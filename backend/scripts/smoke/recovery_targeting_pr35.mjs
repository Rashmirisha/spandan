/**
 * smoke: recovery_targeting_pr35
 *
 * Comprehensive PR #35 verification.
 *
 * Setup: 4 sockets in the room:
 *   - student1: pressed I'm Lost, hash in event.studentIds → MUST receive
 *   - student2: pressed I'm Lost, hash in event.studentIds → MUST receive
 *   - student3 (ghost): did NOT press I'm Lost, hash NOT in event → MUST NOT receive
 *   - teacher: dashboard → MUST receive (so it can clear active display)
 *
 * Verifies:
 *   1. student1 receives confusion:resolved exactly once (not double-delivered)
 *   2. student2 receives confusion:resolved exactly once
 *   3. student3 (ghost) does NOT receive
 *   4. teacher receives (dashboard update path)
 */

import { io as ioClient } from 'socket.io-client'

const BASE = 'http://localhost:3001'

async function login (email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!' })
  })
  return (await r.json()).token
}

let GLOBAL_ROOM_CODE = null
function connectSocket (token, label) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: false
    })
    const received = { confusion_resolved_count: 0, last_payload: null, room_joined: false }
    sock.on('connect', () => sock.emit('room:join', { roomCode: GLOBAL_ROOM_CODE }))
    sock.on('room:joined', () => { received.room_joined = true })
    sock.on('confusion:resolved', (p) => {
      received.confusion_resolved_count += 1
      received.last_payload = p
      console.log(`[${label}] received confusion:resolved #${received.confusion_resolved_count} topic=${p.topic} expect=${p.expectedRespondents} live=${p.recipientsOnline}`)
    })
    sock.on('connect_error', reject)
    setTimeout(() => resolve({ sock, received, label }), 1500)
  })
}

async function main () {
  const teacherToken = await login('rashmi@spandan.local')

  const ROOM_ID = '6a7c763925fe3bff2e5b0566'
  const room = (await (await fetch(`${BASE}/api/rooms`, { headers: { Authorization: `Bearer ${teacherToken}` } })).json()).rooms.find(r => r._id === ROOM_ID)
  GLOBAL_ROOM_CODE = room.code

  // Get the active event. The previous test left one with 2 students.
  let activeRes = await (await fetch(`${BASE}/api/confusion/room/${ROOM_ID}/active`, { headers: { Authorization: `Bearer ${teacherToken}` } })).json()
  let evt = activeRes.active || activeRes.event
  if (!evt) throw new Error('No active event — run recovery_targeting_multi.mjs first to create one')
  console.log('Active event:', { id: evt.id || evt._id, topic: evt.topic?.label, studentCount: evt.confusedStudentCount })

  const s1Token = await login('student@spandan.local')
  const s2Token = await login('student2@spandan.local')
  const s3Token = await login('test@spandan.local') // not a confused student — different role entirely

  console.log('\n--- Connect all 4 sockets ---')
  const s1 = await connectSocket(s1Token, 'student1-confused')
  const s2 = await connectSocket(s2Token, 'student2-confused')
  const s3 = await connectSocket(s3Token, 'student3-ghost-not-confused')
  const teacher = await connectSocket(teacherToken, 'teacher-dashboard')

  await new Promise(r => setTimeout(r, 800))

  console.log('\n--- Teacher triggers request-feedback ---')
  const fbRes = await fetch(`${BASE}/api/confusion/event/${evt.id || evt._id}/request-feedback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${teacherToken}` }
  })
  const fb = await fbRes.json()
  console.log('API response targeting:', JSON.stringify(fb.targeting))

  await new Promise(r => setTimeout(r, 1500))

  console.log('\n--- ASSERTIONS (PR #35 fix) ---')
  let ok = true

  // student1: should receive exactly once
  if (s1.received.confusion_resolved_count !== 1) {
    console.error(`❌ student1 received ${s1.received.confusion_resolved_count}x (expected 1)`); ok = false
  } else console.log('✓ student1 received exactly once')

  // student2: should receive exactly once
  if (s2.received.confusion_resolved_count !== 1) {
    console.error(`❌ student2 received ${s2.received.confusion_resolved_count}x (expected 1)`); ok = false
  } else console.log('✓ student2 received exactly once')

  // student3 (ghost, NOT in event): MUST NOT receive
  if (s3.received.confusion_resolved_count !== 0) {
    console.error(`❌ student3 (ghost, NOT in event) received ${s3.received.confusion_resolved_count}x (expected 0 — PR #35 fix)`); ok = false
  } else console.log('✓ student3 (ghost) did NOT receive (PR #35 fix)')

  // teacher: should receive (dashboard update path)
  if (teacher.received.confusion_resolved_count !== 1) {
    console.error(`❌ teacher received ${teacher.received.confusion_resolved_count}x (expected 1, dashboard needs it)`); ok = false
  } else console.log('✓ teacher received (dashboard update)')

  // API targeting field check
  if (fb.targeting.expectedRespondents !== 2) {
    console.error(`❌ expectedRespondents=${fb.targeting.expectedRespondents} (expected 2)`); ok = false
  } else console.log('✓ API targeting.expectedRespondents=2')

  if (fb.targeting.recipientsOnline !== 2) {
    console.error(`❌ recipientsOnline=${fb.targeting.recipientsOnline} (expected 2)`); ok = false
  } else console.log('✓ API targeting.recipientsOnline=2 (both confused students online)')

  s1.sock.disconnect(); s2.sock.disconnect(); s3.sock.disconnect(); teacher.sock.disconnect()

  if (!ok) { console.error('\n❌ PR #35 TARGETING TEST FAILED'); process.exit(1) }
  console.log('\n✓ PR #35 TARGETING TEST PASSED — recovery prompt is sent only to the students who pressed I\'m Lost.')
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })