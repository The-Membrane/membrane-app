// turnoverStats.mjs — PURE derivation of a venue's gross-vs-net turnover story.
//
// The argument this module exists to compute: a savings vault's TVL line is
// nearly flat, so it reads as "sticky". But TVL is a NET number — it is gross
// inflow minus gross outflow, and netting hides both. Over a window, gross
// outflow can be many multiples of the balance and the balance never moves.
//
// Dependency-free on purpose (same discipline as scripts/lib/alarmRules.mjs and
// scripts/lib/newsParse.mjs): every DB read stays in the calling script, so the
// code under unit test IS the code that renders the card.
// Tested by tests/unit/turnover.test.ts.

// Round to two significant figures — BRAND_CHARTS §4.5, headline numbers.
// toPrecision (not the log10/round trick make-share-card's weather template
// uses) because that one returns 33999999999.999996 for 33.5e9 — a float
// artifact that surfaces the moment sig2 is handed a raw, undivided total.
export function sig2(n) {
  if (!Number.isFinite(n) || n === 0) return 0
  return Number(n.toPrecision(2))
}

/** USD at two significant figures with a magnitude suffix. */
export function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (a >= 1e9) return `${sign}$${sig2(a / 1e9)}B`
  if (a >= 1e6) return `${sign}$${sig2(a / 1e6)}M`
  if (a >= 1e3) return `${sign}$${sig2(a / 1e3)}k`
  return `${sign}$${sig2(a)}`
}

const sum = (rows) => rows.reduce((t, r) => t + (Number(r.usd) || 0), 0)

/**
 * @param {{d: string, usd: number}[]} dailyOut  daily gross outflow, USD
 * @param {{d: string, usd: number}[]} dailyIn   daily gross inflow, USD
 * @param {number|null} tvl                      vault balance now, USD
 * @param {number} windowDays                    span the daily rows cover
 * @returns derived turnover facts; null (never NaN/Infinity) where undefined
 */
export function computeTurnover({ dailyOut = [], dailyIn = [], tvl = null, windowDays = 0 }) {
  const grossOut = sum(dailyOut)
  const grossIn = sum(dailyIn)
  const net = grossIn - grossOut
  const gross = grossIn + grossOut

  const worstOutDay = dailyOut.reduce(
    (best, r) => (best === null || Number(r.usd) > Number(best.usd) ? r : best),
    null,
  )

  const usableTvl = Number.isFinite(tvl) && tvl > 0 ? tvl : null
  const turnoverMultiple = usableTvl ? grossOut / usableTvl : null
  const daysPerVaultTurn =
    turnoverMultiple && turnoverMultiple > 0 && windowDays > 0 ? windowDays / turnoverMultiple : null

  return {
    grossOut,
    grossIn,
    net,
    gross,
    // The sliver TVL actually shows you, as a share of all the capital that moved.
    netShareOfGross: gross > 0 ? Math.abs(net) / gross : null,
    tvl: usableTvl,
    turnoverMultiple,
    daysPerVaultTurn,
    worstOutDay: worstOutDay ? { d: worstOutDay.d, usd: Number(worstOutDay.usd) } : null,
    windowDays,
    activeDays: new Set([...dailyOut, ...dailyIn].map((r) => r.d)).size,
  }
}

/**
 * Bar pixel widths at TRUE relative scale — the size contrast IS the argument,
 * so the net sliver is never floored to a "visible" minimum.
 *
 * The peak spans EVERY bar the card draws, TVL included. On an out-dominant
 * venue (sUSDS) gross outflow is the longest; on a quiet one (sUSDe over 90d)
 * the vault itself is, and scaling to gross alone ran the vault bar off the
 * right edge of the card.
 */
export function barWidths({ grossIn, grossOut, net, tvl }, maxPx) {
  const abs = (v) => (Number.isFinite(v) ? Math.abs(v) : 0)
  const peak = Math.max(abs(grossIn), abs(grossOut), abs(tvl))
  if (!(peak > 0) || !(maxPx > 0)) return { inPx: 0, outPx: 0, netPx: 0, tvlPx: 0, scale: 0 }
  const scale = maxPx / peak
  return {
    scale,
    inPx: abs(grossIn) * scale,
    outPx: abs(grossOut) * scale,
    netPx: abs(net) * scale,
    tvlPx: abs(tvl) * scale,
  }
}

/**
 * Fractional positions (0..1) along the gross-outflow bar where one whole
 * vault-worth of capital has walked out. Makes "the vault empties every N days"
 * literal: count the notches.
 */
export function vaultTicks(grossOut, tvl, cap = 40) {
  if (!(grossOut > 0) || !(tvl > 0)) return []
  const ticks = []
  for (let k = 1; k * tvl < grossOut && ticks.length < cap; k++) ticks.push((k * tvl) / grossOut)
  return ticks
}

/**
 * Honesty gate. sUSDS has no cooldown: a Withdraw event IS a served exit. On a
 * cooldown venue (Ethena sUSDe) the same ERC4626 Withdraw fires when the user
 * STARTS the cooldown and the assets move to the silo — settlement happens
 * later, unlogged by this event. The card must not say "served" there.
 */
export function exitSemantics(cooldownSeconds) {
  const gated = Number.isFinite(cooldownSeconds) && cooldownSeconds > 0
  return {
    gated,
    verb: gated ? 'queued' : 'served',
    // Rendered verbatim on the card — the claim and its limit travel together.
    note: gated
      ? 'Gross ERC4626 Withdraw events over the window — not netted positions. This vault gates exits behind a cooldown, so an "out" is a redemption INITIATION, not a settled exit.'
      : 'Gross ERC4626 Deposit/Withdraw events over the window — not netted positions. This vault has no cooldown, so every outflow above was an exit it served on demand.',
  }
}
