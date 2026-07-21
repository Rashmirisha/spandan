// Trace the full live-lecture pipeline:
// 1. Login as teacher
// 2. Find/create a room
// 3. Start session
// 4. Submit a fake transcript (simulating what the teacher recording does)
// 5. Verify it was saved
// 6. Verify a topic marker was created and emitted via socket
// 7. Verify confusion API sees the data

import { io as socketClient } from 'socket.io-client'

const BASE = 'http://localhost:5173/spandan'

async function jget(path, token) {
  const r = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  return { status: r.status, body: await r.json() }
}
async function jpost(path, body, token) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  return { status: r.status, body: await r.json() }
}

async function login(email) {
  const r = await jpost('/api/auth/login', { email, password: 'Test1234!' })
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`)
  return r.body.token
}

const tlog = (...args) => console.log('[TEST]', ...args)

async function main() {
  tlog('1. login teacher')
  const teacherToken = await login('rashmi@spandan.local')
  tlog('  OK')

  tlog('2. find/create a room')
  const r = await jget('/api/rooms', teacherToken)
  let room = r.body.rooms.find(x => !x.endedAt)
  if (!room) {
    const created = await jpost('/api/rooms', { name: 'Live Lecture Test', settings: { segmentTime: 2 } }, teacherToken)
    room = created.body.room
    tlog('  created new room', room._id)
  } else {
    tlog('  using existing room', room._id, room.name)
  }

  tlog('3. start the session')
  const start = await jpost(`/api/rooms/${room._id}/start`, {}, teacherToken)
  tlog('  status:', start.status, 'roomStartedAt:', start.body.room?.roomStartedAt)

  // Wait 1s to let socket subscriptions settle
  await new Promise(r => setTimeout(r, 800))

  tlog('4. listen on teacher:topic-set via socket')
  let topicMarkerEmitted = null
  const sock = socketClient('http://localhost:3001', {
    query: { roomCode: room.code },
    transports: ['websocket', 'polling']
  })
  await new Promise(resolve => {
    sock.on('connect', resolve)
  })
  sock.on('teacher:topic-set', (data) => {
    topicMarkerEmitted = data?.marker || data
    tlog('  SOCKET: teacher:topic-set', JSON.stringify(topicMarkerEmitted).slice(0, 200))
  })
  tlog('  socket connected:', sock.id)

  tlog('5. submit a transcript (simulating teacher recording)')
  const transcript = await jpost('/api/transcripts', {
    roomId: room._id,
    segmentIndex: Date.now() % 1000,
    text: 'Today we are going to discuss photosynthesis. Photosynthesis is the process by which plants convert sunlight into energy. The chloroplast is the organelle where this happens. Chlorophyll absorbs red and blue light most strongly.',
    duration: 30,
    wordCount: 35
  }, teacherToken)
  tlog('  status:', transcript.status, 'transcript id:', transcript.body.transcript?._id)

  // Wait for fire-and-forget topic generation
  await new Promise(r => setTimeout(r, 3000))

  tlog('6. fetch transcripts back')
  const transcripts = await jget(`/api/transcripts/room/${room._id}`, teacherToken)
  tlog('  count:', transcripts.body.transcripts?.length)
  if (transcripts.body.transcripts?.length) {
    tlog('  latest:', JSON.stringify(transcripts.body.transcripts[transcripts.body.transcripts.length - 1]).slice(0, 200))
  }

  tlog('7. fetch topic markers for room')
  const topics = await jget(`/api/topics/room/${room._id}`, teacherToken)
  tlog('  status:', topics.status, 'body:', JSON.stringify(topics.body).slice(0, 300))

  tlog('8. socket emitted topicMarker:', topicMarkerEmitted ? 'YES' : 'NO')
  sock.disconnect()
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })