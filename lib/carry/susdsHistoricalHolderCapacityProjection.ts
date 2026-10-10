// Conditional source rule: https://github.com/sky-ecosystem/sdai/blob/susds/src/SUsds.sol#L313
// Recorded hashes retain an observed regime, not deployed-source equivalence.
import historyData from '@/data/research/venue-signals/susds-pinned-index-history-v1.json'
import { CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS } from './conditionalGrossFlowHeadroom'
import { selectedHolderExitCapacity, type HolderExitCapacityBinding } from './holderExitCapacity'
import type { ConditionalSampledCashDistribution } from './conditionalSampledCashPathProjection'

const MANIFEST_SHA = 'a6e5de4c6f06efc2117e7fd1351a445bff295b5dd49ccc9ee2d312bcd5e151a7'
const ROUTE = 'USDS → SUsds [USDS]'
const VAULT = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'
const ASSET = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
const MAX = (1n << 256n) - 1n
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const exact = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => exact(x, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact(a[k], b[k]))
    )
  return Object.is(a, b)
}
function freeze(v: unknown): void {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
}
freeze(historyData)
export type SusdsPinnedIndexHistory = typeof historyData
export function susdsPinnedIndexHistory(): SusdsPinnedIndexHistory {
  return structuredClone(historyData)
}
export type SusdsHistoricalHolderCapacityInput = {
  history: unknown
  capacityAgreement: unknown
  binding: HolderExitCapacityBinding
  currentSource: HolderExitCapacityBinding['currentSource']
  currentReadAtUtc: string
  horizonHours: number
  asOfMs: number
}
type Hash = (serialized: string) => string
type Bracket = { earliestAt: string; latestAt: string }
type Run = {
  firstBelowObservation: number
  lastBelowObservation: number
  onset: Bracket | null
  recovery: Bracket | null
  leftCensored: boolean
  rightCensored: boolean
  sampledSpanSeconds: number
}
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
function distribution(v: bigint[]): ConditionalSampledCashDistribution {
  const sorted = [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    sum = v.reduce((a, b) => a + b, 0n),
    n = BigInt(v.length)
  return {
    mean: {
      numeratorRaw: String(sum),
      denominator: v.length,
      floorRaw: String(sum / n - (sum < 0n && sum % n !== 0n ? 1n : 0n)),
    },
    p10Raw: String(sorted[Math.floor((v.length - 1) * 0.1)]),
    p90Raw: String(sorted[Math.floor((v.length - 1) * 0.9)]),
    minimumRaw: String(sorted[0]),
    maximumRaw: String(sorted.at(-1)!),
  }
}
function runs(m: bigint[], elapsed: number, sourceAt: number): Run[] {
  const times = [
      new Date(sourceAt).toISOString(),
      new Date(sourceAt + elapsed * 1000).toISOString(),
    ],
    out: Run[] = []
  for (let i = 0; i < 2; i++) {
    if (m[i] >= 0n) continue
    const first = i
    while (i + 1 < 2 && m[i + 1] < 0n) i++
    out.push({
      firstBelowObservation: first,
      lastBelowObservation: i,
      onset: first === 0 ? null : { earliestAt: times[0], latestAt: times[1] },
      recovery: i === 1 ? null : { earliestAt: times[0], latestAt: times[1] },
      leftCensored: first === 0,
      rightCensored: i === 1,
      sampledSpanSeconds: i === first ? 0 : elapsed,
    })
  }
  return out
}
function verifiedHistory(value: unknown, hash: Hash): SusdsPinnedIndexHistory | null {
  if (!exact(value, historyData) || hash(JSON.stringify(value)) !== MANIFEST_SHA) return null
  for (const item of historyData.checkpoints) {
    const { sha256, ...body } = item.checkpoint
    if (
      hash(JSON.stringify(body)) !== item.bodySha256 ||
      sha256 !== item.bodySha256 ||
      hash(JSON.stringify(item.checkpoint) + '\n') !== item.fileSha256
    )
      return null
  }
  return historyData
}
export function buildSusdsHistoricalHolderCapacityProjection(
  input: SusdsHistoricalHolderCapacityInput,
  hash: Hash,
) {
  try {
    if (
      !record(input) ||
      !record(input.binding) ||
      !record(input.currentSource) ||
      !Number.isSafeInteger(input.asOfMs) ||
      !Number.isSafeInteger(input.horizonHours) ||
      input.horizonHours < 1 ||
      input.horizonHours > 8760 ||
      !utc(input.currentReadAtUtc)
    )
      return null
    const b = input.binding,
      s = input.currentSource
    if (
      b.routeKey !== ROUTE ||
      b.destination !== VAULT ||
      b.asset !== ASSET ||
      b.assetDecimals !== 18 ||
      b.asOfMs !== input.asOfMs ||
      !exact(b.currentSource, s) ||
      !raw(b.requestedRaw) ||
      BigInt(b.requestedRaw) === 0n ||
      !utc(s.blockTime) ||
      Date.parse(s.blockTime) > Date.parse(input.currentReadAtUtc) ||
      Date.parse(input.currentReadAtUtc) > input.asOfMs ||
      input.asOfMs - Date.parse(s.blockTime) > CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000
    )
      return null
    const history = verifiedHistory(input.history, hash),
      capacity = selectedHolderExitCapacity(input.capacityAgreement, b)
    if (
      !history ||
      !capacity ||
      capacity.quote.entitlementMethod !== 'preview_redeem_full_position' ||
      !raw(capacity.quote.entitlementRaw)
    )
      return null
    const E = BigInt(capacity.quote.entitlementRaw),
      Q = BigInt(b.requestedRaw),
      sourceAt = Date.parse(s.blockTime)
    if (
      history.checkpoints.some(
        (x) =>
          x.checkpoint.block.number >= s.blockNumber ||
          x.checkpoint.block.timestamp * 1000 >= sourceAt ||
          Date.parse(x.checkpoint.captureEndUtc) > input.asOfMs,
      )
    )
      return null
    const episodes = history.checkpoints.slice(1).map((item, i) => {
      const before = history.checkpoints[i].checkpoint,
        after = item.checkpoint,
        elapsed = after.block.timestamp - before.block.timestamp
      if (
        !raw(before.state.assetsPerShareRaw) ||
        !raw(after.state.assetsPerShareRaw) ||
        elapsed <= 0
      )
        throw Error('index')
      const Pb = BigInt(before.state.assetsPerShareRaw),
        Pt = BigInt(after.state.assetsPerShareRaw)
      if (Pb === 0n || Pt === 0n) throw Error('zero index')
      // PPS and previewRedeem are floored integers. Bound the underlying index ratio rather than inventing chi precision.
      const lower = (E * Pt) / (Pb + 1n),
        numerator = (E + 1n) * (Pt + 1n),
        upper = (numerator + Pb - 1n) / Pb - 1n
      if (lower > MAX || upper > MAX || lower > upper) throw Error('entitlement overflow')
      const targetAt = new Date(sourceAt + elapsed * 1000).toISOString(),
        lo = [E, lower],
        hi = [E, upper]
      const regimeMatches = exact(before.contract, after.contract)
      return {
        episodeIndex: i,
        baseline: {
          blockNumber: before.block.number,
          blockHash: before.block.hash,
          blockTime: new Date(before.block.timestamp * 1000).toISOString(),
          fileSha256: history.checkpoints[i].fileSha256,
        },
        endpoint: {
          blockNumber: after.block.number,
          blockHash: after.block.hash,
          blockTime: new Date(after.block.timestamp * 1000).toISOString(),
          fileSha256: item.fileSha256,
        },
        elapsedSeconds: elapsed,
        targetAt,
        targetState:
          Date.parse(targetAt) > input.asOfMs
            ? ('future' as const)
            : ('target_already_elapsed' as const),
        observedRegimeMatches: regimeMatches,
        sourceRegimeGap: !regimeMatches,
        baselinePpsRaw: String(Pb),
        endpointPpsRaw: String(Pt),
        entitlementLowerRaw: lo.map(String),
        entitlementUpperRaw: hi.map(String),
        headroomLowerRaw: lo.map((x) => String(x - Q)),
        headroomUpperRaw: hi.map((x) => String(x - Q)),
        lowerTroughObservation: lower < E ? 1 : 0,
        upperTroughObservation: upper < E ? 1 : 0,
        possibleSampledShortfalls: runs(
          lo.map((x) => x - Q),
          elapsed,
          sourceAt,
        ),
        definiteSampledShortfalls: runs(
          hi.map((x) => x - Q),
          elapsed,
          sourceAt,
        ),
      }
    })
    const eligible = episodes.filter((e) => e.targetState === 'future' && !e.sourceRegimeGap)
    const groups = [
      ...new Set(episodes.filter((e) => !e.sourceRegimeGap).map((e) => e.elapsedSeconds)),
    ]
      .sort((a, b) => a - b)
      .map((elapsed) => {
        const es = episodes.filter((e) => !e.sourceRegimeGap && e.elapsedSeconds === elapsed)
        return {
          elapsedSeconds: elapsed,
          targetAt: es[0].targetAt,
          episodeCount: es.length,
          entitlementLower: distribution(es.map((e) => BigInt(e.entitlementLowerRaw[1]))),
          entitlementUpper: distribution(es.map((e) => BigInt(e.entitlementUpperRaw[1]))),
          headroomLower: distribution(es.map((e) => BigInt(e.headroomLowerRaw[1]))),
          headroomUpper: distribution(es.map((e) => BigInt(e.headroomUpperRaw[1]))),
        }
      })
    return {
      status: 'conditional_susds_historical_holder_capacity_projection' as const,
      input: structuredClone(input),
      owner: capacity.quote.owner,
      request: {
        requestedRaw: b.requestedRaw,
        horizonHours: input.horizonHours,
        asOf: new Date(input.asOfMs).toISOString(),
      },
      currentEntitlementRaw: String(E),
      currentQuotedMaxWithdrawRaw: capacity.quote.quotedMaxWithdrawRaw,
      currentSource: structuredClone(s),
      currentReadAtUtc: input.currentReadAtUtc,
      evidence: {
        manifestSha256: MANIFEST_SHA,
        evidenceTier: history.evidenceTier,
        checkpointCount: 29,
        pairedEpisodeCount: 28,
        observedRegimeCount: 1,
        knowledgeCutoff: new Date(
          Math.max(...history.checkpoints.map((x) => Date.parse(x.checkpoint.captureEndUtc))),
        ).toISOString(),
      },
      scope: 'conditional_full_position_entitlement_from_own_share_index' as const,
      method: 'pps_floor_ratio_bounds_then_native_q_once' as const,
      assumption:
        'repeat_own_index_changes_with_unchanged_holdings_redemption_mint_and_principal_rules' as const,
      rounding: 'conservative_interval_without_observed_chi' as const,
      episodes,
      groups,
      counts: {
        pairedEpisodes: 28,
        eligibleFutureEpisodes: eligible.length,
        elapsedTargetCensored: episodes.filter((e) => e.targetState !== 'future').length,
        regimeGapCensored: episodes.filter((e) => e.sourceRegimeGap).length,
      },
      continuousPathKnown: false as const,
      independentScenarioTrials: false as const,
      withdrawalEligibility: 'conditional_unchanged_redemption_mint_rules' as const,
      holderExecutableExit: false as const,
      executableMaximum: false as const,
      minedPayoutObserved: false as const,
      forwardProbability: false as const,
      forecastValidated: false as const,
      prospectiveValidated: false as const,
      sourceImplementationEquivalence: false as const,
      otherHolderFlowDrawCap: false as const,
    }
  } catch {
    return null
  }
}
export type SusdsHistoricalHolderCapacityProjection = NonNullable<
  ReturnType<typeof buildSusdsHistoricalHolderCapacityProjection>
>
export function selectedSusdsHistoricalHolderCapacityProjection(
  value: unknown,
  expected: SusdsHistoricalHolderCapacityInput,
  hash: Hash,
) {
  try {
    if (
      !record(value) ||
      !record(value.input) ||
      !Number.isSafeInteger(value.input.asOfMs) ||
      !Number.isSafeInteger(expected.asOfMs) ||
      (value.input.asOfMs as number) > expected.asOfMs ||
      !buildSusdsHistoricalHolderCapacityProjection(expected, hash)
    )
      return null
    const issuedAt = value.input.asOfMs as number
    const issued = buildSusdsHistoricalHolderCapacityProjection(
      { ...expected, asOfMs: issuedAt, binding: { ...expected.binding, asOfMs: issuedAt } },
      hash,
    )
    if (!issued || !exact(value, issued)) return null
    const active = issued.episodes.filter(
      (e) => !e.sourceRegimeGap && Date.parse(e.targetAt) > expected.asOfMs,
    )
    return {
      projection: issued,
      view: {
        selectedAtUtc: new Date(expected.asOfMs).toISOString(),
        activeEpisodeIndices: active.map((e) => e.episodeIndex),
        elapsedEpisodeIndices: issued.episodes
          .filter((e) => Date.parse(e.targetAt) <= expected.asOfMs)
          .map((e) => e.episodeIndex),
        groups: issued.groups.filter((g) => Date.parse(g.targetAt) > expected.asOfMs),
      },
    }
  } catch {
    return null
  }
}
