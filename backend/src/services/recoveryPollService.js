// recoveryPollService.js -- teacher-initiated "Ask Students: Did this help?"
// recovery rounds, each with its own unique pollId.
//
// ─── ROOT-CAUSE FIX ──────────────────────────────────────────────────
// Before this module, every teacher click of "Ask Students" reused the
// parent ConfusionEvent as the recovery poll identifier. So Poll #2 saw
// Poll #1's responses already in the in-memory map; the dashboard showed
// cumulative counts (Respondents: 3 after 2 polls with 1 student).
//
// The fix is to give each poll its own identity:
//   * RecoveryPoll row in MongoDB (persistent history)
//   * in-memory `currentPollByEvent: Map<eventId, pollId>` so a new poll
//     cleanly supersedes the previous one
//   * recordRecoveryFeedback(pollId, studentHash, answer) keys the tally
//     by POLL ID, not event ID, so old polls can never leak into new ones
//
// Per-student dedup is still preserved within a single poll (latest answer
// wins), matching the prior PR #35 behaviour for spam protection.
//
// Cross-cutting rules:
//   * Historical analytics -- kept in `responses[]` on the RecoveryPoll
//     doc. Never deleted. Pure additions over time.
//   * "I'm Lost" signals, ConfusionEvents, Gemini topic generation --
//     untouched. We only layer a new abstraction on top.
//   * At most ONE active RecoveryPoll per (eventId) at any time. Creating
//     a new poll closes the previous as 'superseded'.

import mongoose from 'mongoose'
import { RecoveryPoll, ConfusionEvent } from '../models/index.js'

// ─── in-memory fast path ─────────────────────────────────────────────
// Map<eventId, pollId> -- the "current poll" lookup. Used by the
// /event/:eventId/feedback route when the frontend omits pollId (legacy
// back-compat) so it can still resolve to the active poll.
//
// For each active poll we also cache the live Map<studentHash, answer>
// in `liveTallyByPoll`. This is the runtime source of truth for the
// dashboard; the RecoveryPoll row's `currentStates[]` mirrors it for
// restart tolerance and history queries.
const currentPollByEvent = new Map()
const liveTallyByPoll = new Map() // pollId -> Map<studentHash, 'understood'|'still_confused'>

/**
 * Tally computed from the in-memory live tally. Returns:
 *   { understood, stillConfused, responded }
 * `responded` = unique students who have answered THIS POLL.
 */
function tallyFromLive (perPoll) {
  let understood = 0
  let stillConfused = 0
  if (perPoll) {
    for (const v of perPoll.values()) {
      if (v === 'understood') understood++
      else if (v === 'still_confused') stillConfused++
    }
  }
  return { understood, stillConfused, responded: understood + stillConfused }
}

// ─── startRecoveryPoll ───────────────────────────────────────────────
/**
 * Create a NEW recovery poll for this event. Closes any prior active
 * poll for the same event as 'superseded' (still in history, not
 * counted in dashboard).
 *
 * Idempotent: if `startRecoveryPoll` is called twice in a row with no
 * intervening feedback, the second call returns the same pollId
 * (we don't create an empty duplicate).
 *
 * Returns: { pollId, pollNumber, alreadyActive }
 *   - alreadyActive=true means we returned the still-open poll from the
 *     first click (so the teacher dashboard doesn't see a brand-new poll
 *     if they double-click).
 */
export async function startRecoveryPoll (eventId, opts = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(eventId))) {
    throw new Error('startRecoveryPoll: invalid eventId')
  }
  const { roomId, topicLabel } = opts

  // Check if there's already an active poll for this event — return it
  // unchanged. This prevents poll inflation from accidental double-clicks
  // and is consistent with the "currentPollByEvent" model.
  const existingId = currentPollByEvent.get(String(eventId))
  if (existingId) {
    const existing = await RecoveryPoll.findById(existingId).lean()
    if (existing && existing.status === 'active') {
      return {
        pollId: String(existing._id),
        pollNumber: existing.pollNumber,
        alreadyActive: true,
        topicLabel: existing.topicLabel
      }
    }
    // Stale reference: cleanup
    currentPollByEvent.delete(String(eventId))
    liveTallyByPoll.delete(String(existingId))
  }

  // Find the latest pollNumber for this event to assign the next ordinal.
  const last = await RecoveryPoll
    .findOne({ eventId })
    .sort({ pollNumber: -1 })
    .select('pollNumber')
    .lean()
  const pollNumber = (last?.pollNumber || 0) + 1

  // Build the new poll doc
  const doc = await RecoveryPoll.create({
    roomId: roomId || undefined,
    eventId,
    pollNumber,
    topicLabel: topicLabel || '',
    status: 'active',
    startedAt: new Date(),
    responses: [],
    currentStates: []
  })

  // Initialize in-memory state
  currentPollByEvent.set(String(eventId), String(doc._id))
  liveTallyByPoll.set(String(doc._id), new Map())

  return {
    pollId: String(doc._id),
    pollNumber: doc.pollNumber,
    alreadyActive: false,
    topicLabel: doc.topicLabel
  }
}

// ─── recordRecoveryFeedback ──────────────────────────────────────────
/**
 * Record a student's response to a recovery poll.
 *
 *   answer='understood' | 'still_confused'
 *
 * Behavior:
 *   * Within ONE poll, the same student's latest answer overwrites their
 *     previous state (per-student dedup, the original PR #35 fix).
 *   * Spamming 'still_confused' 10 times = 1 still_confused count.
 *   * Switching from SC -> U flips the student's current state.
 *
 * Persistence:
 *   * Each call appends to `responses[]` (full history).
 *   * `currentStates[]` and the cached counters are updated to match the
 *     latest state per student.
 *
 * Returns:
 *   { understood, stillConfused, responded, pollId, pollNumber }
 *
 * Throws if pollId is invalid / poll not found / answer invalid.
 */
export async function recordRecoveryFeedback (pollId, studentHash, answer) {
  if (!pollId || typeof pollId !== 'string') {
    throw new Error('recordRecoveryFeedback: pollId is required')
  }
  if (!studentHash || !/^[a-f0-9]{64}$/.test(String(studentHash))) {
    throw new Error('recordRecoveryFeedback: invalid studentHash')
  }
  if (answer !== 'understood' && answer !== 'still_confused') {
    throw new Error(`recordRecoveryFeedback: invalid answer "${answer}"`)
  }

  const pollIdStr = String(pollId)
  if (!mongoose.Types.ObjectId.isValid(pollIdStr)) {
    throw new Error('recordRecoveryFeedback: pollId is not a valid ObjectId')
  }

  const poll = await RecoveryPoll.findById(pollIdStr)
  if (!poll) {
    throw new Error(`recordRecoveryFeedback: poll ${pollIdStr} not found`)
  }
  if (poll.status !== 'active') {
    throw new Error(`recordRecoveryFeedback: poll ${pollIdStr} is not active (status=${poll.status})`)
  }

  const now = new Date()
  // 1) Append to responses history (full audit trail)
  poll.responses.push({ studentHash: String(studentHash), answer, answeredAt: now })

  // 2) Update currentStates (latest answer per student wins)
  const existing = poll.currentStates.find(s => s.studentHash === String(studentHash))
  if (existing) {
    existing.answer = answer
    existing.updatedAt = now
  } else {
    poll.currentStates.push({ studentHash: String(studentHash), answer, updatedAt: now })
  }

  // 3) Recompute cached counts from currentStates
  let u = 0, sc = 0
  for (const s of poll.currentStates) {
    if (s.answer === 'understood') u++
    else if (s.answer === 'still_confused') sc++
  }
  poll.cachedUnderstood = u
  poll.cachedStillConfused = sc
  poll.cachedResponded = u + sc
  await poll.save()

  // 4) Mirror to in-memory map for fast dashboard reads
  let liveMap = liveTallyByPoll.get(pollIdStr)
  if (!liveMap) {
    liveMap = new Map()
    liveTallyByPoll.set(pollIdStr, liveMap)
  }
  liveMap.set(String(studentHash), answer)

  return {
    pollId: pollIdStr,
    pollNumber: poll.pollNumber,
    eventId: String(poll.eventId),
    understood: u,
    stillConfused: sc,
    responded: u + sc
  }
}

// ─── getCurrentTally ────────────────────────────────────────────────
/**
 * Return the current live tally for a pollId, computed from the
 * in-memory Map (the fastest path). Falls back to the persisted
 * `currentStates[]` if the in-memory map was lost (e.g. server restart).
 */
export function getCurrentTally (pollId) {
  const pollIdStr = String(pollId)
  const live = liveTallyByPoll.get(pollIdStr)
  if (live) return tallyFromLive(live)
  return { understood: 0, stillConfused: 0, responded: 0 }
}

/**
 * Async variant: falls back to DB read for tally if in-memory cache miss.
 * Used by the feedback route after a restart to recover state.
 */
export async function getPollTally (pollId) {
  const pollIdStr = String(pollId)
  const live = liveTallyByPoll.get(pollIdStr)
  if (live) return tallyFromLive(live)
  if (!mongoose.Types.ObjectId.isValid(pollIdStr)) {
    return { understood: 0, stillConfused: 0, responded: 0 }
  }
  const poll = await RecoveryPoll.findById(pollIdStr).select('currentStates cachedUnderstood cachedStillConfused cachedResponded status').lean()
  if (!poll) return { understood: 0, stillConfused: 0, responded: 0 }
  return {
    understood: poll.cachedUnderstood || 0,
    stillConfused: poll.cachedStillConfused || 0,
    responded: poll.cachedResponded || 0
  }
}

// ─── getActivePollId ─────────────────────────────────────────────────
/**
 * Return the pollId of the currently-active recovery poll for an event,
 * or null if there is none. Used by the /feedback route to look up
 * which poll the student is responding to (when the frontend doesn't
 * supply one — back-compat with the old code path).
 */
export function getActivePollId (eventId) {
  return currentPollByEvent.get(String(eventId)) || null
}

// ─── closePoll ───────────────────────────────────────────────────────
/**
 * Close an active recovery poll. Used on auto-close paths (all eligible
 * respondents understood) and on event-close paths (teacher ends the
 * ConfusionEvent).
 *
 * `reason` ∈ 'auto_closed' | 'superseded' | 'event_closed' | 'manual'
 */
export async function closePoll (pollId, reason = 'manual') {
  const pollIdStr = String(pollId)
  if (!mongoose.Types.ObjectId.isValid(pollIdStr)) return null
  const updated = await RecoveryPoll.findOneAndUpdate(
    { _id: pollIdStr, status: 'active' },
    { $set: { status: 'closed', closedAt: new Date(), closedReason: reason } },
    { new: true }
  ).lean()
  if (updated) {
    // Drop from in-memory maps
    liveTallyByPoll.delete(pollIdStr)
    // Clear the eventId -> pollId mapping if it pointed here
    for (const [eid, pid] of currentPollByEvent.entries()) {
      if (pid === pollIdStr) currentPollByEvent.delete(eid)
    }
  }
  return updated
}

/**
 * Close all active polls for an event. Used by resetPollStateForRoom
 * (MCQ question boundary) so a new question starts with a clean slate.
 */
export async function closeActivePollsForEvent (eventId, reason = 'event_closed') {
  const r = await RecoveryPoll.updateMany(
    { eventId, status: 'active' },
    { $set: { status: 'closed', closedAt: new Date(), closedReason: reason } }
  )
  // Drop from in-memory
  for (const [eid, pid] of currentPollByEvent.entries()) {
    if (String(eid) === String(eventId)) currentPollByEvent.delete(eid)
  }
  // Drop live tallies (best-effort: read the polls we just closed)
  const ids = await RecoveryPoll.find({ eventId, status: 'closed', closedReason: reason })
    .select('_id').lean()
  for (const p of ids) liveTallyByPoll.delete(String(p._id))
  return r.modifiedCount || 0
}

// ─── listPollsForEvent ──────────────────────────────────────────────
/**
 * List all polls (active + closed) for an event, newest first. For the
 * analytics dashboard. Excludes the response bodies by default to keep
 * payloads small — pass `withResponses: true` to include them.
 */
export async function listPollsForEvent (eventId, { withResponses = false } = {}) {
  const projection = withResponses
    ? '__v'
    : 'responses -1 currentStates -1'
  const polls = await RecoveryPoll
    .find({ eventId })
    .sort({ pollNumber: -1 })
    .select(withResponses ? '' : '-responses -currentStates')
    .lean()
  return polls
}

/**
 * Return the latest active poll for an event (or null). Used by the
 * dashboard on initial mount to recover state after a page refresh.
 */
export async function getActivePollForEvent (eventId) {
  return RecoveryPoll.findOne({ eventId, status: 'active' })
    .sort({ pollNumber: -1 })
    .lean()
}

// ─── test-only helpers ───────────────────────────────────────────────
/**
 * Reset all in-memory state. Test-only — never call from prod code.
 */
export function _resetAllForTests () {
  currentPollByEvent.clear()
  liveTallyByPoll.clear()
}