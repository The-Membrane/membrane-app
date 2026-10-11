export type RouteProxyExitProjectionInput = {
  routeKey: string
  destination: string
  requestedRaw: string
  currentCashRaw: string
  pointRaw: string
  bandLowRaw: string
  bandHighRaw: string
  horizonHours: number
  currentAt: string
  targetAt: string
  asOfAt: string
  method: 'learned_delta' | 'persistence_band' | 'historical_net_change'
  samples: number
  validation?: {
    fit: number
    calibration: number
    holdout: number
    covered: number
    coveragePassed: boolean
    pointBeatsPersistence: boolean | null
  } | null
}

export type RouteProxyHorizonAssessment =
  | 'band_above_q_at_horizon'
  | 'q_inside_band_at_horizon'
  | 'band_below_q_at_horizon'

export type RouteProxyExitProjection =
  | {
      status: 'unavailable'
      reason: 'invalid_projection'
    }
  | {
      status: 'research_projection'
      claimClass: 'route_proxy'
      holderExecutableExit: false
      forecastValidated: false
      probabilityQExecutable: null
      routeKey: string
      destination: string
      requestedRaw: string
      horizonHours: number
      targetAt: string
      method: RouteProxyExitProjectionInput['method']
      samples: number
      validation: RouteProxyExitProjectionInput['validation']
      currentState: 'cash_covers_q' | 'cash_below_q'
      projectedState: 'band_covers_q' | 'band_crosses_q' | 'band_below_q'
      direction: 'shrinking' | 'flat' | 'growing' | 'unassessed'
      projectedChangeRaw: string | null
      expectedNetFlowRaw: { low: string; point: string; high: string }
      capacityRaw: { low: string; point: string; high: string }
      marginAfterQRaw: { low: string; point: string; high: string }
      horizonAssessment: RouteProxyHorizonAssessment
      alert: { kind: 'projected_shrink'; impact: 'estimated' } | null
    }

const RAW = /^(0|[1-9]\d*)$/
const MAX_RAW = (1n << 256n) - 1n

function raw(value: unknown): bigint | null {
  if (typeof value !== 'string' || !RAW.test(value) || value.length > 78) return null
  const parsed = BigInt(value)
  return parsed <= MAX_RAW ? parsed : null
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function passesCoverage(covered: number, holdout: number): boolean {
  return covered * 100 >= holdout * 80
}

function validUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value
}

/**
 * Translate an aggregate-cash band into its exact-Q route impact. This is a
 * forward scenario, but never upgrades aggregate cash into a holder call or a
 * probability or an intra-window duration. The historical inputs only observe
 * the endpoint at the selected horizon.
 */
export function deriveRouteProxyExitProjection(
  input: RouteProxyExitProjectionInput,
): RouteProxyExitProjection {
  const requested = raw(input.requestedRaw)
  const current = raw(input.currentCashRaw)
  const point = raw(input.pointRaw)
  const low = raw(input.bandLowRaw)
  const high = raw(input.bandHighRaw)
  const validation = input.validation ?? null
  const currentAtMs = Date.parse(input.currentAt)
  const targetAtMs = Date.parse(input.targetAt)
  const asOfAtMs = Date.parse(input.asOfAt)
  if (
    typeof input.routeKey !== 'string' ||
    !input.routeKey ||
    typeof input.destination !== 'string' ||
    !/^0x[0-9a-f]{40}$/.test(input.destination) ||
    requested === null ||
    requested === 0n ||
    current === null ||
    point === null ||
    low === null ||
    high === null ||
    low > high ||
    !Number.isSafeInteger(input.horizonHours) ||
    input.horizonHours < 1 ||
    input.horizonHours > 720 ||
    !validUtc(input.currentAt) ||
    !validUtc(input.targetAt) ||
    !validUtc(input.asOfAt) ||
    asOfAtMs - currentAtMs < -120_000 ||
    asOfAtMs - currentAtMs > 30 * 60_000 ||
    targetAtMs - currentAtMs !== input.horizonHours * 60 * 60 * 1000 ||
    targetAtMs <= asOfAtMs ||
    !nonnegativeInteger(input.samples) ||
    input.samples === 0 ||
    (input.method === 'historical_net_change' && validation !== null) ||
    (input.method !== 'historical_net_change' && validation === null) ||
    (validation !== null &&
      (!nonnegativeInteger(validation.fit) ||
        validation.fit === 0 ||
        !nonnegativeInteger(validation.calibration) ||
        validation.calibration === 0 ||
        !nonnegativeInteger(validation.holdout) ||
        validation.holdout === 0 ||
        !nonnegativeInteger(validation.covered) ||
        validation.covered > validation.holdout ||
        typeof validation.coveragePassed !== 'boolean' ||
        validation.coveragePassed !== passesCoverage(validation.covered, validation.holdout) ||
        (input.method === 'learned_delta' &&
          typeof validation.pointBeatsPersistence !== 'boolean') ||
        (input.method === 'persistence_band' && validation.pointBeatsPersistence !== null)))
  )
    return { status: 'unavailable', reason: 'invalid_projection' }

  if (
    validation === null ||
    !validation.coveragePassed ||
    (input.method === 'learned_delta' && validation.pointBeatsPersistence !== true)
  )
    return { status: 'unavailable', reason: 'invalid_projection' }

  const currentCovers = current >= requested
  const projectedState =
    low >= requested
      ? ('band_covers_q' as const)
      : high < requested
        ? ('band_below_q' as const)
        : ('band_crosses_q' as const)
  const direction =
    input.method === 'historical_net_change'
      ? ('unassessed' as const)
      : input.method === 'persistence_band'
        ? high < current
          ? ('shrinking' as const)
          : low > current
            ? ('growing' as const)
            : low === current && high === current
              ? ('flat' as const)
              : ('unassessed' as const)
        : point < current
          ? ('shrinking' as const)
          : point > current
            ? ('growing' as const)
            : ('flat' as const)
  const horizonAssessment: RouteProxyHorizonAssessment =
    projectedState === 'band_covers_q'
      ? 'band_above_q_at_horizon'
      : projectedState === 'band_below_q'
        ? 'band_below_q_at_horizon'
        : 'q_inside_band_at_horizon'
  return {
    status: 'research_projection',
    claimClass: 'route_proxy',
    holderExecutableExit: false,
    forecastValidated: false,
    probabilityQExecutable: null,
    routeKey: input.routeKey,
    destination: input.destination,
    requestedRaw: input.requestedRaw,
    horizonHours: input.horizonHours,
    targetAt: input.targetAt,
    method: input.method,
    samples: input.samples,
    validation,
    currentState: currentCovers ? 'cash_covers_q' : 'cash_below_q',
    projectedState,
    direction,
    projectedChangeRaw:
      input.method === 'historical_net_change' || direction === 'unassessed'
        ? null
        : input.method === 'persistence_band'
          ? direction === 'shrinking'
            ? (high - current).toString()
            : direction === 'growing'
              ? (low - current).toString()
              : '0'
          : (point - current).toString(),
    expectedNetFlowRaw: {
      low: (low - current).toString(),
      point: (point - current).toString(),
      high: (high - current).toString(),
    },
    capacityRaw: { low: input.bandLowRaw, point: input.pointRaw, high: input.bandHighRaw },
    marginAfterQRaw: {
      low: (low - requested).toString(),
      point: (point - requested).toString(),
      high: (high - requested).toString(),
    },
    horizonAssessment,
    alert:
      currentCovers && direction === 'shrinking' && projectedState !== 'band_covers_q'
        ? { kind: 'projected_shrink', impact: 'estimated' }
        : null,
  }
}
