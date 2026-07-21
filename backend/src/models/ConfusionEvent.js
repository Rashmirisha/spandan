import mongoose from 'mongoose'

/**
 * ConfusionEvent — live confusion aggregation per (room, topic).
 *
 * Design:
 *   When the first student presses "I'm Lost" within a topic window, an
 *   active event is created. Subsequent presses for the same room +
 *   topic label merge into the active event instead of spawning new rows.
 *   When the topic changes (label differs, or marker points elsewhere),
 *   the previous event is closed and a fresh one is opened.
 *
 * This keeps the teacher dashboard focused on "what's happening right
 * now" without flooding it with one row per tap, while still keeping
 * every individual DoubtSignal in the collection for analytics.
 *
 * Student identity is stored as a Set of HMAC hashes for de-duplication —
 * a student is counted at most once per active event.
 */
const confusionEventSchema = new mongoose.Schema({
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room',
    required: true,
    index: true
  },
  topicLabel: {
    type: String,
    default: '',
    index: true
  },
  topicSubtopic: {
    type: String,
    default: ''
  },
  topicMarkerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TopicMarker',
    default: null
  },
  topicSource: {
    type: String,
    enum: ['marker', 'auto', 'transcript', 'latest_marker', 'latest_transcript', 'student_utterance', 'fallback', 'no_session', 'room_title', 'none'],
    default: 'none'
  },
  // Anchor wall-clock ms when the first signal arrived
  startTimestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  // Last update ms — used to render "Last update: 12:35 PM" in the dashboard
  latestTimestamp: {
    type: Date,
    default: Date.now
  },
  // Distinct students (by HMAC hash) within this event — for dedup counts
  studentIds: [{
    type: String,
    match: /^[a-f0-9]{64}$/
  }],
  // Cached count (mirrors studentIds.length for query speed)
  confusedStudentCount: {
    type: Number,
    default: 0,
    min: 0
  },
  // Most-recent transcript snippet at signal-time (so the dashboard can
  // render "they were hearing X" even if new transcripts are flowing in)
  latestTranscriptSnippet: {
    type: String,
    default: ''
  },
  // Recording offsets for chart/heatmap anchoring (start to latest)
  startRecordingOffsetMs: {
    type: Number,
    default: null
  },
  latestRecordingOffsetMs: {
    type: Number,
    default: null
  },
  // IDs of signals that contributed to this event (for "show me the
  // individual taps" drill-down)
  signalIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DoubtSignal'
  }],
  // Active = still accepting merges; closed = superseded by topic change
  // OR manually closed by teacher. Closed events are historical only.
  status: {
    type: String,
    enum: ['active', 'closed'],
    default: 'active',
    index: true
  },
  closedAt: {
    type: Date,
    default: null
  },
  // Count of student "still confused" responses after a teacher resolve
  reopenedCount: {
    type: Number,
    default: 0,
    min: 0
  },
  // RECOVERY FLOW PERSISTENT STATS (2026-07-21):
  //   When the teacher clicks "Request Feedback", we record what was asked
  //   and accumulate the per-student responses. This survives backend
  //   restarts so the Recent Confusion Events list can show past tallies.
  feedbackStats: {
    // Whether a feedback round is currently in flight
    status: {
      type: String,
      enum: ['none', 'pending', 'completed', 'timed_out'],
      default: 'none'
    },
    // How many students we expected to respond (= confusedStudentCount at request time)
    expectedRespondents: { type: Number, default: 0, min: 0 },
    // Live running counts
    understoodCount: { type: Number, default: 0, min: 0 },
    stillConfusedCount: { type: Number, default: 0, min: 0 },
    // Wall-clock of the request + completion / timeout
    requestedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Per-respondent log (for forensics, capped at 500 entries)
    responses: [{
      studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      // Anonymous identifier (HMAC hash) so we can dedup re-submits even
      // when we don't have a stable ObjectId for the student in the room.
      studentHash: { type: String, default: '' },
      answer: { type: String, enum: ['understood', 'still_confused'] },
      respondedAt: { type: Date, default: Date.now }
    }]
  }
}, {
  timestamps: true
})

// Fast lookup: "active event for room, ordered by recency"
confusionEventSchema.index({ roomId: 1, status: 1, startTimestamp: -1 })
// History view: all events for a room, newest first
confusionEventSchema.index({ roomId: 1, startTimestamp: -1 })

const ConfusionEvent = mongoose.model('ConfusionEvent', confusionEventSchema)
export default ConfusionEvent