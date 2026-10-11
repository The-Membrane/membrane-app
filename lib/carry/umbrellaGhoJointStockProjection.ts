import type {
  UmbrellaGhoNativeCapacityFact,
  UmbrellaGhoNativeSource,
} from './umbrellaGhoNativeCapacity'
import {
  UMBRELLA_GHO_ROUTE,
  UMBRELLA_STKGHO,
  ORIGINAL_GHO,
  VERIFIED_STKGHO_IMPLEMENTATION,
} from './umbrellaGhoExit'

/** Structurally replayed hypothetical quotes; the private issuer authenticates originals. */
export type UmbrellaGhoJointHistoryPoint = {
  cashIndex: number
  source: UmbrellaGhoNativeSource
  acquiredAtUtc: string
  sharesRaw: string
  cooldownCoveredSharesRaw: string
  cashRaw: string | null
  fullEaRaw: string | null
  coveredEaRaw: string | null
  paused: boolean
  cooldownSeconds: string
  unstakeWindowSeconds: string
  runtimeCodeHashes: Record<string, string>
  owner: null
  historicalOwnership: false
  sourceClass: 'captured_identical_runtimes_only'
  originAcquiredAtUtc?: { host: string; acquiredAtUtc: string }[]
  totalAssetsRaw?: string
  totalSupplyRaw?: string
  maxSlashableAssetsRaw?: string
  authority?: Record<string, false>
}
export type UmbrellaGhoJointStockProjectionInput = {
  current: UmbrellaGhoNativeCapacityFact
  history: readonly UmbrellaGhoJointHistoryPoint[]
  issuedAtUtc: string
  horizonMs: number
  requestedRaw: string
  includeSampledDuration?: boolean
}
export type UmbrellaGhoJointStocks = {
  cashRaw: string
  fullEaRaw: string
  coveredEaRaw: string
}
export type UmbrellaGhoJointMeasurement = {
  cashRaw: string
  fullEaRaw: string
  coveredEaRaw: string
  eligible: boolean
  availableRaw: string
  headroomRaw: string
}
export type UmbrellaGhoJointRational = {
  numeratorRaw: string
  denominatorRaw: string
  floorRaw: string
}
export type UmbrellaGhoJointDistribution = {
  empiricalMean: UmbrellaGhoJointRational
  band: {
    minRaw: string
    p10Raw: string
    median: UmbrellaGhoJointRational
    p90Raw: string
    maxRaw: string
  }
}
export type UmbrellaGhoJointSampledDuration = {
  checkpoints: ({ elapsedMs: number; atUtc: string } & UmbrellaGhoJointMeasurement)[]
  firstSampledInsufficiencyMs: number | null
  firstSampledRecoveryMs: number | null
  /** Present only when conditions hold at issue; waiting is not conditions holding now. */
  sampledConditionsLastingMs: number | null
  knownWindowOpeningMs: number | null
  knownWindowClosingMs: number | null
  maxCheckpointGapMs: number
  unknownBetweenCheckpoints: true
  trueFirstLossClaim: false
  continuousProof: false
}
export type UmbrellaGhoJointScenario = {
  fromIndex: number
  donorPeriodMs: number
  signedDeltaByChannel: UmbrellaGhoJointStocks
} & (
  | {
      status: 'usable'
      projectedStocks: UmbrellaGhoJointStocks
      measurement: UmbrellaGhoJointMeasurement
      sampledDuration: UmbrellaGhoJointSampledDuration | null
    }
  | { status: 'censored'; censorReason: string }
)
export type UmbrellaGhoJointStockProjection = {
  status: 'conditional_umbrella_gho_joint_stock_projection'
  input: UmbrellaGhoJointStockProjectionInput
  sourceAgeMs: number
  projectionElapsedMs: number
  sourceMeasurement: UmbrellaGhoJointMeasurement
  persistenceTarget: UmbrellaGhoJointMeasurement | null
  scenarios: UmbrellaGhoJointScenario[]
  excludedIntervals: { fromIndex: number; reason: string }[]
  usableScenarioCount: number
  targetSummary: {
    available: UmbrellaGhoJointDistribution
    headroom: UmbrellaGhoJointDistribution
  } | null
  usableOnlyDiagnostic: {
    available: UmbrellaGhoJointDistribution | null
    headroom: UmbrellaGhoJointDistribution | null
  }
  MRaw: null
  window: {
    opensAtUtc: string | null
    closesExclusiveAtUtc: string | null
    initiationUnknown: boolean
  }
  assumptions: {
    sameFullAndCoveredSharesAtEveryAnchor: true
    existingSnapshotAndPolicyConditionallyUnchanged: true
    signedNativeUnitRounding: 'mathematical_floor'
    nativeNetFlowsNotSubtractedAgainAsM: true
    sourceAgeCountedOnce: true
    sharedCashNotHolderOwned: true
    durationsRelativeToIssue: true
    exactWindowBreakpointsInserted: true
  }
  flags: {
    originalAuthority: false
    authenticated: false
    historicalOwnership: false
    executionAuthority: false
    calibratedProbability: false
    guaranteedDelivery: false
    coverageCountPromotion: false
  }
  independentHistoricalSeries: 1
}

const MAX = (1n << 256n) - 1n
const CHANNELS = ['cashRaw', 'fullEaRaw', 'coveredEaRaw'] as const
type Stocks = Record<(typeof CHANNELS)[number], bigint>
const HASHES: Record<string, string> = {
  [UMBRELLA_STKGHO]: '0x5fa5d4889c27130d81c0afb814238692ca6b8774d690db729865fca3e3722a52',
  [VERIFIED_STKGHO_IMPLEMENTATION]:
    '0x553314ff37b47c42c33fc80c155f04cf1f0163967003f2a0bac7ccbb1dd22a21',
  [ORIGINAL_GHO]: '0xdd51428dd1ef13362e52bfc1689ed8e011730e6c6d5b50aaf96165ccd7bf0172',
}
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw Error(reason)
}
function uint(v: unknown): bigint {
  check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v), 'invalid_native_uint')
  const n = BigInt(v)
  check(n <= MAX, 'native_uint_overflow')
  return n
}
function time(v: unknown, seconds = false): number {
  check(typeof v === 'string', 'invalid_clock')
  const n = Date.parse(v)
  check(
    Number.isSafeInteger(n) &&
      n > 0 &&
      new Date(n).toISOString() === v &&
      (!seconds || n % 1000 === 0),
    'invalid_clock',
  )
  return n
}
/** Copy own primitive data before validation; aliases are allowed, cycles/accessors are not. */
function snapshot(value: unknown): unknown {
  let nodes = 0,
    bytes = 0
  const path = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= 50000 && depth <= 24, 'input_bound')
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'string') {
      bytes += v.length * 2
      check(v.length <= 65536 && bytes <= 2 * 1024 * 1024, 'input_bound')
      return v
    }
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v), 'input_number')
      return v
    }
    check(v && typeof v === 'object' && !path.has(v), 'input_plain_or_cycle')
    check(
      Object.getPrototypeOf(v) === Object.prototype ||
        Object.getPrototypeOf(v) === null ||
        (Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype),
      'input_prototype',
    )
    path.add(v)
    const own = Reflect.ownKeys(v)
    if (Array.isArray(v)) {
      check(v.length <= 4096 && own.length === v.length + 1, 'input_dense')
      const out = []
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i))
        check(d && d.enumerable && Object.hasOwn(d, 'value'), 'input_accessor_or_sparse')
        out.push(copy(d.value, depth + 1))
      }
      path.delete(v)
      return out
    }
    check(own.length <= 128, 'input_bound')
    const out: Record<string, unknown> = {}
    for (const k of own) {
      check(
        typeof k === 'string' && !['__proto__', 'constructor', 'prototype'].includes(k),
        'input_key',
      )
      const d = Object.getOwnPropertyDescriptor(v, k)
      check(d && d.enumerable && Object.hasOwn(d, 'value'), 'input_accessor')
      out[k] = copy(d.value, depth + 1)
    }
    path.delete(v)
    return out
  }
  return copy(value, 0)
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function same(a: Record<string, string>, b: Record<string, string>): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && a[k] === b[k])
  )
}
function runtime(v: Record<string, string>): void {
  check(
    v &&
      typeof v === 'object' &&
      Object.keys(v).length === 3 &&
      Object.keys(HASHES).every(
        (k) => Object.hasOwn(v, k) && typeof v[k] === 'string' && /^0x[0-9a-f]{64}$/.test(v[k]),
      ),
    'invalid_runtime_identity',
  )
}
function source(v: UmbrellaGhoNativeSource): number {
  check(
    v &&
      v.chainId === 1 &&
      v.finalized === true &&
      Number.isSafeInteger(v.blockNumber) &&
      v.blockNumber > 0 &&
      /^0x[0-9a-f]{64}$/.test(v.blockHash),
    'invalid_native_source',
  )
  return time(v.blockTime, true)
}
function raw(v: Stocks): UmbrellaGhoJointStocks {
  return Object.fromEntries(CHANNELS.map((k) => [k, String(v[k])])) as UmbrellaGhoJointStocks
}
function floor(n: bigint, d: bigint): bigint {
  const q = n / d
  return n < 0n && n % d !== 0n ? q - 1n : q
}
function project(from: Stocks, delta: Stocks, elapsed: number, period: number): Stocks {
  return Object.fromEntries(
    CHANNELS.map((k) => [k, from[k] + floor(delta[k] * BigInt(elapsed), BigInt(period))]),
  ) as Stocks
}
function rational(n: bigint, d: bigint): UmbrellaGhoJointRational {
  return { numeratorRaw: String(n), denominatorRaw: String(d), floorRaw: String(floor(n, d)) }
}
function summary(values: bigint[]): UmbrellaGhoJointDistribution | null {
  if (!values.length) return null
  const a = [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
    n = a.length,
    middle = Math.floor(n / 2)
  return {
    empiricalMean: rational(
      a.reduce((x, y) => x + y, 0n),
      BigInt(n),
    ),
    band: {
      minRaw: String(a[0]),
      p10Raw: String(a[Math.floor((n - 1) / 10)]),
      median: n % 2 ? rational(a[middle], 1n) : rational(a[middle - 1] + a[middle], 2n),
      p90Raw: String(a[Math.ceil(((n - 1) * 9) / 10)]),
      maxRaw: String(a[n - 1]),
    },
  }
}
function measure(
  c: UmbrellaGhoNativeCapacityFact,
  stocks: Stocks,
  Q: bigint,
  at: number,
): UmbrellaGhoJointMeasurement {
  CHANNELS.forEach((k) =>
    check(stocks[k] >= 0n && stocks[k] <= MAX, 'projected_stock_out_of_range:' + k),
  )
  const eligible =
    !c.paused &&
    BigInt(c.cooldownSharesRaw) > 0n &&
    c.cooldownEnd > 0 &&
    at >= c.cooldownEnd * 1000 &&
    at < (c.windowEndInclusive + 1) * 1000
  const available = eligible
    ? CHANNELS.reduce((a, k) => (stocks[k] < a ? stocks[k] : a), stocks.cashRaw)
    : 0n
  return {
    ...raw(stocks),
    eligible,
    availableRaw: String(available),
    headroomRaw: String(available - Q),
  }
}
function duration(
  c: UmbrellaGhoNativeCapacityFact,
  stocks: Stocks,
  delta: Stocks,
  Q: bigint,
  issue: number,
  H: number,
  age: number,
  period: number,
): UmbrellaGhoJointSampledDuration {
  const grid = new Set<number>([0, H])
  const count = Math.min(64, Math.max(1, Math.ceil(H / 1000)))
  for (let i = 1; i < count; i++) grid.add(Math.floor((i * H) / count))
  const open = c.cooldownEnd * 1000 - issue,
    close = (c.windowEndInclusive + 1) * 1000 - issue
  for (const edge of [open, close]) if (edge >= 0 && edge <= H) grid.add(edge)
  const checkpoints = [...grid]
    .sort((a, b) => a - b)
    .map((elapsedMs) => ({
      elapsedMs,
      atUtc: new Date(issue + elapsedMs).toISOString(),
      ...measure(c, project(stocks, delta, age + elapsedMs, period), Q, issue + elapsedMs),
    }))
  const firstBad = checkpoints.find((p) => BigInt(p.availableRaw) < Q)?.elapsedMs ?? null
  let firstRecovery: number | null = null,
    seenBad = false,
    maxGap = 0
  checkpoints.forEach((p, i) => {
    if (BigInt(p.availableRaw) < Q) seenBad = true
    else if (seenBad && firstRecovery === null) firstRecovery = p.elapsedMs
    if (i) maxGap = Math.max(maxGap, p.elapsedMs - checkpoints[i - 1].elapsedMs)
  })
  const holdingAtIssue = checkpoints[0].eligible && BigInt(checkpoints[0].availableRaw) >= Q
  return {
    checkpoints,
    firstSampledInsufficiencyMs: firstBad,
    firstSampledRecoveryMs: firstRecovery,
    sampledConditionsLastingMs: holdingAtIssue ? (firstBad ?? H) : null,
    knownWindowOpeningMs: open >= 0 && open <= H ? open : null,
    knownWindowClosingMs: close >= 0 && close <= H ? close : null,
    maxCheckpointGapMs: maxGap,
    unknownBetweenCheckpoints: true,
    trueFirstLossClaim: false,
    continuousProof: false,
  }
}
/** Pure descriptive NET scenarios. Structural facts and frozen output grant no original authority. */
export function buildUmbrellaGhoJointStockProjection(
  supplied: UmbrellaGhoJointStockProjectionInput,
): UmbrellaGhoJointStockProjection | null {
  try {
    const input = snapshot(supplied) as UmbrellaGhoJointStockProjectionInput
    check(
      Object.keys(input).every((k) =>
        [
          'current',
          'history',
          'issuedAtUtc',
          'horizonMs',
          'requestedRaw',
          'includeSampledDuration',
        ].includes(k),
      ),
      'input_key',
    )
    const c = input.current,
      issue = time(input.issuedAtUtc),
      sourceAt = source(c.source),
      readAt = time(c.readAtUtc),
      age = issue - sourceAt,
      H = input.horizonMs,
      Q = uint(input.requestedRaw),
      S = uint(c.fullSharesRaw),
      CS = uint(c.cooldownSharesRaw)
    check(
      Q > 0n &&
        S > 0n &&
        CS < 1n << 192n &&
        Number.isSafeInteger(H) &&
        H > 0 &&
        H <= 30 * 86400000 &&
        Number.isSafeInteger(issue + H),
      'invalid_position_or_horizon',
    )
    check(
      sourceAt <= readAt && readAt <= issue && age >= 0 && age <= 30 * 60000,
      'current_clock_or_ttl',
    )
    check(
      input.includeSampledDuration === undefined ||
        typeof input.includeSampledDuration === 'boolean',
      'invalid_duration_option',
    )
    runtime(c.runtimeCodeHashes)
    check(
      c.schema === 'umbrella_gho_native_capacity_v1' &&
        c.profileId === 'umbrella_stkgho_v1_native_2026_10_08' &&
        c.routeKey === UMBRELLA_GHO_ROUTE &&
        c.destination === UMBRELLA_STKGHO &&
        c.asset === ORIGINAL_GHO &&
        c.assetDecimals === 18 &&
        c.shareDecimals === 18 &&
        /^0x[0-9a-f]{40}$/.test(c.owner) &&
        c.owner !== '0x' + '0'.repeat(40) &&
        same(c.runtimeCodeHashes, HASHES) &&
        c.runtimeProfileQualified === true &&
        c.qualification === 'runtime_profile_qualified' &&
        c.fullEaMethod === 'preview_redeem_full_position' &&
        c.cooldownStartedAt === null &&
        c.MRaw === null &&
        typeof c.paused === 'boolean' &&
        [
          'originalAuthority',
          'authenticated',
          'executionAuthority',
          'historicalOwnership',
          'guaranteedDelivery',
        ].every((k) => c[k as keyof typeof c] === false),
      'current_native_identity',
    )
    for (const n of [
      c.cooldownEnd,
      c.withdrawalWindowSeconds,
      c.currentCooldownSeconds,
      c.currentUnstakeWindowSeconds,
    ])
      check(Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff, 'invalid_window_policy')
    check(
      c.windowEndInclusive === c.cooldownEnd + c.withdrawalWindowSeconds &&
        Number.isSafeInteger((c.windowEndInclusive + 1) * 1000),
      'invalid_window',
    )
    if (sourceAt <= c.windowEndInclusive * 1000 + 999)
      check(CS <= S, 'active_snapshot_exceeds_position')
    const sourceInWindow =
      CS > 0n && sourceAt >= c.cooldownEnd * 1000 && sourceAt < (c.windowEndInclusive + 1) * 1000
    check(
      uint(c.maxRedeemSharesRaw) === (c.paused ? 0n : sourceInWindow ? CS : 0n),
      'native_max_redeem_mismatch',
    )
    if (c.paused) check(uint(c.maxSlashableAssetsRaw) === 0n, 'paused_slashable')
    else uint(c.maxSlashableAssetsRaw)
    uint(c.totalAssetsGhoRaw)
    uint(c.totalSupplySharesRaw)
    const expectedState = c.paused
      ? 'paused'
      : CS === 0n || c.cooldownEnd === 0
        ? 'cooldown_not_started'
        : sourceAt < c.cooldownEnd * 1000
          ? 'waiting'
          : sourceInWindow
            ? 'window_open'
            : 'window_expired'
    check(c.state === expectedState, 'native_state_mismatch')
    const stocks: Stocks = {
      cashRaw: uint(c.ghoCashRaw),
      fullEaRaw: uint(c.fullEaRaw),
      coveredEaRaw: uint(c.cooldownSnapshotEaRaw),
    }
    check(
      Array.isArray(input.history) && input.history.length >= 2 && input.history.length <= 128,
      'history_count',
    )
    const historicalTimes = input.history.map((p, i) => {
      const at = source(p.source),
        acquired = time(p.acquiredAtUtc)
      check(
        Number.isSafeInteger(p.cashIndex) &&
          p.cashIndex >= 0 &&
          p.cashIndex <= 119 &&
          at < sourceAt &&
          p.source.blockNumber < c.source.blockNumber &&
          at <= acquired &&
          acquired <= issue &&
          p.owner === null &&
          p.historicalOwnership === false &&
          p.sourceClass === 'captured_identical_runtimes_only' &&
          typeof p.paused === 'boolean',
        'historical_source_or_ownership',
      )
      check(
        p.sharesRaw === c.fullSharesRaw && p.cooldownCoveredSharesRaw === c.cooldownSharesRaw,
        'historical_share_basis_mismatch',
      )
      runtime(p.runtimeCodeHashes)
      uint(p.cooldownSeconds)
      uint(p.unstakeWindowSeconds)
      for (const k of CHANNELS) if (p[k] !== null) uint(p[k])
      if (p.authority)
        check(
          Object.values(p.authority).every((v) => v === false),
          'historical_authority',
        )
      if (p.originAcquiredAtUtc) {
        check(
          p.originAcquiredAtUtc.length === 2 &&
            p.originAcquiredAtUtc[0].host === 'eth-mainnet.g.alchemy.com' &&
            p.originAcquiredAtUtc[1].host === 'rpc.ankr.com',
          'historical_origin',
        )
        const clocks = p.originAcquiredAtUtc.map((x) => time(x.acquiredAtUtc))
        check(
          clocks.every((n) => n >= at && n <= issue) && Math.max(...clocks) === acquired,
          'historical_origin_clock',
        )
      }
      if (i)
        check(
          at > source(input.history[i - 1].source) &&
            p.source.blockNumber > input.history[i - 1].source.blockNumber &&
            p.cashIndex > input.history[i - 1].cashIndex,
          'historical_order',
        )
      return at
    })
    const unknown = c.paused
      ? 'source_paused_future_unpause_unknown'
      : CS === 0n || c.cooldownEnd === 0
        ? 'future_cooldown_initiation_unknown'
        : null
    const scenarios: UmbrellaGhoJointScenario[] = [],
      excludedIntervals: { fromIndex: number; reason: string }[] = []
    for (let i = 0; i + 1 < input.history.length; i++) {
      const a = input.history[i],
        z = input.history[i + 1],
        period = historicalTimes[i + 1] - historicalTimes[i]
      let reason: string | null = null
      if (z.cashIndex !== a.cashIndex + 1 || period > 91800000) reason = 'historical_gap'
      else if (
        [a, z].some(
          (p) =>
            !same(p.runtimeCodeHashes, c.runtimeCodeHashes) ||
            p.paused !== c.paused ||
            p.cooldownSeconds !== String(c.currentCooldownSeconds) ||
            p.unstakeWindowSeconds !== String(c.currentUnstakeWindowSeconds),
        )
      )
        reason = 'historical_regime_changed'
      else if ([a, z].some((p) => CHANNELS.some((k) => p[k] === null)))
        reason = 'unsupported_native_channel'
      if (reason) {
        excludedIntervals.push({ fromIndex: i, reason })
        continue
      }
      const delta = Object.fromEntries(
        CHANNELS.map((k) => [k, BigInt(z[k]!) - BigInt(a[k]!)]),
      ) as Stocks
      const common = { fromIndex: i, donorPeriodMs: period, signedDeltaByChannel: raw(delta) }
      try {
        check(unknown === null, unknown ?? 'unknown_eligibility')
        const projected = project(stocks, delta, age + H, period)
        const measurement = measure(c, projected, Q, issue + H)
        const sampledDuration =
          input.includeSampledDuration === false
            ? null
            : duration(c, stocks, delta, Q, issue, H, age, period)
        scenarios.push({
          ...common,
          status: 'usable',
          projectedStocks: raw(projected),
          measurement,
          sampledDuration,
        })
      } catch (e) {
        scenarios.push({
          ...common,
          status: 'censored',
          censorReason: e instanceof Error ? e.message : 'invalid_joint_projection',
        })
      }
    }
    const usable = scenarios.filter(
      (s): s is Extract<UmbrellaGhoJointScenario, { status: 'usable' }> => s.status === 'usable',
    )
    const diagnostic = {
      available: summary(usable.map((s) => BigInt(s.measurement.availableRaw))),
      headroom: summary(usable.map((s) => BigInt(s.measurement.headroomRaw))),
    }
    const headline =
      usable.length > 0 &&
      usable.length === scenarios.length &&
      excludedIntervals.length === 0 &&
      diagnostic.available &&
      diagnostic.headroom
        ? { available: diagnostic.available, headroom: diagnostic.headroom }
        : null
    return freeze<UmbrellaGhoJointStockProjection>({
      status: 'conditional_umbrella_gho_joint_stock_projection',
      input,
      sourceAgeMs: age,
      projectionElapsedMs: age + H,
      sourceMeasurement: measure(c, stocks, Q, sourceAt),
      persistenceTarget: unknown ? null : measure(c, stocks, Q, issue + H),
      scenarios,
      excludedIntervals,
      usableScenarioCount: usable.length,
      targetSummary: headline,
      usableOnlyDiagnostic: diagnostic,
      MRaw: null,
      window: {
        opensAtUtc:
          CS > 0n && c.cooldownEnd > 0 ? new Date(c.cooldownEnd * 1000).toISOString() : null,
        closesExclusiveAtUtc:
          CS > 0n && c.cooldownEnd > 0
            ? new Date((c.windowEndInclusive + 1) * 1000).toISOString()
            : null,
        initiationUnknown: CS === 0n || c.cooldownEnd === 0,
      },
      assumptions: {
        sameFullAndCoveredSharesAtEveryAnchor: true,
        existingSnapshotAndPolicyConditionallyUnchanged: true,
        signedNativeUnitRounding: 'mathematical_floor',
        nativeNetFlowsNotSubtractedAgainAsM: true,
        sourceAgeCountedOnce: true,
        sharedCashNotHolderOwned: true,
        durationsRelativeToIssue: true,
        exactWindowBreakpointsInserted: true,
      },
      flags: {
        originalAuthority: false,
        authenticated: false,
        historicalOwnership: false,
        executionAuthority: false,
        calibratedProbability: false,
        guaranteedDelivery: false,
        coverageCountPromotion: false,
      },
      independentHistoricalSeries: 1,
    })
  } catch {
    return null
  }
}
