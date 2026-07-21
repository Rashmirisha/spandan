// Create a confusion event for visual testing
// 1. Login as student
// 2. POST /api/doubts
// 3. Verify it appears in /api/confusion/.../active

const BASE = 'http://localhost:5173/spandan'

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!' })
  })
  return (await r.json()).token
}

const t = await login('student@spandan.local')
const rooms = await (await fetch(`${BASE}/api/rooms/active`, { headers: { Authorization: `Bearer ${t}` } })).json()
console.log('student /rooms/active:', JSON.stringify(rooms).slice(0, 200))
// Student doesn't have /rooms/active — they need a room code.
// Let me find an active room from the teacher account.

const teacherToken = await login('rashmi@spandan.local')
const tr = await (await fetch(`${BASE}/api/rooms`, { headers: { Authorization: `Bearer ${teacherToken}` } })).json()
const activeRoom = tr.rooms.find(r => !r.endedAt)
console.log('active room:', activeRoom.name, 'code:', activeRoom.code)

// Student joins
const joinR = await fetch(`${BASE}/api/rooms/join`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: activeRoom.code })
})
const j = await joinR.json()
console.log('join response:', JSON.stringify(j).slice(0, 300))
if (!j.token && !j.user) {
  console.log('student could not join -- trying as student2...')
}
const studentToken = j.token || t
const studentUser = j.user || (await (await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${studentToken}` } })).json()).user

console.log('student joined:', studentUser.email)

// POST a doubt signal
const doubtR = await fetch(`${BASE}/api/doubts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}` },
  body: JSON.stringify({
    roomId: activeRoom._id,
    text: 'I lost track at the second example — what variable are we solving for?',
    timestampMs: 12000
  })
})
console.log('doubt POST status:', doubtR.status)
const doubtBody = await doubtR.json()
console.log('doubt response:', JSON.stringify(doubtBody).slice(0, 400))

// Verify it appears in active
const active = await (await fetch(`${BASE}/api/confusion/room/${activeRoom._id}/active`, { headers: { Authorization: `Bearer ${teacherToken}` } })).json()
console.log('active event now:', JSON.stringify(active).slice(0, 400))