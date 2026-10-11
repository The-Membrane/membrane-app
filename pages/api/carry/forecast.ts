import { stusdsPinnedProtocolHistory } from '@/lib/carry/stusdsProtocolCapacityHistoryPins'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

import type { NextApiRequest, NextApiResponse } from 'next'
import { sql, type SQL } from 'drizzle-orm'
import { parseUnits } from 'viem'

import { susdsPinnedIndexHistory } from '@/lib/carry/susdsHistoricalHolderCapacityProjection'
import {
  buildAaveSparkCapacityProjection,
  type AaveSparkCapacitySource,
} from '@/lib/carry/aaveSparkCapacityProjection'
import aaveFlowDuration from '@/data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json'
import {
  buildFluidProtocolCapacityProjection,
  isFluidProtocolProjectionSubject,
} from '@/lib/carry/fluidProtocolCapacityProjection'
import {
  fluidProtocolHistoryPinForSubject,
  FLUID_PROTOCOL_CAPACITY_HISTORY_PINS,
} from '@/lib/carry/fluidProtocolCapacityHistoryPins'
import {
  isFluidExitCapacitySubject,
  selectedFluidExitCapacity,
  type FluidCapacitySource,
} from '@/lib/carry/fluidExitCapacity'
import { readEnv } from '@/scripts/lib/venue-reads.mjs'
import {
  buildConditionalGrossFlowHeadroom,
  CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS,
} from '@/lib/carry/conditionalGrossFlowHeadroom'
import {
  buildConditionalSampledCashPathProjection,
  conditionalSampledCashHistoryFromVerifiedTimeline,
  registeredConditionalSampledCashIdentity,
  type ConditionalSampledCashCurrentSource,
  type ConditionalSampledCashPathProjection,
} from '@/lib/carry/conditionalSampledCashPathProjection'
import { buildConditionalEventImpact } from '@/lib/carry/conditionalEventImpact'
import { buildHistoricalCompetingFlowEstimate } from '@/lib/carry/historicalCompetingFlowEstimate'
import { reviewedAnalogCashSubject } from '@/lib/carry/analogCashProfileRegistry.server'
import {
  issueAnalogCashScenario,
  readAuthenticatedAnalogLiveCash,
  verifyAnalogCashLedger,
  verifyAnalogSupplementalCashLedger,
} from '@/lib/carry/analogCashScenarioIssuer.server'
import { ROUTES } from '@/components/Carry/fixtures'
import { db } from '@/db'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import { resolveHolderExitSubject } from '@/lib/carry/holderExitAssessment'
import {
  currentReadStatus,
  historicalCarryCashContext,
  withReadOnlyCurrentCash,
  type CarryLiveCurrentCash,
} from '@/lib/carry/historicalCashContext'
import {
  replaySampledHistoricalCashPaths,
  type HistoricalSampledCashPathsResult,
} from '@/lib/carry/historicalSampledCashPaths'
import { checkedLocalRouteCashSamples } from '@/lib/carry/localForecastReads'
import {
  localHistoricalCashPairs,
  localHistoricalCashQHoldout,
  localHistoricalCashScenario,
} from '@/lib/carry/localHistoricalCashScenario'
import {
  localHistoricalSampledCashTimeline,
  sampledReadOnlyCurrentCash,
  type SampledCashHistoryCoverage,
} from '@/lib/carry/localHistoricalSampledCashTimeline'
import morphoIdentities from '@/lib/carry/morpho-v2-asset-identities.json'
import { checkOtherVaultAssetIdentity } from '@/lib/carry/otherVaultAssetIdentities'
import { forecastRouteCash, type RouteCashSample } from '@/lib/carry/routeCashForecast'
import {
  buildExitImpactForecast,
  withHistoricalCompetingFlow,
} from '@/lib/forecast/exitImpactForecast'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import { verifyLocalCashIssueLedgerFromVerified } from '@/scripts/lib/localCarryCashIssueStore.mjs'
import {
  readLocalCarryCashModelEvidence,
  verifyLocalCarryCashModelLedgerFromVerified,
} from '@/scripts/lib/localCarryCashModelStore.mjs'
import {
  LOCAL_CARRY_CASH_ROOT,
  localCarryCashObservationsFromVerified,
} from '@/scripts/lib/localCarryCashStore.mjs'
import {
  buildSupplementalAaveUsdeCashManifest,
  localSupplementalAaveUsdeCashObservationsFromVerified,
} from '@/scripts/lib/localSupplementalAaveUsdeCashStore.mjs'
import { buildSubjectManifest } from '@/scripts/record-carry-cash-issues.mjs'
import { readConfiguredInitialDepositNativeFacts } from '@/scripts/research/carry-initial-deposit-native-facts.mjs'
import {
  buildInitialDepositCapacityProjection,
  initialDepositMarket,
} from '@/lib/carry/initialDepositCapacityProjection'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

type ObservationRow = Record<string, unknown>

const fluidProngCache = new Map<string, { value: any; checkedAt: number }>()
const fluidProngPending = new Map<string, Promise<any>>()
const fluidHash = (s: string) => createHash('sha256').update(s).digest('hex')
function checkedFluidHistoryFile(name: string, expectedSha: string) {
  const fd = openSync(join(process.cwd(), 'data/research/venue-signals', name), 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 1 || stat.size > 2 * 1024 * 1024)
      throw Error('fluid_history_size')
    const bytes = Buffer.alloc(stat.size + 1),
      length = readSync(fd, bytes, 0, bytes.length, 0)
    if (
      length !== stat.size ||
      createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== expectedSha
    )
      throw Error('fluid_history_pin')
    return JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } finally {
    closeSync(fd)
  }
}
async function verifyFluidProtocolHistoryFiles(subject: unknown) {
  try {
    const pin = fluidProtocolHistoryPinForSubject(subject)
    if (!pin) return false
    const { replayFluidCapacityProngs } =
      await import('@/scripts/research/carry-fluid-capacity-prongs.mjs')
    const raw = checkedFluidHistoryFile(pin.proofFileName, pin.proofFileSha256)
    const compact = checkedFluidHistoryFile(pin.compactFileName, pin.compactFileSha256)
    if (raw.outcomes.length !== 2) return false
    for (let i = 0; i < 2; i++) {
      const prongs = replayFluidCapacityProngs(
        raw.outcomes[i].receipt,
        compact.subject,
        compact.sourceEvidence[i],
      )
      if (
        raw.outcomes[i].status !== 'captured' ||
        JSON.stringify(prongs.prongs) !==
          JSON.stringify(i === 0 ? compact.baselineProngs : compact.targetProngs)
      )
        return false
    }
    return true
  } catch {
    return false
  }
}
const fluidHistoryVerified = new Map<string, Promise<boolean>>()
/** Immutable byte-pinned historical donors are read and replayed once per server process. */
export async function readVerifiedFluidProtocolHistory(subject: unknown) {
  const pin = fluidProtocolHistoryPinForSubject(subject)
  if (!pin) return false
  const key = pin.proofFileSha256 + pin.compactFileSha256
  let pending = fluidHistoryVerified.get(key)
  if (!pending) {
    pending = verifyFluidProtocolHistoryFiles(subject)
    fluidHistoryVerified.set(key, pending)
  }
  const valid = await pending
  if (!valid) fluidHistoryVerified.delete(key)
  return valid
}

/** One amount-independent, exact-source read shared by requests; browser never invokes this reader. */
export async function readFluidProtocolCapacityProjection(
  subject: { routeKey: string; destination: string; asset: string; assetDecimals: number },
  source: FluidCapacitySource,
  requestedRaw: string,
  horizonHours: number,
) {
  const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason })
  if (!isFluidProtocolProjectionSubject(subject)) return unavailable('subject_mismatch')
  if (
    typeof requestedRaw !== 'string' ||
    !/^[1-9][0-9]{0,77}$/.test(requestedRaw) ||
    BigInt(requestedRaw) >= 1n << 256n ||
    !Number.isSafeInteger(horizonHours) ||
    horizonHours < 1 ||
    horizonHours > 8760
  )
    return unavailable('invalid_request')
  if (
    !source ||
    source.chainId !== 1 ||
    source.finalized !== true ||
    !Number.isSafeInteger(source.blockNumber) ||
    source.blockNumber <= 0 ||
    typeof source.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(source.blockHash) ||
    typeof source.blockTime !== 'string' ||
    !Number.isSafeInteger(Date.parse(source.blockTime)) ||
    new Date(Date.parse(source.blockTime)).toISOString() !== source.blockTime
  )
    return unavailable('invalid_current_source')
  const fresh = () =>
    Date.now() >= Date.parse(source.blockTime) &&
    Date.now() - Date.parse(source.blockTime) <= 1800000
  if (!isFluidExitCapacitySubject(subject) || !fresh()) return unavailable('invalid_current_source')
  if (!(await readVerifiedFluidProtocolHistory(subject))) return unavailable('history_unverified')
  const key = JSON.stringify({ subject, source }),
    cached = fluidProngCache.get(key)
  let receipt = cached && Date.now() - cached.checkedAt <= 60000 ? cached.value : null
  if (!receipt) {
    let pending = fluidProngPending.get(key)
    if (!pending) {
      pending = (async () => {
        const { configuredProviders, readProviderPolicy } =
          await import('@/scripts/research/carry-depth-quote-archive.mjs')
        const { captureFluidCapacityProngs } =
          await import('@/scripts/research/carry-fluid-capacity-prongs.mjs')
        const policy = readProviderPolicy()
        if (policy.status !== 'active' || policy.policyId !== 'configured-c1-c3-v1')
          throw Error('fluid_provider_policy')
        const result = await captureFluidCapacityProngs(
          subject,
          configuredProviders(readEnv(), policy),
          { source, maxRequests: 28 },
        )
        if (!fresh()) throw Error('fluid_source_expired')
        if (fluidProngCache.size >= 12) fluidProngCache.delete(fluidProngCache.keys().next().value!)
        fluidProngCache.set(key, { value: result, checkedAt: Date.now() })
        return result
      })()
      fluidProngPending.set(key, pending)
      pending.finally(() => fluidProngPending.delete(key)).catch(() => {})
    }
    try {
      receipt = await pending
    } catch {
      return unavailable('current_prongs_unavailable')
    }
  }
  if (!fresh()) return unavailable('invalid_current_source')
  if (!selectedFluidExitCapacity(receipt.prongs, { ...subject, source }))
    return unavailable('current_source_conflict')
  return (
    buildFluidProtocolCapacityProjection(
      {
        currentProngs: receipt.prongs,
        currentReadAtUtc: receipt.capturedAt,
        requestedRaw,
        horizonHours,
        asOfMs: Date.now(),
      },
      fluidHash,
    ) ?? unavailable('projection_unavailable')
  )
}

/** Independent protocol-only projection from an already accepted native source; never reads a holder. */
export function aaveSparkCapacityApiFields(input: {
  current: unknown
  requestedRaw: string | null
  horizonHours: number
  asOfMs: number
  jointProjection: unknown
  dailyProjection: unknown
  currentSourceConflict: boolean
}) {
  const unavailable = (reason: string, source: AaveSparkCapacitySource | null = null) => ({
    aaveSparkCapacityProjection: { status: 'unavailable' as const, reason },
    aaveSparkCapacitySource: source,
  })
  const c = input.current as Record<string, unknown> | null
  if (
    !c ||
    c.chainId !== 1 ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    typeof c.block !== 'string' ||
    !/^[1-9][0-9]*$/.test(c.block) ||
    !Number.isSafeInteger(Number(c.block))
  )
    return unavailable('missing_current_source')
  const source = {
    chainId: 1,
    routeKey: c.routeKey,
    destination: c.destination,
    asset: c.asset,
    assetDecimals: c.assetDecimals,
    cashRaw: c.cashRaw,
    blockNumber: Number(c.block),
    blockHash: c.blockHash,
    blockTime: c.blockTime,
    readAt: c.readAt,
    finalized: true,
    sourceKind: c.sourceKind,
    ...(c.sourceKind === 'manifest_bound_ledger'
      ? { manifestSha256: c.manifestSha256, receiptSha256: c.receiptSha256 }
      : {}),
  } as AaveSparkCapacitySource
  const utc = (v: unknown): v is string =>
    typeof v === 'string' &&
    Number.isSafeInteger(Date.parse(v)) &&
    new Date(Date.parse(v)).toISOString() === v
  const native = Object.entries(DIRECT_SUPPLY_MARKETS).find(
    ([key, m]) =>
      key !== 'compoundV3Usdc' &&
      m.routeKey === source.routeKey &&
      m.destination.toLowerCase() === source.destination &&
      m.underlying.toLowerCase() === source.asset &&
      m.decimals === source.assetDecimals,
  )
  if (
    !native ||
    typeof source.cashRaw !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(source.cashRaw) ||
    BigInt(source.cashRaw) >= 1n << 256n ||
    typeof source.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(source.blockHash) ||
    !utc(source.blockTime) ||
    !utc(source.readAt) ||
    !Number.isSafeInteger(input.asOfMs) ||
    Date.parse(source.blockTime) > Date.parse(source.readAt) ||
    Date.parse(source.readAt) > input.asOfMs ||
    !['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(source.sourceKind) ||
    (source.sourceKind === 'manifest_bound_ledger' &&
      (typeof source.manifestSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(source.manifestSha256) ||
        typeof source.receiptSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(source.receiptSha256)))
  )
    return unavailable('invalid_current_source')
  if (input.currentSourceConflict) return unavailable('current_source_conflict', source)
  if (!input.requestedRaw) return unavailable('invalid_requested_raw', source)
  const isJoint =
    source.routeKey === DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey &&
    source.sourceKind === 'live_read_only_two_origin_finalized'
  const projection = buildAaveSparkCapacityProjection(
    {
      currentSource: source,
      requestedRaw: input.requestedRaw,
      horizonHours: input.horizonHours,
      asOfMs: input.asOfMs,
      reserveAgreement: null,
      pathEvidence: {
        kind: isJoint ? 'aave_joint_windows' : 'sampled_daily_paths',
        value: isJoint ? input.jointProjection : input.dailyProjection,
      },
    },
    fluidHash,
  )
  return projection
    ? { aaveSparkCapacityProjection: projection, aaveSparkCapacitySource: source }
    : unavailable(
        typeof source.blockTime === 'string' &&
          Number.isSafeInteger(Date.parse(source.blockTime)) &&
          input.asOfMs - Date.parse(source.blockTime) > 1800000
          ? 'source_stale'
          : 'capacity_path_unavailable',
        source,
      )
}

/** Existing physical-file replay pin plus the independently pinned, joined duration overlay. */
export function readAaveHistoricalCompetingFlow() {
  try {
    const hash = (s: string) => createHash('sha256').update(s).digest('hex')
    // Preserve the historical-suite loader's raw-byte pin and canonical-file contract
    // without importing that suite's collector graph into the API.
    const fd = openSync(
      join(process.cwd(), 'data/research/venue-signals/aave-usdc-flow-stress-summary-v1.json'),
      'r',
    )
    let text: string
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size === 0 || stat.size > 256 * 1024)
        throw Error('competing_flow_summary_size')
      const bytes = Buffer.alloc(stat.size + 1)
      const length = readSync(fd, bytes, 0, bytes.length, 0)
      if (
        length !== stat.size ||
        createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !==
          '3a2360d0a26f47599f6bcd432ae6527b3b4d2c851372f0b44f4eca726ef5762f'
      )
        throw Error('competing_flow_summary_pin')
      text = bytes.subarray(0, length).toString('utf8')
    } finally {
      closeSync(fd)
    }
    const base = JSON.parse(text)
    if (text !== `${JSON.stringify(base)}\n`) throw Error('competing_flow_summary_encoding')
    const stripped = aaveFlowDuration.pairedWindows.map(({ durationPath: _path, ...w }) => w)
    if (
      hash(`${JSON.stringify(base)}\n`) !==
        '3a2360d0a26f47599f6bcd432ae6527b3b4d2c851372f0b44f4eca726ef5762f' ||
      base.sourceVerification !== 'full_sealed_replay' ||
      JSON.stringify(stripped) !== JSON.stringify(base.pairedWindows) ||
      aaveFlowDuration.source.joinContentSha256 !== base.source.joinContentSha256 ||
      aaveFlowDuration.durationOverlay.sourceJoinSha256 !== base.source.joinContentSha256 ||
      hash(JSON.stringify(aaveFlowDuration.pairedWindows)) !==
        aaveFlowDuration.pairedWindowsSha256 ||
      hash(JSON.stringify(aaveFlowDuration.pairedWindows.map((w) => w.durationPath))) !==
        aaveFlowDuration.durationOverlay.pathsSha256
    )
      throw Error('competing_flow_overlay_mismatch')
    return buildHistoricalCompetingFlowEstimate(aaveFlowDuration, hash)
  } catch {
    return { status: 'unavailable', reason: 'verified_gross_flow_history_unavailable' } as const
  }
}

type ProspectiveCashModelIdentity = {
  routeKey: string
  destination: string
  asset: string
  horizonHours: number
}

export type LocalCarryExitV2EvidenceIdentity = {
  routeKey: string
  destination: string
  asset: string
  decimals: number
  assetsRaw: string
  horizonH: number
}

export type LocalCarryExitV2EvidenceReader = (
  identity: LocalCarryExitV2EvidenceIdentity,
) => unknown | Promise<unknown>

type LocalCarryExitV2EvidenceResponse = Record<string, unknown> & {
  status: 'collecting' | 'unavailable'
  routeKey: string | null
  destination: string | null
  asset: string | null
  decimals: number | null
  assetsRaw: string | null
  horizonH: number | null
  claim: 'local_exact_q_observation_only'
  holderExecutableExit: false
  prospectiveValidated: false
  forecastValidated: false
  calibratedForecast: false
  evidence: LocalCarryExitV2PublicEvidence | null
  reason?: string
}

type LocalCarryExitV2PublicCellStatus =
  | 'pending'
  | 'recorded_unverified'
  | 'measured'
  | 'missing'
  | 'censored'
  | 'unavailable'

type LocalCarryExitV2PublicEvidence = {
  issued: number
  pending: number
  recordedUnverified: number
  measured: number
  missing: number
  censored: number
  unavailable: number
  due: number
  localReadbacks: number
  latest: {
    targetAtUtc: string
    deadlineAtUtc: string
    status: LocalCarryExitV2PublicCellStatus
    due: boolean
    localReadback: boolean
  }
}

type ProspectiveCashModelLatestIssue = {
  issuedAtUtc: string
  sourceAtUtc: string
  targetAtUtc: string
  targetLowUtc: string
  targetHighUtc: string
  outcomeDueByUtc: string
  projection:
    | {
        sourceCashRaw: string
        pointRaw: string
        lowRaw: string
        highRaw: string
        persistenceRaw: string
      }
    | {
        sourceCashRaw: string
        pointRaw: string
        lowRaw: string
        highRaw: string
        baselinePointRaw: string
        baselineLowRaw: string
        baselineHighRaw: string
      }
}

type ProspectiveCashModelUnavailableReason =
  | 'no_exact_model_match'
  | 'prospective_ledger_unavailable'
  | 'local_evidence_unavailable'

type ProspectiveCashModelAvailable = {
  routeKey: string
  destination: string
  asset: string
  horizonHours: 24
  claim: 'aggregate_cash_proxy_only'
  holderExecutableExit: false
  schedule: {
    scheduled: number
    onTime: number
    missed: number
    coveragePercent: number
    current?: boolean
  }
  outcome: {
    issued: number
    observed: number
    censored: number
    pending: number
    availabilityPercent: number
  }
  interval: {
    observed: number
    covered: number
    missed: number
    coveragePercent: number
  }
  source: {
    opportunities: number
    available: number
    unavailable: number
    ineligible: number
    unassessed: number
    availabilityPercent: number | null
  }
  latestActiveIssue: ProspectiveCashModelLatestIssue | null
}

export type ProspectiveCashModelResponse =
  | (ProspectiveCashModelAvailable & {
      status: 'collecting'
      prospectiveValidated: false
    })
  | (ProspectiveCashModelAvailable & {
      status: 'validated'
      prospectiveValidated: true
    })
  | {
      status: 'unavailable'
      routeKey: string | null
      destination: string | null
      asset: string | null
      horizonHours: 24 | null
      claim: 'aggregate_cash_proxy_only'
      holderExecutableExit: false
      prospectiveValidated: false
      schedule: null
      outcome: null
      interval: null
      source: null
      latestActiveIssue: null
      reason: ProspectiveCashModelUnavailableReason
    }

export type ProspectiveCashModelReader = (
  identity: ProspectiveCashModelIdentity,
) => Promise<ProspectiveCashModelResponse>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkedProspectiveCashModelResponse(
  value: unknown,
  identity: ProspectiveCashModelIdentity,
): ProspectiveCashModelResponse | null {
  if (
    !isRecord(value) ||
    value.routeKey !== identity.routeKey ||
    value.destination !== identity.destination ||
    value.asset !== identity.asset ||
    value.claim !== 'aggregate_cash_proxy_only' ||
    value.holderExecutableExit !== false
  )
    return null
  if (value.status === 'unavailable') {
    const validReasons: ProspectiveCashModelUnavailableReason[] = [
      'no_exact_model_match',
      'prospective_ledger_unavailable',
      'local_evidence_unavailable',
    ]
    return value.horizonHours === (identity.horizonHours === 24 ? 24 : null) &&
      value.prospectiveValidated === false &&
      value.schedule === null &&
      value.outcome === null &&
      value.interval === null &&
      value.source === null &&
      value.latestActiveIssue === null &&
      validReasons.includes(value.reason as ProspectiveCashModelUnavailableReason)
      ? (value as ProspectiveCashModelResponse)
      : null
  }
  if (
    (value.status !== 'collecting' && value.status !== 'validated') ||
    identity.horizonHours !== 24 ||
    value.horizonHours !== 24 ||
    value.prospectiveValidated !== (value.status === 'validated') ||
    !isRecord(value.schedule) ||
    !isRecord(value.outcome) ||
    !isRecord(value.interval) ||
    !isRecord(value.source) ||
    (value.latestActiveIssue !== null && !isRecord(value.latestActiveIssue))
  )
    return null
  return value as ProspectiveCashModelResponse
}

function unavailableProspectiveCashModel(
  identity: Omit<ProspectiveCashModelIdentity, 'asset'> & { asset: string | null },
  reason: ProspectiveCashModelUnavailableReason,
): ProspectiveCashModelResponse {
  return {
    status: 'unavailable',
    routeKey: identity.routeKey,
    destination: identity.destination,
    asset: identity.asset,
    horizonHours: identity.horizonHours === 24 ? 24 : null,
    claim: 'aggregate_cash_proxy_only',
    holderExecutableExit: false,
    prospectiveValidated: false,
    schedule: null,
    outcome: null,
    interval: null,
    source: null,
    latestActiveIssue: null,
    reason,
  }
}

async function defaultProspectiveCashModelReader(
  identity: ProspectiveCashModelIdentity,
): Promise<ProspectiveCashModelResponse> {
  // Keep the Node-only local-ledger adapter out of every client bundle. A
  // dynamic import also lets this API fail closed if the adapter cannot load.
  const { readProspectiveCashModel } = await import('./_lib/prospectiveCashModelRead.mjs')
  return (await readProspectiveCashModel(identity)) as ProspectiveCashModelResponse
}

async function defaultLocalCarryExitV2EvidenceReader(
  identity: LocalCarryExitV2EvidenceIdentity,
): Promise<unknown> {
  const { readLocalCarryExitV2Evidence } = await import('./_lib/localCarryExitV2Read.mjs')
  return readLocalCarryExitV2Evidence(identity)
}

export async function readProspectiveCashModelSafe(
  identity: ProspectiveCashModelIdentity,
  reader: ProspectiveCashModelReader = defaultProspectiveCashModelReader,
): Promise<ProspectiveCashModelResponse> {
  try {
    const response = checkedProspectiveCashModelResponse(await reader(identity), identity)
    if (!response) throw new Error('prospective_cash_model_response_invalid')
    return response
  } catch {
    return unavailableProspectiveCashModel(identity, 'local_evidence_unavailable')
  }
}

const LOCAL_EXIT_V2_CLAIM = 'local_exact_q_observation_only' as const
const LOCAL_EXIT_V2_CHAIN_LIMITATION =
  'Local SHA chain has no external monotonic checkpoint or rollback proof.'
const LOCAL_EXIT_V2_ADAPTER_UNAVAILABLE_REASONS = new Set([
  'invalid_exact_identity',
  'invalid_clock',
  'trusted_validator_registry_invalid',
  'ledger_verification_failed',
  'trusted_projection_failed',
  'no_exact_subject',
  'no_exact_horizon',
  'public_projection_failed',
])

function unavailableLocalCarryExitV2Evidence(
  identity: Partial<LocalCarryExitV2EvidenceIdentity>,
  reason: string,
): LocalCarryExitV2EvidenceResponse {
  return {
    status: 'unavailable',
    routeKey: typeof identity.routeKey === 'string' ? identity.routeKey : null,
    destination: typeof identity.destination === 'string' ? identity.destination : null,
    asset: typeof identity.asset === 'string' ? identity.asset : null,
    decimals: Number.isInteger(identity.decimals) ? (identity.decimals as number) : null,
    assetsRaw: typeof identity.assetsRaw === 'string' ? identity.assetsRaw : null,
    horizonH: Number.isInteger(identity.horizonH) ? (identity.horizonH as number) : null,
    claim: LOCAL_EXIT_V2_CLAIM,
    provenance: 'local_operator_clock',
    independentTimestamp: false,
    independentWitness: false,
    externalMonotonicCheckpoint: false,
    rollbackProof: false,
    minedPayoutProven: false,
    prospectiveValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
    calibratedForecast: false,
    chainLimitation: LOCAL_EXIT_V2_CHAIN_LIMITATION,
    measurementValidatorId: null,
    evidence: null,
    reason,
  }
}

function checkedLocalCarryExitV2EvidenceResponse(
  value: unknown,
  identity: LocalCarryExitV2EvidenceIdentity,
): LocalCarryExitV2EvidenceResponse | null {
  if (
    !isRecord(value) ||
    (value.status !== 'collecting' && value.status !== 'unavailable') ||
    value.routeKey !== identity.routeKey ||
    value.destination !== identity.destination ||
    value.asset !== identity.asset ||
    value.decimals !== identity.decimals ||
    value.assetsRaw !== identity.assetsRaw ||
    value.horizonH !== identity.horizonH ||
    value.claim !== LOCAL_EXIT_V2_CLAIM ||
    value.provenance !== 'local_operator_clock' ||
    value.independentTimestamp !== false ||
    value.independentWitness !== false ||
    value.externalMonotonicCheckpoint !== false ||
    value.rollbackProof !== false ||
    value.minedPayoutProven !== false ||
    value.prospectiveValidated !== false ||
    value.forecastValidated !== false ||
    value.holderExecutableExit !== false ||
    value.calibratedForecast !== false ||
    value.chainLimitation !== LOCAL_EXIT_V2_CHAIN_LIMITATION
  )
    return null
  if (value.status === 'unavailable') {
    if (
      value.evidence !== null ||
      value.measurementValidatorId !== null ||
      typeof value.reason !== 'string' ||
      !value.reason
    )
      return null
    return unavailableLocalCarryExitV2Evidence(
      identity,
      LOCAL_EXIT_V2_ADAPTER_UNAVAILABLE_REASONS.has(value.reason)
        ? value.reason
        : 'local_evidence_unavailable',
    )
  }
  if (
    !isRecord(value.evidence) ||
    typeof value.measurementValidatorId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.measurementValidatorId)
  )
    return null
  const evidence = value.evidence
  const countKeys = [
    'issued',
    'pending',
    'recordedUnverified',
    'measured',
    'missing',
    'censored',
    'unavailable',
    'due',
    'localReadbacks',
  ] as const
  const counts = Object.fromEntries(countKeys.map((key) => [key, evidence[key]])) as Record<
    (typeof countKeys)[number],
    unknown
  >
  if (
    countKeys.some((key) => !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0) ||
    (counts.issued as number) < 1 ||
    (counts.pending as number) +
      (counts.recordedUnverified as number) +
      (counts.measured as number) +
      (counts.missing as number) +
      (counts.censored as number) +
      (counts.unavailable as number) !==
      counts.issued ||
    (counts.due as number) > (counts.issued as number) ||
    (counts.localReadbacks as number) > (counts.issued as number) ||
    !isRecord(evidence.latest)
  )
    return null
  const latest = evidence.latest
  const statusKeys: Readonly<Record<LocalCarryExitV2PublicCellStatus, (typeof countKeys)[number]>> =
    {
      pending: 'pending',
      recorded_unverified: 'recordedUnverified',
      measured: 'measured',
      missing: 'missing',
      censored: 'censored',
      unavailable: 'unavailable',
    }
  if (
    typeof latest.status !== 'string' ||
    !Object.hasOwn(statusKeys, latest.status) ||
    typeof latest.targetAtUtc !== 'string' ||
    iso(latest.targetAtUtc) !== latest.targetAtUtc ||
    typeof latest.deadlineAtUtc !== 'string' ||
    iso(latest.deadlineAtUtc) !== latest.deadlineAtUtc ||
    Date.parse(latest.deadlineAtUtc) < Date.parse(latest.targetAtUtc) ||
    typeof latest.due !== 'boolean' ||
    typeof latest.localReadback !== 'boolean'
  )
    return null
  const latestStatus = latest.status as LocalCarryExitV2PublicCellStatus
  if (
    (counts[statusKeys[latestStatus]] as number) < 1 ||
    (latest.due && (counts.due as number) < 1) ||
    (latest.localReadback && (counts.localReadbacks as number) < 1)
  )
    return null
  return {
    status: 'collecting',
    ...identity,
    claim: LOCAL_EXIT_V2_CLAIM,
    provenance: 'local_operator_clock',
    independentTimestamp: false,
    independentWitness: false,
    externalMonotonicCheckpoint: false,
    rollbackProof: false,
    minedPayoutProven: false,
    prospectiveValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
    calibratedForecast: false,
    chainLimitation: LOCAL_EXIT_V2_CHAIN_LIMITATION,
    measurementValidatorId: value.measurementValidatorId,
    evidence: {
      issued: counts.issued as number,
      pending: counts.pending as number,
      recordedUnverified: counts.recordedUnverified as number,
      measured: counts.measured as number,
      missing: counts.missing as number,
      censored: counts.censored as number,
      unavailable: counts.unavailable as number,
      due: counts.due as number,
      localReadbacks: counts.localReadbacks as number,
      latest: {
        targetAtUtc: latest.targetAtUtc,
        deadlineAtUtc: latest.deadlineAtUtc,
        status: latestStatus,
        due: latest.due,
        localReadback: latest.localReadback,
      },
    },
  }
}

export async function readLocalCarryExitV2EvidenceSafe(
  identity: LocalCarryExitV2EvidenceIdentity,
  reader: LocalCarryExitV2EvidenceReader = defaultLocalCarryExitV2EvidenceReader,
): Promise<LocalCarryExitV2EvidenceResponse> {
  try {
    const response = checkedLocalCarryExitV2EvidenceResponse(await reader(identity), identity)
    if (!response) throw new Error('local_carry_exit_v2_response_invalid')
    return response
  } catch {
    return unavailableLocalCarryExitV2Evidence(identity, 'local_evidence_unavailable')
  }
}

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const MAX_RAW = (1n << 256n) - 1n
const CANONICAL_PAYOUT_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  '0x00000000efe302beaa2b3e6e1b18d08d69a9012a': 6, // AUSD
  '0x98a878b1cd98131b271883b390f68d2c90674665': 18, // apxUSD
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f': 18, // USDS
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': 6, // PYUSD
  '0x5f7827fdeb7c20b443265fc2f40845b715385ff2': 18, // EURCV
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 18, // USDe
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': 18, // GHO
  '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': 18, // RLUSD
  '0x514910771af9ca656af840dff83e8264ecf986ca': 18, // LINK
})
export function exactForecastAssetsRaw(units: string, decimals: number): string | null {
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(units) ||
    units.length > 80 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    (units.split('.')[1]?.length ?? 0) > decimals
  )
    return null
  const amount = parseUnits(units, decimals)
  return amount > 0n && amount <= MAX_RAW ? amount.toString() : null
}
const MAX_ROWS = 10_000
const LIVE_CURRENT_READ_DEADLINE_MS = 2_000

async function boundedLiveCurrentCashRead(
  query: { routeKey: string; destination: string },
  manifest: Awaited<ReturnType<typeof buildSubjectManifest>>,
  options: { maxSourceAgeMs?: number } = {},
): Promise<CarryLiveCurrentCash> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = readAuthenticatedAnalogLiveCash(query, { manifest, cache: true, ...options }).catch(
    (): CarryLiveCurrentCash => ({ status: 'unavailable', reason: 'live_read_failed' }),
  )
  try {
    return await Promise.race([
      read,
      new Promise<CarryLiveCurrentCash>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'unavailable', reason: 'live_read_timeout' }),
          LIVE_CURRENT_READ_DEADLINE_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const isLocalDevelopment = (req: NextApiRequest) =>
  process.env.NODE_ENV === 'development' &&
  (req.socket?.remoteAddress === '127.0.0.1' ||
    req.socket?.remoteAddress === '::1' ||
    req.socket?.remoteAddress === '::ffff:127.0.0.1')
const TWYNE_WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
const TWYNE_PT = '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'
const TWYNE_ATOKEN = '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545'
const TWYNE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const USD3_VAULT = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
const markets = Object.values(DIRECT_SUPPLY_MARKETS)
const morphoAssetByVault = new Map(
  morphoIdentities.entries.map((entry) => [entry.vault.toLowerCase(), entry.asset.toLowerCase()]),
)
const MARKET_VENUE_KIND: Record<string, string> = {
  [DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey]: 'aave_v3_atoken',
  [DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey]: 'aave_v3_atoken',
  [DIRECT_SUPPLY_MARKETS.compoundV3Usdc.routeKey]: 'compound_v3_comet',
  [DIRECT_SUPPLY_MARKETS.sparkLendUsdt.routeKey]: 'spark_lend_atoken',
}

type CashIssueEvidence =
  | { status: 'not_enrolled'; enrolledHorizonsHours: [1, 24] }
  | { status: 'unavailable'; reason: 'ledger_unavailable' }
  | {
      status: 'available'
      kind: 'prospective_aggregate_cash_persistence_baseline'
      horizonHours: 1 | 24
      attempts: {
        total: number
        issued: number
        sourceUnavailable: number
        sourceInvalid: number
        unassessed: number
      }
      outcomes: { observed: number; censoredMissing: number; pending: number }
      firstIssuedAt: string | null
      latestIssuedAt: string | null
    }

export function localCashIssueEvidence(
  records: Array<{
    kind: string
    slotAt: string
    issueSlotAt: string
    issuedAt: string
    attempts: Array<{
      routeKey: string
      destination: string
      horizonHours: number
      status: string
    } | null>
  }>,
  routeKey: string,
  destination: string,
  horizonHours: number,
  subjectEnrolled = true,
): CashIssueEvidence {
  if (horizonHours !== 1 && horizonHours !== 24)
    return { status: 'not_enrolled', enrolledHorizonsHours: [1, 24] }
  if (!subjectEnrolled) return { status: 'not_enrolled', enrolledHorizonsHours: [1, 24] }
  const attempts = { total: 0, issued: 0, sourceUnavailable: 0, sourceInvalid: 0, unassessed: 0 }
  const outcomes = { observed: 0, censoredMissing: 0, pending: 0 }
  let firstIssuedAt: string | null = null
  let latestIssuedAt: string | null = null
  const scores = new Map<string, string>()
  for (const record of records) {
    if (record.kind !== 'score') continue
    const score = record.attempts.find(
      (row) =>
        row?.routeKey === routeKey &&
        row.destination === destination &&
        row.horizonHours === horizonHours,
    )
    if (score) scores.set(record.issueSlotAt, score.status)
  }
  for (const record of records) {
    if (record.kind !== 'issue') continue
    const attempt = record.attempts.find(
      (row) =>
        row?.routeKey === routeKey &&
        row.destination === destination &&
        row.horizonHours === horizonHours,
    )
    if (!attempt) throw new Error('local_cash_issue_missing_subject')
    attempts.total++
    if (attempt.status === 'issued') {
      attempts.issued++
      firstIssuedAt ??= record.issuedAt
      latestIssuedAt = record.issuedAt
      const score = scores.get(record.slotAt)
      if (score === 'scored') outcomes.observed++
      else if (score === 'censored_no_target') outcomes.censoredMissing++
      else if (score === undefined) outcomes.pending++
      else throw new Error('local_cash_issue_bad_score')
    } else if (attempt.status === 'source_missing') attempts.sourceUnavailable++
    else if (attempt.status === 'unassessed') attempts.unassessed++
    else throw new Error('local_cash_issue_bad_attempt')
  }
  if (!records.length) return { status: 'unavailable', reason: 'ledger_unavailable' }
  return {
    status: 'available',
    kind: 'prospective_aggregate_cash_persistence_baseline',
    horizonHours,
    attempts,
    outcomes,
    firstIssuedAt,
    latestIssuedAt,
  }
}

type ProjectionQualificationReason =
  | 'untouched_interval_coverage_failed'
  | 'untouched_point_skill_failed'

type HistoricalModelEvidence =
  | {
      status: 'unavailable'
      reason:
        | 'not_enrolled'
        | 'no_current_issue'
        | 'ledger_unavailable'
        | ProjectionQualificationReason
    }
  | {
      status: 'historical_projection'
      claim: 'aggregate_cash_proxy_only'
      modelKind: 'learned_delta' | 'persistence_band'
      prospectiveValidated: boolean
      holderExecutableExit: false
      projection: {
        issuedAt: string
        targetAt: string
        pointRaw: string
        bandLowRaw: string
        bandHighRaw: string
        assetDecimals: number
      }
      backtest: {
        fit: number
        calibration: number
        selection: number | null
        selectionCovered: number | null
        selectionCoveragePassed: boolean | null
        holdout: number
        holdoutCovered: number
        holdoutCoveragePassed: boolean
        holdoutPointBeatsPersistence: boolean | null
        holdoutModelMae: { numeratorRaw: string; denominator: number } | null
        holdoutPersistenceMae: { numeratorRaw: string; denominator: number } | null
      }
      prospective: { issued: number; observed: number; censoredMissing: number; pending: number }
    }

function qualifiedHistoricalModelEvidence(
  evidence: HistoricalModelEvidence,
): HistoricalModelEvidence {
  if (evidence.status !== 'historical_projection') return evidence
  const { backtest } = evidence
  const validMae = (
    value: { numeratorRaw: string; denominator: number } | null,
  ): value is { numeratorRaw: string; denominator: number } =>
    value !== null && RAW.test(value.numeratorRaw) && value.denominator === backtest.holdout
  const recomputedCoveragePassed = backtest.holdoutCovered * 100 >= backtest.holdout * 80
  if (
    !Number.isSafeInteger(backtest.holdout) ||
    backtest.holdout <= 0 ||
    !Number.isSafeInteger(backtest.holdoutCovered) ||
    backtest.holdoutCovered < 0 ||
    backtest.holdoutCovered > backtest.holdout ||
    backtest.holdoutCoveragePassed !== recomputedCoveragePassed ||
    (evidence.modelKind === 'learned_delta' &&
      (typeof backtest.holdoutPointBeatsPersistence !== 'boolean' ||
        !validMae(backtest.holdoutModelMae) ||
        !validMae(backtest.holdoutPersistenceMae) ||
        backtest.holdoutPointBeatsPersistence !==
          BigInt(backtest.holdoutModelMae.numeratorRaw) <
            BigInt(backtest.holdoutPersistenceMae.numeratorRaw))) ||
    (evidence.modelKind === 'persistence_band' &&
      (backtest.holdoutPointBeatsPersistence !== null ||
        backtest.holdoutModelMae !== null ||
        backtest.holdoutPersistenceMae !== null))
  )
    return { status: 'unavailable', reason: 'ledger_unavailable' }
  if (!backtest.holdoutCoveragePassed)
    return { status: 'unavailable', reason: 'untouched_interval_coverage_failed' }
  if (evidence.modelKind === 'learned_delta' && backtest.holdoutPointBeatsPersistence !== true)
    return { status: 'unavailable', reason: 'untouched_point_skill_failed' }
  return evidence
}

function localHistoricalModelQualificationReason(
  ledger: ReturnType<typeof verifyLocalCarryCashModelLedgerFromVerified>,
  question: { routeKey: string; destination: string; asset: string; horizonHours: number },
): ProjectionQualificationReason | 'ledger_unavailable' | null {
  const enrollment = ledger.enrollments.at(-1)
  const cell = enrollment?.content.cells.find(
    (entry: {
      routeKey: string
      destination: string
      asset: string
      horizonHours: number
      artifactContentSha256: string | null
      reason?: string | null
    }) =>
      entry.routeKey === question.routeKey &&
      entry.destination === question.destination &&
      entry.asset === question.asset &&
      entry.horizonHours === question.horizonHours,
  )
  if (!cell) return null

  const exactArtifact = cell.artifactContentSha256
    ? ledger.artifacts.get(cell.artifactContentSha256)
    : null
  const artifact =
    exactArtifact ??
    [...ledger.artifacts.values()]
      .filter(
        (entry) =>
          entry.content.routeKey === question.routeKey &&
          entry.content.destination === question.destination &&
          entry.content.asset === question.asset &&
          entry.content.horizonHours === question.horizonHours,
      )
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0]
  if (!artifact) return cell.reason === 'untouched_holdout_failed' ? 'ledger_unavailable' : null

  const content = artifact.content
  if (content.modelKind === 'persistence_band') {
    const covered = safeCount(content.baselineBand?.untouchedTestCovered)
    const total = safeCount(content.baselineBand?.untouchedTestTotal)
    if (covered === null || total === null || total <= 0 || covered > total)
      return 'ledger_unavailable'
    return covered * 100 < total * 80 ? 'untouched_interval_coverage_failed' : null
  }
  if (content.modelKind !== 'learned_delta') return 'ledger_unavailable'
  const covered = safeCount(content.untouchedTest?.covered)
  const total = safeCount(content.untouchedTest?.total)
  if (covered === null || total === null || total <= 0 || covered > total)
    return 'ledger_unavailable'
  if (covered * 100 < total * 80) return 'untouched_interval_coverage_failed'
  const modelMae = parsedHistoricalMae(content.untouchedTest?.modelMae, total)
  const persistenceMae = parsedHistoricalMae(content.untouchedTest?.persistenceMae, total)
  if (!modelMae || !persistenceMae) return 'ledger_unavailable'
  return BigInt(modelMae.numeratorRaw) < BigInt(persistenceMae.numeratorRaw)
    ? null
    : 'untouched_point_skill_failed'
}

function normalizeLocalHistoricalModelEvidence(
  evidence: HistoricalModelEvidence & { detailReason?: string },
  qualificationReason: ProjectionQualificationReason | 'ledger_unavailable' | null,
): HistoricalModelEvidence {
  if (
    evidence.status === 'unavailable' &&
    evidence.reason === 'not_enrolled' &&
    evidence.detailReason === 'untouched_holdout_failed'
  )
    return { status: 'unavailable', reason: qualificationReason ?? 'ledger_unavailable' }
  return qualifiedHistoricalModelEvidence(evidence)
}

function normalizeConditionalQualificationReason(
  forecast: ReturnType<typeof buildExitImpactForecast> | null,
  qualificationReason: ProjectionQualificationReason | 'ledger_unavailable' | null,
): ReturnType<typeof buildExitImpactForecast> | null {
  if (forecast?.status === 'unavailable' && forecast.sourceReason === 'untouched_holdout_failed')
    return {
      ...forecast,
      sourceReason: qualificationReason ?? 'ledger_unavailable',
    }
  return forecast
}

function normalizeLocalHistoricalScenarioReason(
  scenario:
    | ReturnType<typeof localHistoricalCashScenario>
    | { status: 'unavailable'; reason: 'not_24h_or_untracked' },
  qualificationReason: ProjectionQualificationReason | 'ledger_unavailable' | null,
) {
  return scenario.status === 'unavailable' && scenario.reason === 'untouched_holdout_failed'
    ? {
        status: 'unavailable' as const,
        reason: qualificationReason ?? ('ledger_unavailable' as const),
      }
    : scenario
}

type TwynePtReserveEvidence =
  | {
      status: 'unavailable'
      reason: 'no_current_issue' | 'ledger_unavailable' | 'untouched_interval_coverage_failed'
    }
  | {
      status: 'historical_projection'
      metric: 'aave_pt_reserve_cash_raw'
      claim: 'shared_aave_pt_reserve_cash_only'
      prospectiveValidated: false
      holderExecutableExit: false
      projection: {
        issuedAt: string
        targetAt: string
        pointRaw: string
        bandLowRaw: string
        bandHighRaw: string
        assetDecimals: number
      }
      backtest: { fit: number; calibration: number; holdout: number; covered: number }
      prospective: { issued: number; observed: number; censoredMissing: number; pending: number }
    }

/** Frozen PT reserve artifact plus the latest future, DB-clock issue. */
export async function readTwynePtReserveModelEvidence(
  execute: (query: SQL) => Promise<{ rows: ObservationRow[] }> = async (query) =>
    (await db.execute(query)) as { rows: ObservationRow[] },
): Promise<TwynePtReserveEvidence> {
  try {
    const result = await execute(sql`
      WITH latest AS (
        SELECT i.issued_at, i.target_at, i.forecast_point_raw,
          i.forecast_low_raw, i.forecast_high_raw,
          a.sha256 AS artifact_sha256, a.payload_bytes,
          a.asset_decimals, a.fit_pairs, a.calibration_pairs, a.holdout_pairs
        FROM twyne_pt_model_issues i
        JOIN twyne_pt_model_artifacts a ON a.sha256 = i.artifact_sha256
        WHERE i.status = 'issued' AND i.target_at > clock_timestamp()
        ORDER BY i.issued_at DESC LIMIT 1
      ), metrics AS (
        SELECT count(*) FILTER (WHERE i.status = 'issued')::bigint AS issued,
          count(*) FILTER (WHERE s.status = 'observed')::bigint AS observed,
          count(*) FILTER (WHERE s.status = 'censored_missing')::bigint AS censored_missing,
          count(*) FILTER (WHERE i.status = 'issued' AND s.status IS NULL)::bigint AS pending
        FROM latest l
        JOIN twyne_pt_model_issues i ON i.artifact_sha256 = l.artifact_sha256
        LEFT JOIN twyne_pt_model_scores s ON s.slot_at = i.slot_at
      ) SELECT * FROM metrics CROSS JOIN latest`)
    const row = result.rows[0]
    if (!row || result.rows.length !== 1)
      return { status: 'unavailable', reason: 'no_current_issue' }
    const payloadBytes = String(row.payload_bytes)
    if (createHash('sha256').update(payloadBytes).digest('hex') !== row.artifact_sha256)
      throw new Error('twyne_model_artifact_digest_mismatch')
    const payload = JSON.parse(payloadBytes) as Record<string, unknown>
    const pointRaw = String(row.forecast_point_raw)
    const bandLowRaw = String(row.forecast_low_raw)
    const bandHighRaw = String(row.forecast_high_raw)
    const counts = [
      row.fit_pairs,
      row.calibration_pairs,
      row.holdout_pairs,
      row.issued,
      row.observed,
      row.censored_missing,
      row.pending,
    ].map(safeCount)
    const decimals = safeCount(row.asset_decimals)
    const band = payload.baselineBand as Record<string, unknown> | undefined
    const covered = safeCount(band?.holdoutCovered)
    if (
      payload.kind !== 'historical_aave_pt_reserve_persistence_band_v1' ||
      payload.metric !== 'aave_pt_reserve_cash_raw' ||
      payload.routeKey !== 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]' ||
      payload.wrapper !== TWYNE_WRAPPER ||
      payload.pt !== TWYNE_PT ||
      payload.aToken !== TWYNE_ATOKEN ||
      payload.pool !== TWYNE_POOL ||
      payload.horizonHours !== 1 ||
      payload.assetDecimals !== decimals ||
      payload.historicalBacktestOnly !== true ||
      payload.prospectiveValidated !== false ||
      payload.holderExecutableExit !== false ||
      typeof band?.coveragePassed !== 'boolean' ||
      counts.some((count) => count === null) ||
      decimals === null ||
      decimals > 36 ||
      covered === null ||
      covered > Number(row.holdout_pairs) ||
      !RAW.test(pointRaw) ||
      !RAW.test(bandLowRaw) ||
      !RAW.test(bandHighRaw) ||
      BigInt(bandLowRaw) > BigInt(pointRaw) ||
      BigInt(pointRaw) > BigInt(bandHighRaw) ||
      !iso(row.issued_at) ||
      !iso(row.target_at)
    )
      throw new Error('twyne_model_issue_invalid')
    const [fit, calibration, holdout, issued, observed, censoredMissing, pending] =
      counts as number[]
    if (holdout <= 0 || band!.coveragePassed !== covered * 100 >= holdout * 80)
      throw new Error('twyne_model_coverage_invalid')
    if (!band!.coveragePassed)
      return { status: 'unavailable', reason: 'untouched_interval_coverage_failed' }
    if (issued !== observed + censoredMissing + pending)
      throw new Error('twyne_model_accounting_invalid')
    return {
      status: 'historical_projection',
      metric: 'aave_pt_reserve_cash_raw',
      claim: 'shared_aave_pt_reserve_cash_only',
      prospectiveValidated: false,
      holderExecutableExit: false,
      projection: {
        issuedAt: iso(row.issued_at)!,
        targetAt: iso(row.target_at)!,
        pointRaw,
        bandLowRaw,
        bandHighRaw,
        assetDecimals: decimals,
      },
      backtest: { fit, calibration, holdout, covered },
      prospective: { issued, observed, censoredMissing, pending },
    }
  } catch {
    return { status: 'unavailable', reason: 'ledger_unavailable' }
  }
}

/** Current, immutable model issue. Earlier or unqualified historical fits are not displayed. */
export async function readHistoricalModelEvidence(
  question: {
    routeKey: string
    destination: string
    asset: string
    horizonHours: number
    assetDecimals: number
  },
  execute: (query: SQL) => Promise<{ rows: ObservationRow[] }> = async (query) =>
    (await db.execute(query)) as { rows: ObservationRow[] },
): Promise<HistoricalModelEvidence> {
  if (question.horizonHours !== 1 && question.horizonHours !== 24)
    return { status: 'unavailable', reason: 'not_enrolled' }
  try {
    const result = await execute(sql`
      WITH latest AS (
        SELECT m.issued_at, b.target_at, m.forecast_point_raw,
          m.forecast_low_raw, m.forecast_high_raw,
          a.sha256 AS artifact_sha256, a.model_version, a.payload_bytes,
          a.registered_at AS artifact_registered_at, e.activated_at AS v4_activated_at,
          a.fit_pairs, a.calibration_pairs, a.selection_pairs, a.holdout_pairs
        FROM carry_cash_model_attempts m
        JOIN carry_cash_issue_attempts b USING (slot_at, route_key, destination, horizon_hours)
        JOIN carry_cash_model_artifacts a ON a.sha256 = m.model_artifact_sha256
        CROSS JOIN carry_cash_model_v4_epoch e
        WHERE m.route_key = ${question.routeKey} AND m.destination = ${question.destination}
          AND m.horizon_hours = ${question.horizonHours} AND b.asset = ${question.asset}
          AND m.status = 'issued' AND b.target_at > clock_timestamp()
          AND b.target_at = b.source_observed_at + make_interval(hours => b.horizon_hours)
          AND b.issued_at - b.source_observed_at <= interval '30 minutes'
          AND ((a.model_version LIKE 'hdelta4-%' OR a.model_version LIKE 'hband4-%')
            AND a.registered_at >= e.activated_at AND m.issued_at >= e.activated_at
            OR (a.model_version LIKE 'hdelta3-%' OR a.model_version LIKE 'hband3-%')
              AND a.registered_at < e.activated_at AND m.issued_at < e.activated_at)
        ORDER BY m.issued_at DESC LIMIT 1
      ), metrics AS (
        SELECT count(*) FILTER (WHERE m.status = 'issued')::bigint AS issued,
          count(*) FILTER (WHERE z.status = 'observed')::bigint AS observed,
          count(*) FILTER (WHERE z.status = 'censored_missing')::bigint AS censored_missing,
          count(*) FILTER (WHERE m.status = 'issued' AND z.status IS NULL)::bigint AS pending
        FROM latest l
        JOIN carry_cash_model_attempts m ON m.model_artifact_sha256 = l.artifact_sha256
        JOIN carry_cash_issue_attempts b USING (slot_at, route_key, destination, horizon_hours)
        LEFT JOIN carry_cash_model_scores z USING (slot_at, route_key, destination, horizon_hours)
        WHERE b.target_at = b.source_observed_at + make_interval(hours => b.horizon_hours)
          AND b.issued_at - b.source_observed_at <= interval '30 minutes'
          AND (((l.model_version LIKE 'hdelta4-%' OR l.model_version LIKE 'hband4-%')
              AND m.issued_at >= l.v4_activated_at)
            OR ((l.model_version LIKE 'hdelta3-%' OR l.model_version LIKE 'hband3-%')
              AND m.issued_at < l.v4_activated_at))
      ) SELECT * FROM metrics CROSS JOIN latest`)
    const row = result.rows[0]
    if (!row || result.rows.length !== 1)
      return { status: 'unavailable', reason: 'no_current_issue' }
    const payloadBytes = String(row.payload_bytes)
    const digest = createHash('sha256').update(payloadBytes).digest('hex')
    if (digest !== row.artifact_sha256) throw new Error('model_artifact_digest_mismatch')
    const payload = JSON.parse(payloadBytes) as Record<string, unknown>
    const version = String(row.model_version)
    const v4 = /^h(delta|band)4-[0-9]+-[0-9]+$/.test(version)
    const v3 = /^h(delta|band)3-[0-9]+-[0-9]+$/.test(version)
    const issuedAt = iso(row.issued_at)
    const artifactRegisteredAt = iso(row.artifact_registered_at)
    const v4ActivatedAt = iso(row.v4_activated_at)
    const pointRaw = String(row.forecast_point_raw)
    const bandLowRaw = String(row.forecast_low_raw)
    const bandHighRaw = String(row.forecast_high_raw)
    const counts = [
      row.fit_pairs,
      row.calibration_pairs,
      row.holdout_pairs,
      row.issued,
      row.observed,
      row.censored_missing,
      row.pending,
    ].map(safeCount)
    if (
      !['historical_cash_delta_model_v1', 'historical_cash_persistence_band_v1'].includes(
        String(payload.kind),
      ) ||
      payload.routeKey !== question.routeKey ||
      payload.destination !== question.destination ||
      payload.asset !== question.asset ||
      payload.assetDecimals !== question.assetDecimals ||
      payload.horizonHours !== question.horizonHours ||
      payload.historicalBacktestOnly !== true ||
      payload.prospectiveValidated !== false ||
      payload.holderExecutableExit !== false ||
      (!v3 && !v4) ||
      (payload.kind === 'historical_cash_delta_model_v1' && !version.startsWith('hdelta')) ||
      (payload.kind === 'historical_cash_persistence_band_v1' && !version.startsWith('hband')) ||
      !issuedAt ||
      !artifactRegisteredAt ||
      !v4ActivatedAt ||
      (v3 &&
        (Date.parse(artifactRegisteredAt) >= Date.parse(v4ActivatedAt) ||
          Date.parse(issuedAt) >= Date.parse(v4ActivatedAt))) ||
      (v4 &&
        (Date.parse(artifactRegisteredAt) < Date.parse(v4ActivatedAt) ||
          Date.parse(issuedAt) < Date.parse(v4ActivatedAt))) ||
      counts.some((count) => count === null) ||
      !RAW.test(pointRaw) ||
      !RAW.test(bandLowRaw) ||
      !RAW.test(bandHighRaw) ||
      BigInt(bandLowRaw) > BigInt(bandHighRaw) ||
      !iso(row.target_at)
    )
      throw new Error('model_issue_invalid')
    const [fit, calibration, holdout, issued, observed, censoredMissing, pending] =
      counts as number[]
    const historicalHoldout = payload.holdout as Record<string, unknown>
    const historicalSelection = payload.selection as Record<string, unknown> | undefined
    const baselineBand = payload.baselineBand as Record<string, unknown>
    const payloadCounts = payload.counts as Record<string, unknown> | undefined
    const holdoutCovered = safeCount(
      payload.kind === 'historical_cash_persistence_band_v1'
        ? baselineBand?.holdoutCovered
        : historicalHoldout?.covered,
    )
    const selection = v4 ? safeCount(row.selection_pairs) : null
    const selectionCovered = v4
      ? safeCount(
          payload.kind === 'historical_cash_persistence_band_v1'
            ? baselineBand?.selectionCovered
            : historicalSelection?.covered,
        )
      : null
    const selectionCoveragePassed = v4
      ? payload.kind === 'historical_cash_persistence_band_v1'
        ? baselineBand?.selectionCoveragePassed
        : historicalSelection?.coveragePassed
      : null
    const selectionPointBeatsPersistence = v4 ? historicalSelection?.pointBeatsPersistence : null
    const selectionModelMae = v4
      ? parsedHistoricalMae(historicalSelection?.modelMae, selection ?? -1)
      : null
    const selectionPersistenceMae = v4
      ? parsedHistoricalMae(historicalSelection?.persistenceMae, selection ?? -1)
      : null
    const holdoutCoveragePassed =
      payload.kind === 'historical_cash_persistence_band_v1'
        ? baselineBand?.coveragePassed
        : historicalHoldout?.coveragePassed
    const holdoutPointBeatsPersistence =
      payload.kind === 'historical_cash_delta_model_v1'
        ? historicalHoldout?.pointBeatsPersistence
        : null
    const holdoutModelMae =
      payload.kind === 'historical_cash_delta_model_v1'
        ? parsedHistoricalMae(historicalHoldout?.modelMae, holdout)
        : null
    const holdoutPersistenceMae =
      payload.kind === 'historical_cash_delta_model_v1'
        ? parsedHistoricalMae(historicalHoldout?.persistenceMae, holdout)
        : null
    if (
      holdoutCovered === null ||
      holdoutCovered > holdout ||
      typeof holdoutCoveragePassed !== 'boolean' ||
      holdoutCoveragePassed !== holdoutCovered * 100 >= holdout * 80 ||
      (payload.kind === 'historical_cash_delta_model_v1' &&
        (typeof holdoutPointBeatsPersistence !== 'boolean' ||
          holdoutModelMae === null ||
          holdoutPersistenceMae === null ||
          holdoutPointBeatsPersistence !==
            BigInt(holdoutModelMae.numeratorRaw) < BigInt(holdoutPersistenceMae.numeratorRaw))) ||
      (v4 &&
        (selection === null ||
          selectionCovered === null ||
          selectionCovered > selection ||
          typeof selectionCoveragePassed !== 'boolean' ||
          selectionCoveragePassed !== selectionCovered * 100 >= selection * 80 ||
          typeof selectionPointBeatsPersistence !== 'boolean' ||
          selectionModelMae === null ||
          selectionPersistenceMae === null ||
          selectionPointBeatsPersistence !==
            BigInt(selectionModelMae.numeratorRaw) < BigInt(selectionPersistenceMae.numeratorRaw) ||
          safeCount(payloadCounts?.fit) !== fit ||
          safeCount(payloadCounts?.calibration) !== calibration ||
          safeCount(payloadCounts?.selection) !== selection ||
          safeCount(payloadCounts?.holdout) !== holdout ||
          safeCount(payloadCounts?.total) !== fit + calibration + selection + holdout ||
          safeCount(historicalSelection?.total) !== selection ||
          safeCount(historicalHoldout?.total) !== holdout ||
          (payload.kind === 'historical_cash_delta_model_v1' &&
            (historicalSelection?.coveragePassed !== true ||
              historicalSelection?.pointBeatsPersistence !== true)) ||
          (payload.kind === 'historical_cash_persistence_band_v1' &&
            (baselineBand?.selectionCoveragePassed !== true ||
              safeCount(baselineBand?.selectionTotal) !== selection ||
              safeCount(baselineBand?.holdoutTotal) !== holdout ||
              (historicalSelection?.coveragePassed === true &&
                historicalSelection?.pointBeatsPersistence === true))))) ||
      (!v4 && row.selection_pairs !== null && row.selection_pairs !== undefined) ||
      issued !== observed + censoredMissing + pending
    )
      throw new Error('model_evidence_counts_invalid')
    const validatedSelectionCoveragePassed = v4 ? (selectionCoveragePassed as boolean) : null
    const validatedHoldoutCoveragePassed = holdoutCoveragePassed as boolean
    const validatedHoldoutPointBeatsPersistence =
      payload.kind === 'historical_cash_delta_model_v1'
        ? (holdoutPointBeatsPersistence as boolean)
        : null
    return qualifiedHistoricalModelEvidence({
      status: 'historical_projection',
      claim: 'aggregate_cash_proxy_only',
      modelKind:
        payload.kind === 'historical_cash_delta_model_v1' ? 'learned_delta' : 'persistence_band',
      prospectiveValidated: false,
      holderExecutableExit: false,
      projection: {
        issuedAt,
        targetAt: iso(row.target_at)!,
        pointRaw,
        bandLowRaw,
        bandHighRaw,
        assetDecimals: question.assetDecimals,
      },
      backtest: {
        fit,
        calibration,
        selection,
        selectionCovered,
        selectionCoveragePassed: validatedSelectionCoveragePassed,
        holdout,
        holdoutCovered,
        holdoutCoveragePassed: validatedHoldoutCoveragePassed,
        holdoutPointBeatsPersistence: validatedHoldoutPointBeatsPersistence,
        holdoutModelMae,
        holdoutPersistenceMae,
      },
      prospective: { issued, observed, censoredMissing, pending },
    })
  } catch {
    return { status: 'unavailable', reason: 'ledger_unavailable' }
  }
}

function safeCount(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

function parsedHistoricalMae(
  value: unknown,
  expectedDenominator: number,
): { numeratorRaw: string; denominator: number } | null {
  if (!value || typeof value !== 'object') return null
  const metric = value as Record<string, unknown>
  const numeratorRaw = String(metric.numeratorRaw ?? '')
  const denominator = safeCount(metric.denominator)
  if (!RAW.test(numeratorRaw) || denominator !== expectedDenominator) return null
  return { numeratorRaw, denominator }
}

/** Read exact-subject prospective baseline accounting; no raw cash is selected. */
export async function readCashIssueEvidence(
  question: {
    routeKey: string
    destination: string
    asset: string
    source: 'vault' | 'market'
    horizonHours: number
  },
  execute: (query: SQL) => Promise<{ rows: ObservationRow[] }> = async (query) =>
    (await db.execute(query)) as { rows: ObservationRow[] },
): Promise<CashIssueEvidence> {
  if (question.horizonHours !== 1 && question.horizonHours !== 24)
    return { status: 'not_enrolled', enrolledHorizonsHours: [1, 24] }
  const venueKind = question.source === 'market' ? MARKET_VENUE_KIND[question.routeKey] : null
  if (question.source === 'market' && !venueKind)
    return { status: 'unavailable', reason: 'ledger_unavailable' }
  try {
    const result = await execute(sql`
      SELECT count(*)::bigint AS attempts_total,
        count(*) FILTER (WHERE i.status = 'issued')::bigint AS issued_count,
        count(*) FILTER (WHERE i.status = 'source_unavailable')::bigint AS source_unavailable_count,
        count(*) FILTER (WHERE i.status = 'source_invalid')::bigint AS source_invalid_count,
        count(*) FILTER (WHERE i.status = 'unassessed')::bigint AS unassessed_count,
        count(*) FILTER (WHERE s.status = 'observed')::bigint AS observed_count,
        count(*) FILTER (WHERE s.status = 'censored_missing')::bigint AS censored_missing_count,
        count(*) FILTER (WHERE i.status = 'issued' AND s.status IS NULL)::bigint AS pending_count,
        min(i.issued_at) FILTER (WHERE i.status = 'issued') AS first_issued_at,
        max(i.issued_at) FILTER (WHERE i.status = 'issued') AS latest_issued_at
      FROM carry_cash_issue_attempts i
      LEFT JOIN carry_cash_issue_scores s
        ON s.slot_at = i.slot_at AND s.route_key = i.route_key
        AND s.destination = i.destination AND s.horizon_hours = i.horizon_hours
      WHERE i.route_key = ${question.routeKey}
        AND i.destination = ${question.destination}
        AND i.asset = ${question.asset}
        AND i.source_kind = ${question.source}
        AND i.source_venue_kind IS NOT DISTINCT FROM ${venueKind}
        AND i.horizon_hours = ${question.horizonHours}
        AND i.slot_at >= '2026-09-29 09:30:00+00'::timestamptz`)
    const row = result.rows[0]
    if (!row || result.rows.length !== 1) throw new Error('ledger_aggregate_invalid')
    const counts = [
      row.attempts_total,
      row.issued_count,
      row.source_unavailable_count,
      row.source_invalid_count,
      row.unassessed_count,
      row.observed_count,
      row.censored_missing_count,
      row.pending_count,
    ].map(safeCount)
    if (counts.some((count) => count === null)) throw new Error('ledger_counts_invalid')
    const [
      total,
      issued,
      sourceUnavailable,
      sourceInvalid,
      unassessed,
      observed,
      censoredMissing,
      pending,
    ] = counts as number[]
    if (
      total !== issued + sourceUnavailable + sourceInvalid + unassessed ||
      issued !== observed + censoredMissing + pending
    )
      throw new Error('ledger_accounting_invalid')
    const firstIssuedAt = row.first_issued_at == null ? null : iso(row.first_issued_at)
    const latestIssuedAt = row.latest_issued_at == null ? null : iso(row.latest_issued_at)
    if (
      (issued > 0 && (!firstIssuedAt || !latestIssuedAt)) ||
      (issued === 0 && (firstIssuedAt || latestIssuedAt)) ||
      (firstIssuedAt && latestIssuedAt && firstIssuedAt > latestIssuedAt)
    )
      throw new Error('ledger_issue_clock_invalid')
    return {
      status: 'available',
      kind: 'prospective_aggregate_cash_persistence_baseline',
      horizonHours: question.horizonHours,
      attempts: { total, issued, sourceUnavailable, sourceInvalid, unassessed },
      outcomes: { observed, censoredMissing, pending },
      firstIssuedAt,
      latestIssuedAt,
    }
  } catch {
    return { status: 'unavailable', reason: 'ledger_unavailable' }
  }
}

const sha256 = (name: string) =>
  createHash('sha256')
    .update(readFileSync(join(process.cwd(), name)))
    .digest('hex')

function iso(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** Validate every receipt before it enters an issue-time model. */
export function checkedRouteCashSamples(
  rows: ObservationRow[],
  expected: {
    routeKey: string
    destination: string
    asset: string
    decimals: number
    source: 'vault' | 'market'
    seedSha256?: string
    boardSha256?: string
    displayedRoutesSha256?: string
    seedSourceSha256?: string
    cohortId?: string
    unassessedCash?: boolean
  },
): RouteCashSample[] | null {
  const samples: RouteCashSample[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const block = Number(row.block)
    const hash = String(row.block_hash).toLowerCase()
    const observedAt = iso(row.observed_at)
    const firstAvailableAt = iso(row.first_local_receipt_at)
    const destination = String(
      expected.source === 'vault' ? row.vault : row.destination,
    ).toLowerCase()
    const asset = String(expected.source === 'vault' ? row.asset : row.underlying).toLowerCase()
    const decimals = Number(
      expected.source === 'vault' ? row.asset_decimals : row.underlying_decimals,
    )
    const raw = String(row.cash_raw)
    if (
      row.route_key !== expected.routeKey ||
      destination !== expected.destination ||
      asset !== expected.asset ||
      decimals !== expected.decimals ||
      !Number.isSafeInteger(block) ||
      block <= 0 ||
      !HASH.test(hash) ||
      !observedAt ||
      !firstAvailableAt ||
      firstAvailableAt < observedAt ||
      !RAW.test(raw) ||
      seen.has(`${block}:${hash}`) ||
      (expected.source === 'vault' &&
        (row.seed_sha256 !== expected.seedSha256 ||
          row.board_sha256 !== expected.boardSha256 ||
          row.displayed_routes_sha256 !== expected.displayedRoutesSha256 ||
          row.seed_source_sha256 !== expected.seedSourceSha256 ||
          row.cohort_id !== expected.cohortId)) ||
      (expected.source === 'market' && Number(row.chain_id) !== 1)
    )
      return null
    seen.add(`${block}:${hash}`)
    const cashUnits = expected.unassessedCash ? null : Number(raw) / 10 ** decimals
    if (cashUnits !== null && (!Number.isFinite(cashUnits) || cashUnits < 0)) return null
    samples.push({
      block,
      observedAt,
      firstAvailableAt,
      sourceId: `${block}:${hash}:${destination}`,
      coverage: expected.unassessedCash ? 'unverified' : 'complete',
      cashUnits,
    })
  }
  return samples.reverse()
}

/** Public, read-only route forecast evidence. All 25 groups can be queried by exact destination. */
export async function carryForecastRequest(
  req: NextApiRequest,
  res: NextApiResponse,
  prospectiveCashModelReader: ProspectiveCashModelReader = defaultProspectiveCashModelReader,
  localCarryExitV2EvidenceReader: LocalCarryExitV2EvidenceReader = defaultLocalCarryExitV2EvidenceReader,
) {
  res.setHeader('Cache-Control', 'no-store')
  if (
    req.method === 'POST' &&
    req.query.mode !== undefined &&
    req.body?.mode !== undefined &&
    req.query.mode !== req.body.mode
  )
    return res.status(400).json({ error: 'conflicting_forecast_modes' })
  const isInitialDeposit =
    req.method === 'POST'
      ? req.body?.mode === 'initial_deposit'
      : req.query.mode === 'initial_deposit'
  if (req.method !== 'GET' && !(req.method === 'POST' && isInitialDeposit)) {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const question = isInitialDeposit && req.method === 'POST' ? (req.body ?? {}) : req.query
  const depositAssetsRaw = isInitialDeposit ? question.depositAssetsRaw : null
  const plannedExitAssetsRaw = isInitialDeposit ? question.plannedExitAssetsRaw : null
  const nativeRaw = (v: unknown): v is string =>
    typeof v === 'string' &&
    /^(0|[1-9][0-9]{0,77})$/.test(v) &&
    BigInt(v) > 0n &&
    BigInt(v) < 1n << 256n
  if (isInitialDeposit && (!nativeRaw(depositAssetsRaw) || !nativeRaw(plannedExitAssetsRaw)))
    return res.status(400).json({ error: 'invalid_initial_deposit_question' })
  const routeKey = Array.isArray(question.routeKey) ? null : question.routeKey
  const destination =
    Array.isArray(question.destination) || typeof question.destination !== 'string'
      ? null
      : question.destination.toLowerCase()
  // Pilot principals and withdrawals are explicit native six-decimal amounts.
  const amountRaw = isInitialDeposit
    ? `${BigInt(plannedExitAssetsRaw) / 1000000n}.${(BigInt(plannedExitAssetsRaw) % 1000000n).toString().padStart(6, '0')}`
    : Array.isArray(question.amountUnits)
      ? null
      : question.amountUnits
  const horizonRaw = Array.isArray(question.horizonHours)
    ? null
    : isInitialDeposit && typeof question.horizonHours === 'number'
      ? String(question.horizonHours)
      : question.horizonHours
  const amountUnits = Number(amountRaw)
  const horizonHours = Number(horizonRaw)
  if (
    typeof routeKey !== 'string' ||
    !routeKey ||
    routeKey.length > 160 ||
    typeof destination !== 'string' ||
    !ADDRESS.test(destination) ||
    typeof amountRaw !== 'string' ||
    !Number.isFinite(amountUnits) ||
    amountUnits <= 0 ||
    typeof horizonRaw !== 'string' ||
    !Number.isInteger(horizonHours) ||
    horizonHours < 1 ||
    horizonHours > 720
  )
    return res.status(400).json({ error: 'invalid_forecast_question' })

  const registry = buildCarryForecastRegistry(
    ROUTES,
    seed,
    recorderConfig.venues,
    GHO_SGHO.destination,
    verifiedDirectSupplyDestinations(),
  )
  const group = registry.routeGroups.find((row) => row.routeKey === routeKey)
  const subject = group?.contractSubjects.find((row) => row.destinationAddress === destination)
  if (!subject) return res.status(404).json({ error: 'unknown_route_destination' })
  if (isInitialDeposit && !initialDepositMarket(routeKey, destination))
    return res.status(200).json({
      routeKey,
      destination,
      initialDepositProjection: { status: 'unavailable', reason: 'unsupported_subject' },
    })

  const payoutAsset = (() => {
    try {
      return resolveHolderExitSubject(
        routeKey,
        destination as `0x${string}`,
      ).payoutAsset.toLowerCase()
    } catch {
      return null
    }
  })()
  const payoutDecimals = payoutAsset ? (CANONICAL_PAYOUT_DECIMALS[payoutAsset] ?? null) : null
  const payoutAssetsRaw =
    payoutDecimals === null ? null : exactForecastAssetsRaw(amountRaw, payoutDecimals)
  const localCarryExitV2Evidence =
    payoutAsset && payoutDecimals !== null && payoutAssetsRaw
      ? await readLocalCarryExitV2EvidenceSafe(
          {
            routeKey,
            destination,
            asset: payoutAsset,
            decimals: payoutDecimals,
            assetsRaw: payoutAssetsRaw,
            horizonH: horizonHours,
          },
          localCarryExitV2EvidenceReader,
        )
      : unavailableLocalCarryExitV2Evidence(
          {
            routeKey,
            destination,
            ...(payoutAsset ? { asset: payoutAsset } : {}),
            ...(payoutDecimals === null ? {} : { decimals: payoutDecimals }),
            ...(payoutAssetsRaw ? { assetsRaw: payoutAssetsRaw } : {}),
            horizonH: horizonHours,
          },
          payoutAsset && payoutDecimals === null
            ? 'canonical_asset_decimals_unavailable'
            : payoutAsset
              ? 'invalid_requested_assets'
              : 'canonical_payout_asset_unavailable',
        )
  const prospectiveCashModel = payoutAsset
    ? await readProspectiveCashModelSafe(
        { routeKey, destination, asset: payoutAsset, horizonHours },
        prospectiveCashModelReader,
      )
    : unavailableProspectiveCashModel(
        { routeKey, destination, asset: null, horizonHours },
        'no_exact_model_match',
      )

  // Local development replays the complete sealed cash archive and uses only
  // current finalized receipts. Retrospective anchors never train this engine.
  // Production continues to use its existing DB-backed ledger path.
  if (isLocalDevelopment(req) || isInitialDeposit) {
    try {
      const manifest = await buildSubjectManifest()
      const frozenCashSubject = manifest.subjects.find(
        (row) => row.route_key === routeKey && row.destination === destination,
      )
      const supplementalMarket = markets.find(
        (row) => row.routeKey === routeKey && row.destination.toLowerCase() === destination,
      )
      if (!frozenCashSubject && !supplementalMarket)
        return res.status(503).json({ error: 'local_cash_subject_unverified' })
      const supplementalManifest = frozenCashSubject
        ? null
        : await buildSupplementalAaveUsdeCashManifest({ issueManifest: manifest })
      const supplementalCashSubject = supplementalManifest?.subjects.find(
        (row) => row.route_key === routeKey && row.destination === destination,
      )
      const cashSubject = frozenCashSubject ?? supplementalCashSubject
      if (!cashSubject) return res.status(503).json({ error: 'local_cash_subject_unverified' })

      // The supplemental market has its own manifest and receipt chain. It is
      // deliberately absent from the frozen 25/67 cash, issue, and model ledgers.
      const cashLedger = frozenCashSubject
        ? verifyAnalogCashLedger(manifest, LOCAL_CARRY_CASH_ROOT)
        : null
      const supplementalCashLedger = supplementalManifest
        ? verifyAnalogSupplementalCashLedger(supplementalManifest)
        : null
      const receipts = cashLedger
        ? localCarryCashObservationsFromVerified(cashLedger)
        : localSupplementalAaveUsdeCashObservationsFromVerified(supplementalCashLedger)
      const issueLedger = cashLedger
        ? verifyLocalCashIssueLedgerFromVerified(manifest, cashLedger)
        : null
      const modelLedger =
        cashLedger && issueLedger
          ? verifyLocalCarryCashModelLedgerFromVerified(manifest, {
              cash: cashLedger,
              baseline: issueLedger,
            })
          : null
      const checked = checkedLocalRouteCashSamples(receipts, cashSubject)
      const isSupplementalCashSubject = frozenCashSubject === undefined
      const assetSymbol = routeKey.match(/\[([^\]]+)\]$/)?.[1] ?? routeKey.split(' → ')[0]
      const forecast = forecastRouteCash({
        routeKey,
        destination,
        asset: cashSubject.asset,
        assetSymbol,
        amountUnits,
        horizonHours,
        asOf: new Date().toISOString(),
        snapshots: checked.status === 'available' ? checked.samples : [],
        cashKind:
          destination === TWYNE_WRAPPER
            ? 'unassessed'
            : cashSubject.source_kind === 'market'
              ? 'market_cash'
              : destination === USD3_VAULT
                ? 'direct_buffer_only'
                : 'vault_cash',
      })
      const historicalContext =
        cashSubject && destination !== TWYNE_WRAPPER && horizonHours === 24
          ? historicalCarryCashContext(receipts, cashSubject)
          : null
      let scenarioAsOfMs = Date.now()
      const localModelQualificationReason = modelLedger
        ? localHistoricalModelQualificationReason(modelLedger, {
            routeKey,
            destination,
            asset: cashSubject.asset,
            horizonHours,
          })
        : null
      const historicalModel = modelLedger
        ? normalizeLocalHistoricalModelEvidence(
            readLocalCarryCashModelEvidence(
              modelLedger,
              {
                routeKey,
                destination,
                asset: cashSubject.asset,
                horizonHours,
              },
              new Date(scenarioAsOfMs).toISOString(),
            ) as HistoricalModelEvidence & { detailReason?: string },
            localModelQualificationReason,
          )
        : ({ status: 'unavailable', reason: 'not_enrolled' } as const)
      const localHistoricalPairs =
        horizonHours === 24
          ? localHistoricalCashPairs(receipts, cashSubject, scenarioAsOfMs)
          : {
              status: 'unavailable' as const,
              reason: 'not_24h_or_untracked' as const,
            }
      // amountUnits names the route's requested payout asset. Historical cash
      // can answer exact Q only when its asset is that same token.
      const cashAssetMatchesPayout =
        Boolean(payoutAsset) &&
        cashSubject.asset.toLowerCase() === payoutAsset &&
        (localHistoricalPairs.status !== 'historical_pairs' ||
          localHistoricalPairs.asset.toLowerCase() === payoutAsset)
      const requestedAssetsRaw =
        cashAssetMatchesPayout && localHistoricalPairs.status === 'historical_pairs'
          ? exactForecastAssetsRaw(amountRaw, localHistoricalPairs.assetDecimals)
          : null
      const historicalExitImpactResult =
        localHistoricalPairs.status === 'historical_pairs' && requestedAssetsRaw
          ? buildExitImpactForecast({
              kind: 'retrospective_backtest',
              identity: {
                routeKey: localHistoricalPairs.routeKey,
                destination: localHistoricalPairs.destination,
                asset: localHistoricalPairs.asset,
                assetDecimals: localHistoricalPairs.assetDecimals,
              },
              requestedRaw: requestedAssetsRaw,
              horizonHours: localHistoricalPairs.horizonHours,
              pairs: localHistoricalPairs.pairs,
              dailyTimeline: localHistoricalPairs.dailyTimeline,
            })
          : null
      const historicalExitImpact =
        historicalExitImpactResult?.status === 'historical_backtest'
          ? historicalExitImpactResult
          : null
      const historicalExitImpactUnavailableReason = historicalExitImpact
        ? null
        : localHistoricalPairs.status === 'unavailable' &&
            localHistoricalPairs.reason === 'subject_unassessed'
          ? 'subject_unassessed'
          : !cashAssetMatchesPayout
            ? 'asset_identity_mismatch'
            : localHistoricalPairs.status === 'unavailable'
              ? localHistoricalPairs.reason
              : !requestedAssetsRaw
                ? 'invalid_requested_assets'
                : historicalExitImpactResult?.status === 'unavailable'
                  ? historicalExitImpactResult.reason
                  : 'historical_backtest_unavailable'
      // Descriptive sampled paths use verified post-deployment observations;
      // fitted models and Q holdouts retain their independent strict pair gate.
      const fluidNativePin = FLUID_PROTOCOL_CAPACITY_HISTORY_PINS.find(
        ({ compact: { subject: s } }) =>
          s.routeKey === routeKey &&
          s.destination === destination &&
          s.asset === payoutAsset &&
          s.asset === cashSubject.asset.toLowerCase(),
      )
      const fluidSubject = fluidNativePin?.compact.subject ?? null
      const aaveSparkNativeMarket = Object.entries(DIRECT_SUPPLY_MARKETS).find(
        ([key, m]) =>
          key !== 'compoundV3Usdc' &&
          m.routeKey === routeKey &&
          m.destination.toLowerCase() === destination &&
          m.underlying.toLowerCase() === payoutAsset &&
          m.underlying.toLowerCase() === cashSubject.asset.toLowerCase(),
      )
      const cometMarket = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
      const isCometNativeSubject =
        routeKey === cometMarket.routeKey &&
        destination === cometMarket.destination.toLowerCase() &&
        payoutAsset === cometMarket.underlying.toLowerCase() &&
        cashSubject.asset.toLowerCase() === payoutAsset
      const isSusdsNativeSubject = (() => {
        try {
          const registered = resolveHolderExitSubject(routeKey, destination as `0x${string}`)
          return (
            registered.kind === 'susds' &&
            registered.payoutAsset.toLowerCase() === payoutAsset &&
            cashSubject.asset.toLowerCase() === payoutAsset
          )
        } catch {
          return false
        }
      })()
      const isStusdsNativeSubject = (() => {
        try {
          const registered = resolveHolderExitSubject(routeKey, destination as `0x${string}`)
          return (
            registered.kind === 'tracked' &&
            routeKey === 'USDS → StUsds [USDS]' &&
            destination.toLowerCase() === '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9' &&
            registered.payoutAsset.toLowerCase() === payoutAsset &&
            cashSubject.asset.toLowerCase() === payoutAsset
          )
        } catch {
          return false
        }
      })()
      const isSghoNativeSubject = (() => {
        try {
          const registered = resolveHolderExitSubject(routeKey, destination as `0x${string}`)
          return (
            registered.kind === 'sgho' &&
            registered.payoutAsset.toLowerCase() === payoutAsset &&
            cashSubject.asset.toLowerCase() === payoutAsset
          )
        } catch {
          return false
        }
      })()
      const isUsd3NativeSubject = (() => {
        try {
          const registered = resolveHolderExitSubject(routeKey, destination as `0x${string}`)
          return (
            registered.kind === 'usd3' &&
            routeKey === 'USDC → USD3 [USDC]' &&
            destination.toLowerCase() === '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc' &&
            registered.payoutAsset.toLowerCase() === payoutAsset &&
            cashSubject.asset.toLowerCase() === payoutAsset
          )
        } catch {
          return false
        }
      })()
      const analogCashProfile = reviewedAnalogCashSubject(cashSubject)
      const sampledHistory =
        Boolean(registeredConditionalSampledCashIdentity(routeKey, destination)) ||
        horizonHours === 24 ||
        analogCashProfile !== null ||
        fluidSubject !== null ||
        Boolean(aaveSparkNativeMarket) ||
        isSghoNativeSubject ||
        isUsd3NativeSubject ||
        isSusdsNativeSubject ||
        isStusdsNativeSubject ||
        isCometNativeSubject
          ? localHistoricalSampledCashTimeline(receipts, cashSubject)
          : { status: 'unavailable' as const, reason: 'insufficient_eligible_history' as const }
      const sampledRequestedRaw =
        cashAssetMatchesPayout && sampledHistory.status === 'sampled_timeline'
          ? exactForecastAssetsRaw(amountRaw, sampledHistory.identity.assetDecimals)
          : null
      // The normal request is a sealed-history read. Live enrichment is an
      // explicit second request so an RPC stall cannot delay its HTTP result.
      const includeLiveCurrent = isInitialDeposit
        ? question.includeLiveCurrent !== '0'
        : req.query.includeLiveCurrent === '1'
      const isAaveUsdcCashSubject =
        routeKey === DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey &&
        destination === DIRECT_SUPPLY_MARKETS.aaveV3Usdc.destination.toLowerCase() &&
        payoutAsset === DIRECT_SUPPLY_MARKETS.aaveV3Usdc.underlying.toLowerCase() &&
        cashSubject.asset.toLowerCase() === payoutAsset
      let liveCurrent: CarryLiveCurrentCash | undefined
      if (
        includeLiveCurrent &&
        ((historicalContext?.status === 'historical_context' &&
          historicalContext.sampleCount === 60 &&
          historicalContext.current?.freshness !== 'fresh') ||
          (sampledHistory.status === 'sampled_timeline' &&
            (!sampledHistory.current ||
              Date.now() - Date.parse(sampledHistory.current.blockAt) >
                CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000 ||
              Date.parse(sampledHistory.current.blockAt) > Date.now())) ||
          (sampledHistory.status !== 'sampled_timeline' && analogCashProfile !== null))
      )
        // The existing configured native reader only supports the frozen core
        // manifest. Supplemental USDe retains its separately verified receipt.
        liveCurrent = isSupplementalCashSubject
          ? { status: 'unavailable', reason: 'supplemental_live_current_not_supported' }
          : await boundedLiveCurrentCashRead({ routeKey, destination }, manifest, {
              maxSourceAgeMs: CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000,
            })
      // Recheck source age after the bounded RPC await, at response assembly time.
      scenarioAsOfMs = Date.now()
      const sampledCurrent =
        sampledHistory.status === 'sampled_timeline'
          ? sampledReadOnlyCurrentCash(sampledHistory, liveCurrent, scenarioAsOfMs)
          : null
      const sampledReplay: HistoricalSampledCashPathsResult =
        sampledHistory.status === 'sampled_timeline' && sampledRequestedRaw && sampledCurrent
          ? replaySampledHistoricalCashPaths({
              identity: sampledHistory.identity,
              requestedRaw: sampledRequestedRaw,
              current: sampledCurrent,
              timelineIdentity: {
                subjectKey: sampledHistory.subjectKey,
                asset: sampledHistory.identity.asset,
                assetDecimals: sampledHistory.identity.assetDecimals,
              },
              timeline: sampledHistory.timeline,
              asOfMs: scenarioAsOfMs,
            })
          : {
              status: 'unavailable',
              reason: !cashAssetMatchesPayout
                ? 'subject_mismatch'
                : sampledHistory.status !== 'sampled_timeline'
                  ? 'insufficient_eligible_history'
                  : !sampledRequestedRaw
                    ? 'invalid_requested_raw'
                    : 'invalid_current_source',
              claim: 'aggregate_endpoint_cash_proxy_only',
              prospectiveValidated: false,
              holderExecutableExit: false,
              forwardProbability: false,
            }
      const sampledCashPaths: HistoricalSampledCashPathsResult & {
        historyCoverage?: SampledCashHistoryCoverage
      } = {
        ...sampledReplay,
        ...(sampledHistory.status === 'sampled_timeline'
          ? { historyCoverage: sampledHistory.coverage }
          : {}),
      }
      const acceptedHistoricalContext =
        historicalContext?.status === 'historical_context' && liveCurrent
          ? withReadOnlyCurrentCash(historicalContext, cashSubject, liveCurrent, scenarioAsOfMs)
          : historicalContext
      const liveCurrentRead =
        historicalContext?.status === 'historical_context' && liveCurrent
          ? currentReadStatus(historicalContext, acceptedHistoricalContext!, liveCurrent)
          : null
      const localHistoricalScenario =
        destination !== TWYNE_WRAPPER && horizonHours === 24
          ? localHistoricalCashScenario(receipts, cashSubject, scenarioAsOfMs, liveCurrent)
          : { status: 'unavailable' as const, reason: 'not_24h_or_untracked' as const }
      const conditionalExitImpact = normalizeConditionalQualificationReason(
        localHistoricalPairs.status === 'historical_pairs' && requestedAssetsRaw
          ? buildExitImpactForecast({
              kind: 'conditional_projection',
              identity: {
                routeKey: localHistoricalPairs.routeKey,
                destination: localHistoricalPairs.destination,
                asset: localHistoricalPairs.asset,
                assetDecimals: localHistoricalPairs.assetDecimals,
              },
              requestedRaw: requestedAssetsRaw,
              horizonHours: 24,
              scenario:
                localHistoricalScenario.status === 'unavailable' &&
                localHistoricalScenario.reason === 'not_24h_or_untracked'
                  ? { status: 'unavailable', reason: 'insufficient_long_history' }
                  : localHistoricalScenario,
            })
          : null,
        localModelQualificationReason,
      )
      const localHistoricalScenarioResponse = normalizeLocalHistoricalScenarioReason(
        localHistoricalScenario,
        localModelQualificationReason,
      )
      const localCashQHoldout =
        destination !== TWYNE_WRAPPER && horizonHours === 24 && requestedAssetsRaw
          ? localHistoricalCashQHoldout(
              receipts,
              cashSubject,
              requestedAssetsRaw,
              scenarioAsOfMs,
              liveCurrent,
            )
          : {
              status: 'unavailable' as const,
              reason:
                horizonHours !== 24
                  ? ('not_24h' as const)
                  : destination === TWYNE_WRAPPER
                    ? ('not_enrolled' as const)
                    : ('invalid_requested_assets' as const),
              backtest: null,
            }
      // This independent future field reuses the verified daily history, never
      // fitted-pair/model qualification. The source is the accepted C2 baseline.
      const sampledHistoryEvidence =
        sampledHistory.status === 'sampled_timeline'
          ? conditionalSampledCashHistoryFromVerifiedTimeline(receipts, sampledHistory)
          : null
      const sourceReceipt =
        sampledCurrent && !sampledCurrent.sourceKind
          ? receipts.find(
              (entry) =>
                entry.collectionMode === 'current' &&
                entry.source.block === sampledCurrent.block &&
                entry.source.blockHash === sampledCurrent.blockHash &&
                entry.source.blockAt === sampledCurrent.blockAt &&
                entry.firstLocalReceiptAt === sampledCurrent.firstLocalReceiptAt &&
                entry.subjects.some(
                  (row) =>
                    row.routeKey === routeKey &&
                    row.destination === destination &&
                    row.state === 'observed' &&
                    row.asset === cashSubject.asset &&
                    row.assetDecimals === sampledHistoryEvidence?.identity.assetDecimals &&
                    row.cashRaw === sampledCurrent.cashRaw,
                ),
            )
          : null
      const sampledProjectionCurrent: ConditionalSampledCashCurrentSource | null =
        sampledCurrent &&
        sampledHistoryEvidence &&
        (sampledCurrent.sourceKind === 'live_read_only_two_origin_finalized' || sourceReceipt)
          ? {
              ...sampledHistoryEvidence.identity,
              chainId: 1,
              cashRaw: sampledCurrent.cashRaw,
              block: sampledCurrent.block,
              blockHash: sampledCurrent.blockHash,
              blockTime: sampledCurrent.blockAt,
              readAt: sampledCurrent.readAtUtc ?? sourceReceipt!.firstLocalReceiptAt,
              sourceKind: sampledCurrent.sourceKind ?? 'manifest_bound_ledger',
              ...(sourceReceipt
                ? {
                    manifestSha256: sourceReceipt.manifestSha256,
                    receiptSha256: sourceReceipt.receiptSha256,
                  }
                : {}),
            }
          : null
      const aaveCompetingFlow = isAaveUsdcCashSubject ? readAaveHistoricalCompetingFlow() : null
      const flowHash = (s: string) => createHash('sha256').update(s).digest('hex')
      // Both the manifest-bound sealed receipt verifier and the agreed live
      // reader attest C2. Genuine receipt clocks never become fabricated live clocks.
      let conditionalGrossFlowHeadroom:
        | ReturnType<typeof buildConditionalGrossFlowHeadroom>
        | { status: 'unavailable'; reason: 'current_source_conflict' }
        | null = isAaveUsdcCashSubject
        ? buildConditionalGrossFlowHeadroom(
            {
              currentSource:
                liveCurrent?.status === 'available' &&
                liveCurrent.sourceKind === 'live_read_only_two_origin_finalized'
                  ? {
                      chainId: 1,
                      routeKey: liveCurrent.routeKey,
                      destination: liveCurrent.destination,
                      asset: liveCurrent.asset,
                      assetDecimals: liveCurrent.assetDecimals,
                      cashRaw: liveCurrent.cashRaw,
                      blockNumber:
                        typeof liveCurrent.block === 'string' &&
                        /^(0|[1-9][0-9]{0,77})$/.test(liveCurrent.block) &&
                        BigInt(liveCurrent.block) <= BigInt(Number.MAX_SAFE_INTEGER)
                          ? Number(liveCurrent.block)
                          : Number.NaN,
                      blockHash: liveCurrent.blockHash,
                      blockTime: liveCurrent.blockAt,
                      readAt: liveCurrent.readAtUtc,
                      finalized: true,
                    }
                  : sampledProjectionCurrent?.sourceKind === 'manifest_bound_ledger' &&
                      sourceReceipt
                    ? {
                        chainId: 1,
                        routeKey: sampledProjectionCurrent.routeKey,
                        destination: sampledProjectionCurrent.destination,
                        asset: sampledProjectionCurrent.asset,
                        assetDecimals: sampledProjectionCurrent.assetDecimals,
                        cashRaw: sampledProjectionCurrent.cashRaw,
                        blockNumber:
                          typeof sampledProjectionCurrent.block === 'string' &&
                          /^(0|[1-9][0-9]{0,77})$/.test(sampledProjectionCurrent.block) &&
                          BigInt(sampledProjectionCurrent.block) <= BigInt(Number.MAX_SAFE_INTEGER)
                            ? Number(sampledProjectionCurrent.block)
                            : Number.NaN,
                        blockHash: sampledProjectionCurrent.blockHash,
                        blockTime: sampledProjectionCurrent.blockTime,
                        readAt: sourceReceipt.firstLocalReceiptAt,
                        finalized: true,
                      }
                    : null,
              request: {
                requestedRaw: exactForecastAssetsRaw(amountRaw, 6) ?? '',
                asOf: new Date(Date.now()).toISOString(),
              },
              historicalFlow: aaveCompetingFlow,
            },
            flowHash,
          )
        : null
      if (
        (conditionalGrossFlowHeadroom?.status === 'estimated' ||
          (conditionalGrossFlowHeadroom?.status === 'unavailable' &&
            ['source_stale', 'future_window_unavailable'].includes(
              conditionalGrossFlowHeadroom.reason,
            ))) &&
        liveCurrent?.status === 'available'
      ) {
        const sameLiveSource = (
          current:
            | {
                cashRaw: string
                block: string
                blockHash: string
                blockAt: string
                readAtUtc?: string
                sourceKind?: string
              }
            | null
            | undefined,
        ) =>
          current?.cashRaw === liveCurrent.cashRaw &&
          current.block === liveCurrent.block &&
          current.blockHash === liveCurrent.blockHash &&
          current.blockAt === liveCurrent.blockAt &&
          current.readAtUtc === liveCurrent.readAtUtc &&
          current.sourceKind === liveCurrent.sourceKind
        if (
          (sampledHistory.status === 'sampled_timeline' && !sameLiveSource(sampledCurrent)) ||
          (historicalContext?.status === 'historical_context' &&
            historicalContext.current !== null &&
            (acceptedHistoricalContext?.status !== 'historical_context' ||
              !sameLiveSource(acceptedHistoricalContext.current)))
        )
          conditionalGrossFlowHeadroom = {
            status: 'unavailable',
            reason: 'current_source_conflict',
          }
      }
      // Expose genuine sealed-current witness beside the independent sampled
      // current, so the browser never treats the projection's own C2 as proof.
      if (sourceReceipt && sampledCashPaths.status === 'conditional_historical_sampled_cash_paths')
        Object.assign(sampledCashPaths.current, {
          manifestSha256: sourceReceipt.manifestSha256,
          receiptSha256: sourceReceipt.receiptSha256,
        })
      let conditionalSampledCashPathProjection: ConditionalSampledCashPathProjection =
        !cashAssetMatchesPayout
          ? { status: 'unavailable', reason: 'subject_mismatch' }
          : sampledHistory.status !== 'sampled_timeline'
            ? { status: 'unavailable', reason: 'insufficient_eligible_history' }
            : buildConditionalSampledCashPathProjection(
                {
                  history: sampledHistoryEvidence,
                  currentSource: sampledProjectionCurrent,
                  request: {
                    requestedRaw: sampledRequestedRaw ?? '',
                    asOf: new Date(Date.now()).toISOString(),
                  },
                },
                flowHash,
              )
      if (
        sampledHistoryEvidence &&
        sampledRequestedRaw &&
        cashAssetMatchesPayout &&
        liveCurrent?.status === 'available' &&
        (!sampledCurrent ||
          sampledCurrent.cashRaw !== liveCurrent.cashRaw ||
          sampledCurrent.block !== liveCurrent.block ||
          sampledCurrent.blockHash !== liveCurrent.blockHash ||
          sampledCurrent.blockAt !== liveCurrent.blockAt ||
          sampledCurrent.readAtUtc !== liveCurrent.readAtUtc ||
          sampledCurrent.sourceKind !== liveCurrent.sourceKind)
      ) {
        // Validate primitives without promoting a rejected live header over the
        // independently selected baseline; preserve malformed-source reasons.
        const candidate = buildConditionalSampledCashPathProjection(
          {
            history: sampledHistoryEvidence,
            currentSource: {
              chainId: 1,
              routeKey: liveCurrent.routeKey,
              destination: liveCurrent.destination,
              asset: liveCurrent.asset,
              assetDecimals: liveCurrent.assetDecimals,
              cashRaw: liveCurrent.cashRaw,
              block: liveCurrent.block,
              blockHash: liveCurrent.blockHash,
              blockTime: liveCurrent.blockAt,
              readAt: liveCurrent.readAtUtc,
              sourceKind: liveCurrent.sourceKind,
            },
            request: {
              requestedRaw: sampledRequestedRaw,
              asOf: new Date(Date.now()).toISOString(),
            },
          },
          flowHash,
        )
        conditionalSampledCashPathProjection =
          candidate.status === 'unavailable' &&
          [
            'invalid_current_source',
            'subject_mismatch',
            'time_invalid',
            'history_unverified',
          ].includes(candidate.reason)
            ? candidate
            : { status: 'unavailable', reason: 'current_source_conflict' }
      }
      if (
        conditionalSampledCashPathProjection.status === 'estimated' &&
        historicalContext?.status === 'historical_context' &&
        historicalContext.current &&
        acceptedHistoricalContext?.status === 'historical_context'
      ) {
        const selected = acceptedHistoricalContext.current
        if (
          !sampledCurrent ||
          !selected ||
          selected.cashRaw !== sampledCurrent?.cashRaw ||
          selected.block !== sampledCurrent.block ||
          selected.blockHash !== sampledCurrent.blockHash ||
          selected.blockAt !== sampledCurrent.blockAt ||
          selected.readAtUtc !== sampledCurrent.readAtUtc ||
          selected.sourceKind !== sampledCurrent.sourceKind
        )
          conditionalSampledCashPathProjection = {
            status: 'unavailable',
            reason: 'current_source_conflict',
          }
      }
      const analogCashScenario = issueAnalogCashScenario({
        currentLedger: cashLedger ?? supplementalCashLedger,
        donorLedger:
          cashLedger ??
          (conditionalSampledCashPathProjection.status === 'unavailable' &&
          conditionalSampledCashPathProjection.reason === 'insufficient_eligible_history' &&
          analogCashProfile !== null
            ? verifyAnalogCashLedger(manifest, LOCAL_CARRY_CASH_ROOT)
            : null),
        subject: cashSubject,
        liveCurrent,
        requestedRaw:
          cashAssetMatchesPayout && analogCashProfile
            ? exactForecastAssetsRaw(amountRaw, analogCashProfile.identity.assetDecimals)
            : null,
        horizonHours,
        issueAtUtc: new Date(Date.now()).toISOString(),
        nativeProjection: conditionalSampledCashPathProjection,
        currentSourceConflict:
          (liveCurrent?.status === 'unavailable' &&
            ['cash_origin_disagreement', 'finalized_block_disagreement'].includes(
              liveCurrent.reason,
            )) ||
          (conditionalSampledCashPathProjection.status === 'unavailable' &&
            conditionalSampledCashPathProjection.reason === 'current_source_conflict') ||
          (conditionalGrossFlowHeadroom?.status === 'unavailable' &&
            conditionalGrossFlowHeadroom.reason === 'current_source_conflict'),
      })
      const fluidProtocolCapacityProjection = isFluidProtocolProjectionSubject(fluidSubject)
        ? !includeLiveCurrent
          ? { status: 'unavailable', reason: 'live_current_not_requested' }
          : conditionalSampledCashPathProjection.status === 'unavailable' &&
              conditionalSampledCashPathProjection.reason === 'current_source_conflict'
            ? { status: 'unavailable', reason: 'current_source_conflict' }
            : sampledCurrent &&
                typeof sampledCurrent.block === 'string' &&
                /^[1-9][0-9]*$/.test(sampledCurrent.block) &&
                Number.isSafeInteger(Number(sampledCurrent.block)) &&
                sampledCurrent.blockHash &&
                sampledRequestedRaw
              ? await readFluidProtocolCapacityProjection(
                  fluidSubject!,
                  {
                    chainId: 1,
                    blockNumber: Number(sampledCurrent.block),
                    blockHash: sampledCurrent.blockHash,
                    blockTime: sampledCurrent.blockAt,
                    finalized: true,
                  },
                  sampledRequestedRaw,
                  horizonHours,
                )
              : { status: 'unavailable', reason: 'missing_current_source' }
        : null
      const aaveSparkCapacityFields = aaveSparkNativeMarket
        ? aaveSparkCapacityApiFields({
            current: sampledProjectionCurrent,
            requestedRaw: sampledRequestedRaw,
            horizonHours,
            asOfMs: Date.now(),
            jointProjection: conditionalGrossFlowHeadroom,
            dailyProjection: conditionalSampledCashPathProjection,
            currentSourceConflict:
              (conditionalSampledCashPathProjection.status === 'unavailable' &&
                conditionalSampledCashPathProjection.reason === 'current_source_conflict') ||
              (conditionalGrossFlowHeadroom?.status === 'unavailable' &&
                conditionalGrossFlowHeadroom.reason === 'current_source_conflict'),
          })
        : null
      // Native reads enrich only the new hypothetical deposit issue; existing
      // baseline source, receipt clocks and forecast fields are retained.
      let initialDepositProjection
      if (isInitialDeposit) {
        let nativeFacts: any = { status: 'unavailable', reason: 'native_facts_not_requested' }
        if (
          includeLiveCurrent &&
          sampledProjectionCurrent &&
          conditionalSampledCashPathProjection.status === 'estimated'
        ) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const nativeReadController = new AbortController()
          try {
            nativeFacts = await Promise.race([
              readConfiguredInitialDepositNativeFacts(sampledProjectionCurrent, {
                cache: true,
                signal: nativeReadController.signal,
              }).catch(() => ({
                status: 'unavailable',
                reason: 'initial_deposit_native_read_failed',
              })),
              new Promise((resolve) => {
                timer = setTimeout(() => {
                  nativeReadController.abort()
                  resolve({
                    status: 'unavailable',
                    reason: 'initial_deposit_native_read_timeout',
                  })
                }, LIVE_CURRENT_READ_DEADLINE_MS)
              }),
            ])
          } finally {
            if (timer) clearTimeout(timer)
            nativeReadController.abort()
          }
        }
        initialDepositProjection = buildInitialDepositCapacityProjection(
          {
            currentSource: sampledProjectionCurrent,
            dailyProjection: conditionalSampledCashPathProjection,
            depositAssetsRaw,
            plannedExitAssetsRaw,
            horizonHours,
            asOfMs: Date.now(),
            nativeAgreement:
              nativeFacts.status === 'agreed_initial_deposit_native_facts' ? nativeFacts : null,
            nativeUnavailableReason:
              nativeFacts.status === 'unavailable' ? nativeFacts.reason : undefined,
          },
          flowHash,
        )
      }
      // Only the existing strict native-history decoder and accepted current
      // source may supply this unsigned cash context. Proxy final assets abstain.
      const conditionalEventImpact =
        !isInitialDeposit &&
        cashAssetMatchesPayout &&
        sampledHistoryEvidence &&
        sampledHistoryEvidence.points.length >= 8 &&
        sampledProjectionCurrent &&
        sampledRequestedRaw &&
        (conditionalSampledCashPathProjection.status === 'estimated' ||
          (conditionalSampledCashPathProjection.status === 'unavailable' &&
            ['insufficient_eligible_history', 'future_window_unavailable'].includes(
              conditionalSampledCashPathProjection.reason,
            )))
          ? buildConditionalEventImpact({
              question: {
                ...sampledHistoryEvidence.identity,
                requestedRaw: sampledRequestedRaw,
                horizonHours,
                issuedAtUtc: new Date(Date.now()).toISOString(),
              },
              currentSource: sampledProjectionCurrent,
              history: sampledHistoryEvidence,
            })
          : null
      return res.status(200).json({
        routeKey,
        destination,
        source: 'prospective_finalized_observations',
        evidenceStore: 'local_sha_replayed_finalized_rpc',
        localCashStatus: checked.status === 'available' ? 'observed' : checked.reason,
        forecast,
        ...(isInitialDeposit ? { initialDepositProjection } : {}),
        ...(isAaveUsdcCashSubject ? { conditionalGrossFlowHeadroom } : {}),
        ...(aaveSparkCapacityFields ?? {}),
        ...(isStusdsNativeSubject
          ? {
              stusdsHistoricalCapacityEvidence: {
                history: stusdsPinnedProtocolHistory(),
                currentSource:
                  conditionalSampledCashPathProjection.status === 'estimated'
                    ? sampledProjectionCurrent
                    : null,
                holderEntitlementRequired: true,
                currentProtocolEvidenceRequired: true,
                holderExecutableExit: false,
                forecastValidated: false,
              },
            }
          : {}),
        ...(isSusdsNativeSubject
          ? {
              susdsHistoricalCapacityEvidence: {
                history: susdsPinnedIndexHistory(),
                // This accepted cash receipt supplies a source locator, not a holder entitlement.
                currentSource:
                  conditionalSampledCashPathProjection.status === 'estimated'
                    ? sampledProjectionCurrent
                    : null,
                holderEntitlementRequired: true,
                holderExecutableExit: false,
                forecastValidated: false,
              },
            }
          : {}),
        ...(fluidProtocolCapacityProjection ? { fluidProtocolCapacityProjection } : {}),
        ...(fluidProtocolCapacityProjection?.status === 'fluid_protocol_capacity_projection'
          ? {
              fluidProtocolCapacityProngs: {
                currentProngs: fluidProtocolCapacityProjection.currentProngs,
                readAtUtc: fluidProtocolCapacityProjection.currentReadAtUtc,
              },
            }
          : {}),
        liveCurrentRead,
        localHistoricalScenario: localHistoricalScenarioResponse,
        exitImpact: {
          historicalBacktest: aaveCompetingFlow
            ? withHistoricalCompetingFlow(historicalExitImpact, aaveCompetingFlow, flowHash)
            : historicalExitImpact,
          historicalBacktestUnavailableReason: historicalExitImpactUnavailableReason,
          conditionalProjection: aaveCompetingFlow
            ? withHistoricalCompetingFlow(conditionalExitImpact, aaveCompetingFlow, flowHash)
            : conditionalExitImpact,
        },
        sampledCashPaths,
        conditionalSampledCashPathProjection,
        conditionalEventImpact,
        conditionalEventImpactCurrentSource: conditionalEventImpact
          ? sampledProjectionCurrent
          : null,
        analogCashScenario,
        localCashQHoldout,
        baselineEvidence: localCashIssueEvidence(
          issueLedger?.records ?? [],
          routeKey,
          destination,
          horizonHours,
          !isSupplementalCashSubject,
        ),
        historicalModel,
        prospectiveCashModel,
        localCarryExitV2Evidence,
        twynePtReserveModel:
          destination === TWYNE_WRAPPER && horizonHours === 1
            ? { status: 'unavailable', reason: 'ledger_unavailable' }
            : null,
        validation: {
          holderExit: 'unavailable',
          conditionDuration: 'unavailable',
          predictiveAlert: 'unavailable',
        },
      })
    } catch {
      // A malformed receipt, manifest change, or read failure is not an empty
      // series. Never silently fall back to DB or old cash on a broken chain.
      return res.status(503).json({ error: 'local_cash_evidence_unavailable' })
    }
  }

  // The Twyne forecast measures the shared Aave PT reserve. Its own finalized
  // source and ledger remain valid when the wrapper's generic cash read fails.
  if (destination === TWYNE_WRAPPER) {
    const [baselineEvidence, twynePtReserveModel] = await Promise.all([
      readCashIssueEvidence({
        routeKey,
        destination,
        asset: TWYNE_PT,
        source: 'vault',
        horizonHours,
      }),
      horizonHours === 1 ? readTwynePtReserveModelEvidence() : Promise.resolve(null),
    ])
    const forecast = forecastRouteCash({
      routeKey,
      destination,
      asset: TWYNE_PT,
      assetSymbol: routeKey.match(/\[([^\]]+)\]$/)?.[1] ?? 'PT',
      amountUnits,
      horizonHours,
      asOf: new Date().toISOString(),
      snapshots: [],
      cashKind: 'unassessed',
    })
    return res.status(200).json({
      routeKey,
      destination,
      source: 'prospective_finalized_observations',
      forecast,
      baselineEvidence,
      historicalModel: { status: 'unavailable', reason: 'not_enrolled' },
      prospectiveCashModel,
      localCarryExitV2Evidence,
      twynePtReserveModel,
      validation: {
        holderExit: 'unavailable',
        conditionDuration: 'unavailable',
        predictiveAlert: 'unavailable',
      },
    })
  }

  const market = markets.find(
    (row) => row.routeKey === routeKey && row.destination.toLowerCase() === destination,
  )
  const source = market ? ('market' as const) : ('vault' as const)
  try {
    const rows = (
      source === 'market'
        ? await db.execute(sql`
            SELECT route_key, destination, underlying, underlying_decimals, chain_id,
              cash_raw, block, block_hash, observed_at, first_local_receipt_at
            FROM carry_direct_supply_observations
            WHERE route_key = ${routeKey} AND destination = ${destination}
            ORDER BY block DESC LIMIT ${MAX_ROWS + 1}`)
        : await db.execute(sql`
            SELECT route_key, vault, asset, asset_decimals, cash_raw, block, block_hash,
              observed_at, first_local_receipt_at, cohort_id, seed_sha256,
              board_sha256, displayed_routes_sha256, seed_source_sha256
            FROM carry_route_vault_observations
            WHERE route_key = ${routeKey} AND vault = ${destination}
            ORDER BY block DESC LIMIT ${MAX_ROWS + 1}`)
    ).rows as ObservationRow[]
    if (rows.length > MAX_ROWS) return res.status(503).json({ error: 'forecast_series_truncated' })
    if (!rows.length)
      return res.status(200).json({
        status: 'unavailable',
        reason: 'no_prospective_samples',
        prospectiveCashModel,
        localCarryExitV2Evidence,
      })

    const latestAsset = String(
      source === 'market' ? rows[0].underlying : rows[0].asset,
    ).toLowerCase()
    const decimals = Number(
      source === 'market' ? rows[0].underlying_decimals : rows[0].asset_decimals,
    )
    const configured = recorderConfig.venues.find(
      (venue) => venue.enabled && venue.address.toLowerCase() === destination,
    )
    const configuredAsset =
      configured && 'underlying' in configured && typeof configured.underlying === 'string'
        ? configured.underlying.toLowerCase()
        : null
    const morphoAsset = morphoAssetByVault.get(destination) ?? null
    const otherAsset = checkOtherVaultAssetIdentity(destination, latestAsset)
    const expectedAsset =
      market?.underlying.toLowerCase() ?? configuredAsset ?? morphoAsset ?? otherAsset?.asset
    if (!expectedAsset || latestAsset !== expectedAsset || otherAsset?.match === false) {
      return res.status(200).json({
        status: 'unavailable',
        reason: 'asset_identity_unverified',
        prospectiveCashModel,
        localCarryExitV2Evidence,
      })
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      return res.status(200).json({
        status: 'unavailable',
        reason: 'asset_decimals_unverified',
        prospectiveCashModel,
        localCarryExitV2Evidence,
      })
    }
    const baselineEvidence = await readCashIssueEvidence({
      routeKey,
      destination,
      asset: expectedAsset,
      source,
      horizonHours,
    })
    const vaultProvenance =
      source === 'vault'
        ? {
            seedSha256: sha256('scripts/route-cohort/aug-2026-ab-vault-seed.json'),
            boardSha256: sha256('components/Carry/route-capital.json'),
            displayedRoutesSha256: sha256('components/Carry/fixtures.ts'),
            seedSourceSha256: seed.source.sha256,
            cohortId: seed.cohortId,
          }
        : null
    // Old immutable receipts remain in the table after a manifest change.
    // Only the current segment enters the current-sample engine.
    const currentRows = vaultProvenance
      ? rows.filter(
          (row) =>
            row.seed_sha256 === vaultProvenance.seedSha256 &&
            row.board_sha256 === vaultProvenance.boardSha256 &&
            row.displayed_routes_sha256 === vaultProvenance.displayedRoutesSha256 &&
            row.seed_source_sha256 === vaultProvenance.seedSourceSha256 &&
            row.cohort_id === vaultProvenance.cohortId,
        )
      : rows
    const samples = checkedRouteCashSamples(currentRows, {
      routeKey,
      destination,
      asset: expectedAsset,
      decimals,
      source,
      ...(vaultProvenance ?? {}),
      unassessedCash: destination === TWYNE_WRAPPER,
    })
    const historicalModel = await readHistoricalModelEvidence({
      routeKey,
      destination,
      asset: expectedAsset,
      horizonHours,
      assetDecimals: decimals,
    })
    const twynePtReserveModel =
      destination === TWYNE_WRAPPER && horizonHours === 1
        ? await readTwynePtReserveModelEvidence()
        : null
    const assetSymbol = routeKey.match(/\[([^\]]+)\]$/)?.[1] ?? routeKey.split(' → ')[0]
    const forecast = forecastRouteCash({
      routeKey,
      destination,
      asset: expectedAsset,
      assetSymbol,
      amountUnits,
      horizonHours,
      asOf: new Date().toISOString(),
      snapshots: samples ?? [],
      cashKind:
        source === 'market'
          ? 'market_cash'
          : destination === TWYNE_WRAPPER
            ? 'unassessed'
            : destination === USD3_VAULT
              ? 'direct_buffer_only'
              : 'vault_cash',
    })
    return res.status(200).json({
      routeKey,
      destination,
      source: 'prospective_finalized_observations',
      forecast,
      baselineEvidence,
      historicalModel,
      prospectiveCashModel,
      localCarryExitV2Evidence,
      twynePtReserveModel,
      analogCashScenario: {
        status: 'unqualified',
        reason: 'authenticated_current_source_unavailable',
        Ea: null,
      },
      validation: {
        holderExit: 'unavailable',
        conditionDuration: 'unavailable',
        predictiveAlert: 'unavailable',
      },
    })
  } catch {
    return res.status(503).json({ error: 'route_forecast_evidence_unavailable' })
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return carryForecastRequest(req, res)
}
