// Carry Radar — pure stress/verdict logic. JSX-free so the unit suite
// (tests/unit, node environment) exercises it directly, mirroring the split
// used by components/Carry/venueLogLogic.ts.
//
// HONESTY RULES (owner, docs/BRAND_CHARTS.md §4):
//  - Never invent a number. Every figure here is derived from a chain read or a
//    recorded DB row passed in by the caller; nothing is modelled.
//  - Never blend confidences. A venue's composite verdict is the WEAKEST of its
//    applicable exit-capacity/gate prongs, never an average.
//  - A prong that has no data is OMITTED, not defaulted to "clear". In
//    particular a cooldown vault has instantUsd === null and MUST NOT be given a
//    fabricated instant-capacity claim.

export type VenueKind = 'erc4626-cooldown' | 'erc4626-vault-cash' | 'atoken-liquidity'
export type Verdict = 'clear' | 'caution' | 'exposed'

// Recorded inventory/size coverage is only a proxy, not a same-holder exit
// quote. Even 10x inventory cannot establish that this wallet can withdraw.
//  >=  1x → inventory is at least your size → caution (execution unverified)
//  <   1x → your size exceeds inventory     → exposed
// Keep the 10x reference for existing consumers of the descriptive threshold;
// it must not upgrade an inventory-only result to "clear".
export const COVERAGE_CLEAR = 10
export const COVERAGE_CAUTION = 1

// A cooldown gate delays 100% of an exit regardless of size. <= 1 day is a
// caution; anything longer is an exposure.
export const COOLDOWN_EXPOSED_SECONDS = 86_400

export type FlowStats = {
  /** Historical aggregate outflow only; not same-holder exit capacity. */
  worst1dUsd: number
  /** Worst rolling 7-day realized outflow over the window, in USD. */
  worst7dUsd: number
  /** Number of days in the window that had any outflow (corpus density). */
  dayCount: number
}

export type VenueInputs = {
  venue: string
  /** Reader-facing label, e.g. 'Aave', 'sUSDe'. */
  label: string
  kind: VenueKind
  /** The user's position value in USD (chain read; $1/underlying assumption). */
  usd: number
  /** Vault TVL in USD (ERC4626 totalAssets); null when not read (aToken). */
  tvlUsd: number | null
  /** Recorded instant venue inventory in USD; not holder-specific maxWithdraw. */
  instantUsd: number | null
  /** Cooldown gate in seconds (ERC4626 cooldown vaults); null = none recorded. */
  cooldownSeconds: number | null
  /** Legacy historical aggregate outflow input; excluded from the exit verdict. */
  flow: FlowStats | null
}

export type ProngResult = {
  level: Verdict
  /** Inventory ÷ size, an x-multiple. null when the prong is not size-relative. */
  coverage: number | null
}

export type VenueVerdict = {
  venue: string
  label: string
  kind: VenueKind
  usd: number
  tvlUsd: number | null
  shareOfTvl: number | null
  prongs: {
    instant: (ProngResult & { instantUsd: number }) | null
    cooldown: (ProngResult & { seconds: number }) | null
    /** Historical outflow cannot certify this holder's exit; retained for API shape. */
    flow: null
  }
  verdict: Verdict
  reason: string
}

export type RadarResult = {
  totalUsd: number
  heldCount: number
  /** Held venues (usd > 0), each stressed at its own size. */
  positions: VenueVerdict[]
  /** All venues, each stressed at the user's TOTAL size ("if this whole stack sat here"). */
  comparator: VenueVerdict[]
}

// ---------------------------------------------------------------------------
// Formatters — two significant figures, reader units, mono-safe strings.
// ---------------------------------------------------------------------------

/** Round to two significant figures. */
export const sig2 = (n: number): number => {
  if (!isFinite(n) || n === 0) return n === 0 ? 0 : n
  const digits = Math.ceil(Math.log10(Math.abs(n)))
  const power = 2 - digits
  const mag = Math.pow(10, power)
  return Math.round(n * mag) / mag
}

/** USD with a B/M/k suffix at two significant figures, e.g. 331961674 → "$330M". */
export const fmtUsd = (n: number): string => {
  const a = Math.abs(n)
  if (a >= 1e9) return `$${sig2(n / 1e9)}B`
  if (a >= 1e6) return `$${sig2(n / 1e6)}M`
  if (a >= 1e3) return `$${sig2(n / 1e3)}k`
  return `$${sig2(n)}`
}

/** An x-multiple, e.g. 25.3 → "25x", 3.4 → "3.4x", Infinity → "∞". */
export const fmtMultiple = (x: number): string => {
  if (!isFinite(x)) return '∞'
  if (x >= 100) return `${Math.round(x / 10) * 10}x`
  return `${sig2(x)}x`
}

/** A percentage at two significant figures, clamped small values, e.g. 0.034 → "3.4%". */
export const fmtPct = (frac: number): string => {
  const p = frac * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  if (p >= 10) return `${Math.round(p)}%`
  return `${sig2(p)}%`
}

/** Seconds in the largest clean unit, e.g. 86400 → "1d" (matches venueLogLogic). */
export const fmtDuration = (secs: number): string => {
  if (secs % 86400 === 0) return `${secs / 86400}d`
  if (secs % 3600 === 0) return `${secs / 3600}h`
  return `${secs}s`
}

// ---------------------------------------------------------------------------
// Core stress logic.
// ---------------------------------------------------------------------------

const coverageLevel = (x: number): Verdict => (x >= COVERAGE_CAUTION ? 'caution' : 'exposed')

const severity: Record<Verdict, number> = { clear: 0, caution: 1, exposed: 2 }

/** Compute one venue's stress prongs + weakest-prong verdict for a given size. */
export function computeVenueVerdict(input: VenueInputs): VenueVerdict {
  const { venue, label, kind, usd, tvlUsd, instantUsd, cooldownSeconds } = input

  const shareOfTvl = tvlUsd != null && tvlUsd > 0 ? usd / tvlUsd : null

  const base = { venue, label, kind, usd, tvlUsd, shareOfTvl }

  // Zero (or negative) position: nothing to stress. No fabricated prongs.
  if (usd <= 0) {
    return {
      ...base,
      prongs: { instant: null, cooldown: null, flow: null },
      verdict: 'clear',
      reason: 'no position in this venue',
    }
  }

  // Instant-inventory proxy. ONLY where instantUsd is a recorded read — cooldown
  // vaults pass null and get NO instant prong. Inventory alone never clears a
  // holder because wallet health, permissions, route and execution can differ.
  let instant: (ProngResult & { instantUsd: number }) | null = null
  if (instantUsd != null) {
    const coverage = instantUsd / usd
    instant = { level: coverageLevel(coverage), coverage, instantUsd }
  }

  // Cooldown prong. Only for cooldown-kind vaults that actually have a recorded
  // gate; a null gate is OMITTED rather than asserted as "no cooldown".
  let cooldown: (ProngResult & { seconds: number }) | null = null
  if (kind === 'erc4626-cooldown' && cooldownSeconds != null && cooldownSeconds > 0) {
    const level: Verdict = cooldownSeconds > COOLDOWN_EXPOSED_SECONDS ? 'exposed' : 'caution'
    cooldown = { level, coverage: null, seconds: cooldownSeconds }
  }

  // Aggregate past outflow does not establish whether this holder, at this
  // size, through this route, can exit now. Keep the response field for API
  // compatibility, but never turn the flow input into a verdict prong.
  const prongs = { instant, cooldown, flow: null }
  const applicable = [instant, cooldown].filter(Boolean) as ProngResult[]

  // No data at all: we cannot assess a venue we have nothing to stress against.
  if (applicable.length === 0) {
    return {
      ...base,
      prongs,
      verdict: 'caution',
      reason: `no instant capacity or cooldown gate recorded to assess your ${fmtUsd(usd)} exit`,
    }
  }

  // Composite = weakest (most severe) prong. Never averaged.
  const verdict = applicable.reduce<Verdict>(
    (worst, p) => (severity[p.level] > severity[worst] ? p.level : worst),
    'clear',
  )

  return { ...base, prongs, verdict, reason: reasonFor(verdict, prongs, usd, label) }
}

/** Build the one-line reason from the governing (verdict-setting) prong's numbers. */
function reasonFor(
  verdict: Verdict,
  prongs: VenueVerdict['prongs'],
  usd: number,
  label: string,
): string {
  const you = fmtUsd(usd)

  // The governing prong is the applicable prong whose level equals the verdict,
  // preferring the most decision-relevant (cooldown → instant).
  const { instant, cooldown } = prongs

  if (cooldown && cooldown.level === verdict) {
    return `your ${you} is subject to a ${fmtDuration(cooldown.seconds)} cooldown before withdrawal eligibility; completion after the gate is unverified`
  }

  if (instant && instant.level === verdict && instant.coverage != null) {
    if (verdict === 'exposed') {
      return `your ${you} exceeds recorded instant inventory (${fmtMultiple(instant.coverage)} of your size); holder path and health remain unverified`
    }
    return `recorded instant inventory is ${fmtMultiple(instant.coverage)} your ${you} position; holder path and health remain unverified`
  }

  // Fallback (should be unreachable when applicable prongs exist).
  return `${label}: ${verdict} at your ${you}`
}

/** Full radar: held positions (each at own size) + comparator (each at total size). */
export function computeRadar(inputs: VenueInputs[]): RadarResult {
  const totalUsd = inputs.reduce((s, i) => s + Math.max(0, i.usd), 0)
  const positions = inputs
    .filter((i) => i.usd > 0)
    .map(computeVenueVerdict)
    .sort((a, b) => b.usd - a.usd)
  const comparator = inputs.map((i) => computeVenueVerdict({ ...i, usd: totalUsd }))
  return { totalUsd, heldCount: positions.length, positions, comparator }
}

// ---------------------------------------------------------------------------
// Shareable summary — the user's own result as copyable text. Never a plug.
// ---------------------------------------------------------------------------

/** One condensed clause per held venue, keyed to its governing prong. */
export function venueClause(v: VenueVerdict): string {
  const { prongs, verdict, label } = v
  if (prongs.cooldown && prongs.cooldown.level === verdict) {
    return `${label} requires a ${fmtDuration(prongs.cooldown.seconds)} cooldown before withdrawal eligibility`
  }
  if (prongs.instant && prongs.instant.level === verdict && prongs.instant.coverage != null) {
    return verdict === 'exposed'
      ? `${label} recorded instant inventory is ${fmtMultiple(prongs.instant.coverage)} my size`
      : `${label} recorded instant inventory is ${fmtMultiple(prongs.instant.coverage)} my size; withdrawal unverified`
  }
  return `${label} is ${verdict} at my size`
}

/** The copyable share line built from THE USER'S result. */
export function shareLine(result: RadarResult): string {
  const { totalUsd, positions } = result
  if (positions.length === 0) {
    return `No position in any instrumented Membrane venue — Membrane Carry Radar`
  }
  const clauses = positions.map(venueClause).join('; ')
  return `My ${fmtUsd(totalUsd)} across ${positions.length} venue${positions.length === 1 ? '' : 's'}: ${clauses} — Membrane Carry Radar`
}
