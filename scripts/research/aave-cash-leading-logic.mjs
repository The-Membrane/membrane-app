// Pre-registered before inspecting the archive series (2026-09-25).
// Sizes are sensitivity probes, NOT estimates of normal wallet positions.
// Outcome: reserve cash transitions from >= q to < q within the next 24h.
// An alert is actionable only if it predates that first crossing by 6–24h.
// Crossing episodes merge until cash has recovered >= q for 24 continuous hours
// and at least 48h have elapsed since the prior episode start. Fixed 24h
// cooldown deduplicates alerts; a 24h temporal purge separates 70/30 holdout.
// Promotion requires >=20 independent episodes and controls, +10pp holdout
// precision over the best simple baseline, bootstrap 95% CI entirely >0.

export const SIZES = [10_000_000, 50_000_000, 100_000_000]
export const HOUR = 3_600
export const DAY = 24 * HOUR
export const MAX_GAP = 4 * HOUR

export function assertSeries(rows) {
  if (!Array.isArray(rows) || rows.length < 3) throw new Error('Need at least three samples')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (
      !Number.isSafeInteger(row.block) ||
      !Number.isSafeInteger(row.at) ||
      !Number.isFinite(row.cash) ||
      !Number.isFinite(row.debt) ||
      !Number.isFinite(row.liquidityRatePct) ||
      !Number.isFinite(row.borrowRatePct) ||
      row.cash < 0 ||
      row.debt < 0 ||
      row.liquidityRatePct < 0 ||
      row.borrowRatePct < 0 ||
      typeof row.active !== 'boolean' ||
      typeof row.paused !== 'boolean' ||
      typeof row.frozen !== 'boolean' ||
      (i > 0 && (row.block <= rows[i - 1].block || row.at <= rows[i - 1].at))
    )
      throw new Error(`Invalid pinned sample at ${i}`)
  }
  return rows
}

export function atOrBefore(rows, i, seconds) {
  const target = rows[i].at - seconds
  for (let j = i - 1; j >= 0; j--) {
    if (rows[j + 1].at - rows[j].at > MAX_GAP) return null
    if (rows[j].at <= target && rows[i].at - rows[j].at <= seconds + 4 * HOUR) return rows[j]
  }
  return null
}

export function features(rows, i) {
  const current = rows[i]
  const six = atOrBefore(rows, i, 6 * HOUR)
  const prior = atOrBefore(rows, i, DAY)
  const util = current.debt / (current.cash + current.debt || 1)
  return {
    utilization: util,
    cashTo100m: current.cash / 100_000_000,
    debtRise6h: six ? (current.debt - six.debt) / (six.debt || 1) : null,
    debtRise24h: prior ? (current.debt - prior.debt) / (prior.debt || 1) : null,
    cashFall24h: prior ? (prior.cash - current.cash) / (prior.cash || 1) : null,
    utilRise24h: prior ? util - prior.debt / (prior.cash + prior.debt || 1) : null,
    borrowRateRise24h: prior ? current.borrowRatePct - prior.borrowRatePct : null,
  }
}

export function crossingEpisodes(rows, size) {
  assertSeries(rows)
  const starts = []
  let priorStart = -Infinity
  let below = rows[0].cash < size
  let recoveredSince = below ? null : rows[0].at
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].at - rows[i - 1].at > MAX_GAP) {
      // An unobserved crossing/recovery in a gap is not an episode label.
      below = rows[i].cash < size
      recoveredSince = below ? null : rows[i].at
      continue
    }
    const nowBelow = rows[i].cash < size
    if (!nowBelow) {
      if (below) recoveredSince = rows[i].at
    } else if (!below) {
      const recovered = recoveredSince !== null && rows[i].at - recoveredSince >= DAY
      if (recovered && rows[i].at - priorStart >= 2 * DAY) {
        starts.push({ index: i, at: rows[i].at, block: rows[i].block, cash: rows[i].cash })
        priorStart = rows[i].at
      }
    }
    below = nowBelow
  }
  return starts
}

export function eligible(rows, i, size) {
  const row = rows[i]
  return row.cash >= size && row.active && !row.paused && completeHorizon(rows, i)
}

export function completeHorizon(rows, i) {
  const endAt = rows[i].at + DAY
  let j = i + 1
  while (j < rows.length && rows[j].at < endAt) {
    if (rows[j].at - rows[j - 1].at > MAX_GAP) return false
    j++
  }
  return j < rows.length && rows[j].at - rows[j - 1].at <= MAX_GAP && rows[j].at <= endAt + MAX_GAP
}

export function candidateAlerts(rows, size, key, threshold, start, end) {
  const alerts = []
  let priorAlert = -Infinity
  for (let i = start; i < end; i++) {
    const value = features(rows, i)[key]
    if (
      !eligible(rows, i, size) ||
      value === null ||
      value < threshold ||
      rows[i].at - priorAlert < DAY
    )
      continue
    alerts.push({ index: i, at: rows[i].at, value })
    priorAlert = rows[i].at
  }
  return alerts
}

export function evaluateAlerts(alerts, episodes) {
  const covered = new Set()
  let trueAlerts = 0
  const leadsHours = []
  for (const alert of alerts) {
    const target = episodes.find((e) => e.at - alert.at >= 6 * HOUR && e.at - alert.at <= DAY)
    if (target) {
      trueAlerts++
      covered.add(target.at)
      leadsHours.push((target.at - alert.at) / HOUR)
    }
  }
  return {
    alerts: alerts.length,
    trueAlerts,
    falseAlerts: alerts.length - trueAlerts,
    hitEpisodes: covered.size,
    episodes: episodes.length,
    precision: alerts.length ? trueAlerts / alerts.length : null,
    recall: episodes.length ? covered.size / episodes.length : null,
    leadsHours,
  }
}

export function trainThreshold(rows, size, key, end) {
  const values = []
  for (let i = 0; i < end; i++) {
    const value = features(rows, i)[key]
    if (eligible(rows, i, size) && value !== null && Number.isFinite(value)) values.push(value)
  }
  if (values.length < 20) return null
  values.sort((a, b) => a - b)
  return values[Math.ceil(values.length * 0.9) - 1]
}

export function splitIndex(rows) {
  const boundary = Math.floor(rows.length * 0.7)
  const at = rows[boundary].at
  let trainEnd = boundary
  while (trainEnd > 0 && rows[trainEnd - 1].at > at - DAY) trainEnd--
  let holdoutStart = boundary
  while (holdoutStart < rows.length && rows[holdoutStart].at < at + DAY) holdoutStart++
  return { trainEnd, holdoutStart, boundaryAt: at }
}

export function independentControls(rows, size, episodes, start, end) {
  // One eligible 24h follow-up per non-overlapping day, excluding windows
  // containing a crossing or within 24h of a crossing on either side.
  let count = 0
  let nextAt = -Infinity
  for (let i = start; i < end; i++) {
    if (rows[i].at < nextAt || !eligible(rows, i, size)) continue
    if (episodes.some((e) => Math.abs(e.at - rows[i].at) <= DAY)) continue
    // A rapid re-crossing is not an independent episode, but neither is it
    // a no-event control for a supplier who could no longer exit size q.
    let crossesWithinHorizon = false
    for (let j = i + 1; j < rows.length && rows[j].at <= rows[i].at + DAY; j++) {
      if (rows[j].cash < size) {
        crossesWithinHorizon = true
        break
      }
    }
    if (crossesWithinHorizon) continue
    count++
    nextAt = rows[i].at + DAY
  }
  return count
}

export function analyze(rows) {
  assertSeries(rows)
  const split = splitIndex(rows)
  const keys = [
    'utilization',
    'debtRise6h',
    'debtRise24h',
    'utilRise24h',
    'borrowRateRise24h',
    'cashFall24h',
  ]
  const results = {}
  for (const size of SIZES) {
    const episodes = crossingEpisodes(rows, size)
    const train = episodes.filter((e) => e.index < split.trainEnd)
    const holdout = episodes.filter((e) => e.index >= split.holdoutStart)
    const controls = {
      train: independentControls(rows, size, episodes, 0, split.trainEnd),
      holdout: independentControls(rows, size, episodes, split.holdoutStart, rows.length),
    }
    const signals = {}
    for (const key of keys) {
      const threshold = trainThreshold(rows, size, key, split.trainEnd)
      signals[key] =
        threshold === null
          ? { threshold: null }
          : {
              threshold,
              ...evaluateAlerts(
                candidateAlerts(rows, size, key, threshold, split.holdoutStart, rows.length),
                holdout,
              ),
            }
    }
    results[size] = {
      alreadyUnavailableAnchors: rows.filter((row) => row.cash < size).length,
      sampledAnchors: rows.length,
      rawDownCrossings: rows.slice(1).filter((row, i) => rows[i].cash >= size && row.cash < size)
        .length,
      episodes: episodes.length,
      trainEpisodes: train.length,
      holdoutEpisodes: holdout.length,
      controls,
      signals,
    }
  }
  return { split, results }
}
