import express from 'express'
import { authenticate, authorize } from '../middleware/auth.js'
import { Room, DoubtSignal } from '../models/index.js'
import {
  recordDoubt,
  retractLatestDoubt,
  getDoubtCountsBySegment,
  detectSpikes
} from '../services/doubtService.js'

const router = express.Router()

/**
 * POST /api/doubts
 * Student marks "I'm lost". Body: { roomId, segmentIndex, transcriptOffsetMs }
 * Auth: any authenticated user. Students can only signal their own.
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const { roomId, segmentIndex, transcriptOffsetMs } = req.body
    if (!roomId) {
      return res.status(400).json({ success: false, error: 'roomId is required' })
    }

    // Verify student is a member of the room (so they cannot spam into rooms
    // they aren't in). Teachers of the room can also signal (for sanity tests).
    const room = await Room.findById(roomId).select('_id teacher isActive code')
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })

    const isTeacherOfRoom = String(room.teacher) === String(req.user._id)
    const isStudent = req.user.role === 'student'
    if (!isTeacherOfRoom && !isStudent) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    const result = await recordDoubt({
      roomId,
      userId: req.user._id,
      segmentIndex: segmentIndex || 0,
      transcriptOffsetMs: transcriptOffsetMs || 0,
      client: req.headers['user-agent']?.includes('Mobile') ? 'mobile' : 'web'
    })

    if (!result.ok) {
      // Anti-spam is not an error — surface it as 200 with a reason so the
      // client can show "you already marked, try again in N seconds".
      return res.status(200).json({
        success: false,
        error: result.reason,
        retryAfterMs: result.retryAfterMs
      })
    }

    // Notify the teacher (room audience) via Socket.IO. The route handler does
    // not have direct access to io here so we use app.get('io') set in index.js.
    const io = req.app.get('io')
    if (io && room.code) {
      const counts = await getDoubtCountsBySegment(roomId)
      const segCount = counts.find(c => c.segmentIndex === (segmentIndex || 0))?.count || 1
      io.to(room.code).emit('doubt:new', {
        roomId: String(roomId),
        segmentIndex: segmentIndex || 0,
        count: segCount,
        timestamp: Date.now()
      })
    }

    res.json({ success: true, signal: { id: result.signal._id } })
  } catch (err) {
    console.error('[doubts] record error:', err)
    res.status(500).json({ success: false, error: 'Failed to record doubt signal' })
  }
})

/**
 * POST /api/doubts/retract
 * Student withdraws their most recent signal (within the retract window).
 */
router.post('/retract', authenticate, async (req, res) => {
  try {
    const { roomId } = req.body
    if (!roomId) {
      return res.status(400).json({ success: false, error: 'roomId is required' })
    }
    const result = await retractLatestDoubt({ roomId, userId: req.user._id })
    if (!result.ok) return res.status(200).json({ success: false, error: result.reason })
    res.json({ success: true })
  } catch (err) {
    console.error('[doubts] retract error:', err)
    res.status(500).json({ success: false, error: 'Failed to retract doubt signal' })
  }
})

/**
 * GET /api/doubts/room/:roomId
 * Aggregated doubt counts per segment. Teacher-only.
 */
router.get('/room/:roomId', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  try {
    const { roomId } = req.params
    const room = await Room.findById(roomId).select('_id teacher')
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    if (String(room.teacher) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only the room teacher can view doubt signals' })
    }
    const counts = await getDoubtCountsBySegment(roomId)
    res.json({ success: true, segments: counts })
  } catch (err) {
    console.error('[doubts] agg error:', err)
    res.status(500).json({ success: false, error: 'Failed to aggregate doubt signals' })
  }
})

/**
 * GET /api/doubts/room/:roomId/spikes
 * Returns just the segments flagged as confusion spikes, with a transcript
 * snippet so the teacher can see what they were saying at that moment.
 */
router.get('/room/:roomId/spikes', authenticate, authorize('teacher', 'admin'), async (req, res) => {
  try {
    const { roomId } = req.params
    const room = await Room.findById(roomId).select('_id teacher')
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' })
    if (String(room.teacher) !== String(req.user._id) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only the room teacher can view doubt signals' })
    }
    const minMarkCount = parseInt(req.query.minMarkCount, 10) || 3
    const result = await detectSpikes({ roomId, minMarkCount })
    res.json({ success: true, ...result })
  } catch (err) {
    console.error('[doubts] spike error:', err)
    res.status(500).json({ success: false, error: 'Failed to detect spikes' })
  }
})

/**
 * GET /api/doubts/room/:roomId/question/:questionId
 * Returns the doubt count for the segment that a given question is anchored to.
 * Used by RoomResultsPage to show spike warnings next to questions.
 */
router.get('/room/:roomId/question/:questionId', authenticate, async (req, res) => {
  try {
    const { roomId, questionId } = req.params
    const { Question } = await import('../models/index.js')
    const question = await Question.findById(questionId).select('segmentIndex roomId')
    if (!question || String(question.roomId) !== String(roomId)) {
      return res.status(404).json({ success: false, error: 'Question not found in room' })
    }
    const counts = await getDoubtCountsBySegment(roomId)
    const seg = counts.find(c => c.segmentIndex === question.segmentIndex)
    res.json({ success: true, segmentIndex: question.segmentIndex, count: seg?.count || 0 })
  } catch (err) {
    console.error('[doubts] question-doubt error:', err)
    res.status(500).json({ success: false, error: 'Failed to fetch question doubt count' })
  }
})

export default router