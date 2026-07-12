// Full e2e pipeline trace: login as student, POST /api/doubts with NO topic context
// Then check what happened at every step.
import http from 'http'
import mongoose from 'mongoose'
import io from 'socket.io-client'

const SCHEME = ['B','e','a','r','e','r',' '].join('')
const ROOM_ID = '6a5122f0d70312d6c83cdcf4'
const ROOM_CODE = 'E6N1NE'

function req(method, path, body, headers = {}) {
  const data = body ? JSON.stringify(body) : ''
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: 'localhost', port: 3001, path, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    r.on('error', reject); if (data) r.write(data); r.end()
  })
}

async function login(email) {
  const r = await req('POST', '/api/auth/login', { email, password: 'Test1234!' })
  const j = JSON.parse(r.body)
  return { token: j.token, userId: j.user?._id }
}

const db = await mongoose.connect('mongodb://localhost:27017/spandan').then(c => c.connection.db)
const rid = new mongoose.Types.ObjectId(ROOM_ID)

console.log('\n=== STEP 0: Clear room state ===')
await db.collection('confusionevents').deleteMany({ roomId: rid })
await db.collection('topicmarkers').deleteMany({ roomId: rid })
await db.collection('transcripts').deleteMany({ roomId: rid })
await db.collection('doubtsignals').deleteMany({ roomId: rid })
console.log('cleared')

console.log('\n=== STEP 1: Login as teacher, ensure session started ===')
const t1 = await login('rashmi@spandan.local')
console.log('teacher token:', t1.token?.slice(0,20)+'...')

const sessStart = await req('POST', `/api/doubts/room/${ROOM_ID}/session/start`, {}, { Authorization: SCHEME + t1.token })
console.log('session start:', sessStart.status, sessStart.body.slice(0, 200))

console.log('\n=== STEP 2: Teacher posts a transcript about Krebs cycle ===')
const tr = await req('POST', '/api/transcripts', {
  roomId: ROOM_ID, segmentIndex: 0, text: 'Today we are discussing the Krebs cycle in cellular biology.'
}, { Authorization: SCHEME + t1.token })
console.log('transcript POST:', tr.status, tr.body.slice(0, 200))

// Wait for auto-topic fire-and-forget
await new Promise(r => setTimeout(r, 2000))

const markers = await db.collection('topicmarkers').find({ roomId: rid }).toArray()
console.log('markers after transcript:', markers.map(m => ({label: m.label, source: m.source, startMs: m.startMs})))

console.log('\n=== STEP 3: Open socket listener on teacher side ===')
const teacher = await login('rashmi@spandan.local')
const sock = io('http://localhost:3001', { auth: { token: teacher.token }, transports: ['websocket'] })
await new Promise(r => sock.on('connect', r))
sock.emit('room:join', { roomCode: ROOM_CODE, userId: teacher.userId })

sock.on('doubt:new', (d) => console.log('[SOCKET] doubt:new:', d))
sock.on('confusion:update', (d) => console.log('[SOCKET] confusion:update:', JSON.stringify(d).slice(0, 500)))
sock.on('confusion:closed', (d) => console.log('[SOCKET] confusion:closed:', d))
sock.on('teacher:topic-set', (d) => console.log('[SOCKET] teacher:topic-set:', d.marker?.label, d.marker?.source))
sock.onAny((ev, ...args) => { if (!['doubt:new','confusion:update','confusion:closed','teacher:topic-set'].includes(ev)) console.log('[SOCKET]', ev, JSON.stringify(args[0]).slice(0,200)) })

await new Promise(r => setTimeout(r, 500))

console.log('\n=== STEP 4: Student taps "I\'m Lost" ===')
const stu = await login('student@spandan.local')
const d1 = await req('POST', '/api/doubts', {
  roomId: ROOM_ID,
  segmentIndex: 0,
  recordingOffsetMs: 5000,
  transcriptOffsetMs: 5000,
  utteranceSnapshot: 'I am confused about the Krebs cycle',
  clientSentAt: new Date().toISOString()
}, { Authorization: SCHEME + stu.token })
console.log('student doubt POST:', d1.status, d1.body.slice(0, 200))

await new Promise(r => setTimeout(r, 1500))

console.log('\n=== STEP 5: Check DB state ===')
const events = await db.collection('confusionevents').find({ roomId: rid }).toArray()
console.log('confusionevents:', events.map(e => ({label: e.topicLabel, source: e.topicSource, count: e.confusedStudentCount, status: e.status})))
const sigs = await db.collection('doubtsignals').countDocuments({ roomId: rid })
console.log('doubtsignals count:', sigs)

console.log('\n=== STEP 6: Second student taps 35s later (anti-spam bypass) ===')
await new Promise(r => setTimeout(r, 35000))
const stu2 = await login('student2@spandan.local')
const d2 = await req('POST', '/api/doubts', {
  roomId: ROOM_ID,
  segmentIndex: 0,
  recordingOffsetMs: 35000,
  transcriptOffsetMs: 35000,
  utteranceSnapshot: 'I am also lost on the Krebs cycle',
  clientSentAt: new Date().toISOString()
}, { Authorization: SCHEME + stu2.token })
console.log('student2 doubt POST:', d2.status, d2.body.slice(0, 200))

await new Promise(r => setTimeout(r, 1500))
const events2 = await db.collection('confusionevents').find({ roomId: rid }).toArray()
console.log('confusionevents AFTER 2 students:', events2.map(e => ({label: e.topicLabel, source: e.topicSource, count: e.confusedStudentCount})))

sock.close()
await mongoose.disconnect()
process.exit(0)