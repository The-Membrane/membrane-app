import { buildConditionalTimeProcess } from '../venueForecast/conditionalTimeProcess'
import { keccak256, stringToHex } from 'viem'
import {
  FLUID_BRIDGE_USDC,
  FLUID_BRIDGE_USDC_PRONGS,
  type FluidBridgeUsdcFrame,
} from './fluidBridgeUsdcJointHistoricalProcess'

export type FluidUsdcBridgeJointLiveTimeInput = {
  routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]'
  destination: '0x273da948aca9261043fbdb2a857bc255ecc29012'
  asset: typeof FLUID_BRIDGE_USDC
  assetDecimals: 6
  owner: string
  requestedRaw: string
  issueAtUtc: string
  knowledgeCutoffUtc: string
  horizonHours: 1 | 24 | 48 | 168
  maxHistoricalGapSeconds: 91800
  history: FluidBridgeUsdcFrame[]
  current: Omit<
    FluidBridgeUsdcFrame,
    'originalIssue' | 'provenanceKind' | 'historicalOwnership' | 'owner'
  > & {
    owner: string
    readAtUtc: string
  }
}
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const dense = (v: unknown, max: number): v is unknown[] =>
  Array.isArray(v) &&
  v.length <= max &&
  Object.keys(v).length === v.length &&
  Array.from({ length: v.length }, (_, n) => Object.hasOwn(v, n)).every(Boolean)
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
function frame(f: FluidUsdcBridgeJointLiveTimeInput['current'] | FluidBridgeUsdcFrame) {
  return (
    !!f &&
    !!f.source &&
    f.source.chainId === 1 &&
    raw(f.source.blockNumber) &&
    f.source.blockNumber !== '0' &&
    hash(f.source.blockHash) &&
    utc(f.source.blockTime) &&
    Date.parse(f.source.blockTime) % 1000 === 0 &&
    utc(f.acquiredAtUtc) &&
    utc(f.availableAtUtc) &&
    Date.parse(f.source.blockTime) <= Date.parse(f.availableAtUtc) &&
    Date.parse(f.availableAtUtc) <= Date.parse(f.acquiredAtUtc) &&
    raw(f.holderSharesRaw) &&
    f.holderSharesRaw !== '0' &&
    f.shareDecimals === 18 &&
    f.asset === FLUID_BRIDGE_USDC &&
    f.assetDecimals === 6 &&
    f.fundingUnit === 'gross_native_USDC' &&
    f.entitlementUnit === 'net_native_USDC' &&
    f.paused === false &&
    Number.isInteger(f.withdrawalFeeBps) &&
    f.withdrawalFeeBps >= 0 &&
    f.withdrawalFeeBps < 10000 &&
    raw(f.fullHolderNetUsdcRaw) &&
    record(f.nativeProngs) &&
    Object.keys(f.nativeProngs).length === 5 &&
    FLUID_BRIDGE_USDC_PRONGS.every(
      (k) => Object.hasOwn(f.nativeProngs, k) && raw(f.nativeProngs[k]),
    ) &&
    record(f.runtimeCodeHashes) &&
    Object.keys(f.runtimeCodeHashes).length >= 4 &&
    Object.keys(f.runtimeCodeHashes).length <= 16 &&
    Object.entries(f.runtimeCodeHashes).every(([k, v]) => address(k) && hash(v)) &&
    typeof f.regime === 'string' &&
    f.regime.length > 0 &&
    f.regime.length <= 256 &&
    typeof f.provenanceRef === 'string' &&
    f.provenanceRef.length > 0 &&
    f.provenanceRef.length <= 256
  )
}
function regime(f: FluidUsdcBridgeJointLiveTimeInput['current'] | FluidBridgeUsdcFrame) {
  return keccak256(
    stringToHex(
      JSON.stringify([
        f.regime,
        f.withdrawalFeeBps,
        Object.entries(f.runtimeCodeHashes).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    ),
  )
}
function values(f: FluidUsdcBridgeJointLiveTimeInput['current'] | FluidBridgeUsdcFrame) {
  return { ...f.nativeProngs, fullEa: f.fullHolderNetUsdcRaw }
}
const channels = [...FLUID_BRIDGE_USDC_PRONGS, 'fullEa'].map((key) => ({
  key,
  assetAddress: FLUID_BRIDGE_USDC,
  decimals: 6,
  unit: key === 'fullEa' ? 'net_native_USDC' : 'gross_native_USDC',
  negativeHandling: 'reject_scenario' as const,
}))
type Engine = NonNullable<ReturnType<typeof buildConditionalTimeProcess>>
function summary(values: bigint[]) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    empiricalP10HeadroomRaw: String(sorted[Math.floor((sorted.length - 1) * 0.1)]),
    empiricalP90HeadroomRaw: String(sorted[Math.floor((sorted.length - 1) * 0.9)]),
    minimumHeadroomRaw: String(sorted[0]),
    maximumHeadroomRaw: String(sorted.at(-1)!),
    scenarioCount: sorted.length,
  }
}
/** Pure conditional math. Approval alone never authenticates native acquisition. */
export function buildFluidUsdcBridgeJointLiveTimeProcess(
  supplied: FluidUsdcBridgeJointLiveTimeInput,
  approve: (privateInput: FluidUsdcBridgeJointLiveTimeInput) => boolean,
) {
  try {
    if (!supplied || !dense(supplied.history, 129) || supplied.history.length < 2) return null
    const i = structuredClone(supplied),
      c = i.current
    if (
      i.routeKey !== 'USDC → FluidBridgeAggregatorProxy [USDC]' ||
      i.destination !== '0x273da948aca9261043fbdb2a857bc255ecc29012' ||
      i.asset !== FLUID_BRIDGE_USDC ||
      i.assetDecimals !== 6 ||
      !address(i.owner) ||
      i.owner === '0x' + '0'.repeat(40) ||
      c.owner !== i.owner ||
      !raw(i.requestedRaw) ||
      i.requestedRaw === '0' ||
      !utc(i.issueAtUtc) ||
      !utc(i.knowledgeCutoffUtc) ||
      ![1, 24, 48, 168].includes(i.horizonHours) ||
      i.maxHistoricalGapSeconds !== 91800 ||
      !frame(c) ||
      !utc(c.readAtUtc) ||
      c.acquiredAtUtc !== c.readAtUtc ||
      c.availableAtUtc !== c.readAtUtc ||
      i.history.some(
        (p, n) =>
          !frame(p) ||
          p.provenanceKind !== 'native_hypothetical_shares' ||
          p.owner !== null ||
          p.historicalOwnership !== false ||
          Object.hasOwn(p, 'originalIssue') ||
          p.availableAtUtc !== p.acquiredAtUtc ||
          Date.parse(p.acquiredAtUtc) > Date.parse(i.knowledgeCutoffUtc) ||
          (n > 0 &&
            (Date.parse(p.source.blockTime) <= Date.parse(i.history[n - 1].source.blockTime) ||
              BigInt(p.source.blockNumber) <= BigInt(i.history[n - 1].source.blockNumber) ||
              p.source.blockHash === i.history[n - 1].source.blockHash)),
      )
    )
      return null
    const source = Date.parse(c.source.blockTime),
      issue = Date.parse(i.issueAtUtc),
      read = Date.parse(c.readAtUtc)
    const cutoff = Math.max(read, ...i.history.map((p) => Date.parse(p.acquiredAtUtc)))
    if (
      source > read ||
      read > issue ||
      issue - source > 1800000 ||
      Date.parse(i.knowledgeCutoffUtc) !== cutoff ||
      cutoff > issue ||
      approve(structuredClone(i)) !== true
    )
      return null
    const currentRegime = regime(c)
    const excludedIntervals: {
      fromIndex: number
      reason: string
      donorSources: FluidBridgeUsdcFrame['source'][]
    }[] = []
    const scenarios: (Engine['scenarios'][number] & {
      fromIndex: number
      donorSources: FluidBridgeUsdcFrame['source'][]
    })[] = []
    const intervalInputs: { fromIndex: number; input: Engine['input'] }[] = []
    let first: Engine | null = null
    const measure = (state: Record<string, string>) => {
      const gross = FLUID_BRIDGE_USDC_PRONGS.reduce(
        (min, k) => (BigInt(state[k]) < min ? BigInt(state[k]) : min),
        MAX,
      )
      const product = gross * BigInt(10000 - c.withdrawalFeeBps)
      if (product > MAX) throw Error('fluid_bridge_fee_intermediate_overflow')
      return { availableRaw: String(product / 10000n), entitlementRaw: state.fullEa }
    }
    for (let n = 0; n < i.history.length - 1; n++) {
      const a = i.history[n],
        b = i.history[n + 1],
        donorSources = [a.source, b.source]
      const reason =
        a.holderSharesRaw !== c.holderSharesRaw || b.holderSharesRaw !== c.holderSharesRaw
          ? 'same_share_position_mismatch'
          : regime(a) !== currentRegime || regime(b) !== currentRegime
            ? 'native_runtime_fee_or_regime_mismatch'
            : Date.parse(b.source.blockTime) >= source ||
                BigInt(b.source.blockNumber) >= BigInt(c.source.blockNumber)
              ? 'not_strictly_before_current_source'
              : Date.parse(b.source.blockTime) - Date.parse(a.source.blockTime) > 91800000
                ? 'historical_gap'
                : null
      if (reason) {
        excludedIntervals.push({ fromIndex: n, reason, donorSources })
        continue
      }
      const engine = buildConditionalTimeProcess(
        {
          channels,
          observations: [a, b].map((p) => ({
            sourceAtUtc: p.source.blockTime,
            availableAtUtc: p.acquiredAtUtc,
            regime: currentRegime,
            channels,
            valuesByChannel: values(p),
            provenanceRef: p.provenanceRef,
          })),
          outputAsset: { assetAddress: i.asset, decimals: 6 },
          measurementRule:
            'min_five_gross_native_prongs_fee_once_then_min_full_same_S_net_Ea_Q_once',
          current: {
            sourceAtUtc: c.source.blockTime,
            readAtUtc: c.readAtUtc,
            regime: currentRegime,
            valuesByChannel: values(c),
            provenanceRef: c.provenanceRef,
          },
          issueAtUtc: i.issueAtUtc,
          requestedRaw: i.requestedRaw,
          horizonHours: i.horizonHours,
          maxHistoricalGapSeconds: 91800,
        },
        () => true,
        measure,
      )
      if (!engine || engine.scenarios.length !== 1) {
        excludedIntervals.push({ fromIndex: n, reason: 'joint_process_unavailable', donorSources })
        continue
      }
      first ??= engine
      intervalInputs.push({ fromIndex: n, input: engine.input })
      scenarios.push({ ...engine.scenarios[0], fromIndex: n, donorSources })
    }
    const usable = scenarios.filter((s) => s.status === 'conditional_path'),
      censored = scenarios.length - usable.length
    const complete = usable.length > 0 && censored === 0 && excludedIntervals.length === 0
    const currentMeasurement = measure(values(c)),
      C = BigInt(currentMeasurement.availableRaw),
      E = BigInt(c.fullHolderNetUsdcRaw)
    return {
      status: 'conditional_fluid_usdc_bridge_native_joint_time_process' as const,
      input: i,
      process: first
        ? {
            ...first,
            input: i,
            intervalInputs,
            scenarios,
            excludedIntervals,
            targetSummary: complete
              ? summary(usable.map((s) => BigInt(s.targetHeadroomRaw!)))
              : null,
          }
        : null,
      issueAtUtc: i.issueAtUtc,
      sourceAtUtc: c.source.blockTime,
      readAtUtc: c.readAtUtc,
      knowledgeCutoffUtc: i.knowledgeCutoffUtc,
      targetAtUtc: new Date(issue + i.horizonHours * 3600000).toISOString(),
      sourceProofValidUntil: new Date(source + 1800000).toISOString(),
      requestedRaw: i.requestedRaw,
      sharesRaw: c.holderSharesRaw,
      fullEaRaw: c.fullHolderNetUsdcRaw,
      owner: i.owner,
      currentMeasurement: {
        fundingNetRaw: String(C),
        fullEntitlementRaw: String(E),
        capacityRaw: String(C < E ? C : E),
        headroomRaw: String((C < E ? C : E) - BigInt(i.requestedRaw)),
      },
      counts: {
        attempted: i.history.length - 1,
        usable: usable.length,
        censored,
        excluded: excludedIntervals.length,
      },
      MRaw: null,
      historicalOwnershipProven: false,
      executionProven: false,
      calibratedProbability: false,
      forecastValidated: false,
      betweenSamplesKnown: false,
    }
  } catch {
    return null
  }
}
