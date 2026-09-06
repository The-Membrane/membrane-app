import type { NextApiRequest, NextApiResponse } from 'next'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { getAddress, isAddress, verifyMessage } from 'viem'

import { db } from '@/db'
import { userReceipts } from '@/db/schema'
import {
  buildReceiptStatement,
  computeCalibration,
  isReceiptMetric,
  metricForKind,
  type ReceiptMetric,
} from '@/components/Receipts/receiptLogic'
import venueConfig from '@/tools/venue-recorder.config.json'

// CALLED-IT RECEIPTS (owner-approved).
//
//  POST — record a WALLET-BOUND probability call. The caller supplies the numeric
//    fields + an EIP-191 signature; the server REBUILDS the canonical statement
//    from those fields (never trusts a client-supplied string — the wrap.ts /
//    session.ts precedent), verifies the signature recovers `address`, and inserts
//    the row unscored. Open-receipt spam is capped at 5 UNSCORED per address.
//  GET ?address= — the caller's receipts (scored + open), newest first, plus a
//    calibration readout computed AT READ TIME (never stored as a badge).
//
// No leaderboard, no scoring of returns, no grade words: §7/§9.3 by construction.

const MAX_OPEN_PER_ADDRESS = 5
const TS_SKEW_MS = 10 * 60 * 1000 // made_at must be within ±10min of now (no back/forward-dating)
const MIN_HORIZON_HOURS = 1
const MAX_HORIZON_HOURS = 30 * 24 // 30 days
const MARKET_REF_MAX = 200

type VenueEntry = { name: string; kind: string; enabled?: boolean }
const VENUES = (venueConfig.venues as VenueEntry[]).filter((v) => v.enabled)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getReceipts(req, res)
  if (req.method === 'POST') return postReceipt(req, res)
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
}

async function getReceipts(req: NextApiRequest, res: NextApiResponse) {
  const addrStr = typeof req.query.address === 'string' ? req.query.address : ''
  if (!isAddress(addrStr)) return res.status(400).json({ error: 'invalid address' })
  const address = getAddress(addrStr)

  const rows = await db
    .select()
    .from(userReceipts)
    .where(eq(userReceipts.address, address))
    .orderBy(desc(userReceipts.madeAt))

  const receipts = rows.map(shapeReceipt)
  const calibration = computeCalibration(
    receipts
      .filter((r) => r.scored_at !== null && typeof r.hit === 'boolean')
      .map((r) => ({ probabilityPct: r.probability_pct, hit: r.hit as boolean })),
  )

  res.setHeader('Cache-Control', 'private, max-age=15')
  return res.status(200).json({ address, receipts, calibration })
}

async function postReceipt(req: NextApiRequest, res: NextApiResponse) {
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body ?? {}

  // --- address --------------------------------------------------------------
  if (typeof body.address !== 'string' || !isAddress(body.address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const address = getAddress(body.address)

  // --- venue + metric (metric must match the venue's kind) -------------------
  const venue = VENUES.find((v) => v.name === body.venue)
  if (!venue) return res.status(400).json({ error: 'unknown or disabled venue' })
  if (!isReceiptMetric(body.metric)) return res.status(400).json({ error: 'invalid metric' })
  const metric = body.metric as ReceiptMetric
  if (metricForKind(venue.kind) !== metric) {
    return res.status(400).json({ error: `metric '${metric}' not valid for venue kind '${venue.kind}'` })
  }

  // --- band -----------------------------------------------------------------
  const bandLow = Number(body.bandLow)
  const bandHigh = Number(body.bandHigh)
  if (!Number.isFinite(bandLow) || !Number.isFinite(bandHigh) || bandLow <= 0 || bandHigh <= 0) {
    return res.status(400).json({ error: 'band bounds must be positive numbers' })
  }
  if (!(bandLow < bandHigh)) {
    return res.status(400).json({ error: 'band_low must be less than band_high' })
  }

  // --- confidence -----------------------------------------------------------
  const probabilityPct = Number(body.probabilityPct)
  if (!Number.isInteger(probabilityPct) || probabilityPct < 1 || probabilityPct > 99) {
    return res.status(400).json({ error: 'probability_pct must be an integer 1-99' })
  }

  // --- horizon --------------------------------------------------------------
  const horizonHours = Number(body.horizonHours)
  if (
    !Number.isInteger(horizonHours) ||
    horizonHours < MIN_HORIZON_HOURS ||
    horizonHours > MAX_HORIZON_HOURS
  ) {
    return res.status(400).json({ error: 'horizon_hours out of range (1h–30d)' })
  }

  // --- made_at (bounded to now so a call can't be back/forward-dated) --------
  if (typeof body.madeAt !== 'string') return res.status(400).json({ error: 'madeAt required' })
  const madeAtMs = Date.parse(body.madeAt)
  if (!Number.isFinite(madeAtMs)) return res.status(400).json({ error: 'madeAt not a valid timestamp' })
  if (Math.abs(Date.now() - madeAtMs) > TS_SKEW_MS) {
    return res.status(400).json({ error: 'madeAt must be within 10 minutes of now' })
  }
  const madeAt = new Date(madeAtMs)

  // --- market_ref (optional, NULLABLE placeholder — no Trueo behaviour now) ---
  let marketRef: string | null = null
  if (body.marketRef != null) {
    if (typeof body.marketRef !== 'string') return res.status(400).json({ error: 'market_ref must be a string' })
    const t = body.marketRef.trim().slice(0, MARKET_REF_MAX)
    marketRef = t.length > 0 ? t : null
  }

  // --- signature: rebuild the canonical statement and verify it recovers -----
  //     the claimed address. The stored statement is the SERVER-built one.
  const statement = buildReceiptStatement({
    venue: venue.name,
    metric,
    bandLow,
    bandHigh,
    probabilityPct,
    horizonHours,
    madeAt: madeAt.toISOString(),
  })
  const signature = typeof body.signature === 'string' ? body.signature : ''
  if (!signature) return res.status(400).json({ error: 'signature required' })
  let valid = false
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message: statement,
      signature: signature as `0x${string}`,
    })
  } catch {
    valid = false
  }
  if (!valid) return res.status(401).json({ error: 'signature does not match address for this statement' })

  // --- cap: max 5 UNSCORED receipts per address ------------------------------
  const [{ open }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(userReceipts)
    .where(and(eq(userReceipts.address, address), isNull(userReceipts.scoredAt)))
  if (open >= MAX_OPEN_PER_ADDRESS) {
    return res
      .status(429)
      .json({ error: `too many open receipts (max ${MAX_OPEN_PER_ADDRESS} unscored); wait for some to score` })
  }

  // --- insert (unscored) -----------------------------------------------------
  const [row] = await db
    .insert(userReceipts)
    .values({
      address,
      venue: venue.name,
      metric,
      statement,
      bandLow: String(bandLow),
      bandHigh: String(bandHigh),
      probabilityPct,
      horizonHours,
      madeAt,
      signature,
      marketRef,
    })
    .returning()

  return res.status(200).json({ receipt: shapeReceipt(row) })
}

// Shape a DB row for the client (numeric columns arrive as strings from
// neon-http; convert the ones the UI does arithmetic / display on).
function shapeReceipt(r: typeof userReceipts.$inferSelect) {
  return {
    id: r.id,
    address: r.address,
    venue: r.venue,
    metric: r.metric as ReceiptMetric,
    statement: r.statement,
    band_low: Number(r.bandLow),
    band_high: Number(r.bandHigh),
    probability_pct: r.probabilityPct,
    horizon_hours: r.horizonHours,
    made_at: new Date(r.madeAt as unknown as string).toISOString(),
    market_ref: r.marketRef ?? null,
    realized: r.realized === null ? null : Number(r.realized),
    scored_at: r.scoredAt ? new Date(r.scoredAt as unknown as string).toISOString() : null,
    hit: r.hit === null ? null : (r.hit as boolean),
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
