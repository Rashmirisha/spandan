import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { createServer } from 'http'
import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import mongoose from 'mongoose'

// Import routes
import authRoutes from './routes/auth.js'
import roomRoutes from './routes/rooms.js'
import questionRoutes from './routes/questions.js'
import transcriptionRoutes from './routes/transcription.js'
import transcriptRoutes from './routes/transcripts.js'
import responseRoutes from './routes/responses.js'
import doubtRoutes from './routes/doubts.js'
import topicRoutes from './routes/topics.js'
import confusionRoutes from './routes/confusion.js'

// Import models for reference
import './models/index.js'

dotenv.config()

const BASE_PATH = process.env.BASE_PATH || ''
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3001').split(',').map(s => s.trim())

// Request timeout middleware - defined BEFORE use due to hoisting
const requestTimeout = (req, res, next) => {
  // Set a 30-second timeout for all requests
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timeout', message: 'The request took too long to process' })
    }
  })
  
  // Also set server-side timeout for the response
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Response timeout', message: 'The response took too long to generate' })
    }
  })
  
  next()
}

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Socket.IO polling)
      if (!origin) return callback(null, true)
      // Allow if origin is in the explicit CORS_ORIGINS list
      if (CORS_ORIGINS.includes(origin)) return callback(null, true)
      // Allow any localhost origin (covers localhost:5173, :8080, :3001, etc.)
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return callback(null, true)
      }
      callback(new Error('Not allowed by CORS'))
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
})

// Make io accessible to routes
app.set('io', io)

// Trust proxy (for rate limiting behind nginx)
app.set('trust proxy', 1)

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // limit each IP to 2000 requests per windowMs (increased for real-time classroom use)
  message: { error: 'Too many requests, please try again later' }
})

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 300, // limit each IP to 300 auth requests per hour (increased for live classroom use)
  message: { error: 'Too many authentication attempts, please try again later' }
})

const responseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000, // limit each IP to 5000 response submissions per windowMs (high limit for live quizzes)
  message: { error: 'Too many response submissions, please try again later' }
})

const leaderboardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // very high limit for leaderboard reads (refreshes on every points update during live sessions)
  message: { error: 'Too many requests, please try again later' }
})

// Middleware
app.use(helmet())
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}))
app.use(express.json({ limit: '10mb' }))
app.use('/api/', apiLimiter)           // general /api/ routes
app.use('/api/auth/', authLimiter)     // auth routes
app.use('/api/responses/', responseLimiter)  // response submission routes
app.use('/api/responses/leaderboard/', leaderboardLimiter)  // leaderboard routes (high limit for live sessions)

// Apply timeout middleware before routes
app.use(requestTimeout)

// API Routes
app.use('/api/auth', authRoutes)
app.use('/api/rooms', roomRoutes)
app.use('/api/questions', questionRoutes)
app.use('/api/transcription', transcriptionRoutes)
app.use('/api/transcripts', transcriptRoutes)
app.use('/api/responses', responseRoutes)
app.use('/api/doubts', doubtRoutes)
app.use('/api/topics', topicRoutes)
app.use('/api/confusion', confusionRoutes)

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '0.5.0',
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  })
})

// Socket.IO connection handling
const connectedUsers = new Map() // socket.id -> userId

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id)

  // Authenticate socket
  socket.on('authenticate', (data) => {
    try {
      if (!data.token) {
        socket.emit('authenticated', { success: false, error: 'No token provided' })
        return
      }
      const decoded = jwt.verify(data.token, process.env.JWT_SECRET || 'your-secret-key-change-in-production')
      connectedUsers.set(socket.id, decoded.userId)
      socket.emit('authenticated', { success: true })
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        socket.emit('authenticated', { success: false, error: 'Token expired', expired: true })
      } else {
        socket.emit('authenticated', { success: false, error: 'Invalid token' })
      }
    }
  })

  // Join room
  socket.on('room:join', async ({ roomCode, userId }) => {
    try {
      const Room = (await import('./models/Room.js')).default
      const User = (await import('./models/User.js')).default
      const RoomMember = (await import('./models/RoomMember.js')).default
      
      socket.join(roomCode)
      console.log(`Client ${socket.id} (user: ${userId}) joining room ${roomCode}`)
      
      // Find user and room
      const user = await User.findById(userId)
      const room = await Room.findByCode(roomCode)
      
      let participantCount = 0
      
      if (user && room) {
        // Only students get added to RoomMember (not teachers)
        if (user.role === 'student') {
          // Upsert: add student to room members if not already there
          await RoomMember.findOneAndUpdate(
            { roomId: room._id, studentId: user._id },
            { roomId: room._id, studentId: user._id, joinedAt: new Date() },
            { upsert: true, new: true }
          )
          console.log(`Student ${userId} added to room members for room ${roomCode}`)
        }
        
        // Count participants from RoomMember (excludes teacher)
        const memberCount = await RoomMember.countDocuments({ roomId: room._id })
        participantCount = memberCount
      }
      
      io.to(roomCode).emit('room:joined', { 
        roomCode, 
        userId,
        participants: participantCount 
      })
    } catch (error) {
      console.error('Error in room:join:', error)
      io.to(roomCode).emit('room:joined', { 
        roomCode, 
        userId,
        participants: 0 
      })
    }
  })

  // Leave room
  socket.on('room:leave', async ({ roomCode, userId }) => {
    try {
      const Room = (await import('./models/Room.js')).default
      const User = (await import('./models/User.js')).default
      const RoomMember = (await import('./models/RoomMember.js')).default
      
      socket.leave(roomCode)
      console.log(`Client ${socket.id} (user: ${userId}) left room ${roomCode}`)
      
      const user = await User.findById(userId)
      const room = await Room.findByCode(roomCode)
      
      let participantCount = 0
      
      if (user && room && user.role === 'student') {
        // Remove student from room members
        await RoomMember.deleteOne({ roomId: room._id, studentId: user._id })
        
        // Recount remaining participants
        participantCount = await RoomMember.countDocuments({ roomId: room._id })
      }
      
      io.to(roomCode).emit('room:left', { 
        roomCode,
        participants: participantCount 
      })
    } catch (error) {
      console.error('Error in room:leave:', error)
      io.to(roomCode).emit('room:left', { 
        roomCode,
        participants: 0 
      })
    }
  })

  // Submit response (real-time)
  socket.on('response:submit', (data) => {
    io.to(data.roomCode).emit('response:new', {
      questionId: data.questionId,
      studentId: data.studentId,
      selectedOption: data.selectedOption,
      responseTime: data.responseTime
    })
  })

  // Points update event (emitted after response is saved with calculated points)
  socket.on('points:update', (data) => {
    io.to(data.roomCode).emit('points:updated', {
      questionId: data.questionId,
      studentId: data.studentId,
      points: data.points,
      isCorrect: data.isCorrect
    })
  })

  // Question events
  socket.on('question:start', async (data) => {
    // Poll boundary: close any active ConfusionEvent + clear its feedback
    // tally for this room, and update the anti-spam marker so prior signals
    // no longer block clicks on this new poll. Best-effort — we still emit
    // the event even if the reset fails so the poll UX is never blocked.
    if (data && data.roomCode) {
      try {
        const { resetPollStateForRoom } = await import('./services/confusionEventService.js')
        const { markPollStarted } = await import('./services/doubtService.js')
        const { Room } = await import('./models/index.js')
        const room = await Room.findOne({ code: data.roomCode }).select('_id').lean()
        if (room) {
          await resetPollStateForRoom(room._id)
          markPollStarted(room._id)
          io.to(data.roomCode).emit('poll:reset', { roomId: String(room._id) })
        }
      } catch (e) {
        console.warn('[socket] poll reset on question:start failed:', e.message)
      }
    }
    io.to(data.roomCode).emit('question:started', {
      questionId: data.questionId,
      question: data.question,
      timer: data.timer,
      startTime: Date.now()
    })
  })

  socket.on('question:end', (data) => {
    io.to(data.roomCode).emit('question:ended', {
      questionId: data.questionId,
      results: data.results
    })
  })

  // New question from teacher (manually created)
  socket.on('new_question', async (data) => {
    console.log('New question received from teacher:', data.question?.question?.substring(0, 50))
    const roomCode = data.roomCode
    const question = data.question
    if (roomCode && question) {
      // Same poll-boundary reset as 'question:start' — see comment above.
      try {
        const { resetPollStateForRoom } = await import('./services/confusionEventService.js')
        const { markPollStarted } = await import('./services/doubtService.js')
        const { Room } = await import('./models/index.js')
        const room = await Room.findOne({ code: roomCode }).select('_id').lean()
        if (room) {
          await resetPollStateForRoom(room._id)
          markPollStarted(room._id)
          io.to(roomCode).emit('poll:reset', { roomId: String(room._id) })
        }
      } catch (e) {
        console.warn('[socket] poll reset on new_question failed:', e.message)
      }
      io.to(roomCode).emit('new_question', question)
    } else {
      console.error('new_question event missing roomCode or question:', data)
    }
  })

  // Leaderboard update
  socket.on('leaderboard:update', (data) => {
    io.to(data.roomCode).emit('leaderboard:updated', data)
  })

  // Contextual Doubt-Anchored Polling: real-time student signal
  socket.on('doubt:signal', async (data) => {
    try {
      if (!data || !data.roomId || !data.roomCode) return
      const userId = connectedUsers.get(socket.id)
      if (!userId) return
      const { recordDoubt, broadcastRecordedDoubt } = await import('./services/doubtService.js')
      const { Room } = await import('./models/index.js')
      const result = await recordDoubt({
        roomId: data.roomId,
        userId,
        segmentIndex: data.segmentIndex || 0,
        transcriptOffsetMs: data.transcriptOffsetMs || 0,
        recordingOffsetMs: typeof data.recordingOffsetMs === 'number' ? data.recordingOffsetMs : null,
        utteranceSnapshot: data.utteranceSnapshot || '',
        clientSentAt: data.clientSentAt || null,
        client: 'socket'
      })
      if (!result.ok) {
        socket.emit('doubt:ignored', { reason: result.reason, retryAfterMs: result.retryAfterMs })
        return
      }
      // Load the minimal Room fields needed for room-based broadcasting so
      // broadcastRecordedDoubt() can emit to the right socket.io room.
      // (HTTP route already has this loaded from its authorization check.)
      const room = await Room.findById(data.roomId).select('_id code')
      if (!room) return
      // Shared broadcast step — identical to HTTP POST /api/doubts:
      // emits doubt:new, then confusion:update / confusion:closed.
      await broadcastRecordedDoubt({
        io,
        room,
        userId,
        payload: data,
        signal: result.signal
      })
      socket.emit('doubt:confirmed', {
        segmentIndex: data.segmentIndex || 0,
        recordingOffsetLabel: result.signal.recordingOffsetLabel
      })
    } catch (err) {
      console.error('[socket] doubt:signal error:', err.message)
    }
  })

  // ============================================================================
  // NEW: Live position broadcast (so students know what the teacher is on)
  // ============================================================================
  socket.on('teacher:position', async (data) => {
    try {
      if (!data || !data.roomCode) return
      // Forward to everyone in the room EXCEPT the teacher themselves
      // (they don't need to see their own position broadcast)
      socket.to(data.roomCode).emit('teacher:position', {
        segmentIndex: data.segmentIndex || 0,
        transcriptOffsetMs: data.transcriptOffsetMs || 0,
        recordingOffsetMs: data.recordingOffsetMs || 0,
        recordingOffsetLabel: data.recordingOffsetLabel || '00:00',
        utterance: data.utterance || '',
        timestamp: Date.now()
      })
    } catch (err) {
      console.error('[socket] teacher:position error:', err.message)
    }
  })

  // NEW: Teacher announces the start of the recording session
  socket.on('teacher:session-start', async (data) => {
    try {
      if (!data || !data.roomId || !data.roomCode) return
      const userId = connectedUsers.get(socket.id)
      if (!userId) return
      const { startRoomSession } = await import('./services/doubtService.js')
      const result = await startRoomSession(data.roomId, userId)
      if (!result.ok) return
      // Broadcast to everyone in the room
      io.to(data.roomCode).emit('teacher:session-start', {
        roomId: String(data.roomId),
        roomStartedAt: result.roomStartedAt,
        timestamp: Date.now()
      })
    } catch (err) {
      console.error('[socket] teacher:session-start error:', err.message)
    }
  })

  // NEW: Teacher sets a topic marker -- broadcast to room so students + UI sync
  socket.on('teacher:topic-set', async (data) => {
    try {
      if (!data || !data.roomId || !data.roomCode) return
      const userId = connectedUsers.get(socket.id)
      if (!userId) return
      const { setTopic } = await import('./services/topicService.js')
      const result = await setTopic({
        roomId: data.roomId,
        teacherId: userId,
        startMs: data.startMs,
        endMs: data.endMs,
        label: data.label,
        note: data.note
      })
      if (!result.ok) return
      io.to(data.roomCode).emit('teacher:topic-set', {
        marker: result.marker
      })
    } catch (err) {
      console.error('[socket] teacher:topic-set error:', err.message)
    }
  })

  // NEW: Teacher removes a topic marker
  socket.on('teacher:topic-delete', async (data) => {
    try {
      if (!data || !data.roomId || !data.roomCode) return
      const userId = connectedUsers.get(socket.id)
      if (!userId) return
      const { deleteTopic } = await import('./services/topicService.js')
      const result = await deleteTopic({
        roomId: data.roomId,
        teacherId: userId,
        markerId: data.markerId
      })
      if (!result.ok) return
      io.to(data.roomCode).emit('teacher:topic-delete', { markerId: data.markerId })
    } catch (err) {
      console.error('[socket] teacher:topic-delete error:', err.message)
    }
  })

  socket.on('disconnect', () => {
    const userId = connectedUsers.get(socket.id)
    connectedUsers.delete(socket.id)
    console.log('Client disconnected:', socket.id, userId ? `(user: ${userId})` : '')
  })
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err)
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' })
})

// MongoDB connection
const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/spandan'
    
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    })
    
    console.log('MongoDB connected successfully')
  } catch (error) {
    console.error('MongoDB connection error:', error.message)
    console.log('Server will continue without database connection')
  }
}

const PORT = process.env.PORT || 3001

// Start server
const startServer = async () => {
  await connectDB()
  
  httpServer.listen(PORT, () => {
    console.log(`Spandan backend v0.5 running on port ${PORT}`)
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`)
  })
}

startServer().catch(console.error)

export { app, io }