import mongoose from 'mongoose'

/**
 * RecoveryPoll — one teacher-initiated "Ask Students: Did this help?"
 * round, scoped to a single ConfusionEvent.
 *
 * Each teacher click creates a NEW RecoveryPoll with a unique pollId.
 * Per-student responses are stored in `responses`, keyed by anonymous
 * HMAC hash. The latest response per student is the student's current
 * state for THIS poll; older responses are retained for history/analytics.
 *
 * Why this is a separate collection (not just in-memory):
 *  - Historical analytics: "across 3 polls, Student A flipped from
 *    still_confused → understood → still_confused"
 *  - Audit: which student responded to which poll, when
 *  - Restart safety: a backend restart mid-poll loses in-memory state;
 *    a fresh poll starts on next click (acceptable per spec)
 *
 * An "active" poll is the current pending recovery round for its event.
 * At most ONE active poll per (eventId) at any time. Older polls become
 * 'closed' (with reason: 'auto_closed', 'superseded', 'event_closed').
 */
const recoveryPollResponseSchema = new mongoose.Schema({
  studentHash: {
    type: String,
    required: true,
    match: /^[a-f0-9]{64}$/,
    index: true
  },
  answer: {
    type: String,
    enum: ['understood', 'still_confused'],
    required: true
  },
  answeredAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false })

const recoveryPollSchema = new mongoose.Schema({
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room',
    required: true,
    index: true
  },
  // Each poll belongs to exactly one ConfusionEvent. Polls are NOT
  // shared across events -- even if the topic label is the same.
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ConfusionEvent',
    required: true,
    index: true
  },
  // 1-based ordinal within the parent event. Poll #2 is the teacher's
  // second "Ask Students: Did this help?" click on the same event.
  pollNumber: {
    type: Number,
    required: true,
    min: 1
  },
  // Topic label at the moment of poll start (denormalized so historical
  // polls keep their context even if the event's topic is updated).
  topicLabel: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['active', 'closed'],
    default: 'active',
    index: true
  },
  // Why a non-active poll was closed. Set when status moves to 'closed'.
  closedReason: {
    type: String,
    enum: ['auto_closed', 'superseded', 'event_closed', 'manual'],
    default: null
  },
  startedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  closedAt: {
    type: Date,
    default: null
  },
  // Ordered log of every response received for this poll -- the historical
  // analytics trail. A student's CURRENT state is the LAST entry by
  // answeredAt for that studentHash (computed at read time).
  responses: [recoveryPollResponseSchema],
  // Cached latest-per-hash state. Kept in memory by the service for fast
  // tally; persisted snapshot for restart tolerance. NOT the source of
  // truth for analytics -- `responses[]` is.
  currentStates: [{
    studentHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    answer: { type: String, enum: ['understood', 'still_confused'], required: true },
    updatedAt: { type: Date, default: Date.now }
  }],
  // Cached counts for quick dashboard renders
  cachedUnderstood: { type: Number, default: 0, min: 0 },
  cachedStillConfused: { type: Number, default: 0, min: 0 },
  cachedResponded: { type: Number, default: 0, min: 0 }
}, {
  timestamps: true
})

// Indexes for common queries
recoveryPollSchema.index({ eventId: 1, pollNumber: -1 }) // latest poll for an event
recoveryPollSchema.index({ eventId: 1, status: 1 })     // active poll lookup
recoveryPollSchema.index({ roomId: 1, startedAt: -1 })   // room-wide history

const RecoveryPoll = mongoose.model('RecoveryPoll', recoveryPollSchema)
export default RecoveryPoll
