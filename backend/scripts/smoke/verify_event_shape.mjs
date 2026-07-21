const BASE = 'http://localhost:5173/spandan'

async function jget(path, token) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return r.json()
}

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rashmi@spandan.local', password: 'Test1234!' })
  })
  const j = await r.json()
  return j.token
}

const token = await login()
const rooms = (await jget('/api/rooms', token)).rooms
const room = rooms[0]
console.log(`room ${room._id} name=${room.name}`)

console.log('\n=== /api/rooms/:id (room metadata for AnalyticsPage header) ===')
const roomFull = await jget(`/api/rooms/${room._id}`, token)
console.log(JSON.stringify(roomFull.room, null, 2))

console.log('\n=== /api/confusion/.../active (live event) ===')
const active = await jget(`/api/confusion/room/${room._id}/active`, token)
console.log('event:', JSON.stringify(active.event, null, 2))

console.log('\n=== /api/confusion/room/:id (history, limit 2) ===')
const hist = await jget(`/api/confusion/room/${room._id}?limit=2`, token)
console.log('events:', JSON.stringify(hist.events, null, 2))

console.log('\n=== /api/confusion/.../topic-heat ===')
const th = await jget(`/api/confusion/room/${room._id}/topic-heat?topN=5`, token)
console.log(JSON.stringify(th, null, 2))

console.log('\n=== /api/confusion/.../heatmap ===')
const hm = await jget(`/api/confusion/room/${room._id}/heatmap?bucketMs=60000&windowMs=600000`, token)
console.log(JSON.stringify(hm, null, 2))