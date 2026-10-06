// Normalization: every reading → USD, and every reading → a freshness verdict.
//
// Pure. The caller supplies the clock (`now`) and the conversion rates (the consensus USD
// price of ETH, BTC, WBTC, USDe… at the SAME moment as the reading), so a snapshot and a
// historical grid point are normalized by the same code.

import type { OracleComponent, OracleEntry } from './catalog'
import type { Freshness, NormalizedPrice, OracleReading, QuoteResolution } from './types'

/**
 * Stablecoins a USD-quoted oracle may actually be denominated in (a Morpho oracle prices
 * collateral in its loan token; Chronicle's cbBTC feed quotes USDC). They are taken at $1 and
 * the card says so — the peg is an assumption, not a measurement.
 */
export const USD_PEG_ASSUMED: ReadonlySet<string> = new Set([
  'USDC',
  'USDT',
  'RLUSD',
  'PYUSD',
  'DAI',
  'USDS',
])

/**
 * Quote assets that are not catalog assets but map onto one. WETH is ETH exactly (1:1 wrap,
 * not an assumption); stETH is taken as ETH (peg assumed — the same assumption Spark's and
 * Liquity's wstETH oracles make), so the card is labelled.
 */
const QUOTE_ALIASES: Record<string, { asset: string; pegAssumed?: string }> = {
  WETH: { asset: 'ETH' },
  stETH: { asset: 'ETH', pegAssumed: 'stETH' },
}

/** Which asset's consensus (if any) turns this entry's quote into USD. */
export function resolveQuote(entry: OracleEntry, assetKeys: ReadonlySet<string>): QuoteResolution {
  const qa = entry.quoteAsset
  const asAsset = (name: string): QuoteResolution => {
    const alias = QUOTE_ALIASES[name]
    if (alias) return { kind: 'asset', asset: alias.asset, pegAssumed: alias.pegAssumed }
    if (assetKeys.has(name)) return { kind: 'asset', asset: name }
    return { kind: 'unsupported', reason: `no consensus for quote asset ${name}` }
  }
  switch (entry.quoteUnit) {
    case 'USD':
      if (!qa || qa === 'USD') return { kind: 'usd' }
      if (USD_PEG_ASSUMED.has(qa)) return { kind: 'usd', pegAssumed: qa }
      return asAsset(qa)
    case 'ETH':
      return asAsset(qa ?? 'ETH')
    case 'BTC':
      return asAsset(qa ?? 'BTC')
    case 'underlying':
      return qa
        ? asAsset(qa)
        : { kind: 'unsupported', reason: 'underlying quote without quoteAsset' }
    default:
      return { kind: 'unsupported', reason: `quote unit ${entry.quoteUnit} has no USD path` }
  }
}

/**
 * The reading in USD. Non-USD quotes are multiplied by the quote asset's consensus at the
 * same time and flagged `derived`; a missing rate yields `no_conversion`, never a guess.
 */
export function normalizeToUsd(
  reading: Pick<OracleReading, 'price'> | undefined,
  quote: QuoteResolution,
  rateOf: (asset: string) => number | null,
): NormalizedPrice {
  const price = reading?.price
  if (price == null || !Number.isFinite(price) || price <= 0)
    return { usd: null, derived: false, reason: 'no_reading' }
  if (quote.kind === 'unsupported')
    return { usd: null, derived: false, reason: 'unsupported_quote' }
  if (quote.kind === 'usd') {
    return quote.pegAssumed
      ? { usd: price, derived: false, pegAssumed: quote.pegAssumed }
      : { usd: price, derived: false }
  }
  const rate = rateOf(quote.asset)
  const peg = quote.pegAssumed ? { pegAssumed: quote.pegAssumed } : {}
  if (rate == null || !Number.isFinite(rate) || rate <= 0)
    return { usd: null, derived: true, reason: 'no_conversion', ...peg }
  return { usd: price * rate, derived: true, conversion: { asset: quote.asset, rate }, ...peg }
}

// ---- freshness -----------------------------------------------------------------------

/** Pull oracles (Pyth on Ethereum) are stale past one hour — the catalog's policy. */
export const PULL_MAX_AGE_SECONDS = 3600

/**
 * Feeds that expose an age but publish no on-chain heartbeat (Chronicle). 90,000 s (25 h)
 * is the acceptable-source-age bound Spark's own median oracle applies to these same
 * Chronicle feeds — a consumer-published threshold, not one invented here.
 */
export const AGE_ONLY_MAX_AGE_SECONDS = 90_000

/** grace = max(600 s, 10% of heartbeat) — the catalog's staleness policy. */
export function graceSeconds(heartbeatSeconds: number): number {
  return Math.max(600, Math.round(heartbeatSeconds * 0.1))
}

/** The age past which this entry's own timestamp counts as stale. */
export function freshnessLimit(entry: OracleEntry): {
  limitSeconds: number
  basis: 'heartbeat' | 'pull' | 'age_only'
} {
  if (entry.mechanism.updateModel === 'pull')
    return { limitSeconds: PULL_MAX_AGE_SECONDS, basis: 'pull' }
  const hb = entry.mechanism.heartbeatSeconds
  if (hb != null && hb > 0) return { limitSeconds: hb + graceSeconds(hb), basis: 'heartbeat' }
  return { limitSeconds: AGE_ONLY_MAX_AGE_SECONDS, basis: 'age_only' }
}

const LIVE_MODELS = new Set(['twap', 'on_read_view', 'on_interaction'])

/** heartbeat + grace, or the age-only bound when no heartbeat is published. */
function limitForHeartbeat(hb: number | null | undefined): number {
  return hb != null && hb > 0 ? hb + graceSeconds(hb) : AGE_ONLY_MAX_AGE_SECONDS
}

/** Lookups that let assessFreshness judge a view by its legs. */
export type FreshnessContext = {
  entryById?: (id: string) => OracleEntry | undefined
  /** The catalog entry at an address — for a leg that carries no `ref`. */
  entryByAddress?: (address: string) => OracleEntry | undefined
  /**
   * Another entry's freshness at the SAME moment. A leg that is itself a catalog entry is
   * judged by that entry's own verdict, recursively — so a leg whose clock is the read time
   * (Spark's median) or that has no clock of its own (a capped adapter over a Chainlink
   * feed) still passes on the age of the feed underneath it.
   */
  freshnessOf?: (id: string) => Freshness | undefined
}

/**
 * Freshness of one reading at `now`:
 *   own timestamp       → stale past heartbeat + grace (pull: 1 h; no heartbeat: age-only limit);
 *                          ignored when the catalog says it is the read time;
 *   component ages      → stale when ANY leg is past its own limit. A leg that is a catalog
 *                          entry (by `ref`, else by address) uses that entry's verdict; other
 *                          legs use their declared heartbeat, else this entry's;
 *   neither, live model → 'live' (a TWAP or a view computed from live state at read time);
 *   neither, push feed  → 'unknown' (never counted in consensus, never green).
 */
export function assessFreshness(
  entry: OracleEntry,
  reading: OracleReading | undefined,
  now: number,
  context?: FreshnessContext | ((id: string) => OracleEntry | undefined),
): Freshness {
  const ctx: FreshnessContext =
    typeof context === 'function' ? { entryById: context } : (context ?? {})
  if (!reading || reading.price == null)
    return { state: 'unknown', ageSeconds: null, limitSeconds: null, basis: 'none' }
  const m = entry.mechanism
  if (!m.timestampIsReadTime && reading.updatedAt != null && reading.updatedAt > 0) {
    const ageSeconds = Math.max(0, now - reading.updatedAt)
    const { limitSeconds, basis } = freshnessLimit(entry)
    return { state: ageSeconds > limitSeconds ? 'stale' : 'fresh', ageSeconds, limitSeconds, basis }
  }

  const self = entry.address.toLowerCase()
  const legEntry = (k: OracleComponent | undefined, address: string) => {
    const e = k?.ref ? ctx.entryById?.(k.ref) : ctx.entryByAddress?.(address)
    return e && e.id !== entry.id && e.address.toLowerCase() !== self ? e : undefined
  }
  const clocks: { age: number; limit: number }[] = []
  const judged = new Set<string>()
  // 1. Legs that are catalog entries: that entry's own verdict at this moment.
  for (const k of m.components) {
    if (k.timestampIsReadTime) continue
    const ref = legEntry(k, k.address)
    const f = ref ? ctx.freshnessOf?.(ref.id) : undefined
    if (!f || (f.state !== 'fresh' && f.state !== 'stale')) continue
    if (f.ageSeconds == null || f.limitSeconds == null) continue
    clocks.push({ age: f.ageSeconds, limit: f.limitSeconds })
    judged.add(k.address.toLowerCase())
  }
  // 2. Legs read by the collector (latestRoundData on each component at the same block).
  for (const c of reading.components ?? []) {
    if (c.updatedAt == null || !(c.updatedAt > 0)) continue
    const addr = c.address.toLowerCase()
    if (judged.has(addr)) continue
    const k = m.components.find((x) => x.address.toLowerCase() === addr)
    if (k?.timestampIsReadTime) continue
    const ref = legEntry(k, c.address)
    const limit =
      k?.heartbeatSeconds != null
        ? limitForHeartbeat(k.heartbeatSeconds)
        : ref
          ? freshnessLimit(ref).limitSeconds
          : limitForHeartbeat(m.heartbeatSeconds)
    clocks.push({ age: Math.max(0, now - c.updatedAt), limit })
  }
  if (clocks.length) {
    let w = clocks[0]
    for (const c of clocks) if (c.limit - c.age < w.limit - w.age) w = c
    return {
      state: w.age > w.limit ? 'stale' : 'fresh',
      ageSeconds: w.age,
      limitSeconds: w.limit,
      basis: 'components',
    }
  }
  if (LIVE_MODELS.has(m.updateModel))
    return { state: 'live', ageSeconds: null, limitSeconds: null, basis: 'live' }
  return { state: 'unknown', ageSeconds: null, limitSeconds: null, basis: 'none' }
}
