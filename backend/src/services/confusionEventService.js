import mongoose from 'mongoose'
import { ConfusionEvent, Room } from '../models/index.js'
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
    // ALWAYS pass roomStartedAt so topic resolution is session-scoped.
    // Without it, the fallback path can pull transcripts/markers from a
    // previous lecture session in the same room (e.g. "Hello hello",
    // "Photosynthesis which Photosynthesis", "Whether climate").
    // If the room hasn't been started yet, we use null and the resolver
    // returns 'General Confusion' (no cross-session leak possible).
    let roomStartedAt = null
    try {
      const room = await Room.findById(roomId).select('roomStartedAt').lean()
      roomStartedAt = room?.roomStartedAt || null
    } catch (e) {
      // If we can't load the room, fall through with null (resolver
      // will give 'General Confusion' rather than leak from another session)
    }
    topic = await resolveTopicForOffset({
      roomId,
      recordingOffsetMs: recordingOffsetMs || 0,
      roomStartedAt
    })
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
  //
  // We also allow the utterance to override the resolver's defensive
  // 'General Confusion' placeholder (set when roomStartedAt is null),
  // because the student's own words are a strictly more specific signal.
  const ut = (typeof utteranceSnapshot === 'string' ? utteranceSnapshot : '').trim()
  const placeholderLabel = !topicLabel || topicLabel.toLowerCase() === 'general confusion'
  if (placeholderLabel && ut.length > 0) {
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

  // DEMO FALLBACK (2026-07-18): when no marker / transcript / student
  // utterance produced a topic, AND a fresh room was just started (room
  // title sits in `Room.name`), use the room title as the topic label.
  // This prevents the teacher dashboard from showing 'General Confusion'
  // during the demo before any transcript has been captured. Skips when
  // the room name itself looks like placeholder text ('New Room',
  // 'Untitled', generic templates), in which case we stay on the default.
  if (
    (topicLabel === 'General confusion' || topicLabel === 'General Confusion' || topicSource === 'fallback' || topicSource === 'none' || topicSource === 'no_session') &&
    !(placeholderLabel && ut.length > 0)
  ) {
    try {
      const room = await Room.findById(roomId).select('name').lean()
      const rn = (room?.name || '').trim()
      const lower = rn.toLowerCase()
      const looksLikePlaceholder =
        !rn ||
        lower === 'new room' ||
        lower === 'untitled' ||
        lower === 'untitled room' ||
        /^room\s*\d*$/i.test(rn) ||
        lower.length < 3
      if (!looksLikePlaceholder) {
        topicLabel = rn.slice(0, 80)
        topicSource = 'room_title'
      }
    } catch (e) {
      // If room lookup fails, keep the previous fallback -- this branch is
      // best-effort, never crash the doubt-signal path.
    }
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
    scoreComponents: scoring.components,
    // RECOVERY FLOW: persistent feedback stats. Surface on the wire so
    // Recent Confusion Events can render past tallies, and so the
    // AnalyticsPage FeedbackCollector can hydrate from a re-mount.
    feedbackStats: formatFeedbackStatsForClient(event.feedbackStats)
  }
}

/**
 * Wire-format the persistent feedback stats. Drops the raw `responses`
 * array (too noisy); the tallies + status are enough for the dashboard.
 */
function formatFeedbackStatsForClient (fs) {
  if (!fs || typeof fs !== 'object') {
    return {
      status: 'none',
      expectedRespondents: 0,
      understoodCount: 0,
      stillConfusedCount: 0,
      requestedAt: null,
      completedAt: null,
      responseCount: 0
    }
  }
  return {
    status: fs.status || 'none',
    expectedRespondents: fs.expectedRespondents || 0,
    understoodCount: fs.understoodCount || 0,
    stillConfusedCount: fs.stillConfusedCount || 0,
    requestedAt: fs.requestedAt || null,
    completedAt: fs.completedAt || null,
    responseCount: Array.isArray(fs.responses) ? fs.responses.length : 0
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

/**
 * Poll lifecycle reset — called when a new poll starts.
 *
 * Closes any active ConfusionEvents for this room (so the next student
 * press starts a fresh event) and clears their feedbackTallies so the
 * teacher dashboard's recovery counters start from zero on the new poll.
 *
 * Returns the IDs of the events that were closed (for telemetry).
 *
 * This is the keystone fix that decouples poll lifecycle from confusion-
 * event lifecycle: without it, Poll #2 would reuse Poll #1's ConfusionEvent
 * and the recovery tally would persist into Poll #2's dashboard.
 */
export async function resetPollStateForRoom (roomId) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) return []
  const active = await ConfusionEvent.find({ roomId, status: 'active' })
    .select('_id')
    .lean()
  if (active.length === 0) return []
  const ids = active.map(e => String(e._id))
  await ConfusionEvent.updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'closed', closedAt: new Date(), pollResetAt: new Date() } }
  )
  // Drop any in-memory feedback tallies for these events so the next poll
  // starts with a fresh { understood: 0, stillConfused: 0 } reading.
  for (const id of ids) {
    feedbackTallies.delete(id)
  }
  return ids
}

/**
 * RESOLVED PROMPT: teacher-initiated resolve of a specific confusion event.
 * Sets status='closed' if currently 'active'. Idempotent.
 *
 * Returns the updated event doc (lean) or null if not found / invalid id.
 */
export async function resolveEventByTeacher (eventId) {
  if (!mongoose.Types.ObjectId.isValid(String(eventId))) return null
  const updated = await ConfusionEvent.findOneAndUpdate(
    { _id: eventId, status: 'active' },
    { $set: { status: 'closed', closedAt: new Date() } },
    { new: true }
  ).lean()
  return updated
}

/**
 * RESOLVED PROMPT: student feedback on a (presumably teacher-resolved) event.
 *
 *   answer='understood'    -> increment understoodCount (in-memory tally)
 *   answer='still_confused' -> reopen the event (status='active'),
 *                              increment reopenedCount
 *
 * The in-memory understoodCount is keyed by eventId and survives within the
 * process lifetime. (Restart loss is acceptable for the demo -- the teacher
 * dashboard re-fetches event.reopenedCount from Mongo on reconnect.)
 */
const feedbackTallies = new Map() // eventId -> { understood: n, stillConfused: n }

export function recordFeedback (eventId, answer) {
  const tally = feedbackTallies.get(String(eventId)) || { understood: 0, stillConfused: 0 }
  if (answer === 'understood') tally.understood += 1
  else if (answer === 'still_confused') tally.stillConfused += 1
  feedbackTallies.set(String(eventId), tally)
  return { ...tally }
}

export function getFeedbackTally (eventId) {
  return feedbackTallies.get(String(eventId)) || { understood: 0, stillConfused: 0 }
}

/**
 * RECOVERY FLOW: open a feedback round on an event.
 *   - Marks event.feedbackStats.status = 'pending'
 *   - Sets expectedRespondents = current confusedStudentCount
 *   - Resets the live counters + responses array
 *   - Returns the lean event doc with the updated stats.
 *
 * Called by /request-feedback. The expectation is that the
 * `confusion:resolved` socket emit follows so both students (popup)
 * and the teacher dashboard (FeedbackCollector card) get the cue.
 */
export async function openFeedbackRound (eventId) {
  if (!mongoose.Types.ObjectId.isValid(String(eventId))) return null
  const evt = await ConfusionEvent.findById(eventId)
  if (!evt) return null
  const expected = Math.max(
    1,
    evt.confusedStudentCount || (Array.isArray(evt.studentIds) ? evt.studentIds.length : 1)
  )
  evt.feedbackStats = evt.feedbackStats || {}
  evt.feedbackStats.status = 'pending'
  evt.feedbackStats.expectedRespondents = expected
  evt.feedbackStats.understoodCount = 0
  evt.feedbackStats.stillConfusedCount = 0
  evt.feedbackStats.requestedAt = new Date()
  evt.feedbackStats.completedAt = null
  evt.feedbackStats.responses = []
  await evt.save()
  // Also clear the in-memory tally so per-restart drift doesn't leak
  feedbackTallies.set(String(eventId), { understood: 0, stillConfused: 0 })
  return evt.toObject()
}

/**
 * RECOVERY FLOW: record a single student response against the persistent
 * event.feedbackStats structure. Idempotent by studentHash — a student
 * can answer only once per round.
 *
 * Returns { isNew, tally, total, completed } where:
 *   isNew      = true if this was a new response (false if the student
 *                had already answered — we don't double-count)
 *   tally      = { understood, stillConfused }
 *   total      = tally.understood + tally.stillConfused
 *   completed  = true when total >= expectedRespondents OR all-understood
 */
export async function recordFeedbackPersistent (eventId, { studentId, studentHash, answer }) {
  if (!mongoose.Types.ObjectId.isValid(String(eventId))) {
    return { isNew: false, tally: { understood: 0, stillConfused: 0 }, total: 0, completed: false }
  }
  const evt = await ConfusionEvent.findById(eventId)
  if (!evt) {
    return { isNew: false, tally: { understood: 0, stillConfused: 0 }, total: 0, completed: false }
  }
  // Ensure subdoc exists
  evt.feedbackStats = evt.feedbackStats || {}
  const fs = evt.feedbackStats
  if (!Array.isArray(fs.responses)) fs.responses = []
  if (!fs.status) fs.status = 'none'
  if (typeof fs.understoodCount !== 'number') fs.understoodCount = 0
  if (typeof fs.stillConfusedCount !== 'number') fs.stillConfusedCount = 0
  if (typeof fs.expectedRespondents !== 'number') fs.expectedRespondents = 0

  // Idempotency: same studentHash already responded in this round?
  const already = studentHash
    ? fs.responses.find(r => r.studentHash === studentHash)
    : fs.responses.find(r => studentId && r.studentId && String(r.studentId) === String(studentId))
  if (already) {
    return {
      isNew: false,
      tally: { understood: fs.understoodCount, stillConfused: fs.stillConfusedCount },
      total: fs.understoodCount + fs.stillConfusedCount,
      completed: fs.status === 'completed' || fs.status === 'timed_out'
    }
  }

  // Accept the response
  fs.responses.push({
    studentId: studentId || undefined,
    studentHash: studentHash || '',
    answer,
    respondedAt: new Date()
  })
  if (answer === 'understood') fs.understoodCount += 1
  else fs.stillConfusedCount += 1

  // Mark the round complete when:
  //   - everyone has responded (total >= expected), OR
  //   - all-understood (no more students need to respond)
  const total = fs.understoodCount + fs.stillConfusedCount
  const completed =
    (fs.expectedRespondents > 0 && total >= fs.expectedRespondents) ||
    (fs.understoodCount === fs.expectedRespondents && fs.stillConfusedCount === 0)
  if (completed) {
    fs.status = 'completed'
    fs.completedAt = new Date()
  } else {
    fs.status = 'pending'
  }

  await evt.save()
  return {
    isNew: true,
    tally: { understood: fs.understoodCount, stillConfused: fs.stillConfusedCount },
    total,
    completed
  }
}

/**
 * RECOVERY FLOW: mark an in-flight round as timed-out. Called by the
 * feedback route if we want to surface a timeout-driven summary instead
 * of waiting for all students. For now this is a no-op when called with
 * status already terminal.
 */
export async function completeFeedbackRound (eventId, { status = 'completed' } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(eventId))) return null
  const evt = await ConfusionEvent.findById(eventId)
  if (!evt) return null
  evt.feedbackStats = evt.feedbackStats || {}
  if (['completed', 'timed_out'].includes(evt.feedbackStats.status)) {
    return evt.toObject()
  }
  evt.feedbackStats.status = status
  evt.feedbackStats.completedAt = new Date()
  await evt.save()
  return evt.toObject()
}

/**
 * RESOLVED PROMPT: reopen a previously closed event (student said
 * 'still_confused'). Increments event.reopenedCount atomically.
 *
 * Also accepts already-active events: in practice a student can click
 * 'still_confused' before the event has been auto-closed (only some
 * students responded understood). We must increment reopenedCount
 * without requiring the event to first be closed.
 */
export async function reopenEvent (eventId) {
  if (!mongoose.Types.ObjectId.isValid(String(eventId))) return null
  const updated = await ConfusionEvent.findOneAndUpdate(
    { _id: eventId },
    [
      {
        $set: {
          status: 'active',
          closedAt: null,
          reopenedCount: {
            $add: [
              { $ifNull: ['$reopenedCount', 0] },
              { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] }
            ]
          }
        }
      }
    ],
    { new: true }
  ).lean()
  return updated
}

export default {
  attachSignalToEvent,
  getActiveForRoom,
  getLatestForRoom,
  listForRoom,
  closeEvent,
  closeAllActiveForRoom,
  resetPollStateForRoom,
  resolveEventByTeacher,
  reopenEvent,
  recordFeedback,
  getFeedbackTally,
  openFeedbackRound,
  recordFeedbackPersistent,
  completeFeedbackRound,
  formatForClient
}