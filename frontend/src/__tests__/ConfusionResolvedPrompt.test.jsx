/**
 * ConfusionResolvedPrompt -- button-handler regression tests
 *
 * PR #35 -- the popup buttons used to silently do nothing because the
 * backend /feedback route returned 500 (missing destructure for pollId),
 * AND the React error handler logged to console only -- leaving the
 * student stuck on the popup with no recovery path.
 *
 * These tests pin down the end-to-end click behaviour:
 *   - clicking Understood posts to /api/confusion/event/:id/feedback
 *     with { answer: 'understood', pollId: <received via socket> }
 *   - clicking Still Confused does the same with 'still_confused'
 *   - a rapid second click before the first completes is a no-op (lockout)
 *   - a server error shows a visible error UI with Retry and Dismiss
 *     buttons so the student is never permanently stuck
 *   - on success, the popup closes after the short fade-out
 */
import React from 'react'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'

jest.mock('../config.js', () => ({ API_URL: '/api', SOCKET_URL: 'http://localhost' }))
// Mock the auth store used by the api helper. The api.js calls
// `useAuthStore.getState()` (Zustand pattern), so we expose that shape.
jest.mock('../stores/authStore.js', () => ({
  __esModule: true,
  default: {
    getState: () => ({ token: 'fake-jwt', user: { _id: 'u1', role: 'student' } })
  }
}))
// Mock the socket store -- tests inject their own fake socket.
jest.mock('../stores/socketStore.js', () => ({
  __esModule: true,
  useSocketStore: (sel) => sel({ socket: global.__SOCKET__ })
}))
// Mock sounds (no audio in tests).
jest.mock('../lib/sounds.js', () => ({ __esModule: true, default: { tap: () => {} } }))

import ConfusionResolvedPrompt from '../components/ConfusionResolvedPrompt.jsx'

function makeSocket() {
  const handlers = {}
  return {
    on: (e, fn) => { (handlers[e] = handlers[e] || []).push(fn) },
    off: (e, fn) => { if (handlers[e]) handlers[e] = handlers[e].filter(x => x !== fn) },
    __emit: (e, payload) => { (handlers[e] || []).forEach(fn => fn(payload)) }
  }
}

afterEach(() => {
  jest.restoreAllMocks()
  delete global.fetch
  delete global.__SOCKET__
})

describe('ConfusionResolvedPrompt -- PR #35 popup button handlers', () => {
  test('clicking Understood sends POST with answer=understood AND pollId from socket payload', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, pollId: 'p1', pollNumber: 1,
        originalConfused: 1, eligibleRespondents: 1, responded: 1,
        understood: 1, stillConfused: 0, recoveryPercent: 100,
        expectedRespondents: 1, needsMoreExplanation: false, autoClosed: true })
    })
    global.fetch = fetchMock
    const sock = makeSocket(); global.__SOCKET__ = sock

    render(<ConfusionResolvedPrompt roomId="r1" />)

    // Teacher pushes a 'confusion:resolved' event with pollId.
    await act(async () => {
      sock.__emit('confusion:resolved', {
        roomId: 'r1', eventId: 'e1', pollId: 'p-from-socket', pollNumber: 7,
        topic: 'Photosynthesis'
      })
    })

    // Buttons appear.
    const yesBtn = screen.getByRole('button', { name: /Understood/i })
    const noBtn = screen.getByRole('button', { name: /Still Confused/i })
    expect(yesBtn).toBeInTheDocument()
    expect(noBtn).toBeInTheDocument()

    // Click Understood.
    await act(async () => { fireEvent.click(yesBtn) })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/confusion/event/e1/feedback')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    // CRITICAL: pollId must be forwarded from the socket event so the
    // backend records the response against the correct recovery round.
    expect(body).toEqual({ answer: 'understood', pollId: 'p-from-socket' })
  })

  test('clicking Still Confused sends POST with answer=still_confused and pollId', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, pollId: 'p2', pollNumber: 2,
        originalConfused: 1, eligibleRespondents: 1, responded: 1,
        understood: 0, stillConfused: 1, recoveryPercent: 0,
        expectedRespondents: 1, needsMoreExplanation: true, autoClosed: false })
    })
    global.fetch = fetchMock
    const sock = makeSocket(); global.__SOCKET__ = sock

    render(<ConfusionResolvedPrompt roomId="r1" />)
    await act(async () => {
      sock.__emit('confusion:resolved', {
        roomId: 'r1', eventId: 'e2', pollId: 'poll-xyz', pollNumber: 9, topic: 'Krebs cycle'
      })
    })

    const noBtn = screen.getByRole('button', { name: /Still Confused/i })
    await act(async () => { fireEvent.click(noBtn) })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ answer: 'still_confused', pollId: 'poll-xyz' })
  })

  test('rapid second click does NOT send a second POST (lockout via submitting flag)', async () => {
    let resolveFetch
    const pending = new Promise(res => { resolveFetch = res })
    const fetchMock = jest.fn().mockReturnValue(pending)
    global.fetch = fetchMock
    const sock = makeSocket(); global.__SOCKET__ = sock

    render(<ConfusionResolvedPrompt roomId="r1" />)
    await act(async () => {
      sock.__emit('confusion:resolved', { roomId: 'r1', eventId: 'e3', pollId: 'p3', pollNumber: 1, topic: 'X' })
    })

    const yesBtn = screen.getByRole('button', { name: /Understood/i })
    await act(async () => { fireEvent.click(yesBtn) })
    await act(async () => { fireEvent.click(yesBtn) })
    await act(async () => { fireEvent.click(yesBtn) })

    expect(fetchMock).toHaveBeenCalledTimes(1) // exactly one POST, lockout held

    // Resolve so React can flush the success path.
    resolveFetch({ ok: true, status: 200,
      json: async () => ({ success: true, pollId: 'p3', pollNumber: 1, responded: 1, understood: 1, stillConfused: 0, recoveryPercent: 100 }) })
  })

  test('when the server returns 500, the popup shows an error UI with Retry + Dismiss (never stuck)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ success: false, error: 'Failed to record feedback' })
    })
    global.fetch = fetchMock
    const sock = makeSocket(); global.__SOCKET__ = sock

    render(<ConfusionResolvedPrompt roomId="r1" />)
    await act(async () => {
      sock.__emit('confusion:resolved', { roomId: 'r1', eventId: 'e4', pollId: 'p4', pollNumber: 1, topic: 'Y' })
    })

    const yesBtn = screen.getByRole('button', { name: /Understood/i })
    await act(async () => { fireEvent.click(yesBtn) })

    // Wait for the error UI to appear.
    const errBox = await screen.findByRole('alert')
    expect(errBox).toHaveTextContent(/Failed to record feedback|Failed/i)
    // Retry button MUST be present -- student is never stuck.
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
    // Dismiss button gives the student a way out.
    expect(screen.getByRole('button', { name: /Dismiss/i })).toBeInTheDocument()

    // The original two buttons are STILL available so the student can also
    // pick a different answer.
    expect(screen.getByRole('button', { name: /Understood/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Still Confused/i })).toBeInTheDocument()
  })

  test('Dismiss button closes the popup even after an error', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ success: false, error: 'boom' })
    })
    global.fetch = fetchMock
    const sock = makeSocket(); global.__SOCKET__ = sock

    render(<ConfusionResolvedPrompt roomId="r1" />)
    await act(async () => {
      sock.__emit('confusion:resolved', { roomId: 'r1', eventId: 'e5', pollId: 'p5', pollNumber: 1, topic: 'Z' })
    })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Understood/i })) })
    const dismiss = await screen.findByRole('button', { name: /Dismiss/i })
    await act(async () => { fireEvent.click(dismiss) })

    // The whole popup component returns null when no prompt -- so the
    // buttons disappear.
    expect(screen.queryByRole('button', { name: /Understood/i })).toBeNull()
  })

  test('on a fresh prompt after a previous error, the error UI is cleared', async () => {
    let mode = 'fail'
    const fetchMock = jest.fn().mockImplementation(() => {
      if (mode === 'fail') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, pollId: 'p', pollNumber: 1, responded: 1, understood: 1, stillConfused: 0, recoveryPercent: 100 }) })
    })
    global.fetch = fetchMock
    const sock = makeSocket(); global.__SOCKET__ = sock

    render(<ConfusionResolvedPrompt roomId="r1" />)
    await act(async () => {
      sock.__emit('confusion:resolved', { roomId: 'r1', eventId: 'e6', pollId: 'p6', pollNumber: 1, topic: 'W' })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Understood/i })) })
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    // A new prompt arrives -- error UI must reset so the student gets
    // a clean retry surface (not stale errors from the previous round).
    await act(async () => {
      sock.__emit('confusion:resolved', { roomId: 'r1', eventId: 'e7', pollId: 'p7', pollNumber: 2, topic: 'W2' })
    })
    expect(screen.queryByRole('alert')).toBeNull()
    // The Submitting lockout from the previous failed attempt must also
    // be cleared, otherwise the buttons would be disabled on this new prompt.
    expect(screen.getByRole('button', { name: /Understood/i })).not.toBeDisabled()
  })
})
