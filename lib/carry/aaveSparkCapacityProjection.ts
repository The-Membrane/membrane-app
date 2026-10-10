import type { DirectSupplyReserveFacts } from './directSupplyExitQuote'
import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'
import { selectedHolderExitCapacity, type HolderExitCapacityBinding } from './holderExitCapacity'
import {
  selectedConditionalGrossFlowHeadroom,
  type ConditionalGrossFlowCurrentSource,
} from './conditionalGrossFlowHeadroom'
import { selectedConditionalSampledCashPathProjection } from './conditionalSampledCashPathProjection'

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const exact = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
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
const poolFor = (route: string) =>
  route === DIRECT_SUPPLY_MARKETS.sparkLendUsdt.routeKey
    ? '0xc13e21b648a5ee794902342038ff3adab66be987'
    : '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
export type AaveSparkCapacitySource = ConditionalGrossFlowCurrentSource & {
  sourceKind: 'manifest_bound_ledger' | 'live_read_only_two_origin_finalized'
  manifestSha256?: string
  receiptSha256?: string
}
export type AaveSparkReserveAgreement = {
  origins: [
    { host: string; facts: DirectSupplyReserveFacts },
    { host: string; facts: DirectSupplyReserveFacts },
  ]
}
export type AaveSparkCapacityInput = {
  currentSource: AaveSparkCapacitySource
  requestedRaw: string
  horizonHours: number
  asOfMs: number
  reserveAgreement: AaveSparkReserveAgreement | null
  pathEvidence: { kind: 'aave_joint_windows' | 'sampled_daily_paths'; value: unknown }
  holder?: { capacityAgreement: unknown; binding: HolderExitCapacityBinding }
}
function validReserve(
  value: unknown,
  s: AaveSparkCapacitySource,
): value is AaveSparkReserveAgreement {
  if (!record(value) || !Array.isArray(value.origins) || value.origins.length !== 2) return false
  const hosts = new Set<string>()
  for (const o of value.origins) {
    if (
      !record(o) ||
      typeof o.host !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(o.host) ||
      hosts.has(o.host)
    )
      return false
    hosts.add(o.host)
    const f = o.facts
    if (
      !record(f) ||
      f.status !== 'reserve_getter_observed' ||
      f.pool !== poolFor(s.routeKey) ||
      f.aToken !== s.destination ||
      f.asset !== s.asset ||
      f.assetDecimals !== s.assetDecimals ||
      f.restrictionInterpretation !== 'unverified' ||
      f.active !== null ||
      f.withdrawalsPaused !== null ||
      !exact(f.source, {
        chainId: 1,
        blockNumber: s.blockNumber,
        blockHash: s.blockHash,
        blockTime: s.blockTime,
        finalized: true,
      })
    )
      return false
    for (const [k, bits] of [
      ['configurationRaw', 256],
      ['liquidityIndexRaw', 128],
      ['variableBorrowIndexRaw', 128],
      ['reserveLastUpdateTimestampRaw', 40],
      ['unbackedRaw', 128],
    ] as const) {
      const n = f[k]
      if (n !== null && (!raw(n) || BigInt(n) >= 1n << BigInt(bits))) return false
    }
  }
  return exact(value.origins[0].facts, value.origins[1].facts)
}
function distribution(values: bigint[]) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    sum = values.reduce((a, b) => a + b, 0n),
    n = BigInt(values.length)
  return {
    minimumRaw: sorted[0].toString(),
    maximumRaw: sorted.at(-1)!.toString(),
    p10Raw: sorted[Math.floor((values.length - 1) * 0.1)].toString(),
    p90Raw: sorted[Math.floor((values.length - 1) * 0.9)].toString(),
    mean: {
      numeratorRaw: sum.toString(),
      denominator: values.length,
      floorRaw: (sum / n - (sum < 0n && sum % n !== 0n ? 1n : 0n)).toString(),
    },
  }
}
/** Reuses individually verified native paths; no marginal-band combination or gross-flow addition. */
export function buildAaveSparkCapacityProjection(
  input: AaveSparkCapacityInput,
  hash: (s: string) => string,
) {
  try {
    const s = input.currentSource
    if (
      !record(s) ||
      s.chainId !== 1 ||
      s.finalized !== true ||
      !Number.isSafeInteger(s.blockNumber) ||
      s.blockNumber <= 0 ||
      typeof s.blockHash !== 'string' ||
      !/^0x[0-9a-f]{64}$/.test(s.blockHash) ||
      !raw(s.cashRaw) ||
      !utc(s.blockTime) ||
      !utc(s.readAt) ||
      !Number.isSafeInteger(input.asOfMs) ||
      Date.parse(s.blockTime) > Date.parse(s.readAt) ||
      Date.parse(s.readAt) > input.asOfMs ||
      input.asOfMs - Date.parse(s.blockTime) > 1800000 ||
      !raw(input.requestedRaw) ||
      input.requestedRaw === '0' ||
      !Number.isSafeInteger(input.horizonHours) ||
      input.horizonHours < 1 ||
      input.horizonHours > 8760
    )
      return null
    const market = Object.entries(DIRECT_SUPPLY_MARKETS).find(
      ([key, m]) =>
        key !== 'compoundV3Usdc' &&
        m.routeKey === s.routeKey &&
        m.destination.toLowerCase() === s.destination &&
        m.underlying.toLowerCase() === s.asset &&
        m.decimals === s.assetDecimals,
    )
    if (
      !market ||
      !['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(s.sourceKind)
    )
      return null
    if (input.reserveAgreement !== null && !validReserve(input.reserveAgreement, s)) return null
    let entitlement: bigint | null = null
    if (input.holder) {
      const b = input.holder.binding
      if (
        b.routeKey !== s.routeKey ||
        b.destination !== s.destination ||
        b.asset !== s.asset ||
        b.assetDecimals !== s.assetDecimals ||
        b.requestedRaw !== input.requestedRaw ||
        b.asOfMs !== input.asOfMs ||
        !exact(b.currentSource, {
          chainId: 1,
          blockNumber: s.blockNumber,
          blockHash: s.blockHash,
          blockTime: s.blockTime,
          finalized: true,
        })
      )
        return null
      const selected = selectedHolderExitCapacity(input.holder.capacityAgreement, b)
      if (!selected || selected.quote.entitlementRaw === null) return null
      entitlement = BigInt(selected.quote.entitlementRaw)
    }
    let paths: {
      id: number
      capacityRaw: string[]
      targets: { earliestAt: string; latestAt: string }[]
    }[]
    if (input.pathEvidence.kind === 'aave_joint_windows') {
      if (
        market[0] !== 'aaveV3Usdc' ||
        s.sourceKind !== 'live_read_only_two_origin_finalized' ||
        !record(input.pathEvidence.value) ||
        !record(input.pathEvidence.value.request) ||
        !utc(input.pathEvidence.value.request.asOf) ||
        Date.parse(input.pathEvidence.value.request.asOf) > input.asOfMs
      )
        return null
      const { sourceKind: _kind, manifestSha256: _manifest, receiptSha256: _receipt, ...source } = s
      const p = selectedConditionalGrossFlowHeadroom(
        input.pathEvidence.value,
        {
          currentSource: source,
          request: {
            requestedRaw: input.requestedRaw,
            asOf: input.pathEvidence.value.request.asOf,
          },
        },
        hash,
      )
      if (!p || Date.parse(p.target.earliestAt) <= input.asOfMs) return null
      paths = p.scenarios.map((path, id) => ({
        id,
        capacityRaw: [path.capacityRaw],
        targets: [{ earliestAt: p.target.earliestAt, latestAt: p.target.latestAt }],
      }))
    } else if (input.pathEvidence.kind === 'sampled_daily_paths') {
      const p = selectedConditionalSampledCashPathProjection(
        input.pathEvidence.value,
        {
          identity: {
            routeKey: s.routeKey,
            destination: s.destination,
            asset: s.asset,
            assetDecimals: s.assetDecimals,
          },
          requestedRaw: input.requestedRaw,
          asOfMs: input.asOfMs,
          currentSource: {
            chainId: 1,
            routeKey: s.routeKey,
            destination: s.destination,
            asset: s.asset,
            assetDecimals: s.assetDecimals,
            cashRaw: s.cashRaw,
            block: String(s.blockNumber),
            blockHash: s.blockHash,
            blockTime: s.blockTime,
            readAt: s.readAt,
            sourceKind: s.sourceKind,
            ...(s.sourceKind === 'manifest_bound_ledger'
              ? { manifestSha256: s.manifestSha256, receiptSha256: s.receiptSha256 }
              : {}),
          },
        },
        hash,
      )
      if (!p) return null
      paths = p.scenarios.map((path) => ({
        id: path.episodeIndex,
        capacityRaw: path.capacityRaw.slice(1),
        targets: path.elapsedSeconds.slice(1).map((seconds) => ({
          earliestAt: new Date(Date.parse(s.blockTime) + seconds * 1000).toISOString(),
          latestAt: new Date(Date.parse(s.blockTime) + seconds * 1000).toISOString(),
        })),
      }))
    } else return null
    if (
      !paths.length ||
      !paths[0].targets.length ||
      paths.some(
        (p) =>
          p.targets.length !== paths[0].targets.length || p.capacityRaw.length !== p.targets.length,
      )
    )
      return null
    const q = BigInt(input.requestedRaw)
    const scenarios = paths.map((p) => ({
      ...p,
      capacityRaw: p.capacityRaw.map((c) => {
        if (!raw(c)) throw Error('capacity_invalid')
        const n = BigInt(c)
        return (entitlement === null || n < entitlement ? n : entitlement).toString()
      }),
      headroomRaw: p.capacityRaw.map((c) => {
        const n = BigInt(c)
        return ((entitlement === null || n < entitlement ? n : entitlement) - q).toString()
      }),
    }))
    const horizons = paths[0].targets.map((_, i) => {
      const times = paths.map((p) => p.targets[i])
      const earliest = Math.min(...times.map((t) => Date.parse(t.earliestAt))),
        latest = Math.max(...times.map((t) => Date.parse(t.latestAt)))
      if (earliest <= input.asOfMs) throw Error('past_target')
      return {
        observation: i + 1,
        target: {
          earliestAt: new Date(earliest).toISOString(),
          latestAt: new Date(latest).toISOString(),
          lowerSeconds: (earliest - Date.parse(s.blockTime)) / 1000,
          upperSeconds: (latest - Date.parse(s.blockTime)) / 1000,
        },
        scenarioCount: paths.length,
        capacity: distribution(scenarios.map((p) => BigInt(p.capacityRaw[i]))),
        requestedHeadroom: distribution(scenarios.map((p) => BigInt(p.headroomRaw[i]))),
      }
    })
    return {
      status: 'conditional_aave_spark_capacity_projection' as const,
      input: structuredClone(input),
      scope: input.holder
        ? ('entitlement_clipped_conditional_scenario' as const)
        : ('protocol_reserve_liquidity_scenario' as const),
      method: 'per_verified_path_native_capacity_then_entitlement_clip_then_q_once' as const,
      horizons,
      scenarios,
      restrictions: input.reserveAgreement
        ? ('reported_configuration_interpretation_unverified' as const)
        : ('reserve_restrictions_unmeasured' as const),
      versionEquivalence: 'unverified' as const,
      assumption:
        'repeat_historical_net_reserve_paths_with_unchanged_restrictions_and_entitlement' as const,
      holderExecutableExit: false as const,
      executableMaximum: false as const,
      forwardProbability: false as const,
      forecastValidated: false as const,
      prospectiveValidated: false as const,
      minedPayoutObserved: false as const,
      grossFlowAdded: false as const,
    }
  } catch {
    return null
  }
}
export type AaveSparkCapacityProjection = NonNullable<
  ReturnType<typeof buildAaveSparkCapacityProjection>
>
/** Expected source/Q/owner evidence always arrives independently from the result envelope. */
export function selectedAaveSparkCapacityProjection(
  value: unknown,
  expected: AaveSparkCapacityInput,
  hash: (s: string) => string,
) {
  try {
    if (
      !record(value) ||
      !record(value.input) ||
      !Number.isSafeInteger(expected.asOfMs) ||
      (value.input.asOfMs as number) > expected.asOfMs
    )
      return null
    const rebuilt = buildAaveSparkCapacityProjection(expected, hash)
    if (!rebuilt) return null
    const issued = buildAaveSparkCapacityProjection(
      {
        ...expected,
        asOfMs: value.input.asOfMs as number,
        ...(expected.holder
          ? {
              holder: {
                ...expected.holder,
                binding: { ...expected.holder.binding, asOfMs: value.input.asOfMs as number },
              },
            }
          : {}),
      },
      hash,
    )
    return issued && exact(value, issued) ? issued : null
  } catch {
    return null
  }
}
