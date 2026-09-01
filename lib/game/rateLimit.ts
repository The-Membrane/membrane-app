// DB-backed fixed-window rate limiting for the offchain Q-Racing API routes.
// See docs/OFFCHAIN_QRACING_PLAN.md, Phase 3 ("Abuse limits").
//
// Deployment target is Vercel serverless: each invocation is a fresh process with no shared
// memory, so an in-memory token bucket / counter is silently a no-op there (every request
// sees count=0). Every limit must therefore live in Postgres and be enforced with a single
// atomic statement — a plain "read count, check, write count+1" from a serverless function
// races with itself under concurrent invocations and undercounts.

import { sql } from 'drizzle-orm'
import type { NextApiRequest } from 'next'

import { db } from '@/db'

if (typeof window !== 'undefined') {
  throw new Error('lib/game/rateLimit must never be imported from client-side code')
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number }

type RateLimitRow = { count: number; window_start: string }

/**
 * Atomically increments the fixed window counter for `key` and reports whether it is still
 * within `limit` for a `windowSeconds`-wide window. Implemented as a single
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING so concurrent serverless invocations for the
 * same key cannot race each other into under-counting: Postgres serializes conflicting
 * upserts on the same row, so exactly one of two simultaneous callers sees the post-increment
 * count first.
 *
 * Fixed-window (not sliding/leaky): the window resets the moment a request arrives after the
 * previous window_start has aged out past `windowSeconds`. That allows a burst at the window
 * boundary, which is an accepted tradeoff for a single-statement, DB-only implementation.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const result = await db.execute<RateLimitRow>(sql`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_start < now() - (interval '1 second' * ${windowSeconds})
        THEN 1
        ELSE rate_limits.count + 1
      END,
      window_start = CASE
        WHEN rate_limits.window_start < now() - (interval '1 second' * ${windowSeconds})
        THEN now()
        ELSE rate_limits.window_start
      END
    RETURNING count, window_start
  `)

  // Opportunistic cleanup on ~1% of calls: delete rows whose window aged out at least twice
  // over. Best-effort and never allowed to affect the rate-limit decision above — a failure
  // here (e.g. a transient network blip) must not turn into a false rate_limited response.
  if (Math.random() < 0.01) {
    try {
      await db.execute(sql`
        DELETE FROM rate_limits
        WHERE window_start < now() - (interval '1 second' * ${windowSeconds * 2})
      `)
    } catch {
      // Ignore — cleanup is a housekeeping nicety, not correctness-load-bearing.
    }
  }

  const row = result.rows[0]
  const count = Number(row?.count ?? 0)

  if (count > limit) {
    const windowStart = row?.window_start ? new Date(row.window_start) : new Date()
    const elapsedSeconds = Math.floor((Date.now() - windowStart.getTime()) / 1000)
    const retryAfterSeconds = Math.max(1, windowSeconds - elapsedSeconds)
    return { allowed: false, retryAfterSeconds }
  }

  return { allowed: true }
}

/**
 * Client IP for rate-limit keying. Vercel sets x-forwarded-for with the true client as the
 * first hop (convention: the edge appends its own hops after the original client address —
 * see Vercel's "Retrieving the client IP address" docs), so we take the first entry rather
 * than the last. Falls back to the raw socket address for local dev, where there is no proxy
 * and no x-forwarded-for header at all.
 */
export function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (header) {
    const first = header.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket?.remoteAddress ?? 'unknown'
}
