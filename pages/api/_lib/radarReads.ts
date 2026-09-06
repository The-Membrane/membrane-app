import { readFileSync } from 'fs'
import { join } from 'path'
import { createPublicClient, http, fallback, type Address, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { computeRadar, shareLine, type VenueInputs, type VenueKind, type FlowStats } from '@/components/Radar/radarLogic'
import { readUsdByVenue } from '@/scripts/lib/position-reads.mjs'

// Shared Carry Radar read path — the ONE place that turns an address into the
// full radar payload (live chain reads + recorded corpus stress). Extracted from
// pages/api/radar/[address].ts so /api/radar/watch (entry snapshot) and
// /api/radar/recap (the "entered $X → now $Y" delta) read positions IDENTICALLY,
// with no logic drift. Server-only: touches fs, the RPC, and the db.
//
// The per-address position read (balanceOf → convertToAssets) lives in the pure,
// node-safe scripts/lib/position-reads.mjs so the standalone strat scripts
// (discover-carry-strats.mjs / refresh-strat-positions.mjs) read positions the
// SAME way. The corpus fetch (readCorpus) and payload assembly (assembleRadar)
// are split out below so the Carry Strats API can serve STORED positions —
// fetching the address-independent corpus ONCE and reusing computeRadar — instead
// of doing N addresses × 4 venues of live chain reads per request.
//
// PROVENANCE DISCIPLINE (owner, docs/BRAND_CHARTS.md §4): chain reads are LIVE at
// request time; capacity + flow facts are RECORDED (never re-queried live);
// nothing is modelled beyond the stated $1/underlying stable assumption.

// ---- venue config (source of truth: tools/venue-recorder.config.json) -------
export type VenueConfig = {
  name: string
  kind: string
  address: string
  underlying?: string
  decimals?: number
  enabled: boolean
}

export function loadVenues(): VenueConfig[] {
  const raw = readFileSync(join(process.cwd(), 'tools', 'venue-recorder.config.json'), 'utf8')
  return (JSON.parse(raw).venues as VenueConfig[]).filter((v) => v.enabled)
}

// Reader-facing labels. Anything unmapped falls back to the config name.
export const LABELS: Record<string, string> = {
  'aave-v3-usde': 'Aave',
  sUSDe: 'sUSDe',
  sUSDS: 'sUSDS',
  scrvUSD: 'scrvUSD',
}

export function makeClient(): PublicClient {
  const raw = process.env.RECORDER_RPC_URL
  if (!raw) throw new Error('RECORDER_RPC_URL is not set (see .env.local)')
  const urls = raw.split(',').map((u) => u.trim()).filter(Boolean)
  const transport =
    urls.length === 1
      ? http(urls[0])
      : fallback(urls.map((u) => http(u, { timeout: 15_000 })), { rank: false })
  return createPublicClient({ chain: mainnet, transport }) as PublicClient
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

// The serialized position/comparator shapes the radar endpoints return.
export type PositionOut = {
  venue: string
  label: string
  kind: string
  usd: number
  tvl_usd: number | null
  share_of_tvl: number | null
  stress: unknown
  verdict: string
  reason: string
}
export type PerVenueProv = {
  venue: string
  flow_rows: number
  flow_span: { start: unknown; end: unknown } | null
  snapshot_rows: number
  snapshot_observed: number
  snapshot_backfilled: number
  snapshot_span: { start: unknown; end: unknown } | null
  snapshot_at: unknown
}

export type RadarPayload = {
  address: string
  total_usd: number
  held_count: number
  positions: PositionOut[]
  comparator: Array<Omit<PositionOut, 'usd' | 'tvl_usd' | 'share_of_tvl'> & { at_usd: number }>
  share_line: string
  provenance: {
    chain_reads: { at: string; method: string; price_assumption: string }
    recorded: { window: string; note: string; per_venue: PerVenueProv[] }
    modelled: null
  }
}

// The recorded, ADDRESS-INDEPENDENT corpus stress per venue plus provenance. This
// is identical for every address, so the Carry Strats API fetches it ONCE per
// request and reuses it across all tracked strats.
export type VenueCorpus = {
  tvlUsd: number | null
  instantUsd: number | null
  cooldownSeconds: number | null
  flow: FlowStats | null
}
export type Corpus = {
  byVenue: Map<string, VenueCorpus>
  perVenueProvenance: PerVenueProv[]
  window: string
}

/**
 * The RECORDED corpus stress for every configured venue: latest snapshot
 * (capacity + cooldown + TVL) and trailing-90d realized-outflow stats, plus the
 * per-venue provenance counts. Address-independent — the SQL here is exactly what
 * getRadarPayload used inline; splitting it out lets the strats board reuse it
 * once for many addresses. Read from the recorder DB, never re-queried on-chain.
 */
export async function readCorpus(venues: VenueConfig[]): Promise<Corpus> {
  const snapRows = (
    await db.execute(sql`
      SELECT DISTINCT ON (venue)
        venue,
        instant_usd,
        (params ->> 'cooldownDuration') AS cooldown_seconds,
        (params ->> 'totalAssets')      AS total_assets_raw,
        observed_at
      FROM venue_snapshots
      ORDER BY venue, observed_at DESC`)
  ).rows as Array<Record<string, unknown>>

  const worst1dRows = (
    await db.execute(sql`
      WITH daily AS (
        SELECT venue, date_trunc('day', block_time) AS d,
               SUM(assets_raw::numeric) / 1e18 AS out_usd
        FROM venue_flows
        WHERE direction = 'out' AND block_time > now() - interval '90 days'
        GROUP BY venue, date_trunc('day', block_time)
      )
      SELECT venue, MAX(out_usd) AS worst1d, COUNT(*) AS day_count
      FROM daily GROUP BY venue`)
  ).rows as Array<Record<string, unknown>>

  const worst7dRows = (
    await db.execute(sql`
      WITH daily AS (
        SELECT venue, date_trunc('day', block_time) AS d,
               SUM(assets_raw::numeric) / 1e18 AS out_usd
        FROM venue_flows
        WHERE direction = 'out' AND block_time > now() - interval '97 days'
        GROUP BY venue, date_trunc('day', block_time)
      ), roll AS (
        SELECT venue, d,
               SUM(out_usd) OVER (
                 PARTITION BY venue ORDER BY d
                 RANGE BETWEEN interval '6 days' PRECEDING AND CURRENT ROW
               ) AS w7
        FROM daily
      )
      SELECT venue, MAX(w7) AS worst7d
      FROM roll
      WHERE d > now() - interval '90 days'
      GROUP BY venue`)
  ).rows as Array<Record<string, unknown>>

  const flowCorpus = (
    await db.execute(sql`
      SELECT venue, COUNT(*) AS rows, MIN(block_time) AS span_start, MAX(block_time) AS span_end
      FROM venue_flows GROUP BY venue`)
  ).rows as Array<Record<string, unknown>>
  const snapCorpus = (
    await db.execute(sql`
      SELECT venue, COUNT(*) AS rows,
             COUNT(*) FILTER (WHERE source = 'observed')   AS observed,
             COUNT(*) FILTER (WHERE source = 'backfilled') AS backfilled,
             MIN(observed_at) AS span_start, MAX(observed_at) AS span_end
      FROM venue_snapshots GROUP BY venue`)
  ).rows as Array<Record<string, unknown>>

  const byVenue = <T extends { venue?: unknown }>(rows: T[]) =>
    new Map(rows.map((r) => [String(r.venue), r]))
  const snap = byVenue(snapRows)
  const w1 = byVenue(worst1dRows)
  const w7 = byVenue(worst7dRows)
  const fc = byVenue(flowCorpus)
  const sc = byVenue(snapCorpus)

  const corpusByVenue = new Map<string, VenueCorpus>()
  for (const v of venues) {
    const s = snap.get(v.name)
    const a = w1.get(v.name)
    const b = w7.get(v.name)
    const totalAssetsRaw = s ? num(s.total_assets_raw) : null
    const worst1dUsd = a ? num(a.worst1d) : null
    const dayCount = a ? num(a.day_count) : null
    corpusByVenue.set(v.name, {
      tvlUsd: v.kind === 'erc4626-cooldown' && totalAssetsRaw != null ? totalAssetsRaw / 1e18 : null,
      instantUsd: s ? num(s.instant_usd) : null,
      cooldownSeconds: s ? num(s.cooldown_seconds) : null,
      flow:
        worst1dUsd != null
          ? { worst1dUsd, worst7dUsd: (b ? num(b.worst7d) : null) ?? 0, dayCount: dayCount ?? 0 }
          : null,
    })
  }

  const perVenueProvenance: PerVenueProv[] = venues.map((v) => {
    const f = fc.get(v.name)
    const sn = sc.get(v.name)
    return {
      venue: v.name,
      flow_rows: (f ? num(f.rows) : 0) ?? 0,
      flow_span: f ? { start: f.span_start, end: f.span_end } : null,
      snapshot_rows: (sn ? num(sn.rows) : 0) ?? 0,
      snapshot_observed: (sn ? num(sn.observed) : 0) ?? 0,
      snapshot_backfilled: (sn ? num(sn.backfilled) : 0) ?? 0,
      snapshot_span: sn ? { start: sn.span_start, end: sn.span_end } : null,
      snapshot_at: snap.get(v.name)?.observed_at ?? null,
    }
  })

  return { byVenue: corpusByVenue, perVenueProvenance, window: '90d' }
}

/**
 * Assemble the full radar payload from a per-venue USD map + the recorded corpus,
 * reusing computeRadar (the single stress engine). No chain reads, no db — pure
 * given its inputs — so the strats board can call it with STORED positions.
 */
export function assembleRadar(
  address: string,
  usdByVenue: Map<string, number>,
  venues: VenueConfig[],
  corpus: Corpus,
  at: Date,
): RadarPayload {
  const inputs: VenueInputs[] = venues.map((v) => {
    const c = corpus.byVenue.get(v.name)
    return {
      venue: v.name,
      label: LABELS[v.name] ?? v.name,
      kind: v.kind as VenueKind,
      usd: usdByVenue.get(v.name) ?? 0,
      tvlUsd: c?.tvlUsd ?? null,
      instantUsd: c?.instantUsd ?? null,
      cooldownSeconds: c?.cooldownSeconds ?? null,
      flow: c?.flow ?? null,
    }
  })

  const radar = computeRadar(inputs)

  const positions: PositionOut[] = radar.positions.map((p) => ({
    venue: p.venue,
    label: p.label,
    kind: p.kind,
    usd: p.usd,
    tvl_usd: p.tvlUsd,
    share_of_tvl: p.shareOfTvl,
    stress: p.prongs,
    verdict: p.verdict,
    reason: p.reason,
  }))
  const comparator = radar.comparator.map((p) => ({
    venue: p.venue,
    label: p.label,
    kind: p.kind,
    at_usd: p.usd,
    stress: p.prongs,
    verdict: p.verdict,
    reason: p.reason,
  }))

  return {
    address,
    total_usd: radar.totalUsd,
    held_count: radar.heldCount,
    positions,
    comparator,
    share_line: shareLine(radar),
    provenance: {
      chain_reads: {
        at: at.toISOString(),
        method: 'balanceOf + convertToAssets, multicall3 on Ethereum mainnet, live at request time',
        price_assumption:
          'ERC4626 assets and the aToken balance are valued at $1/underlying (the three underlyings are $-stable); aToken balanceOf is already underlying units',
      },
      recorded: {
        window: corpus.window,
        note:
          'capacity (venue_snapshots) and realized flow (venue_flows) are read from the recorder corpus, never re-queried live',
        per_venue: corpus.perVenueProvenance,
      },
      modelled: null,
    },
  }
}

/**
 * The full radar payload for an address: live chain positions stressed against
 * the recorded corpus. This IS the body /api/radar/[address] returns; watch and
 * recap call it so every surface reads positions the same way.
 */
export async function getRadarPayload(address: Address): Promise<RadarPayload> {
  const venues = loadVenues()
  const client = makeClient()
  const now = new Date()

  const usdByVenue = await readUsdByVenue(client, venues, address)
  const corpus = await readCorpus(venues)

  return assembleRadar(address, usdByVenue, venues, corpus, now)
}
