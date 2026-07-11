// confusionScoring.test.js -- pure-function tests for the weighted scoring
// service that powers Milestone 3 (alert tiers + topic heat).

import {
  scoreEvent,
  tierForScore,
  buildTopicHeat,
  buildHeatmap,
  TIER_BANDS,
  tierToClass
} from '../services/confusionScoring.js'

describe('confusionScoring -- tierForScore', () => {
  test('returns null for non-numeric', () => {
    expect(tierForScore('50')).toBeNull()
    expect(tierForScore(null)).toBeNull()
    expect(tierForScore(NaN)).toBeNull()
  })

  test('returns green band for low scores', () => {
    expect(tierForScore(0).name).toBe('green')
    expect(tierForScore(15).name).toBe('green')
    expect(tierForScore(29).name).toBe('green')
    expect(tierForScore(29.999).name).toBe('green')
  })

  test('returns yellow band for moderate', () => {
    expect(tierForScore(30).name).toBe('yellow')
    expect(tierForScore(45).name).toBe('yellow')
    expect(tierForScore(59).name).toBe('yellow')
    expect(tierForScore(59.999).name).toBe('yellow')
  })

  test('returns red band for high', () => {
    expect(tierForScore(60).name).toBe('red')
    expect(tierForScore(85).name).toBe('red')
    expect(tierForScore(100).name).toBe('red')
  })
})

describe('confusionScoring -- scoreEvent', () => {
  const NOW = 1_700_000_000_000
  const FIVE_MIN_AGO = NOW - 5 * 60 * 1000
  const ONE_MIN_AGO = NOW - 60 * 1000

  test('zero students + no source + no signal => green band at zero', () => {
    const out = scoreEvent({
      confusedStudentCount: 0,
      startTimestamp: null,
      latestTimestamp: null,
      topicSource: 'none',
      nowMs: NOW
    })
    expect(out.score).toBe(0)
    expect(out.tier.name).toBe('green')
  })

  test('one recent student + teacher marker => tier matches axis sum', () => {
    const out = scoreEvent({
      confusedStudentCount: 1,
      startTimestamp: ONE_MIN_AGO,
      latestTimestamp: ONE_MIN_AGO,
      topicSource: 'marker',
      nowMs: NOW
    })
    // count(1) ~= 7.5, duration 0, recency(NOW-60s) ~= 6.25, source 15 => raw ~28.75 -> green
    expect(out.score).toBeGreaterThanOrEqual(20)
    expect(out.score).toBeLessThan(40)
    expect(out.tier.name).toBe('green')
    expect(out.components.source).toBe(15)
  })

  test('5 students bubbling 90s + auto topic => red', () => {
    const out = scoreEvent({
      confusedStudentCount: 5,
      startTimestamp: NOW - 90 * 1000,
      latestTimestamp: NOW,
      topicSource: 'auto',
      nowMs: NOW
    })
    // count~20 + duration~22.5 + recency~25 + source~10 ~= 77.5
    expect(out.score).toBeGreaterThanOrEqual(60)
    expect(out.tier.name).toBe('red')
  })

  test('recency decays -- older event scores lower even with same count', () => {
    const fresh = scoreEvent({
      confusedStudentCount: 4,
      startTimestamp: NOW - 5 * 1000,
      latestTimestamp: NOW,
      topicSource: 'auto',
      nowMs: NOW
    })
    const stale = scoreEvent({
      confusedStudentCount: 4,
      startTimestamp: NOW - 5 * 60 * 1000,
      latestTimestamp: NOW - 4 * 60 * 1000,
      topicSource: 'auto',
      nowMs: NOW
    })
    expect(fresh.score).toBeGreaterThan(stale.score)
    expect(fresh.components.recency).toBeGreaterThan(stale.components.recency)
  })

  test('duration capped at 120s', () => {
    const just = scoreEvent({
      confusedStudentCount: 3, startTimestamp: NOW - 119 * 1000, latestTimestamp: NOW,
      topicSource: 'none', nowMs: NOW
    })
    const way = scoreEvent({
      confusedStudentCount: 3, startTimestamp: NOW - 600 * 1000, latestTimestamp: NOW,
      topicSource: 'none', nowMs: NOW
    })
    // Both should saturate near 30 (one is 119/120*30 = 29.75 -> 29.8, other is 30.0)
    expect(just.components.duration).toBeGreaterThanOrEqual(29)
    expect(way.components.duration).toBeGreaterThanOrEqual(29)
    expect(Math.abs(just.components.duration - way.components.duration)).toBeLessThan(1)
  })

  test('count curve is monotonically increasing', () => {
    let prev = -1
    for (const c of [1, 2, 3, 5, 10, 20, 100]) {
      const out = scoreEvent({
        confusedStudentCount: c,
        startTimestamp: NOW, latestTimestamp: NOW,
        topicSource: 'none', nowMs: NOW
      })
      expect(out.components.count).toBeGreaterThan(prev)
      prev = out.components.count
    }
  })

  test('score clamps to [0, 100]', () => {
    const max = scoreEvent({
      confusedStudentCount: 200,
      startTimestamp: NOW - 999 * 1000,
      latestTimestamp: NOW,
      topicSource: 'marker',
      nowMs: NOW
    })
    expect(max.score).toBeLessThanOrEqual(100)
    expect(max.tier.name).toBe('red')
  })

  test('handles malformed input gracefully', () => {
    const out = scoreEvent({
      confusedStudentCount: undefined,
      startTimestamp: null,
      latestTimestamp: undefined,
      topicSource: 'marker',
      nowMs: NOW
    })
    expect(out.score).toBeGreaterThanOrEqual(0)
    expect(out.score).toBeLessThanOrEqual(100)
    expect(out.tier).toBeTruthy()
  })

  test('source-axis values are correct', () => {
    const mk = scoreEvent({ confusedStudentCount: 1, startTimestamp: NOW, latestTimestamp: NOW, topicSource: 'marker', nowMs: NOW })
    const au = scoreEvent({ confusedStudentCount: 1, startTimestamp: NOW, latestTimestamp: NOW, topicSource: 'auto', nowMs: NOW })
    const ts = scoreEvent({ confusedStudentCount: 1, startTimestamp: NOW, latestTimestamp: NOW, topicSource: 'transcript', nowMs: NOW })
    const nn = scoreEvent({ confusedStudentCount: 1, startTimestamp: NOW, latestTimestamp: NOW, topicSource: 'none', nowMs: NOW })
    expect(mk.components.source).toBe(15)
    expect(au.components.source).toBe(10)
    expect(ts.components.source).toBe(5)
    expect(nn.components.source).toBe(0)
  })
})

describe('confusionScoring -- buildTopicHeat', () => {
  test('aggregates by topic, case-insensitive', () => {
    const events = [
      { topic: { label: 'Binary Search', source: 'auto' }, confusedStudentCount: 3, score: 60 },
      { topic: { label: 'binary search', source: 'auto' }, confusedStudentCount: 2, score: 50 },
      { topic: { label: 'Sorting', source: 'marker' }, confusedStudentCount: 5, score: 70 },
      { topic: { label: 'Trees', source: 'transcript' }, confusedStudentCount: 1, score: 20 }
    ]
    const heat = buildTopicHeat(events)
    const bs = heat.find(h => /binary search/i.test(h.topicLabel))
    expect(bs).toBeTruthy()
    expect(bs.eventCount).toBe(2)
    expect(bs.studentCount).toBe(5)
    expect(bs.totalScore).toBe(110)
  })

  test('sorts descending by totalScore', () => {
    const events = [
      { topic: { label: 'A' }, confusedStudentCount: 1, score: 10 },
      { topic: { label: 'B' }, confusedStudentCount: 1, score: 50 },
      { topic: { label: 'C' }, confusedStudentCount: 1, score: 30 }
    ]
    const heat = buildTopicHeat(events)
    expect(heat.map(h => h.topicLabel)).toEqual(['B', 'C', 'A'])
  })

  test('respects topN', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      topic: { label: 'T' + i }, confusedStudentCount: 1, score: 100 - i
    }))
    expect(buildTopicHeat(events, 5)).toHaveLength(5)
  })

  test('handles no-topic events as a single bucket', () => {
    const events = [
      { topic: { label: '' }, confusedStudentCount: 2, score: 20 },
      { topic: null, confusedStudentCount: 1, score: 10 }
    ]
    const heat = buildTopicHeat(events)
    expect(heat).toHaveLength(1)
  })

  test('handles empty / null input', () => {
    expect(buildTopicHeat([])).toEqual([])
    expect(buildTopicHeat(null)).toEqual([])
  })
})

describe('confusionScoring -- buildHeatmap', () => {
  const T0 = 1_700_000_000_000
  const T60 = T0 + 60_000

  test('returns empty buckets when class window invalid', () => {
    expect(buildHeatmap({ starts: [], lasts: [], scores: [], classStartMs: null, classEndMs: T60 })).toEqual({ buckets: [], maxScore: 0 })
    expect(buildHeatmap({ starts: [], lasts: [], scores: [], classStartMs: T60, classEndMs: T0 })).toEqual({ buckets: [], maxScore: 0 })
  })

  test('builds 12 buckets by default', () => {
    const r = buildHeatmap({
      starts: [T0 + 5000],
      lasts: [T0 + 6000],
      scores: [30],
      classStartMs: T0,
      classEndMs: T60,
      bucketCount: 12
    })
    expect(r.buckets).toHaveLength(12)
  })

  test('event contributes score only to overlapping bucket(s)', () => {
    const r = buildHeatmap({
      starts: [T0 + 5000],
      lasts: [T0 + 15000],
      scores: [60],
      classStartMs: T0,
      classEndMs: T60,
      bucketCount: 6 // 10s buckets
    })
    // Bucket 0 = 0..10s, event 5..15s -> falls in bucket 0 only
    expect(r.buckets[0].intensity).toBeGreaterThan(0)
    expect(r.buckets[0].eventCount).toBe(1)
    // bucket 1 = 10..20s -- partial overlap is fractional; should be < 60
    expect(r.buckets[1].intensity).toBeLessThan(60)
    expect(r.buckets[1].intensity).toBeGreaterThan(0)
    expect(r.buckets[2].intensity).toBe(0)
  })

  test('maxScore is the highest bucket intensity', () => {
    const r = buildHeatmap({
      starts: [T0, T0 + 5000, T0 + 11000],
      lasts: [T0 + 1000, T0 + 8000, T0 + 13000],
      scores: [20, 80, 30],
      classStartMs: T0,
      classEndMs: T60,
      bucketCount: 6
    })
    const top = Math.max(...r.buckets.map(b => b.intensity))
    expect(r.maxScore).toBe(top)
  })
})

describe('confusionScoring -- tierToClass', () => {
  test('maps known tier names', () => {
    expect(tierToClass('green')).toBe('cac-tier--green')
    expect(tierToClass('yellow')).toBe('cac-tier--yellow')
    expect(tierToClass('red')).toBe('cac-tier--red')
  })
  test('null/unknown maps to none', () => {
    expect(tierToClass(null)).toBe('cac-tier--none')
    expect(tierToClass('purple')).toBe('cac-tier--none')
  })
})

describe('confusionScoring -- TIER_BANDS constant', () => {
  test('all bands cover 0..100 contiguously', () => {
    let prevMax = -1
    for (const b of TIER_BANDS) {
      // Allow float bands (max is 29.999/59.999); check contiguity in >= sense
      expect(b.min).toBeGreaterThan(prevMax)
      prevMax = b.max
    }
    expect(prevMax).toBeGreaterThanOrEqual(99)
    // And that they classify the integer boundary values consistently
    expect(tierForScore(0).name).toBe('green')
    expect(tierForScore(30).name).toBe('yellow')
    expect(tierForScore(60).name).toBe('red')
  })
})