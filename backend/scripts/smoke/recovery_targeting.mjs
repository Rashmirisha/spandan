/**
 * smoke: recovery_targeting
 *
 * Verifies PR #35 fix: the recovery "Did this help?" prompt must be sent
 * ONLY to the sockets whose studentHash matches the event's studentIds.
 *
 * Procedure:
 *  1. Login as teacher
 *  2. Use the existing "Final Demo" room (id 6a7c763925fe3bff2e5b0566)
 *  3. Pick the active confusion event
 *  4. Connect two SOCKET.IO clients (student1 + student2) and join the room
 *  5. Connect one socket for a "ghost" student (no signal but in room)
 *  6. Capture the 'confusion:resolved' event on each socket
 *  7. Teacher POSTs /request-feedback
 *  8. Assert:
 *     - Only sockets whose userId hashes to event.studentIds receive the prompt
 *     - Ghost student does NOT receive the prompt
 *     - Student who did NOT press "I'm Lost" does NOT receive the prompt
 */

import { io as ioClient } from 'socket.io-client'

const BASE = 'http://localhost:3001'
const ROOM_ID = '6a7c763925fe3bff2e5b0566'

// Look up the actual room code via the API
async function fetchRoomCode () {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rashmi@spandan.local', password: 'Test1234!' })
  })
  const { token } = await login.json()
  const rooms = await (await fetch(`${BASE}/api/rooms`, { headers: { Authorization: `Bearer ${token}` } })).json()
  const room = rooms.rooms?.find(r => r._id === ROOM_ID)
  if (!room?.code) throw new Error(`Room ${ROOM_ID} not found`)
  return { token, code: room.code, room }
}

const { token: _initToken, code: ROOM_CODE } = await fetchRoomCode()

async function login (email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!' })
  })
  const j = await r.json()
  if (!j.token) throw new Error(`login failed for ${email}: ${JSON.stringify(j)}`)
  return j.token
}

async function fetchActiveEvent (token) {
  const r = await fetch(`${BASE}/api/confusion/room/${ROOM_ID}/active`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const j = await r.json()
  if (!j.event) throw new Error('No active event in target room')
  return j.event
}

function connectSocket (token, label) {
  return new Promise((resolve, reject) => {
    const sock = ioClient(BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: false
    })
    const received = { confusion_resolved: [], room_joined: false, errors: [] }
    sock.on('connect', () => {
      console.log(`[${label}] socket connected:`, sock.id)
      sock.emit('room:join', { roomCode: ROOM_CODE })
    })
    sock.on('room:joined', () => {
      console.log(`[${label}] room:joined for`, ROOM_CODE)
      received.room_joined = true
    })
    sock.on('room:error', (err) => {
      console.log(`[${label}] room:error`, err)
      received.errors.push(err)
    })
    sock.on('confusion:resolved', (payload) => {
      console.log(`[${label}] *** RECEIVED confusion:resolved ***`, JSON.stringify(payload))
      received.confusion_resolved.push(payload)
    })
    sock.on('connect_error', (e) => {
      console.log(`[${label}] connect_error:`, e.message)
      reject(e)
    })
    sock.on('authenticated', (msg) => {
      console.log(`[${label}] authenticated:`, JSON.stringify(msg))
    })
    // wait a tick for room:join to land
    setTimeout(() => resolve({ sock, received, label }), 1500)
  })
}

async function main () {
  console.log('--- 1. Login as teacher ---')
  const teacherToken = await login('rashmi@spandan.local')
  console.log('Teacher token prefix:', teacherToken.slice(0, 30))

  console.log('\n--- 2. Pick active confusion event ---')
  const evt = await fetchActiveEvent(teacherToken)
  console.log('Active event:', { id: evt.id, _id: evt._id, topic: evt.topic?.label, confusedStudentCount: evt.confusedStudentCount })
  const eventId = evt.id || evt._id

  console.log('\n--- 3. Connect student1 (had pressed I\'m Lost, hash in event) ---')
  const student1Token = await login('student@spandan.local')
  const s1 = await connectSocket(student1Token, 'student1')

  console.log('\n--- 4. Connect student2 (joined the room but NOT in event.studentIds) ---')
  // We need a "ghost" student who joined the room but whose hash is NOT in
  // event.studentIds. The teacher token is the simplest: a teacher has a
  // userId but never creates DoubtSignals, so their hash is never in
  // event.studentIds. (socket.data.userId will be set to the teacher\'s id.)
  const teacherSocket = await connectSocket(teacherToken, 'teacher-as-ghost')

  // Sanity: both sockets should have actually joined the room.
  if (!s1.received.room_joined) console.error('!! student1 did NOT actually join the room — test is invalid')
  if (!teacherSocket.received.room_joined) console.error('!! teacher-as-ghost did NOT actually join the room — test is invalid')
  if (!s1.received.room_joined || !teacherSocket.received.room_joined) {
    console.error('Aborting: socket setup failed')
    process.exit(2)
  }

  console.log('\n--- 5. Teacher triggers request-feedback ---')
  const fbRes = await fetch(`${BASE}/api/confusion/event/${eventId}/request-feedback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${teacherToken}` }
  })
  const fb = await fbRes.json()
  console.log('request-feedback response (truncated):', JSON.stringify({
    success: fb.success,
    targeting: fb.targeting,
    event_topic: fb.event?.topic?.label,
    event_studentCount: fb.event?.confusedStudentCount
  }, null, 2))

  // Allow a moment for the socket events to propagate
  await new Promise(r => setTimeout(r, 1500))

  console.log('\n--- 6. ASSERTIONS ---')
  const s1Received = s1.received.confusion_resolved.length > 0
  const ghostReceived = teacherSocket.received.confusion_resolved.length > 0

  console.log('student1 (pressed I\'m Lost, hash in event): received =', s1Received)
  console.log('teacher-as-ghost (NEVER pressed I\'m Lost, hash NOT in event): received =', ghostReceived)

  let allPassed = true

  if (ghostReceived) {
    console.error('❌ FAIL: teacher-as-ghost (who never pressed I\'m Lost) received the prompt')
    allPassed = false
  } else {
    console.log('✓ ghost did NOT receive the prompt (correct)')
  }

  if (!s1Received) {
    console.error('❌ FAIL: student1 (who pressed I\'m Lost) did NOT receive the prompt')
    allPassed = false
  } else {
    console.log('✓ student1 (the only student in event.studentIds) received the prompt (correct)')
  }

  // Cleanup
  s1.sock.disconnect()
  teacherSocket.sock.disconnect()

  if (!allPassed) {
    console.error('\n❌ TEST FAILED')
    process.exit(1)
  }
  console.log('\n✓ TARGETING TEST PASSED')
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})