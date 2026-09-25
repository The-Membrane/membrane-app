// Pure logic for the risk desk (/[chain]/risk). No I/O — the loader reads the
// chain, this file turns raw reads into rows. Formulas mirror
// membrane-solidity feat/ltv-change-cap; line refs are into that checkout.

export const WAD = 10n ** 18n

/** lib/Constants.sol:214 — max LTV move per window, WAD (5e16 = 5 pp). */
export const MAX_LTV_MOVE_PER_PERIOD = 5n * 10n ** 16n
/** lib/Constants.sol:241 — one glide window, seconds (14 days). */
export const LTV_GLIDE_PERIOD_S = 14n * 86_400n
/** lib/Constants.sol:268 — hard floor of Disco MBRN before its ratio counts. */
export const MIN_DISCO_LTV_SUPPLY = 1000n * WAD

export type Glide = { applied: bigint; committed: bigint; windowStart: bigint; seeded: boolean }

/** bytes32 → printable denom (right-padded ASCII, e.g. "WETH"). */
export function decodeDenom(hex: string): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  let out = ''
  for (let i = 0; i + 2 <= h.length; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16)
    if (c === 0) break
    out += c >= 32 && c < 127 ? String.fromCharCode(c) : '?'
  }
  return out || hex
}

/**
 * Collateral._glidedValue (Collateral.sol:568-582), bit-exact:
 * applied + committed × min(1, elapsed/P), signed division truncating toward
 * zero (BigInt `/` also truncates toward zero), clamped to [0, cap].
 */
export function glidedValue(cap: bigint, g: Glide, nowS: bigint): bigint {
  const elapsed = nowS - g.windowStart
  let moved = g.committed
  if (elapsed < LTV_GLIDE_PERIOD_S) moved = (moved * elapsed) / LTV_GLIDE_PERIOD_S
  const v = g.applied + moved
  if (v <= 0n) return 0n
  return v > cap ? cap : v
}

export type Direction = 'up' | 'down' | 'flat'

export type GlideProjection = {
  now: bigint
  end: bigint
  windowStart: bigint
  windowEnd: bigint
  direction: Direction
  /** 0..1 share of the window elapsed at `nowS`. */
  progress: number
  windowOpen: boolean
  pctOfCapNow: number
  pctOfCapEnd: number
}

/** Where the enforced line is now and where it lands when this window closes. */
export function projectGlide(cap: bigint, g: Glide, nowS: bigint): GlideProjection {
  const windowEnd = g.windowStart + LTV_GLIDE_PERIOD_S
  const now = glidedValue(cap, g, nowS)
  const end = glidedValue(cap, g, windowEnd)
  const direction: Direction = g.committed > 0n ? 'up' : g.committed < 0n ? 'down' : 'flat'
  const elapsed = nowS - g.windowStart
  const progress = elapsed <= 0n ? 0 : elapsed >= LTV_GLIDE_PERIOD_S ? 1 : Number(elapsed) / Number(LTV_GLIDE_PERIOD_S)
  const pct = (v: bigint) => (cap === 0n ? 0 : Number((v * 1_000_000n) / cap) / 10_000)
  return {
    now,
    end,
    windowStart: g.windowStart,
    windowEnd,
    direction,
    progress,
    windowOpen: nowS < windowEnd,
    pctOfCapNow: pct(now),
    pctOfCapEnd: pct(end),
  }
}

/** The one sentence about LTV change, built from the constants above. */
export function glideRuleSentence(): string {
  const pp = Number((MAX_LTV_MOVE_PER_PERIOD * 100n) / WAD)
  const days = Number(LTV_GLIDE_PERIOD_S / 86_400n)
  return `The max LTV moves at most ${pp} percentage points per ${days}-day window, in either direction, and can never exceed the listing cap.`
}

// ---------------------------------------------------------------------------
// What drives the target — Collateral.targetMaxLTV (Collateral.sol:521-541)
// and LtvDisco.queryAverageLTV (LtvDisco.sol:1701-1723).
// ---------------------------------------------------------------------------

export type TargetSource = 'onboarding' | 'no-disco' | 'disco' | 'disco-below-floor'

export function targetSource(i: {
  nowS: bigint
  onboardingWindowEnd: bigint
  discoOracle: string
  discoAverage: bigint
}): TargetSource {
  if (i.nowS < i.onboardingWindowEnd) return 'onboarding'
  if (/^0x0{40}$/i.test(i.discoOracle)) return 'no-disco'
  return i.discoAverage === 0n ? 'disco-below-floor' : 'disco'
}

export const TARGET_SOURCE_LABEL: Record<TargetSource, string> = {
  onboarding: 'Onboarding window: listing LTV',
  'no-disco': 'No Disco wired: listing LTV',
  disco: 'Disco MBRN per vault token',
  'disco-below-floor': 'Disco below its MBRN floor: listing LTV',
}

/** Effective Disco floor: the per-asset floor may only raise the code floor. */
export function discoFloor(assetFloor: bigint): bigint {
  return assetFloor < MIN_DISCO_LTV_SUPPLY ? MIN_DISCO_LTV_SUPPLY : assetFloor
}

// ---------------------------------------------------------------------------
// Bad-debt waterfall — Cdp._absorbBadDebt (Cdp.sol:3037-3150)
// ---------------------------------------------------------------------------

export type Unit = 'CDT' | 'MBRN'
export type Scope = 'asset' | 'global'

export type WaterfallRow = {
  step: number
  key: string
  label: string
  amount: bigint
  unit: Unit
  scope: Scope
  /** How the size is derived, e.g. "pending × 40.00%". */
  basis: string
  /** Step 8 is a debt the others failed to cover, not a buffer. */
  kind: 'buffer' | 'hole'
  source: 'revenueDistributor' | 'ltvDisco' | 'transmuter'
}

export type WaterfallInput = {
  reserve: bigint
  pendingRevenue: bigint
  split: { disco: bigint; junior: bigint; senior: bigint }
  discoMbrn: bigint
  juniorStaked: bigint
  seniorStaked: bigint
  outstandingHole: bigint
}

export const fmtRatio = (r: bigint) => `${(Number((r * 10_000n) / WAD) / 100).toFixed(2)}%`

/**
 * Rows in cascade order. Revenue stops are sized exactly as the absorber sizes
 * them (Cdp.sol:3071-3075): pending × ratio / 1e18 against one frozen snapshot.
 */
export function waterfallRows(i: WaterfallInput): WaterfallRow[] {
  const stop = (r: bigint) => (i.pendingRevenue * r) / WAD
  const basis = (r: bigint) => `pending × ${fmtRatio(r)}`
  return [
    { step: 1, key: 'reserve', label: 'Reserve', amount: i.reserve, unit: 'CDT', scope: 'global', basis: 'reserveAccumulation', kind: 'buffer', source: 'revenueDistributor' },
    { step: 2, key: 'disco-rev', label: 'Disco revenue stop', amount: stop(i.split.disco), unit: 'CDT', scope: 'asset', basis: basis(i.split.disco), kind: 'buffer', source: 'revenueDistributor' },
    { step: 3, key: 'disco-mbrn', label: 'Disco MBRN auction', amount: i.discoMbrn, unit: 'MBRN', scope: 'asset', basis: 'assetTotalMbrn; reserves min(residual, this) CDT', kind: 'buffer', source: 'ltvDisco' },
    { step: 4, key: 'junior-rev', label: 'Junior revenue stop', amount: stop(i.split.junior), unit: 'CDT', scope: 'asset', basis: basis(i.split.junior), kind: 'buffer', source: 'revenueDistributor' },
    { step: 5, key: 'junior-cap', label: 'Junior capital', amount: i.juniorStaked, unit: 'CDT', scope: 'asset', basis: 'junior total_staked', kind: 'buffer', source: 'transmuter' },
    { step: 6, key: 'senior-rev', label: 'Senior revenue stop', amount: stop(i.split.senior), unit: 'CDT', scope: 'asset', basis: basis(i.split.senior), kind: 'buffer', source: 'revenueDistributor' },
    { step: 7, key: 'senior-cap', label: 'Senior capital', amount: i.seniorStaked, unit: 'CDT', scope: 'asset', basis: 'senior total_staked', kind: 'buffer', source: 'transmuter' },
    { step: 8, key: 'hole', label: 'Senior haircut, open hole', amount: i.outstandingHole, unit: 'CDT', scope: 'global', basis: 'totalOutstandingHole', kind: 'hole', source: 'transmuter' },
  ]
}

// ---------------------------------------------------------------------------
// History — LtvGlideUpdated (Collateral.sol:248)
// ---------------------------------------------------------------------------

export type GlideLog = {
  blockNumber: bigint
  logIndex: number
  txHash: string
  applied: bigint
  committed: bigint
  windowStart: bigint
}

export type HistoryRow = GlideLog & { blockTime: bigint | null; windowEnd: bigint; landsAt: bigint; direction: Direction }

export function historyRows(logs: GlideLog[], blockTimes: Map<bigint, bigint>): HistoryRow[] {
  return [...logs]
    .sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1))
    .map((l) => ({
      ...l,
      blockTime: blockTimes.get(l.blockNumber) ?? null,
      windowEnd: l.windowStart + LTV_GLIDE_PERIOD_S,
      landsAt: l.applied + l.committed,
      direction: l.committed > 0n ? 'up' : l.committed < 0n ? 'down' : 'flat',
    }))
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** WAD fraction → "82.50%". */
export function fmtWadPct(v: bigint, dp = 2): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const scaled = Number((a * 10n ** BigInt(dp + 2)) / WAD) / 10 ** dp
  return `${neg ? '-' : ''}${scaled.toFixed(dp)}%`
}

/** Signed WAD offset → "+2.50 pp" / "-5.00 pp" / "0.00 pp". */
export function fmtPp(v: bigint): string {
  const s = fmtWadPct(v).replace('%', ' pp')
  return v > 0n ? `+${s}` : s
}

/** 18-dp token amount → "1,234.56". Zero prints as "0". */
export function fmtToken(v: bigint, dp = 2): string {
  if (v === 0n) return '0'
  const whole = v / WAD
  const frac = ((v % WAD) * 10n ** BigInt(dp)) / WAD
  const w = whole.toLocaleString('en-US')
  return dp === 0 ? w : `${w}.${frac.toString().padStart(dp, '0')}`
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export function fmtTime(s: bigint | null): string {
  if (s == null) return '—'
  return new Date(Number(s) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}
