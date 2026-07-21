// End-to-end via Vite proxy: socket connects to /spandan/socket.io
// Then in parallel: REST POST /api/transcripts triggers auto-topic which emits teacher:topic-set
// Verify the proxy socket receives it.
import { io as socketClient } from 'socket.io-client'

const PROXY = 'http://localhost:5173/spandan'
const TOKEN = 'eyJhbGciOiJIUzI1NiIs'  // replaced at runtime
const ROOM_ID = '6a5b5266305142686645dc89'
const ROOM_CODE = 'E993LJ'

async function jget(p, t) { const r = await fetch(`${PROXY}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} }); return { status: r.status, body: await r.json() } }
async function jpost(p, b, t) { const r = await fetch(`${PROXY}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() } }

const log = (...a) => console.log('[T]', ...a)

const { body: lj } = await jpost('/api/auth/login', { email: 'rashmi@spandan.local', password: 'Test1234!' })
const token = lj.token
log('logged in')

// Connect socket via Vite proxy (exactly like frontend)
const sock = socketClient('http://localhost:5173', {
  auth: { token },
  path: '/spandan/socket.io',
  transports: ['websocket', 'polling'],
  reconnection: false,
  timeout: 8000
})

const events = []
await new Promise(resolve => sock.on('connect', resolve))
log('socket connected via proxy, id:', sock.id)

sock.on('teacher:topic-set', d => events.push({ name: 'teacher:topic-set', label: d?.marker?.label }))
sock.on('teacher:position', d => events.push({ name: 'teacher:position' }))
sock.on('room:joined', d => log('  room:joined', d?.roomCode, 'participants:', d?.participants))

sock.emit('room:join', { roomCode: ROOM_CODE })
await new Promise(r => setTimeout(r, 500))

// Trigger auto-topic pipeline via REST POST /api/transcripts
log('triggering transcript save -> auto-topic pipeline')
const save = await jpost('/api/transcripts', {
  roomId: ROOM_ID,
  segmentIndex: Date.now() % 1000,
  text: 'Chlorophyll absorbs red and blue light wavelengths most strongly.',
  duration: 5,
  wordCount: 10
}, token)
log('  save status', save.status)

await new Promise(r => setTimeout(r, 4000))

log('events received via proxy socket:', events.length)
for (const e of events) log('  -', e.name, e.label || '')

sock.disconnect()
process.exit(0)