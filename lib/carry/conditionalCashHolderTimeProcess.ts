import {
  buildConditionalTimeProcess,
  selectedConditionalTimeProcess,
  type ConditionalTimeProcessInput,
} from '../venueForecast/conditionalTimeProcess'
import {
  registeredConditionalSampledCashIdentity,
  selectedConditionalSampledCashPathProjection,
  type ConditionalSampledCashCurrentSource,
} from './conditionalSampledCashPathProjection'
import { selectedHolderExitCapacity, type HolderExitCapacityBinding } from './holderExitCapacity'
import { selectedCometWithdrawFacts } from './cometHolderCapacityProjection'
import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'

const MARKETS = Object.freeze(
  Object.values(DIRECT_SUPPLY_MARKETS).map((m) => Object.freeze({ ...m })),
)
const COMET_ROUTE = DIRECT_SUPPLY_MARKETS.compoundV3Usdc.routeKey

export type CashHolderTimeProcessInput = {
  cashProjection: unknown
  capacityAgreement: unknown
  cometFactsAgreement?: unknown
  currentSource: ConditionalSampledCashCurrentSource
  binding: HolderExitCapacityBinding
  horizonHours: number
  asOfMs: number
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
function exact(a: unknown, b: unknown): boolean {
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
function prepare(input: CashHolderTimeProcessInput, at: number, hash: (s: string) => string) {
  const s = input.currentSource,
    b = input.binding
  if (!record(s) || !record(b) || b.asOfMs !== input.asOfMs || !Number.isSafeInteger(at))
    return null
  const identity = registeredConditionalSampledCashIdentity(s.routeKey, s.destination)
  const market = MARKETS.find(
    (m) => m.routeKey === s.routeKey && m.destination.toLowerCase() === s.destination,
  )
  if (
    !identity ||
    !market ||
    market.underlying.toLowerCase() !== s.asset ||
    market.decimals !== s.assetDecimals ||
    !exact(identity, {
      routeKey: s.routeKey,
      destination: s.destination,
      asset: s.asset,
      assetDecimals: s.assetDecimals,
    }) ||
    typeof s.block !== 'string' ||
    !/^[1-9][0-9]*$/.test(s.block) ||
    !Number.isSafeInteger(Number(s.block)) ||
    b.routeKey !== s.routeKey ||
    b.destination !== s.destination ||
    b.asset !== s.asset ||
    b.assetDecimals !== s.assetDecimals ||
    !exact(b.currentSource, {
      chainId: 1,
      blockNumber: Number(s.block),
      blockHash: s.blockHash,
      blockTime: s.blockTime,
      finalized: true,
    })
  )
    return null
  const cash = selectedConditionalSampledCashPathProjection(
    input.cashProjection,
    { identity, requestedRaw: b.requestedRaw, currentSource: s, asOfMs: at },
    hash,
  )
  const capacity = selectedHolderExitCapacity(input.capacityAgreement, { ...b, asOfMs: at })
  if (
    !cash ||
    !capacity ||
    capacity.quote.entitlementMethod !== 'supplied_balance' ||
    capacity.quote.entitlementRaw === null
  )
    return null
  const comet = market.routeKey === COMET_ROUTE
  const facts = comet
    ? selectedCometWithdrawFacts(input.cometFactsAgreement, {
        ...identity,
        source: b.currentSource,
        asOfMs: at,
      })
    : null
  return { cash, capacity, paused: facts?.facts.withdrawalsPaused ?? null }
}
/** A conditional constant-rate process for native cash-backed direct-supply exits only. */
export function buildConditionalCashHolderTimeProcess(
  input: CashHolderTimeProcessInput,
  hash: (s: string) => string,
) {
  try {
    // Freeze the approved snapshot before any externally supplied hash/qualifier callback.
    input = structuredClone(input)
    if (!record(input) || !Number.isSafeInteger(input.asOfMs)) return null
    const approved = prepare(input, input.asOfMs, hash)
    if (!approved) return null
    const s = input.currentSource,
      cash = approved.cash
    const channels: ConditionalTimeProcessInput['channels'] = [
      {
        key: 'cash',
        assetAddress: s.asset,
        decimals: s.assetDecimals,
        unit: 'native_underlying_cash',
        negativeHandling: 'clamp_zero',
      },
    ]
    const regime = s.routeKey + ':' + s.destination
    const processInput: ConditionalTimeProcessInput = {
      channels,
      observations: cash.history.points.map((p) => ({
        sourceAtUtc: p[3],
        availableAtUtc: cash.history.witness.availableAt,
        regime,
        channels: structuredClone(channels),
        valuesByChannel: { cash: p[4] },
        provenanceRef: p[1] + ':' + p[2],
      })),
      outputAsset: { assetAddress: s.asset, decimals: s.assetDecimals },
      measurementRule: 'cash_clipped_by_qualified_full_entitlement_held_constant',
      current: {
        sourceAtUtc: s.blockTime,
        readAtUtc: s.readAt,
        regime,
        valuesByChannel: { cash: s.cashRaw },
        provenanceRef: s.block + ':' + s.blockHash,
        fullEntitlementRaw: approved.capacity.quote.entitlementRaw!,
      },
      issueAtUtc: new Date(input.asOfMs).toISOString(),
      requestedRaw: input.binding.requestedRaw,
      horizonHours: input.horizonHours,
      maxHistoricalGapSeconds: 91800,
    }
    const privateApproved = structuredClone(processInput)
    const qualify = (value: ConditionalTimeProcessInput) => exact(value, privateApproved)
    const measure =
      approved.paused === true
        ? () => ({ availableRaw: '0', entitlementRaw: approved.capacity.quote.entitlementRaw })
        : undefined
    const process = buildConditionalTimeProcess(processInput, qualify, measure)
    if (!process) return null
    return {
      status: 'conditional_cash_holder_time_process' as const,
      input,
      owner: input.binding.owner,
      fullEntitlementRaw: approved.capacity.quote.entitlementRaw,
      withdrawalsPaused: approved.paused,
      eligibility:
        'conditional_unchanged_holder_authority_protocol_pause_and_token_transfer_rules' as const,
      process,
      forecastValidated: false as const,
      holderExecutableExit: false as const,
      minedPayout: false as const,
      calibratedProbability: false as const,
    }
  } catch {
    return null
  }
}
export function selectedConditionalCashHolderTimeProcess(
  value: unknown,
  expected: { input: CashHolderTimeProcessInput; asOfMs: number },
  hash: (s: string) => string,
) {
  try {
    const v = structuredClone(value),
      e = structuredClone(expected)
    const rebuilt = buildConditionalCashHolderTimeProcess(e.input, hash)
    if (!rebuilt || !exact(v, rebuilt) || !prepare(e.input, e.asOfMs, hash)) return null
    const privateApproved = structuredClone(rebuilt.process.input)
    const process = selectedConditionalTimeProcess(
      rebuilt.process,
      { input: privateApproved, asOfMs: e.asOfMs },
      (x) => exact(x, privateApproved),
      rebuilt.withdrawalsPaused === true
        ? () => ({ availableRaw: '0', entitlementRaw: rebuilt.fullEntitlementRaw })
        : undefined,
    )
    return process ? rebuilt : null
  } catch {
    return null
  }
}
