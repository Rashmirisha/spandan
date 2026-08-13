import express from 'express'
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
  getFeedbackTally
} from '../services/confusionEventService.js'
import { ConfusionEvent } from '../models/index.js'
import {
  buildTopicHeat,
  buildHeatmap
} from '../services/confusionScoring.js'
import {
  installOnIo,
  resolveRecoveryRecipients,
  noteRoomCode
} from '../services/studentSocketRegistry.js'

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
 * - Effect: emit 'confusion:resolved' ONLY to the sockets whose userId
 *   hashes to one of the event's studentIds for this room's salt. A
 *   student who did NOT press "I'm Lost" never sees the popup.
 *   See services/studentSocketRegistry.js for the anonymous-hash → socket
 *   lookup (HMAC-SHA256(userId, room.doubtSalt)).
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
    const room = await Room.findById(evt.roomId).select('code teacher doubtSalt').lean()
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    if (String(room.teacher) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only the room teacher can request feedback' })
    }
    const io = req.app.get('io')
    // Lazy-install the socket registry hook on first use. Idempotent.
    if (io) installOnIo(io)

    const studentHashes = new Set(evt.studentIds || [])
    const expectedRespondents = evt.confusedStudentCount || studentHashes.size

    if (io && room.code) {
      // Note the room code so the registry can count room members for
      // diagnostics without an extra DB read.
      noteRoomCode(String(evt.roomId), room.code)
      const { socketIds, studentHashes: matchedHashes, roomMembers } = resolveRecoveryRecipients({
        io,
        roomId: String(evt.roomId),
        roomSalt: room.doubtSalt,
        studentHashes
      })
      const payload = {
        roomId: String(evt.roomId),
        eventId: String(evt._id),
        topic: evt.topicLabel || 'General Confusion',
        expectedRespondents,
        // Tell the client who exactly is being asked (so the frontend can
        // log when expected != recipients-online for observability).
        recipientsOnline: socketIds.size,
        matchedHashes: matchedHashes.size,
        roomMembers
      }
      // 1) Emit confusion:resolved ONLY to the targeted student sockets
      //    (those whose hash is in event.studentIds). This is the PR #35
      //    fix: the recovery popup goes ONLY to students who pressed
      //    "I'm Lost", never to the whole room.
      if (socketIds.size > 0) {
        console.log('[confusion] request-feedback emit confusion:resolved to', socketIds.size, 'targeted sockets (of', roomMembers, 'room members,', expectedRespondents, 'expected) for room', room.code, 'event', String(evt._id))
        for (const sid of socketIds) {
          io.to(sid).emit('confusion:resolved', payload)
        }
      } else {
        console.log('[confusion] request-feedback: no live sockets match event.studentIds — student prompt will surface when those students reconnect. room=', room.code, 'event=', String(evt._id), 'expectedRespondents=', expectedRespondents)
      }

      // 2) Emit confusion:resolved ALSO to the room (minus the targeted
      //    sockets we already sent to) so the teacher's dashboard can
      //    clear its active-event display and start the feedback tally.
      //    We use the targeted socket list to avoid double-delivery to
      //    students (who would otherwise see the popup twice).
      try {
        const adapter = io.sockets.adapter
        const roomSet = adapter && adapter.rooms && adapter.rooms.get(room.code)
        if (roomSet) {
          const teacherPayload = { ...payload }
          // The teacher dashboard cares about the event, not the student
          // popup, so we can keep the same payload shape.
          for (const sid of roomSet) {
            if (socketIds.has(sid)) continue // already sent above
            const sock = io.sockets.sockets.get(sid)
            if (!sock) continue
            // Only deliver to sockets that represent the teacher (or any
            // non-student observer). Student sockets have already been
            // covered above (or intentionally excluded because their hash
            // isn\'t in event.studentIds).
            const role = sock.data?.role
            if (role === 'teacher' || role === 'admin') {
              io.to(sid).emit('confusion:resolved', teacherPayload)
            }
          }
        }
      } catch (err) {
        console.warn('[confusion] request-feedback: teacher-dashboard emit failed (non-fatal):', err.message)
      }
    }
    res.json({
      success: true,
      event: formatForClient(evt),
      // Surface targeting info to the caller (teacher dashboard) so they
      // can show "X students were notified".
      targeting: {
        expectedRespondents,
        studentHashes: studentHashes.size,
        recipientsOnline: io ? resolveRecoveryRecipients({
          io,
          roomId: String(evt.roomId),
          roomSalt: room.doubtSalt,
          studentHashes
        }).socketIds.size : 0
      }
    })
  } catch (err) {
    console.error('[confusion] request-feedback error:', err)
    res.status(500).json({ success: false, error: 'Failed to request feedback' })
  }
})

/**
 * Backwards-compat alias: old /resolve route now behaves like /request-feedback.
 * Keeps any client that still POSTs to the old endpoint working.
 */
router.post('/event/:eventId/resolve', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  req.url = req.url.replace('/resolve', '/request-feedback')
  return router.handle(req, res, () => {})
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
    const tally = recordFeedback(eventId, answer)
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
    const expectedRespondents = evt.confusedStudentCount || (evt.studentIds ? evt.studentIds.length : tally.understood + tally.stillConfused)
    let autoClosed = false
    if (answer === 'understood' && tally.understood >= expectedRespondents && tally.stillConfused === 0) {
      const closed = await resolveEventByTeacher(eventId)
      if (closed) {
        evt = closed
        autoClosed = true
      }
    }
    const room = await Room.findById(evt.roomId).select('code').lean()
    const io = req.app.get('io')
    if (io && room?.code) {
      const needsMoreExplanation = tally.stillConfused > 0
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
        topic: evt.topic
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
      autoClosed
    })
  } catch (err) {
    console.error('[confusion] feedback error:', err)
    res.status(500).json({ success: false, error: 'Failed to record feedback' })
  }
})

export default router