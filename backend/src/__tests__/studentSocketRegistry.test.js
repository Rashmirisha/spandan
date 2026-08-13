/**
 * Unit tests for the PR #35 recovery-prompt targeting fix.
 *
 * Verifies that resolveRecoveryRecipients returns ONLY the sockets whose
 * userId hashes to one of event.studentIds for the room's salt, never
 * sockets that are merely in the room.
 */
import { jest } from '@jest/globals'
import {
  resolveRecoveryRecipients,
  installOnIo,
  clearRoomIndex,
  noteRoomCode,
  _debugDump
} from '../services/studentSocketRegistry.js'
import { hashStudent } from '../services/doubtService.js'

const SALT_A = 'a'.repeat(64)
const SALT_B = 'b'.repeat(64)
const ROOM_A = 'roomA'
const ROOM_B = 'roomB'
const ROOMCODE_A = 'ROOMCODE_A'
const ROOMCODE_B = 'ROOMCODE_B'

function mkSocket (id, userId, roomCode) {
  const rooms = new Set([id])
  if (roomCode) rooms.add(roomCode)
  return {
    id,
    data: { userId },
    rooms
  }
}

function mkIo (sockets) {
  const socketsMap = new Map(sockets.map(s => [s.id, s]))
  const adapterRooms = new Map()
  for (const s of sockets) {
    for (const r of s.rooms) {
      if (!adapterRooms.has(r)) adapterRooms.set(r, new Set())
      adapterRooms.get(r).add(s.id)
    }
  }
  return {
    sockets: {
      sockets: socketsMap,
      adapter: { rooms: adapterRooms }
    }
  }
}

describe('studentSocketRegistry.resolveRecoveryRecipients', () => {
  beforeEach(() => {
    clearRoomIndex(ROOM_A)
    clearRoomIndex(ROOM_B)
  })

  test('returns ONLY sockets whose hash matches event.studentIds', () => {
    const userA = '00000000000000000000000a'
    const userB = '00000000000000000000000b'
    const userC = '00000000000000000000000c' // ghost (in room, not in event)

    const hashA = hashStudent(userA, SALT_A)
    const hashB = hashStudent(userB, SALT_A)

    const sockA = mkSocket('sockA', userA, ROOMCODE_A)
    const sockB = mkSocket('sockB', userB, ROOMCODE_A)
    const sockC = mkSocket('sockC', userC, ROOMCODE_A)

    const io = mkIo([sockA, sockB, sockC])
    noteRoomCode(ROOM_A, ROOMCODE_A)

    const { socketIds, studentHashes } = resolveRecoveryRecipients({
      io,
      roomId: ROOM_A,
      roomSalt: SALT_A,
      studentHashes: new Set([hashA, hashB])
    })

    expect(socketIds.has('sockA')).toBe(true)
    expect(socketIds.has('sockB')).toBe(true)
    expect(socketIds.has('sockC')).toBe(false) // ghost must be excluded
    expect(studentHashes.has(hashA)).toBe(true)
    expect(studentHashes.has(hashB)).toBe(true)
  })

  test('returns empty set when no socket hashes match', () => {
    const sockA = mkSocket('sockA', '00000000000000000000000a', ROOMCODE_A)
    const io = mkIo([sockA])
    noteRoomCode(ROOM_A, ROOMCODE_A)
    const { socketIds } = resolveRecoveryRecipients({
      io,
      roomId: ROOM_A,
      roomSalt: SALT_A,
      studentHashes: new Set(['0'.repeat(64)]) // unrelated hash
    })
    expect(socketIds.size).toBe(0)
  })

  test('different rooms use different salts — cross-room hashes do not collide', () => {
    // Same userId, but in room A (saltA) and room B (saltB).
    const userX = '000000000000000000000001'
    const hashInRoomA = hashStudent(userX, SALT_A)
    const hashInRoomB = hashStudent(userX, SALT_B)
    expect(hashInRoomA).not.toBe(hashInRoomB)

    // sockX_A is in room A; sockX_B is in room B. They are physically
    // separate sockets in this test (different socket.ids) because a single
    // socket cannot be in two rooms with two different salts at the same
    // time.
    const sockX_A = mkSocket('sockX_A', userX, ROOMCODE_A)
    const sockX_B = mkSocket('sockX_B', userX, ROOMCODE_B)
    const io = mkIo([sockX_A, sockX_B])
    noteRoomCode(ROOM_A, ROOMCODE_A)
    noteRoomCode(ROOM_B, ROOMCODE_B)

    // Targeting event in ROOM_A reaches only sockX_A
    const a = resolveRecoveryRecipients({
      io,
      roomId: ROOM_A,
      roomSalt: SALT_A,
      studentHashes: new Set([hashInRoomA])
    })
    expect([...a.socketIds].sort()).toEqual(['sockX_A'])

    // Targeting event in ROOM_B reaches only sockX_B
    const b = resolveRecoveryRecipients({
      io,
      roomId: ROOM_B,
      roomSalt: SALT_B,
      studentHashes: new Set([hashInRoomB])
    })
    expect([...b.socketIds].sort()).toEqual(['sockX_B'])
  })

  test('falls back to iterating io.sockets when the index is empty', () => {
    const userA = '00000000000000000000000a'
    const hashA = hashStudent(userA, SALT_A)
    const sockA = mkSocket('sockA', userA, ROOMCODE_A)
    const sockC = mkSocket('sockC', '00000000000000000000000c', ROOMCODE_A)
    const io = mkIo([sockA, sockC])
    noteRoomCode(ROOM_A, ROOMCODE_A)
    // Index is empty — registry should still find sockA via the fallback.
    const { socketIds } = resolveRecoveryRecipients({
      io,
      roomId: ROOM_A,
      roomSalt: SALT_A,
      studentHashes: new Set([hashA])
    })
    expect(socketIds.has('sockA')).toBe(true)
    expect(socketIds.has('sockC')).toBe(false)
  })

  test('skips sockets whose userId is missing (unauthenticated)', () => {
    const hashA = hashStudent('00000000000000000000000a', SALT_A)
    const sockAnon = { id: 'sockAnon', data: {}, rooms: new Set(['sockAnon', ROOMCODE_A]) }
    const sockA = mkSocket('sockA', '00000000000000000000000a', ROOMCODE_A)
    const io = mkIo([sockAnon, sockA])
    noteRoomCode(ROOM_A, ROOMCODE_A)
    const { socketIds } = resolveRecoveryRecipients({
      io,
      roomId: ROOM_A,
      roomSalt: SALT_A,
      studentHashes: new Set([hashA])
    })
    expect(socketIds.has('sockA')).toBe(true)
    expect(socketIds.has('sockAnon')).toBe(false)
  })

  test('anonymous: registry never exposes userIds in its return shape', () => {
    const userA = '00000000000000000000000a'
    const hashA = hashStudent(userA, SALT_A)
    const sockA = mkSocket('sockA', userA, ROOMCODE_A)
    const io = mkIo([sockA])
    noteRoomCode(ROOM_A, ROOMCODE_A)

    const result = resolveRecoveryRecipients({
      io,
      roomId: ROOM_A,
      roomSalt: SALT_A,
      studentHashes: new Set([hashA])
    })
    // No field in `result` should leak the userId.
    const flat = JSON.stringify(result)
    expect(flat).not.toContain(userA)
    // Result only contains socketIds (strings), studentHashes (HMACs),
    // and roomMembers (count). No userId field.
    expect(Object.keys(result).sort()).toEqual(['roomMembers', 'socketIds', 'studentHashes'])
  })
})