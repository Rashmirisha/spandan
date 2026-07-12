import React, { useEffect, useState, useCallback, useRef } from 'react'
import { confusionApi } from '../lib/api.js'
import { useSocketStore } from '../stores/socketStore.js'

/**
 * ConfusionAlertCard -- THE single live confusion card per room.
 *
 * Milestone 3 redesign:
 *   - Tier-styled shell (green/yellow/red) based on backend `tier.name`
 *   - Animated count-up when the student count rises
 *   - Status pill (Live / Resolved) + pulsing dot when active
 *   - Topic source badge (AI / Teacher / Snippet)
 *   - Subtopic line, latest transcript snippet
 *   - Priority score badge with tier emoji
 *
 * History is owned by <ConfusionTimeline /> -- this card only shows the live
 * card (or the most recent if no active event exists).
 *
 * Empty states:
 *   - loading
 *   - "No students have reported confusion yet."
 *   - "Start recording to enable topic-aware confusion detection."
 */
export default function ConfusionAlertCard ({ roomId, hasTranscript = true }) {
  const socket = useSocketStore(s => s.socket)
  const [event, setEvent] = useState(null)
  const [latest, setLatest] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [displayCount, setDisplayCount] = useState(0)
  const [pulseKey, setPulseKey] = useState(0)
  const prevCountRef = useRef(0)

  const fetchAll = useCallback(async () => {
    if (!roomId) return
    try {
      const [active, latestRes] = await Promise.all([
        confusionApi.getActive(roomId).catch(() => ({ event: null })),
        confusionApi.getLatest(roomId).catch(() => ({ event: null }))
      ])
      setEvent(active.event || null)
      setLatest(latestRes.event || null)
      setError('')
    } catch (e) {
      setError(e?.message || 'Failed to fetch confusion data')
    } finally {
      setLoading(false)
    }
  }, [roomId])

  useEffect(() => {
    fetchAll()
    const t = setInterval(fetchAll, 8000)
    // Also refresh when the tab becomes visible again (handles the case
    // where the teacher switched tabs and missed several socket events).
    const onVisibility = () => { if (!document.hidden) fetchAll() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fetchAll])

  useEffect(() => {
    if (!socket) return
    const onUpdate = (data) => {
      if (String(data.roomId) !== String(roomId)) return
      setEvent(data.event)
      setLatest(data.event)
    }
    const onClosed = (data) => {
      if (String(data.roomId) !== String(roomId)) return
      setEvent(null)
      if (data.event) setLatest(data.event)
    }
    socket.on('confusion:update', onUpdate)
    socket.on('confusion:closed', onClosed)
    return () => {
      socket.off('confusion:update', onUpdate)
      socket.off('confusion:closed', onClosed)
    }
  }, [socket, roomId])

  // Animated count-up: when target count increases, tween 0 -> target over ~600ms
  const card = event || latest
  const targetCount = card?.confusedStudentCount || 0
  useEffect(() => {
    const from = prevCountRef.current
    const to = targetCount
    if (from === to) return
    prevCountRef.current = to
    setPulseKey(k => k + 1)
    if (from === 0) { setDisplayCount(to); return }
    const duration = 600
    const start = performance.now()
    let raf
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3) // ease-out cubic
      setDisplayCount(Math.round(from + (to - from) * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
      else setDisplayCount(to)
    }
    raf = requestAnimationFrame(tick)
    return () => raf && cancelAnimationFrame(raf)
  }, [targetCount])

  if (loading) {
    return (
      <div className="cac-shell cac-shell--idle" data-loading="true">
        <div className="cac-header">
          <h3>⚠ Live Confusion Alert</h3>
        </div>
        <div className="cac-body cac-body--loading">Loading…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="cac-shell cac-shell--idle">
        <div className="cac-header">
          <h3>⚠ Live Confusion Alert</h3>
        </div>
        <div className="cac-body cac-body--error">{error}</div>
      </div>
    )
  }

  if (!card) {
    return (
      <div className="cac-shell cac-shell--idle cac-shell--empty">
        <div className="cac-header">
          <h3>⚠ Live Confusion Alert</h3>
          <span className="cac-status cac-status--idle">No events</span>
        </div>
        <div className="cac-body cac-body--empty">
          <div className="cac-empty-icon">✅</div>
          <div>
            {hasTranscript
              ? 'No students have reported confusion yet.'
              : 'Start recording to enable topic-aware confusion detection.'}
          </div>
        </div>
      </div>
    )
  }

  const isActive = !!event
  const tierClass = tierToClass(card.tier?.name)
  const tierLabel = card.tier?.label || 'Info'
  const tierEmoji = card.tier?.emoji || '🟢'
  const sourceLabel = sourceToLabel(card.topic?.source)
  const sourceClass = sourceToClass(card.topic?.source)

  return (
    <div
      className={`cac-shell cac-shell--${tierClass}${isActive ? ' cac-shell--live' : ' cac-shell--resolved'}`}
      role="region"
      aria-label={isActive ? 'Active confusion alert' : 'Recent resolved confusion event'}
      data-tier={tierClass}
      data-status={isActive ? 'live' : 'resolved'}
    >
      <div className="cac-header">
        <h3>
          ⚠ Live Confusion Alert
          {isActive && (
            <span className="cac-live-dot" aria-label="live" key={`pulse-${pulseKey}`} />
          )}
        </h3>
        <div className="cac-header-right">
          <span className={`cac-source-badge ${sourceClass}`}>{sourceLabel}</span>
          <span className={`cac-status cac-status--${isActive ? 'live' : 'resolved'}`}>
            {isActive ? 'Live' : 'Resolved'}
          </span>
        </div>
      </div>

      <div className="cac-body">
        <div className="cac-row cac-row--topic">
          <div className="cac-row-label">Topic</div>
          <div className="cac-row-value cac-row-value--topic">
            {card.topic?.label || <em className="cac-muted">(no topic detected)</em>}
          </div>
        </div>

        {card.topic?.subtopic && (
          <div className="cac-row cac-row--subtopic">
            <div className="cac-row-label">Subtopic</div>
            <div className="cac-row-value">{card.topic.subtopic}</div>
          </div>
        )}

        <div className="cac-row cac-row--count">
          <div className="cac-row-label">Students Confused</div>
          <div className="cac-row-value cac-row-value--count">
            <span className="cac-count-num" key={`n-${displayCount}-${pulseKey}`}>{displayCount}</span>
            <span className="cac-count-suffix">
              {displayCount === 1 ? 'student' : 'students'}
            </span>
          </div>
        </div>

        <div className="cac-row cac-row--timestamps">
          <div>
            <div className="cac-row-label cac-row-label--small">Started</div>
            <div className="cac-row-value cac-row-value--small">{card.startedAtLabel || '—'}</div>
          </div>
          <div>
            <div className="cac-row-label cac-row-label--small">Last Updated</div>
            <div className="cac-row-value cac-row-value--small">{card.lastUpdateLabel || '—'}</div>
          </div>
          <div>
            <div className="cac-row-label cac-row-label--small">Duration</div>
            <div className="cac-row-value cac-row-value--small">
              {formatDuration(card.durationMs || 0)}
            </div>
          </div>
        </div>

        {card.latestTranscriptSnippet && (
          <div className="cac-row cac-row--snippet">
            <div className="cac-row-label">Latest Transcript</div>
            <div className="cac-row-snippet">
              “{card.latestTranscriptSnippet.slice(0, 220)}{card.latestTranscriptSnippet.length > 220 ? '…' : ''}”
            </div>
          </div>
        )}

        <div className="cac-row cac-row--meta">
          <div className="cac-meta-block">
            <div className="cac-row-label cac-row-label--small">Topic Source</div>
            <div className="cac-row-value cac-row-value--small">
              <span className={`cac-source-badge ${sourceClass}`}>{sourceLabel}</span>
            </div>
          </div>
          <div className="cac-meta-block">
            <div className="cac-row-label cac-row-label--small">Priority Tier</div>
            <div className="cac-row-value cac-row-value--small">
              <span className={`cac-tier-badge cac-tier-badge--${tierClass}`}>
                {tierEmoji} {tierLabel}
                {card.score != null ? ` · ${card.score.toFixed ? card.score.toFixed(1) : card.score}` : ''}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function tierToClass (name) {
  switch (name) {
    case 'green': return 'green'
    case 'yellow': return 'yellow'
    case 'red': return 'red'
    default: return 'idle'
  }
}

function sourceToLabel (source) {
  switch (source) {
    case 'marker': return 'Teacher'
    case 'auto': return 'AI'
    case 'transcript': return 'Snippet'
    case 'latest_marker': return 'Recent'
    case 'latest_transcript': return 'Snippet'
    case 'student_utterance': return 'Student'
    case 'fallback': return 'General'
    case 'none': return 'No topic'
    default: return ''
  }
}

function sourceToClass (source) {
  switch (source) {
    case 'marker': return 'cac-source-badge--marker'
    case 'auto': return 'cac-source-badge--auto'
    case 'transcript': return 'cac-source-badge--transcript'
    case 'latest_marker': return 'cac-source-badge--marker'
    case 'latest_transcript': return 'cac-source-badge--transcript'
    case 'student_utterance': return 'cac-source-badge--student'
    case 'fallback': return 'cac-source-badge--fallback'
    case 'none': return 'cac-source-badge--none'
    default: return ''
  }
}

function formatDuration (ms) {
  if (!ms || ms < 0) return '—'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const s = sec % 60
  return `${min}:${String(s).padStart(2, '0')}`
}