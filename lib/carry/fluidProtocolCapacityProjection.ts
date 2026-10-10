import { selectedHolderExitCapacity, type HolderExitCapacityBinding } from './holderExitCapacity'
import { fluidProtocolHistoryPinForSubject } from './fluidProtocolCapacityHistoryPins'
import {
  selectedFluidExitCapacity,
  isFluidExitCapacitySubject,
  type FluidExitCapacity,
  type FluidCapacitySource,
} from './fluidExitCapacity'
import {
  buildConditionalProtocolCapacityProjection,
  selectedConditionalProtocolCapacityProjection,
  type ConditionalProtocolCapacityProjection,
  type ProtocolEpisode,
  type ProtocolObservation,
} from './conditionalProtocolCapacityProjection'

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
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
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const adapter = {
  rule: 'shared_cash_supply_less_remaining_limit' as const,
  supplyView: 'resolver_supply' as const,
}
export function isFluidProtocolProjectionSubject(value: unknown): boolean {
  return isFluidExitCapacitySubject(value) && !!fluidProtocolHistoryPinForSubject(value)
}
export function fluidProtocolPinnedEpisode(
  hash: (s: string) => string,
  identity: unknown,
): ProtocolEpisode | null {
  try {
    const pin = fluidProtocolHistoryPinForSubject(identity)
    if (!pin) return null
    const pinnedExport = pin.compact
    const { sha256, ...body } = pinnedExport
    if (sha256 !== pin.contentSha256 || hash(JSON.stringify(body)) !== sha256) return null
    const view = (
      prongs: typeof pinnedExport.baselineProngs,
      source: (typeof pinnedExport.sourceEvidence)[number],
      i: number,
    ): ProtocolObservation => ({
      source: {
        chainId: 1,
        blockNumber: source.blockNumber,
        blockHash: source.blockHash,
        blockTime: source.blockTime,
      },
      prongs: {
        sharedCashRaw: prongs.sharedLiquidityCashRaw,
        fTokenSupplyRaw: prongs.fTokenReportedSupplyRaw,
        resolverSupplyRaw: prongs.resolverSupplyRaw,
        minimumRemainingSupplyRaw: prongs.expandedWithdrawalLimitRaw,
      },
      runtimeIdentities: pinnedExport.runtimeIdentities[i],
      limitParameters:
        i === 0 ? pinnedExport.baselineLimitParameters : pinnedExport.targetLimitParameters,
    })
    return structuredClone({
      id: pin.id,
      historySha256: sha256,
      knowledgeCutoffAt: pinnedExport.knowledgeCutoffAt,
      identity: pinnedExport.subject,
      observations: [
        view(pinnedExport.baselineProngs, pinnedExport.sourceEvidence[0], 0),
        view(pinnedExport.targetProngs, pinnedExport.sourceEvidence[1], 1),
      ],
      gapAfterIndices: [],
    })
  } catch {
    return null
  }
}
export type FluidProtocolCapacityHolder = {
  capacityAgreement: unknown
  binding: HolderExitCapacityBinding
}
export type FluidProtocolCapacityProjection = {
  status: 'fluid_protocol_capacity_projection'
  currentProngs: FluidExitCapacity
  currentReadAtUtc: string
  request: { requestedRaw: string; horizonHours: number; asOf: string }
  projection: ConditionalProtocolCapacityProjection
  holder?: FluidProtocolCapacityHolder
  scope?: 'entitlement_clipped_conditional_scenario'
  method?: 'joint_protocol_prongs_then_bound_entitlement_then_q_once'
}
export function buildFluidProtocolCapacityProjection(
  input: {
    currentProngs: unknown
    currentReadAtUtc: string
    requestedRaw: string
    horizonHours: number
    asOfMs: number
    holder?: FluidProtocolCapacityHolder
  },
  hash: (s: string) => string,
): FluidProtocolCapacityProjection | null {
  try {
    if (
      !record(input.currentProngs) ||
      !record(input.currentProngs.source) ||
      !utc(input.currentReadAtUtc) ||
      !Number.isSafeInteger(input.asOfMs) ||
      Date.parse(input.currentReadAtUtc) > input.asOfMs ||
      !Number.isSafeInteger(input.horizonHours) ||
      input.horizonHours <= 0 ||
      input.horizonHours > 8760
    )
      return null
    const c = input.currentProngs as unknown as FluidExitCapacity
    const current = selectedFluidExitCapacity(c, {
      routeKey: c.routeKey,
      destination: c.destination,
      asset: c.asset,
      assetDecimals: c.assetDecimals,
      source: c.source,
    })
    const episode = fluidProtocolPinnedEpisode(hash, current)
    if (
      !current ||
      !episode ||
      !exact(episode.identity, {
        routeKey: c.routeKey,
        destination: c.destination,
        asset: c.asset,
        assetDecimals: c.assetDecimals,
      })
    )
      return null
    const age = input.asOfMs - Date.parse(c.source.blockTime)
    if (
      age < 0 ||
      age > 1800000 ||
      Date.parse(input.currentReadAtUtc) < Date.parse(c.source.blockTime)
    )
      return null
    let entitlement: string | undefined
    if (input.holder !== undefined) {
      if (!record(input.holder) || !record(input.holder.binding)) return null
      const b = input.holder.binding
      if (
        b.routeKey !== c.routeKey ||
        b.destination !== c.destination ||
        b.asset !== c.asset ||
        b.assetDecimals !== c.assetDecimals ||
        b.requestedRaw !== input.requestedRaw ||
        b.asOfMs !== input.asOfMs ||
        !exact(b.currentSource, c.source)
      )
        return null
      const selected = selectedHolderExitCapacity(input.holder.capacityAgreement, b)
      if (!selected || selected.quote.entitlementRaw === null) return null
      entitlement = selected.quote.entitlementRaw
    }
    const { finalized: _finalized, ...source } = c.source
    const projection = buildConditionalProtocolCapacityProjection({
      identity: episode.identity,
      current: {
        source,
        prongs: {
          sharedCashRaw: c.prongs.sharedLiquidityCashRaw,
          fTokenSupplyRaw: c.prongs.fTokenReportedSupplyRaw,
          resolverSupplyRaw: c.prongs.resolverSupplyRaw,
          minimumRemainingSupplyRaw: c.prongs.expandedWithdrawalLimitRaw,
        },
        runtimeIdentities: c.origins[0].identities,
        limitParameters: c.origins[0].limitParameters,
        readAtUtc: input.currentReadAtUtc,
        sourceKind: 'live_read_only_two_origin_finalized',
      },
      adapter,
      scope: entitlement === undefined ? 'protocol' : 'existing_holder',
      ...(entitlement === undefined ? {} : { holderEntitlementRaw: entitlement }),
      requestedRaw: input.requestedRaw,
      episodes: [episode],
      asOfMs: input.asOfMs,
    })
    if (!projection) return null
    return {
      status: 'fluid_protocol_capacity_projection',
      currentProngs: structuredClone(current),
      currentReadAtUtc: input.currentReadAtUtc,
      request: {
        requestedRaw: input.requestedRaw,
        horizonHours: input.horizonHours,
        asOf: new Date(input.asOfMs).toISOString(),
      },
      projection,
      ...(input.holder === undefined
        ? {}
        : {
            holder: structuredClone(input.holder),
            scope: 'entitlement_clipped_conditional_scenario' as const,
            method: 'joint_protocol_prongs_then_bound_entitlement_then_q_once' as const,
          }),
    }
  } catch {
    return null
  }
}
export function selectedFluidProtocolCapacityProjection(
  value: unknown,
  expected: {
    routeKey: string
    destination: string
    asset: string
    assetDecimals: number
    currentSource: FluidCapacitySource
    currentProngs: unknown
    currentReadAtUtc: string
    requestedRaw: string
    horizonHours: number
    asOfMs: number
    holder?: FluidProtocolCapacityHolder
  },
  hash: (s: string) => string,
): FluidProtocolCapacityProjection | null {
  try {
    if (
      !record(value) ||
      !record(value.request) ||
      !utc(value.request.asOf) ||
      !isFluidExitCapacitySubject(expected) ||
      value.request.requestedRaw !== expected.requestedRaw ||
      value.request.horizonHours !== expected.horizonHours ||
      value.currentReadAtUtc !== expected.currentReadAtUtc ||
      Date.parse(value.request.asOf) > expected.asOfMs
    )
      return null
    const current = selectedFluidExitCapacity(expected.currentProngs, {
      ...expected,
      source: expected.currentSource,
    })
    if (!current || !exact(current, value.currentProngs)) return null
    // Revalidate the external entitlement at the render clock before reconstructing
    // the original issued projection. Never use the payload's holder as authority.
    if (
      !buildFluidProtocolCapacityProjection(
        {
          currentProngs: current,
          currentReadAtUtc: expected.currentReadAtUtc,
          requestedRaw: expected.requestedRaw,
          horizonHours: expected.horizonHours,
          asOfMs: expected.asOfMs,
          ...(expected.holder === undefined ? {} : { holder: expected.holder }),
        },
        hash,
      )
    )
      return null
    const rebuilt = buildFluidProtocolCapacityProjection(
      {
        currentProngs: current,
        currentReadAtUtc: value.currentReadAtUtc as string,
        requestedRaw: expected.requestedRaw,
        horizonHours: expected.horizonHours,
        asOfMs: Date.parse(value.request.asOf),
        ...(expected.holder === undefined
          ? {}
          : {
              holder: {
                ...expected.holder,
                binding: { ...expected.holder.binding, asOfMs: Date.parse(value.request.asOf) },
              },
            }),
      },
      hash,
    )
    const episode = fluidProtocolPinnedEpisode(hash, current)
    if (
      !rebuilt ||
      !episode ||
      !exact(value, rebuilt) ||
      !selectedConditionalProtocolCapacityProjection(
        rebuilt.projection,
        {
          identity: rebuilt.projection.input.identity,
          current: rebuilt.projection.input.current,
          requestedRaw: expected.requestedRaw,
          scope: rebuilt.projection.input.scope,
          ...(rebuilt.projection.input.holderEntitlementRaw === undefined
            ? {}
            : {
                holderEntitlementRaw: rebuilt.projection.input.holderEntitlementRaw,
              }),
          adapter,
          asOfMs: expected.asOfMs,
        },
        (sha, e) => sha === episode.historySha256 && exact(e, episode),
      )
    )
      return null
    return rebuilt
  } catch {
    return null
  }
}
