// Pure outcome logic for fixed-size crvUSD -> USDT/USDC secondary exits.
// Research design written before historical split quotes were fetched
// (2026-09-25), then recovery-gap and control rules were tightened during
// validation. Treat this study as exploratory, not fully preregistered.
// - Fixed inputs: 100,000 and 1,000,000 crvUSD, optimized on the 0/25/50/75/100%
//   two-pool grid; USDT/USDC count at $1. No redemption, gas, MEV or depeg claim.
// - Stress onset: first sampled fall >=0.25 percentage points from the highest
//   quote in the prior 24h, provided that prior quote >=0.995. While stressed,
//   do not count another onset until observed quotes have recovered to within
//   0.10pp of that peak over 24h, with no observation gap >4h. Sensitivity:
//   12h and 48h recovery.
// - Actionable opportunity: at least one prior sample 6-24h before onset had
//   quote >=0.995 and >=0.25pp above the onset quote. The user could have sold
//   at that sampled quote; this is a historical quote, not a fill guarantee.
// - Promotion remains gated on >=20 ACTIONABLE independent onsets and >=20 controls,
//   then holdout precision >=10pp over best simple baseline with lower CI >0.

export const HOUR = 3600
export const DAY = 24 * HOUR

export function stressEpisodes(rows, field, recoveryHours = 24) {
  if (!Number.isFinite(recoveryHours) || recoveryHours <= 0)
    throw new Error('recoveryHours must be positive')
  const episodes = []
  let active = null
  let recoveryStart = null
  let previousRecoverySampleAt = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const quote = row[field]
    if (!Number.isFinite(quote) || !Number.isSafeInteger(row.at))
      throw new Error(`Invalid quote row ${i}`)
    const past = rows.slice(0, i).filter((r) => row.at - r.at <= DAY)
    if (!active) {
      if (!past.length) continue
      const peak = past.reduce((winner, r) => (r[field] > winner[field] ? r : winner))
      if (peak[field] >= 0.995 && peak[field] - quote >= 0.0025) {
        const opportunities = past.filter(
          (r) =>
            row.at - r.at >= 6 * HOUR &&
            row.at - r.at <= DAY &&
            r[field] >= 0.995 &&
            r[field] - quote >= 0.0025,
        )
        active = {
          onsetAt: row.at,
          onsetBlock: row.block,
          onsetQuote: quote,
          peakQuote: peak[field],
          peakAt: peak.at,
          minQuote: quote,
          minAt: row.at,
          opportunityCount: opportunities.length,
          earliestOpportunityAt: opportunities[0]?.at ?? null,
          latestOpportunityAt: opportunities.at(-1)?.at ?? null,
          latestOpportunityQuote: opportunities.at(-1)?.[field] ?? null,
          recoveredAt: null,
        }
        episodes.push(active)
      }
      continue
    }
    if (quote < active.minQuote) {
      active.minQuote = quote
      active.minAt = row.at
    }
    if (quote >= active.peakQuote - 0.001) {
      if (previousRecoverySampleAt !== null && row.at - previousRecoverySampleAt > 4 * HOUR)
        recoveryStart = null
      recoveryStart ??= row.at
      previousRecoverySampleAt = row.at
      if (row.at - recoveryStart >= recoveryHours * HOUR) {
        active.recoveredAt = row.at
        active = null
        recoveryStart = null
        previousRecoverySampleAt = null
      }
    } else {
      recoveryStart = null
      previousRecoverySampleAt = null
    }
  }
  return episodes
}

export function episodeSummary(rows, field) {
  const episodes = stressEpisodes(rows, field)
  const splitAt = rows[0].at + 0.7 * (rows.at(-1).at - rows[0].at)
  const controls = rows.filter(
    (r) =>
      r[field] >= 0.995 &&
      episodes.every(
        (e) => r.at < e.onsetAt - DAY || (e.recoveredAt !== null && r.at > e.recoveredAt + DAY),
      ) &&
      r.at <= rows.at(-1).at - DAY,
  )
  // At most one control per non-overlapping 24h bucket.
  const controlBuckets = new Set(controls.map((r) => Math.floor((r.at - rows[0].at) / DAY)))
  return {
    episodes: episodes.length,
    actionable: episodes.filter((e) => e.opportunityCount > 0).length,
    promotionEventCount: episodes.filter((e) => e.opportunityCount > 0).length,
    train: episodes.filter((e) => e.onsetAt < splitAt - DAY).length,
    holdout: episodes.filter((e) => e.onsetAt >= splitAt + DAY).length,
    independentControls: controlBuckets.size,
    recoverySensitivity: Object.fromEntries(
      [12, 24, 48].map((hours) => [hours, stressEpisodes(rows, field, hours).length]),
    ),
    episodesDetail: episodes.map((e) => ({
      ...e,
      onsetIso: new Date(e.onsetAt * 1000).toISOString(),
      durationHours: e.recoveredAt ? (e.recoveredAt - e.onsetAt) / HOUR : null,
    })),
  }
}
