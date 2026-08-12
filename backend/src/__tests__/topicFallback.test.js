// topicFallback.test.js -- regression tests for A + C fallback paths.
//
// Covers:
//   A (multi-chunk context)        -- fragmented transcripts yield meaningful topics
//   C (last confirmed fallback)    -- empty heuristic + confirmed marker = reuse label
//   no-AI independence             -- all paths work with no MINIMAX key
//   AI 401/timeout/bad-JSON fallback -- always falls through to heuristic or C
//   "General Confusion" only when no other signal exists
//
// MongoDB connection is provided by the global jest preset
// (jest-mongodb in jest-mongodb.config.js) so we don't manage it here.

import {
  extractTopicProxy,
  maybeGenerateAutoTopic
} from '../services/topicGenerator.js'
import { getLastConfirmedTopic } from '../services/topicService.js'
import mongoose from 'mongoose'
import TopicMarker from '../models/TopicMarker.js'
import Room from '../models/Room.js'

afterEach(async () => {
  await TopicMarker.deleteMany({})
  await Room.deleteMany({})
})

// ── A: extractTopicProxy accepts array ────────────────────────────────
describe('A: extractTopicProxy multi-chunk aggregation', () => {
  it('returns "" for empty array', () => {
    expect(extractTopicProxy([])).toBe('')
  })

  it('returns "" when all chunks are empty strings', () => {
    expect(extractTopicProxy(['', '   ', null, undefined, '\n'])).toBe('')
  })

  it('falls back to single-chunk extraction when array has one item', () => {
    expect(extractTopicProxy(['Photosynthesis converts light energy']))
      .toBe('Photosynthesis')
  })

  it('extracts Photosynthesis from greeting-filler + lecture-content chunks', () => {
    const chunks = [
      'Hi everyone, today we are going to study something interesting',
      "Let's begin with the chapter on plant biology",
      'Photosynthesis is the process by which green plants convert light energy into chemical energy'
    ]
    const label = extractTopicProxy(chunks)
    expect(label).toBe('Photosynthesis')
  })

  it('extracts Photosynthesis from fragmented short segments', () => {
    const chunks = [
      'Photosynthesis',
      'is the process',
      'by which green plants',
      'convert light energy',
      'into chemical energy'
    ]
    const label = extractTopicProxy(chunks)
    expect(label).toBe('Photosynthesis')
  })

  it('extracts Krebs from fragmented Krebs cycle transcript', () => {
    const chunks = [
      'Today we discuss',
      'the Krebs cycle',
      'and how it produces NADH',
      'in the mitochondrial matrix'
    ]
    const label = extractTopicProxy(chunks)
    expect(label.toLowerCase()).toMatch(/krebs/)
  })

  it('skips empty strings between real chunks', () => {
    expect(extractTopicProxy(['', '  ', 'Mitosis is cell division', ''])).toBe('Mitosis')
  })

  it('still returns "" for greeting-only chunks', () => {
    expect(extractTopicProxy(['Hello everyone', 'Hi guys today'])).toBe('')
  })

  it('still returns "" for the original "Hello hello hello" pattern (no chunks)', () => {
    expect(extractTopicProxy('Hello hello hello.')).toBe('')
  })

  it('handles a single realistic photosynthesis transcript chunk', () => {
    // From Rashmi's demo: this exact transcript must yield "Photosynthesis"
    const text = 'Today we are going to understand photosynthesis. Photosynthesis is the process by which green plants convert light energy into chemical energy. This process mainly occurs in chloroplasts.'
    expect(extractTopicProxy(text)).toBe('Photosynthesis')
  })
})

// ── maybeGenerateAutoTopic: AI paths always fall back ──────────────────
describe('maybeGenerateAutoTopic fallback paths (no AI)', () => {
  beforeEach(() => {
    delete process.env.MINIMAX_API_KEY
    delete process.env.MINIMAX_KEY
  })

  it('returns null (createNew:false) when no chunks given', async () => {
    const r = await maybeGenerateAutoTopic({
      roomId: 'r1', nowMs: 100000,
      chunks: [], recentTranscripts: []
    })
    expect(r.createNew).toBe(false)
  })

  it('extracts Photosynthesis from a single chunk (no API key)', async () => {
    const r = await maybeGenerateAutoTopic({
      roomId: 'r2', nowMs: 100000,
      chunks: ['Today we are going to understand photosynthesis. Photosynthesis is the process by which green plants convert light energy into chemical energy.']
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Photosynthesis')
    expect(r.source).toBe('auto')
  })

  it('extracts Photosynthesis from fragmented chunks (the A-fix)', async () => {
    const r = await maybeGenerateAutoTopic({
      roomId: 'r3', nowMs: 100000,
      chunks: [
        'Hi everyone today we are going to study something interesting',
        'Photosynthesis is the process by which green plants convert light energy into chemical energy',
        'It mainly occurs in the chloroplasts'
      ]
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Photosynthesis')
    expect(r.source).toBe('auto')
  })

  it('falls back to heuristic when AI fetch returns 401', async () => {
    const oldFetch = global.fetch
    global.fetch = async () => ({ ok: false, status: 401 })
    process.env.MINIMAX_API_KEY = 'expired-key'
    try {
      const r = await maybeGenerateAutoTopic({
        roomId: 'r4', nowMs: 100000,
        chunks: ['Mitochondria are the powerhouse of the cell and produce ATP through respiration']
      })
      expect(r.createNew).toBe(true)
      expect(r.label).toBe('Mitochondria')
    } finally {
      global.fetch = oldFetch
      delete process.env.MINIMAX_API_KEY
    }
  })

  it('falls back to heuristic when AI fetch throws (timeout / network)', async () => {
    const oldFetch = global.fetch
    global.fetch = async () => { throw new Error('ECONNRESET') }
    process.env.MINIMAX_API_KEY = 'some-key'
    try {
      const r = await maybeGenerateAutoTopic({
        roomId: 'r5', nowMs: 100000,
        chunks: ['Krebs cycle is part of cellular respiration and produces NADH and FADH2']
      })
      expect(r.createNew).toBe(true)
      expect(r.label.toLowerCase()).toMatch(/krebs/)
    } finally {
      global.fetch = oldFetch
      delete process.env.MINIMAX_API_KEY
    }
  })

  it('falls back to heuristic when AI returns bad JSON', async () => {
    const oldFetch = global.fetch
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ nope: 'wrong shape' })
    })
    process.env.MINIMAX_API_KEY = 'some-key'
    try {
      const r = await maybeGenerateAutoTopic({
        roomId: 'r6', nowMs: 100000,
        chunks: ['Chlorophyll absorbs red and blue light during photosynthesis']
      })
      expect(r.createNew).toBe(true)
      expect(r.label.toLowerCase()).toMatch(/chlorophyll|photosynthesis/)
    } finally {
      global.fetch = oldFetch
      delete process.env.MINIMAX_API_KEY
    }
  })

  it('skips when chunks produce greeting-only / empty result (no confirmed fallback)', async () => {
    const r = await maybeGenerateAutoTopic({
      roomId: 'r7', nowMs: 100000,
      chunks: ['Hello hello hello', 'Hi everyone welcome']
    })
    expect(r.createNew).toBe(false)
    expect(r.reused).toBeFalsy()
  })
})

// ── C: last confirmed topic fallback ───────────────────────────────────
describe('C: last confirmed topic fallback', () => {
  beforeEach(() => {
    delete process.env.MINIMAX_API_KEY
    delete process.env.MINIMAX_KEY
  })

  it('getLastConfirmedTopic returns null when no confirmed marker exists', async () => {
    const room = await Room.create({
      code: 'ROOM-A1', name: 'Room A', teacher: new mongoose.Types.ObjectId()
    })
    const label = await getLastConfirmedTopic({ roomId: room._id.toString() })
    expect(label).toBeNull()
  })

  it('getLastConfirmedTopic returns the most recent confirmed label', async () => {
    const room = await Room.create({
      code: 'ROOM-A2', name: 'Room A2', teacher: new mongoose.Types.ObjectId()
    })
    const teacherId = room.teacher
    await TopicMarker.create({
      roomId: room._id, teacherId, startMs: 0, endMs: 60000,
      label: 'Photosynthesis', source: 'manual', confirmed: true
    })
    await TopicMarker.create({
      roomId: room._id, teacherId, startMs: 60000, endMs: 120000,
      label: 'Krebs Cycle', source: 'manual', confirmed: true
    })
    const label = await getLastConfirmedTopic({ roomId: room._id.toString() })
    expect(label).toBe('Krebs Cycle')
  })

  it('skips unconfirmed markers (source=auto)', async () => {
    const room = await Room.create({
      code: 'ROOM-A3', name: 'Room A3', teacher: new mongoose.Types.ObjectId()
    })
    const teacherId = room.teacher
    await TopicMarker.create({
      roomId: room._id, teacherId, startMs: 0, endMs: 60000,
      label: 'Auto Topic', source: 'auto', confirmed: false
    })
    const label = await getLastConfirmedTopic({ roomId: room._id.toString() })
    expect(label).toBeNull()
  })

  it('reuses last confirmed topic when heuristic returns empty', async () => {
    // Greeting-only chunks (heuristic returns empty) BUT a confirmed topic exists
    const r = await maybeGenerateAutoTopic({
      roomId: 'r-c1', nowMs: 100000,
      chunks: ['Hello hello hello'],
      lastConfirmedTopic: 'Photosynthesis'
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Photosynthesis')
    expect(r.reused).toBe(true)
    expect(r.source).toBe('inferred')
  })

  it('C-fallback does NOT fire when heuristic returns a real label', async () => {
    const r = await maybeGenerateAutoTopic({
      roomId: 'r-any', nowMs: 100000,
      chunks: ['Today we are going to discuss photosynthesis in great detail across the entire chapter on plant biology'],
      lastConfirmedTopic: 'Krebs Cycle'
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Photosynthesis')
    expect(r.reused).toBeFalsy()
  })

  it('does NOT use C-fallback when lastConfirmedTopic is empty string', async () => {
    const r = await maybeGenerateAutoTopic({
      roomId: 'r-empty', nowMs: 100000,
      chunks: ['Hello hello hello'],
      lastConfirmedTopic: ''
    })
    expect(r.createNew).toBe(false)
  })

  it('General Confusion only when BOTH heuristic and C-fallback are unavailable', async () => {
    const r = await maybeGenerateAutoTopic({
      roomId: 'r-gc', nowMs: 100000,
      chunks: ['Hi everyone'],
      lastConfirmedTopic: null
    })
    expect(r.createNew).toBe(false)
    expect(r.label).toBeFalsy()
  })
})