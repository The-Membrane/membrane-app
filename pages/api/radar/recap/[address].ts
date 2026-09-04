import type { NextApiRequest, NextApiResponse } from 'next'
import { isAddress, getAddress, parseAbiItem, type Address, type PublicClient } from 'viem'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { loadVenues, makeClient, getRadarPayload, LABELS, type VenueConfig } from '@/pages/api/_lib/radarReads'
import { fetchVenueLogEntries } from '@/pages/api/_lib/venueLogQuery'
import { composeRecap, type AddressFlow } from '@/components/Radar/recapLogic'

// GET /api/radar/recap/[address] — the POST-EVENT RECAP: tell the story of what
// happened to an address's carry strat, composed ONLY from chain logs + our
// recorded corpus, never invented (see components/Radar/recapLogic.ts).
//
// Window: from the watch's created_at (if the address is tracked) else a trailing
// --lookback (default 180d). We fetch THEIR own Deposit/Withdraw logs per venue
// (address filtered on the indexed owner/user/onBehalfOf topic), join each exit
// to its recorded corpus context (cooldownDuration at that block, that day's
// venue outflow, worst-day rank), and fold in venue state changes during the
// hold window. The portfolio delta (entry snapshot vs live) closes the story.
//
// DOMAIN FACT — VERIFIED against mainnet 2026-09-04 (32/32 recent sUSDe Withdraw
// logs): on sUSDe (Ethena StakedUSDeV2) with cooldownDuration>0, cooldownAssets/
// cooldownShares burn shares and move USDe to the silo
// (0x7FC7c91D556B400AFa565013E3F32055a0713425), emitting the ERC4626 Withdraw
// event AT COOLDOWN START — every sampled Withdraw had receiver == the silo. The
// later unstake() claim is a plain silo transfer with NO vault event. So a
// Withdraw log on sUSDe = "exit INITIATED, gated for cooldownDuration"; we render
// the projected landing as arithmetic (block-time + gate), never as observed.
// sUSDS/scrvUSD have no cooldown method (Withdraw = instant); aave-v3-usde Pool
// Withdraw (reserve=USDe) = instant exit.

// The recorder's RPC (drpc free tier) hard-caps eth_getLogs at a ~10k-block span
// AND rate-limits (~2-3 req/s) — VERIFIED 2026-09-04: an address-filtered query
// over 100k blocks returns InvalidParamsRpcError, and a 180d full scan (~130
// windows/contract) does not return inside an API budget. So the unwatched
// lookback defaults to a fast window and is capped; a WATCHED address scans from
// its watch instant (short at first, grows over time). Callers can widen via
// ?lookbackDays= up to the cap, accepting the extra latency.
const DEFAULT_LOOKBACK_DAYS = 30
const MAX_LOOKBACK_DAYS = 180
const GETLOGS_CHUNK = 10_000n // the RPC's proven-safe getLogs span
const GETLOGS_POOL = 8 // concurrency ceiling — higher trips the free-tier rate limit
const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const AVG_BLOCK_SECONDS = 12 // window-bound estimate only; beat dates use real block times

const ERC4626_DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const ERC4626_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
)
const AAVE_SUPPLY = parseAbiItem(
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
)
const AAVE_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
)

type Classified = { direction: 'deposit' | 'withdraw'; usd: number } | null

// One fetch spec per venue CONTRACT: a single combined-events getLogs per window
// (fewer calls than one-per-direction), with THIS address matched client-side on
// the decoded arg. Aave additionally pre-filters the reserve (an indexed topic)
// so the Pool's other reserves never come back.
type FetchSpec = {
  venue: string
  label: string
  address: Address
  events: any[]
  args?: Record<string, unknown>
  classify: (l: any) => Classified
}

function specFor(venue: VenueConfig, label: string, address: Address): FetchSpec | null {
  const addrLc = address.toLowerCase()
  if (venue.kind === 'erc4626-cooldown') {
    return {
      venue: venue.name,
      label,
      address: getAddress(venue.address) as Address,
      events: [ERC4626_DEPOSIT, ERC4626_WITHDRAW],
      classify: (l) => {
        if (String(l.args.owner).toLowerCase() !== addrLc) return null
        const usd = Number(l.args.assets) / 1e18
        return { direction: l.eventName === 'Deposit' ? 'deposit' : 'withdraw', usd }
      },
    }
  }
  if (venue.kind === 'atoken-liquidity') {
    const reserve = getAddress(venue.underlying as string)
    return {
      venue: venue.name,
      label,
      address: getAddress(AAVE_V3_POOL) as Address,
      events: [AAVE_SUPPLY, AAVE_WITHDRAW],
      args: { reserve },
      classify: (l) => {
        // Supply credits onBehalfOf; Withdraw is emitted by the withdrawing user.
        const who = String((l.eventName === 'Supply' ? l.args.onBehalfOf : l.args.user) ?? '').toLowerCase()
        if (who !== addrLc) return null
        const usd = Number(l.args.amount) / 1e18
        return { direction: l.eventName === 'Supply' ? 'deposit' : 'withdraw', usd }
      },
    }
  }
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// getLogs over one window with a bounded retry (transient free-tier HTTP blips)
// and a span-split fallback (should not trigger at CHUNK, but stays safe).
async function getLogsWindow(client: PublicClient, spec: FetchSpec, from: bigint, to: bigint, tries = 3): Promise<any[]> {
  const base: any = { address: spec.address, events: spec.events, fromBlock: from, toBlock: to }
  if (spec.args) base.args = spec.args
  for (let i = 0; i < tries; i++) {
    try {
      return (await client.getLogs(base)) as any[]
    } catch (e) {
      if (to > from && String((e as any)?.shortMessage ?? e).includes('Invalid parameters')) {
        const mid = from + (to - from) / 2n
        const a = await getLogsWindow(client, spec, from, mid, tries)
        const b = await getLogsWindow(client, spec, mid + 1n, to, tries)
        return a.concat(b)
      }
      if (i === tries - 1) throw e
      await sleep(300 * 2 ** i)
    }
  }
  return []
}

// Run tasks with a fixed concurrency ceiling.
async function runPool<T, R>(items: T[], pool: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(pool, items.length) }, () => worker()))
  return out
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const raw = req.query.address
  const addrStr = Array.isArray(raw) ? raw[0] : raw
  if (!addrStr || !isAddress(addrStr)) return res.status(400).json({ error: 'invalid address' })
  const address = getAddress(addrStr) as Address

  const lookbackDays = Math.max(1, Math.min(MAX_LOOKBACK_DAYS, Number(req.query.lookbackDays) || DEFAULT_LOOKBACK_DAYS))

  // ---- watch lookup (entry baseline + since) --------------------------------
  const watchRows = (
    await db.execute(sql`
      SELECT address, label, entry_positions, created_at
      FROM strat_watches WHERE address = ${address} LIMIT 1`)
  ).rows as Array<Record<string, unknown>>
  const watch = watchRows[0] ?? null
  const watchedSinceISO = watch ? new Date(watch.created_at as string).toISOString() : null

  const now = new Date()
  const windowStart = watchedSinceISO
    ? new Date(watchedSinceISO)
    : new Date(now.getTime() - lookbackDays * 86400_000)

  // ---- live positions (delta + current holdings) ----------------------------
  const payload = await getRadarPayload(address)
  const currentTotalUsd = payload.total_usd

  // entry_positions is the stored radar positions array; sum its usd for the delta.
  let entryTotalUsd: number | null = null
  if (watch?.entry_positions) {
    const ep = watch.entry_positions as Array<{ usd?: number }>
    entryTotalUsd = Array.isArray(ep) ? ep.reduce((s, p) => s + (Number(p.usd) || 0), 0) : null
  }

  // ---- their own on-chain flows over the window -----------------------------
  const venues = loadVenues()
  const client = makeClient()
  const latest = await client.getBlockNumber()
  const secondsAgo = Math.max(0, Math.floor((now.getTime() - windowStart.getTime()) / 1000))
  const estBack = BigInt(Math.ceil(secondsAgo / AVG_BLOCK_SECONDS) + 7200) // +~1d block-time safety margin
  const fromBlock = latest > estBack ? latest - estBack : 0n

  const blockTimeCache = new Map<string, string>()
  async function blockTime(bn: bigint): Promise<string> {
    const key = bn.toString()
    const hit = blockTimeCache.get(key)
    if (hit) return hit
    const blk = await client.getBlock({ blockNumber: bn })
    const iso = new Date(Number(blk.timestamp) * 1000).toISOString()
    blockTimeCache.set(key, iso)
    return iso
  }

  type RawFlow = { venue: string; label: string; direction: 'deposit' | 'withdraw'; block: bigint; usd: number; txHash: string }
  const specs = venues
    .map((v) => specFor(v, LABELS[v.name] ?? v.name, address))
    .filter((s): s is FetchSpec => s !== null)

  // (spec × window) tasks fanned out under one concurrency ceiling, so all
  // venues share the pool rather than serializing venue-by-venue.
  const windows: Array<[bigint, bigint]> = []
  for (let f = fromBlock; f <= latest; f += GETLOGS_CHUNK) {
    windows.push([f, f + GETLOGS_CHUNK - 1n > latest ? latest : f + GETLOGS_CHUNK - 1n])
  }
  const tasks = specs.flatMap((spec) => windows.map((w) => ({ spec, w })))

  const rawFlows: RawFlow[] = []
  const results = await runPool(tasks, GETLOGS_POOL, async ({ spec, w }) => {
    const logs = await getLogsWindow(client, spec, w[0], w[1])
    const rows: RawFlow[] = []
    for (const l of logs) {
      const c = spec.classify(l)
      if (!c) continue
      rows.push({
        venue: spec.venue,
        label: spec.label,
        direction: c.direction,
        block: l.blockNumber as bigint,
        usd: c.usd,
        txHash: l.transactionHash as string,
      })
    }
    return rows
  })
  for (const rows of results) rawFlows.push(...rows)

  // Resolve block times (unique blocks, small polite pool).
  const uniqBlocks = [...new Set(rawFlows.map((f) => f.block))]
  for (let i = 0; i < uniqBlocks.length; i += 6) {
    await Promise.all(uniqBlocks.slice(i, i + 6).map((bn) => blockTime(bn)))
  }

  // ---- join corpus context to each flow (exits get gate + day rank) ---------
  const flows: AddressFlow[] = []
  for (const f of rawFlows) {
    const at = blockTimeCache.get(f.block.toString()) as string
    let cooldownSecondsAtEvent: number | null = null
    let dayOutflowUsd: number | null = null
    let dayRank: number | null = null
    let dayRankTotal: number | null = null

    // Nearest recorded cooldownDuration ≤ the event's block time (observed OR
    // backfilled) — >0 ⇒ this exit was gated.
    const cdRow = (
      await db.execute(sql`
        SELECT (params ->> 'cooldownDuration') AS cd
        FROM venue_snapshots
        WHERE venue = ${f.venue} AND observed_at <= ${at} AND params ? 'cooldownDuration'
        ORDER BY observed_at DESC LIMIT 1`)
    ).rows as Array<Record<string, unknown>>
    if (cdRow[0]?.cd != null) cooldownSecondsAtEvent = Number(cdRow[0].cd)

    if (f.direction === 'withdraw') {
      // That calendar day's total venue outflow + its rank among all outflow days.
      const dayRow = (
        await db.execute(sql`
          WITH daily AS (
            SELECT date_trunc('day', block_time) AS d, SUM(assets_raw::numeric) / 1e18 AS o
            FROM venue_flows WHERE venue = ${f.venue} AND direction = 'out'
            GROUP BY 1
          ), target AS (
            SELECT o FROM daily WHERE d = date_trunc('day', ${at}::timestamptz)
          )
          SELECT
            (SELECT o FROM target) AS day_out,
            (SELECT COUNT(*) FROM daily) AS total_days,
            (SELECT COUNT(*) FROM daily x WHERE x.o >= (SELECT o FROM target)) AS rank`)
      ).rows as Array<Record<string, unknown>>
      const dr = dayRow[0]
      if (dr && dr.day_out != null) {
        dayOutflowUsd = Number(dr.day_out)
        dayRankTotal = dr.total_days != null ? Number(dr.total_days) : null
        dayRank = dr.rank != null ? Number(dr.rank) : null
      }
    }

    flows.push({
      venue: f.venue,
      label: f.label,
      direction: f.direction,
      at,
      usd: f.usd,
      txHash: f.txHash,
      cooldownSecondsAtEvent,
      dayOutflowUsd,
      dayRank,
      dayRankTotal,
    })
  }

  // ---- venue state changes during the hold window (shared log query) --------
  // Scope to the trader-relevant discrete changes the venue log is designed for
  // (cooldown gate moves, >20% instant-liquidity shifts) — NOT recorder-internal
  // read artifacts (e.g. an intermittently-read decimals/silo field flapping),
  // which would misrepresent a non-event as "what happened to the venue".
  const RELEVANT_EVENT_KINDS = new Set(['cooldown_duration_changed', 'instant_liquidity_shift'])
  const venueEvents = (
    await fetchVenueLogEntries({ sinceISO: windowStart.toISOString(), untilISO: now.toISOString() })
  ).filter((e) => RELEVANT_EVENT_KINDS.has(e.kind))

  // ---- compose --------------------------------------------------------------
  const { beats, summary } = composeRecap({
    address,
    watchedSinceISO,
    lookbackLabel: `${lookbackDays}d`,
    entryTotalUsd,
    currentTotalUsd,
    flows,
    venueEvents,
  })

  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.status(200).json({
    address,
    watched_since: watchedSinceISO,
    label: watch?.label ?? null,
    beats,
    summary,
    provenance: {
      window: watchedSinceISO ? `since ${watchedSinceISO.slice(0, 10)} (watch)` : `trailing ${lookbackDays}d`,
      chain_logs: 'Deposit/Withdraw logs filtered to this address on the indexed owner/user topic, live at request time',
      recorded: 'cooldown gate, day outflow, and worst-day rank read from the venue_snapshots / venue_flows corpus',
      current_holdings: 'balanceOf + convertToAssets at $1/underlying, live at request time',
      modelled: null,
    },
  })
}
