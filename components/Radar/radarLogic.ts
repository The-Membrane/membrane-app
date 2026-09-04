// Carry Radar — pure stress/verdict logic. JSX-free so the unit suite
// (tests/unit, node environment) exercises it directly, mirroring the split
// used by components/Carry/venueLogLogic.ts.
//
// HONESTY RULES (owner, docs/BRAND_CHARTS.md §4):
//  - Never invent a number. Every figure here is derived from a chain read or a
//    recorded DB row passed in by the caller; nothing is modelled.
//  - Never blend confidences. A venue's composite verdict is the WEAKEST of its
//    applicable prongs, never an average.
//  - A prong that has no data is OMITTED, not defaulted to "clear". In
//    particular a cooldown vault has instantUsd === null and MUST NOT be given a
//    fabricated instant-capacity claim.

export type VenueKind = 'erc4626-cooldown' | 'atoken-liquidity'
export type Verdict = 'clear' | 'caution' | 'exposed'

// Capacity/size coverage bands. coverage = capacity ÷ your size (an x-multiple):
//  >= 10x  → the venue dwarfs you            → clear
//  >=  1x  → the venue can just cover you     → caution
//  <   1x  → you are bigger than the capacity → exposed
export const COVERAGE_CLEAR = 10
export const COVERAGE_CAUTION = 1

// A cooldown gate delays 100% of an exit regardless of size. <= 1 day is a
// caution; anything longer is an exposure.
export const COOLDOWN_EXPOSED_SECONDS = 86_400

export type FlowStats = {
  /** Worst single-day realized outflow over the window, in USD. */
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
  /** Instant withdrawable liquidity in USD; null for cooldown vaults. */
  instantUsd: number | null
  /** Cooldown gate in seconds (ERC4626 cooldown vaults); null = none recorded. */
  cooldownSeconds: number | null
  /** Recorded outflow stats; null when the corpus has no rows for this venue. */
  flow: FlowStats | null
}

export type ProngResult = {
  level: Verdict
  /** capacity ÷ size, an x-multiple. null when the prong is not size-relative. */
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
    flow: (ProngResult & { worst1dUsd: number; worst7dUsd: number; coverage7d: number | null }) | null
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

const coverageLevel = (x: number): Verdict =>
  x >= COVERAGE_CLEAR ? 'clear' : x >= COVERAGE_CAUTION ? 'caution' : 'exposed'

const severity: Record<Verdict, number> = { clear: 0, caution: 1, exposed: 2 }

/** Compute one venue's stress prongs + weakest-prong verdict for a given size. */
export function computeVenueVerdict(input: VenueInputs): VenueVerdict {
  const { venue, label, kind, usd, tvlUsd, instantUsd, cooldownSeconds, flow } = input

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

  // Instant-capacity prong. ONLY where instantUsd is a real read — cooldown
  // vaults pass null and get NO instant prong (honesty: never fabricate one).
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

  // Flow prong. A large historical outflow is GOOD for an exiter — it proves the
  // venue can push size out. coverage = worst single-day outflow ÷ your size.
  let flowProng:
    | (ProngResult & { worst1dUsd: number; worst7dUsd: number; coverage7d: number | null })
    | null = null
  if (flow && flow.worst1dUsd > 0) {
    const coverage = flow.worst1dUsd / usd
    const coverage7d = flow.worst7dUsd > 0 ? flow.worst7dUsd / usd : null
    flowProng = {
      level: coverageLevel(coverage),
      coverage,
      coverage7d,
      worst1dUsd: flow.worst1dUsd,
      worst7dUsd: flow.worst7dUsd,
    }
  }

  const prongs = { instant, cooldown, flow: flowProng }
  const applicable = [instant, cooldown, flowProng].filter(Boolean) as ProngResult[]

  // No data at all: we cannot clear a venue we have nothing to stress against.
  if (applicable.length === 0) {
    return {
      ...base,
      prongs,
      verdict: 'caution',
      reason: `no recorded capacity or flow to stress your ${fmtUsd(usd)} against`,
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
  // preferring the most decision-relevant (cooldown → instant → flow).
  const { instant, cooldown, flow } = prongs

  if (cooldown && cooldown.level === verdict) {
    return `your exit sits behind a ${fmtDuration(cooldown.seconds)} cooldown — 100% of your ${you} is gated until it clears`
  }

  if (instant && instant.level === verdict && instant.coverage != null) {
    if (verdict === 'exposed') {
      return `your ${you} exceeds instant liquidity — only ${fmtMultiple(instant.coverage)} of your size can exit right now`
    }
    return `instant liquidity covers your ${you} ${fmtMultiple(instant.coverage)} over`
  }

  if (flow && flow.level === verdict && flow.coverage != null) {
    if (verdict === 'exposed') {
      return `your ${you} is ${fmtMultiple(1 / flow.coverage)} the venue's worst observed exit day (${fmtUsd(flow.worst1dUsd)}) — no single day has moved your size`
    }
    return `your ${you} = ${fmtPct(usd / flow.worst1dUsd)} of the worst observed exit day (${fmtUsd(flow.worst1dUsd)}) — ${label} has served ${fmtMultiple(flow.coverage)} your size in a day`
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
    return `${label} cooldown gates 100% of my exit`
  }
  if (prongs.instant && prongs.instant.level === verdict && prongs.instant.coverage != null) {
    return verdict === 'exposed'
      ? `${label} can't clear my size instantly (${fmtMultiple(prongs.instant.coverage)})`
      : `${label} clears my size ${fmtMultiple(prongs.instant.coverage)} over instantly`
  }
  if (prongs.flow && prongs.flow.level === verdict && prongs.flow.coverage != null) {
    return verdict === 'exposed'
      ? `my size is ${fmtMultiple(1 / prongs.flow.coverage)} ${label}'s worst exit day`
      : `${label} clears my size ${fmtMultiple(prongs.flow.coverage)} over on its worst day`
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
