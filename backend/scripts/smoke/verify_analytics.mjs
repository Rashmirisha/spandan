// Smoke test: end-to-end through Vite proxy on :5173
// Verifies login + analytics endpoint chain works through the new dev stack.

const BASE = 'http://localhost:5173/spandan'
const CREDS = { email: 'rashmi@spandan.local', password: 'Test1234!' }

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CREDS)
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`login failed: ${j.error}`)
  return j
}

async function me(token) {
  const r = await fetch(`${BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return { status: r.status, body: await r.json() }
}

async function rooms(token) {
  const r = await fetch(`${BASE}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const j = await r.json()
  return j.rooms || []
}

async function confusion(token, roomId) {
  const endpoints = ['active', 'topic-heat', 'heatmap', 'history']
  const results = {}
  for (const e of endpoints) {
    const url = e === 'history'
      ? `${BASE}/api/confusion/room/${roomId}?limit=5`
      : e === 'heatmap'
        ? `${BASE}/api/confusion/room/${roomId}/heatmap?bucketMs=60000&windowMs=600000`
        : e === 'topic-heat'
          ? `${BASE}/api/confusion/room/${roomId}/topic-heat?topN=10`
          : `${BASE}/api/confusion/room/${roomId}/active`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    results[e] = { status: r.status, body: await r.json() }
  }
  return results
}

async function main() {
  console.log('1. login via proxy...')
  const auth = await login()
  console.log(`   OK role=${auth.user.role} tokenLen=${auth.token.length}`)

  console.log('2. /me ...')
  const m = await me(auth.token)
  console.log(`   status=${m.status} email=${m.body.user?.email}`)

  console.log('3. /rooms ...')
  const roomsList = await rooms(auth.token)
  console.log(`   count=${roomsList.length}`)
  if (roomsList.length === 0) {
    console.log('   no rooms, stopping')
    return
  }
  const room = roomsList[0]
  console.log(`   first: name="${room.name}" code=${room.code} _id=${room._id}`)

  console.log('4. confusion endpoints for room...')
  const c = await confusion(auth.token, room._id)
  for (const k of Object.keys(c)) {
    console.log(`   ${k}: status=${c[k].status}`)
  }

  console.log('\n5. room fetch (used by AnalyticsPage)...')
  const rr = await fetch(`${BASE}/api/rooms/${room._id}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const roomBody = await rr.json()
  console.log(`   room status=${rr.status} name=${roomBody.room?.name}`)

  console.log('\n6. analytics route SPA fallback (vite serves index.html for the path)...')
  const spa = await fetch(`${BASE}/teacher/analytics/${room._id}`)
  console.log(`   /teacher/analytics/:roomId -> status=${spa.status} content-type=${spa.headers.get('content-type')}`)

  console.log('\nALL CHECKS DONE')
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1) })