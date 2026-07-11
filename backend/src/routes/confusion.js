import express from 'express'
import { authenticate, authorize } from '../middleware/auth.js'
import { Room } from '../models/index.js'
import {
  getActiveForRoom,
  getLatestForRoom,
  listForRoom,
  formatForClient
} from '../services/confusionEventService.js'

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

export default router