import { createHash } from 'node:crypto'

import { sql } from 'drizzle-orm'
import type { NextApiRequest, NextApiResponse } from 'next'
import { isAddress, getAddress } from 'viem'

import { db } from '@/db'
import { isLandingVariant } from '@/lib/landingVariant'

/**
 * THE LANDING H1 TEST — the event sink (owner ruling 2026-09-15).
 *
 * The landing page renders one of two headlines, B or C, chosen server-side
 * (lib/landingVariant.ts). This route records the ONE conversion the test scores: an
 * address actually run in the hero simulator, stamped with the variant that was on
 * screen above it. A page view is deliberately not an event here, because impressions
 * cannot answer "which headline gets a stranger to run their own wallet".
 *
 *   POST {variant, kind:'run'|'connect', chain?, address?, source?:'paste'|'wallet'}
 *   204 on every accepted or ignored beacon.
 *
 * PRIVACY. The address is never stored. address_hash is sha256 of the checksummed
 * address, which counts distinct runners and dedupes without holding the address;
 * ua_hash is sha256 of the user agent and exists only to key the rate limit. No IP,
 * no wallet, no clear address.
 *
 * FAILURE POSTURE. This is a beacon, not a transaction. Bad input, a rate-limit hit
 * and a database outage all return 204: a measurement problem must never surface in
 * the reader's browser or retry against the database.
 */

/** Ignore more than this many beacons per minute from one ua_hash + address_hash. */
const RATE_LIMIT = 20
const RATE_WINDOW_MS = 60_000
/** Above this many tracked keys the window is swept. Bounds the map in a long-lived lambda. */
const RATE_MAP_SWEEP_AT = 5_000

type Bucket = { count: number; startedAt: number }
const buckets = new Map<string, Bucket>()

/** True when this key has already spent its allowance inside the current minute. */
function rateLimited(key: string, now: number): boolean {
  if (buckets.size > RATE_MAP_SWEEP_AT) {
    for (const [k, b] of buckets) if (now - b.startedAt >= RATE_WINDOW_MS) buckets.delete(k)
  }
  const bucket = buckets.get(key)
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    buckets.set(key, { count: 1, startedAt: now })
    return false
  }
  bucket.count += 1
  return bucket.count > RATE_LIMIT
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function safeParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const body: Record<string, unknown> =
    typeof req.body === 'string'
      ? safeParse(req.body)
      : req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {}

  // A variant outside a|b|c is not a reader of this page; drop it without a trace.
  const variant = body.variant
  if (!isLandingVariant(variant)) return res.status(204).end()

  const kind = body.kind
  if (kind !== 'run' && kind !== 'connect') return res.status(204).end()

  const source = body.source === 'wallet' || body.source === 'paste' ? body.source : null
  const chain = str(body.chain, 32)

  const rawAddress = body.address
  const addressHash =
    typeof rawAddress === 'string' && isAddress(rawAddress) ? sha256(getAddress(rawAddress)) : null

  const ua = str(req.headers['user-agent'], 512)
  const uaHash = ua ? sha256(ua) : null
  const referrer = str(req.headers.referer, 512)

  if (rateLimited(`${uaHash ?? 'no-ua'}:${addressHash ?? 'no-address'}`, Date.now())) {
    return res.status(204).end()
  }

  try {
    await db.execute(sql`
      INSERT INTO landing_events (variant, kind, chain, address_hash, source, referrer, ua_hash)
      VALUES (${variant}, ${kind}, ${chain}, ${addressHash}, ${source}, ${referrer}, ${uaHash})`)
  } catch (e) {
    // A measurement outage stays a measurement outage. Logged for the operator,
    // invisible to the reader.
    console.warn('[landing/event] insert failed:', (e as Error)?.message)
  }

  return res.status(204).end()
}
