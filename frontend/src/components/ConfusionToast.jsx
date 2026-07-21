import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useSocketStore } from '../stores/socketStore.js'
import { useAuthStore } from '../stores/authStore.js'
import sounds from '../lib/sounds.js'
import './ConfusionToast.css'

/**
 * ConfusionToast -- listens for `confusion:update` socket events and shows
 * a top-right toast notification each time a student presses "I'm Lost".
 *
 * Features:
 *   - Auto-dismiss after 6 seconds
 *   - Merges multiple updates within a short window into ONE toast
 *     (latest count + topic wins) so a class of 30 confused students
 *     doesn't show 30 toasts.
 *   - Plays a short bell on NEW confusion events only (action === 'created').
 *     Merges and re-opens do NOT play the sound (avoid noise).
 *   - Severity color comes from the event tier (green/yellow/red).
 *   - Pauses the auto-dismiss timer on hover.
 *
 * Props:
 *   - roomName: optional override for the room name. If not passed,
 *     we fall back to "Live Session".
 *   - maxToasts: queue size limit (default 4)
 */
export default function ConfusionToast ({ roomName, maxToasts = 4 }) {
  const socket = useSocketStore(s => s.socket)
  const isAuthed = useAuthStore(s => !!s.token)

  // Queue of toasts (max maxToasts). Each toast: { id, eventId, topic, count, tier, createdAt, fadeOut }
  const [toasts, setToasts] = useState([])
  // Throttle: collapse updates that arrive within MERGE_WINDOW_MS of each other
  const mergeTimersRef = useRef(new Map()) // eventId -> timeoutId
  // Track which events we've already played the bell for (avoid replaying on merge)
  const bellPlayedRef = useRef(new Set())

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // Dedupe helper: same eventId -> update count + topic + ts
  const upsertToast = useCallback((payload) => {
    const eventId = payload.eventId || payload.event?.id
    if (!eventId) return

    setToasts((prev) => {
      const existing = prev.find((t) => t.eventId === eventId)
      const newToast = {
        id: existing?.id || `${eventId}-${Date.now()}`,
        eventId,
        topic: payload.topic || payload.event?.topic?.label || payload.event?.topicLabel || 'this topic',
        count: payload.count ?? payload.event?.confusedStudentCount ?? 1,
        tier: payload.tier || payload.event?.tier?.name || deriveTierFromScore(payload.event?.score),
        score: payload.event?.score,
        roomName: roomName || 'Live Session',
        createdAt: existing?.createdAt || Date.now(),
        isNew: !existing // used to decide whether to play bell on the render side
      }
      if (existing) {
        // Update in place, keep createdAt + isNew=false (don't re-trigger bell)
        return prev.map((t) => (t.id === existing.id ? { ...newToast, isNew: false } : t))
      }
      // Push new (newest on top), enforce maxToasts
      const next = [newToast, ...prev]
      return next.slice(0, maxToasts)
    })
  }, [roomName, maxToasts])

  useEffect(() => {
    if (!socket || !isAuthed) return

    const onUpdate = (data) => {
      // Only care about live confusion events
      if (!data) return
      const isCreated = data.action === 'created'
      const isMerged = data.action === 'merged'
      // Ignore anything that's not an active live update
      if (!isCreated && !isMerged) return
      const eventId = data.event?.id || data.event?._id
      if (!eventId) return

      // Schedule upsert with a small merge window so multiple clicks arriving
      // in quick succession collapse into one toast
      const existingTimer = mergeTimersRef.current.get(eventId)
      if (existingTimer) clearTimeout(existingTimer)
      const timer = setTimeout(() => {
        upsertToast({
          eventId,
          event: data.event,
          topic: data.event?.topic?.label || data.event?.topicLabel,
          count: data.event?.confusedStudentCount,
          tier: data.event?.tier?.name,
          isCreated
        })
        mergeTimersRef.current.delete(eventId)
      }, 250) // 250ms merge window
      mergeTimersRef.current.set(eventId, timer)
    }

    socket.on('confusion:update', onUpdate)
    return () => {
      socket.off('confusion:update', onUpdate)
      // Clear all pending timers on unmount
      for (const t of mergeTimersRef.current.values()) clearTimeout(t)
      mergeTimersRef.current.clear()
    }
  }, [socket, isAuthed, upsertToast])

  // After every render: play bell for any new toasts that haven't had it played,
  // and auto-dismiss toasts after 6s.
  useEffect(() => {
    const AUTO_DISMISS_MS = 6000
    const newTimers = []
    for (const t of toasts) {
      if (t.isNew && !bellPlayedRef.current.has(t.eventId)) {
        bellPlayedRef.current.add(t.eventId)
        try { sounds.notify() } catch {}
      }
      const ageMs = Date.now() - t.createdAt
      const remaining = AUTO_DISMISS_MS - ageMs
      if (remaining > 0) {
        const timer = setTimeout(() => dismissToast(t.id), remaining)
        newTimers.push(timer)
      } else {
        // Already expired -> dismiss on next tick
        const timer = setTimeout(() => dismissToast(t.id), 0)
        newTimers.push(timer)
      }
    }
    return () => {
      for (const timer of newTimers) clearTimeout(timer)
    }
  }, [toasts, dismissToast])

  if (!toasts.length) return null

  return (
    <div className="confusion-toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  )
}

function ToastItem ({ toast, onDismiss }) {
  const [hovered, setHovered] = useState(false)
  const tierKey = ['green', 'yellow', 'red'].includes(toast.tier) ? toast.tier : 'idle'
  const tierLabel = tierKey === 'red' ? 'Spike' : tierKey === 'yellow' ? 'Watch' : tierKey === 'green' ? 'Calm' : 'Info'
  const tierEmoji = tierKey === 'red' ? '🔴' : tierKey === 'yellow' ? '🟡' : tierKey === 'green' ? '🟢' : '⚪'
  const timeLabel = new Date(toast.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return (
    <div
      className={`confusion-toast confusion-toast--${tierKey}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="status"
    >
      <div className="confusion-toast__head">
        <span className="confusion-toast__icon">🔔</span>
        <span className="confusion-toast__title">Student Confusion Detected</span>
        <button
          className="confusion-toast__close"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      <div className="confusion-toast__body">
        <div className="confusion-toast__topic" title={toast.topic}>{toast.topic}</div>
        <div className="confusion-toast__meta">
          <span className="confusion-toast__count">
            <strong>{toast.count}</strong> student{toast.count === 1 ? '' : 's'} confused
          </span>
          <span className={`confusion-toast__severity confusion-toast__severity--${tierKey}`}>
            {tierEmoji} {tierLabel}
          </span>
        </div>
        <div className="confusion-toast__foot">
          <span className="confusion-toast__room">{toast.roomName}</span>
          <span className="confusion-toast__time">{timeLabel}</span>
          {!hovered && <span className="confusion-toast__progress" />}
        </div>
      </div>
    </div>
  )
}

function deriveTierFromScore (score) {
  if (score == null) return 'idle'
  if (score >= 60) return 'red'
  if (score >= 30) return 'yellow'
  return 'green'
}