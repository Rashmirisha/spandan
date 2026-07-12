// Topic marker service tests
import {
  setTopic,
  deleteTopic,
  listTopics,
  resolveTopicForOffset,
  resolveTopicsForOffsets,
  annotateSpikesWithTopics
} from '../services/topicService.js'
import { extractTopicProxy } from '../services/topicGenerator.js'
import { TopicMarker } from '../models/index.js'
import { DoubtSignal } from '../models/index.js'
import { Room } from '../models/index.js'
import { User } from '../models/index.js'
import { Transcript } from '../models/index.js'

let teacher, room
async function makeRoom () {
  const teacher = await User.create({
    email: `topic_teacher_${Date.now()}_${Math.random()}@test.local`,
    password: 'Test1234!',
    name: 'Topic Teacher',
    role: 'teacher'
  })
  const room = await Room.create({
    code: 'TPC' + Math.random().toString(36).slice(2, 6).toUpperCase(),
    name: 'Topic test room',
    teacher: teacher._id,
    isActive: true,
    roomStartedAt: new Date(Date.now() - 600000),
    doubtSalt: 'topic-salt'
  })
  return { teacher, room }
}

async function makeStudent (suffix = '') {
  return User.create({
    email: `topic_student_${Date.now()}_${Math.random()}${suffix}@test.local`,
    password: 'Test1234!',
    name: 'Topic Student',
    role: 'student'
  })
}

beforeEach(async () => {
  await TopicMarker.deleteMany({})
  await Room.deleteMany({})
  await User.deleteMany({})
  await Transcript.deleteMany({})
  ;({ teacher, room } = await makeRoom())
})

describe('setTopic', () => {
  it('creates a topic marker', async () => {
    const r = await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 30000, label: 'Intro' })
    expect(r.ok).toBe(true)
    expect(r.marker.label).toBe('Intro')
    expect(r.marker.startMs).toBe(30000)
  })

  it('replaces existing marker at same startMs', async () => {
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 30000, label: 'Old' })
    const r = await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 30000, label: 'New' })
    expect(r.ok).toBe(true)
    const all = await TopicMarker.find({ roomId: room._id }).lean()
    expect(all.length).toBe(1)
    expect(all[0].label).toBe('New')
  })

  it('rejects empty label', async () => {
    const r = await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 0, label: '  ' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('label_required')
  })

  it('rejects negative startMs', async () => {
    const r = await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: -1, label: 'bad' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('invalid_start_ms')
  })

  it('rejects non-teacher', async () => {
    const intruder = await makeStudent()
    const r = await setTopic({ roomId: room._id, teacherId: intruder._id, startMs: 0, label: 'hax' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_teacher')
  })

  it('truncates label to MAX_LABEL_LEN', async () => {
    const longLabel = 'x'.repeat(200)
    const r = await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 0, label: longLabel })
    expect(r.ok).toBe(true)
    expect(r.marker.label.length).toBe(120)
  })

  it('strips whitespace', async () => {
    const r = await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 0, label: '  Hello  ' })
    expect(r.marker.label).toBe('Hello')
  })
})

describe('deleteTopic', () => {
  it('removes a marker by id', async () => {
    const r = await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 30000, label: 'X' })
    const del = await deleteTopic({ roomId: room._id, teacherId: teacher._id, markerId: r.marker._id })
    expect(del.ok).toBe(true)
    expect(del.deletedCount).toBe(1)
  })

  it('rejects non-teacher', async () => {
    const r = await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 0, label: 'X' })
    const intruder = await makeStudent()
    const del = await deleteTopic({ roomId: room._id, teacherId: intruder._id, markerId: r.marker._id })
    expect(del.ok).toBe(false)
    expect(del.reason).toBe('not_teacher')
  })
})

describe('listTopics', () => {
  it('returns empty when no topics', async () => {
    const r = await listTopics(room._id)
    expect(r.topics).toEqual([])
  })

  it('returns topics sorted by startMs', async () => {
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 50000, label: 'B' })
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 10000, label: 'A' })
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 30000, label: 'M' })
    const r = await listTopics(room._id)
    expect(r.topics.map(t => t.label)).toEqual(['A', 'M', 'B'])
  })
})

describe('resolveTopicForOffset', () => {
  beforeEach(async () => {
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 0, endMs: 60000, label: 'Intro' })
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 60000, endMs: 120000, label: 'Phase 1' })
  })

  it('returns marker for offset within window', async () => {
    const r = await resolveTopicForOffset({ roomId: room._id, recordingOffsetMs: 30000 })
    expect(r.source).toBe('marker')
    expect(r.label).toBe('Intro')
  })

  it('returns null endMs marker as ongoing', async () => {
    // add a separate open-ended marker
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 120000, endMs: null, label: 'Phase 2' })
    const r = await resolveTopicForOffset({ roomId: room._id, recordingOffsetMs: 999000 })
    expect(r.label).toBe('Phase 2')
    expect(r.source).toBe('marker')
  })

  it('falls back to transcript when no marker covers', async () => {
    await TopicMarker.deleteMany({ roomId: room._id })
    await Transcript.create({
      roomId: room._id,
      segmentIndex: 0,
      teacherId: teacher._id,
      text: 'This is the discussion about cellular respiration and metabolic pathways.'
    })
    const r = await resolveTopicForOffset({ roomId: room._id, recordingOffsetMs: 999000, roomStartedAt: null })
    expect(r.source).toBe('transcript')
    expect(r.label.toLowerCase()).toContain('cellular')
  })

  it('falls back to latest marker when offset is past the last closed marker', async () => {
    // Delete all markers then add 2 closed ones (Phase 2 from beforeEach isn't here -- this it()
    // runs after the previous it() that may have deleted markers).
    await TopicMarker.deleteMany({ roomId: room._id })
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 0, endMs: 60000, label: 'Intro' })
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 60000, endMs: 120000, label: 'Phase 1' })
    const r = await resolveTopicForOffset({ roomId: room._id, recordingOffsetMs: 999000 })
    expect(r.source).toBe('latest_marker')
    expect(r.label).toBe('Phase 1')
  })

  it('returns latest_marker when offset is past the last closed marker (latest_marker fallback)', async () => {
    // Drop the open-ended Phase 2 marker so all markers are closed.
    await TopicMarker.deleteOne({ roomId: room._id, startMs: 120000 })
    const r = await resolveTopicForOffset({ roomId: room._id, recordingOffsetMs: 999000 })
    expect(r.source).toBe('latest_marker')
    expect(r.label).toBe('Phase 1')
  })

  it('returns latest_transcript when no marker covers and no transcript in window', async () => {
    await TopicMarker.deleteMany({ roomId: room._id })
    await Transcript.deleteMany({ roomId: room._id })
    // Create a transcript whose createdAt is FAR from roomStartedAt + offset,
    // so the ±15s window misses it. roomStartedAt is set in makeRoom() to (now - 600000).
    await Transcript.create({
      roomId: room._id,
      segmentIndex: 0,
      teacherId: teacher._id,
      text: 'This is about mitochondrial metabolism and ATP synthesis.',
      createdAt: new Date(Date.now() - 60000) // way before now
    })
    const r = await resolveTopicForOffset({
      roomId: room._id,
      recordingOffsetMs: 0,
      roomStartedAt: new Date() // offset 0 maps to "now", transcript createdAt is 60s ago
    })
    expect(r.source).toBe('latest_transcript')
    expect(r.label.toLowerCase()).toContain('mitochondrial')
  })

  it('returns none when no marker and no transcript', async () => {
    await TopicMarker.deleteMany({ roomId: room._id })
    await Transcript.deleteMany({ roomId: room._id })
    const r = await resolveTopicForOffset({ roomId: room._id, recordingOffsetMs: 999000 })
    expect(r.source).toBe('none')
    expect(r.label).toBe('')
  })
})

describe('resolveTopicsForOffsets (batch)', () => {
  beforeEach(async () => {
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 0, endMs: 60000, label: 'Intro' })
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 60000, endMs: 120000, label: 'Phase 1' })
  })

  it('resolves multiple offsets in one call', async () => {
    const r = await resolveTopicsForOffsets({ roomId: room._id, offsets: [30000, 90000, 200000] })
    expect(r.get(30000).label).toBe('Intro')
    expect(r.get(90000).label).toBe('Phase 1')
    expect(r.get(200000).source).toBe('latest_marker')
  })
})

describe('annotateSpikesWithTopics', () => {
  it('adds topic to each spike', async () => {
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 0, endMs: 60000, label: 'Intro' })
    await setTopic({ roomId: room._id, teacherId: teacher._id, startMs: 60000, endMs: 120000, label: 'Phase 1' })
    const spikes = [
      { recordingOffsetMs: 30000, count: 4 },
      { recordingOffsetMs: 90000, count: 5 },
      { recordingOffsetMs: 200000, count: 3 }
    ]
    const annotated = await annotateSpikesWithTopics({ roomId: room._id, spikes })
    expect(annotated[0].topic.label).toBe('Intro')
    expect(annotated[1].topic.label).toBe('Phase 1')
    expect(annotated[2].topic.label).toBe('Phase 1') // latest_marker fallback (offset past endMs)
  })

  it('handles empty spikes array', async () => {
    const annotated = await annotateSpikesWithTopics({ roomId: room._id, spikes: [] })
    expect(annotated).toEqual([])
  })
})

describe('extractTopicProxy (heuristic)', () => {
  it('extracts proper-noun bigram', () => {
    const label = extractTopicProxy('Today we will discuss the Krebs cycle and how it produces NADH.')
    expect(label).toBe('Krebs cycle')
  })

  it('returns empty for empty input', () => {
    expect(extractTopicProxy('')).toBe('')
    expect(extractTopicProxy(null)).toBe('')
  })

  it('handles a single capitalized phrase', () => {
    const label = extractTopicProxy('Let me explain Photosynthesis now.')
    expect(label).toContain('Photosynthesis')
  })

  it('strips stage directions before extracting', () => {
    const label = extractTopicProxy('[applause] Now Calvin cycle fixes carbon.')
    expect(label).toBe('Calvin cycle')
  })

  it('falls back to first words when nothing capitalized', () => {
    const label = extractTopicProxy('um so the investment phase uses atp to phosphorylate glucose.')
    // No capitalized noun -> fall back; might be first sentence or single-word strategy
    expect(typeof label).toBe('string')
    expect(label.length).toBeGreaterThan(0)
  })
})