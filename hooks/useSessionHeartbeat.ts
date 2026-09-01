// Fires POST /api/game/session/heartbeat on mount and on every completed route change,
// throttled to at most once per GAME.SESSION_HEARTBEAT_MIN_INTERVAL_MS (60s). Phase 5
// server-side replacement for persisted-state/useSessionTrackingState.ts's
// localStorage-only session tracking — see docs/OFFCHAIN_QRACING_PLAN.md, Phase 5.
//
// SSR-safe: everything runs inside a useEffect (no-op during server render/build), and
// the heartbeat itself is fire-and-forget/best-effort — a failed or 401'd heartbeat
// (no player cookie minted yet, DB unreachable) never surfaces to the user or blocks
// navigation. Reuses useOffchainRacing's memoized `ensurePlayer()` so mounting this
// app-wide (pages/_app.tsx) doesn't race a second player-cookie mint against the
// racing page's own bootstrap.

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/router'

import { GAME } from '@/lib/game/config'
import { ensurePlayer } from '@/hooks/useOffchainRacing'

async function fireHeartbeat(page: string): Promise<void> {
  try {
    await ensurePlayer()
    await fetch('/api/game/session/heartbeat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page }),
    })
  } catch {
    // Best-effort — see file header.
  }
}

export function useSessionHeartbeat(): void {
  const router = useRouter()
  const lastFiredAtRef = useRef(0)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const maybeFire = (page: string) => {
      const now = Date.now()
      if (now - lastFiredAtRef.current < GAME.SESSION_HEARTBEAT_MIN_INTERVAL_MS) return
      lastFiredAtRef.current = now
      void fireHeartbeat(page)
    }

    maybeFire(router.asPath)

    const handleRouteChangeComplete = (url: string) => maybeFire(url)
    router.events.on('routeChangeComplete', handleRouteChangeComplete)
    return () => {
      router.events.off('routeChangeComplete', handleRouteChangeComplete)
    }
    // router.asPath is intentionally not a dependency: this effect wires up
    // router.events exactly once per mount and only reads the live asPath for the
    // initial-mount fire, same pattern as hooks/usePerformanceMetrics.ts's mount-once guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.events])
}

export default useSessionHeartbeat
