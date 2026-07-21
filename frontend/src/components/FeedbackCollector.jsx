import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useSocketStore } from '../stores/socketStore.js'
import sounds from '../lib/sounds.js'

/**
 * FeedbackCollector -- teacher's live tally card for an in-flight feedback
 * round.
 *
 * Lifecycle:
 *   1. Mounted always; renders nothing until a round begins.
 *   2. Listens for `confusion:feedback:request` and `confusion:resolved`
 *      (both emitted by POST /request-feedback on the backend) -- starts
 *      a round for the matching eventId.
 *   3. Subscribes to `confusion:feedback` -- updates the running tally as
 *      each student answers. Idempotent by eventId.
 *   4. After either:
 *        - timeout (default 30s) and no further responses, OR
 *        - `feedbackStats.status === 'completed'`, OR
 *        - `autoClosed === true`,
 *      the card switches to "summary" mode.
 *   5. Summary mode computes the recommendation badge from the
 *      understood-vs-stillConfused split.
 *   6. "Dismiss" hides the card until the next round.
 *
 * Props:
 *   - roomId (required)            : restrict events to this room.
 *   - expectedRespondents (optional): fallback if the socket event doesn't include it.
 *   - timeoutMs (optional)         : default 30000.
 *   - onComplete (optional)        : callback when the round closes.
 */
export default function FeedbackCollector ({
  roomId,
  expectedRespondents: initialExpectedRespondents = 0,
  timeoutMs = 30000,
  onComplete
}) {
  const socket = useSocketStore(s => s.socket)

  // State machine: 'idle' | 'collecting' | 'summary'
  const [phase, setPhase] = useState('idle')
  const [round, setRound] = useState(null) // { eventId, topic, expectedRespondents, startedAt, understood, stillConfused, completed, autoClosed }

  const timerRef = useRef(null)
  const completeFiredRef = useRef(false)

  // ─── Phase transitions ───────────────────────────────────────────

  const beginRound = useCallback((payload) => {
    if (!payload || !payload.eventId) return
    if (roomId && String(payload.roomId) !== String(roomId)) return
    const expected = Number(payload.expectedRespondents || initialExpectedRespondents || 0)
    setRound({
      eventId: String(payload.eventId),
      topic: payload.topic || 'this topic',
      expectedRespondents: expected,
      startedAt: Date.now(),
      understood: 0,
      stillConfused: 0,
      responseCount: 0,
      completed: false,
      autoClosed: false
    })
    setPhase('collecting')
    completeFiredRef.current = false
    // Clear any existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // Arm timeout: if no further responses by timeoutMs, switch to summary
    timerRef.current = setTimeout(() => {
      setRound(prev => prev ? { ...prev, completed: true, autoClosed: false } : prev)
      setPhase('summary')
      try { sounds.tap() } catch {}
    }, timeoutMs)
  }, [roomId, initialExpectedRespondents, timeoutMs])

  const applyFeedback = useCallback((data) => {
    if (!data) return
    if (roomId && String(data.roomId) !== String(roomId)) return
    setRound(prev => {
      if (!prev) return prev
      if (String(prev.eventId) !== String(data.eventId)) return prev
      const understood = Number(data.understood ?? prev.understood)
      const stillConfused = Number(data.stillConfused ?? prev.stillConfused)
      const expected = Number(data.expectedRespondents ?? prev.expectedRespondents)
      const responseCount = understood + stillConfused
      // Backend marks the round "completed" once responseCount >= expected
      const completed = data.feedbackStats?.status === 'completed'
        || (expected > 0 && responseCount >= expected)
        || data.autoClosed === true
      return {
        ...prev,
        understood,
        stillConfused,
        expectedRespondents: expected,
        responseCount,
        completed,
        autoClosed: data.autoClosed === true || prev.autoClosed
      }
    })
  }, [roomId])

  // After every render, if the round is marked completed, switch to summary phase
  // (skipping the timeout). Cleanup on unmount.
  useEffect(() => {
    if (!round) return
    if (round.completed && phase === 'collecting' && !completeFiredRef.current) {
      completeFiredRef.current = true
      // Brief delay so the user sees the final increment before the card morphs
      const t = setTimeout(() => {
        setPhase('summary')
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        try { sounds.send() } catch {}
        if (onComplete) onComplete(round)
      }, 700)
      return () => clearTimeout(t)
    }
  }, [round, phase, onComplete])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  // ─── Socket wiring ───────────────────────────────────────────────

  useEffect(() => {
    if (!socket) return
    const onRequest = (data) => beginRound(data)
    const onResolved = (data) => beginRound(data) // also fires on the teacher's socket
    const onFeedback = (data) => applyFeedback(data)
    socket.on('confusion:feedback:request', onRequest)
    socket.on('confusion:resolved', onResolved)
    socket.on('confusion:feedback', onFeedback)
    return () => {
      socket.off('confusion:feedback:request', onRequest)
      socket.off('confusion:resolved', onResolved)
      socket.off('confusion:feedback', onFeedback)
    }
  }, [socket, beginRound, applyFeedback])

  // ─── Actions ─────────────────────────────────────────────────────

  const dismiss = useCallback(() => {
    setPhase('idle')
    setRound(null)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  if (phase === 'idle' || !round) return null

  if (phase === 'collecting') {
    return <CollectingCard round={round} timeoutMs={timeoutMs} onDismiss={dismiss} />
  }
  return <SummaryCard round={round} onDismiss={dismiss} />
}

// ─── Subviews ───────────────────────────────────────────────────────

function CollectingCard ({ round, timeoutMs, onDismiss }) {
  const [hovered, setHovered] = useState(false)
  const [now, setNow] = useState(Date.now())

  // Tick once a second so the progress bar animates
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])

  const elapsedMs = now - round.startedAt
  const elapsedSec = Math.min(Math.floor(elapsedMs / 1000), Math.ceil(timeoutMs / 1000))
  const remainingSec = Math.max(0, Math.ceil(timeoutMs / 1000) - elapsedSec)
  const total = round.responseCount
  const expected = Math.max(1, round.expectedRespondents || 0)
  const progressPct = Math.min(100, Math.round((total / expected) * 100))
  const timeoutPct = Math.min(100, Math.round((elapsedMs / timeoutMs) * 100))

  const understood = round.understood
  const stillConfused = round.stillConfused
  const understoodPct = total ? Math.round((understood / total) * 100) : 0
  const stillConfusedPct = total ? 100 - understoodPct : 0

  return (
    <div
      className="ans-fb-collector ans-fb-collector--collecting"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="region"
      aria-label="Feedback responses"
    >
      <div className="ans-fb-head">
        <span className="ans-fb-icon">📊</span>
        <span className="ans-fb-title">Feedback Responses</span>
        <span className="ans-fb-count-pill">
          {total}/{round.expectedRespondents || '?'}
        </span>
        <button className="ans-fb-close" aria-label="Dismiss" onClick={onDismiss}>×</button>
      </div>

      <div className="ans-fb-topic" title={round.topic}>{round.topic}</div>

      <div className="ans-fb-rows">
        <div className="ans-fb-row">
          <span className="ans-fb-row-label">
            <span className="ans-fb-emoji">✅</span> Understood
          </span>
          <span className="ans-fb-row-value">
            <strong>{understood}</strong>
            <span className="ans-fb-row-sub">({understoodPct}%)</span>
          </span>
        </div>
        <div className="ans-fb-row">
          <span className="ans-fb-row-label">
            <span className="ans-fb-emoji">❌</span> Still Confused
          </span>
          <span className="ans-fb-row-value">
            <strong>{stillConfused}</strong>
            <span className="ans-fb-row-sub">({stillConfusedPct}%)</span>
          </span>
        </div>
      </div>

      <div className="ans-fb-progress-block">
        <div className="ans-fb-progress-label">
          <span>Response Progress</span>
          <span>{progressPct}%</span>
        </div>
        <div className="ans-fb-progress-track" aria-label={`${progressPct}% of expected responses`}>
          <div className="ans-fb-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      <div className="ans-fb-foot">
        <span className="ans-fb-status ans-fb-status--collecting">
          <span className="ans-fb-dot ans-fb-dot--pulse" />
          Collecting responses...
        </span>
        <span className="ans-fb-timer">
          ⏱ {remainingSec}s
        </span>
      </div>

      {!hovered && (
        <div className="ans-fb-timer-bar">
          <div className="ans-fb-timer-bar-fill" style={{ width: `${timeoutPct}%` }} />
        </div>
      )}
    </div>
  )
}

function SummaryCard ({ round, onDismiss }) {
  const total = round.understood + round.stillConfused
  const expected = round.expectedRespondents || total || 1
  const understoodPct = total ? Math.round((round.understood / total) * 100) : 0
  const stillConfusedPct = total ? 100 - understoodPct : 0
  // Recommendation badge:
  //   - If 0 still_confused → "Most students understood"
  //   - If stillConfusedPct < 20 → "Most students understood"
  //   - If stillConfusedPct > 20 → "Many still confused, consider revisiting"
  const recommendContinue = stillConfusedPct <= 20
  const completionLabel = round.autoClosed
    ? 'All students responded'
    : (round.responseCount >= expected ? 'All students responded' : 'Round timed out')

  return (
    <div
      className="ans-fb-collector ans-fb-collector--summary"
      role="region"
      aria-label="Feedback summary"
    >
      <div className="ans-fb-head">
        <span className="ans-fb-icon">📊</span>
        <span className="ans-fb-title">Feedback Summary</span>
        <button className="ans-fb-close" aria-label="Dismiss" onClick={onDismiss}>×</button>
      </div>

      <div className="ans-fb-topic" title={round.topic}>{round.topic}</div>

      <div className="ans-fb-total">
        <span className="ans-fb-total-num">{total}</span>
        <span className="ans-fb-total-of">of {expected} students responded</span>
      </div>

      <div className="ans-fb-rows ans-fb-rows--summary">
        <div className="ans-fb-row ans-fb-row--green">
          <span className="ans-fb-row-label">
            <span className="ans-fb-emoji">✅</span> Understood
          </span>
          <span className="ans-fb-row-value">
            <strong>{round.understood}</strong>
            <span className="ans-fb-row-sub">students ({understoodPct}%)</span>
          </span>
        </div>
        <div className="ans-fb-row ans-fb-row--red">
          <span className="ans-fb-row-label">
            <span className="ans-fb-emoji">❌</span> Still Confused
          </span>
          <span className="ans-fb-row-value">
            <strong>{round.stillConfused}</strong>
            <span className="ans-fb-row-sub">students ({stillConfusedPct}%)</span>
          </span>
        </div>
      </div>

      <div className={`ans-fb-recommend ans-fb-recommend--${recommendContinue ? 'continue' : 'revisit'}`}>
        {recommendContinue ? (
          <>🟢 <strong>Most students understood the concept.</strong> Safe to continue.</>
        ) : (
          <>🟡 <strong>Many students are still confused.</strong> Consider revisiting the topic.</>
        )}
      </div>

      <div className="ans-fb-foot ans-fb-foot--summary">
        <span className="ans-fb-completion">{completionLabel}</span>
        <span className="ans-fb-elapsed">⏱ {Math.round((Date.now() - round.startedAt) / 1000)}s</span>
      </div>
    </div>
  )
}