import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { confusionApi } from '../lib/api.js'
import { API_URL } from '../config.js'
import useAuthStore from '../stores/authStore.js'
import useSocketStore from '../stores/socketStore.js'
import Sidebar from '../components/Sidebar'
import ThemeToggle from '../components/ThemeToggle'
import ProfileDropdown from '../components/ProfileDropdown'
import ConfusionToast from '../components/ConfusionToast.jsx'
import FeedbackCollector from '../components/FeedbackCollector.jsx'
import '../styles/analytics.css'

/**
 * AnalyticsPage — dedicated standalone module for the doubt-anchored polling
 * analytics feature. Reuses existing backend APIs (/api/confusion/*) and
 * socket events (confusion:update, confusion:closed, confusion:feedback,
 * confusion:resolved). Renders a fresh dashboard-style layout instead of
 * piggybacking on RoomDetailPage's live session page.
 *
 * Sections (top -> bottom):
 *   1. Live confusion overview (current tier, count, current topic, score)
 *   2. KPI strip: total events, # confused students, avg score, recovery rate
 *   3. Topic-wise confusion heat bars (from /topic-heat)
 *   4. Time-bucketed spike intensity (from /heatmap, inline SVG, no new deps)
 *   5. AI insights / recommendations (locally computed from event history)
 *   6. Recent confusion events list (from /history)
 */

const SCORE_BY_TIER = {
  green: { label: 'Calm', emoji: '🟢', score: 0 },
  yellow: { label: 'Watch', emoji: '🟡', score: 1 },
  red: { label: 'Spike', emoji: '🔴', score: 2 }
}

export default function AnalyticsPage () {
  const { roomId } = useParams()
  const navigate = useNavigate()
  const { token, user } = useAuthStore()
  const socket = useSocketStore(s => s.socket)

  const [room, setRoom] = useState(null)
  const [active, setActive] = useState(null)
  const [history, setHistory] = useState([])
  const [topicHeat, setTopicHeat] = useState([])
  const [heatmap, setHeatmap] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [feedbackPending, setFeedbackPending] = useState(false) // active event waiting on students

  const fetchAll = useCallback(async () => {
    if (!roomId || !token) return
    try {
      const [activeRes, histRes, topicRes, hmRes, roomRes] = await Promise.all([
        confusionApi.getActive(roomId),
        confusionApi.getHistory(roomId, 50),
        confusionApi.getTopicHeat(roomId, 10),
        confusionApi.getHeatmap(roomId, { bucketMs: 60000, windowMs: 600000 }),
        fetch(`${API_URL}/rooms/${roomId}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      ])
      setActive(activeRes.event || null)
      setHistory(Array.isArray(histRes.events) ? histRes.events : [])
      setTopicHeat(Array.isArray(topicRes.buckets) ? topicRes.buckets : [])
      setHeatmap(Array.isArray(hmRes.heatmap) ? hmRes.heatmap : [])
      setRoom(roomRes?.room || roomRes || null)
      setError('')
    } catch (e) {
      setError(e?.message || 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [roomId, token])

  useEffect(() => {
    fetchAll()
    const t = setInterval(fetchAll, 12000)
    return () => clearInterval(t)
  }, [fetchAll])

  // Socket subscriptions: live updates without polling lag
  useEffect(() => {
    if (!socket) return
    const onUpdate = (data) => {
      if (String(data.roomId) !== String(roomId)) return
      fetchAll()
    }
    const onClosed = (data) => {
      if (String(data.roomId) !== String(roomId)) return
      setFeedbackPending(false)
      fetchAll()
    }
    const onResolved = (data) => {
      if (String(data.roomId) !== String(roomId)) return
      setFeedbackPending(false)
      fetchAll()
    }
    const onFeedbackRequest = (data) => {
      if (String(data.eventId) !== String(active?.id) && String(data.eventId) !== String(active?._id)) return
      setFeedbackPending(true)
    }
    const onFeedback = (data) => {
      if (String(data.eventId) !== String(active?.id) && String(data.eventId) !== String(active?._id)) return
      setFeedbackPending(false)
      fetchAll()
    }
    socket.on('confusion:update', onUpdate)
    socket.on('confusion:closed', onClosed)
    socket.on('confusion:resolved', onResolved)
    socket.on('confusion:feedback:request', onFeedbackRequest)
    socket.on('confusion:feedback', onFeedback)
    return () => {
      socket.off('confusion:update', onUpdate)
      socket.off('confusion:closed', onClosed)
      socket.off('confusion:resolved', onResolved)
      socket.off('confusion:feedback:request', onFeedbackRequest)
      socket.off('confusion:feedback', onFeedback)
    }
  }, [socket, roomId, active, fetchAll])

  // ----- Derived analytics -----

  // Active event topic may be a flat string OR a nested {label, subtopic, source}
  // object depending on which code path emitted it. Normalize.
  const activeTopicLabel = useMemo(() => {
    if (!active) return 'General'
    return active.topicLabel
      || (typeof active.topic === 'string' ? active.topic : null)
      || active.topic?.label
      || 'General'
  }, [active])

  const activeTier = useMemo(() => {
    if (!active) return 'idle'
    if (active.tier?.name) return active.tier.name
    if (typeof active.tier === 'string') return active.tier
    const s = active.score ?? 0
    if (s >= 60) return 'red'
    if (s >= 30) return 'yellow'
    return 'green'
  }, [active])

  const activeScore = active?.score ?? null

  const kpis = useMemo(() => {
    const total = history.length
    const closed = history.filter(e => e.status === 'closed' || e.status === 'resolved').length
    const recoveryRate = total ? Math.round((closed / total) * 100) : 0
    const avgScore = total
      ? history.reduce((sum, e) => sum + (e.score || 0), 0) / total
      : 0
    const peakCount = active?.confusedStudentCount ?? Math.max(0, ...history.map(e => e.confusedStudentCount || 0))
    return { total, closed, recoveryRate, avgScore, peakCount }
  }, [history, active])

  const insights = useMemo(() => computeInsights(history, active), [history, active])

  // ----- Handlers -----

  const handleRequestFeedback = async () => {
    if (!active) return
    const eventId = active.id || active._id
    if (!eventId) return
    try {
      await confusionApi.requestFeedback(eventId)
      setFeedbackPending(true)
    } catch (e) {
      console.error('Request feedback failed:', e)
    }
  }

  const handleResolve = async () => {
    if (!active) return
    const eventId = active.id || active._id
    if (!eventId) return
    try {
      // Force-close the event immediately. The backend emits confusion:closed
      // so all connected dashboards drop the live card and move it to history.
      await confusionApi.resolve(eventId)
      // The socket subscription will refresh state on the next 'confusion:closed'
      // event, but call fetchAll() now too so the UI feels instant.
      fetchAll()
    } catch (e) {
      console.error('Resolve failed:', e)
    }
  }

  if (loading) {
    return (
      <div className="ans-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 44, height: 44, border: '4px solid var(--border-color)',
            borderTopColor: '#3b82f6', borderRadius: '50%',
            animation: 'spin 1s linear infinite', margin: '0 auto 12px'
          }} />
          <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Loading analytics...</p>
        </div>
      </div>
    )
  }

  const maxHeatScore = Math.max(1, ...topicHeat.map(b => b.score || 0))
  const maxBucketScore = Math.max(1, ...heatmap.map(b => b.score || 0))

  return (
    <div className="ans-page">
      {/* Live student confusion toasts -- listens to socket independently */}
      <ConfusionToast roomName={room?.name} />
      {/* Header */}
      <header className="ans-header">
        <div className="ans-header-row">
          <div>
            <h1>📊 Confusion Analytics</h1>
            <p className="ans-subtitle">
              {room?.name || 'Room'} — Live doubt-anchored polling insights
            </p>
            {room?.code && <span className="ans-code-pill">{room.code}</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="ans-back-btn"
              onClick={() => navigate(`/teacher/room/${roomId}`)}
            >
              ← Back to Live Session
            </button>
            <ThemeToggle />
            <ProfileDropdown />
          </div>
        </div>
      </header>

      <div style={{ display: 'flex' }}>
        <Sidebar user={user} />
        <main className="ans-main" style={{ flex: 1, marginLeft: 240 }}>
          {error && (
            <div className="ans-card" style={{ borderLeft: '3px solid #ef4444', color: '#991b1b' }}>
              {error}
            </div>
          )}

          {/* Row 1: Live confusion (wide) + AI insights (narrow) */}
          <div className="ans-grid-2">
            <section className="ans-card ans-live-card">
              <div className="ans-card-head">
                <h2 className="ans-card-title">🔴 Live Confusion Overview</h2>
                <span className="ans-card-subtitle">
                  {active ? 'Event active' : 'No active event'}
                </span>
              </div>
              {active ? (
                <>
                  <div>
                    <span className={`ans-live-tier ans-live-tier--${activeTier}`}>
                      {SCORE_BY_TIER[activeTier]?.emoji} {SCORE_BY_TIER[activeTier]?.label}
                    </span>
                  </div>
                  <div className="ans-live-topic">
                    Topic: {activeTopicLabel}
                  </div>
                  <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end' }}>
                    <div>
                      <div className="ans-live-count">
                        {active.confusedStudentCount ?? 0}
                      </div>
                      <div className="ans-live-count-label">confused students right now</div>
                    </div>
                    {activeScore != null && (
                      <div>
                        <div className="ans-live-count" style={{ fontSize: 26, color: 'var(--text-secondary)' }}>
                          {typeof activeScore === 'number' ? activeScore.toFixed(1) : activeScore}/100
                        </div>
                        <div className="ans-live-count-label">score</div>
                      </div>
                    )}
                  </div>
                  <div className="ans-live-actions">
                    <button
                      className="ans-btn ans-btn--primary"
                      onClick={handleRequestFeedback}
                      disabled={feedbackPending}
                    >
                      {feedbackPending ? '⏳ Awaiting student feedback…' : '🗣️ Request Feedback'}
                    </button>
                    <button className="ans-btn ans-btn--secondary" onClick={handleResolve}>
                      ✅ Mark Resolved
                    </button>
                  </div>
                </>
              ) : (
                <div className="ans-empty">
                  No active confusion event. Students can press <strong>I'm Lost</strong> during
                  the live session to trigger one.
                </div>
              )}
            </section>

            <FeedbackCollector roomId={room?._id} />

            <section className="ans-card">
              <div className="ans-card-head">
                <h2 className="ans-card-title">🧠 AI Insights</h2>
                <span className="ans-card-subtitle">From recent history</span>
              </div>
              {insights.length === 0 ? (
                <div className="ans-empty">No insights yet — needs more events.</div>
              ) : (
                <ul className="ans-insights" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {insights.map((ins, i) => (
                    <li key={i} className="ans-insight">
                      <span className="ans-insight-emoji">{ins.emoji}</span>
                      <span
                        className="ans-insight-text"
                        // We render precomputed text with our own tags. Safe: no user input.
                        dangerouslySetInnerHTML={{ __html: ins.html }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* Row 2: KPI strip */}
          <section className="ans-kpis">
            <div className="ans-kpi ans-kpi-accent-blue">
              <div className="ans-kpi-emoji">📈</div>
              <div className="ans-kpi-value">{kpis.total}</div>
              <div className="ans-kpi-label">Total confusion events</div>
            </div>
            <div className="ans-kpi ans-kpi-accent-red">
              <div className="ans-kpi-emoji">👥</div>
              <div className="ans-kpi-value">{kpis.peakCount}</div>
              <div className="ans-kpi-label">Peak confused students</div>
            </div>
            <div className="ans-kpi ans-kpi-accent-yellow">
              <div className="ans-kpi-emoji">🔥</div>
              <div className="ans-kpi-value">
                {kpis.avgScore ? kpis.avgScore.toFixed(1) : '0.0'}
              </div>
              <div className="ans-kpi-label">Avg event score</div>
            </div>
            <div className="ans-kpi ans-kpi-accent-green">
              <div className="ans-kpi-emoji">✅</div>
              <div className="ans-kpi-value">{kpis.recoveryRate}%</div>
              <div className="ans-kpi-label">Resolved events</div>
            </div>
            <div className="ans-kpi ans-kpi-accent-purple">
              <div className="ans-kpi-emoji">⏱️</div>
              <div className="ans-kpi-value">{computeAvgDuration(history)}s</div>
              <div className="ans-kpi-label">Avg event duration</div>
            </div>
          </section>

          {/* Row 3: Topic heat + Time heatmap */}
          <div className="ans-grid-2">
            <section className="ans-card">
              <div className="ans-card-head">
                <h2 className="ans-card-title">🎯 Topic-Wise Confusion</h2>
                <span className="ans-card-subtitle">{topicHeat.length} topics</span>
              </div>
              {topicHeat.length === 0 ? (
                <div className="ans-empty">
                  No topic data yet. Topic markers + auto-extraction appear once the
                  session produces confusion events.
                </div>
              ) : (
                <div className="ans-heat-bar-list">
                  {topicHeat.map((b, i) => {
                    const tierClass = ['green', 'yellow', 'red'].includes(b.tier) ? b.tier : 'idle'
                    const w = ((b.score || 0) / maxHeatScore) * 100
                    return (
                      <div key={`${b.topicLabel}-${i}`} className="ans-heat-row">
                        <div className="ans-heat-row-label" title={b.topicLabel}>
                          #{i + 1} {b.topicLabel}
                        </div>
                        <div className="ans-heat-row-track">
                          <div
                            className={`ans-heat-row-fill ans-heat-row-fill--${tierClass}`}
                            style={{ width: `${w}%` }}
                          />
                        </div>
                        <div className="ans-heat-row-score">
                          {b.score != null ? b.score.toFixed(1) : '0.0'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <section className="ans-card">
              <div className="ans-card-head">
                <h2 className="ans-card-title">📈 Spike Intensity (last 10 min)</h2>
                <span className="ans-card-subtitle">1-min buckets</span>
              </div>
              {heatmap.length === 0 ? (
                <div className="ans-empty">No spike data in this window.</div>
              ) : (
                <>
                  <BucketBars heatmap={heatmap} max={maxBucketScore} />
                  <div className="ans-timeline-legend">
                    <span><span className="ans-timeline-legend-dot" style={{ background: '#22c55e' }} />Calm</span>
                    <span><span className="ans-timeline-legend-dot" style={{ background: '#eab308' }} />Watch</span>
                    <span><span className="ans-timeline-legend-dot" style={{ background: '#ef4444' }} />Spike</span>
                  </div>
                </>
              )}
            </section>
          </div>

          {/* Row 4: Recent events */}
          <section className="ans-card">
            <div className="ans-card-head">
              <h2 className="ans-card-title">📜 Recent Confusion Events</h2>
              <span className="ans-card-subtitle">{history.length} total</span>
            </div>
            {history.length === 0 ? (
              <div className="ans-empty">No confusion events yet.</div>
            ) : (
              <div>
                {history.slice(0, 15).map((e, i) => (
                  <div key={e.id || e._id || i} className="ans-recent-row">
                    <div className="ans-recent-topic">
                      {topicLabelOf(e)}
                    </div>
                    <span className={`ans-pill ans-pill--${pillFor(e)}`}>{pillLabel(e)}</span>
                    <div className="ans-recent-time">
                      {e.score != null ? `${Number(e.score).toFixed(1)}/100 · ` : ''}
                      {e.confusedStudentCount ?? 0} students · {formatTime(e.startedAt || e.startTimestamp || e.startTime || e.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <footer style={{ padding: '16px 0', color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center' }}>
            Spandan · Live doubt-anchored polling analytics · Refreshes every 12s
          </footer>
        </main>
      </div>
    </div>
  )
}

// ---------- helpers ----------

// ConfusionEvent topic may be either a flat string ("General Confusion"),
// a flat topicLabel string, or a nested object {label, subtopic, source}.
// Backend formatForClient() can return either shape depending on emit path.
function topicLabelOf (e) {
  if (!e) return 'General'
  if (typeof e.topicLabel === 'string' && e.topicLabel) return e.topicLabel
  if (typeof e.topic === 'string' && e.topic) return e.topic
  if (e.topic && typeof e.topic === 'object' && e.topic.label) return e.topic.label
  return 'General'
}

function BucketBars ({ heatmap, max }) {
  // Inline SVG (no new deps). Each bucket = one bar, color by tier.
  const w = 100 // viewBox width units; stretches to 100% via CSS
  const h = 30
  const padX = 1
  const padY = 4
  const innerW = w - padX * 2
  const innerH = h - padY * 2
  const barW = innerW / Math.max(1, heatmap.length)
  return (
    <svg className="ans-timeline-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {heatmap.map((b, i) => {
        const score = b.score || 0
        const ratio = Math.min(1, score / max)
        const bh = Math.max(0.5, ratio * innerH)
        const x = padX + i * barW + barW * 0.1
        const bw = barW * 0.8
        const y = padY + (innerH - bh)
        const tier = ['green', 'yellow', 'red'].includes(b.tier) ? b.tier : 'idle'
        const color = tier === 'red' ? '#ef4444' : tier === 'yellow' ? '#eab308' : tier === 'green' ? '#22c55e' : '#94a3b8'
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={bw}
            height={bh}
            fill={color}
            rx={0.6}
          />
        )
      })}
    </svg>
  )
}

function pillFor (e) {
  if (e.status === 'resolved') return 'resolved'
  if (e.status === 'closed') return 'closed'
  if (e.needsMoreExplanation) return 'recovery'
  return 'closed'
}
function pillLabel (e) {
  if (e.status === 'resolved') return 'Resolved'
  if (e.needsMoreExplanation) return 'Needs more'
  if (e.status === 'closed') return 'Closed'
  return '—'
}

function formatTime (ts) {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

function computeAvgDuration (history) {
  if (!history.length) return 0
  let total = 0
  let n = 0
  for (const e of history) {
    const start = e.startedAt || e.startTimestamp || e.startTime || e.createdAt
    const end = e.endedAt || e.endTimestamp || e.endTime || e.closedAt
    if (start && end) {
      total += (new Date(end) - new Date(start)) / 1000
      n++
    }
  }
  return n ? Math.round(total / n) : 0
}

function computeInsights (history, active) {
  const out = []
  if (history.length === 0 && !active) return out

  // Peak topic
  const byTopic = new Map()
  for (const e of history) {
    const t = topicLabelOf(e)
    const cur = byTopic.get(t) || { score: 0, count: 0 }
    cur.score += e.score || 0
    cur.count += 1
    byTopic.set(t, cur)
  }
  if (byTopic.size) {
    const sorted = [...byTopic.entries()].sort((a, b) => b[1].score - a[1].score)
    const [topTopic, agg] = sorted[0]
    out.push({
      emoji: '🎯',
      html: `Most-asked-about topic: <strong>${esc(topTopic)}</strong> with <strong>${agg.count}</strong> event${agg.count === 1 ? '' : 's'} totaling <span class="ans-insight-tag">${agg.score.toFixed(1)} score</span>`
    })
  }

  // Peak time
  let peakEvent = null
  for (const e of history) {
    if (!peakEvent || (e.score || 0) > (peakEvent.score || 0)) peakEvent = e
  }
  if (peakEvent && peakEvent.score != null) {
    const t = formatTime(peakEvent.startedAt || peakEvent.startTimestamp || peakEvent.startTime || peakEvent.createdAt)
    out.push({
      emoji: '⏰',
      html: `Peak confusion at <strong>${t}</strong> on <strong>${esc(topicLabelOf(peakEvent))}</strong> (score <span class="ans-insight-tag">${(peakEvent.score || 0).toFixed(1)}/100</span>)`
    })
  }

  // Recovery rate insight
  const closed = history.filter(e => e.status === 'closed' || e.status === 'resolved').length
  const rate = history.length ? Math.round((closed / history.length) * 100) : 0
  if (history.length >= 3) {
    out.push({
      emoji: rate >= 70 ? '✅' : '⚠️',
      html: rate >= 70
        ? `Recovery rate is <strong>${rate}%</strong> — your re-explanations are landing.`
        : `Recovery rate is <strong>${rate}%</strong> — consider pausing for Q&amp;A more often after spikes.`
    })
  }

  // Active-event recommendation
  if (active) {
    const s = active.score ?? 0
    if (s >= 60) {
      out.push({
        emoji: '🚨',
        html: `Current event is at <span class="ans-insight-tag">${s.toFixed(1)}/100</span> — re-explain <strong>${esc(active.topicLabel || (typeof active.topic === 'string' ? active.topic : active.topic?.label) || 'this topic')}</strong> now or use Request Feedback to check understanding.`
      })
    } else if (s >= 30) {
      out.push({
        emoji: '👀',
        html: `Watch level on <strong>${esc(active.topicLabel || (typeof active.topic === 'string' ? active.topic : active.topic?.label) || 'this topic')}</strong> — ${active.confusedStudentCount || 0} students. A short recap will likely clear it.`
      })
    }
  } else if (history.length > 0) {
    const last = history[0]
    out.push({
      emoji: 'ℹ️',
      html: `No active event. Most recent: <strong>${esc(last.topicLabel || (typeof last.topic === 'string' ? last.topic : last.topic?.label) || 'General')}</strong>.`
    })
  }

  return out.slice(0, 4)
}

function esc (s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}