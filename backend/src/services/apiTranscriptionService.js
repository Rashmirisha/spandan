// API-based transcription fallback. Used when the local faster-whisper
// service is unavailable, hangs, or returns empty/garbage.
//
// Supports the OpenAI-compatible /v1/audio/transcriptions endpoint shape,
// which MiniMax also exposes. Configure these env vars to enable:
//
//   TRANSCRIPTION_API_URL=https://api.openai.com/v1/audio/transcriptions
//   TRANSCRIPTION_API_KEY=<your key>
//
//   # Optional: model name; defaults to whisper-1
//   TRANSCRIPTION_API_MODEL=whisper-1
//
// Request body: multipart/form-data with { file: <wav blob>, model, language?, prompt? }
import FormData from 'form-data' // can be polyfilled; fall back to manual multipart below

const API_URL = process.env.TRANSCRIPTION_API_URL || ''
const API_KEY = process.env.TRANSCRIPTION_API_KEY || ''
const API_MODEL = process.env.TRANSCRIPTION_API_MODEL || 'whisper-1'

function isEnabled () {
  return Boolean(API_URL && API_KEY)
}

/**
 * Transcribe via OpenAI-compatible API.
 * @param {string} audioBase64 - base64-encoded WAV (or raw PCM) audio
 * @param {number} sampleRate - sample rate in Hz (16k expected)
 * @returns {Promise<{text: string, language?: string}>}
 */
async function transcribeViaApi (audioBase64, sampleRate = 16000) {
  if (!isEnabled()) {
    throw new Error('API transcription not configured (set TRANSCRIPTION_API_URL and TRANSCRIPTION_API_KEY)')
  }

  // Build multipart/form-data manually (no external deps).
  const boundary = '----transcription-' + Date.now().toString(36) + Math.random().toString(36).slice(2)
  const audioBytes = Buffer.from(audioBase64, 'base64')

  // Wrap PCM as a minimal WAV header if not already WAV
  let wavBytes = audioBytes
  if (!(audioBytes.length > 44 && audioBytes.toString('ascii', 0, 4) === 'RIFF' && audioBytes.toString('ascii', 8, 12) === 'WAVE')) {
    wavBytes = Buffer.alloc(44 + audioBytes.length)
    wavBytes.write('RIFF', 0)
    wavBytes.writeUInt32LE(36 + audioBytes.length, 4)
    wavBytes.write('WAVE', 8)
    wavBytes.write('fmt ', 12)
    wavBytes.writeUInt32LE(16, 16)
    wavBytes.writeUInt16LE(1, 20)
    wavBytes.writeUInt16LE(1, 22)
    wavBytes.writeUInt32LE(sampleRate, 24)
    wavBytes.writeUInt32LE(sampleRate * 2, 28)
    wavBytes.writeUInt16LE(2, 32)
    wavBytes.writeUInt16LE(16, 34)
    wavBytes.write('data', 36)
    wavBytes.writeUInt32LE(audioBytes.length, 40)
    audioBytes.copy(wavBytes, 44)
  }

  const CRLF = '\r\n'
  const parts = []
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="audio.wav"${CRLF}` +
    `Content-Type: audio/wav${CRLF}${CRLF}`
  ))
  parts.push(wavBytes)
  parts.push(Buffer.from(`${CRLF}`))
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
    `${API_MODEL}${CRLF}`
  ))
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
    `en${CRLF}`
  ))
  parts.push(Buffer.from(
    `--${boundary}--${CRLF}`
  ))
  const body = Buffer.concat(parts)

  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 30000)

  let resp
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length)
      },
      body,
      signal: ctrl.signal
    })
  } finally {
    clearTimeout(to)
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`API transcription error ${resp.status}: ${errText.slice(0, 200)}`)
  }
  const data = await resp.json()
  const text = (data.text || '').trim()
  return { text, language: data.language || 'en' }
}

export { isEnabled, transcribeViaApi }
export default { isEnabled, transcribeViaApi }
