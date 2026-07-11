// backend/src/services/confusionScoring.js
//
// Weighted confusion scoring for Milestone 3.
//
// One raw `confusedStudentCount` is not enough -- a 5-student burst that
// lasted 5 seconds and resolved itself is very different from a 5-student
// confusion that has been bubbling for 90 seconds. We need a *score*.
//
// The score is a float 0..100. We then bucket it into tiers:
//
//   green  (0..29.999)  info     -- topic was tricky, students recovered
//   yellow (30..59.999) caution  -- teacher should check in
//   red    (60..100)    urgent   -- pivot / reteach
//
// Each axis contributes points up to its weight, then we sum and clamp.
//
//   count     (max 30)  smooth curve on student count
//   duration  (max 30)  linear, capped at 120s
//   recency   (max 25)  exp decay with 30s half-life
//   source    (max 15)  teacher-set marker = 15, auto topic = 10,
//                       transcript snippet = 5, none = 0
//
// `scoreEvent()` is a pure function -- no DB, easy to unit test.

export const TIER_BANDS = [
  { name: 'green', min: 0, max: 29.999, label: 'Info', emoji: '\ud83d\udfe2', description: 'Students briefly confused, recovered on their own' },
  { name: 'yellow', min: 30, max: 59.999, label: 'Caution', emoji: '\ud83d\udfe1', description: 'Teacher should check in or clarify' },
  { name: 'red', min: 60, max: 100, label: 'Urgent', emoji: '\ud83d\udd34', description: 'Pivot or reteach -- confusion is sustained' }
]

export function tierForScore (score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return null
  if (score < 30) return TIER_BANDS[0]
  if (score < 60) return TIER_BANDS[1]
  return TIER_BANDS[2]
}

const W_COUNT = 30
const W_DURATION = 30
const W_RECENCY = 25
const W_SOURCE = 15

function scoreCount (count) {
  if (!count || count <= 0) return 0
  // Smooth curve: 1 student -> ~7, 3 -> ~15, 5 -> ~20, 10 -> ~25
  // f(count) = 30 * (1 - 1/(1 + count/3))
  const x = count / 3
  return Math.min(W_COUNT, W_COUNT * (1 - 1 / (1 + x)))
}

function scoreDuration (durationMs) {
  if (!durationMs || durationMs <= 0) return 0
  const seconds = durationMs / 1000
  const v = Math.min(seconds, 120) / 120 // 0..1
  return v * W_DURATION
}

function scoreRecency (nowMs, lastUpdateMs) {
  if (!lastUpdateMs) return 0
  const ageMs = Math.max(0, nowMs - lastUpdateMs)
  const ageSec = ageMs / 1000
  // 0s -> 25, 30s -> ~12.5, 60s -> ~6, 120s -> ~1.5, 300s+ -> ~0
  const halfLife = 30
  const v = Math.exp(-Math.LN2 * ageSec / halfLife)
  return v * W_RECENCY
}

function scoreSource (source) {
  switch (source) {
    case 'marker': return 15
    case 'auto': return 10
    case 'transcript': return 5
    case 'none': return 0
    default: return 0
  }
}

function round1 (n) { return Math.round(n * 10) / 10 }

/**
 * @param {object} args
 * @param {number} args.confusedStudentCount - distinct students (de-duped)
 * @param {number} args.startTimestamp - first-signal ms epoch
 * @param {number} args.latestTimestamp - most-recent signal ms epoch
 * @param {string} args.topicSource - 'marker' | 'auto' | 'transcript' | 'none'
 * @param {number} [args.nowMs=Date.now()] - clock to use for recency
 */
export function scoreEvent ({
  confusedStudentCount,
  startTimestamp,
  latestTimestamp,
  topicSource,
  nowMs = Date.now()
}) {
  const durationMs = (startTimestamp && latestTimestamp)
    ? Math.max(0, latestTimestamp - startTimestamp)
    : 0
  const components = {
    count: round1(scoreCount(confusedStudentCount)),
    duration: round1(scoreDuration(durationMs)),
    recency: round1(scoreRecency(nowMs, latestTimestamp || startTimestamp)),
    source: round1(scoreSource(topicSource))
  }
  const raw = components.count + components.duration + components.recency + components.source
  const score = Math.max(0, Math.min(100, raw))
  const tier = tierForScore(score)
  return { score: round1(score), tier, components, durationMs, nowMs }
}

/**
 * Topic heatmap summary -- collapse many events into per-topic totals.
 * Sorted by total score (descending), capped at topN.
 *
 * @param {object[]} events - ConfusionEvent-like objects with topic.label + score
 * @param {number} [topN=10]
 */
export function buildTopicHeat (events, topN = 10) {
  const buckets = new Map()
  for (const e of events || []) {
    const label = e.topic?.label || e.topicLabel || '(no topic)'
    const key = label.toLowerCase().trim() || '__none__'
    if (!buckets.has(key)) {
      buckets.set(key, {
        topicLabel: label,
        topicSource: e.topic?.source || e.topicSource || 'none',
        eventCount: 0,
        studentCount: 0,
        totalScore: 0,
        maxScore: 0
      })
    }
    const b = buckets.get(key)
    b.eventCount += 1
    b.studentCount += e.confusedStudentCount || 0
    b.totalScore += e.score || 0
    if ((e.score || 0) > b.maxScore) b.maxScore = e.score || 0
  }
  const arr = [...buckets.values()].map(b => ({
    ...b,
    totalScore: round1(b.totalScore),
    maxScore: round1(b.maxScore),
    avgScore: b.eventCount > 0 ? round1(b.totalScore / b.eventCount) : 0
  }))
  arr.sort((a, b) => b.totalScore - a.totalScore)
  return arr.slice(0, topN)
}

/**
 * Build a time-of-class heatmap. Each event contributes its score across
 * the buckets it spans (proportional to overlap).
 *
 * @param {object} args
 * @param {number[]} args.starts - timestamps of event starts (ms epoch)
 * @param {number[]} args.lasts - timestamps of latest updates (ms epoch)
 * @param {number[]} args.scores - per-event scores
 * @param {number} args.classStartMs - recording start (anchor 0)
 * @param {number} args.classEndMs - recording end / now
 * @param {number} args.bucketCount - how many time buckets (default 12)
 */
export function buildHeatmap ({
  starts, lasts, scores, classStartMs, classEndMs, bucketCount = 12
}) {
  if (!classStartMs || !classEndMs || classEndMs <= classStartMs) {
    return { buckets: [], maxScore: 0 }
  }
  const span = classEndMs - classStartMs
  const bucketMs = span / bucketCount
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    index: i,
    startMs: classStartMs + i * bucketMs,
    endMs: classStartMs + (i + 1) * bucketMs,
    intensity: 0,
    eventCount: 0
  }))

  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]
    const e = lasts[i] || s
    const sc = scores[i] || 0
    if (s == null || e < s) continue
    for (const b of buckets) {
      const overlapStart = Math.max(b.startMs, s)
      const overlapEnd = Math.min(b.endMs, e)
      if (overlapEnd > overlapStart) {
        const fraction = (overlapEnd - overlapStart) / (e - s)
        b.intensity += sc * fraction
        if (overlapStart === s) b.eventCount += 1
      }
    }
  }

  let maxScore = 0
  for (const b of buckets) {
    b.intensity = round1(b.intensity)
    if (b.intensity > maxScore) maxScore = b.intensity
  }
  return { buckets, maxScore }
}

/**
 * Helper: format a tier name into a CSS class suffix.
 * Keeps the frontend's tier styling consistent with the backend scoring.
 */
export function tierToClass (tierName) {
  if (!tierName) return 'cac-tier--none'
  const known = ['green', 'yellow', 'red']
  return `cac-tier--${known.includes(tierName) ? tierName : 'none'}`
}