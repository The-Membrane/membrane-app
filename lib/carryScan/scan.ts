/**
 * THE WEEKLY SCAN, S0 → S8, with every data source injected so it runs under test.
 *
 *  S0 fetch    DeFiLlama /pools, /lendBorrow, /protocols · Morpho GraphQL · Merkl (any failure → abort)
 *  S1 universe Ethereum ∧ stablecoin ∧ USD-stable allowlist → single + LP (ilRisk=no)
 *  S2 filters  TVL ≥ $10M · count ≥ 30 · !outlier · reward ≤ 50% · category allow · project deny
 *  S3 bench    cheapest same-stable borrow (Aave Core/Prime, Spark, Morpho blue-chip, ≥ $5M borrowed)
 *  S4 columns  (a) market carry · (b) Membrane carry → positive (a) ∧ positive 30-day-mean (a)
 *              vault rows are priced from the AVERAGE of their sources (./venueApy.ts)
 *  S5 dedupe   on-app set (R1–R4 + aliases) by 1:<addr>; a /carry route class annotates, never hides
 *  S6 finalist chart stability · on-chain verify at the finalized anchor · on-chain pricing of
 *              lending rows · vault rows re-averaged with the on-chain 7-day figure
 *  S7 lists    stability first for every finalist, then address, verification, LP, benchmark,
 *              carry (./status.ts placeFinalists)
 *     status   NEW / STILL / RETURNING / DROPPED / NOW ON APP vs the last 8 weekly files
 *  S8 gate     publish, hold (churn) or fail closed
 *
 * Returns an outcome; ./publish.ts writes it. Never throws for a data problem: every
 * failure becomes `{kind:'failed', reason}`.
 */

import type { PublicClient } from 'viem'

import {
  extractCampaigns,
  fetchMerklOpportunities,
  type MerklOpportunity,
} from '../netApy/incentives'
import { readAllVenues, resolveAnchor } from '../netApy/read'
import { redactError } from '../netApy/rpc'
import type { BlockAnchor } from '../netApy/types'
import { NET_APY_VENUES, venueByKey } from '../netApy/venues'
import { buildBenchmarks, eligibleLlamaBench, onchainBench } from './benchmark'
import {
  baseApy,
  carryAOf,
  carryBPair,
  headlineApy,
  venueColumnsFromBreakdowns,
  venueColumnsFromLlama,
} from './columns'
import { CARRY_SCAN_NOTES } from './copy'
import { checkBenchmarks, checkChurn, checkUniverseCount, checkVerification } from './gate'
import {
  aaveLikeVenues,
  buildOnAppSet,
  DEFAULT_ON_APP_INPUTS,
  keyOf,
  onAppRouteNotes,
  type OnAppInputs,
} from './onApp'
import POOL_ADDRESSES from './poolAddresses.json'
import { scoutReadiness } from './readiness'
import {
  fetchChart,
  fetchLendBorrow,
  fetchMorpho,
  fetchPools,
  fetchProtocols,
  pacer,
  realSleep,
  type Sleep,
} from './sources'
import { stabilityFromChart } from './stability'
import { computeStatuses, placeFinalists, type CurrentRow } from './status'
import { buildUniverse, poolLabel } from './universe'
import {
  averagedVenueApy,
  isVaultKind,
  llamaVenueApy,
  onchainIrmVenueApy,
  sourcesDisagree,
  venueColumnsFromAverage,
  VENUE_APY_RULE,
  type Onchain7d,
} from './venueApy'
import {
  aTokenOfAt,
  matchMorphoVault,
  resolveAddress,
  supplyBreakdowns,
  verifyOnChain,
  venueDefFor,
  type Resolution,
} from './verify'
import {
  AGREEMENT_STABLES,
  CARRY_SCAN_SCHEMA_VERSION,
  DEFAULT_SCAN_SIZE,
  SCAN_SIZES_USD,
  SIZE_KEYS,
  THRESHOLDS,
  type BenchRef,
  type Candidate,
  type Carry,
  type CarryB,
  type CarryScanFile,
  type LlamaLendBorrow,
  type MorphoVaultInfo,
  type PastWeek,
  type PoolAddressEntry,
  type ScoutList,
  type ScoutRow,
  type SizeKey,
  type Stability,
  type StageCounts,
  type ScoutKind,
  type Valued,
  type VenueApy,
  type Verification,
} from './types'

export interface ScanDeps {
  fetch: typeof fetch
  rpc: () => { client: PublicClient; label: string }
  nowMs: () => number
  appSha: string | null
  /** Weekly files already on the data branch (any order; the last 8 are used). */
  pastWeeks: PastWeek[]
  /** The live latest.json, for the week-over-week count gate. */
  lastLatest: { counts?: { ethStablePools?: number; ranked?: number } } | null
  acceptChurn: boolean
  sleep?: Sleep
  log?: (m: string) => void
  onAppInputs?: OnAppInputs
  poolAddresses?: Record<string, PoolAddressEntry>
  fetchMerkl?: () => Promise<MerklOpportunity[]>
}

export interface BenchmarksFile {
  schemaVersion: typeof CARRY_SCAN_SCHEMA_VERSION
  week: string
  asOf: number
  anchorBlock: string | null
  table: CarryScanFile['benchmarks']
  agreement: Record<
    string,
    { onchain: number | null; defillama: number | null; diffPp: number | null }
  >
  rejectedSample: { venue: string; reason: string }[]
  rejectedCount: number
}

export type ScanOutcome =
  | { kind: 'published'; file: CarryScanFile; benchmarks: BenchmarksFile; note: string | null }
  | { kind: 'held'; reason: string; file: CarryScanFile; benchmarks: BenchmarksFile }
  | { kind: 'failed'; reason: string }

/** ISO-8601 week, e.g. "2026-W41". */
export function isoWeek(ms: number): string {
  const d = new Date(ms)
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const day = (new Date(t).getUTCDay() + 6) % 7 // Mon = 0
  const thursday = new Date(t - day * 86_400_000 + 3 * 86_400_000)
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / (7 * 86_400_000))
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

interface Work {
  c: Candidate
  label: string
  venueNet: Record<SizeKey, Valued>
  venueNetBase: Record<SizeKey, Valued>
  bench: Record<SizeKey, BenchRef | null>
  carryA: Record<SizeKey, Carry | null>
  carryABase: Record<SizeKey, Carry | null>
  carryA30d: number | null
  resolution?: Resolution
  verification?: Verification
  stability?: Stability
  breakdown: unknown | null
  flags: string[]
  pricedOnchain: boolean
  /** Set when the row is a vault (VAULT_KINDS): its venue APY is the average of its sources. */
  vault: { kind: ScoutKind; morpho: MorphoVaultInfo | null } | null
  venueApy: VenueApy
  /** /carry route-class labels whose destinations include this row's contract (S5). */
  alsoBehindRoutes: string[]
}

function benchForStables(
  table: CarryScanFile['benchmarks'],
  symbols: string[],
): Record<SizeKey, BenchRef | null> {
  const out = {} as Record<SizeKey, BenchRef | null>
  for (const k of SIZE_KEYS) {
    let best: BenchRef | null = null
    for (const s of symbols) {
      const b = table[s]?.bySize[k] ?? null
      if (b && (!best || b.apy < best.apy)) best = b
    }
    out[k] = best
  }
  return out
}

function applyCarry(w: Work): void {
  for (const k of SIZE_KEYS) {
    w.carryA[k] = carryAOf(w.venueNet[k], w.bench[k])
    w.carryABase[k] = carryAOf(w.venueNetBase[k], w.bench[k])
  }
  const mean = w.c.pool.apyMean30d
  w.carryA30d = w.bench['100k'] && mean !== null ? mean / 100 - w.bench['100k'].apy : null
}

const a100 = (w: Work): number => w.carryA['100k']?.apy ?? -Infinity
/** The venue figure an unranked list sorts on: the averaged one for a vault row. */
const headlineOf = (w: Work): number => w.venueApy.withRewards ?? headlineApy(w.c.pool)
const isPositive = (w: Work): boolean => a100(w) > 0 && (w.carryA30d ?? -Infinity) > 0

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

export async function runCarryScan(deps: ScanDeps): Promise<ScanOutcome> {
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? realSleep
  const nowMs = deps.nowMs()
  const nowTs = Math.floor(nowMs / 1000)
  const week = isoWeek(nowMs)
  const poolAddresses =
    deps.poolAddresses ?? (POOL_ADDRESSES as { pools: Record<string, PoolAddressEntry> }).pools
  const trace = new Map<string, string>()
  const traceCounts: Record<string, number> = {}
  const drop = (uuid: string, gate: string) => {
    trace.set(uuid, gate)
    traceCounts[gate] = (traceCounts[gate] ?? 0) + 1
  }

  // ---------------------------------------------------------------- S0 sources
  let pools, lendBorrow: LlamaLendBorrow[], protocols, morpho, merkl: MerklOpportunity[]
  try {
    ;[pools, lendBorrow, protocols, morpho, merkl] = await Promise.all([
      fetchPools(deps.fetch, sleep),
      fetchLendBorrow(deps.fetch, sleep),
      fetchProtocols(deps.fetch, sleep),
      fetchMorpho(deps.fetch, sleep),
      (deps.fetchMerkl ?? (() => fetchMerklOpportunities(deps.fetch)))(),
    ])
  } catch (e) {
    return { kind: 'failed', reason: `gate 1: source failed — ${redactError(e)}` }
  }
  log(
    `S0 pools=${pools.length} lendBorrow=${lendBorrow.length} protocols=${protocols.length} morphoVaults=${morpho.vaults.length} morphoMarkets=${morpho.markets.length} merkl=${merkl.length}`,
  )
  const sources = [
    { name: 'defillama /pools', ok: true, rows: pools.length },
    { name: 'defillama /lendBorrow', ok: true, rows: lendBorrow.length },
    { name: 'defillama /protocols', ok: true, rows: protocols.length },
    { name: 'morpho graphql', ok: true, rows: morpho.vaults.length + morpho.markets.length },
    { name: 'merkl', ok: true, rows: merkl.length },
  ]

  // ---------------------------------------------------------------- S1/S2
  const uni = buildUniverse(pools, lendBorrow, protocols)
  for (const [uuid, gate] of uni.trace) drop(uuid, gate)
  const g1 = checkUniverseCount(uni.ethStableCount, deps.lastLatest?.counts?.ethStablePools ?? null)
  if (!g1.ok) return { kind: 'failed', reason: g1.reason }
  log(
    `S1 eth-stable=${uni.ethStableCount} single=${uni.universeSingle} lp=${uni.universeLp}; S2 single=${uni.single.length} lp=${uni.lp.length}`,
  )

  // ---------------------------------------------------------------- anchor + registry venues
  let client: PublicClient
  let rpcLabel: string
  let anchor: BlockAnchor
  try {
    ;({ client, label: rpcLabel } = deps.rpc())
    anchor = await resolveAnchor(client)
  } catch (e) {
    return {
      kind: 'failed',
      reason: `gate 3: the finalized anchor did not resolve — ${redactError(e)}`,
    }
  }
  const anchorTs = Number(anchor.blockTimestamp)
  const regSet = await readAllVenues(client, NET_APY_VENUES, rpcLabel, anchor.blockNumber)
  const registryVaultOf = (k: string) => {
    const d = venueByKey(k)
    return d && d.protocol === 'euler-v2' ? d.vault : null
  }
  const regCampaigns = extractCampaigns(merkl, regSet.snapshots, registryVaultOf, nowTs)
  log(
    `anchor ${anchor.blockNumber} rpc=${rpcLabel} registry read ${regSet.snapshots.length}/${NET_APY_VENUES.length}`,
  )

  // ---------------------------------------------------------------- S3 benchmarks
  const llamaBench = eligibleLlamaBench(pools, lendBorrow, morpho.markets)
  const onVenues = onchainBench(regSet.snapshots, regCampaigns, nowTs)
  const bench = buildBenchmarks(llamaBench, onVenues, NET_APY_VENUES, AGREEMENT_STABLES, {
    morphoListed: morpho.markets,
  })
  const g2 = checkBenchmarks(bench.table, bench.agreement)
  if (!g2.ok) return { kind: 'failed', reason: g2.reason }

  // ---------------------------------------------------------------- S4 columns
  const lbByPool = new Map(lendBorrow.map((r) => [r.pool, r]))
  const morphoByAddress = new Map(morpho.vaults.map((v) => [v.address.toLowerCase(), v]))
  /** The vault a row is, from what needs no RPC: the hand-kept table, else a Morpho match. */
  const vaultOf = (c: Candidate): Work['vault'] => {
    if (c.exposure !== 'single') return null
    const hand = poolAddresses[c.pool.pool]
    if (hand)
      return isVaultKind(hand.kind)
        ? { kind: hand.kind, morpho: morphoByAddress.get(hand.address.toLowerCase()) ?? null }
        : null
    if (c.pool.project !== 'morpho-blue') return null
    const m = matchMorphoVault(c, morpho.vaults)
    return m && 'address' in m
      ? { kind: m.version === 'v2' ? 'morpho-vault-v2' : 'metamorpho', morpho: m }
      : null
  }
  const mkWork = (c: Candidate): Work => {
    const vault = vaultOf(c)
    const venueApy = vault
      ? averagedVenueApy({
          pool: c.pool,
          fetchedAt: nowTs,
          morpho: vault.morpho,
          kind: vault.kind,
          address: vault.morpho?.address ?? poolAddresses[c.pool.pool]?.address ?? null,
        })
      : llamaVenueApy(c.pool, nowTs)
    const cols = vault
      ? venueColumnsFromAverage(venueApy, c.pool.tvlUsd)
      : venueColumnsFromLlama(c.pool)
    const w: Work = {
      c,
      label: poolLabel(c.pool),
      ...cols,
      bench: benchForStables(
        bench.table,
        c.stables.map((s) => s.symbol),
      ),
      carryA: {} as Work['carryA'],
      carryABase: {} as Work['carryABase'],
      carryA30d: null,
      breakdown: null,
      flags: [...c.flags],
      pricedOnchain: false,
      vault,
      venueApy,
      alsoBehindRoutes: [],
    }
    applyCarry(w)
    return w
  }
  const singles = uni.single.map(mkWork)
  const lps = uni.lp.map(mkWork)
  const positive: Work[] = []
  const noBench: Work[] = []
  const lpPositive: Work[] = []
  for (const w of singles) {
    if (!w.bench['100k']) noBench.push(w)
    else if (a100(w) <= 0) drop(w.c.pool.pool, 'carry: (a) not positive at $100K')
    else if (!((w.carryA30d ?? -Infinity) > 0))
      drop(w.c.pool.pool, 'carry: 30-day-mean (a) not positive')
    else positive.push(w)
  }
  for (const w of lps) {
    if (!w.bench['100k']) drop(w.c.pool.pool, 'LP: no same-stable borrow benchmark')
    else if (!isPositive(w)) drop(w.c.pool.pool, 'LP: (a) not positive')
    else lpPositive.push(w)
  }
  log(
    `S4 withBench=${singles.length - noBench.length} positive=${positive.length} noBench=${noBench.length} lpPositive=${lpPositive.length}`,
  )

  // ---------------------------------------------------------------- S5 on-app set + dedupe
  const aTokens = new Map<string, string>()
  for (const s of regSet.snapshots)
    if (s.state.kind === 'aave-virtual' || s.state.kind === 'spark')
      aTokens.set(s.venueKey, s.state.aToken)
  for (const d of aaveLikeVenues()) {
    if (aTokens.has(d.venueKey)) continue
    try {
      const a = await aTokenOfAt(client, anchor, d.pool, d.asset.address)
      if (a) aTokens.set(d.venueKey, a)
    } catch {
      // reported below as unresolved
    }
  }
  const onApp = buildOnAppSet(deps.onAppInputs ?? DEFAULT_ON_APP_INPUTS, aTokens)
  if (onApp.unresolved.length)
    return {
      kind: 'failed',
      reason: `S5: on-app set incomplete — aToken unresolved for ${onApp.unresolved.join(', ')}`,
    }

  const resolveCtx = {
    poolAddresses,
    morphoVaults: morpho.vaults,
    aTokenOf: (pool: string, asset: string) => aTokenOfAt(client, anchor, pool, asset),
  }
  let onAppCount = 0
  let alsoBehindCount = 0
  const dedupe = async (list: Work[]): Promise<Work[]> => {
    const kept: Work[] = []
    for (const w of list) {
      try {
        w.resolution = await resolveAddress(w.c, resolveCtx)
      } catch (e) {
        w.resolution = { address: null, reason: `address read failed: ${redactError(e)}` }
      }
      if (w.resolution.address && onApp.keys.has(keyOf(w.resolution.address))) {
        onAppCount++
        drop(w.c.pool.pool, 'on the app already')
        continue
      }
      // A /carry route class (several contracts) never hides a vault: kept, and annotated.
      const classes = w.resolution.address
        ? onApp.routeClassOf.get(keyOf(w.resolution.address))
        : undefined
      if (classes?.length) {
        w.alsoBehindRoutes = [...classes]
        alsoBehindCount++
      }
      kept.push(w)
    }
    return kept
  }
  const positiveKept = await dedupe(positive)
  const noBenchKept = await dedupe(noBench)
  const lpKept = await dedupe(lpPositive)
  log(
    `S5 onApp=${onAppCount} alsoBehindRoute=${alsoBehindCount} positive=${positiveKept.length} noBench=${noBenchKept.length} lp=${lpKept.length}`,
  )

  // ---------------------------------------------------------------- S6 finalists
  const byA = (x: Work, y: Work) => a100(y) - a100(x)
  const finRanked = [...positiveKept].sort(byA).slice(0, THRESHOLDS.finalistsRanked)
  const finNoBench = [...noBenchKept]
    .sort((x, y) => headlineOf(y) - headlineOf(x))
    .slice(0, THRESHOLDS.finalistsNoBench)
  const finLp = [...lpKept].sort(byA).slice(0, THRESHOLDS.finalistsLp)
  const finalists = [...finRanked, ...finNoBench, ...finLp].slice(0, THRESHOLDS.finalistsMax)
  const finSet = new Set(finalists)
  for (const w of [...positiveKept, ...noBenchKept, ...lpKept])
    if (!finSet.has(w)) drop(w.c.pool.pool, 'not a finalist this week (finalist cap)')

  // Stability: the chart, paced.
  const pace = pacer(THRESHOLDS.chartCallsPerMinute, sleep)
  let chartFailures = 0
  for (const w of finalists) {
    await pace()
    try {
      const points = await fetchChart(deps.fetch, w.c.pool.pool, sleep)
      w.stability = stabilityFromChart(points, w.c.pool.apy ?? 0)
    } catch (e) {
      chartFailures++
      w.stability = {
        sigma90Pp: null,
        median90: null,
        spikeRatio: null,
        points: 0,
        ok: false,
        reason: `chart unavailable: ${redactError(e)}`,
      }
    }
  }
  if (finalists.length && chartFailures / finalists.length > 0.5) {
    return {
      kind: 'failed',
      reason: `gate 1: ${chartFailures} of ${finalists.length} DeFiLlama chart calls failed`,
    }
  }

  // On-chain verification of every resolved finalist.
  const attempted = finalists.filter((w) => w.resolution?.address)
  await inBatches(attempted, 8, async (w) => {
    const r = w.resolution as Exclude<Resolution, { address: null }>
    const lb = lbByPool.get(w.c.pool.pool)
    const v = await verifyOnChain(client, anchor, {
      address: r.address,
      kind: r.kind,
      stable: w.c.exposure === 'single' ? w.c.stables[0] : null,
      suppliedUsd:
        lb?.totalSupplyUsd && lb.totalSupplyUsd > 0 ? lb.totalSupplyUsd : w.c.pool.tvlUsd,
      apyBase7dPct: w.c.pool.apyBase7d ?? null,
      apyBasePct: baseApy(w.c.pool) * 100,
    })
    w.verification = {
      ok: v.ok,
      checks: v.checks,
      failed: v.failed,
      trailing7dApy: v.trailing7dApy ?? null,
      ...(v.trailing7dError ? { trailing7dError: v.trailing7dError } : {}),
    }
    // An averaged vault row flags disagreement from the spread of its sources (below).
    if (v.sourceDisagreement && !w.vault) w.flags.push('source-disagreement')
  })
  const verifiedCount = attempted.filter((w) => w.verification?.ok).length
  const g3 = checkVerification(attempted.length, verifiedCount, finalists.length)
  if (!g3.ok) return { kind: 'failed', reason: g3.reason }
  log(
    `S6 finalists=${finalists.length} attempted=${attempted.length} verified=${verifiedCount} chartFailures=${chartFailures}`,
  )

  // On-chain pricing for verified lending rows (Aave v3 / Spark / Euler LinearKink).
  const priceable = attempted.filter((w) => w.verification?.ok && w.c.exposure === 'single')
  const defs = priceable
    .map((w) => {
      const r = w.resolution as Exclude<Resolution, { address: null }>
      return {
        w,
        def: venueDefFor({
          address: r.address,
          kind: r.kind,
          aavePool: r.aavePool,
          stable: w.c.stables[0],
          label: w.label,
        }),
      }
    })
    .filter(
      (x): x is { w: Work; def: NonNullable<ReturnType<typeof venueDefFor>> } => x.def !== null,
    )
  if (defs.length) {
    const set = await readAllVenues(
      client,
      defs.map((d) => d.def),
      rpcLabel,
      anchor.blockNumber,
    )
    const scoutVaultOf = (k: string) => {
      const d = defs.find((x) => x.def.venueKey === k)?.def
      return d && d.protocol === 'euler-v2' ? d.vault : null
    }
    const campaigns = extractCampaigns(merkl, set.snapshots, scoutVaultOf, nowTs)
    for (const { w, def } of defs) {
      const snap = set.snapshots.find((s) => s.venueKey === def.venueKey)
      if (!snap) {
        const err = set.errors.find((e) => e.venueKey === def.venueKey)
        w.flags.push('priced-from-defillama')
        if (err) w.verification!.checks.push(`irm-read-failed: ${err.message.slice(0, 120)}`)
        continue
      }
      const { bySize, serialized } = supplyBreakdowns(snap, campaigns, nowTs)
      const cols = venueColumnsFromBreakdowns(bySize)
      w.venueNet = cols.venueNet
      w.venueNetBase = cols.venueNetBase
      w.breakdown = serialized
      w.pricedOnchain = true
      w.venueApy = onchainIrmVenueApy(w.c.pool, nowTs, {
        base: bySize['100k'].checks.reverts ? null : bySize['100k'].netIncentiveFree.apy,
        withRewards: bySize['100k'].checks.reverts ? null : bySize['100k'].net.apy,
        asOf: anchorTs,
        address: (w.resolution as Exclude<Resolution, { address: null }>).address,
      })
      applyCarry(w)
    }
  }

  // Vault finalists: re-average with the on-chain 7-day figure (owner ruling 1, 2026-10-11).
  for (const w of finalists) {
    const r = w.resolution?.address
      ? (w.resolution as Exclude<Resolution, { address: null }>)
      : null
    if (!r || !isVaultKind(r.kind) || w.c.exposure !== 'single') {
      if (w.vault && !w.pricedOnchain) {
        // Unresolved after all: nothing is known about the venue type, so DeFiLlama's figure.
        w.vault = null
        w.venueApy = llamaVenueApy(w.c.pool, nowTs)
        Object.assign(w, venueColumnsFromLlama(w.c.pool))
        applyCarry(w)
      }
      continue
    }
    w.vault = {
      kind: r.kind,
      morpho: morphoByAddress.get(r.address.toLowerCase()) ?? w.vault?.morpho ?? null,
    }
    const v = w.verification
    const onchain: Onchain7d =
      v?.ok && typeof v.trailing7dApy === 'number' && Number.isFinite(v.trailing7dApy)
        ? { value: v.trailing7dApy, asOf: anchorTs, address: r.address }
        : {
            error: !v
              ? 'not read'
              : !v.ok
                ? `not read: verification failed (${v.failed ?? 'unknown'})`
                : (v.trailing7dError ?? 'no 7-day figure'),
            asOf: anchorTs,
            address: r.address,
          }
    w.venueApy = averagedVenueApy({
      pool: w.c.pool,
      fetchedAt: nowTs,
      morpho: w.vault.morpho,
      kind: w.vault.kind,
      address: r.address,
      onchain,
    })
    Object.assign(w, venueColumnsFromAverage(w.venueApy, w.c.pool.tvlUsd))
    w.flags = w.flags.filter((f) => f !== 'source-disagreement')
    if (sourcesDisagree(w.venueApy)) w.flags.push('source-disagreement')
    applyCarry(w)
  }

  // ---------------------------------------------------------------- S7 lists, ranks, status
  const listed: { w: Work; list: ScoutList; reason?: string }[] = []
  const placed = placeFinalists(
    finalists.map((w) => ({
      address: w.resolution?.address ?? null,
      unresolvedReason: w.resolution && 'reason' in w.resolution ? w.resolution.reason : undefined,
      verification: w.verification,
      stability: w.stability,
      exposure: w.c.exposure,
      hasBenchmark: Boolean(w.bench['100k']),
      positive: isPositive(w),
    })),
  )
  finalists.forEach((w, i) => {
    const p = placed.placements[i]
    if ('drop' in p) drop(w.c.pool.pool, p.drop)
    else listed.push({ w, list: p.list, reason: p.reason })
  })

  const order = (x: Work, y: Work) =>
    a100(y) - a100(x) ||
    (y.carryABase['100k']?.apy ?? -Infinity) - (x.carryABase['100k']?.apy ?? -Infinity) ||
    (y.c.pool.count ?? 0) - (x.c.pool.count ?? 0) ||
    y.c.pool.tvlUsd - x.c.pool.tvlUsd
  const rankOf = new Map<Work, number>()
  for (const list of ['ranked', 'lp'] as const) {
    listed
      .filter((l) => l.list === list)
      .map((l) => l.w)
      .sort(order)
      .forEach((w, i) => rankOf.set(w, i + 1))
  }

  const keyOfWork = (w: Work): string | null =>
    w.resolution?.address ? keyOf(w.resolution.address) : null
  const current: CurrentRow[] = listed.map(({ w, list, reason }) => ({
    key: list === 'unverified' ? null : keyOfWork(w),
    aliases: [`llama:${w.c.pool.pool}`],
    list,
    carryA100k: w.carryA['100k']?.apy ?? null,
    label: w.label,
    protocol: w.c.pool.project,
    stable: w.c.stables.map((s) => s.symbol).join('/'),
    unrankedReason: reason,
  }))
  const gateByAlias = new Map<string, string>()
  for (const [uuid, gate] of trace) gateByAlias.set(`llama:${uuid}`, gate)
  // A re-run inside the same ISO week compares against the weeks before it, not itself.
  const past = [...deps.pastWeeks]
    .sort((a, b) => a.week.localeCompare(b.week))
    .filter((w) => w.week !== week)
  const status = computeStatuses(current, past, onApp.keys, gateByAlias)

  const rows: ScoutRow[] = listed.map(({ w, list, reason }, i) => {
    const key = current[i].key
    const st = key ? status.byKey.get(key) : undefined
    const stables = w.c.stables.map((s) => s.symbol)
    const kind = w.resolution?.address
      ? (w.resolution as Exclude<Resolution, { address: null }>).kind
      : w.c.exposure === 'multi'
        ? 'lp'
        : 'other'
    const resolved = w.resolution?.address
      ? (w.resolution as Exclude<Resolution, { address: null }>)
      : null
    const { readiness, segue } = scoutReadiness({
      list,
      kind,
      stables,
      address: resolved?.address ?? null,
      aavePool: resolved?.aavePool ?? null,
      withdraw: resolved?.withdraw,
    })
    const carryB = {} as Record<SizeKey, CarryB>
    for (const k of SIZE_KEYS) carryB[k] = carryBPair(w.venueNetBase[k], w.venueNet[k])
    const flags = [
      ...new Set([
        ...w.flags,
        ...((w.c.pool.count ?? 0) >= THRESHOLDS.badgeCount ? ['history-90d'] : []),
        ...(st?.persistent ? ['persistent'] : []),
      ]),
    ]
    return {
      key,
      aliases: [`llama:${w.c.pool.pool}`],
      label: w.label,
      protocol: w.c.pool.project,
      category: w.c.category,
      kind,
      stable: stables.join('/'),
      stables,
      exposure: w.c.exposure,
      address: resolved?.address ?? null,
      tvlUsd: w.c.pool.tvlUsd,
      count: w.c.pool.count ?? 0,
      apy: headlineApy(w.c.pool),
      apyBase: w.c.pool.apyBase === null ? null : baseApy(w.c.pool),
      apyReward: w.c.pool.apyReward === null ? null : Math.max(0, w.c.pool.apyReward) / 100,
      apyMean30d: w.c.pool.apyMean30d === null ? null : w.c.pool.apyMean30d / 100,
      venueNet: w.venueNet,
      venueNetBase: w.venueNetBase,
      bench: w.bench,
      carryA: w.carryA,
      carryABase: w.carryABase,
      carryA30d: w.carryA30d,
      carryB,
      stability: w.stability ?? null,
      verification: w.verification ?? null,
      flags,
      list,
      rank: rankOf.get(w) ?? null,
      unrankedReason: reason,
      status: st?.status ?? null,
      weeksInRow: st?.weeksInRow ?? 0,
      persistent: st?.persistent ?? null,
      readiness,
      segue,
      breakdown: w.breakdown,
      venueApy: w.venueApy,
      alsoBehindRoutes: w.alsoBehindRoutes,
    }
  })
  const venueOf = (r: ScoutRow): number => r.venueApy.withRewards ?? r.apy
  rows.sort(
    (x, y) =>
      listOrder(x.list) - listOrder(y.list) ||
      (x.rank ?? 1e9) - (y.rank ?? 1e9) ||
      venueOf(y) - venueOf(x),
  )

  const rankedCount = rows.filter((r) => r.list === 'ranked').length
  const counts: StageCounts = {
    ethStablePools: uni.ethStableCount,
    universeSingle: uni.universeSingle,
    universeLp: uni.universeLp,
    afterFilters: uni.single.length,
    afterFiltersLp: uni.lp.length,
    withBenchmark: singles.length - noBench.length,
    positive: positive.length,
    noBenchmark: noBench.length,
    onApp: onAppCount,
    alsoBehindRoute: rows.filter((r) => r.alsoBehindRoutes.length).length,
    finalists: finalists.length,
    verified: verifiedCount,
    stable: placed.stable,
    ranked: rankedCount,
    rankedLp: rows.filter((r) => r.list === 'lp').length,
    unverified: rows.filter((r) => r.list === 'unverified').length,
    dropped: status.dropped.length,
    new: status.newCount,
    gateTrace: traceCounts,
  }

  const file: CarryScanFile = {
    schemaVersion: CARRY_SCAN_SCHEMA_VERSION,
    week,
    asOf: nowTs,
    anchor: {
      blockNumber: anchor.blockNumber.toString(),
      blockTimestamp: anchor.blockTimestamp.toString(),
      blockHash: anchor.blockHash,
    },
    appSha: deps.appSha,
    rpc: rpcLabel,
    defaultSizeUsd: DEFAULT_SCAN_SIZE,
    sizes: [...SCAN_SIZES_USD],
    counts,
    benchmarks: bench.table,
    rows,
    dropped: status.dropped,
    nowOnApp: status.nowOnApp,
    sources,
    notes: [
      ...CARRY_SCAN_NOTES,
      ...onAppRouteNotes(onApp, (deps.onAppInputs ?? DEFAULT_ON_APP_INPUTS).aliases),
    ],
    venueApyRule: VENUE_APY_RULE,
  }
  const benchmarks: BenchmarksFile = {
    schemaVersion: CARRY_SCAN_SCHEMA_VERSION,
    week,
    asOf: nowTs,
    anchorBlock: anchor.blockNumber.toString(),
    table: bench.table,
    agreement: bench.agreement,
    rejectedSample: bench.rejected.slice(0, 60).map((r) => ({ venue: r.venue, reason: r.reason })),
    rejectedCount: bench.rejected.length,
  }

  // ---------------------------------------------------------------- S8 churn
  const lastWeek = past[past.length - 1]
  const lastRanked = lastWeek
    ? (lastWeek.counts?.ranked ?? lastWeek.rows.filter((r) => r.list === 'ranked').length)
    : null
  const churn = checkChurn(status.newCount, rankedCount, lastRanked, deps.acceptChurn)
  if (churn.held) return { kind: 'held', reason: churn.reason!, file, benchmarks }
  return { kind: 'published', file, benchmarks, note: churn.reason }
}

const listOrder = (l: ScoutList): number =>
  ({ ranked: 0, lp: 1, 'no-benchmark': 2, unverified: 3 })[l]
