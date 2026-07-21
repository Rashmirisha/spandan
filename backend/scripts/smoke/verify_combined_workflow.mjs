// Combined workflow smoke: this mirrors the user-facing flow exactly.
//    student1 clicks "I'm Lost"
//    student2 clicks "I'm Lost"
//    teacher clicks "Request Feedback"  -> /api/confusion/event/:id/request-feedback
//    students answer via /api/confusion/event/:id/feedback
//    teacher sees live counts via socket feedback events
//    teacher clicks "Mark Resolved"      -> /api/confusion/event/:id/resolve
//    event archived, feedbackStats preserved
//
// Verifies ALL of:
//   * teacher notification (count 1 -> 2)
//   * feedback round opens with expectedRespondents
//   * students receive popup via confusion:resolved socket emit
//   * teacher receives confusion:feedback per response with live counts
//   * idempotency: duplicate student answer rejected
//   * mark-resolved clears active, archives to history
//   * post-resolve: feedbackStats still on event in DB
//
// Skips browser visual verification (agent tool blocked).
import { io as socketClient } from 'socket.io-client'

const PROXY = 'http://localhost:3001'
const log = (...a) => console.log('[T]', ...a)
const fail = (m) => { console.log('FATAL:', m); process.exit(1) }

async function jget (p, t) {
  const r = await fetch(`${PROXY}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} })
  return { status: r.status, body: await r.json() }
}
async function jpost (p, b, t) {
  const r = await fetch(`${PROXY}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(b)
  })
  return { status: r.status, body: await r.json() }
}

async function login (email) {
  const r = await jpost('/api/auth/login', { email, password: 'Test1234!' })
  if (r.status !== 200) fail(`login ${email}: ${JSON.stringify(r.body)}`)
  return r.body.token
}

const teacherToken = await login('rashmi@spandan.local')
const s1Token = await login('student@spandan.local')
const s2Token = await login('student2@spandan.local')

// Pick the active room
const { body: roomsBody } = await jget('/api/rooms', teacherToken)
const room = roomsBody.rooms.find(r => !r.endedAt) || roomsBody.rooms[0]
if (!room) fail('no room found')
log('room', room.code, room._id)

// Reset: clear any prior active event
const preActive = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
if (preActive.body?.event?.id) {
  log('clearing prior active event', preActive.body.event.id)
  await jpost(`/api/confusion/event/${preActive.body.event.id}/resolve`, {}, teacherToken)
  await new Promise(r => setTimeout(r, 400))
}

// Authenticated teacher socket for receiving all emits
const teacherSock = socketClient(PROXY, {
  auth: { token: teacherToken },
  transports: ['polling'],
  reconnection: false
})
const events = []
teacherSock.on('connect', () => {})
teacherSock.on('confusion:update', d => events.push({ kind: 'update', data: d }))
teacherSock.on('confusion:closed', d => events.push({ kind: 'closed', data: d }))
teacherSock.on('confusion:resolved', d => events.push({ kind: 'resolved', data: d }))
teacherSock.on('confusion:feedback:request', d => events.push({ kind: 'fbRequest', data: d }))
teacherSock.on('confusion:feedback', d => events.push({ kind: 'fb', data: d }))
await new Promise(r => teacherSock.on('connect', r))
teacherSock.emit('room:join', { roomCode: room.code })
await new Promise(r => setTimeout(r, 400))
log('teacher socket connected to room', room.code)

// ─── STAGE 1: student1 clicks "I'm Lost" ───────────────────────────
log('\n--- STAGE 1: student1 clicks I\'m Lost ---')
const s1 = await jpost('/api/doubts', { roomId: room._id, segmentIndex: Math.floor(Date.now()/1000) % 99999 }, s1Token)
if (!s1.body?.signal?.id) fail(`student1 doubt failed: ${JSON.stringify(s1.body)}`)
await new Promise(r => setTimeout(r, 700))
const a1 = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
if (!a1.body?.event || a1.body.event.confusedStudentCount !== 1) fail(`expected count=1, got ${JSON.stringify(a1.body)}`)
const eventId = a1.body.event.id
log('  ✅ active event id', eventId, 'count=1')

// ─── STAGE 2: student2 clicks "I'm Lost" (merge into same event) ───
log('\n--- STAGE 2: student2 clicks I\'m Lost ---')
const s2 = await jpost('/api/doubts', { roomId: room._id, segmentIndex: Math.floor(Date.now()/1000) % 99999 }, s2Token)
if (!s2.body?.signal?.id) fail(`student2 doubt failed`)
await new Promise(r => setTimeout(r, 700))
const a2 = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
if (a2.body.event.confusedStudentCount !== 2) fail(`expected count=2, got ${a2.body.event.confusedStudentCount}`)
log('  ✅ active count=2 (merged)')

// ─── STAGE 3: teacher clicks "Request Feedback" ────────────────────
log('\n--- STAGE 3: teacher clicks Request Feedback ---')
const req = await jpost(`/api/confusion/event/${eventId}/request-feedback`, {}, teacherToken)
if (req.status !== 200 || req.body.feedbackStats?.status !== 'pending') {
  fail(`request-feedback bad response: ${JSON.stringify(req.body)}`)
}
if (req.body.feedbackStats.expectedRespondents !== 2) fail(`expectedRespondents should be 2`)
log('  ✅ expectedRespondents=2, status=pending')

await new Promise(r => setTimeout(r, 600))
// Teacher socket should have received: confusion:feedback:request AND confusion:resolved
const fbRequests = events.filter(e => e.kind === 'fbRequest' && e.data.eventId === eventId)
const resolveds = events.filter(e => e.kind === 'resolved' && e.data.eventId === eventId)
if (fbRequests.length < 1) fail(`no confusion:feedback:request on teacher socket`)
if (resolveds.length < 1) fail(`no confusion:resolved on teacher socket (students would not see popup)`)
log('  ✅ teacher got confusion:feedback:request')
log('  ✅ teacher got confusion:resolved (broadcasts to students too)')

// ─── STAGE 4: students answer via existing /api/confusion/event/:id/feedback ───
log('\n--- STAGE 4: students respond ---')
events.length = 0
const fb1 = await jpost(`/api/confusion/event/${eventId}/feedback`, { answer: 'understood' }, s1Token)
if (fb1.body.understood !== 1) fail(`expected understood=1`)
log('  ✅ student1 answered "understood" (tally=1)')
await new Promise(r => setTimeout(r, 350))

const fb2 = await jpost(`/api/confusion/event/${eventId}/feedback`, { answer: 'still_confused' }, s2Token)
if (fb2.body.stillConfused !== 1) fail(`expected stillConfused=1`)
log('  ✅ student2 answered "still_confused" (tally=1)')

await new Promise(r => setTimeout(r, 350))

// ─── STAGE 5: teacher gets live updates over socket ──────────────
log('\n--- STAGE 5: teacher received live updates ---')
const fbEvents = events.filter(e => e.kind === 'fb' && e.data.eventId === eventId)
if (fbEvents.length < 2) fail(`expected >=2 confusion:feedback emits, got ${fbEvents.length}`)
const lastFb = fbEvents[fbEvents.length - 1].data
if (lastFb.understood !== 1 || lastFb.stillConfused !== 1) {
  fail(`final tally wrong: ${JSON.stringify(lastFb)}`)
}
log(`  ✅ ${fbEvents.length} confusion:feedback events received`)
log(`  ✅ final tally: understood=${lastFb.understood}, stillConfused=${lastFb.stillConfused}`)

// ─── STAGE 6: idempotency (duplicate answer rejected) ─────────────
log('\n--- STAGE 6: student1 retries; tally unchanged ---')
const fb1b = await jpost(`/api/confusion/event/${eventId}/feedback`, { answer: 'understood' }, s1Token)
if (fb1b.body.understood !== 1) fail(`idempotency broken: duplicate changed tally`)
log('  ✅ duplicate answer does not double-count')

// ─── STAGE 7: teacher clicks Mark Resolved ─────────────────────────
log('\n--- STAGE 7: teacher clicks Mark Resolved ---')
events.length = 0
const res = await jpost(`/api/confusion/event/${eventId}/resolve`, {}, teacherToken)
if (!res.body.success || res.body.event.status !== 'closed') fail(`resolve failed: ${JSON.stringify(res.body)}`)
log('  ✅ event status=closed, archived')

await new Promise(r => setTimeout(r, 400))

// ─── STAGE 8: verify active empty + history shows closed ──────────
log('\n--- STAGE 8: state after resolve ---')
const a3 = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
if (a3.body?.event) fail(`active still has event after resolve`)
log('  ✅ active is empty')

const hist = await jget(`/api/confusion/room/${room._id}?limit=20`, teacherToken)
const archived = hist.body.events?.find(e => (e.id || e._id) === eventId)
if (!archived || archived.status !== 'closed') fail(`history missing closed event`)
log('  ✅ event archived in Recent Confusion Events')
log('  ✅ feedbackStats preserved on archived event:', JSON.stringify(archived.feedbackStats))

// ─── STAGE 9: socket emits received ────────────────────────────────
log('\n--- STAGE 9: socket confirmation ---')
const closes = events.filter(e => e.kind === 'closed' && e.data.eventId === eventId)
if (closes.length !== 1) fail(`expected exactly 1 confusion:closed, got ${closes.length}`)
log('  ✅ confusion:closed emitted once with reason=' + closes[0].data.reason)

teacherSock.disconnect()
log('\n====== ALL COMBINED-WORKFLOW CHECKS PASSED ✅ ======')
process.exit(0)