// Preregistered Sky LitePSM USDC-exit runway study. Keep this contract fixed
// before looking at historical outcomes; alternate sizes are exploratory.
// Pre-data correction 2026-09-25: a $100M candidate was briefly written but
// had no measured holder-size justification. Its RPC pilot was stopped before
// an artifact or result existed. The $20M primary is a hypothetical scenario
// chosen for cross-venue comparability, NOT an observed holder distribution.
export const SKY_RUNWAY_PROTOCOL = Object.freeze({
  study: 'sky-litepsm-usdc-runway-v1',
  positionUsdc: 20_000_000,
  horizonMinHours: 6,
  horizonMaxHours: 24,
  eventClusterHours: 48,
  sampleGapMaxHours: 4,
  trainFraction: 0.7,
  minIndependentEvents: 20,
  minIndependentControls: 20,
  minHoldoutEvents: 6,
  minHoldoutControls: 6,
  minHoldoutAlerts: 6,
  signalRunwayHours: 30,
  minCoverageAtSignal: 1.25,
  baselineLowCoverage: 1.25,
  baselineMomentum24hPct: 0.1,
  minPrecisionLiftPp: 10,
  minHoldoutRecallWilsonLower95: 0.5,
  minHoldoutPrecisionWilsonLower95: 0.2,
})

const HOUR = 3600

export function wilsonLower95(successes, trials) {
  if (!trials) return 0
  const z = 1.959963984540054
  const p = successes / trials
  const z2 = z * z
  return (
    (p + z2 / (2 * trials) - z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) /
    (1 + z2 / trials)
  )
}

export function wilsonUpper95(successes, trials) {
  if (!trials) return 1
  const z = 1.959963984540054
  const p = successes / trials
  const z2 = z * z
  return (
    (p + z2 / (2 * trials) + z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) /
    (1 + z2 / trials)
  )
}

export function makeRunwayRows(samples, transfers, protocol = SKY_RUNWAY_PROTOCOL) {
  if (samples.length < 2) throw new Error('At least two pinned samples are required')
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  const flows = [...transfers].sort((a, b) => a.at - b.at)
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]
    if (!Number.isSafeInteger(row.block) || !Number.isSafeInteger(row.at))
      throw new Error('Invalid pinned sample')
    if (!Number.isFinite(row.pocketUsdc) || row.pocketUsdc < 0)
      throw new Error('Invalid Pocket balance')
    if (i && (row.at <= sorted[i - 1].at || row.block <= sorted[i - 1].block))
      throw new Error('Samples must increase by block and timestamp')
  }
  for (const flow of flows) {
    if (!Number.isSafeInteger(flow.at) || !Number.isSafeInteger(flow.block))
      throw new Error('Invalid transfer time or block')
    if (!Number.isFinite(flow.usdc) || flow.usdc < 0 || !['in', 'out'].includes(flow.direction))
      throw new Error('Invalid transfer')
  }

  return sorted.map((row, index) => {
    // Strictly past-only: event blocks may be no later than the pinned state.
    const past = flows.filter((flow) => flow.block <= row.block && flow.at <= row.at)
    const sum = (hours, direction) =>
      past
        .filter((flow) => flow.at > row.at - hours * HOUR && flow.direction === direction)
        .reduce((acc, flow) => acc + flow.usdc, 0)
    const grossOut6h = sum(6, 'out')
    const grossOut24h = sum(24, 'out')
    const grossIn24h = sum(24, 'in')
    const cashHeadroom = Math.max(0, row.pocketUsdc - protocol.positionUsdc)
    const runway6h = grossOut6h > 0 ? cashHeadroom / (grossOut6h / 6) : null
    const runway24h = grossOut24h > 0 ? cashHeadroom / (grossOut24h / 24) : null
    const netOut24h = grossOut24h - grossIn24h
    const baselineNetRunway24h = netOut24h > 0 ? cashHeadroom / (netOut24h / 24) : null
    const prior24h = sorted
      .slice(0, index)
      .findLast(
        (prior) => Math.abs(row.at - prior.at - 24 * HOUR) <= protocol.sampleGapMaxHours * HOUR,
      )
    const pocketMomentum24hPct =
      prior24h && prior24h.pocketUsdc > 0
        ? (prior24h.pocketUsdc - row.pocketUsdc) / prior24h.pocketUsdc
        : null
    return {
      ...row,
      coverage: row.pocketUsdc / protocol.positionUsdc,
      grossOut6h,
      grossOut24h,
      grossIn24h,
      netOut24h,
      runway6h,
      runway24h,
      pocketMomentum24hPct,
      signal6h:
        row.pocketUsdc >= protocol.positionUsdc * protocol.minCoverageAtSignal &&
        runway6h !== null &&
        runway6h <= protocol.signalRunwayHours,
      signal24h:
        row.pocketUsdc >= protocol.positionUsdc * protocol.minCoverageAtSignal &&
        runway24h !== null &&
        runway24h <= protocol.signalRunwayHours,
      baselineLowCoverage:
        row.pocketUsdc >= protocol.positionUsdc &&
        row.pocketUsdc / protocol.positionUsdc <= protocol.baselineLowCoverage,
      baselineMomentum24h:
        pocketMomentum24hPct !== null && pocketMomentum24hPct >= protocol.baselineMomentum24hPct,
      baselineNetRunway24h:
        baselineNetRunway24h !== null && baselineNetRunway24h <= protocol.signalRunwayHours,
    }
  })
}

export function evaluateRunway(rows, protocol = SKY_RUNWAY_PROTOCOL) {
  const horizonMin = protocol.horizonMinHours * HOUR
  const horizonMax = protocol.horizonMaxHours * HOUR
  const clusterGap = protocol.eventClusterHours * HOUR
  const maxGap = protocol.sampleGapMaxHours * HOUR
  const eligible = rows.filter((row, index) => {
    if (row.pocketUsdc < protocol.positionUsdc) return false
    if (index && row.at - rows[index - 1].at > maxGap) return false
    const endIndex = rows.findIndex((next) => next.at >= row.at + horizonMax)
    if (endIndex < 0 || rows[endIndex].at > row.at + horizonMax + maxGap) return false
    return rows
      .slice(index + 1, endIndex + 1)
      .every((next, offset) => next.at - rows[index + offset].at <= maxGap)
  })
  const windows = eligible.map((row) => {
    const future = rows.filter(
      (next) => next.at >= row.at + horizonMin && next.at <= row.at + horizonMax,
    )
    return { ...row, target: future.some((next) => next.pocketUsdc < protocol.positionUsdc) }
  })
  const cluster = (items) => {
    const groups = []
    for (const row of items) {
      if (!groups.length || row.at - groups.at(-1).at > clusterGap) groups.push(row)
    }
    return groups
  }
  // Count actual first cash-shortage crossings, not adjacent positive forecast
  // windows. Otherwise one depletion is incorrectly counted many times.
  const crossings = rows.filter(
    (row, index) =>
      index > 0 &&
      row.pocketUsdc < protocol.positionUsdc &&
      rows[index - 1].pocketUsdc >= protocol.positionUsdc &&
      row.at - rows[index - 1].at <= maxGap,
  )
  const events = cluster(
    crossings.filter((crossing) =>
      windows.some(
        (window) => crossing.at >= window.at + horizonMin && crossing.at <= window.at + horizonMax,
      ),
    ),
  )
  const controls = cluster(windows.filter((row) => !row.target))
  const splitAt = rows[Math.floor((rows.length - 1) * protocol.trainFraction)].at
  const holdoutEvents = events.filter((row) => row.at > splitAt)
  const holdoutControls = controls.filter((row) => row.at > splitAt)
  const score = (name, predicate) => {
    const alerts = cluster(windows.filter((row) => row.at > splitAt && predicate(row)))
    const hits = holdoutEvents.filter((event) =>
      alerts.some(
        (alert) => event.at - alert.at <= horizonMax && event.at - alert.at >= horizonMin,
      ),
    )
    const trueAlerts = alerts.filter((alert) =>
      holdoutEvents.some(
        (event) => event.at >= alert.at + horizonMin && event.at <= alert.at + horizonMax,
      ),
    )
    return {
      name,
      alerts: alerts.length,
      hits: hits.length,
      trueAlerts: trueAlerts.length,
      precision: alerts.length ? trueAlerts.length / alerts.length : null,
      recall: holdoutEvents.length ? hits.length / holdoutEvents.length : null,
      precisionWilsonLower95: wilsonLower95(trueAlerts.length, alerts.length),
      precisionWilsonUpper95: wilsonUpper95(trueAlerts.length, alerts.length),
      recallWilsonLower95: wilsonLower95(hits.length, holdoutEvents.length),
      alertTimes: alerts.map((row) => row.at),
    }
  }
  const candidate = score('gross-outflow runway', (row) => row.signal6h || row.signal24h)
  const baselines = [
    score('low Pocket coverage', (row) => row.baselineLowCoverage),
    score('24h Pocket balance momentum', (row) => row.baselineMomentum24h),
    score('net-outflow runway', (row) => row.baselineNetRunway24h),
  ]
  const comparableBaselines = baselines.filter(
    (baseline) => baseline.alerts >= protocol.minHoldoutAlerts,
  )
  const bestBaseline = comparableBaselines.sort((a, b) => b.precision - a.precision)[0] ?? null
  const precisionLiftPp =
    bestBaseline && candidate.precision !== null
      ? 100 * (candidate.precision - bestBaseline.precision)
      : null
  // Non-overlap of separate 95% Wilson intervals is a conservative positive
  // confidence bound on the precision difference, not a fitted bootstrap.
  const precisionLiftLower95 = bestBaseline
    ? candidate.precisionWilsonLower95 - bestBaseline.precisionWilsonUpper95
    : null
  const enoughEvents =
    events.length >= protocol.minIndependentEvents &&
    holdoutEvents.length >= protocol.minHoldoutEvents
  const enoughControls =
    controls.length >= protocol.minIndependentControls &&
    holdoutControls.length >= protocol.minHoldoutControls
  return {
    samples: rows.length,
    eligibleWindows: windows.length,
    independentEvents: events.length,
    independentControls: controls.length,
    holdoutEvents: holdoutEvents.length,
    holdoutControls: holdoutControls.length,
    holdoutAlerts: candidate.alerts,
    holdoutHits: candidate.hits,
    holdoutTrueAlerts: candidate.trueAlerts,
    holdoutRecallWilsonLower95: candidate.recallWilsonLower95,
    holdoutPrecisionWilsonLower95: candidate.precisionWilsonLower95,
    candidate,
    baselines,
    bestBaseline: bestBaseline?.name ?? null,
    precisionLiftPp,
    precisionLiftLower95,
    gate: {
      enoughEvents,
      enoughControls,
      enoughAlerts: candidate.alerts >= protocol.minHoldoutAlerts,
      comparableBaseline: bestBaseline !== null,
      passed:
        enoughEvents &&
        enoughControls &&
        candidate.alerts >= protocol.minHoldoutAlerts &&
        bestBaseline !== null &&
        precisionLiftPp >= protocol.minPrecisionLiftPp &&
        precisionLiftLower95 > 0 &&
        candidate.recallWilsonLower95 >= protocol.minHoldoutRecallWilsonLower95 &&
        candidate.precisionWilsonLower95 >= protocol.minHoldoutPrecisionWilsonLower95,
    },
    // Report times rather than quietly collapsing repeated sample windows.
    eventStartTimes: events.map((row) => row.at),
    holdoutAlertTimes: candidate.alertTimes,
  }
}
