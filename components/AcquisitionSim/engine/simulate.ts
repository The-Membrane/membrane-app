import type {
  SimConfig,
  SimEvent,
  SimPhase,
  SimTick,
  UtilizationPoint,
} from './types'
import { DEFAULT_CONFIG } from './types'

// ─── Constants ────────────────────────────────────────────────────────────

const SECONDS_PER_DAY = 86_400
const TICK_DT = 3_600 // 1 hour per tick

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Linearly interpolate utilization at a given second from sorted points */
function interpolateUtilization(
  points: UtilizationPoint[],
  seconds: number
): number {
  if (points.length === 0) return 0.5
  if (points.length === 1) return points[0].utilization

  const day = seconds / SECONDS_PER_DAY

  // Before first point → use first value
  if (day <= points[0].dayOffset) return points[0].utilization
  // After last point → use last value
  if (day >= points[points.length - 1].dayOffset)
    return points[points.length - 1].utilization

  // Find surrounding points and lerp
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (day >= a.dayOffset && day <= b.dayOffset) {
      const t = (day - a.dayOffset) / (b.dayOffset - a.dayOffset)
      return a.utilization + t * (b.utilization - a.utilization)
    }
  }

  return points[points.length - 1].utilization
}

/** Collect events that fall within [tickStart, tickEnd) in seconds */
function eventsInTick(
  events: SimEvent[],
  tickStartSec: number,
  tickEndSec: number
): SimEvent[] {
  return events.filter((e) => {
    const eSec = e.dayOffset * SECONDS_PER_DAY
    return eSec >= tickStartSec && eSec < tickEndSec
  })
}

/** Format large numbers for labels */
function formatAmount(amount: number): string {
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1)}B`
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(0)}M`
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(0)}K`
  return amount.toFixed(0)
}

// ─── Simulation Engine ────────────────────────────────────────────────────

export function runSimulation(
  config: Partial<SimConfig>,
  events: SimEvent[],
  utilizationCurve: UtilizationPoint[]
): SimTick[] {
  const cfg: SimConfig = { ...DEFAULT_CONFIG, ...config }

  // Derived values
  const depositPeriodSec = cfg.depositPeriodDays * SECONDS_PER_DAY
  const withdrawalPeriodSec = cfg.withdrawalPeriodDays * SECONDS_PER_DAY
  const cliffPeriodSec = cfg.cliffPeriodDays * SECONDS_PER_DAY
  const maxRate = cfg.maxMbrnEmission / depositPeriodSec
  const bumpReductionInterval =
    cfg.bumpIntervalSeconds / cfg.reductionSpeedMultiplier

  // Sort events by time
  const sortedEvents = [...events].sort((a, b) => a.dayOffset - b.dayOffset)

  // Determine total simulation length
  const lastEventDay =
    sortedEvents.length > 0
      ? sortedEvents[sortedEvents.length - 1].dayOffset
      : 0
  const lastUtilDay =
    utilizationCurve.length > 0
      ? utilizationCurve[utilizationCurve.length - 1].dayOffset
      : 0
  // Simulate at least through cliff end, or through the latest input
  const minDays =
    cfg.depositPeriodDays + cfg.withdrawalPeriodDays + cfg.cliffPeriodDays
  const totalDays = Math.max(minDays, lastEventDay + 5, lastUtilDay + 5)
  // Cap at reasonable max to prevent runaway
  const simDays = Math.min(totalDays, 150)
  const totalTicks = Math.ceil((simDays * SECONDS_PER_DAY) / TICK_DT)

  // ── State ──
  let accruedPool = 0
  let poolMaxed = false
  let currentRate = cfg.baseAcquisitionRate
  let bumpRate = cfg.initialBumpRate
  let totalGrossDeposits = 0
  let totalNetDeposits = 0
  let lastMutationEfficiency: number | null = null
  let efficiencyClamped = false
  let acquisitionBudget: number | null = null
  let windowTimersStarted = false
  let depositEndSec = Infinity
  let withdrawalEndSec = Infinity
  let cliffEndSec = Infinity

  // Bump timing
  let lastBumpUpTime = 0
  let lastBumpDownTime = 0

  // Track the day when first mutation measurement was taken (after day 1)
  let firstMutationDay = -1

  const ticks: SimTick[] = []

  for (let i = 0; i <= totalTicks; i++) {
    const seconds = i * TICK_DT
    const day = seconds / SECONDS_PER_DAY
    const tickEnd = seconds + TICK_DT

    // ── Interpolate utilization ──
    const utilization = interpolateUtilization(utilizationCurve, seconds)
    const isAboveTarget = utilization >= cfg.targetUtilization

    // ── Determine phase ──
    let phase: SimPhase = 'awaiting'
    if (windowTimersStarted) {
      if (seconds < depositEndSec) {
        phase = 'deposit'
      } else if (seconds < withdrawalEndSec) {
        phase = 'withdrawal'
      } else if (seconds < cliffEndSec) {
        phase = cliffEndSec === Infinity ? 'post-withdrawal' : 'cliff'
      } else {
        phase = 'cliff'
      }
    }

    // ── Process events in this tick ──
    const tickEvents = eventsInTick(sortedEvents, seconds, tickEnd)
    const eventLabels: string[] = []

    for (const evt of tickEvents) {
      if (evt.type === 'deposit') {
        // First deposit starts timers
        if (!windowTimersStarted) {
          windowTimersStarted = true
          depositEndSec = seconds + depositPeriodSec
          withdrawalEndSec = depositEndSec + withdrawalPeriodSec
          cliffEndSec = withdrawalEndSec + cliffPeriodSec
          phase = 'deposit'
        }

        // Only accept deposits during deposit period
        if (seconds < depositEndSec) {
          totalGrossDeposits += evt.amount
          totalNetDeposits += evt.amount
          eventLabels.push(`Deposit ${formatAmount(evt.amount)} uCDT`)
        }
      } else if (evt.type === 'withdrawal') {
        // Only during withdrawal period (or deposit period for early withdrawals)
        if (seconds < withdrawalEndSec) {
          totalNetDeposits = Math.max(0, totalNetDeposits - evt.amount)
          eventLabels.push(`Withdraw ${formatAmount(evt.amount)} uCDT`)
        }
      }
    }

    // ── Pool accrual ──
    const isAccruing = isAboveTarget && !poolMaxed
    if (isAccruing && i > 0) {
      const newMbrn = currentRate * TICK_DT
      accruedPool = Math.min(accruedPool + newMbrn, cfg.maxMbrnEmission)
      if (accruedPool >= cfg.maxMbrnEmission) {
        poolMaxed = true
      }
    }

    // ── Efficiency control / rate mutation (after day 1, during deposit period) ──
    if (
      day >= 1 &&
      phase === 'deposit' &&
      totalGrossDeposits > 0 &&
      accruedPool > 0
    ) {
      const efficiency = totalGrossDeposits / accruedPool

      if (firstMutationDay < 0) {
        // First measurement — store, no mutation yet
        lastMutationEfficiency = efficiency
        firstMutationDay = day
      } else if (lastMutationEfficiency !== null && lastMutationEfficiency > 0) {
        // Subsequent measurements — compute delta and mutate
        const delta =
          (efficiency - lastMutationEfficiency) / lastMutationEfficiency

        // Clamp delta magnitude to max_rate_change_per_mutation
        const clampedDelta = Math.max(
          -cfg.maxRateChangePerMutation,
          Math.min(cfg.maxRateChangePerMutation, delta)
        )

        const rateChange = Math.abs(clampedDelta) * currentRate

        if (clampedDelta < 0) {
          // Efficiency WORSENING → rate INCREASES (emit more to attract deposits)
          currentRate = Math.min(currentRate + rateChange, maxRate)
        } else if (clampedDelta > 0) {
          // Efficiency IMPROVING → rate DECREASES (emit less, being efficient)
          currentRate = Math.max(currentRate - rateChange, 0)
        }

        lastMutationEfficiency = efficiency
      }
    }

    // ── Bump rate ──
    if (poolMaxed) {
      if (isAboveTarget) {
        // Bump UP: increment every bumpIntervalSeconds
        const timeSinceLastUp = seconds - lastBumpUpTime
        if (timeSinceLastUp >= cfg.bumpIntervalSeconds) {
          const ticks_elapsed = Math.floor(
            timeSinceLastUp / cfg.bumpIntervalSeconds
          )
          bumpRate += cfg.bumpIncrement * ticks_elapsed
          lastBumpUpTime =
            seconds -
            (timeSinceLastUp % cfg.bumpIntervalSeconds)
        }
      }
    }

    // Bump DOWN: whenever util < target and bump > 0 (regardless of poolMaxed)
    if (!isAboveTarget && bumpRate > 0) {
      const timeSinceLastDown = seconds - lastBumpDownTime
      if (timeSinceLastDown >= bumpReductionInterval) {
        const ticks_elapsed = Math.floor(
          timeSinceLastDown / bumpReductionInterval
        )
        bumpRate = Math.max(0, bumpRate - cfg.bumpIncrement * ticks_elapsed)
        lastBumpDownTime =
          seconds -
          (timeSinceLastDown % bumpReductionInterval)
      }
    }

    // ── Efficiency clamp (one-time at post-withdrawal entry) ──
    if (
      phase === 'post-withdrawal' &&
      !efficiencyClamped &&
      seconds >= withdrawalEndSec
    ) {
      efficiencyClamped = true

      if (totalGrossDeposits > 0) {
        const baselinePool = cfg.baseAcquisitionRate * depositPeriodSec
        const baselineRatio = baselinePool / totalGrossDeposits
        const realizedRatio = accruedPool / totalGrossDeposits
        const maxAcceptable = baselineRatio * (1 + cfg.maxRateChangePerMutation)

        if (realizedRatio > maxAcceptable) {
          // Clamp fires — reduce pool
          const clampedPool = totalGrossDeposits * maxAcceptable
          acquisitionBudget = Math.min(clampedPool, cfg.maxMbrnEmission)
          eventLabels.push(
            `CLAMP: budget reduced to ${formatAmount(acquisitionBudget)}`
          )
        } else {
          acquisitionBudget = Math.min(accruedPool, cfg.maxMbrnEmission)
          eventLabels.push(`Budget set: ${formatAmount(acquisitionBudget)}`)
        }
      } else {
        acquisitionBudget = 0
      }
    }

    // ── Compute display values ──
    const efficiency =
      accruedPool > 0 && totalGrossDeposits > 0
        ? totalGrossDeposits / accruedPool
        : 0

    const cdpRateImpact = bumpRate * cfg.maxLTV

    // ── Push tick ──
    ticks.push({
      day: Math.round(day * 100) / 100,
      seconds,
      phase,
      accruedPool,
      poolMaxed,
      currentRate,
      utilization,
      isAccruing,
      bumpRate,
      cdpRateImpact,
      totalGrossDeposits,
      totalNetDeposits,
      efficiency,
      lastMutationEfficiency,
      efficiencyClamped,
      acquisitionBudget,
      eventLabel:
        eventLabels.length > 0 ? eventLabels.join(' | ') : undefined,
    })
  }

  return ticks
}
