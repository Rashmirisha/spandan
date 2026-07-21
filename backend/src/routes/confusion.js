import express from 'express'
import crypto from 'crypto'
import { authenticate, authorize } from '../middleware/auth.js'
import { Room } from '../models/index.js'
import {
  getActiveForRoom,
  getLatestForRoom,
  listForRoom,
  formatForClient,
  resolveEventByTeacher,
  recordFeedback,
  reopenEvent,
  getFeedbackTally,
  openFeedbackRound,
  recordFeedbackPersistent,
  completeFeedbackRound
} from '../services/confusionEventService.js'
import { ConfusionEvent } from '../models/index.js'
import {
  buildTopicHeat,
  buildHeatmap
} from '../services/confusionScoring.js'

const router = express.Router()

/**
 * GET /api/confusion/room/:roomId/active
 * Currently-live confusion event for the room (or null).
 * Auth: teacher of the room OR admin OR a student in the room.
 */
router.get('/room/:roomId/active', authenticate, async (req, res) => {
  try {
    const { roomId } = req.params
    const room = await Room.findById(roomId).select('_id teacher members')
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    const isTeacher = String(room.teacher) === String(req.user._id)
    const isAdmin = req.user.role === 'admin'
    if (!isTeacher && !isAdmin) {
      return res.status(403).json({ success: false, error: 'Only the room teacher can view confusion events' })
    }
    const active = await getActiveForRoom(roomId)
    res.json({ success: true, event: formatForClient(active) })
  } catch (err) {
    console.error('[confusion] active error:', err)
    res.status(500).json({ success: false, error: 'Failed to fetch active confusion event' })
  }
})

/**
 * GET /api/confusion/room/:roomId/latest
 * Most-recent event regardless of status. Used by the dashboard during
 * the millisecond gap between close-and-reopen.
 */
router.get('/room/:roomId/latest', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  try {
    const { roomId } = req.params
    const room = await Room.findById(roomId).select('_id teacher')
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    if (String(room.teacher) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only the room teacher can view confusion events' })
    }
    const latest = await getLatestForRoom(roomId)
    res.json({ success: true, event: formatForClient(latest) })
  } catch (err) {
    console.error('[confusion] latest error:', err)
    res.status(500).json({ success: false, error: 'Failed to fetch latest confusion event' })
  }
})

/**
 * GET /api/confusion/room/:roomId
 * History list of confusion events for a room, newest first.
 * Query params: limit (default 50, max 200)
 */
router.get('/room/:roomId', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  try {
    const { roomId } = req.params
    const room = await Room.findById(roomId).select('_id teacher')
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    if (String(room.teacher) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only the room teacher can view confusion events' })
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200)
    const events = await listForRoom({ roomId, limit })
    res.json({ success: true, events: events.map(formatForClient) })
  } catch (err) {
    console.error('[confusion] list error:', err)
    res.status(500).json({ success: false, error: 'Failed to fetch confusion events' })
  }
})

/**
 * GET /api/confusion/room/:roomId/topic-heat
 * Ranked list of topics by aggregated confusion score.
 * Query params: topN (default 10, max 50)
 */
router.get('/room/:roomId/topic-heat', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  try {
    const { roomId } = req.params
    const room = await Room.findById(roomId).select('_id teacher')
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    if (String(room.teacher) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only the room teacher can view topic heat' })
    }
    const topN = Math.min(parseInt(req.query.topN, 10) || 10, 50)
    const events = await listForRoom({ roomId, limit: 200 })
    const buckets = buildTopicHeat(events, topN)
    res.json({ success: true, buckets })
  } catch (err) {
    console.error('[confusion] topic-heat error:', err)
    res.status(500).json({ success: false, error: 'Failed to compute topic heat' })
  }
})

/**
 * GET /api/confusion/room/:roomId/heatmap
 * Time-bucketed scores across the recent window.
 * Query params: bucketMs (default 60s), windowMs (default 10min)
 */
router.get('/room/:roomId/heatmap', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  try {
    const { roomId } = req.params
    const room = await Room.findById(roomId).select('_id teacher')
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    if (String(room.teacher) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only the room teacher can view heatmap' })
    }
    const bucketMs = Math.min(parseInt(req.query.bucketMs, 10) || 60000, 300000)
    const windowMs = Math.min(parseInt(req.query.windowMs, 10) || 600000, 3600000)
    const events = await listForRoom({ roomId, limit: 200 })
    const heat = buildHeatmap(events, { bucketMs, windowMs })
    res.json({ success: true, heat })
  } catch (err) {
    console.error('[confusion] heatmap error:', err)
    res.status(500).json({ success: false, error: 'Failed to compute heatmap' })
  }
})

/**
 * RECOVERY FLOW: teacher requests student feedback on a confusion event.
 * (Replaces the old /resolve endpoint. Does NOT close the event.)
 *
 * POST /api/confusion/event/:eventId/request-feedback
 * - Auth: teacher only (must own the room)
 * - Effect: emit 'confusion:resolved' to the room code so each associated
 *   student sees "Did this explanation help?" popup.
 * - The event stays active. Auto-close happens in /feedback when all
 *   associated students have responded "understood".
 */
router.post('/event/:eventId/request-feedback', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  try {
    const { eventId } = req.params
    const evt = await ConfusionEvent.findById(eventId).lean()
    if (!evt) {
      return res.status(404).json({ success: false, error: 'Confusion event not found' })
    }
    const room = await Room.findById(evt.roomId).select('code teacher').lean()
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    if (String(room.teacher) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only the room teacher can request feedback' })
    }
    // Open the persistent feedback round so stats survive backend restarts.
    const fresh = await openFeedbackRound(eventId)
    const expectedRespondents = fresh?.feedbackStats?.expectedRespondents
      ?? evt.confusedStudentCount
      ?? (Array.isArray(evt.studentIds) ? evt.studentIds.length : 0)
    const io = req.app.get('io')
    if (io && room.code) {
      const payload = {
        roomId: String(evt.roomId),
        eventId: String(evt._id),
        topic: evt.topicLabel || 'General Confusion',
        expectedRespondents,
        requestedAt: fresh?.feedbackStats?.requestedAt || new Date().toISOString()
      }
      console.log('[confusion] request-feedback emit confusion:resolved to room', room.code, payload)
      io.to(room.code).emit('confusion:resolved', payload)
      // ALSO emit confusion:feedback:request -- a dedicated event so the
      // teacher dashboard's FeedbackCollector card can hydrate without
      // confusing it with the student-side popup.
      io.to(room.code).emit('confusion:feedback:request', payload)
    }
    res.json({
      success: true,
      event: fresh ? formatForClient(fresh) : formatForClient(evt),
      feedbackStats: fresh?.feedbackStats || null,
      expectedRespondents
    })
  } catch (err) {
    console.error('[confusion] request-feedback error:', err)
    res.status(500).json({ success: false, error: 'Failed to request feedback' })
  }
})

/**
 * FORCE RESOLVE: teacher clicks "Mark Resolved" — close the event IMMEDIATELY
 * without waiting for student feedback. Emits confusion:closed so all
 * connected dashboards remove it from the Live Confusion Overview and
 * move it into Recent Confusion Events with status='closed'.
 *
 * POST /api/confusion/event/:eventId/resolve
 * - Auth: teacher only (must own the room)
 * - Effect: close the event in the DB, emit confusion:closed to the room code
 *
 * This is intentionally DIFFERENT from /request-feedback:
 *   /request-feedback  -> keep event active, prompt students
 *   /resolve           -> close the event NOW (force)
 */
router.post('/event/:eventId/resolve', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  try {
    const { eventId } = req.params
    if (!ConfusionEvent || !ConfusionEvent.findById) {
      return res.status(500).json({ success: false, error: 'ConfusionEvent model unavailable' })
    }
    const evt = await ConfusionEvent.findById(eventId)
    if (!evt) return res.status(404).json({ success: false, error: 'Confusion event not found' })
    if (evt.status === 'closed') {
      // Idempotent — already closed. Return the existing event.
      return res.json({ success: true, event: formatForClient(evt.toObject ? evt.toObject() : evt), alreadyClosed: true })
    }
    const room = await Room.findById(evt.roomId).select('code teacher').lean()
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    if (String(room.teacher) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only the room teacher can resolve' })
    }

    // Close the event in the DB
    evt.status = 'closed'
    evt.closedAt = new Date()
    await evt.save()

    const closed = formatForClient(evt.toObject())

    // Broadcast so every connected teacher dashboard removes the live card
    const io = req.app.get('io')
    if (io && room.code) {
      io.to(room.code).emit('confusion:closed', {
        roomId: String(evt.roomId),
        eventId: String(evt._id),
        reason: 'teacher_resolved',
        event: closed
      })
    }

    console.log('[confusion] /resolve closed event', String(evt._id), 'for room', room.code)
    res.json({ success: true, event: closed })
  } catch (err) {
    console.error('[confusion] resolve error:', err)
    res.status(500).json({ success: false, error: 'Failed to resolve confusion event' })
  }
})

/**
 * RESOLVED PROMPT: student responds to the resolved-prompt popup.
 *
 * POST /api/confusion/event/:eventId/feedback
 * - Auth: any authenticated user
 * - Body: { answer: 'understood' | 'still_confused' }
 * - Effect:
 *     understood    -> tally++
 *     still_confused -> tally++ AND reopen event (status='active')
 * - Emit: 'confusion:feedback' to the room code (teacher dashboard listens)
 */
router.post('/event/:eventId/feedback', authenticate, async (req, res) => {
  try {
    const { eventId } = req.params
    const { answer } = req.body || {}
    if (!['understood', 'still_confused'].includes(answer)) {
      return res.status(400).json({ success: false, error: 'answer must be "understood" or "still_confused"' })
    }
    // Persist the answer against the event's feedbackStats (idempotent by student).
    // Also keep the legacy in-memory tally updated so existing listeners don't drift.
    // Compute a per-student anonymous hash so we can dedupe across sessions.
    const studentHash = computeStudentHash(req.user)
    const persistent = await recordFeedbackPersistent(eventId, {
      studentId: req.user?._id,
      studentHash,
      answer
    })
    const tally = persistent.isNew
      ? recordFeedback(eventId, answer)
      : getFeedbackTally(eventId)

    let evt = null
    if (answer === 'still_confused') {
      // still_confused: keep the event active. No auto-close.
      evt = await reopenEvent(eventId)
    } else {
      evt = await ConfusionEvent.findById(eventId).lean()
    }
    if (!evt) {
      return res.status(404).json({ success: false, error: 'Confusion event not found' })
    }
    // RECOVERY FLOW: compute expected respondents. If tally.understood has
    // reached the expected count, auto-close the event.
    const fs = evt.feedbackStats || {}
    const expectedRespondents = fs.expectedRespondents
      || evt.confusedStudentCount
      || (evt.studentIds ? evt.studentIds.length : tally.understood + tally.stillConfused)
    let autoClosed = false
    if (answer === 'understood' && tally.understood >= expectedRespondents && tally.stillConfused === 0) {
      const closed = await resolveEventByTeacher(eventId)
      if (closed) {
        evt = closed
        autoClosed = true
        await completeFeedbackRound(eventId, { status: 'completed' })
      }
    }
    const room = await Room.findById(evt.roomId).select('code').lean()
    const io = req.app.get('io')
    if (io && room?.code) {
      const needsMoreExplanation = tally.stillConfused > 0
      const fsPayload = {
        status: fs.status || (autoClosed ? 'completed' : 'pending'),
        expectedRespondents,
        understood: tally.understood,
        stillConfused: tally.stillConfused,
        responseCount: Array.isArray(fs.responses) ? fs.responses.length : (tally.understood + tally.stillConfused)
      }
      io.to(room.code).emit('confusion:feedback', {
        roomId: String(evt.roomId),
        eventId: String(evt._id),
        answer,
        understood: tally.understood,
        stillConfused: tally.stillConfused,
        expectedRespondents,
        needsMoreExplanation,
        autoClosed,
        reopened: answer === 'still_confused' && !autoClosed,
        reopenedCount: evt.reopenedCount || 0,
        topic: evt.topic,
        feedbackStats: fsPayload
      })
      if (autoClosed) {
        io.to(room.code).emit('confusion:closed', {
          roomId: String(evt.roomId),
          eventId: String(evt._id),
          reason: 'all_students_understood',
          topic: evt.topic
        })
      }
    }
    res.json({
      success: true,
      understood: tally.understood,
      stillConfused: tally.stillConfused,
      expectedRespondents,
      needsMoreExplanation: tally.stillConfused > 0,
      autoClosed,
      feedbackStats: {
        status: persistent.completed ? 'completed' : 'pending',
        expectedRespondents,
        understoodCount: tally.understood,
        stillConfusedCount: tally.stillConfused,
        responseCount: tally.understood + tally.stillConfused
      }
    })
  } catch (err) {
    console.error('[confusion] feedback error:', err)
    res.status(500).json({ success: false, error: 'Failed to record feedback' })
  }
})

/**
 * Tiny helper: derive a 64-char hex HMAC hash from the authenticated user.
 * We use it as an anonymous identifier so we can dedupe student responses
 * per round without leaking user data. Same input + same salt => same hash.
 */
function computeStudentHash (user) {
  if (!user) return ''
  // Use a per-process salt so hashes are not stable across deployments.
  // (Acceptable for a demo-grade anonymous id; for prod this should be
  // an HMAC with a stable salt stored in env.)
  const salt = process.env.STUDENT_HASH_SALT || 'spandan-feedback-salt'
  const id = user._id ? String(user._id) : (user.id || user.email || '')
  return crypto.createHmac('sha256', salt).update(id).digest('hex')
}

export default router