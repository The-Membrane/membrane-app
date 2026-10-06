// Consensus: one market price per asset = the MEDIAN of its fresh market-class members in USD.
//
// "Market-class" is the catalog's consensus role `member`: market feeds, DEX TWAPs and
// market-equivalent composites, at most one per provider family (so Chainlink's three ETH/USD
// variants count once). Alternates, derived composites and basis feeds (exchange-rate,
// capped, fixed, peg-assumed) are coloured AGAINST the consensus but never vote in it.
//
// Band: every verdict on an asset uses its EFFECTIVE band, max(class band, d1 + d2) over the
// deviation thresholds its members declare (effectiveBand / bandOf, owner ruling 2026-10-05).
//
// Pure: readings and the clock come in as arguments.

import type { OracleCatalog, OracleEntry } from './catalog'
import { assessFreshness, normalizeToUsd, resolveQuote, type FreshnessContext } from './normalize'
import type {
  AssetConsensus,
  ConsensusExclusion,
  EffectiveBand,
  Freshness,
  NormalizedPrice,
  OracleReading,
  QuoteResolution,
  RiskClass,
} from './types'

/**
 * Fewer fresh members than this and the asset has no consensus (cards go 'unavailable').
 * Two members are a consensus only while they agree: see consensusOf.
 */
export const MIN_CONSENSUS_MEMBERS = 2

export function median(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = xs.length >> 1
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

// ---- bands -----------------------------------------------------------------------------

/**
 * CLASS band per risk class, in bps of the consensus — the FLOOR of an asset's band (the band
 * actually in force is effectiveBand below). A band must be wider than the gap an HONEST feed
 * can show between updates, or healthy cards flicker red/gold:
 *
 *  - major 50 — Chainlink ETH/USD and BTC/USD, RedStone and the WBTC/BTC ratio feeds all
 *    push on a 0.5% (50 bps) deviation trigger, so a correct feed can sit up to 50 bps from
 *    spot before it is obliged to update.
 *  - lst_lrt 75 — the USD price of an LST/LRT is a PRODUCT of two pushed legs (ratio ×
 *    ETH/USD), each on its own 50 bps trigger, plus a thinner secondary market. Two
 *    triggers compound to ~100 bps worst case; 75 bps sits between one and two, so a
 *    single lagging leg is tolerated and a real depeg is not.
 *  - stable 25 — dollar assets trade within a few bps across venues; stable-collateral
 *    markets run 91.5–96.5% LLTV, so 25 bps is already 5–10% of the liquidation buffer and is
 *    worth a colour.
 *  - fixed_income 50 — a Pendle PT is a dollar claim discounted by an implied rate; 50 bps
 *    ≈ a 1%/yr implied-rate disagreement on a six-month PT, and is generous near maturity.
 *
 * Owner ruling 2026-10-05 — the class band alone did not hold every honest pair: two feeds
 * can each lag spot in OPPOSITE directions while inside their own triggers, so they can sit up
 * to the SUM of their deviation thresholds apart (USDe/sUSDe: Chainlink 0.5% + RedStone 0.2%
 * = 70 bps against the ±25 bps stable band), and honest feeds were flagged. The band in
 * force is therefore effectiveBand: max(class band, d1 + d2) over the members' declared
 * thresholds. These class values are unchanged by that ruling.
 */
export const DEFAULT_BANDS_BPS: Readonly<Record<RiskClass, number>> = {
  stable: 25,
  major: 50,
  lst_lrt: 75,
  fixed_income: 50,
}

export const ASSET_RISK_CLASS: Readonly<Record<string, RiskClass>> = {
  ETH: 'major',
  BTC: 'major',
  WBTC: 'major',
  cbBTC: 'major',
  wstETH: 'lst_lrt',
  weETH: 'lst_lrt',
  USDe: 'stable',
  sUSDe: 'stable',
  sUSDS: 'stable',
}

export type BandConfig = {
  byClass?: Partial<Record<RiskClass, number>>
  byAsset?: Record<string, number>
}

export function riskClassOf(asset: string): RiskClass {
  if (ASSET_RISK_CLASS[asset]) return ASSET_RISK_CLASS[asset]
  if (asset.startsWith('PT-')) return 'fixed_income'
  return 'major'
}

/**
 * The CLASS band for an asset (a per-asset override, else its class's band) — the floor that
 * effectiveBand widens. Verdicts never use this directly; they use effectiveBand(...).bandBps.
 */
export function bandFor(asset: string, config: BandConfig = {}): number {
  const own = config.byAsset?.[asset]
  if (own != null) return own
  const cls = riskClassOf(asset)
  return config.byClass?.[cls] ?? DEFAULT_BANDS_BPS[cls]
}

/**
 * The band in force (owner ruling 2026-10-05):
 *
 *     bandBps = max(classBandBps, d1 + d2)
 *
 * where d1 ≥ d2 are the two largest deviation thresholds DECLARED among the asset's consensus
 * members. Two honest push feeds can sit up to d1 + d2 apart (each lagging spot in an
 * opposite direction inside its own trigger), so a band of that width colours them both
 * green, and the two-member agreement test (consensusOf: apart by more than two bands) can
 * never fire on them. Members that declare no threshold — TWAPs, Chronicle, pull oracles —
 * contribute nothing: with exactly one declared, bandBps = max(classBandBps, d1); with none,
 * the class band. The two largest are taken because the widest honest gap among n members is
 * between the two loosest feeds.
 *
 * Not covered, and still able to flag a feed that is working as designed: a feed with no
 * declared threshold that lags a fast market, and a composite's other legs (only the member's
 * own trigger is counted).
 */
export function effectiveBand(
  classBandBps: number,
  memberThresholdsBps: readonly (number | null | undefined)[],
): EffectiveBand {
  const declared = memberThresholdsBps
    .filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
    .sort((a, b) => b - a)
    .slice(0, 2)
  const feedSum = declared.reduce((sum, v) => sum + v, 0)
  return { bandBps: Math.max(classBandBps, feedSum), classBandBps, thresholdsBps: declared }
}

/**
 * An asset's effective band from the catalog: its consensus members (role 'member', the same
 * verified / includeUnverified filter the consensus uses) and their declared thresholds. It
 * is a property of the CATALOG, not of the moment: a member that is stale or unreadable still
 * counts, so no card changes colour because a different feed stopped updating, and the
 * snapshot, the header and every hour of the history replay share one band.
 */
export function bandOf(
  catalog: OracleCatalog,
  asset: string,
  opts: Pick<ConsensusOptions, 'bands' | 'includeUnverified'> = {},
): EffectiveBand {
  // Owner ruling 2026-10-05 widened the STABLE band only (honest stable feeds sit up to
  // d1 + d2 apart, e.g. USDe 50 + 20 bps vs a 25 bps band). Majors, LST/LRT and PTs keep
  // their class band: widening them to their feeds' triggers (cbBTC/USD has a 2% trigger,
  // so ±250 bps) would paint a real, persistent lag green. Extending it there is the
  // owner's call.
  if (riskClassOf(asset) !== 'stable') return effectiveBand(bandFor(asset, opts.bands), [])
  const thresholds = catalog.entries
    .filter(
      (e) =>
        e.asset === asset &&
        e.consensus.role === 'member' &&
        (opts.includeUnverified || e.status === 'verified'),
    )
    .map((e) => e.mechanism.deviationThresholdBps)
  return effectiveBand(bandFor(asset, opts.bands), thresholds)
}

// ---- one asset ---------------------------------------------------------------------------

export type ConsensusCandidate = {
  id: string
  usd: number | null
  /** Why the candidate cannot vote; undefined = eligible. */
  exclusion?: ConsensusExclusion['reason']
}

/**
 * Median of the eligible candidates; 'insufficient' below `minMembers`.
 *
 * Exactly two members are a tie, not a majority: their median is the midpoint, so each sits
 * half the spread away from it and a single bad feed would paint BOTH cards — the correct
 * one in the opposite colour. When that would happen (half the spread outside the band,
 * i.e. the two are more than two bands apart) nothing can say which feed is wrong, so the
 * asset has no consensus ('members_disagree') rather than a false outlier. `bandBps` is the
 * asset's EFFECTIVE band (effectiveBand), at least the sum of the two largest declared member
 * thresholds, so two honest feeds — at most that sum apart — always pass this test.
 */
export function consensusOf(
  asset: string,
  candidates: readonly ConsensusCandidate[],
  minMembers = MIN_CONSENSUS_MEMBERS,
  bandBps?: number,
): AssetConsensus {
  const eligible = candidates.filter((c) => !c.exclusion && c.usd != null) as {
    id: string
    usd: number
  }[]
  const excluded: ConsensusExclusion[] = candidates
    .filter((c) => c.exclusion || c.usd == null)
    .map((c) => ({ id: c.id, reason: c.exclusion ?? 'no_reading' }))
  if (eligible.length < Math.max(1, minMembers)) {
    return {
      asset,
      status: 'insufficient',
      price: null,
      reason: 'too_few_members',
      memberIds: eligible.map((c) => c.id),
      excluded,
      spreadBps: null,
      minMembers,
      ...(eligible.length === 1 ? { reference: { id: eligible[0].id, usd: eligible[0].usd } } : {}),
    }
  }
  const price = median(eligible.map((c) => c.usd)) as number
  const usds = eligible.map((c) => c.usd)
  const spreadBps = ((Math.max(...usds) - Math.min(...usds)) / price) * 10_000
  if (eligible.length === 2 && bandBps != null) {
    // The same rounding classify.deviationBps applies, so "outside" means what a card shows.
    const half = Math.max(...usds.map((u) => Math.abs(Math.round((u / price - 1) * 1e8) / 1e4)))
    if (half > bandBps)
      return {
        asset,
        status: 'insufficient',
        reason: 'members_disagree',
        price: null,
        memberIds: eligible.map((c) => c.id),
        excluded,
        spreadBps,
        minMembers,
      }
  }
  return {
    asset,
    status: 'ok',
    price,
    memberIds: eligible.map((c) => c.id),
    excluded,
    spreadBps,
    minMembers,
  }
}

// ---- the whole catalog -------------------------------------------------------------------

export type EvaluatedEntry = {
  entry: OracleEntry
  reading: OracleReading | undefined
  quote: QuoteResolution
  freshness: Freshness
  normalized: NormalizedPrice
}

export type ConsensusOptions = {
  minMembers?: number
  includeUnverified?: boolean
  bands?: BandConfig
}

export type ResolvedConsensus = {
  byAsset: Map<string, AssetConsensus>
  /** Each catalog asset's effective band (bandOf) — the one its consensus test used. */
  bands: Map<string, EffectiveBand>
  /** Every catalog entry normalized with the final rates (members, alternates, derived, basis). */
  entries: Map<string, EvaluatedEntry>
}

function exclusionFor(n: NormalizedPrice, f: Freshness): ConsensusExclusion['reason'] | undefined {
  if (n.reason) return n.reason
  if (f.state === 'stale') return 'stale'
  if (f.state === 'unknown') return 'unknown_freshness'
  return undefined
}

/**
 * Resolve every asset's consensus in dependency order: an asset whose members quote in ETH,
 * BTC, WBTC or USDe needs that asset's consensus first (weETH/ETH × ETH/USD; cbBTC/WBTC ×
 * WBTC/USD). Assets are resolved as soon as their dependencies are; a cycle or a missing
 * dependency resolves with those members marked 'no_conversion' rather than guessed.
 */
export function resolveConsensus(
  catalog: OracleCatalog,
  readings: ReadonlyMap<string, OracleReading>,
  now: number,
  opts: ConsensusOptions = {},
): ResolvedConsensus {
  const minMembers = opts.minMembers ?? MIN_CONSENSUS_MEMBERS
  const assetKeys = new Set(catalog.assets.map((a) => a.key))
  const live = catalog.entries.filter((e) => opts.includeUnverified || e.status === 'verified')
  const byId = new Map(catalog.entries.map((e) => [e.id, e]))
  const byAddress = new Map<string, OracleEntry>()
  for (const e of catalog.entries) {
    const k = e.address.toLowerCase()
    if (!byAddress.has(k)) byAddress.set(k, e)
  }
  // Freshness is recursive (a view inherits its legs' verdicts), so it is memoised per call
  // and a reference cycle resolves to "no verdict" for the leg that closes it.
  const memo = new Map<string, Freshness>()
  const inProgress = new Set<string>()
  const ctx: FreshnessContext = {
    entryById: (id) => byId.get(id),
    entryByAddress: (address) => byAddress.get(address.toLowerCase()),
    freshnessOf: (id) => {
      const hit = memo.get(id)
      if (hit) return hit
      const e = byId.get(id)
      if (!e || inProgress.has(id)) return undefined
      inProgress.add(id)
      const f = assessFreshness(e, readings.get(id), now, ctx)
      inProgress.delete(id)
      memo.set(id, f)
      return f
    },
  }
  const freshnessOf = (e: OracleEntry): Freshness =>
    ctx.freshnessOf?.(e.id) ?? assessFreshness(e, readings.get(e.id), now, ctx)
  const quotes = new Map(live.map((e) => [e.id, resolveQuote(e, assetKeys)]))
  const byAsset = new Map<string, AssetConsensus>()
  const bands = new Map(catalog.assets.map((a) => [a.key, bandOf(catalog, a.key, opts)]))
  const rateOf = (asset: string) => {
    const c = byAsset.get(asset)
    return c?.status === 'ok' ? c.price : null
  }

  const members = new Map<string, OracleEntry[]>()
  for (const e of live) {
    if (e.consensus.role !== 'member') continue
    const list = members.get(e.asset) ?? []
    list.push(e)
    members.set(e.asset, list)
  }
  const depsOf = (asset: string) => {
    const deps = new Set<string>()
    for (const e of members.get(asset) ?? []) {
      const q = quotes.get(e.id)
      if (q?.kind === 'asset' && q.asset !== asset) deps.add(q.asset)
    }
    return deps
  }

  const pending = new Set(catalog.assets.map((a) => a.key))
  const resolveOne = (asset: string) => {
    const candidates: ConsensusCandidate[] = (members.get(asset) ?? []).map((e) => {
      const reading = readings.get(e.id)
      const quote = quotes.get(e.id) as QuoteResolution
      const n = normalizeToUsd(reading, quote, rateOf)
      const f = freshnessOf(e)
      return { id: e.id, usd: n.usd, exclusion: exclusionFor(n, f) }
    })
    const band = bands.get(asset) ?? bandOf(catalog, asset, opts)
    byAsset.set(asset, consensusOf(asset, candidates, minMembers, band.bandBps))
    pending.delete(asset)
  }
  while (pending.size) {
    const ready = [...pending].filter((a) => [...depsOf(a)].every((d) => !pending.has(d)))
    // A cycle (or a dependency on an asset outside the catalog) — resolve the rest with
    // whatever rates exist; the unresolvable members are excluded as 'no_conversion'.
    for (const a of ready.length ? ready : [...pending]) resolveOne(a)
  }

  const entries = new Map<string, EvaluatedEntry>()
  for (const e of live) {
    const reading = readings.get(e.id)
    const quote = quotes.get(e.id) as QuoteResolution
    entries.set(e.id, {
      entry: e,
      reading,
      quote,
      freshness: freshnessOf(e),
      normalized: normalizeToUsd(reading, quote, rateOf),
    })
  }
  return { byAsset, bands, entries }
}
