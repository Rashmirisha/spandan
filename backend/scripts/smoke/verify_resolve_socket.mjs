// Verify that /resolve emits confusion:closed via socket
import { io as socketClient } from 'socket.io-client'

const PROXY = 'http://localhost:3001'
async function jget(p, t) { const r = await fetch(`${PROXY}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} }); return { status: r.status, body: await r.json() } }
async function jpost(p, b, t) { const r = await fetch(`${PROXY}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() } }
const log = (...a) => console.log('[T]', ...a)

async function login(email) { const r = await jpost('/api/auth/login', { email, password: 'Test1234!' }); return r.body.token }

// 1. Login teacher + find room
const teacherToken = await login('rashmi@spandan.local')
const studentToken = await login('student2@spandan.local')
const { body: roomsBody } = await jget('/api/rooms', teacherToken)
const room = roomsBody.rooms.find(r => !r.endedAt)
log('room', room._id, room.code)

// 2. Connect socket (direct to backend, polling only — no proxy)
const sock = socketClient(PROXY, {
  auth: { token: teacherToken }, // must auth at handshake so room:join works
  transports: ['polling'],
  reconnection: false
})
await new Promise(resolve => sock.on('connect', resolve))
log('socket connected', sock.id)
sock.emit('room:join', { roomCode: room.code })
await new Promise(r => setTimeout(r, 500))

const socketEvents = []
sock.on('confusion:update', d => socketEvents.push({ name: 'confusion:update', action: d.action, eventId: d.event?.id, count: d.event?.confusedStudentCount }))
sock.on('confusion:closed', d => socketEvents.push({ name: 'confusion:closed', reason: d.reason, eventId: d.eventId }))

// 3. Student triggers doubt
log('student POST /api/doubts')
await jpost('/api/doubts', { roomId: room._id, segmentIndex: Date.now() % 1000 }, studentToken)
await new Promise(r => setTimeout(r, 1500))

const active = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
const eventId = active.body?.event?.id
log('active event id', eventId)

// 4. Teacher POSTs /resolve
log('teacher POST /resolve')
const res = await jpost(`/api/confusion/event/${eventId}/resolve`, {}, teacherToken)
log('resolve status', res.status, 'event.status:', res.body?.event?.status)

await new Promise(r => setTimeout(r, 1000))

log('socket events received:', socketEvents.length)
for (const e of socketEvents) log('  -', e.name, JSON.stringify({ action: e.action, reason: e.reason, eventId: e.eventId, count: e.count }))

const closed = socketEvents.find(e => e.name === 'confusion:closed' && e.eventId === eventId)
if (!closed) { log('FATAL: no confusion:closed emitted'); process.exit(1) }
log('OK: confusion:closed emitted')

sock.disconnect()
process.exit(0)