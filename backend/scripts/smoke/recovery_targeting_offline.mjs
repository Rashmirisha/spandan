/**
 * smoke: recovery_targeting_offline
 *
 * Verifies that when ONE of the two confused students is offline (no socket
 * connected), only the online one receives the prompt. The offline student
 * will see it on reconnect.
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
    const received = { confusion_resolved: [], room_joined: false }
    sock.on('connect', () => {
      sock.emit('room:join', { roomCode: GLOBAL_ROOM_CODE })
    })
    sock.on('room:joined', () => { received.room_joined = true })
    sock.on('confusion:resolved', (p) => {
      console.log(`[${label}] *** RECEIVED confusion:resolved *** expect=${p.expectedRespondents} live=${p.recipientsOnline}`)
      received.confusion_resolved.push(p)
    })
    sock.on('connect_error', reject)
    setTimeout(() => resolve({ sock, received, label }), 1500)
  })
}

async function main () {
  const teacherToken = await login('rashmi@spandan.local')
  const s1Token = await login('student@spandan.local')
  const s2Token = await login('student2@spandan.local')

  // Use the room from the previous test (still has the 2-student event)
  const ROOM_ID = '6a7c763925fe3bff2e5b0566'
  const room = (await (await fetch(`${BASE}/api/rooms`, { headers: { Authorization: `Bearer ${teacherToken}` } })).json()).rooms.find(r => r._id === ROOM_ID)
  GLOBAL_ROOM_CODE = room.code

  const activeRes = await (await fetch(`${BASE}/api/confusion/room/${ROOM_ID}/active`, { headers: { Authorization: `Bearer ${teacherToken}` } })).json()
  const evt = activeRes.active || activeRes.event
  console.log('Active event:', { id: evt.id || evt._id, topic: evt.topic?.label, studentCount: evt.confusedStudentCount })

  console.log('\n--- Connect ONLY student1 (student2 stays offline) ---')
  const s1 = await connectSocket(s1Token, 'student1')

  await new Promise(r => setTimeout(r, 500))
  console.log('\n--- Teacher triggers request-feedback ---')
  const fbRes = await fetch(`${BASE}/api/confusion/event/${evt.id || evt._id}/request-feedback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${teacherToken}` }
  })
  const fb = await fbRes.json()
  console.log('targeting:', JSON.stringify(fb.targeting))

  await new Promise(r => setTimeout(r, 1000))

  const s1Got = s1.received.confusion_resolved.length > 0
  console.log('\n--- ASSERTIONS ---')
  console.log('student1 (online, in event) received =', s1Got)
  console.log('student2 (offline, in event) cannot receive (no socket) - correct')

  let allPassed = true
  if (!s1Got) { console.error('❌ online student did NOT receive (FAIL)'); allPassed = false }
  else console.log('✓ online student received')

  if (fb.targeting.recipientsOnline !== 1) {
    console.error('❌ expected recipientsOnline=1, got', fb.targeting.recipientsOnline, '(FAIL)')
    allPassed = false
  } else {
    console.log('✓ targeting.recipientsOnline=1 (correct: 2 expected, 1 online)')
  }

  if (fb.targeting.expectedRespondents !== 2) {
    console.error('❌ expected expectedRespondents=2, got', fb.targeting.expectedRespondents, '(FAIL)')
    allPassed = false
  } else {
    console.log('✓ expectedRespondents=2 (matches event.confusedStudentCount)')
  }

  s1.sock.disconnect()
  if (!allPassed) { console.error('\n❌ OFFLINE-TARGETING FAILED'); process.exit(1) }
  console.log('\n✓ OFFLINE-TARGETING PASSED')
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })