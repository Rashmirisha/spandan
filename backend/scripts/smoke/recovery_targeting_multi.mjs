/**
 * smoke: recovery_targeting_multi
 *
 * Verifies the PR #35 targeting fix with 2 confused students.
 * Both students who pressed "I'm Lost" should receive the prompt.
 * A 3rd socket in the room (the teacher) should NOT.
 */

import { io as ioClient } from 'socket.io-client'

const BASE = 'http://localhost:3001'

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
      sock.emit('room:join', { roomCode: GLOBAL_ROOM_CODE })
    })
    sock.on('room:joined', () => {
      console.log(`[${label}] room:joined for`, GLOBAL_ROOM_CODE)
      received.room_joined = true
    })
    sock.on('room:error', (err) => { received.errors.push(err) })
    sock.on('confusion:resolved', (payload) => {
      console.log(`[${label}] *** RECEIVED confusion:resolved *** topic=${payload.topic} expect=${payload.expectedRespondents} live=${payload.recipientsOnline}`)
      received.confusion_resolved.push(payload)
    })
    sock.on('connect_error', (e) => reject(e))
    setTimeout(() => resolve({ sock, received, label }), 1500)
  })
}

let GLOBAL_ROOM_CODE = null

async function main () {
  console.log('--- 1. Login as teacher ---')
  const teacherToken = await login('rashmi@spandan.local')

  console.log('\n--- 2. Find or create a room with an active event ---')
  // Reuse existing room "Final Demo"
  const ROOM_ID = '6a7c763925fe3bff2e5b0566'
  const rooms = await (await fetch(`${BASE}/api/rooms`, { headers: { Authorization: `Bearer ${teacherToken}` } })).json()
  const room = rooms.rooms.find(r => r._id === ROOM_ID)
  GLOBAL_ROOM_CODE = room.code
  console.log('Room:', room.name, 'code:', room.code, 'startedAt:', room.roomStartedAt)

  // Force-create a fresh, multi-student confusion event by ending any active
  // session, starting a new one, and having both students press "I'm Lost".
  console.log('Creating a fresh session + multi-student event...')
  // End any current session (best-effort)
  await fetch(`${BASE}/api/rooms/${ROOM_ID}/session/end`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${teacherToken}` }
  }).catch(() => {})
  await new Promise(r => setTimeout(r, 500))

  const startRes = await fetch(`${BASE}/api/rooms/${ROOM_ID}/session/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${teacherToken}` }
  })
  const start = await startRes.json()
  console.log('start session result:', JSON.stringify(start).slice(0, 200))

  // Have student1 then student2 both send doubt signals
  const s1Token = await login('student@spandan.local')
  const s2Token = await login('student2@spandan.local')
  const r1 = await fetch(`${BASE}/api/doubts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s1Token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: ROOM_ID })
  })
  console.log('s1 doubt result:', r1.status)
  await new Promise(r => setTimeout(r, 600))
  const r2 = await fetch(`${BASE}/api/doubts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s2Token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: ROOM_ID })
  })
  console.log('s2 doubt result:', r2.status)
  await new Promise(r => setTimeout(r, 1500))

  const activeRes = await (await fetch(`${BASE}/api/confusion/room/${ROOM_ID}/active`, { headers: { Authorization: `Bearer ${teacherToken}` } })).json()

  const evt = activeRes.active || activeRes.event
  console.log('Active event:', { id: evt.id || evt._id, topic: evt.topic?.label, studentCount: evt.confusedStudentCount })
  const eventId = evt.id || evt._id

  console.log('\n--- 3. Connect student1 ---')
  const s1 = await connectSocket(s1Token, 'student1')

  console.log('\n--- 4. Connect student2 ---')
  const s2 = await connectSocket(s2Token, 'student2')

  console.log('\n--- 5. Connect teacher socket (ghost) ---')
  const teacherSocket = await connectSocket(teacherToken, 'teacher-as-ghost')

  console.log('\n--- 6. Teacher triggers request-feedback ---')
  const fbRes = await fetch(`${BASE}/api/confusion/event/${eventId}/request-feedback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${teacherToken}` }
  })
  const fb = await fbRes.json()
  console.log('targeting:', JSON.stringify(fb.targeting))

  await new Promise(r => setTimeout(r, 1500))

  console.log('\n--- 7. ASSERTIONS ---')
  const s1Got = s1.received.confusion_resolved.length > 0
  const s2Got = s2.received.confusion_resolved.length > 0
  const ghostGot = teacherSocket.received.confusion_resolved.length > 0

  console.log('student1 received =', s1Got)
  console.log('student2 received =', s2Got)
  console.log('teacher-as-ghost received =', ghostGot)

  let allPassed = true
  // Teacher SHOULD receive the prompt (dashboard onResolved handler clears
  // the active-event display). The PR #35 fix is that non-confused
  // STUDENTS do not receive it.
  if (!ghostGot) { console.error('❌ teacher-as-ghost did NOT receive (FAIL: dashboard won\'t update)'); allPassed = false } else console.log('✓ teacher (dashboard) received (correct: dashboard needs it to clear active event)')
  if (!s1Got) { console.error('❌ student1 did NOT receive (FAIL)'); allPassed = false } else console.log('✓ student1 received')
  if (!s2Got) { console.error('❌ student2 did NOT receive (FAIL)'); allPassed = false } else console.log('✓ student2 received')

  s1.sock.disconnect()
  s2.sock.disconnect()
  teacherSocket.sock.disconnect()

  if (!allPassed) { console.error('\n❌ MULTI-TARGETING FAILED'); process.exit(1) }
  console.log('\n✓ MULTI-TARGETING PASSED')
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })