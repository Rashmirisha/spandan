import express from 'express'
import { authenticate, authorize } from '../middleware/auth.js'
import { Room } from '../models/index.js'
import {
  getActiveForRoom,
  getLatestForRoom,
  listForRoom,
  formatForClient,
  resolveEventByTeacher,
  reopenEvent
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
import { hashStudent } from '../services/doubtService.js'
import {
  startRecoveryPoll,
  recordRecoveryFeedback,
  getCurrentTally,
  getActivePollId,
  getActivePollForEvent,
  closePoll,
  listPollsForEvent
} from '../services/recoveryPollService.js'

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

    // ─── ROOT-CAUSE FIX (recovery-poll accumulation bug) ────────────
    // Every teacher click of "Ask Students: Did this help?" creates a
    // NEW RecoveryPoll with its own unique pollId. Old polls (and their
    // responses) are preserved in the RecoveryPoll collection for
    // historical analytics, but they no longer pollute the active
    // dashboard. The dashboard only ever shows the CURRENT poll's tally.
    //
    // `startRecoveryPoll` is idempotent: if there's already an active
    // poll for this event (e.g. teacher double-clicks before any student
    // answers), it returns the existing pollId with alreadyActive=true.
    // That means accidental double-clicks don't burn a poll number.
    const poll = await startRecoveryPoll(String(evt._id), {
      roomId: String(evt.roomId),
      topicLabel: evt.topicLabel || ''
    })

    const io = req.app.get('io')
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
      // Payload now carries `pollId` and `pollNumber` so the student
      // popup and the teacher dashboard can scope everything to a single
      // recovery round.
      const payload = {
        roomId: String(evt.roomId),
        eventId: String(evt._id),
        pollId: poll.pollId,
        pollNumber: poll.pollNumber,
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
        console.log('[confusion] request-feedback emit confusion:resolved to', socketIds.size, 'targeted sockets (of', roomMembers, 'room members,', expectedRespondents, 'expected) for room', room.code, 'event', String(evt._id), 'poll', poll.pollNumber, poll.pollId)
        for (const sid of socketIds) {
          io.to(sid).emit('confusion:resolved', payload)
        }
      } else {
        console.log('[confusion] request-feedback: no live sockets match event.studentIds — student prompt will surface when those students reconnect. room=', room.code, 'event=', String(evt._id), 'expectedRespondents=', expectedRespondents, 'poll=', poll.pollNumber)
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
      // New: the pollId the frontend should use for the next /feedback POST.
      pollId: poll.pollId,
      pollNumber: poll.pollNumber,
      alreadyActive: poll.alreadyActive,
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
    // BUG FIX (PR #35 recovery-poll round 2): the original route only
    // destructured `answer` from req.body. The recovery-poll rewrite added
    // `pollId` (forwarded from the student's popup) to scope the response
    // to the correct poll, but the destructure was never updated. That
    // left `bodyPollId` undefined and produced a ReferenceError on the
    // next line of code that referenced it, which the outer catch turned
    // into a 500 "Failed to record feedback" -- so every click of
    // Understood / Still Confused silently did nothing.
    const { answer, pollId: bodyPollId } = req.body || {}
    if (!['understood', 'still_confused'].includes(answer)) {
      return res.status(400).json({ success: false, error: 'answer must be "understood" or "still_confused"' })
    }

    // Load the event first -- we need its roomId to compute the student's
    // anonymous HMAC hash, and to know the originalConfused/autoClose count.
    const initialEvt = await ConfusionEvent.findById(eventId).lean()
    if (!initialEvt) {
      return res.status(404).json({ success: false, error: 'Confusion event not found' })
    }

    // Per-student dedup: compute the same HMAC-SHA256(userId, room.doubtSalt)
    // hash used by attachSignalToEvent and studentSocketRegistry. This is
    // what makes "one student spamming Still Confused" contribute at most
    // ONE count to the tally, and it's also what scopes the recovery emit
    // to only the originally-asked students.
    const roomForHash = await Room.findById(initialEvt.roomId).select('code doubtSalt teacher').lean()
    if (!roomForHash) {
      return res.status(404).json({ success: false, error: 'Room not found' })
    }
    const studentHash = hashStudent(req.user._id, roomForHash.doubtSalt)

    // ─── Resolve the recovery poll to record this response against ─────
    // Priority: explicit pollId in body (fresh from the student's popup)
    //   > the currently-active poll for this event (in-memory lookup)
    //   > the latest persisted active poll for this event (DB fallback
    //     after a server restart wiped the in-memory map)
    let resolvedPollId = bodyPollId || getActivePollId(eventId)
    if (!resolvedPollId) {
      const last = await getActivePollForEvent(eventId)
      if (last) resolvedPollId = String(last._id)
    }
    if (!resolvedPollId) {
      return res.status(409).json({
        success: false,
        error: 'No active recovery poll for this event. The teacher must click "Ask Students" first.'
      })
    }

    // Record this student's response against the resolved poll.
    // Per-student dedup inside the poll: same student overwriting their
    // previous answer does NOT inflate the count.
    let pollResult
    try {
      pollResult = await recordRecoveryFeedback(resolvedPollId, studentHash, answer)
    } catch (e) {
      if (e && /not active/i.test(e.message)) {
        return res.status(409).json({
          success: false,
          error: 'Recovery poll is no longer active. The teacher may have started a new poll.'
        })
      }
      throw e
    }

    let evt = initialEvt
    if (answer === 'still_confused') {
      // still_confused: keep the event active. No auto-close.
      evt = await reopenEvent(eventId)
    }

    // RECOVERY FLOW METRICS (PR #35 fix, scoped to THIS poll).
    //
    // The recovery denominator for THIS poll is `responded` = unique
    // students who have answered THIS poll. NOT confusedStudentCount.
    //
    // Auto-close: when everyone who can respond has answered "understood"
    // AND no one is still confused, close THIS poll (not the ConfusionEvent
    // -- the teacher can start another poll if they want to ask again).
    const io = req.app.get('io')
    let eligibleRespondents = 0
    if (io) {
      try {
        const r = resolveRecoveryRecipients({
          io,
          roomId: String(initialEvt.roomId),
          roomSalt: roomForHash.doubtSalt,
          studentHashes: new Set(initialEvt.studentIds || [])
        })
        eligibleRespondents = r.socketIds.size
      } catch (_) { eligibleRespondents = 0 }
    }
    if (eligibleRespondents === 0) {
      // Room empty / no sockets -- fall back to studentIds count so we
      // don't auto-close on the first response when nobody else is around.
      eligibleRespondents = (initialEvt.studentIds || []).length
    }

    let autoClosed = false
    let autoClosedAt = null
    if (answer === 'understood' && pollResult.understood >= eligibleRespondents && pollResult.stillConfused === 0 && eligibleRespondents > 0) {
      const closed = await closePoll(resolvedPollId, 'auto_closed')
      if (closed) {
        autoClosed = true
        autoClosedAt = closed.closedAt
      }
    }

    const originalConfused = initialEvt.confusedStudentCount || (initialEvt.studentIds ? initialEvt.studentIds.length : 0)
    const responded = pollResult.responded // u + sc for THIS poll
    const needsMoreExplanation = pollResult.stillConfused > 0

    const payload = {
      roomId: String(initialEvt.roomId),
      eventId: String(initialEvt._id),
      // New: scope every tally update to a single recovery poll. The
      // dashboard uses pollId to discard stale updates from old polls.
      pollId: resolvedPollId,
      pollNumber: pollResult.pollNumber,
      answer,
      originalConfused,
      eligibleRespondents,
      responded, // <- recovery denominator for THIS poll
      understood: pollResult.understood,
      stillConfused: pollResult.stillConfused,
      recoveryPercent: responded > 0 ? Math.round((pollResult.understood / responded) * 100) : 0,
      expectedRespondents: originalConfused, // legacy back-compat
      needsMoreExplanation,
      autoClosed,
      autoClosedAt,
      reopened: answer === 'still_confused' && !autoClosed,
      reopenedCount: evt.reopenedCount || 0,
      topic: initialEvt.topicLabel || 'General Confusion'
    }

    if (io && roomForHash?.code) {
      io.to(roomForHash.code).emit('confusion:feedback', payload)
      if (autoClosed) {
        io.to(roomForHash.code).emit('confusion:closed', {
          roomId: String(initialEvt.roomId),
          eventId: String(initialEvt._id),
          pollId: resolvedPollId,
          pollNumber: pollResult.pollNumber,
          reason: 'all_eligible_understood',
          topic: initialEvt.topicLabel || 'General Confusion',
          originalConfused,
          responded,
          understood: pollResult.understood,
          recoveryPercent: payload.recoveryPercent
        })
      }
    }
    res.json({
      success: true,
      pollId: resolvedPollId,
      pollNumber: pollResult.pollNumber,
      originalConfused,
      eligibleRespondents,
      responded,
      understood: pollResult.understood,
      stillConfused: pollResult.stillConfused,
      recoveryPercent: payload.recoveryPercent,
      // Legacy field name, kept so any other callers don't break.
      expectedRespondents: originalConfused,
      needsMoreExplanation,
      autoClosed
    })
  } catch (err) {
    console.error('[confusion] feedback error:', err)
    res.status(500).json({ success: false, error: 'Failed to record feedback' })
  }
})

/**
 * RECOVERY HISTORY: list all recovery polls for an event.
 *
 * GET /api/confusion/event/:eventId/recovery-polls
 * - Auth: any authenticated user (history is metadata only; per-student
 *   responses are HMAC hashes that don't leak identity).
 * - Returns polls sorted newest first, including pollNumber, status,
 *   startedAt, closedAt, closedReason, and cached counts.
 *
 * This is for analytics/debugging -- the ACTIVE dashboard reads only the
 * current poll, never the history.
 */
router.get('/event/:eventId/recovery-polls', authenticate, async (req, res) => {
  try {
    const { eventId } = req.params
    const polls = await listPollsForEvent(eventId)
    const active = await getActivePollForEvent(eventId)
    res.json({
      success: true,
      activePollId: active ? String(active._id) : null,
      polls: polls.map(p => ({
        pollId: String(p._id),
        pollNumber: p.pollNumber,
        status: p.status,
        closedReason: p.closedReason,
        startedAt: p.startedAt,
        closedAt: p.closedAt,
        understood: p.cachedUnderstood,
        stillConfused: p.cachedStillConfused,
        responded: p.cachedResponded
      }))
    })
  } catch (err) {
    console.error('[confusion] recovery-polls list error:', err)
    res.status(500).json({ success: false, error: 'Failed to list recovery polls' })
  }
})

export default router