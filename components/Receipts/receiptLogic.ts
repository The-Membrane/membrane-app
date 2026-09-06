// Pure logic for CALLED-IT RECEIPTS — a signed, wallet-bound probability call on
// a venue outcome, scored by our recorder against what actually happened.
//
// JSX-free and dependency-free ON PURPOSE (repo convention: radarLogic /
// radarShareCardModel / alarmRules): the SAME functions run in three places and
// must agree byte-for-byte —
//   • the browser (components/Receipts/Receipts.tsx) builds the statement the
//     wallet signs,
//   • the API (pages/api/receipts.ts) REBUILDS the statement server-side from
//     the posted numeric fields and verifies the EIP-191 signature against it
//     (never trusts a client-supplied statement string — the wrap.ts /
//     session.ts precedent),
//   • the vitest suite (tests/unit/receipts.test.ts) exercises this module
//     directly.
//
// BADASS_RULESET §7 / §9.3: confidence claims may come ONLY from realized
// outcomes. Nothing here grades calibration with words, ranks by wins, or scores
// returns — it produces the canonical sentence, the band-containment verdict,
// and the numbers-only calibration readout, and nothing else.

export const RECEIPT_METRICS = ['instant_usd', 'total_assets'] as const
export type ReceiptMetric = (typeof RECEIPT_METRICS)[number]

export function isReceiptMetric(m: unknown): m is ReceiptMetric {
  return typeof m === 'string' && (RECEIPT_METRICS as readonly string[]).includes(m)
}

// The venue kinds (tools/venue-recorder.config.json) expose exactly one honest
// metric each: atoken venues expose instant exit liquidity in USD; the 4626
// cooldown vaults expose only aggregate totalAssets (their instant/cooling/
// stranded split is not derivable — see scripts/lib/venue-reads.mjs). A call may
// only be made on the metric its venue actually surfaces.
export function metricForKind(kind: string): ReceiptMetric | null {
  if (kind === 'atoken-liquidity') return 'instant_usd'
  if (kind === 'erc4626-cooldown') return 'total_assets'
  return null
}

// Compact USD formatter for the canonical statement. Deterministic: the same
// numeric input always yields the same string on client and server (identical
// V8 double math + toFixed), which is what keeps the signed message byte-exact.
// Up to two decimals, trailing zeros stripped: 1.2e9 -> "$1.2B", 40000 -> "$40k".
export function fmtStatementUsd(n: number): string {
  if (!Number.isFinite(n)) return '$?'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const fmt = (val: number, suffix: string) => {
    const s = val.toFixed(2).replace(/\.?0+$/, '')
    return `${sign}$${s}${suffix}`
  }
  if (abs >= 1e9) return fmt(abs / 1e9, 'B')
  if (abs >= 1e6) return fmt(abs / 1e6, 'M')
  if (abs >= 1e3) return fmt(abs / 1e3, 'k')
  return fmt(abs, '')
}

// Normalize made_at to minute precision + 'Z' so the statement is stable
// regardless of the input's sub-minute precision. Client and server both run
// this on the SAME made_at value, so the rebuilt message matches the signed one.
export function formatMadeAt(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16) + 'Z'
}

export interface ReceiptClaim {
  venue: string
  metric: ReceiptMetric
  bandLow: number
  bandHigh: number
  probabilityPct: number // 1-99, the user's stated confidence
  horizonHours: number
  madeAt: string // ISO
}

// THE canonical human sentence — the exact bytes the wallet signs and the server
// verifies. Do not reorder or reword without changing both call sites together;
// a byte drift silently invalidates every in-flight signature.
export function buildReceiptStatement(c: ReceiptClaim): string {
  const when = formatMadeAt(c.madeAt)
  return (
    `I call: ${c.venue} ${c.metric} between ${fmtStatementUsd(c.bandLow)} and ${fmtStatementUsd(c.bandHigh)}` +
    ` in ${c.horizonHours}h of ${when}. Confidence ${c.probabilityPct}%. — Membrane Called-It`
  )
}

// Band containment — the ONLY scoring rule. Inclusive on both ends. A call is a
// HIT iff the realized value lands within [low, high]; there is no partial credit
// and no notion of "how close" (§7: outcomes, not narratives).
export function scoreHit(realized: number, bandLow: number, bandHigh: number): boolean {
  return realized >= bandLow && realized <= bandHigh
}

export interface ScoredCall {
  probabilityPct: number
  hit: boolean
}

export interface Calibration {
  nScored: number
  nInBand: number
  expectedInBand: number // Σ p_i — the count you'd expect in-band at your stated confidences
  hitRate: number | null
  brier: number | null // mean (p - outcome)^2 over scored calls; lower = better calibrated
}

// Per-address calibration aggregate, computed AT READ TIME (never stored as a
// badge). Numbers only. expectedInBand is the sum of stated probabilities —
// compare it to nInBand to see whether the caller's confidence was earned.
export function computeCalibration(scored: ScoredCall[]): Calibration {
  const rows = (scored ?? []).filter(
    (r) => typeof r.hit === 'boolean' && Number.isFinite(Number(r.probabilityPct)),
  )
  const nScored = rows.length
  const nInBand = rows.filter((r) => r.hit).length
  const expectedInBand = rows.reduce((s, r) => s + Number(r.probabilityPct) / 100, 0)
  const hitRate = nScored > 0 ? nInBand / nScored : null
  const brier =
    nScored > 0
      ? rows.reduce((s, r) => {
          const p = Number(r.probabilityPct) / 100
          const o = r.hit ? 1 : 0
          return s + (p - o) * (p - o)
        }, 0) / nScored
      : null
  return { nScored, nInBand, expectedInBand, hitRate, brier }
}

// The one-line calibration readout. No grade words — just the tally and the
// expectation. Empty state is exactly "0 of 0 scored" (a caller with no scored
// calls has no track record to claim, per §9.3).
export function calibrationReadout(cal: Calibration | null | undefined): string {
  if (!cal || cal.nScored === 0) return '0 of 0 scored'
  return (
    `your calls: ${cal.nScored} scored, ${cal.nInBand} in-band; ` +
    `at your stated confidences the expected in-band was ${cal.expectedInBand.toFixed(1)}`
  )
}
