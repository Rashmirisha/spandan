# Spandan - Local Setup

Private project, internal use only.

## TL;DR

Double-click `start.ps1` (or run it from PowerShell). Open `http://localhost:5173/spandan/`. That's it.

## What `start.ps1` does

1. Checks MongoDB on `:27017`. Starts it if down.
2. Starts backend (`node src/index.js`) on `:3001`. Reuses if already running.
3. Starts frontend (`npm run dev`) on `:5173`. Reuses if already running.

Each service writes to `%TEMP%\spandan-{mongo,backend,frontend}.log`.

## Login credentials (all `Test1234!`)

| Role | Email |
|------|-------|
| Teacher | `rashmi@spandan.local` |
| Teacher (alt) | `test@spandan.local` |
| Student | `student@spandan.local` |
| Student (alt) | `student2@spandan.local` |

## Manual commands (if scripts fail)

```powershell
# MongoDB (one-time per Windows session, leave running)
"C:\Program Files\MongoDB\Server\7.0\bin\mongod.exe" --dbpath C:\data\db

# Backend
cd C:\Users\ajith\Desktop\spandan-fresh-archived-2026-07-12\backend
node src/index.js

# Frontend
cd C:\Users\ajith\Desktop\spandan-fresh-archived-2026-07-12\frontend
npm run dev
```

## Stop services

```powershell
.\stop.ps1
```

Or manually:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src/index.js*' -or $_.CommandLine -like '*vite*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Troubleshooting

### "localhost refused to connect" / ERR_CONNECTION_REFUSED

A service died. Run `start.ps1` again. It will only restart what's missing.

To check what's running:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CreationDate, CommandLine
```

If you see `src/index.js` with `CreationDate` older than your code change, that backend is stale. Restart it:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src/index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### "127.0.0.1 refused to connect" but localhost works

Vite binds to IPv6 (`::1`) by default. Use `http://localhost:5173/spandan/`. `http://127.0.0.1:5173/` will not work.

### Browser shows old code after editing `RoomDetailPage.jsx`

Vite HMR catches most changes automatically. If not, hard-refresh (Ctrl+Shift+R).

### Auto-topic shows "General confusion"

Backend logs show `MINIMAX_API_KEY` is returning 401. Either:
- Rotate the key in `backend/.env` (recommended)
- Live with the heuristic fallback (less accurate)

### Tests

```powershell
cd backend
npm test -- --runInBand
```
