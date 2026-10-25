/**
 * A light per-key fixed-window limiter, in memory (pages/api/landing/event.ts
 * precedent). Per lambda instance, so it slows spam and enumeration rather than
 * stopping a distributed attacker — the 256-bit feed token is what protects a feed.
 */

export type RateLimiter = (key: string, nowMs?: number) => boolean

export function createRateLimiter(opts: { limit: number; windowMs: number; sweepAt?: number }): RateLimiter {
  const buckets = new Map<string, { count: number; startedAt: number }>()
  const sweepAt = opts.sweepAt ?? 5_000
  return (key, nowMs = Date.now()) => {
    if (buckets.size > sweepAt) {
      for (const [k, b] of buckets) if (nowMs - b.startedAt >= opts.windowMs) buckets.delete(k)
    }
    const b = buckets.get(key)
    if (!b || nowMs - b.startedAt >= opts.windowMs) {
      buckets.set(key, { count: 1, startedAt: nowMs })
      return false
    }
    b.count += 1
    return b.count > opts.limit
  }
}

/** The caller's IP: the first x-forwarded-for hop (Vercel sets it), else the socket. */
export function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const xff = req.headers['x-forwarded-for']
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim()
  return first || req.socket?.remoteAddress || 'unknown'
}
