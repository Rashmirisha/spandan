// Verify the EXACT frontend socket flow (path=/spandan/socket.io via Vite proxy)
import { io as socketClient } from 'socket.io-client'

const TOKEN = process.argv[2]
const ROOM_CODE = process.argv[3]
if (!TOKEN || !ROOM_CODE) { console.error('usage: node verify_socket_proxy.mjs <token> <roomCode>'); process.exit(1) }

const sock = socketClient('http://localhost:5173', {
  auth: { token: TOKEN },
  path: '/spandan/socket.io',
  transports: ['websocket', 'polling'],
  timeout: 10000,
  reconnection: true
})

const events = []
sock.on('connect', () => {
  console.log('CONNECTED', sock.id)
  sock.emit('room:join', { roomCode: ROOM_CODE })
})
sock.on('room:joined', d => console.log('JOINED', d))
sock.on('teacher:topic-set', d => {
  events.push(d)
  console.log('TOPIC-SET', d?.marker?.label, 'source:', d?.marker?.source)
})
sock.on('teacher:position', d => console.log('TEACHER-POS'))
sock.on('connect_error', e => console.log('CONNECT-ERR', e.message))
sock.on('disconnect', r => console.log('DISCONNECT', r))

setTimeout(async () => {
  console.log(`test window done; events=${events.length}`)
  sock.disconnect()
  process.exit(0)
}, 8000)
