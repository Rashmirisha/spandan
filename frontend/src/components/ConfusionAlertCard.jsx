import React, { useEffect, useState, useCallback } from 'react'
import { confusionApi } from '../lib/api.js'
import { useSocketStore } from '../stores/socketStore.js'

/**
 * ConfusionAlertCard -- one live card per (room, topic).
 *
 * Topic-Aware Confusion (Milestone 2): when a student presses "I'm Lost",
 * the backend attaches the signal to an active ConfusionEvent. Subsequent
 * presses for the same topic MERGE into the event (count goes up, latest
 * timestamp / snippet refresh). When the topic changes, the prior event is
 * closed and a fresh one opens.
 *
 * This card subscribes to two socket events:
 *   - "confusion:update"  -- count changed, or a new event opened
 *   - "confusion:closed"  -- the active event was closed (topic shift)
 *
 * On first mount we hydrate from `confusionApi.getActive`, fall back to
 * `confusionApi.getLatest` if no active event exists so the teacher can
 * still see "what just happened" during the topic-shift millisecond.
 */
export default function ConfusionAlertCard ({ roomId }) {
  const socket = useSocketStore(s => s.socket)
  const [event, setEvent] = useState(null)
  const [latest, setLatest] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tickMs, setTickMs] = useState(Date.now())

  const fetchAll = useCallback(async () => {
    if (!roomId) return
    try {
      const [active, latestRes, historyRes] = await Promise.all([
        confusionApi.getActive(roomId).catch(() => ({ event: null })),
        confusionApi.getLatest(roomId).catch(() => ({ event: null })),
        confusionApi.getHistory(roomId, 10).catch(() => ({ events: [] }))
      ])
      setEvent(active.event || null)
      // Fall back to latest so the "Just now" card stays visible
      // when the topic just shifted and no active event yet exists.
      setLatest(latestRes.event || null)
      setHistory(Array.isArray(historyRes.events) ? historyRes.events : [])
      setError('')
    } catch (e) {
      setError(e?.message || 'Failed to fetch confusion data')
    } finally {
      setLoading(false)
    }
  }, [roomId])

  useEffect(() => {
    fetchAll()
    const t = setInterval(fetchAll, 8000) // safety refresh in case socket misses
    return () => clearInterval(t)
  }, [fetchAll])

  // Socket subscriptions
  useEffect(() => {
    if (!socket) return
    const onUpdate = (data) => {
      if (String(data.roomId) !== String(roomId)) return
      setEvent(data.event)
      setLatest(data.event)
      setTickMs(Date.now())
    }
    const onClosed = (data) => {
      if (String(data.roomId) !== String(roomId)) return
      // The closed event may have been the active one -- move it to latest
      setEvent(null)
      if (data.event) setLatest(data.event)
      setTickMs(Date.now())
    }
    socket.on('confusion:update', onUpdate)
    socket.on('confusion:closed', onClosed)
    return () => {
      socket.off('confusion:update', onUpdate)
      socket.off('confusion:closed', onClosed)
    }
  }, [socket, roomId])

  if (loading) {
    return (
      <div className="cac-shell cac-shell--idle">
        <div className="cac-header">
          <h3>⚠ Confusion alert</h3>
        </div>
        <div className="cac-body cac-body--loading">Loading…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="cac-shell cac-shell--idle">
        <div className="cac-header">
          <h3>⚠ Confusion alert</h3>
        </div>
        <div className="cac-body cac-body--error">{error}</div>
      </div>
    )
  }

  // Choose what to render: active event wins; fall back to latest
  const card = event || latest
  if (!card) {
    return (
      <div className="cac-shell cac-shell--idle">
        <div className="cac-header">
          <h3>⚠ Confusion alert</h3>
        </div>
        <div className="cac-body cac-body--idle">
          <div className="cac-empty-icon">✅</div>
          <div>No active confusion event. Students are keeping up.</div>
        </div>
      </div>
    )
  }

  const confusionsSinceStart = card.confusedStudentCount || 0
  const sourceLabel = sourceToLabel(card.topic?.source)
  const sourceClass = sourceToClass(card.topic?.source)
  const isActive = !!event

  return (
    <div
      className={`cac-shell${isActive ? ' cac-shell--live' : ' cac-shell--idle'}`}
      role="region"
      aria-label={isActive ? 'Active confusion alert' : 'Recent confusion event'}
    >
      <div className="cac-header">
        <h3>
          ⚠ Confusion Alert
          {isActive && <span className="cac-live-dot" aria-label="live" />}
        </h3>
        <span className={`cac-source-badge ${sourceClass}`}>{sourceLabel}</span>
      </div>

      <div className="cac-body">
        <div className="cac-row">
          <div className="cac-row-label">Topic</div>
          <div className="cac-row-value cac-row-value--topic">
            {card.topic?.label || <em>(no topic detected)</em>}
          </div>
        </div>

        {card.topic?.subtopic && (
          <div className="cac-row">
            <div className="cac-row-label">Subtopic</div>
            <div className="cac-row-value">{card.topic.subtopic}</div>
          </div>
        )}

        <div className="cac-row cac-row--count">
          <div className="cac-row-label">Students Confused</div>
          <div className="cac-row-value cac-row-value--count">
            <span className="cac-count-num">{confusionsSinceStart}</span>
            <span className="cac-count-suffix">
              {confusionsSinceStart === 1 ? 'student' : 'students'}
            </span>
          </div>
        </div>

        <div className="cac-row cac-row--timestamps">
          <div>
            <div className="cac-row-label cac-row-label--small">Started</div>
            <div className="cac-row-value cac-row-value--small">{card.startedAtLabel || '—'}</div>
          </div>
          <div>
            <div className="cac-row-label cac-row-label--small">Last Update</div>
            <div className="cac-row-value cac-row-value--small">{card.lastUpdateLabel || '—'}</div>
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

        {!isActive && (
          <div className="cac-row cac-row--note">
            <em>Topic just changed. Waiting for the next signal to open a new alert.</em>
          </div>
        )}
      </div>

      {history.length > 0 && (
        <details className="cac-history">
          <summary>History ({history.length} events)</summary>
          <ol className="cac-history-list">
            {history.slice(0, 10).map((e) => (
              <li key={e.id} className={`cac-history-row${e.status === 'active' ? ' cac-history-row--active' : ''}`}>
                <div className="cac-history-line">
                  <strong>{e.topic?.label || '(no topic)'}</strong>
                  {' · '}
                  <span>{e.confusedStudentCount || 0}</span>
                  {' · '}
                  <time>{e.startedAtLabel || '—'}</time>
                  {e.status === 'active' && <span className="cac-live-dot" aria-label="live" />}
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

function sourceToLabel (source) {
  switch (source) {
    case 'marker': return 'teacher marker'
    case 'auto': return 'auto topic'
    case 'transcript': return 'transcript snippet'
    case 'none': return 'no topic'
    default: return ''
  }
}

function sourceToClass (source) {
  switch (source) {
    case 'marker': return 'cac-source-badge--marker'
    case 'auto': return 'cac-source-badge--auto'
    case 'transcript': return 'cac-source-badge--transcript'
    case 'none': return 'cac-source-badge--none'
    default: return ''
  }
}