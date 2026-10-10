// capacityCurve.ts — pure logic over recorded venue_depth_curves rows
// (scripts/record-depth-curves.mjs). No I/O.
//
// A market curve is [{costPct, capacityUsd}]: the largest USD exit of the venue
// token whose cost incl. fees stays at or under costPct, quoted on-chain at the
// recorded levels. capacityUsd null = the quote reverted (unknown, never 0).
//
// COMBINING MARKETS (why a SUM is valid): a holder can split one exit across a
// venue's markets. If every leg costs at most c, the whole exit costs at most c
// (the total cost is the value-weighted average of the leg costs). So the sum of
// each market's capacity at c is an achievable exit at cost <= c — a floor on the
// best split. This holds ONLY for INDEPENDENT pools: selling into one must not
// move the other's price within the exit. Two pools that share liquidity (one
// routes through the other, a meta-pool over a base pool, two views of the same
// buffer) would double-count and must not be summed.

export type CurvePoint = { costPct: number; capacityUsd: number | null }

// Must match scripts/lib/depthCurve.mjs COST_LEVELS_PCT, which writes the rows.
// The API rejects a latest-block pass missing any of these levels; it must not
// publish a partial venue curve as if it represented every exit route.
export const RECORDED_COST_LEVELS_PCT = [0.1, 0.25, 0.5, 1, 2, 5, 10] as const

export type StoredCurveRow = {
  market: unknown
  block: unknown
  observed_at: unknown
  points: unknown
  meta: unknown
}

export type StoredCurvePassRow = StoredCurveRow & { block_row_count: unknown }

/** Exact configured-market and quote-level gate for one recorder pass. */
export function hasCompleteCurvePass(rows: readonly StoredCurveRow[], expectedMarkets: readonly string[]): boolean {
  if (expectedMarkets.length === 0 || rows.length !== expectedMarkets.length) return false
  const expected = new Set(expectedMarkets)
  if (expected.size !== expectedMarkets.length) return false
  const seen = new Set<string>()
  let block: number | null = null

  for (const row of rows) {
    if (typeof row.market !== 'string' || !expected.has(row.market) || seen.has(row.market)) return false
    seen.add(row.market)
    const rowBlock = Number(row.block)
    if (!Number.isSafeInteger(rowBlock) || rowBlock <= 0 || (block !== null && rowBlock !== block)) return false
    block = rowBlock
    if (typeof row.observed_at !== 'string' && !(row.observed_at instanceof Date)) return false
    if (!Number.isFinite(new Date(row.observed_at).getTime())) return false
    if (typeof row.meta !== 'object' || row.meta === null || Array.isArray(row.meta)) return false
    if ((row.meta as Record<string, unknown>).error != null) return false
    if (!Array.isArray(row.points) || row.points.length !== RECORDED_COST_LEVELS_PCT.length) return false
    const levels = new Set<number>()
    let previousCapacity = -Infinity
    for (const point of row.points) {
      if (typeof point !== 'object' || point === null || Array.isArray(point)) return false
      const p = point as Record<string, unknown>
      if (typeof p.costPct !== 'number' || p.costPct !== RECORDED_COST_LEVELS_PCT[levels.size] || levels.has(p.costPct)) return false
      if (typeof p.capacityUsd !== 'number' || !Number.isFinite(p.capacityUsd) || p.capacityUsd < 0) return false
      if (p.capacityUsd < previousCapacity) return false
      previousCapacity = p.capacityUsd
      levels.add(p.costPct)
    }
  }
  return seen.size === expected.size
}

/** Pick a complete pass from DB-ordered newest-first rows, never from a truncated block group. */
export function selectRecentCompleteCurvePass(
  rows: readonly StoredCurvePassRow[],
  expectedMarkets: readonly string[],
  expectedIdentities: Readonly<Record<string, string>>,
): { rows: StoredCurvePassRow[]; latestPassIncomplete: boolean } | null {
  const byBlock = new Map<string, StoredCurvePassRow[]>()
  for (const row of rows) {
    const key = String(row.block)
    const group = byBlock.get(key) ?? []
    group.push(row)
    byBlock.set(key, group)
  }
  let index = 0
  for (const group of byBlock.values()) {
    const count = Number(group[0].block_row_count)
    if (
      Number.isSafeInteger(count) &&
      count === group.length &&
      group.every((row) => Number(row.block_row_count) === count) &&
      hasCompleteCurvePass(group, expectedMarkets) &&
      group.every((row) => {
        const meta = row.meta as Record<string, unknown>
        return (
          typeof row.market === 'string' &&
          typeof expectedIdentities[row.market] === 'string' &&
          meta.configIdentity === expectedIdentities[row.market] &&
          typeof meta.sourceBlockTime === 'string' &&
          Number.isFinite(Date.parse(meta.sourceBlockTime)) &&
          typeof meta.sourceBlockHash === 'string' &&
          /^0x[0-9a-f]{64}$/.test(meta.sourceBlockHash)
        )
      }) &&
      group.every((row) => {
        const meta = row.meta as Record<string, unknown>
        const first = group[0].meta as Record<string, unknown>
        return (
          meta.sourceBlockTime === first.sourceBlockTime &&
          meta.sourceBlockHash === first.sourceBlockHash
        )
      })
    ) {
      return { rows: group, latestPassIncomplete: index > 0 }
    }
    index++
  }
  return null
}

export type MarketCurve = {
  market: string
  points: CurvePoint[]
}

/** Text-fallback presets (owner 2026-09-26): capacity at 0.5%, 1% and 5% cost. */
export const CAPACITY_PRESETS_PCT = [0.5, 1, 5] as const

/** The slider's range, % cost incl. fees. */
export const CAPACITY_SLIDER_MIN_PCT = 0.1
export const CAPACITY_SLIDER_MAX_PCT = 10

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function sorted(points: CurvePoint[]): CurvePoint[] {
  return [...points].filter((p) => finite(p.costPct)).sort((a, b) => a.costPct - b.costPct)
}

/**
 * One venue curve from its markets: at each cost level any market quoted, the
 * SUM of the markets' capacities. If any market is null (or did not quote that
 * level), the venue level is null — a partial sum would be read as the whole.
 */
export function combineMarkets(markets: MarketCurve[]): CurvePoint[] {
  if (markets.length === 0) return []
  const levels = Array.from(new Set(markets.flatMap((m) => m.points.map((p) => p.costPct)).filter(finite))).sort(
    (a, b) => a - b,
  )
  return levels.map((costPct) => {
    let sum = 0
    for (const m of markets) {
      const p = m.points.find((x) => x.costPct === costPct)
      if (!p || !finite(p.capacityUsd)) return { costPct, capacityUsd: null }
      sum += p.capacityUsd
    }
    return { costPct, capacityUsd: sum }
  })
}

/** True when the non-null capacities never fall as cost rises. */
export function isMonotone(points: CurvePoint[]): boolean {
  let prev = -Infinity
  for (const p of sorted(points)) {
    if (!finite(p.capacityUsd)) continue
    if (p.capacityUsd < prev) return false
    prev = p.capacityUsd
  }
  return true
}

export type CapacityReading =
  | { kind: 'quoted'; costPct: number; capacityUsd: number }
  | {
      kind: 'interpolated'
      costPct: number
      capacityUsd: number
      /** The bracketing quoted points: the true capacity lies in [lowerUsd, upperUsd]. */
      lowerUsd: number
      upperUsd: number
      fromPct: number
      toPct: number
    }
  | { kind: 'below-range' | 'beyond-range' | 'unavailable'; costPct: number; capacityUsd: null }

/**
 * Capacity at any cost. Exactly on a level: 'quoted'. Between two adjacent
 * NON-NULL levels: linear in cost, 'interpolated', with the bracket (curves are
 * monotone, so the truth is between the two quoted capacities). Below the first
 * or past the last quoted level: null — never extrapolated. Next to a null level:
 * 'unavailable'.
 */
export function capacityAt(points: CurvePoint[], costPct: number): CapacityReading {
  const pts = sorted(points)
  if (!finite(costPct) || pts.length === 0) return { kind: 'unavailable', costPct, capacityUsd: null }
  const exact = pts.find((p) => p.costPct === costPct)
  if (exact) {
    return finite(exact.capacityUsd)
      ? { kind: 'quoted', costPct, capacityUsd: exact.capacityUsd }
      : { kind: 'unavailable', costPct, capacityUsd: null }
  }
  if (costPct < pts[0].costPct) return { kind: 'below-range', costPct, capacityUsd: null }
  if (costPct > pts[pts.length - 1].costPct) return { kind: 'beyond-range', costPct, capacityUsd: null }
  const k = pts.findIndex((p) => p.costPct > costPct)
  const a = pts[k - 1]
  const b = pts[k]
  if (!finite(a.capacityUsd) || !finite(b.capacityUsd)) return { kind: 'unavailable', costPct, capacityUsd: null }
  const t = (costPct - a.costPct) / (b.costPct - a.costPct)
  return {
    kind: 'interpolated',
    costPct,
    capacityUsd: a.capacityUsd + t * (b.capacityUsd - a.capacityUsd),
    lowerUsd: Math.min(a.capacityUsd, b.capacityUsd),
    upperUsd: Math.max(a.capacityUsd, b.capacityUsd),
    fromPct: a.costPct,
    toPct: b.costPct,
  }
}

/** The three text-fallback readings. */
export function presetReadings(points: CurvePoint[]): CapacityReading[] {
  return CAPACITY_PRESETS_PCT.map((c) => capacityAt(points, c))
}

export type SizeCostReading =
  /** size fits within the first quoted level: cost is AT MOST that level. */
  | { kind: 'within-first'; sizeUsd: number; costPct: number; atMostPct: number }
  /** size lands exactly on a quoted capacity. */
  | { kind: 'quoted'; sizeUsd: number; costPct: number }
  /** size lands between two quoted capacities: linear in capacity, cost bracketed by the two levels. */
  | { kind: 'interpolated'; sizeUsd: number; costPct: number; fromPct: number; toPct: number }
  /** size is larger than the last quoted capacity: never extrapolated. */
  | { kind: 'beyond-quoted-depth'; sizeUsd: number; costPct: null; lastQuotedUsd: number; lastQuotedPct: number }
  | { kind: 'unavailable'; sizeUsd: number; costPct: null }

/**
 * The inverse read: the cost (incl. fees) of exiting `sizeUsd` in one go, read
 * off the curve. Size <= the first quoted capacity: 'within-first' (cost at most
 * that level). Between two adjacent NON-NULL levels: linear in capacity, flagged
 * 'interpolated' (the true cost lies in (fromPct, toPct]). Larger than the last
 * quoted capacity: 'beyond-quoted-depth', never extrapolated. A null next to the
 * size's bracket: 'unavailable'.
 */
export function costAtSize(points: CurvePoint[], sizeUsd: number): SizeCostReading {
  const pts = sorted(points)
  if (!finite(sizeUsd) || sizeUsd < 0 || pts.length === 0) return { kind: 'unavailable', sizeUsd, costPct: null }
  const first = pts[0]
  if (!finite(first.capacityUsd)) return { kind: 'unavailable', sizeUsd, costPct: null }
  if (sizeUsd <= first.capacityUsd) {
    return { kind: 'within-first', sizeUsd, costPct: first.costPct, atMostPct: first.costPct }
  }
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]
    const b = pts[k]
    if (!finite(a.capacityUsd) || !finite(b.capacityUsd)) return { kind: 'unavailable', sizeUsd, costPct: null }
    if (sizeUsd === b.capacityUsd) return { kind: 'quoted', sizeUsd, costPct: b.costPct }
    if (sizeUsd < b.capacityUsd) {
      const t = (sizeUsd - a.capacityUsd) / (b.capacityUsd - a.capacityUsd)
      return { kind: 'interpolated', sizeUsd, costPct: a.costPct + t * (b.costPct - a.costPct), fromPct: a.costPct, toPct: b.costPct }
    }
  }
  const last = pts[pts.length - 1]
  return {
    kind: 'beyond-quoted-depth',
    sizeUsd,
    costPct: null,
    lastQuotedUsd: last.capacityUsd as number,
    lastQuotedPct: last.costPct,
  }
}

/** GET /api/venues/[venue]/capacity-curve — shared by the route and its readers. */
export type CapacityCurveResponse = {
  venue: string
  /** True only when a failed latest pass forced an older complete curve; read curve's original age. */
  latestPassIncomplete?: boolean
  /** Why curve is null; never silently publish partial latest-block depth. */
  unavailableReason?: 'not-configured' | 'no-recording' | 'incomplete-latest'
  /** null when no complete current recorder pass is available. */
  curve: {
    block: number
    observedAt: string
    /** Timestamp of the quoted chain block; absent only in legacy callers. */
    sourceBlockTime?: string
    /** The venue curve: markets summed level by level (combineMarkets). */
    points: CurvePoint[]
    markets: Array<{
      market: string
      points: CurvePoint[]
      route: string | null
      /** 'curve get_dy' | 'psm tout' */
      source: string | null
      navUsd: number | null
      /** Curve pool fee in bps (get_dy includes it) or PSM tout in bps. */
      feeBps: number | null
      /** The raw swap-into reserve at $1 — the ceiling, not an exit at par. */
      reserveUsd: number | null
      error: string | null
    }>
    reserveUsd: number | null
  } | null
}

// --- cost ceiling (owner 2026-09-26: the cost scale ends where capacity maxes out) ---
/** Share of the pool's reserve that counts as "drained" for the ceiling. */
export const DRAINED_SHARE = 0.99

export type CostCeiling = {
  costPct: number
  capacityUsd: number
  /** pool drained: the value received reached DRAINED_SHARE of the reserve; paying more buys nothing.
   *  capacity flat: capacity stopped growing (e.g. a PSM buffer at its fee). last quote: neither, within the quoted range. */
  reason: 'pool drained' | 'capacity flat' | 'last quote'
}

/**
 * The lowest quoted cost at which exit capacity is maxed out. Past it, a larger
 * "capacity" only means paying more for the same output, so charts and levers
 * stop here. reserveUsd = the swap-into reserve(s) summed; null when unknown.
 */
export function costCeiling(points: CurvePoint[], reserveUsd: number | null): CostCeiling | null {
  const q = points
    .filter((p): p is { costPct: number; capacityUsd: number } => p.capacityUsd !== null)
    .sort((a, b) => a.costPct - b.costPct)
  if (q.length === 0) return null
  const max = q[q.length - 1].capacityUsd
  for (const p of q) {
    if (reserveUsd != null && reserveUsd > 0 && p.capacityUsd * (1 - p.costPct / 100) >= reserveUsd * DRAINED_SHARE) {
      return { costPct: p.costPct, capacityUsd: p.capacityUsd, reason: 'pool drained' }
    }
    if (p.capacityUsd >= max * (1 - 1e-3)) {
      // First point at the maximum: earlier than the last quote = the curve went flat;
      // only at the last quote = still rising when the quotes end.
      const atLast = q.length > 1 && p === q[q.length - 1]
      return { costPct: p.costPct, capacityUsd: p.capacityUsd, reason: atLast ? 'last quote' : 'capacity flat' }
    }
  }
  const last = q[q.length - 1]
  return { costPct: last.costPct, capacityUsd: last.capacityUsd, reason: 'last quote' }
}

/** Sum of the markets' reserves; null if any market's reserve is unknown. */
export function venueReserveUsd(markets: Array<{ reserveUsd: number | null }>): number | null {
  if (markets.length === 0 || markets.some((m) => m.reserveUsd == null)) return null
  return markets.reduce((a, m) => a + (m.reserveUsd as number), 0)
}

// --- slider (log scale: 0.1%..ceiling) -----------------------------------------
export const SLIDER_STEPS = 1000
const SNAP_LOG = 0.02 // snap to a quoted level within ~2% of it (in cost terms)

/** Slider position [0, SLIDER_STEPS] -> cost %, log-spaced, snapped onto a quoted level when close. */
export function sliderToCost(step: number, levels: readonly number[] = [], maxPct: number = CAPACITY_SLIDER_MAX_PCT): number {
  const t = Math.min(Math.max(step, 0), SLIDER_STEPS) / SLIDER_STEPS
  const raw = CAPACITY_SLIDER_MIN_PCT * (maxPct / CAPACITY_SLIDER_MIN_PCT) ** t
  for (const l of levels) if (Math.abs(Math.log(raw / l)) < SNAP_LOG) return l
  return Number(raw.toPrecision(3))
}

/** Inverse of sliderToCost. */
export function costToSlider(costPct: number, maxPct: number = CAPACITY_SLIDER_MAX_PCT): number {
  if (maxPct <= CAPACITY_SLIDER_MIN_PCT) return 0
  const c = Math.min(Math.max(costPct, CAPACITY_SLIDER_MIN_PCT), maxPct)
  return Math.round((Math.log(c / CAPACITY_SLIDER_MIN_PCT) / Math.log(maxPct / CAPACITY_SLIDER_MIN_PCT)) * SLIDER_STEPS)
}
