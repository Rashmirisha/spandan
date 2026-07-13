// topicGenerator.test.js -- unit tests for auto-topic detection pipeline.
//
// Covers:
//   - extractTopicProxy heuristic (stage directions, bigram detection,
//     sentence-opener filtering, proper-noun preference)
//   - maybeGenerateAutoTopic state machine (cooldown, shift detection, fallback)
//   - detectTopicShift (mocked MiniMax response)
//
// These tests run without a real MiniMax key by stubbing global fetch.

import {
  extractTopicProxy,
  maybeGenerateAutoTopic,
  detectTopicShift
} from '../services/topicGenerator.js'

// ─── extractTopicProxy ──────────────────────────────────────────────
describe('extractTopicProxy', () => {
  it('returns empty string for empty/null input', () => {
    expect(extractTopicProxy('')).toBe('')
    expect(extractTopicProxy(null)).toBe('')
    expect(extractTopicProxy(undefined)).toBe('')
    expect(extractTopicProxy(42)).toBe('')
  })

  it('strips [applause] stage directions before extracting', () => {
    const label = extractTopicProxy('[applause] Now Calvin cycle fixes carbon.')
    expect(label.toLowerCase()).toContain('calvin cycle')
    expect(label).not.toMatch(/^Now/i)
  })

  it('prefers capitalized proper-noun bigram over sentence opener', () => {
    const label = extractTopicProxy('Let me explain Photosynthesis now.')
    expect(label).toContain('Photosynthesis')
    expect(label).not.toMatch(/^Let /)
  })

  it('picks "Krebs cycle" from a longer transcript', () => {
    const label = extractTopicProxy('Today we will discuss the Krebs cycle and how it produces NADH.')
    expect(label.toLowerCase()).toContain('krebs cycle')
  })

  it('falls back to top content words when no capital nouns', () => {
    const label = extractTopicProxy('um so the investment phase uses atp to phosphorylate glucose.')
    expect(typeof label).toBe('string')
    expect(label.length).toBeGreaterThan(0)
  })

  it('does not return a label shorter than 1 char', () => {
    const label = extractTopicProxy('[noise]')
    expect(label).toBe('')
  })

  it('handles parenthetical stage directions', () => {
    const label = extractTopicProxy('(music) Binary Search trees use recursion heavily.')
    expect(label.toLowerCase()).toContain('binary')
  })

  it('truncates to a reasonable length', () => {
    const longText = 'Photosynthesis '.repeat(20)
    const label = extractTopicProxy(longText)
    expect(label.length).toBeLessThanOrEqual(60)
  })

  it('rejects [blank_audio] and other stage directions', () => {
    const label = extractTopicProxy('[blank_audio] Today we cover Dijkstra algorithm.')
    expect(label.toLowerCase()).toContain('dijkstra')
    expect(label).not.toMatch(/^Today/i)
  })

  // ─── Required topic-extraction cases ────────────────────────────────
  // Each input describes a real lecture topic. Expected behavior:
  //   - strip stopwords / filler / transcription artifacts
  //   - prefer capitalized scientific terms
  //   - return only the strong keyword for standalone topics
  //   - return the 2-word compound for compound topics
  //   - never repeat the same word twice

  it('extracts "Photosynthesis" from a lowercase-mention transcript', () => {
    const label = extractTopicProxy('Today we discuss photosynthesis.')
    expect(label).toBe('Photosynthesis')
  })

  it('extracts "Mitosis" from a learn-about-lecture transcript', () => {
    const label = extractTopicProxy("Let's learn about mitosis.")
    expect(label).toBe('Mitosis')
  })

  it('extracts "French Revolution" as a compound topic', () => {
    const label = extractTopicProxy('Today we begin our unit on the French Revolution and its causes.')
    expect(label).toBe('French Revolution')
  })

  it('extracts "Quadratic formula" from a lowercase-math transcript (sentence-case convention)', () => {
    const label = extractTopicProxy('The quadratic formula solves for the roots of any second-degree polynomial.')
    expect(label).toBe('Quadratic formula')
  })

  it('extracts "Natural Selection" as a compound topic', () => {
    const label = extractTopicProxy('Darwin proposed Natural Selection as the mechanism for evolution by descent with modification.')
    expect(label).toBe('Natural Selection')
  })

  it('never repeats a word in the output label', () => {
    const label = extractTopicProxy('Photosynthesis which Photosynthesis is the basis of Photosynthesis.')
    expect(label).not.toMatch(/\b(\w+)\s+\1\b/i)
  })

  it('does not include stopwords or filler in the label', () => {
    const label = extractTopicProxy('OK so today we are going to be talking about photosynthesis.')
    expect(label.toLowerCase()).not.toMatch(/\b(today|about|talking|going)\b/)
    expect(label).toBe('Photosynthesis')
  })

  it('caps labels at 4 meaningful words', () => {
    const label = extractTopicProxy('Photosynthesis Cellular Respiration Energy Metabolism Biochemical Pathways all share similarities.')
    const words = label.split(/\s+/)
    expect(words.length).toBeLessThanOrEqual(4)
  })

  it('returns Title Case for compound topics', () => {
    const label = extractTopicProxy('We examine Binary Search trees next.')
    expect(label).toBe('Binary Search')
  })
})

// ─── maybeGenerateAutoTopic ─────────────────────────────────────────
describe('maybeGenerateAutoTopic', () => {
  beforeEach(() => {
    // Ensure no live API key so we exercise the heuristic fallback path
    delete process.env.MINIMAX_API_KEY
  })

  it('returns createNew=false for empty transcripts', async () => {
    const r = await maybeGenerateAutoTopic({ recentTranscripts: [], nowMs: 60000 })
    expect(r.createNew).toBe(false)
  })

  it('returns createNew=false when text is too short', async () => {
    const r = await maybeGenerateAutoTopic({
      recentTranscripts: [{ text: 'short', recordingOffsetMs: 60000 }],
      nowMs: 60000
    })
    expect(r.createNew).toBe(false)
  })

  it('returns createNew=false when a recent auto topic already exists (cooldown)', async () => {
    const recent = [
      { text: 'Photosynthesis is the process by which green plants convert light energy into chemical energy.', recordingOffsetMs: 60000 }
    ]
    const r = await maybeGenerateAutoTopic({
      recentTranscripts: recent,
      lastAutoTopic: { label: 'Photosynthesis', startMs: 59000 },
      nowMs: 60000
    })
    expect(r.createNew).toBe(false)
  })

  it('creates a new topic with heuristic label when no prior topic exists', async () => {
    const recent = [
      { text: 'Today we will discuss Binary Search trees and how they allow O of log n lookups in sorted data.', recordingOffsetMs: 120000 }
    ]
    const r = await maybeGenerateAutoTopic({
      recentTranscripts: recent,
      lastAutoTopic: null,
      nowMs: 120000
    })
    expect(r.createNew).toBe(true)
    expect(r.label).toBeTruthy()
    expect(r.source).toBe('auto')
  })

  it('skips when the last transcript is outside the 90s window', async () => {
    const recent = [
      { text: 'x '.repeat(60), recordingOffsetMs: 0 } // very old
    ]
    const r = await maybeGenerateAutoTopic({
      recentTranscripts: recent,
      lastAutoTopic: null,
      nowMs: 600000 // 10 minutes later
    })
    expect(r.createNew).toBe(false)
  })

  it('returns createNew=true with new label when topic shifts', async () => {
    const recent = [
      { text: 'Quicksort partitions the array around a pivot element and recursively sorts the two halves.', recordingOffsetMs: 600000 }
    ]
    const r = await maybeGenerateAutoTopic({
      recentTranscripts: recent,
      lastAutoTopic: { label: 'Photosynthesis Calvin Cycle', startMs: 10000 },
      nowMs: 600000
    })
    expect(r.createNew).toBe(true)
    expect(r.label.toLowerCase()).not.toContain('photosynthesis')
  })
})

// ─── detectTopicShift (with mocked fetch) ───────────────────────────
describe('detectTopicShift', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
    process.env.MINIMAX_API_KEY = 'test-key-for-mock'
  })

  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.MINIMAX_API_KEY
  })

  it('returns null for very short transcripts', async () => {
    const r = await detectTopicShift({ recentText: 'short', previousTopic: null })
    expect(r).toBeNull()
  })

  it('returns null when API key is missing', async () => {
    delete process.env.MINIMAX_API_KEY
    const r = await detectTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check '.repeat(5),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('parses valid AI response', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: JSON.stringify({ label: 'Binary Search', changed: true, confidence: 0.92 }) }
        }]
      })
    })
    const r = await detectTopicShift({
      recentText: 'Binary search divides the sorted array in half each step. '.repeat(10),
      previousTopic: null
    })
    expect(r).toEqual({ changed: true, label: 'Binary Search', confidence: 0.92 })
  })

  it('returns null on invalid JSON from API', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'not json at all' } }]
      })
    })
    const r = await detectTopicShift({
      recentText: 'Photosynthesis is a process used by plants. '.repeat(10),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('returns null when API responds with non-2xx', async () => {
    global.fetch = async () => ({ ok: false, status: 500 })
    const r = await detectTopicShift({
      recentText: 'A valid transcript chunk for testing. '.repeat(10),
      previousTopic: null
    })
    expect(r).toBeNull()
  })

  it('clamps confidence to 0-1 range', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ label: 'X', confidence: 5.0 }) } }]
      })
    })
    const r = await detectTopicShift({
      recentText: 'A long enough transcript chunk to pass the length check '.repeat(5),
      previousTopic: null
    })
    expect(r.confidence).toBeLessThanOrEqual(1)
  })
})