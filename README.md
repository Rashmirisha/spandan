# Spandan - Poll Question Generator

> A real-time polling and question generation platform for classrooms and presentations.

**Version:** 0.8.0

## Features

- 🔐 **Authentication** — JWT-based login with role-based access (Teacher/Student)
- 🎯 **Room Management** — Create, join, and manage live polling sessions
- ❓ **Question Types** — Multiple choice and open-ended questions with approval workflow
- 📊 **Real-time Results** — Live response tracking with Socket.IO
- 🚩 **Doubt-Anchored Polling** — Anonymous "I'm lost" button on student screens, anchored to transcript segments so the teacher sees *which* moment confused the class. See [docs/doubt-anchored-polling.md](docs/doubt-anchored-polling.md) for design.
- 🎙 **Transcription** — Whisper-powered audio transcription for question generation
- 🌗 **Theme Toggle** — Dark and light mode support
- 📱 **Responsive** — Works across devices with teacher and student dashboards

## Doubt-Anchored Polling (new)

Students press a squishy flag in the top-right corner when they lose the
thread. The teacher sees counts per transcript segment and a list of
**confusion spikes** — segments where mark-count crosses a floor (3) or
the room's statistical threshold (mean + 2σ). Each spike card carries
the actual transcript snippet so the teacher can re-explain that exact
moment.

**Privacy:** signals are anonymized with HMAC-SHA256 against a per-room
salt; raw userIds are never stored. See the
[design doc](docs/doubt-anchored-polling.md) for the math, the
anti-spam window, and what's deliberately not built yet.

## Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | React, Vite, TailwindCSS, Zustand, Socket.IO Client, React Router |
| **Backend** | Node.js, Express, Socket.IO, MongoDB (Mongoose), Whisper (Transformers) |
| **Auth** | JWT, bcryptjs |
| **AI** | Xenova Transformers (Whisper for transcription) |
| **Testing** | Jest + in-memory MongoDB (`@shelf/jest-mongodb`) |

## Quick Start

```bash
# Install all dependencies
npm run install:all

# Run development (both frontend and backend)
npm run dev

# Run backend tests
cd backend && npm test

# Run backend tests for the Doubt-Anchored Polling feature
cd backend && npx jest src/__tests__/doubtService.test.js

# Build frontend
npm run build
```

## Project Structure

```
spandan/
├── docs/
│   └── doubt-anchored-polling.md   # Design doc for the new feature
├── frontend/                       # React app (Vite)
│   └── src/
│       ├── components/             # UI components (incl. ImLostButton, ConfusionSpikePanel)
│       ├── pages/                  # Page components
│       ├── stores/                 # Zustand stores
│       ├── lib/
│       │   ├── api.js              # REST client (incl. doubtApi namespace)
│       │   └── sounds.js           # Web Audio API cues for the doubt button
│       └── themes.css
├── backend/                        # Express API
│   └── src/
│       ├── models/                 # Mongoose schemas (incl. DoubtSignal)
│       ├── routes/                 # API routes (incl. doubts.js)
│       ├── services/               # Business logic (incl. doubtService.js)
│       ├── __tests__/              # Jest tests (incl. doubtService.test.js)
│       └── index.js                # Entry point
└── package.json                    # Monorepo root
```

## Environment

Copy `.env.example` to `.env` in the backend folder and configure as needed.

```env
PORT=3001
MONGODB_URI=mongodb://localhost:27017/spandan
JWT_SECRET=***
```

## Roles

| Role | Capabilities |
|------|--------------|
| **Teacher** | Create rooms, manage questions, approve responses, view live doubt signals + confusion spikes |
| **Student** | Join rooms, answer questions, signal confusion anonymously |

## Testing

```bash
cd backend
npm test                          # all tests
npm run test:coverage             # with coverage report
```

The Doubt-Anchored Polling service has 28 unit tests covering the hash,
anti-spam, retraction, per-segment aggregation, and spike detection
math. Tests run against an in-memory MongoDB so they don't touch the
real database.

## License

Private — All rights reserved