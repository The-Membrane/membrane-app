import type { NextApiRequest, NextApiResponse } from 'next'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createPublicClient, http, fallback, isAddress, getAddress, type Address } from 'viem'
import { mainnet } from 'viem/chains'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { computeRadar, shareLine, type VenueInputs, type VenueKind } from '@/components/Radar/radarLogic'

// PRIVATE, address-specific. Paste ANY mainnet address → its positions across
// our four instrumented venues, stressed against our RECORDED capacity + flow
// corpus. No wallet connect: this is a standalone decision tool.
//
// PROVENANCE DISCIPLINE (owner, docs/BRAND_CHARTS.md §4):
//  - Chain reads are LIVE at request time (balanceOf / convertToAssets).
//  - Capacity + flow facts are RECORDED (venue_snapshots / venue_flows), read
//    from the DB — never re-queried live here.
//  - Nothing is modelled. The only assumption is $1/underlying for the three
//    $-stable ERC4626 underlyings and the aToken (stated in provenance).

// ---- venue config (source of truth: tools/venue-recorder.config.json) -------
type VenueConfig = {
  name: string
  kind: string
  address: string
  underlying?: string
  decimals?: number
  enabled: boolean
}

function loadVenues(): VenueConfig[] {
  const raw = readFileSync(join(process.cwd(), 'tools', 'venue-recorder.config.json'), 'utf8')
  return (JSON.parse(raw).venues as VenueConfig[]).filter((v) => v.enabled)
}

// Reader-facing labels. Anything unmapped falls back to the config name.
const LABELS: Record<string, string> = {
  'aave-v3-usde': 'Aave',
  sUSDe: 'sUSDe',
  sUSDS: 'sUSDS',
  scrvUSD: 'scrvUSD',
}

const erc4626Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

function makeClient() {
  const raw = process.env.RECORDER_RPC_URL
  if (!raw) throw new Error('RECORDER_RPC_URL is not set (see .env.local)')
  const urls = raw.split(',').map((u) => u.trim()).filter(Boolean)
  const transport =
    urls.length === 1
      ? http(urls[0])
      : fallback(urls.map((u) => http(u, { timeout: 15_000 })), { rank: false })
  return createPublicClient({ chain: mainnet, transport })
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const raw = req.query.address
  const addrStr = Array.isArray(raw) ? raw[0] : raw
  if (!addrStr || !isAddress(addrStr)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const address = getAddress(addrStr) as Address

  const venues = loadVenues()
  const client = makeClient()
  const now = new Date()

  // ---- LIVE chain reads: user balances, then assets for the ERC4626s --------
  // Batch 1: balanceOf(user) for every venue (multicall3 on mainnet).
  const balances = await client.multicall({
    allowFailure: true,
    contracts: venues.map((v) => ({
      address: getAddress(v.address) as Address,
      abi: v.kind === 'atoken-liquidity' ? erc20Abi : erc4626Abi,
      functionName: 'balanceOf',
      args: [address],
    })),
  })

  // Batch 2: convertToAssets(shares) for the ERC4626 vaults that returned a
  // non-zero share balance (aToken balance is ALREADY underlying units).
  const need4626 = venues
    .map((v, i) => ({ v, i, bal: balances[i]?.status === 'success' ? (balances[i].result as bigint) : 0n }))
    .filter((x) => x.v.kind === 'erc4626-cooldown' && x.bal > 0n)

  const assetsResults =
    need4626.length > 0
      ? await client.multicall({
          allowFailure: true,
          contracts: need4626.map((x) => ({
            address: getAddress(x.v.address) as Address,
            abi: erc4626Abi,
            functionName: 'convertToAssets',
            args: [x.bal],
          })),
        })
      : []
  const assetsByIdx = new Map<number, bigint>()
  need4626.forEach((x, k) => {
    if (assetsResults[k]?.status === 'success') assetsByIdx.set(x.i, assetsResults[k].result as bigint)
  })

  // Per-venue USD position: 18-dec underlying valued at $1 (stated assumption).
  const usdByVenue = new Map<string, number>()
  venues.forEach((v, i) => {
    const bal = balances[i]?.status === 'success' ? (balances[i].result as bigint) : 0n
    let underlyingRaw: bigint
    if (v.kind === 'atoken-liquidity') {
      underlyingRaw = bal // aToken balance is underlying units
    } else {
      underlyingRaw = assetsByIdx.get(i) ?? 0n // convertToAssets(shares)
    }
    const dec = v.decimals ?? 18
    usdByVenue.set(v.name, Number(underlyingRaw) / 10 ** dec)
  })

  // ---- RECORDED reads: latest snapshot per venue + trailing-90d flow stats --
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

  // Worst single-day outflow (USD) + outflow day-count, trailing 90d.
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

  // Worst rolling 7-day outflow (USD), trailing 90d.
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

  // Corpus provenance: row counts + spans for both tables.
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

  // ---- assemble stress inputs ----------------------------------------------
  const inputs: VenueInputs[] = venues.map((v) => {
    const s = snap.get(v.name)
    const a = w1.get(v.name)
    const b = w7.get(v.name)
    const totalAssetsRaw = s ? num(s.total_assets_raw) : null
    const worst1dUsd = a ? num(a.worst1d) : null
    const dayCount = a ? num(a.day_count) : null
    return {
      venue: v.name,
      label: LABELS[v.name] ?? v.name,
      kind: v.kind as VenueKind,
      usd: usdByVenue.get(v.name) ?? 0,
      // ERC4626 TVL from totalAssets (18-dec, $1 underlying); aToken TVL not read.
      tvlUsd: v.kind === 'erc4626-cooldown' && totalAssetsRaw != null ? totalAssetsRaw / 1e18 : null,
      // instant_usd is populated ONLY for the aToken venue; null for cooldown vaults.
      instantUsd: s ? num(s.instant_usd) : null,
      cooldownSeconds: s ? num(s.cooldown_seconds) : null,
      flow:
        worst1dUsd != null
          ? { worst1dUsd, worst7dUsd: (b ? num(b.worst7d) : null) ?? 0, dayCount: dayCount ?? 0 }
          : null,
    }
  })

  const radar = computeRadar(inputs)

  // Serialized shape (radar verdicts + a copyable share line + provenance).
  const positions = radar.positions.map((p) => ({
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

  const perVenueProvenance = venues.map((v) => {
    const f = fc.get(v.name)
    const sn = sc.get(v.name)
    return {
      venue: v.name,
      flow_rows: f ? num(f.rows) : 0,
      flow_span: f ? { start: f.span_start, end: f.span_end } : null,
      snapshot_rows: sn ? num(sn.rows) : 0,
      snapshot_observed: sn ? num(sn.observed) : 0,
      snapshot_backfilled: sn ? num(sn.backfilled) : 0,
      snapshot_span: sn ? { start: sn.span_start, end: sn.span_end } : null,
      snapshot_at: snap.get(v.name)?.observed_at ?? null,
    }
  })

  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.status(200).json({
    address,
    total_usd: radar.totalUsd,
    held_count: radar.heldCount,
    positions,
    comparator,
    share_line: shareLine(radar),
    provenance: {
      chain_reads: {
        at: now.toISOString(),
        method: 'balanceOf + convertToAssets, multicall3 on Ethereum mainnet, live at request time',
        price_assumption:
          'ERC4626 assets and the aToken balance are valued at $1/underlying (the three underlyings are $-stable); aToken balanceOf is already underlying units',
      },
      recorded: {
        window: '90d',
        note:
          'capacity (venue_snapshots) and realized flow (venue_flows) are read from the recorder corpus, never re-queried live',
        per_venue: perVenueProvenance,
      },
      modelled: null,
    },
  })
}
