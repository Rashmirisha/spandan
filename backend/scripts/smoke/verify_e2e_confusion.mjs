// End-to-end confusion lifecycle test:
// 1. Student1 clicks I'm Lost -> confusion:update emitted, count=1
// 2. Verify /api/confusion/room/:id/active returns count=1 (active=true)
// 3. Student2 clicks I'm Lost -> confusion:update merged, count=2
// 4. Verify active count=2, KPI /active reflects it
// 5. Teacher clicks "Mark Resolved" -> event status=closed
// 6. Verify active is empty, history shows the closed event
// 7. Verify confusion:closed was emitted to socket
// 8. Verify a fresh student click after resolve creates a NEW event
import { io as socketClient } from 'socket.io-client'

const PROXY = 'http://localhost:3001'
async function jget(p, t) { const r = await fetch(`${PROXY}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} }); return { status: r.status, body: await r.json() } }
async function jpost(p, b, t) { const r = await fetch(`${PROXY}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() } }
const log = (...a) => console.log('[T]', ...a)
const fail = (msg) => { console.log('FATAL:', msg); process.exit(1) }

async function login(email) { const r = await jpost('/api/auth/login', { email, password: 'Test1234!' }); if (r.status !== 200) fail(`login ${email}`); return r.body.token }

const teacherToken = await login('rashmi@spandan.local')
const student1Token = await login('student@spandan.local')
const student2Token = await login('student2@spandan.local')

// Find or create a fresh room for this test
const { body: roomsBody } = await jget('/api/rooms', teacherToken)
let room = roomsBody.rooms.find(r => !r.endedAt)
if (!room) { fail('no active room found') }
log('using room', room._id, room.code)

// Start session (idempotent)
await jpost(`/api/rooms/${room._id}/start`, {}, teacherToken)

// Resolve any existing active event first so we start clean.
// This is a multi-run smoke; without this, prior test runs leave the
// event populated and our `count === 1` strict checks fail.
const preActive = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
if (preActive.body?.event?.id) {
  log('clearing prior active event', preActive.body.event.id, 'count', preActive.body.event.confusedStudentCount)
  await jpost(`/api/confusion/event/${preActive.body.event.id}/resolve`, {}, teacherToken)
  await new Promise(r => setTimeout(r, 400))
}
const preCount = 0 // after clearing

// 30-second anti-spam cooldown for prior student signals — wait it out
// so the script is repeatable across runs.
log('waiting 31s for anti-spam cooldown to expire...')
await new Promise(r => setTimeout(r, 31000))

// Connect authenticated socket
const sock = socketClient(PROXY, {
  auth: { token: teacherToken },
  transports: ['polling'],
  reconnection: false
})
const socketEvents = []
await new Promise(resolve => sock.on('connect', resolve))
sock.emit('room:join', { roomCode: room.code })
sock.on('confusion:update', d => socketEvents.push({ event: 'update', action: d.action, eventId: d.event?.id, count: d.event?.confusedStudentCount, topic: d.event?.topic?.label }))
sock.on('confusion:closed', d => socketEvents.push({ event: 'closed', eventId: d.eventId, reason: d.reason }))
await new Promise(r => setTimeout(r, 500))
log('socket joined room', room.code)

// Wait for any prior cooldown to expire (30s anti-spam window)
// Skip for tests by tracking time; we use different students so they should be fresh.

log('--- STAGE 1: student1 clicks I\'m Lost ---')
const s1 = await jpost('/api/doubts', { roomId: room._id, segmentIndex: 100 }, student1Token)
if (!s1.body?.signal?.id) fail(`student1 doubt failed: ${JSON.stringify(s1)}`)
log('  ok signal id', s1.body.signal.id)
await new Promise(r => setTimeout(r, 800))

const a1 = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
if (!a1.body?.event || a1.body.event.confusedStudentCount !== preCount + 1) fail(`stage1 active wrong: ${JSON.stringify(a1.body)}`)
const eventId1 = a1.body.event.id
log('  active event id', eventId1, 'count=' + a1.body.event.confusedStudentCount, '✅')

log('--- STAGE 2: student2 clicks I\'m Lost ---')
const s2 = await jpost('/api/doubts', { roomId: room._id, segmentIndex: 100 }, student2Token)
if (!s2.body?.signal?.id) fail(`student2 doubt failed: ${JSON.stringify(s2)}`)
log('  ok signal id', s2.body.signal.id)
await new Promise(r => setTimeout(r, 800))

const a2 = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
if (!a2.body?.event || a2.body.event.confusedStudentCount !== preCount + 2) fail(`stage2 active wrong: ${JSON.stringify(a2.body)}`)
log('  active count=' + a2.body.event.confusedStudentCount, '✅')

const eventId2 = a2.body.event.id
if (eventId1 !== eventId2) fail(`merge failed: ${eventId1} != ${eventId2}`)
log('  merged into same event ✅')

log('--- STAGE 3: teacher Mark Resolved ---')
const t1 = Date.now()
const res = await jpost(`/api/confusion/event/${eventId2}/resolve`, {}, teacherToken)
if (!res.body?.success || res.body.event.status !== 'closed') fail(`resolve wrong: ${JSON.stringify(res.body)}`)
log('  closed in', Date.now() - t1, 'ms ✅')

await new Promise(r => setTimeout(r, 800))

log('--- STAGE 4: verify active empty + history updated ---')
const a3 = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
if (a3.body?.event) fail(`active still has event: ${JSON.stringify(a3.body)}`)
log('  active is empty ✅')

const hist = await jget(`/api/confusion/room/${room._id}?limit=20`, teacherToken)
const found = hist.body?.events?.find(e => (e.id || e._id) === eventId2)
if (!found || found.status !== 'closed') fail(`history missing closed event: ${JSON.stringify(hist.body?.events?.slice(0, 3))}`)
log('  history shows closed event ✅')

log('--- STAGE 5: verify socket emissions ---')
const updates = socketEvents.filter(e => e.event === 'update')
const closes = socketEvents.filter(e => e.event === 'closed' && e.eventId === eventId2)
if (updates.length < 1) fail(`no confusion:update emitted: ${JSON.stringify(socketEvents)}`)
if (closes.length !== 1) fail(`missing/duplicate confusion:closed: ${JSON.stringify(socketEvents)}`)
log('  update events:', updates.length, '(expect >=1) ✅')
log('  closed events:', closes.length, '(expect 1) ✅')
log('  socket log:', JSON.stringify(socketEvents))

log('--- STAGE 6: fresh student click after resolve ---')
await new Promise(r => setTimeout(r, 1000))
const s3 = await jpost('/api/doubts', { roomId: room._id, segmentIndex: 200 }, student1Token)
if (!s3.body?.signal?.id) fail(`student1 second doubt failed (cooldown?): ${JSON.stringify(s3)}`)
log('  ok new signal id', s3.body.signal.id)
await new Promise(r => setTimeout(r, 800))
const a4 = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
if (!a4.body?.event) fail(`no new active event after resolve: ${JSON.stringify(a4.body)}`)
log('  new active event id', a4.body.event.id, '✅')

sock.disconnect()
log('ALL E2E CHECKS PASSED ✅')
process.exit(0)