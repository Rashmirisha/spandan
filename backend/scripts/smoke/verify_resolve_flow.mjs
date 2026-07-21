// Verify the Mark Resolved flow:
// 1. Login as student, POST /api/doubts -> creates confusion event
// 2. Verify /api/confusion/room/:id/active returns the event
// 3. Login as teacher, POST /api/confusion/event/:id/resolve
// 4. Verify event is now closed (status='closed') and active is empty
// 5. Verify history endpoint shows the closed event

const PROXY = 'http://localhost:3001'

async function jget(p, t) { const r = await fetch(`${PROXY}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} }); return { status: r.status, body: await r.json() } }
async function jpost(p, b, t) { const r = await fetch(`${PROXY}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() } }

const log = (...a) => console.log('[T]', ...a)

async function login(email) {
  const r = await jpost('/api/auth/login', { email, password: 'Test1234!' })
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`)
  return r.body.token
}

// Find any room (or use first one)
const teacherToken = await login('rashmi@spandan.local')
const { body: roomsBody } = await jget('/api/rooms', teacherToken)
const room = roomsBody.rooms.find(r => !r.endedAt)
if (!room) throw new Error('No active room found')
log('using room', room._id, room.name)

log('1. start session if not started')
await jpost(`/api/rooms/${room._id}/start`, {}, teacherToken)

log('2. login student1')
const studentToken = await login('student@spandan.local')

log('3. POST /api/doubts as student1 -> should create event')
const d1 = await jpost('/api/doubts', { roomId: room._id, segmentIndex: Date.now() % 1000, transcriptOffsetMs: 0 }, studentToken)
log('  status', d1.status, 'signal id:', d1.body?.signal?.id)

log('4. wait 1s for /api/confusion/room/:id/active to populate')
await new Promise(r => setTimeout(r, 1500))

log('5. GET /api/confusion/room/:id/active (teacher)')
const active = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
log('  status', active.status, 'has event:', !!active.body?.event, 'count:', active.body?.event?.confusedStudentCount)
if (!active.body?.event) {
  log('  FATAL: no active event after student signal — aborting')
  process.exit(1)
}
const eventId = active.body.event.id
log('  active event id:', eventId)

log('6. POST /api/confusion/event/:id/resolve (teacher)')
const res = await jpost(`/api/confusion/event/${eventId}/resolve`, {}, teacherToken)
log('  status', res.status, 'success:', res.body?.success, 'event.status:', res.body?.event?.status)
if (!res.body?.success) { log('  FATAL: resolve failed'); console.log(JSON.stringify(res.body, null, 2)); process.exit(1) }
if (res.body.event.status !== 'closed') { log('  FATAL: event.status is not closed:', res.body.event.status); process.exit(1) }
log('  OK: event is closed')

log('7. GET /api/confusion/room/:id/active — should be empty')
const active2 = await jget(`/api/confusion/room/${room._id}/active`, teacherToken)
log('  status', active2.status, 'has event:', !!active2.body?.event, 'event:', active2.body?.event)
if (active2.body?.event) { log('  FATAL: active still has event after resolve'); process.exit(1) }
log('  OK: active is empty')

log('8. GET /api/confusion/room/:id (history) — should show closed event')
const hist = await jget(`/api/confusion/room/${room._id}?limit=5`, teacherToken)
log('  status', hist.status, 'event count:', hist.body?.events?.length)
const found = hist.body?.events?.find(e => (e.id || e._id) === eventId)
if (!found) { log('  FATAL: history does not include resolved event'); process.exit(1) }
log('  OK: history includes event with status:', found.status)

log('9. Idempotency — POST resolve again on same id')
const res2 = await jpost(`/api/confusion/event/${eventId}/resolve`, {}, teacherToken)
log('  status', res2.status, 'alreadyClosed:', res2.body?.alreadyClosed, 'event.status:', res2.body?.event?.status)
if (!res2.body?.success) { log('  FATAL: idempotent resolve failed'); process.exit(1) }

log('ALL CHECKS PASSED ✅')
process.exit(0)