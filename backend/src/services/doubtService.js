import crypto from 'crypto'
import mongoose from 'mongoose'
import { DoubtSignal, Room } from '../models/index.js'
import { annotateSpikesWithTopics } from './topicService.js'

/**
 * Per-room salt for anonymous student hashes. Stored on Room.doubtSalt.
 * Lazy-generated on first signal; rotated when the room ends so signals
 * cannot be linked across sessions.
 */
export async function ensureRoomSalt (roomId) {
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
export async function recordDoubt ({ roomId, userId, segmentIndex, transcriptOffsetMs, client, recordingOffsetMs, utteranceSnapshot, clientSentAt }) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return { ok: false, reason: 'invalid_room_id' }
  }
  const room = await Room.findById(roomId).select('_id isActive doubtSalt roomStartedAt')
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

  // Compute recordingOffsetMs server-side if client didn't provide one
  // (more authoritative -- uses server clock + roomStartedAt).
  let computedRecordingOffsetMs = null
  if (typeof recordingOffsetMs === 'number' && recordingOffsetMs >= 0) {
    computedRecordingOffsetMs = recordingOffsetMs
  } else if (room.roomStartedAt) {
    const sentAt = clientSentAt ? new Date(clientSentAt) : new Date()
    // Clamp to non-negative (clock skew could go slightly negative)
    computedRecordingOffsetMs = Math.max(0, sentAt.getTime() - room.roomStartedAt.getTime())
  }

  const signal = await DoubtSignal.create({
    roomId,
    studentHash,
    segmentIndex: Math.max(0, parseInt(segmentIndex, 10) || 0),
    transcriptOffsetMs: Math.max(0, parseInt(transcriptOffsetMs, 10) || 0),
    clientSentAt: clientSentAt ? new Date(clientSentAt) : new Date(),
    recordingOffsetMs: computedRecordingOffsetMs,
    utteranceSnapshot: typeof utteranceSnapshot === 'string' ? utteranceSnapshot.slice(0, 500) : '',
    client: { type: client || 'web' }
  })

  return { ok: true, signal }
}

/**
 * Mark a room's recording clock origin. Called when the teacher starts the
 * recording / session. All subsequent doubt signals anchor their
 * `recordingOffsetMs` against this.
 */
export async function startRoomSession (roomId, teacherId) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return { ok: false, reason: 'invalid_room_id' }
  }
  const room = await Room.findById(roomId)
  if (!room) return { ok: false, reason: 'room_not_found' }
  // Only the room's teacher can start the session
  if (String(room.teacher) !== String(teacherId)) {
    return { ok: false, reason: 'not_teacher' }
  }
  room.roomStartedAt = new Date()
  await room.save()
  return { ok: true, roomStartedAt: room.roomStartedAt }
}

/**
 * Get a room's current recording clock + most-recent teacher position
 * (for late-joining students who need to sync up).
 */
export async function getRoomSession (roomId) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return { ok: false, reason: 'invalid_room_id' }
  }
  const room = await Room.findById(roomId).select('_id isActive roomStartedAt').lean()
  if (!room) return { ok: false, reason: 'room_not_found' }
  return {
    ok: true,
    roomStartedAt: room.roomStartedAt,
    isActive: room.isActive,
    // Server-side current recording offset, useful if student just joined
    currentRecordingOffsetMs: room.roomStartedAt
      ? Math.max(0, Date.now() - new Date(room.roomStartedAt).getTime())
      : null
  }
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
    .map(c => {
      const segSnippet = (transcriptBySeg.get(c.segmentIndex) || '').slice(0, 200)
      return {
        segmentIndex: c.segmentIndex,
        count: c.count,
        transcriptSnippet: segSnippet,
        hasTranscript: !!transcriptBySeg.get(c.segmentIndex)
      }
    })
    .sort((a, b) => b.count - a.count)

  return { spikes, allSegments: counts, stats: { mean, stddev, threshold: spikeThreshold } }
}

/**
 * NEW: Get per-spike details with recording timestamps + utterance snapshots.
 * This is the data the teacher UI really wants. Goes signal-by-signal to
 * show *when* each signal arrived and *what the teacher said* at that moment.
 */
export async function getSpikeDetails ({ roomId, bucketMs = 5000, minMarkCount = 3 }) {
  const bucketCounts = await DoubtSignal.countDistinctStudentsByRecordingTime(roomId, bucketMs)
  let spikes = bucketCounts
    .filter(b => b.count >= minMarkCount)
    .map(b => ({
      recordingOffsetMs: b.recordingOffsetMs,
      recordingOffsetLabel: formatMs(b.recordingOffsetMs),
      count: b.count,
      sampleUtterance: b.sampleUtterance || ''
    }))
    .sort((a, b) => a.recordingOffsetMs - b.recordingOffsetMs)
  // Augment each spike with the topic label (teacher-set marker or transcript proxy)
  spikes = await annotateSpikesWithTopics({ roomId, spikes })
  return { spikes, bucketMs }
}

/**
 * NEW: Get all signals for a room, time-anchored, so the teacher can replay
 * "where was each student when they tapped?". Returns:
 *   [{ recordingOffsetMs, recordingOffsetLabel, utteranceSnapshot,
 *      studentHashShort (first 8 chars for display), clientSentAt, retracted }]
 */
export async function getSignalsForRoom (roomId, opts = {}) {
  const limit = Math.min(opts.limit || 200, 1000)
  const signals = await DoubtSignal.find({ roomId })
    .sort({ recordingOffsetMs: 1, createdAt: 1 })
    .limit(limit)
    .lean()
  const mapped = signals.map(s => ({
    _id: s._id,
    segmentIndex: s.segmentIndex,
    transcriptOffsetMs: s.transcriptOffsetMs,
    recordingOffsetMs: s.recordingOffsetMs,
    recordingOffsetLabel: formatMs(s.recordingOffsetMs || 0),
    utteranceSnapshot: s.utteranceSnapshot || '',
    studentHashShort: (s.studentHash || '').slice(0, 8),
    clientSentAt: s.clientSentAt || s.createdAt,
    retracted: !!s.retracted
  }))
  // Annotate each signal with topic label so the timeline can show topic per-tap
  const { annotateSpikesWithTopics } = await import('./topicService.js')
  const spikesForAnnotation = mapped.map(s => ({ recordingOffsetMs: s.recordingOffsetMs || 0 }))
  const annotated = await annotateSpikesWithTopics({ roomId, spikes: spikesForAnnotation })
  return mapped.map((s, i) => ({
    ...s,
    topic: annotated[i]?.topic || { label: '', source: 'none' }
  }))
}

/**
 * Format milliseconds as MM:SS or HH:MM:SS for UI display.
 */
function formatMs (ms) {
  if (ms == null || isNaN(ms)) return '—'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}