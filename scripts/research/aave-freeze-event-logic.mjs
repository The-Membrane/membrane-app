// Locked before the event-log scan. A cross-reserve configuration event is an
// exposure, not a withdrawal lock: frozen reserves may still be withdrawn.
export const PREREG = Object.freeze({
  version: 1,
  window: '2025-08-27 through 2026-09-25, bounded by cached Aave USDe samples',
  exposure:
    'ReserveFrozen(asset,true) or ReservePaused(asset,true) on Aave V3 Ethereum PoolConfigurator; primary excludes USDe itself',
  eventTime:
    'the configuration event block timestamp, never proposal publication or later cash movement',
  independentIncident:
    'merge all positive configuration events within 24h; first event is incident time',
  cash: 'USDe.balanceOf(aUSDe) at pinned blocks; upper bound on instant USDe supplier exits',
  thresholdsUsd: [10_000_000, 50_000_000, 100_000_000],
  response:
    'cash >= q immediately before event, cash < q at any 3h grid point from 6h through 24h after; count threshold crossing at most once per incident',
  controls:
    'same UTC hour/weekday at ±7 and ±14 days where no positive configuration incident occurs within ±24h; pick closest pre-event USDe cash, report mismatch; no replacement if unavailable',
  alertAccounting:
    'one alert per independent event incident; false positive if no q crossing; report event/control risk difference and do not promote below 20 independent event incidents with eligible controls and outcomes',
})

export const DAY = 86400
export const HOUR = 3600
export const GRID_HOURS = [6, 9, 12, 15, 18, 21, 24]
export const THRESHOLDS = PREREG.thresholdsUsd

export function independentIncidents(events) {
  const positive = events
    .filter(
      (event) => event.enabled && event.asset.toLowerCase() !== event.targetAsset.toLowerCase(),
    )
    .sort((a, b) => a.at - b.at || a.block - b.block || a.logIndex - b.logIndex)
  const incidents = []
  for (const event of positive) {
    const last = incidents.at(-1)
    if (last && event.at - last.at < DAY) last.events.push(event)
    else incidents.push({ at: event.at, block: event.block, events: [event] })
  }
  return incidents
}

export function response(preCash, gridCash, q) {
  if (!Number.isFinite(preCash) || preCash < q) return { eligible: false, crossed: false }
  if (gridCash.length !== GRID_HOURS.length || gridCash.some((x) => !Number.isFinite(x)))
    return { eligible: false, crossed: false }
  const first = gridCash.findIndex((cash) => cash < q)
  return {
    eligible: true,
    crossed: first >= 0,
    firstHour: first >= 0 ? GRID_HOURS[first] : null,
  }
}

export function summarize(incidents) {
  return Object.fromEntries(
    THRESHOLDS.map((q) => {
      const eligible = incidents.filter((r) => r.response?.[q]?.eligible)
      const crossing = eligible.filter((r) => r.response[q].crossed)
      const controls = eligible.filter((r) => r.control?.response?.[q]?.eligible)
      const controlCrossing = controls.filter((r) => r.control.response[q].crossed)
      return [
        q,
        {
          eligibleEvents: eligible.length,
          eventCrossings: crossing.length,
          falsePositiveEvents: eligible.length - crossing.length,
          eligibleMatchedControls: controls.length,
          controlCrossings: controlCrossing.length,
          eventRate: eligible.length ? crossing.length / eligible.length : null,
          controlRate: controls.length ? controlCrossing.length / controls.length : null,
          riskDifference:
            eligible.length && controls.length
              ? crossing.length / eligible.length - controlCrossing.length / controls.length
              : null,
          gatePassed: eligible.length >= 20 && controls.length >= 20,
        },
      ]
    }),
  )
}

// Exploratory two-stage follow-up. This is deliberately NOT part of PREREG.
// All baseline samples end before the governance event/control anchor.
export function rollingSixHourDrops(rows, anchorAt, days = 14) {
  const start = anchorAt - days * DAY
  const relevant = rows.filter((row) => row.at >= start - 7 * HOUR && row.at < anchorAt)
  const drops = []
  for (let i = 0; i < relevant.length; i++) {
    const now = relevant[i]
    if (now.at < start) continue
    let best = null
    for (let j = i - 1; j >= 0; j--) {
      const prior = relevant[j]
      const lag = now.at - prior.at
      if (lag > 7 * HOUR) break
      if (Math.abs(lag - 6 * HOUR) <= HOUR && (!best || Math.abs(lag - 6 * HOUR) < best.error))
        best = { prior, error: Math.abs(lag - 6 * HOUR) }
    }
    if (!best) continue
    const between = relevant.slice(relevant.indexOf(best.prior), i + 1)
    if (between.some((row, k) => k && row.at - between[k - 1].at > 4 * HOUR)) continue
    drops.push({ at: now.at, drop: best.prior.cash - now.cash })
  }
  return drops
}

export function empiricalQuantile(values, p) {
  if (!values.length || p <= 0 || p > 1) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(p * sorted.length) - 1]
}
