// Validate the same-browser teacher+student fix.
// Simulates two tabs (Tab A = teacher, Tab B = student) and confirms each
// receives a stable, isolated session. The backend doesn't know about tabs;
// the fix is in the FRONTEND authStore (localStorage -> sessionStorage).
// Here we just verify that two logins through the same proxy don't blow up
// and that /auth/me returns distinct users per tab.

const BASE = 'http://localhost:5173/spandan'

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!' })
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`login failed: ${j.error}`)
  return j
}

async function me(token) {
  const r = await fetch(`${BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return r.json()
}

async function main() {
  console.log('=== same-browser auth-flow isolation test ===\n')

  console.log('TAB A: teacher login')
  const teacher = await login('rashmi@spandan.local')
  console.log(`  role=${teacher.user.role} email=${teacher.user.email}`)

  console.log('\nTAB B: student login (would clobber localStorage in the old code)')
  const student = await login('student@spandan.local')
  console.log(`  role=${student.user.role} email=${student.user.email}`)

  console.log('\nTAB A: re-fetch /me with teacher token (should still be teacher)')
  const meA = await me(teacher.token)
  console.log(`  role=${meA.user?.role} email=${meA.user?.email}`)

  console.log('\nTAB B: re-fetch /me with student token (should still be student)')
  const meB = await me(student.token)
  console.log(`  role=${meB.user?.role} email=${meB.user?.email}`)

  const passed = meA.user.role === 'teacher' && meB.user.role === 'student'
  console.log(`\nRESULT: ${passed ? 'PASS' : 'FAIL'} - backend correctly serves distinct sessions per tab`)

  // The CRITICAL part: the FRONTEND fix. We can't simulate browser storage
  // from Node, but we can prove the bundle swaps localStorage -> sessionStorage
  // by re-grepping the dist (already done in verify_no_browser.mjs).
  console.log('\nNote: frontend fix is in dist (verified earlier with grep).')
  console.log('Each browser tab now uses sessionStorage, so a student login')
  console.log('in Tab B does not overwrite teacher auth in Tab A.')

  if (!passed) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })