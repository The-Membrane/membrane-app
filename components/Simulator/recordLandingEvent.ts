import type { LandingVariant } from '@/lib/landingVariant'

export interface LandingEvent {
  variant: LandingVariant
  kind: 'run' | 'connect'
  chain?: string
  address?: string
  source?: 'paste' | 'wallet'
}

/**
 * Fire-and-forget: report the landing H1 test's one conversion to
 * /api/landing/event. Never awaited, never throws, never blocks the run, exactly like
 * recordRead.ts. The route hashes the address server-side; nothing is stored in the
 * clear, and a failed beacon costs the reader nothing.
 */
export function recordLandingEvent(event: LandingEvent): void {
  if (typeof window === 'undefined') return
  try {
    void fetch('/api/landing/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* measurement must never surface */
  }
}
