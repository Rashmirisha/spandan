import React, { useState, useEffect, useCallback } from 'react'
import { doubtApi } from '../lib/api.js'
import { useSocketStore } from '../stores/socketStore.js'

/**
 * ConfusionSpikePanel — live view for teachers during a room session.
 *
 * Shows a real-time chart of distinct-student doubt counts per segment,
 * with the transcript snippet for each "spike" highlighted so the teacher
 * can re-explain that exact moment.
 *
 * Pure presentational + small fetch. Lifecycle controlled by parent.
 *
 * Props:
 *   - roomId
 *   - roomCode
 *   - refreshIntervalMs (default 5000)
 */
export default function ConfusionSpikePanel ({ roomId, roomCode, refreshIntervalMs = 5000 }) {
  const socket = useSocketStore(s => s.socket)
  const [segments, setSegments] = useState([])
  const [spikes, setSpikes] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdate, setLastUpdate] = useState(Date.now())

  const fetchSpikes = useCallback(async () => {
    if (!roomId) return
    try {
      const [agg, spike] = await Promise.all([
        doubtApi.getForRoom(roomId),
        doubtApi.getSpikes(roomId)
      ])
      setSegments(agg.segments || [])
      setSpikes(spike.spikes || [])
      setStats(spike.stats || null)
      setLastUpdate(Date.now())
      setError('')
    } catch (e) {
      setError(e?.message || 'Failed to fetch doubt data')
    } finally {
      setLoading(false)
    }
  }, [roomId])

  // Initial + periodic fetch
  useEffect(() => {
    fetchSpikes()
    const t = setInterval(fetchSpikes, refreshIntervalMs)
    return () => clearInterval(t)
  }, [fetchSpikes, refreshIntervalMs])

  // Listen for live doubt:new events — increment matching segment count locally
  useEffect(() => {
    if (!socket) return
    const onNew = (data) => {
      if (String(data.roomId) !== String(roomId)) return
      setSegments(prev => {
        const idx = prev.findIndex(s => s.segmentIndex === data.segmentIndex)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], count: data.count }
          return next
        }
        return [...prev, { segmentIndex: data.segmentIndex, count: data.count }].sort((a, b) => a.segmentIndex - b.segmentIndex)
      })
      setLastUpdate(Date.now())
      // Re-fetch spikes so the highlighted list updates too
      doubtApi.getSpikes(roomId).then(s => {
        setSpikes(s.spikes || [])
        setStats(s.stats || null)
      }).catch(() => {})
    }
    socket.on('doubt:new', onNew)
    return () => socket.off('doubt:new', onNew)
  }, [socket, roomId])

  const maxCount = Math.max(1, ...segments.map(s => s.count))

  return (
    <div className="csp-panel" role="region" aria-label="Live confusion signals">
      <div className="csp-header">
        <h3>🚩 Confusion signals</h3>
        <span className="csp-meta" title={`Last update ${new Date(lastUpdate).toLocaleTimeString()}`}>
          {loading ? 'Loading…' : `${segments.length} segment${segments.length === 1 ? '' : 's'} · ${segments.reduce((a, s) => a + s.count, 0)} total`}
        </span>
      </div>

      {error && <div className="csp-error">{error}</div>}

      {!loading && segments.length === 0 && (
        <div className="csp-empty">No signals yet. When a student taps "I'm lost", they'll show up here.</div>
      )}

      {segments.length > 0 && (
        <div className="csp-chart" aria-label="Doubt count per segment">
          {segments.map(s => {
            const isSpike = spikes.some(sp => sp.segmentIndex === s.segmentIndex)
            const heightPct = (s.count / maxCount) * 100
            return (
              <div key={s.segmentIndex} className={`csp-bar-wrap${isSpike ? ' csp-bar-wrap--spike' : ''}`}>
                <div className="csp-bar" style={{ height: `${heightPct}%` }}>
                  <span className="csp-bar-count">{s.count}</span>
                </div>
                <div className="csp-bar-label">S{s.segmentIndex}</div>
              </div>
            )
          })}
        </div>
      )}

      {stats && (
        <div className="csp-stats">
          mean {stats.mean.toFixed(1)} · σ {stats.stddev.toFixed(1)} · threshold {stats.threshold.toFixed(1)}
        </div>
      )}

      {spikes.length > 0 && (
        <div className="csp-spikes">
          <div className="csp-spikes-title">⚠ Confusion spikes</div>
          {spikes.map(s => (
            <div key={s.segmentIndex} className="csp-spike">
              <div className="csp-spike-head">
                <span className="csp-spike-seg">Segment {s.segmentIndex}</span>
                <span className="csp-spike-count">{s.count} student{s.count === 1 ? '' : 's'}</span>
              </div>
              {s.transcriptSnippet && (
                <div className="csp-spike-snippet">"{s.transcriptSnippet}…"</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}