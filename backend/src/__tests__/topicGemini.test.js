// topicGemini.test.js -- regression tests for Gemini as the PRIMARY AI
// topic generator, with the local heuristic as the fallback.
//
// Covers (per Rashmi's PR #35 spec):
//   - Gemini available → verify AI-generated topic
//   - Gemini unavailable (network error) → verify local heuristic
//   - Gemini 401 → verify fallback
//   - Missing API key → verify fallback
//   - Fragmented transcript → verify meaningful topic
//   - Greeting + lecture content → verify lecture topic is selected
//   - 401/403/timeout/bad-JSON/invalid-label all fall back to the heuristic
//   - Empty transcript / too-short input → heuristic handles it
//
// Run with: `npm test -- --testPathPatterns=topicGemini.test.js --runInBand`

import {
  extractTopicProxy,
  maybeGenerateAutoTopic,
  detectGeminiTopicShift
} from '../services/topicGenerator.js'

// ─── detectGeminiTopicShift (mocked fetch) ──────────────────────────
describe('detectGeminiTopicShift', () => {
  let originalFetch
  let originalKey

  beforeEach(() => {
    originalFetch = global.fetch
    originalKey = process.env.GEMINI_API_KEY
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  })

  it('returns null when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY
    const r = await detectGeminiTopicShift({
      recentText: 'This is a long enough transcript to pass the length check for the AI path. '.repeat(5),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('returns null when transcript is too short (< 30 chars)', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    const r = await detectGeminiTopicShift({ recentText: 'short', previousTopic: null })
    expect(r).toBeNull()
  })

  it('parses a valid Gemini response and returns the label', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: '{"label":"Photosynthesis","changed":true,"confidence":0.92}' }] }
        }]
      })
    })
    const r = await detectGeminiTopicShift({
      recentText: 'Today we are going to understand photosynthesis. Photosynthesis is the process by which green plants convert light energy into chemical energy. '.repeat(3),
      previousTopic: null
    })
    expect(r).toEqual({ changed: true, label: 'Photosynthesis', confidence: 0.92 })
  })

  it('passes chunks (last 3-5) to Gemini when provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    let capturedBody = null
    global.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"label":"Photosynthesis","changed":true,"confidence":0.85}' }] } }]
        })
      }
    }
    await detectGeminiTopicShift({
      recentText: 'ambiguous single string',
      previousTopic: null,
      chunks: [
        'Hi everyone today we are going to learn something interesting',
        'Photosynthesis is the process by which green plants convert light energy',
        'It mainly occurs in the chloroplasts'
      ]
    })
    expect(capturedBody).toBeTruthy()
    // The joined chunks should appear in the user prompt
    const userText = capturedBody.contents?.[0]?.parts?.[0]?.text || ''
    expect(userText).toContain('Photosynthesis')
    expect(userText).toContain('chloroplasts')
    // systemInstruction should be present
    expect(capturedBody.systemInstruction?.parts?.[0]?.text).toMatch(/topic detector/i)
  })

  it('returns null when Gemini returns 401 (invalid key)', async () => {
    process.env.GEMINI_API_KEY = 'expired-key'
    global.fetch = async () => ({ ok: false, status: 401 })
    const r = await detectGeminiTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check. '.repeat(5),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('returns null when Gemini returns 403', async () => {
    process.env.GEMINI_API_KEY = 'forbidden-key'
    global.fetch = async () => ({ ok: false, status: 403 })
    const r = await detectGeminiTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check. '.repeat(5),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('returns null when Gemini returns 429 (rate limit)', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({ ok: false, status: 429 })
    const r = await detectGeminiTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check. '.repeat(5),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('returns null when Gemini request throws (timeout / network)', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => { throw new Error('ECONNRESET') }
    const r = await detectGeminiTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check. '.repeat(5),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('returns null on bad JSON from Gemini', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'not json at all' }] } }]
      })
    })
    const r = await detectGeminiTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check. '.repeat(5),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('returns null when Gemini returns empty label', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"label":"","changed":true,"confidence":0.9}' }] } }]
      })
    })
    const r = await detectGeminiTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check. '.repeat(5),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('strips code-fenced JSON from Gemini response', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '```json\n{"label":"Climate Change","changed":true,"confidence":0.88}\n```' }] } }]
      })
    })
    const r = await detectGeminiTopicShift({
      recentText: 'We are studying climate change and global warming effects. '.repeat(5),
      previousTopic: null
    })
    expect(r).toEqual({ changed: true, label: 'Climate Change', confidence: 0.88 })
  })

  it('clamps confidence to 0..1', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"label":"X","changed":true,"confidence":5.0}' }] } }]
      })
    })
    const r = await detectGeminiTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check. '.repeat(5),
      previousTopic: null
    })
    expect(r.confidence).toBeLessThanOrEqual(1)
  })

  it('caps label at 60 chars', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    const long = 'A'.repeat(200)
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: `{"label":"${long}","changed":true,"confidence":0.9}` }] } }]
      })
    })
    const r = await detectGeminiTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check. '.repeat(5),
      previousTopic: null
    })
    expect(r.label.length).toBeLessThanOrEqual(60)
  })
})

// ─── maybeGenerateAutoTopic with Gemini as primary ─────────────────
describe('maybeGenerateAutoTopic: Gemini-primary chain', () => {
  let originalFetch
  let originalKey

  beforeEach(() => {
    originalFetch = global.fetch
    originalKey = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  })

  it('Gemini available → uses AI-generated topic (Primary requirement)', async () => {
    process.env.GEMINI_API_KEY = 'test-key-fake'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"label":"Photosynthesis","changed":true,"confidence":0.92}' }] } }]
      })
    })
    const r = await maybeGenerateAutoTopic({
      roomId: 'gem-1', nowMs: 100000,
      chunks: [
        'Hi everyone today we are going to learn about something interesting',
        'Photosynthesis is the process by which green plants convert light energy into chemical energy'
      ]
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Photosynthesis')
    expect(r.source).toBe('auto')
    expect(r.confidence).toBe(0.92)
  })

  it('Gemini returns 401 → falls back to heuristic', async () => {
    process.env.GEMINI_API_KEY = 'expired-key'
    global.fetch = async () => ({ ok: false, status: 401 })
    const r = await maybeGenerateAutoTopic({
      roomId: 'gem-401', nowMs: 100000,
      chunks: ['Mitochondria are the powerhouse of the cell and produce ATP through respiration']
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Mitochondria')
    expect(r.source).toBe('auto')
  })

  it('Gemini times out → falls back to heuristic', async () => {
    process.env.GEMINI_API_KEY = 'timeout-key'
    global.fetch = async () => { throw new Error('AbortError: timeout') }
    const r = await maybeGenerateAutoTopic({
      roomId: 'gem-timeout', nowMs: 100000,
      chunks: ['Krebs cycle is part of cellular respiration and produces NADH and FADH2']
    })
    expect(r.createNew).toBe(true)
    expect(r.label.toLowerCase()).toMatch(/krebs/)
  })

  it('Missing GEMINI_API_KEY → falls back to local heuristic', async () => {
    // GEMINI_API_KEY is already deleted in beforeEach
    const r = await maybeGenerateAutoTopic({
      roomId: 'gem-nokey', nowMs: 100000,
      chunks: ['Today we are going to understand photosynthesis. Photosynthesis is the process by which green plants convert light energy into chemical energy.']
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Photosynthesis')
    expect(r.source).toBe('auto')
    // fetch should NOT have been called
    expect(global.fetch).toBeUndefined()
  })

  it('Fragmented transcript → Gemini sees full context and returns concept', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    let capturedUserText = ''
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body)
      capturedUserText = body.contents?.[0]?.parts?.[0]?.text || ''
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"label":"Photosynthesis","changed":true,"confidence":0.85}' }] } }]
        })
      }
    }
    const r = await maybeGenerateAutoTopic({
      roomId: 'gem-frag', nowMs: 100000,
      chunks: [
        'Hi everyone today we are going to study something interesting',
        'Photosynthesis is the process',
        'by which green plants',
        'convert light energy into chemical energy'
      ]
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Photosynthesis')
    // Verify Gemini received the joined chunks
    expect(capturedUserText).toContain('Photosynthesis')
    expect(capturedUserText).toContain('green plants')
  })

  it('Greeting + lecture content → Gemini picks lecture content (not greeting)', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"label":"Photosynthesis","changed":true,"confidence":0.9}' }] } }]
      })
    })
    const r = await maybeGenerateAutoTopic({
      roomId: 'gem-greet', nowMs: 100000,
      chunks: [
        'Hello everyone, welcome to today class',
        'Good morning students, hope you all are doing well',
        'So today we are going to understand photosynthesis in detail',
        'Photosynthesis is the process by which green plants convert light energy into chemical energy'
      ]
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Photosynthesis')
  })

  it('Gemini returns invalid JSON → falls back to heuristic', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'not json at all' }] } }]
      })
    })
    const r = await maybeGenerateAutoTopic({
      roomId: 'gem-bad-json', nowMs: 100000,
      chunks: ['Chlorophyll absorbs red and blue light during photosynthesis in plant cells']
    })
    expect(r.createNew).toBe(true)
    expect(r.label.toLowerCase()).toMatch(/chlorophyll|photosynthesis/)
  })

  it('Gemini returns empty label → falls back to heuristic', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"label":"","changed":true,"confidence":0.9}' }] } }]
      })
    })
    const r = await maybeGenerateAutoTopic({
      roomId: 'gem-empty', nowMs: 100000,
      chunks: ['Mitochondria are the powerhouse of the cell and produce ATP through respiration']
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBe('Mitochondria')
  })

  it('Gemini says no topic shift → returns createNew:false', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"label":"Photosynthesis","changed":false,"confidence":0.95}' }] } }]
      })
    })
    const r = await maybeGenerateAutoTopic({
      roomId: 'gem-shift', nowMs: 100000,
      lastAutoTopic: { label: 'Photosynthesis', startMs: 80000 },
      chunks: ['Photosynthesis continues and we move to the next sub-topic of chlorophyll absorption']
    })
    expect(r.createNew).toBe(false)
    expect(r.reason).toBe('gemini_no_shift')
  })

  it('URLs / advertisements in transcript → Gemini ignores them (verified via prompt design)', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    let capturedUserText = ''
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body)
      capturedUserText = body.contents?.[0]?.parts?.[0]?.text || ''
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"label":"Photosynthesis","changed":true,"confidence":0.9}' }] } }]
        })
      }
    }
    await maybeGenerateAutoTopic({
      roomId: 'gem-ads', nowMs: 100000,
      chunks: [
        'Visit www.spandan.com for more info',
        'Check out our sponsor at https://example.com',
        'Photosynthesis is the process by which green plants convert light energy into chemical energy'
      ]
    })
    // The system prompt MUST instruct Gemini to ignore URLs/ads
    expect(capturedUserText).toBeTruthy()
    // Verify the system prompt (sent separately) contains the ignore rule
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body)
      expect(body.systemInstruction?.parts?.[0]?.text).toMatch(/URLs|advertisements/i)
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"label":"Photosynthesis","changed":true,"confidence":0.9}' }] } }]
        })
      }
    }
    await maybeGenerateAutoTopic({
      roomId: 'gem-ads-2', nowMs: 100000,
      chunks: ['Photosynthesis is the process by which green plants convert light energy into chemical energy']
    })
  })
})

// ─── extractTopicProxy sanity (still works without AI) ─────────────
describe('extractTopicProxy (heuristic still works without Gemini)', () => {
  it('returns Photosynthesis for the canonical example', () => {
    const text = 'Today we are going to understand photosynthesis. Photosynthesis is the process by which green plants convert light energy into chemical energy.'
    expect(extractTopicProxy(text)).toBe('Photosynthesis')
  })

  it('returns Photosynthesis from greeting + lecture content', () => {
    const chunks = [
      'Hello everyone today we are going to study something interesting',
      'Photosynthesis is the process by which green plants convert light energy into chemical energy'
    ]
    expect(extractTopicProxy(chunks)).toBe('Photosynthesis')
  })

  it('returns "" for greeting-only input', () => {
    expect(extractTopicProxy('Hello hello hello')).toBe('')
  })
})
