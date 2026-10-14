import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { decodeCompact, type CompactReplay } from '@/lib/wavefront/stream'

import { BIN_SECONDS, WavefrontTimeline, type WavefrontFrame } from '../model'
import {
  httpPageFetcher,
  LIVE_POLL_MS,
  liveIsStale,
  LiveUnavailableError,
  pollInto,
  type PageFetcher,
} from '../live'

export const REPLAY_URL = '/data/oct10-2025/wavefront-replay.json'
/** One 10-minute step per frame while playing: the 48 h replay plays in ~23 s. */
export const PLAY_STEP_MS = 80
/** Live: how often the clock (and so staleness) is re-read without new data. */
const LIVE_CLOCK_MS = 15_000

export type WavefrontMode = 'replay' | 'live'

export interface WavefrontStreamOptions {
  mode: WavefrontMode
  /** Initial playhead (unix s); default: the end (live: now). */
  initialT?: number | null
  /** Replay only: start playing from the beginning once loaded. */
  autoPlay?: boolean
  replayUrl?: string
  /** Live only. */
  fetchPage?: PageFetcher
  pollMs?: number
}

export interface WavefrontStream {
  mode: WavefrontMode
  /** 'unavailable': live was asked for and the endpoint did not answer. */
  status: 'loading' | 'ready' | 'error' | 'unavailable'
  error: string | null
  frame: WavefrontFrame | null
  /** Playable span, unix s (live: the playhead is always the end). */
  start: number
  end: number
  t: number
  playing: boolean
  /** Scrub to t (pauses). Replay only. */
  seek: (t: number) => void
  togglePlay: () => void
  /** The replay window (replay mode), for the kicker. */
  window: { startTs: number; endTs: number } | null
  protocols: string[]
  chains: string[]
  /** Walked positions per cluster over the whole stream held (sizes the marks once). */
  clusterTotals: { name: string; count: number }[]
  /** Live: when the last poll answered (unix s). */
  updatedAt: number | null
  /** Live: no answer for 3 minutes, or the newest tick overdue (`liveIsStale`). */
  stale: boolean
  /** Live: the newest tick's time (else the last answer) — "stale since". */
  staleSince: number | null
}

const nowSec = () => Math.floor(Date.now() / 1000)

/**
 * The wavefront's data source. `replay` loads the served compact replay, decodes it with
 * lib/wavefront/stream.ts and plays it on a clock this hook owns; `live` polls
 * /api/wavefront/stream every 30 s and folds new records with the same reducer, keeping only
 * the reducer's state and the per-position index (not the records). Either way the page
 * reads one `frame`, folded by `applyRecord`.
 */
export function useWavefrontStream(opts: WavefrontStreamOptions): WavefrontStream {
  const { mode, initialT = null, autoPlay = false, replayUrl = REPLAY_URL } = opts
  const pollMs = opts.pollMs ?? LIVE_POLL_MS
  const fetchPageRef = useRef<PageFetcher>(opts.fetchPage ?? httpPageFetcher())

  const [timeline, setTimeline] = useState(() => new WavefrontTimeline())
  const [version, setVersion] = useState(0)
  const [status, setStatus] = useState<WavefrontStream['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [win, setWin] = useState<WavefrontStream['window']>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [liveNow, setLiveNow] = useState(0)
  // null = follow the end (live: always)
  const [tState, setTState] = useState<number | null>(initialT)
  const [playing, setPlaying] = useState(false)

  // Read when the replay finishes loading, not when the effect starts.
  const startRef = useRef({ initialT, autoPlay })
  startRef.current = { initialT, autoPlay }

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // ---- replay: load once per mode
  useEffect(() => {
    if (mode !== 'replay') return
    const tl = new WavefrontTimeline({ retain: true })
    setTimeline(tl)
    setStatus('loading')
    setError(null)
    let cancelled = false
    fetch(replayUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json()
      })
      .then((c: CompactReplay) => {
        if (cancelled || !mounted.current) return
        tl.append(decodeCompact(c))
        const startTs = c.window.startTs
        const endTs = c.window.startTs + c.window.stepSeconds * c.window.minutes
        setWin({ startTs, endTs })
        setVersion((v) => v + 1)
        setStatus('ready')
        const { initialT: t0, autoPlay: play } = startRef.current
        if (play && t0 == null) {
          setTState(startTs)
          setPlaying(true)
        }
      })
      .catch((e: unknown) => {
        if (cancelled || !mounted.current) return
        setError(e instanceof Error ? e.message : 'failed to load')
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [mode, replayUrl])

  // ---- live: first load, then poll; a clock re-reads staleness between polls
  useEffect(() => {
    if (mode !== 'live') return
    const tl = new WavefrontTimeline({ retain: false })
    setTimeline(tl)
    setStatus('loading')
    setError(null)
    setWin(null)
    setTState(null)
    setPlaying(false)
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    const clock = setInterval(() => setLiveNow(nowSec()), LIVE_CLOCK_MS)
    const poll = async (first: boolean) => {
      try {
        // stream mode: the reducer folds (and validates) every record as it is appended
        const added = await pollInto(tl, fetchPageRef.current)
        if (cancelled || !mounted.current) return
        setUpdatedAt(nowSec())
        setLiveNow(nowSec())
        if (added > 0 || first) setVersion((v) => v + 1)
        setStatus('ready')
      } catch (e: unknown) {
        if (cancelled || !mounted.current) return
        setError(e instanceof Error ? e.message : 'live stream unavailable')
        // No first answer, or a record the reducer refuses: not live. A later network or
        // HTTP failure keeps what was folded and goes stale.
        const transient = e instanceof TypeError || e instanceof LiveUnavailableError
        if (first || !transient) setStatus('unavailable')
        setLiveNow(nowSec())
      }
    }
    poll(true).then(() => {
      if (cancelled) return
      timer = setInterval(() => poll(false), pollMs)
    })
    return () => {
      cancelled = true
      clearInterval(clock)
      if (timer) clearInterval(timer)
    }
  }, [mode, pollMs])

  // ---- the playable span
  const { start, end } = useMemo(() => {
    if (mode === 'replay') {
      return win ? { start: win.startTs, end: win.endTs } : { start: 0, end: 0 }
    }
    const first = timeline.firstTs
    const last = timeline.lastTs
    const e = Math.max(liveNow, last !== null ? last + 1 : 0)
    const s = first !== null ? Math.floor(first / BIN_SECONDS) * BIN_SECONDS : e
    return { start: s, end: e }
    // version: the timeline grew
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, win, timeline, version, liveNow])

  const t = mode === 'live' || tState === null ? end : Math.min(end, Math.max(start, tState))
  const tRef = useRef(t)
  tRef.current = t

  // ---- play clock (replay)
  useEffect(() => {
    if (!playing || mode !== 'replay') return
    const id = setInterval(() => {
      const next = tRef.current + BIN_SECONDS
      if (next >= end) {
        setTState(end)
        setPlaying(false)
      } else {
        setTState(next)
      }
    }, PLAY_STEP_MS)
    return () => clearInterval(id)
  }, [playing, end, mode])

  const seek = useCallback(
    (to: number) => {
      if (mode !== 'replay') return
      setPlaying(false)
      setTState(to)
    },
    [mode],
  )

  const togglePlay = useCallback(() => {
    if (mode !== 'replay') return
    if (playing) {
      setPlaying(false)
      return
    }
    if (tRef.current >= end) setTState(start)
    setPlaying(true)
  }, [mode, playing, start, end])

  const frame = useMemo(() => {
    // An empty live stream is a valid frame (nothing liquidated yet).
    if (status !== 'ready') return null
    try {
      return timeline.frameAt(t)
    } catch {
      return null
    }
    // version: the timeline grew
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, timeline, version, t])

  const clusterTotals = useMemo(
    () => timeline.clusterTotals().map((count, i) => ({ name: timeline.clusterNames[i], count })),
    // version: the timeline grew
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, version],
  )

  const lastTickTs = timeline.lastTickTs
  const stale = mode === 'live' && status === 'ready' && liveIsStale(liveNow, updatedAt, lastTickTs)

  return {
    mode,
    status,
    error,
    frame,
    start,
    end,
    t,
    playing,
    seek,
    togglePlay,
    window: win,
    protocols: [...timeline.protocols],
    chains: [...timeline.chains],
    clusterTotals,
    updatedAt,
    stale,
    staleSince: lastTickTs ?? updatedAt,
  }
}
