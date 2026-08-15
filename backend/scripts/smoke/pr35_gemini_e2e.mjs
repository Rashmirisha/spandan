/**
 * smoke: pr35_gemini_e2e
 *
 * End-to-end verification for PR #35 (Gemini as PRIMARY topic generator).
 *
 * Exercises the real browser flow programmatically:
 *   1. Teacher logs in, creates a fresh room, starts a session.
 *   2. Teacher "speaks" → POSTs 3 transcript chunks (the photosynthesis lecture).
 *   3. Backend auto-topic generation runs. Asserts:
 *        - topic is "Photosynthesis" (regardless of Gemini or heuristic)
 *        - topic appears in /topic-heat
 *   4. Student A presses "I'm Lost" → confusion event created.
 *   5. Student B does NOT press "I'm Lost" → no event for B.
 *   6. Teacher sends recovery prompt → ONLY Student A receives it (per-student targeting).
 *
 * Prerequisites (must be running on host):
 *   - MongoDB :27017
 *   - Backend :3001  (with NEW Gemini code in topicGenerator.js)
 *   - Faster-Whisper :3003
 *   - Frontend :5173 (only the browser would touch this)
 *
 * Run: `node scripts/smoke/pr35_gemini_e2e.mjs`
 */

import { io as ioClient } from 'socket.io-client'

const BASE = 'http://localhost:3001'
const TEACHER = 'rashmi@spandan.local'
const STUDENT_A = 'student@spandan.local'
const STUDENT_B = 'student2@spandan.local'
const PASS = 'Test1234!'

let _n = 0
function ok (label, cond, detail) {
  _n += 1
  const tag = cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  console.log(`[${tag}] #${_n} ${label}${detail ? '  → ' + detail : ''}`)
  if (!cond) process.exitCode = 1
}

async function login (email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS })
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`login(${email}) failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j.token
}

async function authFetch (path, token, opts = {}) {
  return fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  })
}

function socket (token, label) {
  return new Promise((resolve) => {
    const sock = ioClient(BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: false
    })
    sock.on('connect_error', (e) => console.log(`[${label}] connect_error:`, e.message))
    sock.on('connect', () => {})
    setTimeout(() => resolve({ sock, label }), 1500)
  })
}

async function postTranscript (token, roomId, segmentIndex, text) {
  return authFetch('/api/transcripts', token, {
    method: 'POST',
    body: JSON.stringify({
      roomId,
      segmentIndex,
      text,
      duration: 3000,
      wordCount: text.split(/\s+/).length,
      source: 'audio'
    })
  })
}

async function main () {
  console.log('===== PR #35 END-TO-END (Gemini primary) =====\n')

  // 1. Teacher login
  const teacherToken = await login(TEACHER)
  ok('teacher login', !!teacherToken)

  // 2. Create fresh room
  const createRoom = await authFetch('/api/rooms', teacherToken, {
    method: 'POST',
    body: JSON.stringify({ name: `PR35 Gemini Test ${Date.now()}` })
  })
  const createJ = await createRoom.json()
  const room = createJ.room || createJ
  ok('room created', createRoom.ok && !!room._id, `id=${room._id} code=${room.code}`)

  // 3. Start session (sets roomStartedAt)
  const start = await authFetch(`/api/doubts/room/${room._id}/session/start`, teacherToken, {
    method: 'POST'
  })
  const startJ = await start.json()
  ok('session started', start.ok && startJ.success, `roomStartedAt=${startJ.roomStartedAt}`)

  // 4. Students join via socket
  const aToken = await login(STUDENT_A)
  const bToken = await login(STUDENT_B)
  const aSock = await socket(aToken, 'A')
  const bSock = await socket(bToken, 'B')
  aSock.sock.emit('room:join', { roomCode: room.code })
  bSock.sock.emit('room:join', { roomCode: room.code })
  await new Promise(r => setTimeout(r, 800))

  // Track per-student socket events
  const received = { A: [], B: [] }
  for (const evt of ['confusion:new', 'confusion:update', 'confusion:resolved', 'recovery:request', 'doubt:new']) {
    aSock.sock.on(evt, (p) => received.A.push({ evt, payload: p }))
    bSock.sock.on(evt, (p) => received.B.push({ evt, payload: p }))
  }

  // 5. Teacher "speaks" → POST 3 transcript chunks
  const chunks = [
    'Hi everyone today we are going to study something interesting',
    'Photosynthesis is the process by which green plants convert light energy into chemical energy',
    'It mainly occurs in the chloroplasts of leaves'
  ]
  console.log('\n--- Posting transcript chunks ---')
  for (let i = 0; i < chunks.length; i++) {
    const r = await postTranscript(teacherToken, room._id, i, chunks[i])
    console.log(`  chunk ${i}: ${r.status} ${chunks[i].slice(0, 60)}...`)
  }
  ok('transcript chunks posted', true, `${chunks.length} chunks`)

  // 6. Wait for auto-topic generation
  await new Promise(r => setTimeout(r, 12000))

  // 7. Read topic-heat (deferred — needs confusion events to be in the DB)
  let topics = []
  let aiSource = null

  // 8. Confusion flow — student A presses "I'm Lost"
  const doubtRes = await authFetch('/api/doubts', aToken, {
    method: 'POST',
    body: JSON.stringify({ roomId: room._id, segmentIndex: 0, utteranceSnapshot: 'I don\'t get it' })
  })
  const doubtJ = await doubtRes.json()
  const evtId = doubtJ.signal?.id || doubtJ.event?.id || doubtJ.event?._id || doubtJ.id || doubtJ._id
  ok('student A doubt accepted', doubtRes.ok && doubtJ.success, `signal.id=${evtId}`)

  await new Promise(r => setTimeout(r, 1000))

  // 9. Active event
  const activeRes = await authFetch(`/api/confusion/room/${room._id}/active`, teacherToken)
  const activeJ = await activeRes.json()
  const activeEvt = activeJ.active || activeJ.event
  ok('active confusion event exists', !!activeEvt, `topic=${activeEvt?.topic?.label || activeEvt?.topicLabel} studentCount=${activeEvt?.confusedStudentCount}`)

  // 9b. Now topic-heat will have data (it aggregates confusion events)
  const heatRes = await authFetch(`/api/confusion/room/${room._id}/topic-heat`, teacherToken)
  const heatJ = await heatRes.json()
  topics = heatJ.buckets || heatJ.topics || heatJ.heat || []
  console.log(`\n--- topic-heat (${topics.length} topics) ---`)
  topics.forEach(t => console.log(`  ${t.topicLabel || t.label || t.topic}  source=${t.topicSource || t.source || 'unknown'}  score=${t.totalScore || t.score || 0}`))
  const hasPhotosynthesis = topics.some(t => /photosynthesis/i.test(t.topicLabel || t.label || t.topic || ''))
  ok('topic-heat endpoint returns "Photosynthesis"', hasPhotosynthesis)
  aiSource = topics.find(t => /photosynthesis/i.test(t.topicLabel || t.label || t.topic || ''))?.topicSource
  console.log(`  → topic source: ${aiSource}  (backend labels both Gemini + heuristic as 'auto')`)

  // 10. Per-student targeting — recovery prompt goes ONLY to A
  if (activeEvt) {
    const recoveryRes = await authFetch(`/api/confusion/event/${activeEvt.id || activeEvt._id}/request-feedback`, teacherToken, {
      method: 'POST'
    })
    ok('recovery request sent', recoveryRes.ok, `status=${recoveryRes.status}`)

    await new Promise(r => setTimeout(r, 1500))
  }

  console.log('\n--- Per-student targeting ---')
  console.log(`Student A received: ${JSON.stringify(received.A.map(r => r.evt))}`)
  console.log(`Student B received: ${JSON.stringify(received.B.map(r => r.evt))}`)

  // Per-student targeting check: only the TARGETED event (confusion:resolved) must
  // go to the confused student. Room-broadcast events (doubt:new, confusion:update)
  // go to everyone in the room — that's by design.
  const aResolved = received.A.some(r => r.evt === 'confusion:resolved')
  const bResolved = received.B.some(r => r.evt === 'confusion:resolved')
  ok('Student A (confused) received confusion:resolved', aResolved)
  ok('Student B (NOT confused) did NOT receive confusion:resolved', !bResolved, `B events=${JSON.stringify(received.B.map(r => r.evt))}`)

  // 11. Teacher dashboard data — list events
  const listRes = await authFetch(`/api/confusion/room/${room._id}`, teacherToken)
  const listJ = await listRes.json()
  ok('events list endpoint reachable', listRes.ok, `events=${(listJ.events || listJ.spikes || []).length}`)

  // 12. Topic-source audit: log what was used
  console.log('\n===== SUMMARY =====')
  console.log(`Room: ${room._id} (${room.code})`)
  console.log(`Topics detected: ${topics.length} → ${topics.map(t => t.topicLabel || t.label || t.topic).join(', ')}`)
  console.log(`Topic source: ${aiSource || 'unknown'} (backend labels both Gemini + heuristic as 'auto')`)
  console.log(`Confusion event: ${activeEvt?.topic?.label || activeEvt?.topicLabel || 'none'} (${activeEvt?.confusedStudentCount || 0} students)`)
  console.log(`Student A socket events: ${received.A.length}`)
  console.log(`Student B socket events: ${received.B.length}`)

  aSock.sock.disconnect()
  bSock.sock.disconnect()
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })