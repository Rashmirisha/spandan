import crypto from 'crypto'
import mongoose from 'mongoose'
import { DoubtSignal, Room } from '../models/index.js'

/**
 * Per-room salt for anonymous student hashes. Stored on Room.doubtSalt.
 * Lazy-generated on first signal; rotated when the room ends so signals
 * cannot be linked across sessions.
 */
async function ensureRoomSalt (roomId) {
  const room = await Room.findById(roomId).select('doubtSalt')
  if (!room) return null
  if (!room.doubtSalt) {
    const salt = crypto.randomBytes(32).toString('hex')
    await Room.updateOne({ _id: roomId }, { $set: { doubtSalt: salt } })
    return salt
  }
  return room.doubtSalt
}

export function hashStudent (userId, salt) {
  return crypto.createHmac('sha256', salt).update(String(userId)).digest('hex')
}

const ANTI_SPAM_MS = 30 * 1000 // one signal per student per 30s, regardless of segment

/**
 * Record a doubt signal. Returns { ok, signal, reason } — reason is set when
 * the call was deliberately ignored (anti-spam or already-retracted-then-readded).
 */
export async function recordDoubt ({ roomId, userId, segmentIndex, transcriptOffsetMs, client }) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return { ok: false, reason: 'invalid_room_id' }
  }
  const room = await Room.findById(roomId).select('_id isActive doubtSalt')
  if (!room) return { ok: false, reason: 'room_not_found' }
  if (!room.isActive) return { ok: false, reason: 'room_ended' }

  const salt = room.doubtSalt || (await ensureRoomSalt(roomId))
  const studentHash = hashStudent(userId, salt)

  // Anti-spam: ignore if the same student signaled within ANTI_SPAM_MS
  const recent = await DoubtSignal.findOne({
    roomId,
    studentHash,
    retracted: false,
    createdAt: { $gt: new Date(Date.now() - ANTI_SPAM_MS) }
  }).sort({ createdAt: -1 })
  if (recent) return { ok: false, reason: 'anti_spam', retryAfterMs: ANTI_SPAM_MS }

  const signal = await DoubtSignal.create({
    roomId,
    studentHash,
    segmentIndex: Math.max(0, parseInt(segmentIndex, 10) || 0),
    transcriptOffsetMs: Math.max(0, parseInt(transcriptOffsetMs, 10) || 0),
    client: { type: client || 'web' }
  })

  return { ok: true, signal }
}

/**
 * Retract a signal. Only the original student (by hash) can retract, and only
 * within the retract window. We find the most recent non-retracted signal for
 * this hash in the room and mark it.
 */
const RETRACT_WINDOW_MS = 60 * 1000

export async function retractLatestDoubt ({ roomId, userId }) {
  const salt = await ensureRoomSalt(roomId)
  if (!salt) return { ok: false, reason: 'room_not_found' }
  const studentHash = hashStudent(userId, salt)
  const latest = await DoubtSignal.findOne({
    roomId,
    studentHash,
    retracted: false,
    createdAt: { $gt: new Date(Date.now() - RETRACT_WINDOW_MS) }
  }).sort({ createdAt: -1 })
  if (!latest) return { ok: false, reason: 'nothing_to_retract' }
  latest.retracted = true
  await latest.save()
  return { ok: true }
}

/**
 * Aggregate distinct-student counts per segmentIndex for a room.
 * Output: [{ segmentIndex, count }]
 */
export async function getDoubtCountsBySegment (roomId) {
  return DoubtSignal.countDistinctStudentsBySegment(roomId)
}

/**
 * Detect confusion spikes. A segment is a spike when:
 *   - rawCount >= minMarkCount  (default 3), OR
 *   - rawCount >= mean + spikeStdDevMultiplier * stddev  (default 2.0)
 *
 * Returns { spikes: [{ segmentIndex, count, transcriptSnippet }], allSegments: [...] }
 * Includes a small transcript snippet per spike so the UI can show "you said
 * 'glycolysis produces 2 ATP' at this moment" without a second API call.
 */
export async function detectSpikes ({ roomId, minMarkCount = 3, spikeStdDevMultiplier = 2.0 }) {
  const { Transcript } = await import('../models/index.js')
  const counts = await getDoubtCountsBySegment(roomId)
  if (counts.length === 0) return { spikes: [], allSegments: counts }

  const values = counts.map(c => c.count)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  const stddev = Math.sqrt(variance)
  const spikeThreshold = mean + spikeStdDevMultiplier * stddev

  // Fetch transcripts once for snippet lookup
  const transcripts = await Transcript.find({ roomId })
    .select('segmentIndex text')
    .lean()
  const transcriptBySeg = new Map(transcripts.map(t => [t.segmentIndex, t.text]))

  const spikes = counts
    .filter(c => c.count >= minMarkCount || c.count >= spikeThreshold)
    .map(c => ({
      segmentIndex: c.segmentIndex,
      count: c.count,
      transcriptSnippet: (transcriptBySeg.get(c.segmentIndex) || '').slice(0, 200)
    }))
    .sort((a, b) => b.count - a.count)

  return { spikes, allSegments: counts, stats: { mean, stddev, threshold: spikeThreshold } }
}