import mongoose from 'mongoose'
import { ConfusionEvent } from '../models/index.js'
import { resolveTopicForOffset } from './topicService.js'
import { scoreEvent } from './confusionScoring.js'

/**
 * confusionEventService -- live "what topic are students confused about RIGHT NOW?"
 *
 * One row per (roomId, topicLabel, status=active). A second student pressing
 * "I'm Lost" while the same topic is still active increments the count in
 * place; the teacher dashboard re-renders without round-tripping the API.
 *
 * Topic comparison rule (intentionally loose):
 *   - If both events have a TopicMarker, the comparison uses markerId. A new
 *     marker => new event.
 *   - If one or both are heuristic (auto/transcript), we compare labels
 *     case-insensitively after trimming whitespace. A different label => new
 *     event.
 *   - Empty topic label is treated as a bucket of its own (so we don't merge
 *     "no-topic-yet" signals across different topics).
 *
 * Why not merge across different topics?
 *   The whole point of "topic-aware confusion" is that the teacher can see
 *   "students are lost on X" cleanly. Merging an "ATP synthesis" signal into
 *   a "Calvin cycle" event would silently destroy that signal.
 */

// ─── Topic-equality helper ──────────────────────────────────────────
function isSameTopic (a, b) {
  // Both anchored to markers with the same id => same topic
  if (a.markerId && b.markerId && String(a.markerId) === String(b.markerId)) return true
  // If only one has a marker, they're different
  if (Boolean(a.markerId) !== Boolean(b.markerId)) return false
  // Neither has a marker (auto/transcript) => compare labels
  const la = (a.label || '').trim().toLowerCase()
  const lb = (b.label || '').trim().toLowerCase()
  if (!la && !lb) return false // both empty => treat as different (avoids accidental merge)
  return la === lb
}

/**
 * Find the currently active event for a room, if any. We only ever want
 * one active event per room (a new topic closes the old one).
 */
export async function getActiveForRoom (roomId) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) return null
  return ConfusionEvent.findOne({ roomId, status: 'active' })
    .sort({ startTimestamp: -1 })
    .lean()
}

/**
 * Get the most-recent event (active OR recently closed). Used by the
 * dashboard so it can keep showing the "last 5 minutes" data even
 * during the millisecond gap between close-and-reopen on topic shift.
 */
export async function getLatestForRoom (roomId) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) return null
  return ConfusionEvent.findOne({ roomId })
    .sort({ startTimestamp: -1 })
    .lean()
}

/**
 * History list for a room. Paginated by limit; newest first.
 */
export async function listForRoom ({ roomId, limit = 50 } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) return []
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  return ConfusionEvent.find({ roomId })
    .sort({ startTimestamp: -1 })
    .limit(cap)
    .lean()
}

/**
 * Close an event. Used internally when topic shifts, OR when the room ends.
 *
 * Returns the closed event (the prior active snapshot, mutated).
 */
export async function closeEvent (eventId) {
  if (!mongoose.Types.ObjectId.isValid(String(eventId))) return null
  const updated = await ConfusionEvent.findByIdAndUpdate(
    eventId,
    { $set: { status: 'closed', closedAt: new Date() } },
    { new: true }
  ).lean()
  return updated
}

/**
 * Attach a freshly-recorded doubt signal to the active event for its topic.
 *
 * If no active event exists, OR if the topic label differs from the active
 * event's label, the prior event is closed and a brand-new active event is
 * created.
 *
 * Inputs:
 *   roomId          -- ObjectId-ish
 *   signalId        -- ObjectId of the new DoubtSignal (stored in signalIds)
 *   studentHash     -- HMAC(uid, salt); used for dedup
 *   recordingOffsetMs -- teacher's clock, ms since roomStartedAt
 *   utteranceSnapshot-- latest transcript snippet at signal time
 *   topicContext    -- { label, source, markerId, startMs, endMs } from
 *                      topicService.resolveTopicForOffset. If absent, the
 *                      function will resolve it itself.
 *
 * Returns:
 *   {
 *     event:        <lean event doc>,
 *     action:       'created' | 'merged' | 'noop',   // noop = student already counted
 *     closedPrior:  <lean event doc or null>,         // only set when topic shifted
 *   }
 *
 * Why noop? An active event may already count this student (the same HMAC).
 * We don't want to refresh the timestamp and pretend a new merge happened.
 */
export async function attachSignalToEvent ({
  roomId,
  signalId,
  studentHash,
  recordingOffsetMs = null,
  utteranceSnapshot = '',
  topicContext = null
}) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return { event: null, action: 'noop', closedPrior: null }
  }
  if (!mongoose.Types.ObjectId.isValid(String(signalId))) {
    return { event: null, action: 'noop', closedPrior: null }
  }

  // Resolve topic context if not provided (caller may have already looked it up)
  let topic = topicContext
  if (!topic) {
    topic = await resolveTopicForOffset({ roomId, recordingOffsetMs: recordingOffsetMs || 0 })
  }
  let topicLabel = (topic.label || '').trim()
  let topicSubtopic = (topic.note || '').trim()
  let topicSource = topic.source || 'none'
  const topicMarkerId = topic.markerId || null

  // Last-resort fallback: if we still don't have a topic AND the student
  // typed something in the utterance, extract a topic from their words.
  // This handles the common cold-start case: student taps "I'm Lost" before
  // the teacher has produced any transcript or marker, and the only signal
  // we have is the student's own description of what they're lost on.
  const ut = (typeof utteranceSnapshot === 'string' ? utteranceSnapshot : '').trim()
  if (!topicLabel && ut.length > 0) {
    const { extractTopicProxy } = await import('./topicGenerator.js')
    const studentTopic = extractTopicProxy(ut)
    if (studentTopic) {
      topicLabel = studentTopic
      topicSource = 'student_utterance'
    }
  }

  // Final hard fallback: even if we have no utterance, NEVER create an
  // event with an empty topicLabel. Use a sensible default so the teacher
  // dashboard has SOMETHING to display.
  if (!topicLabel) {
    topicLabel = 'General confusion'
    if (topicSource === 'none') topicSource = 'fallback'
  }

  // Look up the currently active event for this room
  const active = await getActiveForRoom(roomId)

  // Same-topic merge path
  if (active && isSameTopic(
    { label: active.topicLabel, markerId: active.topicMarkerId },
    { label: topicLabel, markerId: topicMarkerId }
  )) {
    // Already counted? Return the active event without mutating.
    const alreadyCounted = Array.isArray(active.studentIds) && active.studentIds.includes(studentHash)
    if (alreadyCounted) {
      return { event: active, action: 'noop', closedPrior: null }
    }

    // Different student → merge in place
    const now = new Date()
    const updated = await ConfusionEvent.findByIdAndUpdate(
      active._id,
      {
        $push: {
          studentIds: studentHash,
          signalIds: signalId
        },
        $set: {
          confusedStudentCount: (active.confusedStudentCount || 0) + 1,
          latestTimestamp: now,
          latestTranscriptSnippet: utteranceSnapshot || active.latestTranscriptSnippet || '',
          latestRecordingOffsetMs: recordingOffsetMs ?? active.latestRecordingOffsetMs ?? null,
          topicSubtopic: topicSubtopic || active.topicSubtopic || ''
        }
      },
      { new: true }
    ).lean()
    return { event: updated, action: 'merged', closedPrior: null }
  }

  // Different topic (or no active event) → close the prior and open a fresh one
  let closedPrior = null
  if (active) {
    closedPrior = await closeEvent(active._id)
  }

  const now = new Date()
  const created = await ConfusionEvent.create({
    roomId,
    topicLabel,
    topicSubtopic,
    topicMarkerId,
    topicSource,
    startTimestamp: now,
    latestTimestamp: now,
    studentIds: [studentHash],
    signalIds: [signalId],
    confusedStudentCount: 1,
    latestTranscriptSnippet: utteranceSnapshot || '',
    startRecordingOffsetMs: recordingOffsetMs ?? null,
    latestRecordingOffsetMs: recordingOffsetMs ?? null,
    status: 'active'
  })
  return { event: created.toObject(), action: 'created', closedPrior }
}

/**
 * Format a ConfusionEvent doc for the dashboard wire (drops mongoose internals,
 * derives timestamps into UI-ready strings).
 */
export function formatForClient (event, { nowMs = Date.now() } = {}) {
  if (!event) return null
  // Weighted score (Milestone 3) -- count + duration + recency + source
  const scoring = scoreEvent({
    confusedStudentCount: event.confusedStudentCount || 0,
    startTimestamp: event.startTimestamp ? new Date(event.startTimestamp).getTime() : null,
    latestTimestamp: event.latestTimestamp ? new Date(event.latestTimestamp).getTime() : null,
    topicSource: event.topicSource || 'none',
    nowMs
  })
  return {
    id: String(event._id),
    roomId: String(event.roomId),
    topic: {
      label: event.topicLabel || '',
      subtopic: event.topicSubtopic || '',
      source: event.topicSource || 'none',
      markerId: event.topicMarkerId ? String(event.topicMarkerId) : null
    },
    confusedStudentCount: event.confusedStudentCount || 0,
    startedAt: event.startTimestamp,
    startedAtLabel: formatWallClock(event.startTimestamp),
    lastUpdateAt: event.latestTimestamp,
    lastUpdateLabel: formatWallClock(event.latestTimestamp),
    durationMs: scoring.durationMs,
    startRecordingOffsetMs: event.startRecordingOffsetMs,
    latestRecordingOffsetMs: event.latestRecordingOffsetMs,
    latestTranscriptSnippet: event.latestTranscriptSnippet || '',
    status: event.status,
    signalCount: Array.isArray(event.signalIds) ? event.signalIds.length : 0,
    // Milestone 3: weighted scoring
    score: scoring.score,
    tier: scoring.tier ? { name: scoring.tier.name, label: scoring.tier.label, emoji: scoring.tier.emoji, description: scoring.tier.description } : null,
    scoreComponents: scoring.components
  }
}

function formatWallClock (d) {
  if (!d) return ''
  try {
    const date = d instanceof Date ? d : new Date(d)
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * Close all active events for a room. Used when the room ends.
 */
export async function closeAllActiveForRoom (roomId) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) return 0
  const r = await ConfusionEvent.updateMany(
    { roomId, status: 'active' },
    { $set: { status: 'closed', closedAt: new Date() } }
  )
  return r.modifiedCount || 0
}

export default {
  attachSignalToEvent,
  getActiveForRoom,
  getLatestForRoom,
  listForRoom,
  closeEvent,
  closeAllActiveForRoom,
  formatForClient
}