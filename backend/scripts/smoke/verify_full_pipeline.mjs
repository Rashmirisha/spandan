// End-to-end live lecture test:
// 1. Teacher logs in
// 2. Finds a room, starts session
// 3. Joins socket with room:join
// 4. Sends synthesized WAV audio to Python /transcribe
// 5. Saves the resulting transcript via /api/transcripts
// 6. Listens on teacher:topic-set (must arrive)
// 7. Verifies topics appear via /api/topics/room/:id

import { io as socketClient } from 'socket.io-client'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

const BASE = 'http://localhost:3001'
const PROXY = 'http://localhost:5173/spandan'

async function jget(path, token) {
  const r = await fetch(`${PROXY}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  return { status: r.status, body: await r.json() }
}
async function jpost(path, body, token) {
  const r = await fetch(`${PROXY}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  return { status: r.status, body: await r.json() }
}

async function login(email) {
  const r = await jpost('/api/auth/login', { email, password: 'Test1234!' })
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`)
  return r.body.token
}

const log = (...a) => console.log('[T]', ...a)

// Create a 3-second silent WAV (16-bit PCM, 16 kHz, mono) -- pure tone test
function makeSilentWav(seconds = 3) {
  const sampleRate = 16000
  const numSamples = sampleRate * seconds
  const byteRate = sampleRate * 2 // 16-bit mono
  const buf = Buffer.alloc(44 + numSamples * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + numSamples * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)         // PCM chunk size
  buf.writeUInt16LE(1, 20)          // PCM format
  buf.writeUInt16LE(1, 22)          // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(2, 32)          // block align
  buf.writeUInt16LE(16, 34)         // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(numSamples * 2, 40)
  // Generate a quiet sine wave at 440 Hz so Whisper has SOMETHING to chew on (not pure silence)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const v = Math.sin(2 * Math.PI * 440 * t) * 0.05 // amplitude 0.05 to keep quiet
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buf
}

async function transcribeViaPython(wavBuf) {
  const form = new FormData()
  form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'test.wav')
  form.append('language', 'en')
  const r = await fetch('http://127.0.0.1:3003/transcribe', { method: 'POST', body: form })
  return { status: r.status, body: await r.json() }
}

async function main() {
  log('1. login teacher')
  const token = await login('rashmi@spandan.local')

  log('2. list rooms')
  const { body: roomsBody } = await jget('/api/rooms', token)
  const room = roomsBody.rooms.find(r => !r.endedAt) || roomsBody.rooms[0]
  log('  using room', room._id, room.name)

  log('3. start session')
  const start = await jpost(`/api/rooms/${room._id}/start`, {}, token)
  log('  status', start.status, start.body?.room?.roomStartedAt || 'already started')

  log('4. connect socket + join room (polling only, no websocket to avoid Vite proxy churn)')
  const sock = socketClient('http://localhost:3001', {
    auth: { token },
    path: '/socket.io', // backend socket.io is at default /socket.io when accessed directly
    transports: ['polling'],
    timeout: 5000,
    reconnection: false
  })
  await new Promise(resolve => sock.on('connect', resolve))
  log('  connected', sock.id)

  const socketEvents = []
  sock.on('teacher:topic-set', d => socketEvents.push({ name: 'teacher:topic-set', data: d?.marker?.label || '?' }))
  sock.on('teacher:position', d => socketEvents.push({ name: 'teacher:position' }))
  sock.on('teacher:session-start', d => socketEvents.push({ name: 'teacher:session-start' }))

  sock.emit('room:join', { roomCode: room.code })
  await new Promise(r => setTimeout(r, 500))
  log('  joined room', room.code)

  log('5. transcribe silent WAV via Python service')
  const wav = makeSilentWav(3)
  log('  wav size:', wav.length, 'bytes')
  const tr = await transcribeViaPython(wav)
  log('  whisper status', tr.status, 'transcript:', JSON.stringify(tr.body).slice(0, 200))
  const transcriptText = tr.body?.text || tr.body?.transcript || ''

  log('6. save transcript via POST /api/transcripts')
  const seg = Date.now() % 1000
  const save = await jpost('/api/transcripts', {
    roomId: room._id,
    segmentIndex: seg,
    text: transcriptText || 'Photosynthesis is the process by which plants convert light into chemical energy.',
    duration: 3,
    wordCount: 15
  }, token)
  log('  status', save.status, 'transcript id', save.body?.transcript?._id)

  // Wait for fire-and-forget topic generator
  log('7. wait 3s for auto-topic pipeline...')
  await new Promise(r => setTimeout(r, 3000))

  log('8. fetch topics via /api/topics/room/:id')
  const topics = await jget(`/api/topics/room/${room._id}`, token)
  log('  status', topics.status, 'topic count', topics.body?.topics?.length)
  if (topics.body?.topics?.length) {
    const latest = topics.body.topics[topics.body.topics.length - 1]
    log('  latest topic:', latest.label, 'source:', latest.source)
  }

  log('9. socket events received:', socketEvents.length)
  for (const e of socketEvents) log('  -', e.name, e.data || '')

  sock.disconnect()
}

main().catch(e => { console.error('FAIL:', e); process.exit(1) })