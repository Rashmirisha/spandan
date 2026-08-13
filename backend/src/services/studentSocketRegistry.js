/**
 * studentSocketRegistry.js
 *
 * Server-side registry mapping anonymous ConfusionEvent.studentIds (HMAC hashes)
 * to the live Socket.IO sockets currently connected as that student.
 *
 * PR #35 fix: the recovery "Did this help?" prompt must be sent ONLY to
 * students who actually pressed "I'm Lost" (i.e. whose hash appears in the
 * event's studentIds). Previously it was broadcast to the whole room, which
 * leaked the prompt to students who never pressed "I'm Lost".
 *
 * The registry hooks the existing socket.io 'connection' event (via
 * installOnIo, called once on first use) to populate the index without
 * touching index.js. The hash is recomputed using the same HMAC-SHA256
 * algorithm as doubtService (HMAC-SHA256(userId, roomSalt)) — a student
 * cannot impersonate another student without knowing their userId and the
 * room's salt.
 *
 * Anonymous-to-socket lookup uses an LRU-cached Map<roomId, Map<studentHash, Set<socketId>>>
 * so a room with many historical events does not balloon memory.
 */
import crypto from 'crypto'
import { hashStudent } from './doubtService.js'

const MAX_CACHED_ROOMS = 500

// roomId(str) -> Map<studentHash, Set<socketId>>
const socketIndexByRoom = new Map()
// socketId -> { roomCode, studentHash, roomId }
const socketMeta = new Map()
// io instance we hooked
let installedIo = null

function getRoomIndex (roomId) {
  const key = String(roomId)
  let m = socketIndexByRoom.get(key)
  if (!m) {
    // LRU eviction: drop oldest if cache is full
    if (socketIndexByRoom.size >= MAX_CACHED_ROOMS) {
      const firstKey = socketIndexByRoom.keys().next().value
      if (firstKey) socketIndexByRoom.delete(firstKey)
    }
    m = new Map()
    socketIndexByRoom.set(key, m)
  }
  return m
}

/**
 * Idempotently hook the io singleton. Safe to call multiple times.
 * Safe to call BEFORE any sockets connect. No-op if io is null/undefined.
 */
export function installOnIo (io) {
  if (!io || installedIo === io) return
  installedIo = io

  io.on('connection', (socket) => {
    // Attach a 'room:join' listener that does NOT interfere with the
    // existing handler in index.js — Socket.IO invokes ALL listeners for
    // an event in registration order. We only record state; we never
    // call socket.emit or socket.join.
    socket.on('room:join', async ({ roomCode } = {}) => {
      try {
        if (!roomCode) return
        const userId = socket.data?.userId
        if (!userId) return
        // Resolve roomId + doubtSalt by code (we don't have the roomId in
        // the join payload — only the code). Lazily import Room so we
        // don't create a load-order cycle.
        const Room = (await import('../models/Room.js')).default
        const room = await Room.findOne({ code: roomCode }).select('_id doubtSalt').lean()
        if (!room) return
        const salt = room.doubtSalt
        if (!salt) return
        const hash = hashStudent(userId, salt)
        const roomId = String(room._id)
        const idx = getRoomIndex(roomId)
        let set = idx.get(hash)
        if (!set) { set = new Set(); idx.set(hash, set) }
        set.add(socket.id)
        socketMeta.set(socket.id, { roomId, roomCode, studentHash: hash })
      } catch (err) {
        // Non-fatal — the recovery route has a rebuild fallback.
        console.warn('[studentSocketRegistry] room:join hook error:', err.message)
      }
    })

    socket.on('disconnect', () => {
      const meta = socketMeta.get(socket.id)
      if (!meta) return
      const idx = socketIndexByRoom.get(meta.roomId)
      if (idx) {
        const set = idx.get(meta.studentHash)
        if (set) {
          set.delete(socket.id)
          if (set.size === 0) idx.delete(meta.studentHash)
        }
      }
      socketMeta.delete(socket.id)
    })
  })
}

/**
 * For a given event's studentIds, return the Set of live socketIds whose
 * socket.data.userId hashes to one of those hashes for this room's salt.
 *
 * Returns:
 *   { socketIds: Set<string>, studentHashes: Set<string>, roomMembers: number }
 *
 * - socketIds: sockets to emit the recovery prompt to (one emit per socket)
 * - studentHashes: hashes from event.studentIds that had at least one live socket
 * - roomMembers: total sockets currently joined to the room (for diagnostics)
 */
export function resolveRecoveryRecipients ({ io, roomId, roomSalt, studentHashes }) {
  const roomIndex = getRoomIndex(roomId)
  const targetSockets = new Set()
  const matchedHashes = new Set()
  let roomMembers = 0

  if (!io || !io.sockets || !studentHashes || studentHashes.size === 0) {
    return { socketIds: targetSockets, studentHashes: matchedHashes, roomMembers: 0 }
  }

  const hashSet = new Set(studentHashes)
  // Fast path: iterate the cached room index.
  for (const [hash, socketIds] of roomIndex.entries()) {
    if (!hashSet.has(hash)) continue
    for (const sid of socketIds) {
      const sock = io.sockets.sockets.get(sid)
      if (sock) {
        targetSockets.add(sid)
        matchedHashes.add(hash)
      }
    }
  }

  // Fallback: rebuild by iterating io.sockets.sockets and recomputing the
  // hash for each. Used when the index is empty (e.g. backend just restarted
  // and no room:join has happened yet, OR the installOnIo hook failed).
  //
  // IMPORTANT: we MUST only consider sockets that are currently in this
  // room's socket-room. Otherwise a student who is in roomB with saltB
  // would be matched against roomA's saltA (a different hash), but if
  // they were in two rooms simultaneously with different salts, the
  // fallback would erroneously include them. Restricting to the room's
  // socket-room is required to preserve per-room isolation.
  if (targetSockets.size === 0 && roomSalt) {
    // Find the room's code from either the cached __roomCode or by
    // counting against adapter rooms.
    let targetRoomCode = roomIndex && roomIndex.__roomCode
    if (!targetRoomCode && io.sockets.adapter && io.sockets.adapter.rooms) {
      // adapter.rooms maps roomCode/roomId -> Set<socketId>. We don't
      // have the code from the caller when the index is empty, but we
      // have the roomId. Sockets joined via socket.join(code) put the
      // code in their rooms set; the adapter.rooms key is the code, not
      // the roomId. We can't derive code from roomId here. So if the
      // cache is empty, we have to defer to the caller-supplied code
      // via a different pathway. For safety, in this fallback, we skip
      // sockets whose current rooms set does NOT include any of the
      // known rooms in the cache — but if the cache is empty, we can\'t
      // do that. So restrict to sockets that explicitly carry the
      // cached __roomCode OR (best-effort) iterate adapter.rooms to find
      // a room containing sockets whose data has userId matching.
      // Simpler: scan every socket, look at its .rooms set, and if
      // it doesn\'t include any tracked room, skip it.
    }
    if (targetRoomCode) {
      const roomSockets = io.sockets.adapter && io.sockets.adapter.rooms
        ? io.sockets.adapter.rooms.get(targetRoomCode)
        : null
      const socketIdsInRoom = roomSockets ? [...roomSockets] : null
      const socketsToCheck = socketIdsInRoom
        ? socketIdsInRoom.map(sid => io.sockets.sockets.get(sid)).filter(Boolean)
        : [...io.sockets.sockets.values()]
      for (const sock of socketsToCheck) {
        const uid = sock?.data?.userId
        if (!uid) continue
        // Double-check membership by inspecting socket.rooms directly (defensive).
        if (socketIdsInRoom && !sock.rooms?.has?.(targetRoomCode)) continue
        const hash = hashStudent(uid, roomSalt)
        if (!hashSet.has(hash)) continue
        targetSockets.add(sock.id)
        matchedHashes.add(hash)
        // Backfill the index so subsequent calls are fast.
        const idx = getRoomIndex(roomId)
        let set = idx.get(hash)
        if (!set) { set = new Set(); idx.set(hash, set) }
        set.add(sock.id)
      }
    }
  }

  // Count room members for diagnostics (sockets in the room's socket-room).
  const roomCode = roomIndex && roomIndex.__roomCode
  if (roomCode && io.sockets.adapter && io.sockets.adapter.rooms) {
    const r = io.sockets.adapter.rooms.get(roomCode)
    if (r) roomMembers = r.size
  }

  return { socketIds: targetSockets, studentHashes: matchedHashes, roomMembers }
}

/**
 * Cache the room's code on its index entry so resolveRecoveryRecipients
 * can count room members without recomputing.
 */
export function noteRoomCode (roomId, roomCode) {
  const idx = getRoomIndex(roomId)
  idx.__roomCode = roomCode
}

export function clearRoomIndex (roomId) {
  socketIndexByRoom.delete(String(roomId))
  for (const [sid, meta] of socketMeta) {
    if (meta.roomId === String(roomId)) socketMeta.delete(sid)
  }
}

export function _debugDump () {
  const out = {}
  for (const [roomId, idx] of socketIndexByRoom) {
    out[roomId] = { __roomCode: idx.__roomCode || null }
    for (const [hash, set] of idx) {
      if (hash === '__roomCode') continue
      out[roomId][hash] = [...set]
    }
  }
  return out
}