import {
  buildConditionalTimeProcess,
  type ConditionalTimeProcessInput,
} from '../venueForecast/conditionalTimeProcess'
import { selectedHolderExitCapacity, type HolderExitCapacityBinding } from './holderExitCapacity'
import { morphoV2AdapterCapacityMath } from './morphoV2AdapterCapacityMath'

export const MORPHO_V2_PILOT = Object.freeze({
  routeKey: 'USDC → VaultV2 [USDC]',
  destination: '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  assetDecimals: 6,
  shareDecimals: 18,
})
export type MorphoV2ProtocolPoint = {
  source: { chainId: 1; blockNumber: string; blockHash: string; blockTime: string }
  status: 'two_origin_conditional_configured_adapter_prongs'
  prongs: {
    idleCashRaw: string
    blueCashRaw: string
    market: string[]
    internalSharesRaw: string
    actualSharesRaw: string
    allowanceRaw: string
    allocationsRaw: string[]
    borrowRateRaw: string
    feeRecipient: string
  }
}
export type MorphoV2ProtocolEvidence = {
  subject: typeof MORPHO_V2_PILOT
  configured: {
    adapter: string
    morpho: string
    irm: string
    marketId: string
    liquidityData: string
    allocationIds: string[]
  }
  runtimeIdentities: {
    key: string
    codeHash: string
    proxyInspection: string
    implementationAddress: null
    implementationCodeHash: null
  }[]
  sourceImplementationEquivalence: false
  captureReceiptSha256: string
  knowledgeCutoff: string
}
export type MorphoV2HolderTimeProcessInput = {
  history: MorphoV2ProtocolEvidence & {
    history: { points: MorphoV2ProtocolPoint[]; elapsedSeconds: number[] }
  }
  current: MorphoV2ProtocolEvidence & { point: MorphoV2ProtocolPoint; readAtUtc: string }
  capacityAgreement: unknown
  binding: HolderExitCapacityBinding
  horizonHours: number
  asOfMs: number
}
/** Current approval independently replays the complete raw two-origin receipts,
 * exact EIP-1898/header/identity/code/config/units/clock proofs and external source.
 * History may use the reviewed app-shipped immutable dataset only after exact
 * equality to its externally pinned full raw replay frame. An API checksum,
 * payload approval flag, self seal or normalized summary is never approval. */
export type AcceptMorphoV2ProtocolEvidence = (
  kind: 'history' | 'current',
  evidence: MorphoV2HolderTimeProcessInput['history'] | MorphoV2HolderTimeProcessInput['current'],
) => boolean
const MAX = (1n << 256n) - 1n
const ZERO = '0x0000000000000000000000000000000000000000'
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
function exact(a: unknown, b: unknown): boolean {
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
function validPoint(p: MorphoV2ProtocolPoint) {
  const s = p.source,
    g = p.prongs
  return (
    s.chainId === 1 &&
    typeof s.blockNumber === 'string' &&
    /^[1-9][0-9]*$/.test(s.blockNumber) &&
    Number.isSafeInteger(Number(s.blockNumber)) &&
    typeof s.blockHash === 'string' &&
    /^0x[0-9a-f]{64}$/.test(s.blockHash) &&
    utc(s.blockTime) &&
    Date.parse(s.blockTime) % 1000 === 0 &&
    p.status === 'two_origin_conditional_configured_adapter_prongs' &&
    Array.isArray(g.market) &&
    g.market.length === 6 &&
    g.market.every(raw) &&
    g.market[5] === '0' &&
    g.feeRecipient === ZERO &&
    Array.isArray(g.allocationsRaw) &&
    g.allocationsRaw.length === 3 &&
    g.allocationsRaw.every(raw) &&
    [
      g.idleCashRaw,
      g.blueCashRaw,
      g.internalSharesRaw,
      g.actualSharesRaw,
      g.allowanceRaw,
      g.borrowRateRaw,
    ].every(raw)
  )
}
function validEvidence(e: MorphoV2ProtocolEvidence) {
  return (
    exact(e.subject, MORPHO_V2_PILOT) &&
    e.sourceImplementationEquivalence === false &&
    utc(e.knowledgeCutoff) &&
    typeof e.captureReceiptSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(e.captureReceiptSha256) &&
    e.configured.adapter === '0x672a63773db26b7ca9585f0f2b17f8a268687f75' &&
    e.configured.morpho === '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' &&
    e.configured.irm === '0x870ac11d48b15db9a138cf899d20f13f79ba00bc' &&
    e.configured.marketId ===
      '0xed05fcc2893b78b3fa468d21b6e4d2925e7f2c64eb1f16279757c43f87502a99' &&
    typeof e.configured.liquidityData === 'string' &&
    /^0x[0-9a-f]{320}$/.test(e.configured.liquidityData) &&
    Array.isArray(e.configured.allocationIds) &&
    e.configured.allocationIds.length === 3 &&
    e.configured.allocationIds.every((x) => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x)) &&
    Array.isArray(e.runtimeIdentities) &&
    e.runtimeIdentities.length === 5 &&
    ['vault', 'asset', 'adapter', 'blue', 'irm'].every(
      (k) =>
        e.runtimeIdentities.filter(
          (x) =>
            x.key === k &&
            typeof x.codeHash === 'string' &&
            /^0x[0-9a-f]{64}$/.test(x.codeHash) &&
            typeof x.proxyInspection === 'string' &&
            x.implementationAddress === null &&
            x.implementationCodeHash === null,
        ).length === 1,
    )
  )
}
/** Pilot-only conditional configured-adapter paths. Global Blue cash is a NET
 * donor channel, not this market's gross competing flow or an execution proof. */
export function buildMorphoV2HolderTimeProcess(
  supplied: MorphoV2HolderTimeProcessInput,
  acceptEvidence: AcceptMorphoV2ProtocolEvidence,
) {
  try {
    const input = structuredClone(supplied),
      h = input.history,
      c = input.current,
      p = c.point,
      b = input.binding
    const sourceAt = Date.parse(p.source.blockTime)
    if (
      !Number.isSafeInteger(input.asOfMs) ||
      b.asOfMs !== input.asOfMs ||
      typeof acceptEvidence !== 'function' ||
      !validEvidence(h) ||
      !validEvidence(c) ||
      !validPoint(p) ||
      !exact(h.configured, c.configured) ||
      !exact(h.runtimeIdentities, c.runtimeIdentities) ||
      !utc(c.readAtUtc) ||
      sourceAt > Date.parse(c.readAtUtc) ||
      Date.parse(c.readAtUtc) > input.asOfMs ||
      input.asOfMs - sourceAt < 0 ||
      input.asOfMs - sourceAt > 1800000 ||
      Date.parse(h.knowledgeCutoff) > input.asOfMs ||
      Date.parse(c.knowledgeCutoff) > input.asOfMs ||
      Date.parse(c.knowledgeCutoff) < Date.parse(c.readAtUtc) ||
      !Array.isArray(h.history.points) ||
      h.history.points.length !== 2 ||
      !exact(h.history.elapsedSeconds, [0, 86400]) ||
      b.routeKey !== MORPHO_V2_PILOT.routeKey ||
      b.destination !== MORPHO_V2_PILOT.destination ||
      b.asset !== MORPHO_V2_PILOT.asset ||
      b.assetDecimals !== 6 ||
      !exact(b.currentSource, {
        chainId: 1,
        blockNumber: Number(p.source.blockNumber),
        blockHash: p.source.blockHash,
        blockTime: p.source.blockTime,
        finalized: true,
      })
    )
      return null
    const [a, z] = h.history.points
    if (
      !validPoint(a) ||
      !validPoint(z) ||
      Date.parse(z.source.blockTime) - Date.parse(a.source.blockTime) !== 86400000 ||
      BigInt(a.source.blockNumber) >= BigInt(z.source.blockNumber) ||
      BigInt(z.source.blockNumber) >= BigInt(p.source.blockNumber) ||
      Date.parse(z.source.blockTime) >= sourceAt ||
      Date.parse(h.knowledgeCutoff) < Date.parse(z.source.blockTime) ||
      !exact(a.prongs.market, z.prongs.market) ||
      !['internalSharesRaw', 'actualSharesRaw', 'allocationsRaw', 'allowanceRaw'].every((k) =>
        exact(a.prongs[k as keyof typeof a.prongs], z.prongs[k as keyof typeof z.prongs]),
      )
    )
      return null
    // Approve complete private snapshots before measurement callbacks. Caller mutation cannot alter them.
    if (
      acceptEvidence('history', structuredClone(h)) !== true ||
      acceptEvidence('current', structuredClone(c)) !== true
    )
      return null
    const cap = selectedHolderExitCapacity(input.capacityAgreement, b)
    if (
      !cap ||
      cap.quote.entitlementMethod !== 'preview_redeem_full_position' ||
      !raw(cap.quote.entitlementRaw)
    )
      return null
    const g = p.prongs,
      E = cap.quote.entitlementRaw
    const measure = (state: Record<string, string>, elapsedMs: number) => {
      if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw Error('mechanical_clock_invalid')
      const m = morphoV2AdapterCapacityMath({
        market: g.market.map(BigInt),
        at: BigInt(sourceAt / 1000) + BigInt(Math.floor(elapsedMs / 1000)),
        borrowRate: BigInt(g.borrowRateRaw),
        internalShares: BigInt(g.internalSharesRaw),
        actualShares: BigInt(g.actualSharesRaw),
        allocations: g.allocationsRaw.map(BigInt),
        allowance: BigInt(g.allowanceRaw),
        idleCash: BigInt(state.idleCashRaw),
        blueCash: BigInt(state.blueCashRaw),
        enrolled: true,
      })
      return { availableRaw: m.conditionalProtocolCapacityRaw, entitlementRaw: E }
    }
    // Reject malformed current native prongs now; future overflow remains a censored scenario.
    measure({ idleCashRaw: g.idleCashRaw, blueCashRaw: g.blueCashRaw }, 0)
    const channels = ['idleCashRaw', 'blueCashRaw'].map((key) => ({
      key,
      assetAddress: MORPHO_V2_PILOT.asset,
      decimals: 6,
      unit: 'native_usdc_raw6',
      negativeHandling: 'clamp_zero' as const,
    }))
    const values = (x: MorphoV2ProtocolPoint) => ({
      idleCashRaw: x.prongs.idleCashRaw,
      blueCashRaw: x.prongs.blueCashRaw,
    })
    const kernelInput: ConditionalTimeProcessInput = {
      channels,
      observations: h.history.points.map((x, i) => ({
        sourceAtUtc: x.source.blockTime,
        availableAtUtc: h.knowledgeCutoff,
        regime: 'morpho_v2_pilot_configured_adapter',
        channels: structuredClone(channels),
        valuesByChannel: values(x),
        provenanceRef: h.captureReceiptSha256 + ':' + i,
      })),
      outputAsset: { assetAddress: MORPHO_V2_PILOT.asset, decimals: 6 },
      measurementRule: 'configured_adapter_native_prongs_then_full_entitlement_then_q_once',
      current: {
        sourceAtUtc: p.source.blockTime,
        readAtUtc: c.readAtUtc,
        regime: 'morpho_v2_pilot_configured_adapter',
        valuesByChannel: values(p),
        provenanceRef: c.captureReceiptSha256,
      },
      issueAtUtc: new Date(input.asOfMs).toISOString(),
      requestedRaw: b.requestedRaw,
      horizonHours: input.horizonHours,
      maxHistoricalGapSeconds: 86400,
    }
    const process = buildConditionalTimeProcess(kernelInput, (v) => exact(v, kernelInput), measure)
    if (!process) return null
    return {
      status: 'conditional_morpho_v2_holder_time_process' as const,
      input,
      owner: b.owner,
      issueAtUtc: process.issueAtUtc,
      targetAtUtc: process.targetAtUtc,
      sourceProofValidUntil: process.sourceProofValidUntil,
      process,
      assumptions: {
        constantJointHistoricalIdleAndGlobalBlueNetCashRates: true,
        currentInternalAndActualSharesAllocationsAllowanceHeldConstant: true,
        currentPeriodAverageBorrowRateHeldConstant: true,
        storedMarketAccruedOnceToSourcePlusElapsed: true,
        futureMechanicalClockWholeSeconds: true,
        fullNativeEntitlementHeldConstant: true,
        ownerReceiverAndTokenEligibilityUnchangedUnverified: true,
        sourceImplementationEquivalence: false,
        globalBlueCashIsNotMarketGrossFlow: true,
      },
      holderExecutableExit: false as const,
      forecastValidated: false as const,
      prospectiveValidated: false as const,
      calibratedProbability: false as const,
      minedPayout: false as const,
    }
  } catch {
    return null
  }
}
export function selectedMorphoV2HolderTimeProcess(
  value: unknown,
  expected: MorphoV2HolderTimeProcessInput,
  asOfMs: number,
  acceptEvidence: AcceptMorphoV2ProtocolEvidence,
) {
  try {
    const v = structuredClone(value),
      e = structuredClone(expected)
    if (
      !Number.isSafeInteger(asOfMs) ||
      asOfMs < e.asOfMs ||
      asOfMs - Date.parse(e.current.point.source.blockTime) > 1800000
    )
      return null
    const rebuilt = buildMorphoV2HolderTimeProcess(e, acceptEvidence)
    if (!rebuilt || asOfMs >= Date.parse(rebuilt.targetAtUtc) || !exact(v, rebuilt)) return null
    return rebuilt
  } catch {
    return null
  }
}
