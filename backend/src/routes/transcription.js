import express from 'express'
import { authenticate, authorize, requireApprovedTeacher } from '../middleware/auth.js'
import { isEnabled as apiEnabled, transcribeViaApi } from '../services/apiTranscriptionService.js'

const router = express.Router()

// Phase 2C: speech-to-text now runs in a SEPARATE faster-whisper process
// (backend/transcription_server.py, default :3003). This route only PROXIES to it, so
// the heavy CPU inference never runs on — and never blocks — the Node event loop. The
// proxy call is plain async I/O. If the service is down/slow we fail fast with 502/503
// and the API stays fully responsive for everyone else.
const TRANSCRIPTION_URL = process.env.TRANSCRIPTION_SERVICE_URL || 'http://127.0.0.1:3003'
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS) || 30000

// Health/status check (proxied to the transcription service)
router.get('/status', authenticate, async (req, res) => {
  try {
    const r = await fetch(`${TRANSCRIPTION_URL}/health`, { signal: AbortSignal.timeout(3000) })
    const data = await r.json()
    res.json({ status: data.loaded ? 'ready' : 'loading', model: data.model || 'unknown' })
  } catch (err) {
    res.status(503).json({ status: 'unavailable', error: 'Transcription service not reachable' })
  }
})

// Transcribe an audio chunk — forwarded to the faster-whisper service
router.post('/transcribe', authenticate, authorize('teacher'), requireApprovedTeacher, async (req, res) => {
  if (!req.body || !req.body.audio) {
    return res.status(400).json({ error: 'No audio provided' })
  }
  const audio = req.body.audio
  const sampleRate = req.body.sampleRate || 16000

  // Primary path: local faster-whisper
  try {
    const r = await fetch(`${TRANSCRIPTION_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio, sampleRate }),
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
    })
    const data = await r.json()
    // If local Whisper succeeded with non-empty text, return it.
    if (r.ok && data && data.text && data.text.trim()) {
      return res.status(r.status).json(data)
    }
    console.warn(`[transcribe] Local Whisper empty/error (status=${r.status}); falling back${apiEnabled() ? ' to API' : ' (no API key configured)'}`)
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    console.error('[transcribe] Local Whisper error:', err.message, timedOut ? '(timeout)' : '')
  }

  // Fallback path: API-based transcription (OpenAI-compatible /v1/audio/transcriptions)
  if (apiEnabled()) {
    try {
      const apiResult = await transcribeViaApi(audio, sampleRate)
      console.log(`[transcribe] API fallback success: ${apiResult.text.slice(0, 60)}`)
      return res.status(200).json({ text: apiResult.text, language: apiResult.language, source: 'api' })
    } catch (err) {
      console.error('[transcribe] API fallback failed:', err.message)
      return res.status(502).json({ error: `Local transcription failed and API fallback failed: ${err.message}` })
    }
  }

  // Neither local Whisper nor API is working — return last attempt's error
  return res.status(502).json({ error: 'Transcription service unavailable (local Whisper down, no API configured)' })
})

export default router
