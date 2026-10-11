import { CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS } from './conditionalGrossFlowHeadroom'

export type ProtocolProngs = {
  sharedCashRaw: string
  fTokenSupplyRaw: string
  resolverSupplyRaw: string
  minimumRemainingSupplyRaw: string
}
export type ProtocolSource = {
  chainId: 1
  blockNumber: number
  blockHash: string
  blockTime: string
}
export type ProtocolIdentity = {
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
}
export type ProtocolObservation = {
  source: ProtocolSource
  prongs: ProtocolProngs
  runtimeIdentities: unknown
  limitParameters: unknown
}
export type ProtocolEpisode = {
  id: string
  historySha256: string
  knowledgeCutoffAt: string
  identity: ProtocolIdentity
  observations: ProtocolObservation[]
  gapAfterIndices: number[]
}
export type ProtocolProjectionInput = {
  identity: ProtocolIdentity
  current: ProtocolObservation & {
    readAtUtc: string
    sourceKind: 'manifest_bound_ledger' | 'live_read_only_two_origin_finalized'
  }
  adapter: {
    rule:
      | 'shared_cash_supply_less_remaining_limit'
      | 'shared_cash'
      | 'reported_supply_less_remaining_limit'
    supplyView: 'resolver_supply' | 'fToken_reported_supply'
  }
  scope: 'protocol' | 'existing_holder'
  holderEntitlementRaw?: string | null
  requestedRaw: string
  episodes: ProtocolEpisode[]
  asOfMs: number
}
export type ProtocolProjectedPoint = {
  observationIndex: number
  elapsedSeconds: number
  targetAt: string | null
  prongs: ProtocolProngs
  reportedProngQuoteRaw: string
  afterHolderClipRaw: string
  requestedHeadroomRaw: string
}
export type ProtocolShortfallRun = {
  firstBelowIndex: number
  lastBelowIndex: number
  onset: { lowerSeconds: number; upperSeconds: number } | null
  recovery: { lowerSeconds: number; upperSeconds: number } | null
  leftCensored: boolean
  rightCensored: boolean
}
export type ConditionalProtocolCapacityProjection = {
  status: 'conditional_reported_protocol_prong_projection'
  input: ProtocolProjectionInput
  issuedAt: string
  scenarios: {
    id: string
    historySha256: string
    points: ProtocolProjectedPoint[]
    troughIndex: number
    sampledBelowRequestedRuns: ProtocolShortfallRun[]
    regime: {
      observedRuntimeIdentitiesMatch: boolean
      observedParametersMatch: boolean
      proxyImplementationContinuity: 'unknown'
      sourceEquivalence: 'unverified'
    }
  }[]
  horizons: {
    observationIndex: number
    elapsedSeconds: { lower: number; upper: number }
    target: { earliestAt: string; latestAt: string }
    reportedQuote: {
      mean: { numeratorRaw: string; denominator: number }
      p10Raw: string
      p90Raw: string
    }
    requestedHeadroom: {
      mean: { numeratorRaw: string; denominator: number }
      p10Raw: string
      p90Raw: string
    }
    episodeCount: number
  }[]
  assumption: 'repeat_joint_historical_prong_changes_and_unchanged_holder_entitlement_under_selected_reported_rule'
  cashBelowRequestedImpliesHolderFailure: false
  executableMaximum: false
  holderExecutableExit: false
  futureSuccess: false
  forwardProbability: false
  calibrated: false
  grossFlowAdded: false
  pause: 'unknown'
  authority: 'unknown'
  hypotheticalDepositCapacity: 'unknown'
  inFlightFlows: 'unknown'
  holderEntitlementAssumption: 'fixed_entitlement_no_new_earnings_or_position_changes' | null
}

const UINT = /^(0|[1-9][0-9]{0,77})$/
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const keys = [
  'sharedCashRaw',
  'fTokenSupplyRaw',
  'resolverSupplyRaw',
  'minimumRemainingSupplyRaw',
] as const
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const raw = (v: unknown): v is string =>
  typeof v === 'string' && UINT.test(v) && BigInt(v) < 1n << 256n
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
    )
  return Object.is(a, b)
}
function identity(v: unknown): v is ProtocolIdentity {
  return (
    record(v) &&
    typeof v.routeKey === 'string' &&
    !!v.routeKey &&
    typeof v.destination === 'string' &&
    ADDRESS.test(v.destination) &&
    typeof v.asset === 'string' &&
    ADDRESS.test(v.asset) &&
    Number.isInteger(v.assetDecimals) &&
    Number(v.assetDecimals) >= 0 &&
    Number(v.assetDecimals) <= 36
  )
}
function source(v: unknown): v is ProtocolSource {
  return (
    record(v) &&
    v.chainId === 1 &&
    Number.isSafeInteger(v.blockNumber) &&
    Number(v.blockNumber) > 0 &&
    typeof v.blockHash === 'string' &&
    HASH.test(v.blockHash) &&
    utc(v.blockTime)
  )
}
function observation(v: unknown): v is ProtocolObservation {
  return (
    record(v) &&
    source(v.source) &&
    record(v.prongs) &&
    keys.every((k) => raw((v.prongs as Record<string, unknown>)[k])) &&
    Object.hasOwn(v, 'runtimeIdentities') &&
    Object.hasOwn(v, 'limitParameters')
  )
}
function runtimeEvidence(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (id) =>
        record(id) &&
        typeof id.address === 'string' &&
        ADDRESS.test(id.address) &&
        typeof id.codeHash === 'string' &&
        HASH.test(id.codeHash),
    )
  )
}
function parameterEvidence(v: unknown): boolean {
  return (
    record(v) &&
    Object.keys(v).length > 0 &&
    Object.values(v).every(
      (value) =>
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isSafeInteger(value)) ||
        (typeof value === 'string' &&
          !!value &&
          !['unknown', 'unavailable', 'not_read'].includes(value)),
    )
  )
}
function requireValue(ok: unknown) {
  if (!ok) throw new Error('invalid_projection_input')
}
const floor = (v: bigint) => (v > 0n ? v : 0n)
function quote(prongs: ProtocolProngs, adapter: ProtocolProjectionInput['adapter']) {
  const cash = BigInt(prongs.sharedCashRaw),
    supply = BigInt(
      adapter.supplyView === 'resolver_supply' ? prongs.resolverSupplyRaw : prongs.fTokenSupplyRaw,
    ),
    unlocked = floor(supply - BigInt(prongs.minimumRemainingSupplyRaw))
  return adapter.rule === 'shared_cash'
    ? cash
    : adapter.rule === 'reported_supply_less_remaining_limit'
      ? unlocked
      : cash < unlocked
        ? cash
        : unlocked
}
function summary(values: bigint[]) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    n = values.length
  return {
    mean: { numeratorRaw: values.reduce((a, b) => a + b, 0n).toString(), denominator: n },
    p10Raw: sorted[Math.floor((n - 1) / 10)].toString(),
    p90Raw: sorted[Math.ceil(((n - 1) * 9) / 10)].toString(),
  }
}
function runs(points: ProtocolProjectedPoint[], gaps: number[]): ProtocolShortfallRun[] {
  const result: ProtocolShortfallRun[] = []
  for (let i = 0; i < points.length; i++) {
    if (BigInt(points[i].requestedHeadroomRaw) >= 0n) continue
    const first = i
    while (
      i + 1 < points.length &&
      BigInt(points[i + 1].requestedHeadroomRaw) < 0n &&
      !gaps.includes(i)
    )
      i++
    const last = i
    result.push({
      firstBelowIndex: first,
      lastBelowIndex: last,
      onset:
        first && !gaps.includes(first - 1)
          ? {
              lowerSeconds: points[first - 1].elapsedSeconds,
              upperSeconds: points[first].elapsedSeconds,
            }
          : null,
      recovery:
        last + 1 < points.length && !gaps.includes(last)
          ? {
              lowerSeconds: points[last].elapsedSeconds,
              upperSeconds: points[last + 1].elapsedSeconds,
            }
          : null,
      leftCensored: first === 0 || gaps.includes(first - 1),
      rightCensored: last === points.length - 1 || gaps.includes(last),
    })
  }
  return result
}

export function buildConditionalProtocolCapacityProjection(
  input: ProtocolProjectionInput,
): ConditionalProtocolCapacityProjection | null {
  try {
    requireValue(
      record(input) &&
        identity(input.identity) &&
        observation(input.current) &&
        utc(input.current.readAtUtc) &&
        ['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(
          input.current.sourceKind,
        ) &&
        raw(input.requestedRaw) &&
        BigInt(input.requestedRaw) > 0n &&
        ((input.scope === 'protocol' &&
          (input.holderEntitlementRaw === null || input.holderEntitlementRaw === undefined)) ||
          (input.scope === 'existing_holder' && raw(input.holderEntitlementRaw))) &&
        Number.isSafeInteger(input.asOfMs),
    )
    requireValue(
      record(input.adapter) &&
        [
          'shared_cash_supply_less_remaining_limit',
          'shared_cash',
          'reported_supply_less_remaining_limit',
        ].includes(input.adapter.rule) &&
        ['resolver_supply', 'fToken_reported_supply'].includes(input.adapter.supplyView),
    )
    const currentAt = Date.parse(input.current.source.blockTime),
      readAt = Date.parse(input.current.readAtUtc)
    requireValue(
      currentAt <= readAt &&
        readAt <= input.asOfMs &&
        input.asOfMs - currentAt <= CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000,
    )
    requireValue(
      Array.isArray(input.episodes) &&
        input.episodes.length > 0 &&
        input.episodes.length <= 256 &&
        new Set(input.episodes.map((e) => e.id)).size === input.episodes.length,
    )
    requireValue(
      new Set(input.episodes.map((e) => e.observations.map((p) => p.source.blockHash).join(':')))
        .size === input.episodes.length,
    )
    const scenarios = input.episodes.map((episode) => {
      requireValue(
        record(episode) &&
          typeof episode.id === 'string' &&
          !!episode.id &&
          SHA.test(episode.historySha256) &&
          identity(episode.identity) &&
          same(episode.identity, input.identity) &&
          utc(episode.knowledgeCutoffAt) &&
          Date.parse(episode.knowledgeCutoffAt) <= input.asOfMs &&
          Array.isArray(episode.observations) &&
          episode.observations.length >= 2 &&
          episode.observations.length <= 8,
      )
      requireValue(
        Array.isArray(episode.gapAfterIndices) &&
          new Set(episode.gapAfterIndices).size === episode.gapAfterIndices.length &&
          episode.gapAfterIndices.every(
            (i) => Number.isInteger(i) && i >= 0 && i < episode.observations.length - 1,
          ),
      )
      const observations = episode.observations
      requireValue(
        observations.every(
          (point, i) =>
            observation(point) &&
            Date.parse(point.source.blockTime) <= currentAt &&
            point.source.blockNumber <= input.current.source.blockNumber &&
            (point.source.blockNumber !== input.current.source.blockNumber ||
              (point.source.blockHash === input.current.source.blockHash &&
                point.source.blockTime === input.current.source.blockTime)) &&
            Date.parse(point.source.blockTime) <= Date.parse(episode.knowledgeCutoffAt) &&
            (!i ||
              (point.source.blockNumber > observations[i - 1].source.blockNumber &&
                Date.parse(point.source.blockTime) >
                  Date.parse(observations[i - 1].source.blockTime))),
        ),
      )
      const baseline = observations[0],
        baseAt = Date.parse(baseline.source.blockTime)
      const points = observations.map((point, observationIndex) => {
        const elapsedSeconds = (Date.parse(point.source.blockTime) - baseAt) / 1000,
          targetMs = currentAt + elapsedSeconds * 1000
        requireValue(!observationIndex || targetMs > input.asOfMs)
        const prongs = Object.fromEntries(
          keys.map((k) => [
            k,
            floor(
              BigInt(input.current.prongs[k]) +
                BigInt(point.prongs[k]) -
                BigInt(baseline.prongs[k]),
            ).toString(),
          ]),
        ) as ProtocolProngs
        requireValue(keys.every((k) => raw(prongs[k])))
        const reported = quote(prongs, input.adapter),
          afterClip =
            input.holderEntitlementRaw == null
              ? reported
              : reported < BigInt(input.holderEntitlementRaw)
                ? reported
                : BigInt(input.holderEntitlementRaw)
        return {
          observationIndex,
          elapsedSeconds,
          targetAt: observationIndex ? new Date(targetMs).toISOString() : null,
          prongs,
          reportedProngQuoteRaw: reported.toString(),
          afterHolderClipRaw: afterClip.toString(),
          requestedHeadroomRaw: (afterClip - BigInt(input.requestedRaw)).toString(),
        }
      })
      let troughIndex = 0
      points.forEach((point, i) => {
        if (BigInt(point.afterHolderClipRaw) < BigInt(points[troughIndex].afterHolderClipRaw))
          troughIndex = i
      })
      return {
        id: episode.id,
        historySha256: episode.historySha256,
        points,
        troughIndex,
        sampledBelowRequestedRuns: runs(points, episode.gapAfterIndices),
        regime: {
          observedRuntimeIdentitiesMatch:
            runtimeEvidence(input.current.runtimeIdentities) &&
            observations.every(
              (p) =>
                runtimeEvidence(p.runtimeIdentities) &&
                same(p.runtimeIdentities, input.current.runtimeIdentities),
            ),
          observedParametersMatch:
            parameterEvidence(input.current.limitParameters) &&
            observations.every(
              (p) =>
                parameterEvidence(p.limitParameters) &&
                same(p.limitParameters, input.current.limitParameters),
            ),
          proxyImplementationContinuity: 'unknown' as const,
          sourceEquivalence: 'unverified' as const,
        },
      }
    })
    const horizons = Array.from(
      { length: Math.max(...scenarios.map((s) => s.points.length)) - 1 },
      (_, i) => {
        const observationIndex = i + 1,
          points = scenarios.flatMap((s) =>
            s.points[observationIndex] ? [s.points[observationIndex]] : [],
          ),
          elapsed = points.map((p) => p.elapsedSeconds),
          targets = points.map((p) => p.targetAt!).sort()
        return {
          observationIndex,
          elapsedSeconds: { lower: Math.min(...elapsed), upper: Math.max(...elapsed) },
          target: { earliestAt: targets[0], latestAt: targets.at(-1)! },
          reportedQuote: summary(points.map((p) => BigInt(p.reportedProngQuoteRaw))),
          requestedHeadroom: summary(points.map((p) => BigInt(p.requestedHeadroomRaw))),
          episodeCount: points.length,
        }
      },
    )
    return {
      status: 'conditional_reported_protocol_prong_projection',
      input: structuredClone(input),
      issuedAt: new Date(input.asOfMs).toISOString(),
      scenarios,
      horizons,
      assumption:
        'repeat_joint_historical_prong_changes_and_unchanged_holder_entitlement_under_selected_reported_rule',
      cashBelowRequestedImpliesHolderFailure: false,
      executableMaximum: false,
      holderExecutableExit: false,
      futureSuccess: false,
      forwardProbability: false,
      calibrated: false,
      grossFlowAdded: false,
      pause: 'unknown',
      authority: 'unknown',
      hypotheticalDepositCapacity: 'unknown',
      inFlightFlows: 'unknown',
      holderEntitlementAssumption:
        input.scope === 'existing_holder'
          ? 'fixed_entitlement_no_new_earnings_or_position_changes'
          : null,
    }
  } catch {
    return null
  }
}

// acceptPinnedHistory must compare the full episode against independently pinned
// history evidence; accepting its self-declared digest alone is insufficient.
export function selectedConditionalProtocolCapacityProjection(
  value: unknown,
  expected: {
    identity: ProtocolIdentity
    current: ProtocolProjectionInput['current']
    requestedRaw: string
    scope: 'protocol' | 'existing_holder'
    holderEntitlementRaw?: string | null
    adapter: ProtocolProjectionInput['adapter']
    asOfMs: number
  },
  acceptPinnedHistory: (sha256: string, episode: ProtocolEpisode) => boolean,
): ConditionalProtocolCapacityProjection | null {
  try {
    if (!record(value) || !record(value.input)) return null
    const input = value.input as unknown as ProtocolProjectionInput
    if (
      !same(input.identity, expected.identity) ||
      !same(input.current, expected.current) ||
      input.requestedRaw !== expected.requestedRaw ||
      input.scope !== expected.scope ||
      input.holderEntitlementRaw !== expected.holderEntitlementRaw ||
      !same(input.adapter, expected.adapter) ||
      input.asOfMs > expected.asOfMs ||
      !Array.isArray(input.episodes) ||
      !input.episodes.every((e) => acceptPinnedHistory(e.historySha256, e))
    )
      return null
    const result = buildConditionalProtocolCapacityProjection(input)
    if (
      !result ||
      !same(result, value) ||
      !buildConditionalProtocolCapacityProjection({ ...input, asOfMs: expected.asOfMs })
    )
      return null
    return result
  } catch {
    return null
  }
}
