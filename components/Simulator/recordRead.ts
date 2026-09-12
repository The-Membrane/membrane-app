import type { AdapterResult } from '@/lib/position-sim'

/**
 * Fire-and-forget: log a real-address read to /api/sim/reads so launch can measure
 * "came back", not "was seen". Never awaited, never throws, never blocks the run.
 * The worked example is never logged — the caller only fires this after a real read.
 */
export function recordSimRead(address: string, results: AdapterResult[]): void {
  if (typeof window === 'undefined') return
  const protocols = results.filter((r) => r.positions.length > 0).map((r) => r.protocol)
  try {
    void fetch('/api/sim/reads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, protocols }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* logging must never surface */
  }
}
