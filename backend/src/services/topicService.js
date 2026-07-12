import mongoose from 'mongoose'
import { Room, TopicMarker, Transcript } from '../models/index.js'
import { extractTopicProxy } from './topicGenerator.js'

/**
 * topicService — teacher-set topic markers for "what was being taught when".
 *
 * Each marker says "from recordingOffsetMs `startMs` until `endMs`, the topic
 * was `<label>`". Doubt signals arriving in that window inherit the label,
 * so the confusion-spike dashboard shows:
 *
 *   🕐 02:34 — 8 lost
 *   📚 Glycolysis — Investment Phase
 *
 * If no marker covers a signal's time, we fall back to a "topic proxy"
 * built from the matching Transcript doc — first 4-6 significant words.
 */

const MAX_LABEL_LEN = 120
const MAX_NOTE_LEN = 240

/**
 * Add or update a topic marker. If a marker already starts at the same
 * `startMs` in this room, it's replaced (idempotent for the teacher's UX
 * of "fix the label").
 */
export async function setTopic ({ roomId, teacherId, startMs, label, note = '', endMs = null }) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return { ok: false, reason: 'invalid_room_id' }
  }
  if (!label || typeof label !== 'string' || !label.trim()) {
    return { ok: false, reason: 'label_required' }
  }
  if (typeof startMs !== 'number' || startMs < 0) {
    return { ok: false, reason: 'invalid_start_ms' }
  }
  const cleanLabel = label.trim().slice(0, MAX_LABEL_LEN)
  const cleanNote = (note || '').trim().slice(0, MAX_NOTE_LEN)
  const cleanEnd = typeof endMs === 'number' && endMs > startMs ? endMs : null

  // Verify room + teacher ownership
  const room = await Room.findById(roomId).select('_id teacher')
  if (!room) return { ok: false, reason: 'room_not_found' }
  if (String(room.teacher) !== String(teacherId)) {
    return { ok: false, reason: 'not_teacher' }
  }

  const marker = await TopicMarker.findOneAndUpdate(
    { roomId, startMs },
    {
      $set: {
        roomId,
        teacherId,
        startMs,
        endMs: cleanEnd,
        label: cleanLabel,
        note: cleanNote,
        source: 'manual',
        confirmed: true
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
  return { ok: true, marker }
}

/**
 * Remove a topic marker by id (or by startMs).
 */
export async function deleteTopic ({ roomId, teacherId, markerId, startMs }) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return { ok: false, reason: 'invalid_room_id' }
  }
  const room = await Room.findById(roomId).select('_id teacher')
  if (!room) return { ok: false, reason: 'room_not_found' }
  if (String(room.teacher) !== String(teacherId)) {
    return { ok: false, reason: 'not_teacher' }
  }
  const query = { roomId }
  if (markerId && mongoose.Types.ObjectId.isValid(String(markerId))) {
    query._id = markerId
  } else if (typeof startMs === 'number') {
    query.startMs = startMs
  } else {
    return { ok: false, reason: 'marker_id_or_start_ms_required' }
  }
  const r = await TopicMarker.deleteOne(query)
  return { ok: true, deletedCount: r.deletedCount }
}

/**
 * Get all topic markers for a room, in start-time order.
 */
export async function listTopics (roomId) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return { ok: false, reason: 'invalid_room_id' }
  }
  const markers = await TopicMarker.find({ roomId })
    .sort({ startMs: 1 })
    .lean()
  return { ok: true, topics: markers }
}

/**
 * Resolve the topic label for a given recording offset. Returns:
 *   { label: string, source: 'marker' | 'transcript' | 'none', markerId? }
 *
 * Lookup order:
 *   1. If a TopicMarker covers the offset, use its label
 *   2. Else, find the closest preceding Transcript (within ±15s) and use
 *      the first ~6 significant words as the "topic proxy"
 *   3. Else, source='none'
 */
export async function resolveTopicForOffset ({ roomId, recordingOffsetMs, roomStartedAt }) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return { label: '', source: 'none' }
  }

  // 1. Topic markers — find one where startMs <= offset < endMs (or endMs null)
  const marker = await TopicMarker.findOne({
    roomId,
    startMs: { $lte: recordingOffsetMs },
    $or: [
      { endMs: null },
      { endMs: { $gt: recordingOffsetMs } }
    ]
  }).sort({ startMs: -1 }).lean()

  if (marker) {
    return {
      label: marker.label,
      note: marker.note || '',
      source: marker.source === 'auto' ? 'auto' : 'marker',
      markerId: marker._id,
      startMs: marker.startMs,
      endMs: marker.endMs
    }
  }

  // 1b. SOFT FALLBACK: if no marker covers the offset but markers exist for
  // the room, return the most recent marker that started <= offset. This
  // handles the common case of students joining AFTER the teacher has moved
  // past a marker (offset past endMs) -- the current topic is still whatever
  // the teacher last said.
  const lastMarker = await TopicMarker.findOne({
    roomId,
    startMs: { $lte: recordingOffsetMs }
  }).sort({ startMs: -1 }).lean()

  if (lastMarker) {
    return {
      label: lastMarker.label,
      note: lastMarker.note || '',
      source: 'latest_marker',
      markerId: lastMarker._id,
      startMs: lastMarker.startMs,
      endMs: lastMarker.endMs
    }
  }

  // 2. Fallback: closest preceding Transcript within ±15s.
  // Transcripts are anchored to recordingOffsetMs = (createdAt - roomStartedAt)
  let transcripts
  if (roomStartedAt) {
    const targetTs = new Date(new Date(roomStartedAt).getTime() + recordingOffsetMs)
    const windowStart = new Date(targetTs.getTime() - 15000)
    const windowEnd = new Date(targetTs.getTime() + 5000)
    transcripts = await Transcript.find({
      roomId,
      createdAt: { $gte: windowStart, $lte: windowEnd }
    })
      .sort({ createdAt: -1 })
      .limit(1)
      .lean()
  } else {
    // No session clock — fall back to segmentIndex ordering
    transcripts = await Transcript.find({ roomId })
      .sort({ segmentIndex: 1 })
      .limit(50)
      .lean()
    // Pick the one whose segmentIndex is closest (caller can refine)
    transcripts = transcripts.length ? [transcripts[Math.floor(transcripts.length / 2)]] : []
  }

  if (transcripts.length > 0) {
    return {
      label: extractTopicProxy(transcripts[0].text),
      note: '',
      source: 'transcript',
      markerId: null
    }
  }

  // 2b. SOFT FALLBACK: if no transcript is in the ±15s window but the room
  // has transcripts, use the most recent one. Same reasoning as 1b -- the
  // teacher was talking about SOMETHING and we should attribute it to
  // SOMETHING rather than empty.
  const lastTranscript = await Transcript.findOne({ roomId })
    .sort({ segmentIndex: -1, createdAt: -1 })
    .lean()

  if (lastTranscript) {
    return {
      label: extractTopicProxy(lastTranscript.text),
      note: '',
      source: 'latest_transcript',
      markerId: null
    }
  }

  return { label: '', source: 'none' }
}

/**
 * Resolve topics for many offsets at once (one round-trip per batch via
 * the in-memory intersection of sorted markers + sorted offsets).
 */
export async function resolveTopicsForOffsets ({ roomId, offsets }) {
  if (!mongoose.Types.ObjectId.isValid(String(roomId))) {
    return new Map(offsets.map(o => [o, { label: '', source: 'none' }]))
  }
  const markers = await TopicMarker.find({ roomId }).sort({ startMs: 1 }).lean()
  // Compute the most recent preceding marker (regardless of endMs) once.
  const lastMarker = markers.length ? markers[markers.length - 1] : null
  const out = new Map()
  // For each offset, walk markers in order
  for (const offset of offsets) {
    const m = markers.find(mk => mk.startMs <= offset && (mk.endMs == null || mk.endMs > offset))
    if (m) {
      out.set(offset, { label: m.label, note: m.note || '', source: 'marker', markerId: m._id })
    } else if (lastMarker && lastMarker.startMs <= offset) {
      // Soft fallback: use the most recent preceding marker (covers past-endMs case)
      out.set(offset, { label: lastMarker.label, note: lastMarker.note || '', source: 'latest_marker', markerId: lastMarker._id })
    } else {
      out.set(offset, { label: '', source: 'none' })
    }
  }
  return out
}

/**
 * Re-export the heuristic from topicGenerator.js so existing imports
 * (`import { extractTopicProxy } from './topicService.js'`) keep working.
 * topicGenerator.js owns the implementation; topicService.js owns the
 * marker + transcript plumbing.
 */
export { extractTopicProxy }

/**
 * Augment a list of spike buckets with their topic labels. The spike service
 * can call this before returning to the teacher.
 */
export async function annotateSpikesWithTopics ({ roomId, spikes }) {
  if (!spikes?.length) return spikes
  const offsets = spikes.map(s => s.recordingOffsetMs).filter(o => o != null)
  const labels = await resolveTopicsForOffsets({ roomId, offsets })
  return spikes.map(s => {
    const found = labels.get(s.recordingOffsetMs)
    return {
      ...s,
      topic: {
        label: found?.label || '',
        source: found?.source || 'none',
        markerId: found?.markerId || null
      }
    }
  })
}

export default {
  setTopic,
  deleteTopic,
  listTopics,
  resolveTopicForOffset,
  resolveTopicsForOffsets,
  annotateSpikesWithTopics
}