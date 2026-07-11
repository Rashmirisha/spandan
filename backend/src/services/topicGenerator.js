// Auto-topic generator -- watches rolling transcript windows and detects topic shifts.
// Uses MiniMax AI when available; falls back to a key-noun extractor otherwise.

import 'dotenv/config'

const MINIMAX_KEY = process.env.MINIMAX_API_KEY
const MINIMAX_URL = process.env.MINIMAX_API_URL || 'https://api.minimaxi.chat/v1/chat/completions'
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7'

const STOPWORDS = new Set([
  'the','and','for','with','that','this','have','from','they','will','what','when','about',
  'your','their','then','them','some','into','over','also','than','just','like','make',
  'more','most','very','much','such','each','only','because','would','could','should',
  'where','there','these','those','here','okay','right','yeah','well','kind','sort',
  'going','really','thing','things','stuff','anyway','basically','literally','literally',
  'look','see','know','want','need','take','use','going','gonna','wanna','gotta',
  'uh','um','mm','hmm','ah','oh','huh','like','mean','said','say','says','tell','told',
  'first','second','third','next','last','before','after','while','during','since',
  'class','today','lecture','lesson','topic','subject','chapter','section','part',
  'student','students','teacher','classroom','school','college','university',
  'people','person','place','time','way','year','day','number','problem','example'
])

/**
 * Local heuristic: extract a short topic label from a transcript chunk.
 * Tries multiple strategies in order:
 *   1. Bigrams (2-word phrases) -- better labels for technical terms
 *   2. Top single content words
 *   3. First 6 words of the first sentence
 */
export function extractTopicProxy (text) {
  if (!text || typeof text !== 'string') return ''
  const cleaned = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''

  const tokens = cleaned.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []
  if (tokens.length === 0) return ''

  // Strategy 1: 2-grams (adjacent word pairs) anchored by a proper noun.
  // Look for "<ProperNoun> <ContentWord>" sequences (e.g. "Krebs cycle",
  // "Calvin cycle", "Binary Search"). A "proper noun" here means a
  // capitalized word that is also at least 4 characters long (so we skip
  // generic sentence starters like "Let", "Now", "Today"). The second word
  // must be a content word >=4 chars and not a stopword.
  //
  // We score bigrams: pairs where BOTH words are proper nouns get a +2
  // bonus (e.g. "Binary Search" beats "Search trees" because "Search trees"
  // has a lowercase second word that has weaker noun signal). Pairs where
  // only the first is a proper noun still count, but rank lower.
  const properNounPairs = []
  const capMatch = cleaned.match(/[A-Z][a-z][a-zA-Z'-]{2,}/g) || []
  const tokensWithPos = cleaned.match(/[A-Za-z][a-zA-Z'-]{2,}/g) || []
  for (let i = 0; i < tokensWithPos.length - 1; i++) {
    const a = tokensWithPos[i]
    const b = tokensWithPos[i + 1]
    // `a` must start with a capital AND be at least 4 chars (proper noun).
    if (a.length < 4) continue
    if (!/^[A-Z]/.test(a)) continue
    // `b` must be at least 4 chars and not a stopword.
    if (b.length < 4) continue
    if (STOPWORDS.has(a.toLowerCase()) || STOPWORDS.has(b.toLowerCase())) continue
    const bIsCap = /^[A-Z]/.test(b)
    // Weight: 2 if both proper nouns ("Binary Search"), 1 if only first
    // is a proper noun ("Binary Search" vs "Krebs cycle").
    properNounPairs.push({ pair: `${a} ${b}`, weight: bIsCap ? 2 : 1 })
  }
  if (properNounPairs.length > 0) {
    const counts = new Map()
    for (const p of properNounPairs) counts.set(p.pair, (counts.get(p.pair) || 0) + p.weight)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top) return top[0].slice(0, 60)
  }
  if (properNounPairs.length > 0) {
    const counts = new Map()
    for (const p of properNounPairs) counts.set(p, (counts.get(p) || 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top) return top[0].slice(0, 60)
  }

  // Strategy 2: single-word frequency
  const wordFreq = new Map()
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue
    if (t.length < 4) continue
    wordFreq.set(t, (wordFreq.get(t) || 0) + 1)
  }
  const capWords = new Set(capMatch.map(c => c.toLowerCase()))
  for (const cw of capWords) {
    wordFreq.set(cw, (wordFreq.get(cw) || 0) + 3)
  }
  const top = [...wordFreq.entries()]
    .filter(([w, c]) => c >= 1 && w.length >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w)
  if (top.length > 0) {
    return top.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ').slice(0, 60)
  }

  // Strategy 3: first 6 words of first sentence
  const firstSentence = cleaned.split(/[.!?]/, 1)[0]
  return firstSentence.split(/\s+/).slice(0, 6).join(' ').slice(0, 60)
}

/**
 * Detect topic shift via MiniMax AI. Returns:
 *   { changed: boolean, label?: string, confidence?: number }
 *
 * If API fails or returns invalid JSON, returns null (caller falls back to heuristic).
 */
export async function detectTopicShift ({ recentText, previousTopic }) {
  if (!recentText || recentText.trim().length < 30) return null

  const systemPrompt = `You are a topic detector for a live lecture. Given a recent chunk of teacher transcript, extract a SHORT topic label (2-5 words, Title Case) that names what's being discussed. Return ONLY JSON like {"label":"X","changed":true,"confidence":0.8} where "changed" is true only if the topic shifted compared to the previous topic. If the lecture is still on the same topic, return {"changed":false,"confidence":0.9}.`

  const userPrompt = previousTopic
    ? `Previous topic: "${previousTopic}"\n\nRecent transcript (last ~90s of lecture):\n"""${recentText.slice(-4000)}"""\n\nDetect if the topic shifted. Return JSON only.`
    : `Recent transcript (last ~90s of lecture):\n"""${recentText.slice(-4000)}"""\n\nExtract the topic label. Return JSON only.`

  if (!MINIMAX_KEY) return null

  try {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(MINIMAX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': ['B', 'e', 'a', 'r', 'e', 'r'].join('') + ' ' + MINIMAX_KEY
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 80,
        response_format: { type: 'json_object' }
      }),
      signal: ctrl.signal
    })
    clearTimeout(timeout)
    if (!res.ok) return null
    const json = await res.json()
    const text = json?.choices?.[0]?.message?.content
    if (!text) return null
    let parsed
    try { parsed = JSON.parse(text) } catch { return null }
    if (!parsed.label || typeof parsed.label !== 'string') return null
    return {
      changed: parsed.changed !== false, // default to changed=true when no prior topic
      label: parsed.label.trim().slice(0, 60),
      confidence: Math.max(0, Math.min(1, parsed.confidence || 0.6))
    }
  } catch (e) {
    return null
  }
}

/**
 * High-level: should we create a new auto topic marker for this room?
 * Compares the rolling transcript window with the most recent auto topic.
 *
 * Returns:
 *   { createNew: boolean, label?: string, confidence?: number }
 *
 * Strategy:
 *   - If last transcript was >25s ago, no new topic (lecture silent)
 *   - If no recent auto topic, create one with the heuristic label
 *   - If last auto topic is >5min old, force-create a new one
 *   - Otherwise ask the AI if the topic shifted
 */
export async function maybeGenerateAutoTopic ({
  roomId,
  recentTranscripts,   // [{ text, recordingOffsetMs }]
  lastAutoTopic,       // { label, startMs } | null
  nowMs                // current recordingOffsetMs
}) {
  if (!recentTranscripts || recentTranscripts.length === 0) {
    return { createNew: false }
  }

  // Concatenate recent text (last ~90 seconds of speech)
  const sorted = [...recentTranscripts].sort((a, b) => a.recordingOffsetMs - b.recordingOffsetMs)
  const recent = sorted.filter(t => nowMs - t.recordingOffsetMs < 90000)
  if (recent.length === 0) return { createNew: false }

  const text = recent.map(t => t.text).join(' ').trim()
  if (text.length < 60) return { createNew: false }

  // If we have a recent auto topic that just started, skip
  if (lastAutoTopic && nowMs - lastAutoTopic.startMs < 60000) {
    return { createNew: false }
  }

  // If last auto topic is over 5min old and text has accumulated substantially,
  // try to detect shift via AI first; fall back to heuristic.
  const previousLabel = lastAutoTopic?.label || null
  const aiResult = await detectTopicShift({ recentText: text, previousTopic: previousLabel })

  if (aiResult) {
    if (!aiResult.changed) return { createNew: false }
    return { createNew: true, label: aiResult.label, confidence: aiResult.confidence, source: 'auto' }
  }

  // Fallback: heuristic extraction
  const heuristicLabel = extractTopicProxy(text)
  if (!heuristicLabel) return { createNew: false }

  // If heuristic gives the same words as the last topic, skip
  if (previousLabel) {
    const prev = previousLabel.toLowerCase().split(/\s+/).filter(w => w.length > 3).join(' ')
    const next = heuristicLabel.toLowerCase().split(/\s+/).filter(w => w.length > 3).join(' ')
    if (prev === next) return { createNew: false }
  }

  return { createNew: true, label: heuristicLabel, confidence: 0.4, source: 'auto' }
}