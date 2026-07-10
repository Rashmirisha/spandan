import React, { useState, useEffect, useCallback, useRef } from 'react'
import { topicApi } from '../lib/api.js'
import { useTeacherPositionStore, formatMs } from '../stores/teacherPositionStore.js'
import { useSocketStore } from '../stores/socketStore.js'

/**
 * TopicMarkerBar — teacher-only inline editor for topic markers.
 *
 * Shows the current topic (based on recordingOffsetMs) plus a button to
 * "Mark now" or edit the label. Teachers can drop markers at any time
 * during the lecture; they'll show up on the confusion-spike dashboard.
 *
 * Late markers (after a spike happened) still apply retroactively to any
 * doubt signal in the same time window.
 *
 * Props:
 *   - roomId, roomCode
 *   - editable (default true) -- teacher mode
 */
export default function TopicMarkerBar ({ roomId, roomCode, editable = true }) {
  const teacherPos = useTeacherPositionStore(s => s.lastPosition)
  const roomStartedAt = useTeacherPositionStore(s => s.roomStartedAt)
  const sessionActive = useTeacherPositionStore(s => s.sessionActive)
  const socket = useSocketStore(s => s.socket)

  const [topics, setTopics] = useState([])
  const [editing, setEditing] = useState(false)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const fetchTopics = useCallback(async () => {
    if (!roomId) return
    try {
      const r = await topicApi.list(roomId)
      setTopics(r.topics || [])
    } catch (e) {
      // Non-fatal -- teacher can still type a marker
    }
  }, [roomId])

  useEffect(() => { fetchTopics() }, [fetchTopics])

  // Socket updates
  useEffect(() => {
    if (!socket) return
    const onSet = (data) => {
      if (data?.marker) fetchTopics()
    }
    const onDelete = () => fetchTopics()
    socket.on('teacher:topic-set', onSet)
    socket.on('teacher:topic-delete', onDelete)
    return () => {
      socket.off('teacher:topic-set', onSet)
      socket.off('teacher:topic-delete', onDelete)
    }
  }, [socket, fetchTopics])

  // Find current topic based on recording offset
  const currentOffsetMs = teacherPos?.recordingOffsetMs ?? null
  const currentTopic = (() => {
    if (currentOffsetMs == null) return null
    return topics.find(t =>
      t.startMs <= currentOffsetMs && (t.endMs == null || t.endMs > currentOffsetMs)
    ) || null
  })()
  const nextTopic = (() => {
    if (currentOffsetMs == null) return null
    return topics.find(t => t.startMs > currentOffsetMs) || null
  })()

  const handleMarkNow = async () => {
    if (currentOffsetMs == null) {
      setError('No recording clock yet -- start the session first')
      return
    }
    setError('')
    setEditing(true)
    setDraftLabel('')
    setDraftNote('')
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const handleSave = async () => {
    if (!draftLabel.trim()) {
      setError('Label required')
      return
    }
    setSaving(true)
    setError('')
    try {
      const r = await topicApi.set(roomId, {
        startMs: currentOffsetMs,
        label: draftLabel.trim(),
        note: draftNote.trim()
      })
      if (r.success) {
        setEditing(false)
        setDraftLabel('')
        setDraftNote('')
        // Broadcast to other clients (incl. students)
        socket?.emit('teacher:topic-set', {
          roomId, roomCode,
          markerId: r.marker._id,
          startMs: r.marker.startMs,
          label: r.marker.label,
          note: r.marker.note
        })
        fetchTopics()
      } else {
        setError(r.error || 'Failed to save')
      }
    } catch (e) {
      setError(e?.response?.data?.error || e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (markerId) => {
    try {
      await topicApi.remove(roomId, markerId)
      socket?.emit('teacher:topic-delete', { roomId, roomCode, markerId })
      fetchTopics()
    } catch (e) {
      setError(e.message)
    }
  }

  const handleCancel = () => {
    setEditing(false)
    setDraftLabel('')
    setDraftNote('')
    setError('')
  }

  return (
    <div className="tmb-bar">
      <div className="tmb-header">
        <div className="tmb-title">
          <span className="tmb-icon">📚</span>
          <span>Topics</span>
          <span className="tmb-count">{topics.length}</span>
        </div>
        {editable && sessionActive && currentOffsetMs != null && !editing && (
          <button type="button" className="tmb-mark-btn" onClick={handleMarkNow}>
            + Mark this moment
          </button>
        )}
      </div>

      {editing && (
        <div className="tmb-editor">
          <div className="tmb-editor-time">
            <span className="tmb-time-icon">🕐</span>
            <span className="tmb-time-label">{formatMs(currentOffsetMs)}</span>
            <span className="tmb-editor-hint">Recording clock</span>
          </div>
          <input
            ref={inputRef}
            type="text"
            placeholder="Topic label (e.g. Glycolysis — Investment Phase)"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            className="tmb-input"
            maxLength={120}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
              if (e.key === 'Escape') handleCancel()
            }}
          />
          <input
            type="text"
            placeholder="Note (optional)"
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            className="tmb-input tmb-input--note"
            maxLength={240}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
              if (e.key === 'Escape') handleCancel()
            }}
          />
          {error && <div className="tmb-error">{error}</div>}
          <div className="tmb-editor-actions">
            <button type="button" className="tmb-btn tmb-btn--ghost" onClick={handleCancel} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="tmb-btn tmb-btn--primary" onClick={handleSave} disabled={saving || !draftLabel.trim()}>
              {saving ? 'Saving…' : 'Save marker'}
            </button>
          </div>
        </div>
      )}

      {!editing && currentTopic && (
        <div className="tmb-current">
          <span className="tmb-current-label">📍 Now teaching:</span>
          <span className="tmb-current-name">{currentTopic.label}</span>
          {currentTopic.note && <span className="tmb-current-note">— {currentTopic.note}</span>}
        </div>
      )}

      {!editing && topics.length > 0 && (
        <ol className="tmb-timeline">
          {topics.map((t) => {
            const isCurrent = currentTopic && currentTopic._id === t._id
            return (
              <li key={t._id} className={`tmb-topic${isCurrent ? ' tmb-topic--current' : ''}`}>
                <span className="tmb-topic-time">
                  🕐 {formatMs(t.startMs)}{t.endMs != null ? `–${formatMs(t.endMs)}` : '–…'}
                </span>
                <span className="tmb-topic-label">{t.label}</span>
                {t.note && <span className="tmb-topic-note">— {t.note}</span>}
                {editable && (
                  <button
                    type="button"
                    className="tmb-topic-del"
                    onClick={() => handleDelete(t._id)}
                    aria-label="Delete topic"
                    title="Delete topic"
                  >×</button>
                )}
              </li>
            )
          })}
          {nextTopic && (
            <li className="tmb-topic tmb-topic--upcoming">
              <span className="tmb-topic-time">
                🕐 {formatMs(nextTopic.startMs)}
              </span>
              <span className="tmb-topic-label">{nextTopic.label}</span>
              <span className="tmb-topic-note">(upcoming)</span>
            </li>
          )}
        </ol>
      )}

      {!editing && topics.length === 0 && editable && sessionActive && (
        <div className="tmb-empty">
          No topics yet. Hit <strong>+ Mark this moment</strong> when you start a new section — students will see it instantly on the spike dashboard.
        </div>
      )}

      {!editing && topics.length === 0 && !editable && (
        <div className="tmb-empty">The teacher hasn't marked any topics yet for this lecture.</div>
      )}
    </div>
  )
}