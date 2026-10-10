import type { MorphoHolderPositionObservation } from './morphoV2HolderPositionEvidence'
import type { StusdsProtocolOriginObservation } from './stusdsCurrentProtocolCapacityEvidence'
import type { MorphoV2ProtocolOriginObservation } from './morphoV2ProtocolCapacityReplay'
import type { SusdeProtocolOriginObservation } from './susdeCurrentProtocolCapacity'
import type {
  CometWithdrawFacts,
  CometWithdrawFactsAgreement,
} from './cometHolderCapacityProjection'
import {
  buildHolderExitCapacityQuote,
  resolveHolderExitCapacitySubject,
  type HolderExitCapacityFacts,
  type HolderExitCapacityQuote,
} from './holderExitCapacity'
import { resolveIssuedHolderExitSubject } from './holderExitMechanisms'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'
export { resolveHolderExitSubject } from './holderExitSubjectRegistry'
import type { Address, PublicClient } from 'viem'

import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'

import {
  APXUSD_ASSET,
  readApyUsdExit,
  type ApyUsdExitClient,
  type ApyUsdExitResult,
} from './apyUsdExit'
import { projectApyUsdNet, validApyUsdFeeCurve, type ApyUsdFeeCurve } from './apyUsdFeeOutlook'
import {
  readDirectSupplyExitQuote,
  type DirectSupplyExitClient,
  type DirectSupplyHistoricalFinalizedBlock,
} from './directSupplyExitQuote'
import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'
import { isEoaTransactionOriginCode } from './holderOriginCode'
import {
  readMorphoExitQuote,
  resolveMorphoExitTarget,
  type MorphoExitClient,
} from './morphoExitQuote'
import {
  HASTRA_STAKING_VAULT,
  HASTRA_YIELD_VAULT,
  PYUSD_TOKEN,
  USDC_TOKEN,
  readPyusdStakingRouteIdentity,
  type PyusdStakingRouteIdentity,
} from './pyusdStakingRouteIdentity'
import { readPyusdStakingFirstLeg } from './pyusdStakingFirstLeg'
import { readPyusdStakingYieldQueue, type PyusdStakingYieldQueue } from './pyusdStakingYieldQueue'
import { readSghoExit } from './sghoExit'
import {
  readSaturnTicketConversionQuote,
  type SaturnTicketConversionQuote,
} from './saturnTicketConversionQuote'
import {
  readStakedUsdatExit,
  STAKED_USDAT_QUEUE,
  USDAT_ASSET,
  type StakedUsdatRecordedRequest,
} from './stakedUsdatExit'
import {
  readSusdeCooldownExitQuote,
  type SusdeHolderFacts,
  resolveSusdeCooldownExitTarget,
} from './susdeCooldownExitQuote'
import { USDS_ASSET, readSusdsExitQuote } from './susdsExitQuote'
import {
  readTrackedDirectVaultExit,
  type TrackedDirectVaultExitClient,
} from './trackedDirectVaultExit'
import { readTwyneBorrowerExit, TWYNE_PT_BORROWER_DEPLOYMENT } from './twyneBorrowerExit'
import { TWYNE_AAVE_POOL, TWYNE_PT_ASSET, TWYNE_PT_ROUTE, TWYNE_PT_WRAPPER } from './twynePtExit'
import { ORIGINAL_GHO, readUmbrellaGhoExit, type UmbrellaGhoAmountCheck } from './umbrellaGhoExit'
import { readUsd3ExitQuote } from './usd3ExitQuote'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW = /^[1-9][0-9]{0,77}$/
const MAX_U256 = (1n << 256n) - 1n
export const MAX_CURRENT_EXIT_BLOCK_AGE_MS = 30 * 60_000

export function isCurrentHolderExitAssessment(
  assessment: HolderExitAssessment,
  nowMs: number,
): boolean {
  const blockMs = Date.parse(assessment.source.blockTime)
  const ageMs = nowMs - blockMs
  if (!Number.isFinite(blockMs) || ageMs < 0 || ageMs > MAX_CURRENT_EXIT_BLOCK_AGE_MS) return false
  const condition = assessment.condition
  if (condition?.gate === 'window_open')
    return (
      condition.windowEndInclusive !== null &&
      Number.isSafeInteger(condition.windowEndInclusive) &&
      nowMs < (condition.windowEndInclusive + 1) * 1000
    )
  if (condition?.gate === 'waiting')
    return (
      condition.cooldownEnd !== null &&
      Number.isSafeInteger(condition.cooldownEnd) &&
      nowMs < condition.cooldownEnd * 1000
    )
  const pending = assessment.cooldownCondition
  if (pending?.pendingClaimStatus === 'not_yet_eligible') {
    const earliestMs = Date.parse(pending.pendingClaimEarliestAt ?? '')
    return Number.isFinite(earliestMs) && nowMs < earliestMs
  }
  return true
}
export const FLUID_USDT_ROUTE = 'USDT → FluidBridgeAggregatorProxy [USDC]'
export const FLUID_BRIDGE_VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012' as Address
export const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7' as Address
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
export const SGHO_ROUTE_KEY = 'GHO → sGho [GHO]'
export const AUSD_ASSET = '0x00000000efe302beaa2b3e6e1b18d08d69a9012a' as Address
export const USDE_ASSET = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3' as Address

export type HolderExitAssessmentRequest = {
  routeKey: string
  destinationAddress: Address
  owner: Address
  /** Original requested payout asset units. */
  assetsRaw: string
  horizonHours: number
  /** USDC units, independent of USDT Q; required only on the USDT bridge route. */
  firstLegUsdcRaw?: string
  receiptTokenId?: string
  /** Independent sUSDat share probe; never inferred from the original AUSD Q. */
  sharesRaw?: string
  /** Existing sUSDat queue ticket, independent of the new share request and AUSD Q. */
  requestTokenId?: string
  /** Independent Twyne collateral vault containing the wrapper shares. */
  collateralVault?: Address
  /** Independent PT first-leg amount; never inferred from original USDe Q. */
  ptRaw?: string
  /** PRIME vault shares, independent of the original PYUSD payout amount. */
  primeSharesRaw?: string
}

export type HolderExitStage = {
  name:
    | 'withdrawal'
    | 'receipt_initiation'
    | 'receipt_claim'
    | 'cooldown_initiation'
    | 'pending_claim'
    | 'queue_request'
    | 'existing_ticket_claim'
    | 'pt_redemption'
    | 'prime_redemption'
    | 'usdc_vault_withdrawal'
    | 'usdc_to_usdt_conversion'
    | 'usdt_delivery'
    | 'redeem'
  assetAddress: Address | null
  status: 'simulated' | 'reverted' | 'unassessed'
  amountRaw: string | null
  relatedToRequest: boolean
}

export type HolderExitAssessment = {
  /** Private observations from the exact client behind an agreeing required assay. */
  susdeProtocolCapacityObservation?: SusdeProtocolOriginObservation | null
  susdeHolderFacts?: SusdeHolderFacts
  stusdsProtocolCapacityObservation?: StusdsProtocolOriginObservation | null
  /** Private optional native bytes; public responses carry only an agreed compact pair. */
  morphoV2ProtocolCapacityObservation?: MorphoV2ProtocolOriginObservation | null
  /** Private native holder traces; API transports only a verified encoded pair. */
  morphoHolderPositionObservation?: MorphoHolderPositionObservation | null
  capacityQuote?: HolderExitCapacityQuote
  cometFacts?: CometWithdrawFacts
  cometFactsAgreement?: CometWithdrawFactsAgreement
  status: 'assessed' | 'partial' | 'unsupported'
  unsupportedReason?: PyusdStakingRouteIdentity['reason']
  routeKey: string
  destinationAddress: Address
  owner: Address
  request: {
    assetsRaw: string
    assetAddress: Address
    horizonHours: number
    receiptTokenId?: string
    sharesRaw?: string
    requestTokenId?: string
    collateralVault?: Address
    ptRaw?: string
    primeSharesRaw?: string
  }
  source: {
    chainId: 1
    blockNumber: number
    blockHash: `0x${string}`
    blockTime: string
    originValidation: 'single_provider' | 'two_provider'
  }
  stages: HolderExitStage[]
  finalPayout: {
    assetAddress: Address
    status: 'unassessed' | 'simulated' | 'mined_observed'
    amountRaw: string | null
  }
  /** A separately supplied ApyUSD receipt claim simulated for this holder at the pinned block. */
  existingReceiptClaim?: {
    tokenId: string
    assetAddress: Address
    status: 'simulated'
    /** Pinned previewClaim amount; claim execution and token delivery are unobserved. */
    amountRaw: string
    delivery: 'not_observed'
  }
  forecast: {
    status: 'unvalidated'
    futureExit: null
    exitDurationHours: null
    prospectiveValidated: false
  }
  /** Current onchain Umbrella window only; not a forecast of how long exit remains possible. */
  condition?: {
    gate: UmbrellaGhoAmountCheck['gate']
    cooldownEnd: number | null
    windowEndInclusive: number | null
    currentCooldownSeconds: number
    currentUnstakeWindowSeconds: number
    slashExposure: UmbrellaGhoAmountCheck['slashExposure']
  } | null
  /** New ApyUSD receipt schedule under the fee curve at the checked block. */
  apyUsdCondition?: {
    currentMinimumClaimDelaySeconds: number | null
    /** Current native curve, distinct from the curve when an older receipt was created. */
    currentFeeCurve: ApyUsdFeeCurve | null
    /** Full existing receipt escrow and original native clock, independent of newly requested Q. */
    existingReceipt: NonNullable<NonNullable<ApyUsdExitResult['current']>['existingReceipt']> | null
    ifInitiatedAtCheckedBlockClaimableAt: number | null
    ifInitiatedAtCheckedBlockEarliestNetRaw: string | null
    ifInitiatedAtCheckedBlockMinimumFeeAt: number | null
    ifInitiatedAtCheckedBlockMinimumFeeNetRaw: string | null
    ifInitiatedAtCheckedBlockHorizonNetRaw: string | null
  }
  /** sUSDe's pending queue belongs to the holder; shared silo cash is not earmarked for new Q. */
  cooldownCondition?: {
    exitMode: 'cooldown' | 'direct_withdrawal'
    durationSeconds: number
    pendingAssetsRaw: string
    aggregateSiloUsdeRaw: string
    pendingClaimEarliestAt: string | null
    initiationStatus: 'success' | 'evm_revert' | 'not_applicable'
    directWithdrawalStatus: 'success' | 'evm_revert' | null
    pendingClaimStatus: 'success' | 'evm_revert' | 'not_yet_eligible' | 'no_pending_claim'
    newRequestWouldResetPending: boolean
    ifInitiatedAtCheckedBlockEarliestAt: string | null
  }
  stakedUsdatCondition?: {
    requestedSharesRaw: string
    previewUsdatRaw: string | null
    queueRequestStatus: 'success' | 'evm_revert' | 'not_attempted'
    simulatedQueueTicketId: string | null
    existingTicketId: string | null
    existingTicketOwnership: 'holder' | 'other_owner' | 'not_found' | null
    existingTicketClaimStatus: 'success' | 'evm_revert' | 'not_holder' | 'not_found' | null
    existingTicketRequestedAtUnix: string | null
    /** Exact existing-ticket amount only; independent of a new share request and original AUSD Q. */
    existingTicketConversionQuote: SaturnTicketConversionQuote | null
    existingTicketRecordedRequest?: StakedUsdatRecordedRequest | null
    existingTicketConversionBasis?: 'claim_return' | 'recorded_owed_if_delivered' | null
    existingTicketConversionFeeStatus?: 'included_in_claim_return' | 'unknown' | null
    existingTicketRequestedLimit: null | {
      minSharePriceRaw: string
      currentNetSharePriceRaw: string | null
      comparison: 'above_current_quote' | 'at_or_below_current_quote' | 'quote_unavailable'
      limitUpdateSimulation: 'success' | 'evm_revert'
    }
  }
  twyneCondition?: {
    collateralVault: Address
    requestedPtRaw: string
    status: 'observed' | 'restricted' | 'unsupported'
    reason: string | null
    simulatedReturnedPtRaw: string | null
  }
  pyusdStakingCondition?: {
    requestedPrimeSharesRaw: string
    holderPrimeSharesRaw: string
    maxRedeemRaw: string
    previewWyldsRaw: string | null
    simulatedWyldsRaw: string | null
    stakingPaused: boolean
    holderFrozen: boolean
    reason:
      | 'insufficient_prime_shares'
      | 'staking_paused'
      | 'holder_frozen'
      | 'below_max_redeem'
      | 'redeem_reverted'
      | 'zero_wylds_out'
      | 'prime_to_wylds_callable'
  }
  /** Existing holder wYLDS state at the identity block; separate from the new PRIME Q. */
  pyusdYieldQueueCondition?: PyusdStakingYieldQueue
}

type Clients = {
  direct: DirectSupplyExitClient
  apy: ApyUsdExitClient & Pick<PublicClient, 'request'>
  tracked: TrackedDirectVaultExitClient
  morpho: MorphoExitClient & Pick<PublicClient, 'request'>
}
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const validRaw = (value: unknown): value is string =>
  typeof value === 'string' && RAW.test(value) && BigInt(value) <= MAX_U256
const forecast = {
  status: 'unvalidated',
  futureExit: null,
  exitDurationHours: null,
  prospectiveValidated: false,
} as const

/** Strictly resolves the frozen route and destination together, before any provider call. */
export function validateHolderExitAssessmentRequest(input: HolderExitAssessmentRequest) {
  if (
    !input ||
    typeof input.routeKey !== 'string' ||
    input.routeKey.length < 1 ||
    input.routeKey.length > 160 ||
    !ADDRESS.test(input.destinationAddress) ||
    !ADDRESS.test(input.owner) ||
    !validRaw(input.assetsRaw) ||
    !Number.isSafeInteger(input.horizonHours) ||
    input.horizonHours < 1 ||
    input.horizonHours > 8760
  )
    throw new Error('holder_exit_request_invalid')
  const subject = resolveHolderExitSubject(input.routeKey, input.destinationAddress)
  if (
    (input.horizonHours > 720 && subject.kind !== 'fluid_usdt') ||
    (subject.kind === 'fluid_usdt' && !validRaw(input.firstLegUsdcRaw)) ||
    (subject.kind !== 'fluid_usdt' && input.firstLegUsdcRaw !== undefined) ||
    (subject.kind !== 'apy' && input.receiptTokenId !== undefined) ||
    (input.receiptTokenId !== undefined && !validRaw(input.receiptTokenId)) ||
    (subject.kind === 'staked_usdat' && !validRaw(input.sharesRaw)) ||
    (subject.kind !== 'staked_usdat' && input.sharesRaw !== undefined) ||
    (subject.kind !== 'staked_usdat' && input.requestTokenId !== undefined) ||
    (input.requestTokenId !== undefined && !/^(0|[1-9][0-9]{0,77})$/.test(input.requestTokenId)) ||
    (input.requestTokenId !== undefined && BigInt(input.requestTokenId) > MAX_U256) ||
    (subject.kind === 'twyne_pt' &&
      (!ADDRESS.test(input.collateralVault ?? '') || !validRaw(input.ptRaw))) ||
    (subject.kind !== 'twyne_pt' &&
      (input.collateralVault !== undefined || input.ptRaw !== undefined)) ||
    (subject.kind !== 'pyusd_staking' && input.primeSharesRaw !== undefined) ||
    (input.primeSharesRaw !== undefined &&
      (!validRaw(input.primeSharesRaw) || BigInt(input.primeSharesRaw) > 10n ** 18n))
  )
    throw new Error('holder_exit_request_invalid')
  return subject
}

/** Current read-only stages only. The chosen horizon is retained for a future validated model. */
export type HolderExitAssessmentReadOptions = {
  /** Server-constructed reference, independently verified by each direct executor. */
  directFinalizedBlock?: DirectSupplyHistoricalFinalizedBlock
  atomicFinalizedBlock?: DirectSupplyHistoricalFinalizedBlock
  /** Dedicated staged USDC bridge capacity pin; it grants no atomic execution status. */
  fluidUsdcBridgeFinalizedBlock?: DirectSupplyHistoricalFinalizedBlock
  includeStusdsProtocolCapacity?: true
  includeFluidUsdcBridgeNativeCapacity?: true
  includeCapacityFacts?: true
}

export async function readHolderExitAssessment(
  clients: Clients,
  input: HolderExitAssessmentRequest,
  options: HolderExitAssessmentReadOptions = {},
): Promise<HolderExitAssessment> {
  const subject = validateHolderExitAssessmentRequest(input)
  const legacyPin = options.directFinalizedBlock
  const fluidPin = options.fluidUsdcBridgeFinalizedBlock
  const fluidCapacitySubject =
    input.routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]' &&
    options.includeCapacityFacts === true
      ? resolveHolderExitCapacitySubject(input.routeKey, input.destinationAddress)
      : null
  const pin = fluidPin ?? options.atomicFinalizedBlock ?? legacyPin
  const atomicSubject = resolveIssuedHolderExitSubject(input.routeKey, input.destinationAddress)
  if (
    pin !== undefined &&
    ((!atomicSubject && !(fluidPin !== undefined && fluidCapacitySubject)) ||
      (fluidPin !== undefined &&
        (!fluidCapacitySubject ||
          legacyPin !== undefined ||
          options.atomicFinalizedBlock !== undefined)) ||
      (legacyPin !== undefined &&
        (input.routeKey !== DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey ||
          !same(input.destinationAddress, DIRECT_SUPPLY_MARKETS.aaveV3Usdc.destination))) ||
      (legacyPin !== undefined && options.atomicFinalizedBlock !== undefined) ||
      !pin ||
      typeof pin !== 'object' ||
      Array.isArray(pin) ||
      pin.mode !== 'internal_historical_finalized_block' ||
      typeof pin.blockNumber !== 'bigint' ||
      pin.blockNumber < 1n ||
      pin.blockNumber > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof pin.blockHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(pin.blockHash))
  )
    throw new Error('holder_exit_source_pin_invalid')
  const verifyAtomicUnits = (
    units: { assetAddress: unknown; assetDecimals: unknown } | undefined,
  ) => {
    const canonical = (atomicSubject ?? fluidCapacitySubject)?.canonicalFinalAsset
    if (!canonical) return
    // Existing reader return types carry both live-checked fields. Require them
    // on the new generic pin boundary; keep optional-parameter callers compatible.
    if (
      (!units && (options.atomicFinalizedBlock !== undefined || fluidPin !== undefined)) ||
      (units &&
        (typeof units.assetAddress !== 'string' ||
          !same(units.assetAddress, canonical.address) ||
          typeof units.assetDecimals !== 'number' ||
          units.assetDecimals !== canonical.decimals))
    )
      throw new Error('holder_exit_atomic_units_mismatch')
  }
  const base = {
    routeKey: input.routeKey,
    destinationAddress: input.destinationAddress,
    owner: input.owner,
    request: {
      assetsRaw: input.assetsRaw,
      assetAddress: subject.payoutAsset,
      horizonHours: input.horizonHours,
      ...(subject.kind === 'apy' && input.receiptTokenId !== undefined
        ? { receiptTokenId: input.receiptTokenId }
        : {}),
      ...(subject.kind === 'staked_usdat' ? { sharesRaw: input.sharesRaw } : {}),
      ...(subject.kind === 'staked_usdat' && input.requestTokenId !== undefined
        ? { requestTokenId: input.requestTokenId }
        : {}),
      ...(subject.kind === 'twyne_pt'
        ? { collateralVault: input.collateralVault, ptRaw: input.ptRaw }
        : {}),
      ...(subject.kind === 'pyusd_staking' && input.primeSharesRaw !== undefined
        ? { primeSharesRaw: input.primeSharesRaw }
        : {}),
    },
    forecast,
  }
  const withCapacity = (
    assessment: HolderExitAssessment,
    facts: HolderExitCapacityFacts,
    readerPositionPresent = true,
  ): HolderExitAssessment => {
    if (!readerPositionPresent) return assessment
    const capacityQuote = buildHolderExitCapacityQuote(assessment, facts, Date.now())
    return capacityQuote ? { ...assessment, capacityQuote } : assessment
  }
  if (subject.kind === 'umbrella_gho') {
    const result = await readUmbrellaGhoExit(clients.apy, {
      routeKey: input.routeKey,
      destinationAddress: input.destinationAddress,
      holder: input.owner,
      assetsRaw: input.assetsRaw,
    })
    const ownerCode = await clients.apy.request({
      method: 'eth_getCode',
      params: [input.owner, { blockHash: result.evidence.blockHash, requireCanonical: true }],
    })
    if (!isEoaTransactionOriginCode(ownerCode)) throw new Error('holder_exit_eoa_unverified')
    if (
      result.evidence.chainId !== 1 ||
      !same(result.evidence.proxy, input.destinationAddress) ||
      !same(result.evidence.routeAsset, subject.payoutAsset) ||
      (result.status === 'observed' && !same(result.originalAsset, subject.payoutAsset))
    )
      throw new Error('holder_exit_umbrella_identity_mismatch')
    const amount = result.status === 'observed' ? result.amountCheck : null
    if (
      result.status === 'observed' &&
      (!amount || amount.requested.unit !== 'assets' || amount.requested.raw !== input.assetsRaw)
    )
      throw new Error('holder_exit_umbrella_amount_mismatch')
    const successful =
      result.status === 'observed' &&
      result.state === 'window_open' &&
      amount?.gate === 'window_open' &&
      amount.simulation.status === 'success' &&
      BigInt(amount.simulation.ghoRaw) >= BigInt(input.assetsRaw)
    return {
      ...base,
      status: result.status === 'unsupported' ? 'unsupported' : successful ? 'assessed' : 'partial',
      source: {
        chainId: 1,
        blockNumber: result.evidence.blockNumber,
        blockHash: result.evidence.blockHash,
        blockTime: new Date(result.evidence.blockTimestamp * 1000).toISOString(),
        originValidation: 'single_provider',
      },
      stages: [
        {
          name: 'redeem',
          assetAddress: subject.payoutAsset,
          status: successful
            ? 'simulated'
            : amount?.simulation.status === 'evm_revert'
              ? 'reverted'
              : 'unassessed',
          amountRaw: input.assetsRaw,
          relatedToRequest: true,
        },
      ],
      finalPayout: {
        assetAddress: subject.payoutAsset,
        status: successful ? 'simulated' : 'unassessed',
        amountRaw:
          successful && amount?.simulation.status === 'success' ? amount.simulation.ghoRaw : null,
      },
      condition:
        result.status === 'observed' && amount
          ? {
              gate: amount.gate,
              cooldownEnd: result.cooldownEnd,
              windowEndInclusive: result.windowEndInclusive,
              currentCooldownSeconds: result.currentCooldownSeconds,
              currentUnstakeWindowSeconds: result.currentUnstakeWindowSeconds,
              slashExposure: amount.slashExposure,
            }
          : null,
    }
  }
  if (subject.kind === 'susde') {
    const result = await readSusdeCooldownExitQuote(
      clients.apy,
      {
        routeKey: input.routeKey,
        destinationAddress: input.destinationAddress,
        owner: input.owner,
        assetsRaw: input.assetsRaw,
      },
      ...(options.includeCapacityFacts === true
        ? ([() => Date.now(), { includeCapacityFacts: true }] as const)
        : []),
    )
    const ownerCode = await clients.apy.request({
      method: 'eth_getCode',
      params: [input.owner, { blockHash: result.source.blockHash, requireCanonical: true }],
    })
    if (!isEoaTransactionOriginCode(ownerCode)) throw new Error('holder_exit_eoa_unverified')
    const target = resolveSusdeCooldownExitTarget(input.routeKey, input.destinationAddress)
    const aggregateSiloUsdeRaw = result.aggregateSiloUsde?.balanceRaw
    const directMode = result.exitMode === 'direct_withdrawal'
    if (
      result.source.chainId !== 1 ||
      result.routeKey !== input.routeKey ||
      !same(result.vault.address, input.destinationAddress) ||
      !same(result.vault.assetAddress, subject.payoutAsset) ||
      !same(result.vault.siloAddress, target.silo) ||
      result.request.assetsRaw !== input.assetsRaw ||
      typeof aggregateSiloUsdeRaw !== 'string' ||
      !/^(0|[1-9][0-9]{0,77})$/.test(aggregateSiloUsdeRaw) ||
      BigInt(aggregateSiloUsdeRaw) > MAX_U256 ||
      (directMode
        ? result.vault.cooldownDurationSeconds !== 0 ||
          result.initiation.status !== 'not_applicable' ||
          !['success', 'evm_revert'].includes(result.directWithdrawal?.status ?? '')
        : result.exitMode !== 'cooldown' ||
          result.vault.cooldownDurationSeconds <= 0 ||
          !['success', 'evm_revert'].includes(result.initiation.status) ||
          result.directWithdrawal !== null)
    )
      throw new Error('holder_exit_susde_result_mismatch')
    return {
      ...base,
      status: 'partial',
      ...(options.includeCapacityFacts === true && result.susdeHolderFacts
        ? { susdeHolderFacts: result.susdeHolderFacts }
        : {}),
      source: {
        chainId: 1,
        blockNumber: result.source.blockNumber,
        blockHash: result.source.blockHash,
        blockTime: result.source.blockTime,
        originValidation: 'single_provider',
      },
      stages: [
        {
          name: directMode ? 'withdrawal' : 'cooldown_initiation',
          assetAddress: subject.payoutAsset,
          status:
            (directMode ? result.directWithdrawal?.status : result.initiation.status) === 'success'
              ? 'simulated'
              : 'reverted',
          amountRaw: input.assetsRaw,
          relatedToRequest: true,
        },
        {
          name: 'pending_claim',
          assetAddress: subject.payoutAsset,
          status:
            result.claim.status === 'success'
              ? 'simulated'
              : result.claim.status === 'evm_revert'
                ? 'reverted'
                : 'unassessed',
          amountRaw: result.pending.assetsRaw,
          relatedToRequest: false,
        },
      ],
      // The successful initiation only queues new Q. An older claim cannot prove its payout.
      finalPayout: { assetAddress: subject.payoutAsset, status: 'unassessed', amountRaw: null },
      cooldownCondition: {
        exitMode: result.exitMode,
        durationSeconds: result.vault.cooldownDurationSeconds,
        pendingAssetsRaw: result.pending.assetsRaw,
        aggregateSiloUsdeRaw,
        pendingClaimEarliestAt: result.currentClaimEarliestAt,
        initiationStatus: result.initiation.status,
        directWithdrawalStatus: result.directWithdrawal?.status ?? null,
        pendingClaimStatus: result.claim.status,
        newRequestWouldResetPending: result.newRequestWouldResetPending,
        ifInitiatedAtCheckedBlockEarliestAt: result.ifInitiatedAtCheckedBlockEarliestAt,
      },
    }
  }
  if (subject.kind === 'staked_usdat') {
    const result = await readStakedUsdatExit(clients.apy, {
      routeKey: input.routeKey,
      destinationAddress: input.destinationAddress,
      holder: input.owner,
      sharesRaw: input.sharesRaw!,
      ...(input.requestTokenId !== undefined ? { requestTokenId: input.requestTokenId } : {}),
    })
    const ownerCode = await clients.apy.request({
      method: 'eth_getCode',
      params: [input.owner, { blockHash: result.evidence.blockHash, requireCanonical: true }],
    })
    if (!isEoaTransactionOriginCode(ownerCode)) throw new Error('holder_exit_eoa_unverified')
    if (
      result.evidence.chainId !== 1 ||
      !same(result.evidence.vault, input.destinationAddress) ||
      !same(result.evidence.queue, STAKED_USDAT_QUEUE) ||
      !same(result.evidence.underlying, USDAT_ASSET) ||
      (result.status === 'observed' &&
        (!result.current ||
          result.current.requestedSharesRaw !== input.sharesRaw ||
          result.current.existingTicket?.tokenId !== input.requestTokenId))
    )
      throw new Error('holder_exit_staked_usdat_result_mismatch')
    const current = result.status === 'observed' ? result.current : undefined
    const ticket = current?.existingTicket
    if (
      ticket?.requestedAtUnix != null &&
      (!/^[1-9]\d*$/.test(ticket.requestedAtUnix) ||
        BigInt(ticket.requestedAtUnix) > BigInt(result.evidence.blockTimestamp) ||
        ticket.ownership !== 'holder')
    )
      throw new Error('holder_exit_staked_usdat_ticket_time_invalid')
    let conversionQuote: SaturnTicketConversionQuote | null = null
    const recorded = ticket?.recordedRequest
    const validRecorded =
      ticket?.ownership === 'holder' &&
      result.evidence.underlyingDecimals === 6 &&
      result.evidence.shareDecimals === 18 &&
      recorded !== null &&
      typeof recorded === 'object' &&
      !Array.isArray(recorded) &&
      Object.keys(recorded).length === 5 &&
      [
        recorded.sharesRaw18,
        recorded.usdatOwedRaw6,
        recorded.requestedAtUnix,
        recorded.minSharePriceRaw,
      ].every(
        (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX_U256,
      ) &&
      recorded.sharesRaw18 !== '0' &&
      recorded.requestedAtUnix !== '0' &&
      BigInt(recorded.requestedAtUnix) <= BigInt(result.evidence.blockTimestamp) &&
      Number.isSafeInteger(recorded.rawStatus) &&
      recorded.rawStatus >= 0 &&
      recorded.rawStatus <= 255
        ? recorded
        : null
    const quoteInput =
      ticket?.ownership === 'holder'
        ? ticket.claimSimulation === 'success'
          ? validRaw(ticket.simulatedUsdatRaw)
            ? { amountRaw: ticket.simulatedUsdatRaw, basis: 'claim_return' as const }
            : null
          : validRecorded && validRaw(validRecorded.usdatOwedRaw6)
            ? {
                amountRaw: validRecorded.usdatOwedRaw6,
                basis: 'recorded_owed_if_delivered' as const,
              }
            : null
        : null
    if (quoteInput) {
      try {
        const quote = await readSaturnTicketConversionQuote(
          clients.apy,
          result.evidence.blockHash,
          quoteInput.amountRaw,
        )
        if (
          quote.status !== 'conditional_quote' ||
          quote.execution !== 'unassessed' ||
          quote.usdatInputRaw !== quoteInput.amountRaw
        )
          throw new Error('holder_exit_saturn_quote_size_mismatch')
        conversionQuote = quote
      } catch {
        // The public swap quote is optional; retain the verified holder ticket assay.
      }
    }
    return {
      ...base,
      status: current ? 'partial' : 'unsupported',
      source: {
        chainId: 1,
        blockNumber: result.evidence.blockNumber,
        blockHash: result.evidence.blockHash,
        blockTime: new Date(result.evidence.blockTimestamp * 1000).toISOString(),
        originValidation: 'single_provider',
      },
      stages: [
        {
          name: 'queue_request',
          assetAddress: null,
          status:
            current?.request.status === 'success'
              ? 'simulated'
              : current?.request.status === 'evm_revert'
                ? 'reverted'
                : 'unassessed',
          // The queue request is measured in sUSDat shares, not AUSD or USDat.
          amountRaw: null,
          relatedToRequest: false,
        },
        {
          name: 'existing_ticket_claim',
          assetAddress: USDAT_ASSET,
          status:
            ticket?.claimSimulation === 'success'
              ? 'simulated'
              : ticket?.claimSimulation === 'evm_revert'
                ? 'reverted'
                : 'unassessed',
          amountRaw: ticket?.claimSimulation === 'success' ? ticket.simulatedUsdatRaw : null,
          relatedToRequest: false,
        },
      ],
      // Neither a new queue ticket nor an older USDat claim proves conversion to AUSD Q.
      finalPayout: { assetAddress: AUSD_ASSET, status: 'unassessed', amountRaw: null },
      stakedUsdatCondition: current
        ? {
            requestedSharesRaw: current.requestedSharesRaw,
            previewUsdatRaw: current.previewUsdatRaw,
            queueRequestStatus: current.request.status,
            simulatedQueueTicketId:
              current.request.status === 'success' ? current.request.requestTokenId : null,
            existingTicketId: ticket?.tokenId ?? null,
            existingTicketOwnership: ticket?.ownership ?? null,
            existingTicketClaimStatus: ticket?.claimSimulation ?? null,
            existingTicketRequestedAtUnix: ticket?.requestedAtUnix ?? null,
            existingTicketConversionQuote: conversionQuote,
            ...(recorded !== undefined ? { existingTicketRecordedRequest: validRecorded } : {}),
            existingTicketConversionBasis: conversionQuote ? quoteInput!.basis : null,
            existingTicketConversionFeeStatus: conversionQuote
              ? quoteInput!.basis === 'claim_return'
                ? 'included_in_claim_return'
                : 'unknown'
              : null,
            existingTicketRequestedLimit: ticket?.requestedLimit
              ? {
                  minSharePriceRaw: ticket.requestedLimit.minSharePriceRaw,
                  currentNetSharePriceRaw: ticket.requestedLimit.currentNetSharePriceRaw,
                  comparison: ticket.requestedLimit.comparison,
                  limitUpdateSimulation: ticket.requestedLimit.limitUpdateSimulation,
                }
              : null,
          }
        : undefined,
    }
  }
  if (subject.kind === 'twyne_pt') {
    const result = await readTwyneBorrowerExit(
      clients.apy,
      {
        routeKey: TWYNE_PT_ROUTE,
        collateralVault: input.collateralVault!,
        requestedPtRaw: input.ptRaw!,
      },
      TWYNE_PT_BORROWER_DEPLOYMENT,
    )
    if (
      result.routeKey !== input.routeKey ||
      !same(result.collateralVault, input.collateralVault!) ||
      result.requestedPtRaw !== input.ptRaw ||
      result.evidence.chainId !== 1 ||
      result.evidence.receiver !== 'borrower' ||
      (result.status === 'observed' &&
        (!same(result.evidence.asset ?? '', TWYNE_PT_WRAPPER) ||
          !same(result.evidence.targetAsset ?? '', USDE_ASSET) ||
          !same(result.evidence.targetVault ?? '', TWYNE_AAVE_POOL) ||
          result.evidence.returnedPtRaw === null ||
          BigInt(result.evidence.returnedPtRaw) < BigInt(input.ptRaw!)))
    )
      throw new Error('holder_exit_twyne_result_mismatch')
    // Early deployment/identity failures may precede borrower(). They are
    // route-level unsupported evidence, never a holder-authorized stage.
    if (result.status !== 'unsupported') {
      // The frozen seed's CV owner is a contract. Authorization belongs to the
      // current borrower() returned at this exact finalized block.
      if (!result.borrower || !same(result.borrower, input.owner))
        throw new Error('holder_exit_twyne_borrower_unverified')
      const ownerCode = await clients.apy.request({
        method: 'eth_getCode',
        params: [input.owner, { blockHash: result.evidence.blockHash, requireCanonical: true }],
      })
      if (!isEoaTransactionOriginCode(ownerCode)) throw new Error('holder_exit_eoa_unverified')
    }
    return {
      ...base,
      status: result.status === 'unsupported' ? 'unsupported' : 'partial',
      source: {
        chainId: 1,
        blockNumber: result.evidence.blockNumber,
        blockHash: result.evidence.blockHash,
        blockTime: new Date(result.evidence.blockTimestamp * 1000).toISOString(),
        originValidation: 'single_provider',
      },
      stages:
        result.status === 'unsupported'
          ? []
          : [
              {
                name: 'pt_redemption',
                assetAddress: TWYNE_PT_ASSET,
                status:
                  result.status === 'observed'
                    ? 'simulated'
                    : result.reason === 'evm_revert'
                      ? 'reverted'
                      : 'unassessed',
                amountRaw: input.ptRaw!,
                relatedToRequest: false,
              },
            ],
      finalPayout: { assetAddress: USDE_ASSET, status: 'unassessed', amountRaw: null },
      twyneCondition: {
        collateralVault: input.collateralVault!,
        requestedPtRaw: input.ptRaw!,
        status: result.status,
        reason: result.reason ?? null,
        simulatedReturnedPtRaw: result.evidence.returnedPtRaw,
      },
    }
  }
  if (subject.kind === 'pyusd_staking') {
    const result = await readPyusdStakingRouteIdentity(clients.apy)
    if (
      result.routeKey !== input.routeKey ||
      !same(result.destination, input.destinationAddress) ||
      result.evidence.chainId !== 1 ||
      result.pyusdPayout !== 'not_attested' ||
      result.holderAmountCheck !== 'not_performed_route_incomplete' ||
      (result.status === 'route_asset_mismatch' &&
        (result.reason !== 'pyusd_leg_not_verified' ||
          result.assetLinks !== 'staking_asset_wYLDS_yield_asset_USDC' ||
          !same(result.evidence.stakingAsset ?? '', HASTRA_YIELD_VAULT) ||
          !same(result.evidence.yieldAsset ?? '', USDC_TOKEN) ||
          result.evidence.pyusdDecimals !== 6))
    )
      throw new Error('holder_exit_pyusd_identity_mismatch')
    const firstLeg =
      result.status === 'route_asset_mismatch' && input.primeSharesRaw !== undefined
        ? await readPyusdStakingFirstLeg(
            clients.apy,
            input.owner,
            input.primeSharesRaw,
            result.evidence.blockHash,
          )
        : null
    let yieldQueue: PyusdStakingYieldQueue | null = null
    if (result.status === 'route_asset_mismatch') {
      try {
        yieldQueue = await readPyusdStakingYieldQueue(
          clients.apy,
          input.owner,
          result.evidence.blockHash,
        )
      } catch {
        // A supplemental existing queue read cannot erase the independent PRIME assay.
      }
    }
    const hasExistingYieldPosition =
      yieldQueue !== null &&
      (BigInt(yieldQueue.existingWyldsSharesRaw) > 0n ||
        BigInt(yieldQueue.pendingSharesRaw) > 0n ||
        BigInt(yieldQueue.pendingUsdcRaw) > 0n)
    const visibleYieldQueue = firstLeg || hasExistingYieldPosition ? yieldQueue : null
    return {
      ...base,
      status: firstLeg || visibleYieldQueue ? 'partial' : 'unsupported',
      ...(!firstLeg && !visibleYieldQueue ? { unsupportedReason: result.reason } : {}),
      source: {
        chainId: 1,
        blockNumber: result.evidence.blockNumber,
        blockHash: result.evidence.blockHash,
        blockTime: new Date(result.evidence.blockTimestamp * 1000).toISOString(),
        originValidation: 'single_provider',
      },
      stages: firstLeg
        ? [
            {
              name: 'prime_redemption' as const,
              assetAddress: HASTRA_STAKING_VAULT,
              status:
                firstLeg.reason === 'prime_to_wylds_callable'
                  ? ('simulated' as const)
                  : firstLeg.simulatedWyldsRaw === null
                    ? ('reverted' as const)
                    : ('unassessed' as const),
              amountRaw: input.primeSharesRaw!,
              relatedToRequest: false,
            },
          ]
        : [],
      finalPayout: { assetAddress: PYUSD_TOKEN, status: 'unassessed', amountRaw: null },
      ...(firstLeg ? { pyusdStakingCondition: firstLeg } : {}),
      ...(visibleYieldQueue ? { pyusdYieldQueueCondition: visibleYieldQueue } : {}),
    }
  }
  if (subject.kind === 'sgho' || subject.kind === 'susds' || subject.kind === 'usd3') {
    const result =
      subject.kind === 'sgho'
        ? options.includeCapacityFacts === true
          ? await readSghoExit(clients.apy, input.owner, input.assetsRaw, () => Date.now(), pin, {
              includeCapacityFacts: true,
            })
          : pin
            ? await readSghoExit(clients.apy, input.owner, input.assetsRaw, () => Date.now(), pin)
            : await readSghoExit(clients.apy, input.owner, input.assetsRaw)
        : subject.kind === 'susds'
          ? await readSusdsExitQuote(
              clients.apy,
              {
                routeKey: input.routeKey,
                destinationAddress: input.destinationAddress,
                owner: input.owner,
                assetsRaw: input.assetsRaw,
              },
              ...(options.includeCapacityFacts === true
                ? ([() => Date.now(), pin, { includeCapacityFacts: true }] as const)
                : pin
                  ? ([() => Date.now(), pin] as const)
                  : []),
            )
          : await readUsd3ExitQuote(
              clients.apy,
              {
                routeKey: input.routeKey,
                destinationAddress: input.destinationAddress,
                owner: input.owner,
                assetsRaw: input.assetsRaw,
              },
              ...(options.includeCapacityFacts === true
                ? ([() => Date.now(), pin, { includeCapacityFacts: true }] as const)
                : pin
                  ? ([() => Date.now(), pin] as const)
                  : []),
            )
    verifyAtomicUnits('assetDecimals' in result.vault ? result.vault : undefined)
    // All three readers use viem getCode, which maps valid EOA `0x` to
    // undefined. Require raw code at their exact finalized simulation block.
    const ownerCode = await clients.apy.request({
      method: 'eth_getCode',
      params: [input.owner, { blockHash: result.source.blockHash, requireCanonical: true }],
    })
    if (!isEoaTransactionOriginCode(ownerCode)) throw new Error('holder_exit_eoa_unverified')
    if (
      result.source.chainId !== 1 ||
      !same(result.vault.address, input.destinationAddress) ||
      !same(result.vault.assetAddress, subject.payoutAsset) ||
      result.request.assetsRaw !== input.assetsRaw ||
      ('routeKey' in result && result.routeKey !== input.routeKey)
    )
      throw new Error('holder_exit_result_mismatch')
    const simulated = result.simulation.status === 'success'
    return withCapacity(
      {
        ...base,
        status: 'assessed',
        source: {
          chainId: 1,
          blockNumber: result.source.blockNumber,
          blockHash: result.source.blockHash,
          blockTime: result.source.blockTime,
          originValidation: 'single_provider',
        },
        stages: [
          {
            name: 'withdrawal',
            assetAddress: subject.payoutAsset,
            status: simulated
              ? 'simulated'
              : result.simulation.status === 'evm_revert'
                ? 'reverted'
                : 'unassessed',
            amountRaw: input.assetsRaw,
            relatedToRequest: true,
          },
        ],
        finalPayout: {
          assetAddress: subject.payoutAsset,
          status: simulated ? 'simulated' : 'unassessed',
          amountRaw: simulated ? input.assetsRaw : null,
        },
      },
      {
        ...(options.includeCapacityFacts === true &&
        subject.kind === 'usd3' &&
        'usd3NativeCapacity' in result &&
        result.usd3NativeCapacity
          ? { usd3NativeCapacity: result.usd3NativeCapacity }
          : {}),
        ...(options.includeCapacityFacts === true &&
        subject.kind === 'usd3' &&
        result.position &&
        'balanceSharesRaw' in result.position &&
        typeof result.position.balanceSharesRaw === 'string' &&
        /^(0|[1-9][0-9]{0,77})$/.test(result.position.balanceSharesRaw) &&
        BigInt(result.position.balanceSharesRaw) <= MAX_U256 &&
        'shareDecimals' in result.vault &&
        typeof result.vault.shareDecimals === 'number' &&
        Number.isInteger(result.vault.shareDecimals) &&
        result.vault.shareDecimals >= 0 &&
        result.vault.shareDecimals <= 36
          ? {
              sourceHolderPosition: {
                sharesRaw: result.position.balanceSharesRaw,
                shareDecimals: result.vault.shareDecimals,
                method: 'balance_of_owner_at_source' as const,
              },
            }
          : {}),
        entitlementRaw:
          result.position && 'previewRedeemGhoRaw' in result.position
            ? result.position.previewRedeemGhoRaw
            : (result.position?.entitlementAssetsRaw ?? null),
        quotedMaxWithdrawStatus: 'quoted',
        quotedMaxWithdrawRaw:
          result.position && 'maxWithdrawGhoRaw' in result.position
            ? result.position.maxWithdrawGhoRaw
            : (result.position?.maxWithdrawAssetsRaw ?? null),
        effectiveLimitRaw:
          result.position && 'effectiveExitGhoRaw' in result.position
            ? result.position.effectiveExitGhoRaw
            : null,
        withdrawalsPaused:
          'withdrawalsPaused' in result.vault ? result.vault.withdrawalsPaused : null,
        // USD3's optional native previewRedeem uses the source-pinned full
        // balanceShares, independently of requested Q and withdrawal shares.
        ...(options.includeCapacityFacts === true &&
        subject.kind === 'usd3' &&
        result.position &&
        'entitlementAssetsRaw' in result.position
          ? { fullPositionEntitlementRaw: result.position.entitlementAssetsRaw }
          : {}),
        ...(subject.kind === 'sgho' &&
        result.position &&
        'fullPositionEntitlementGhoRaw' in result.position
          ? {
              fullPositionEntitlementRaw: result.position.fullPositionEntitlementGhoRaw,
            }
          : {}),
      },
      Boolean(result.position),
    )
  }
  if (subject.kind === 'morpho') {
    const result = await readMorphoExitQuote(
      clients.morpho,
      {
        routeKey: input.routeKey,
        destinationAddress: input.destinationAddress,
        owner: input.owner,
        assetsRaw: input.assetsRaw,
      },
      ...(options.includeCapacityFacts === true
        ? ([() => Date.now(), pin, { includeCapacityFacts: true }] as const)
        : pin
          ? ([() => Date.now(), pin] as const)
          : []),
    )
    verifyAtomicUnits('assetDecimals' in result.vault ? result.vault : undefined)
    // viem getCode converts the valid EOA result `0x` to undefined. Require
    // the raw EIP-1898 response at the *same* block used by the simulation.
    const ownerCode = await clients.morpho.request({
      method: 'eth_getCode',
      params: [input.owner, { blockHash: result.source.blockHash, requireCanonical: true }],
    })
    if (!isEoaTransactionOriginCode(ownerCode)) throw new Error('holder_exit_morpho_eoa_unverified')
    if (
      result.source.chainId !== 1 ||
      result.routeKey !== input.routeKey ||
      !same(result.vault.address, input.destinationAddress) ||
      !same(result.vault.assetAddress, subject.payoutAsset) ||
      result.request.assetsRaw !== input.assetsRaw
    )
      throw new Error('holder_exit_morpho_result_mismatch')
    const simulated = result.simulation.status === 'success'
    return withCapacity(
      {
        ...base,
        ...(result.morphoHolderPositionObservation
          ? { morphoHolderPositionObservation: result.morphoHolderPositionObservation }
          : {}),
        status: 'assessed',
        source: {
          chainId: 1,
          blockNumber: result.source.blockNumber,
          blockHash: result.source.blockHash,
          blockTime: result.source.blockTime,
          originValidation: 'single_provider',
        },
        stages: [
          {
            name: 'withdrawal',
            assetAddress: subject.payoutAsset,
            status: simulated ? 'simulated' : 'reverted',
            amountRaw: input.assetsRaw,
            relatedToRequest: true,
          },
        ],
        finalPayout: {
          assetAddress: subject.payoutAsset,
          status: simulated ? 'simulated' : 'unassessed',
          amountRaw: simulated ? input.assetsRaw : null,
        },
      },
      {
        entitlementRaw: result.position?.previewRedeemAssetsRaw ?? null,
        ...(result.position
          ? {
              sourceHolderPosition: {
                sharesRaw: result.position.sharesRaw,
                shareDecimals: result.vault.shareDecimals,
                method: 'balance_of_owner_at_source' as const,
              },
            }
          : {}),
        quotedMaxWithdrawRaw: result.position?.maxWithdrawQuote?.amountRaw ?? null,
        quotedMaxWithdrawStatus: result.position?.maxWithdrawQuote?.status ?? 'not_read',
        effectiveLimitRaw: null,
        withdrawalsPaused: null,
      },
      Boolean(result.position),
    )
  }
  if (subject.kind === 'tracked') {
    const result = await readTrackedDirectVaultExit(
      clients.tracked,
      {
        routeKey: input.routeKey,
        destinationAddress: input.destinationAddress,
        owner: input.owner,
        assetsRaw: input.assetsRaw,
      },
      ...(options.includeCapacityFacts === true
        ? ([
            () => Date.now(),
            pin,
            {
              includeCapacityFacts: true,
              ...(options.includeStusdsProtocolCapacity === true
                ? { includeStusdsProtocolCapacity: true as const }
                : {}),
              ...(options.includeFluidUsdcBridgeNativeCapacity === true
                ? { includeFluidUsdcBridgeNativeCapacity: true as const }
                : {}),
            },
          ] as const)
        : pin
          ? ([() => Date.now(), pin] as const)
          : []),
    )
    verifyAtomicUnits('assetDecimals' in result.vault ? result.vault : undefined)
    if (
      result.source.chainId !== 1 ||
      result.routeKey !== input.routeKey ||
      !same(result.vault.address, input.destinationAddress) ||
      !same(result.vault.assetAddress, subject.payoutAsset) ||
      result.request.assetsRaw !== input.assetsRaw
    )
      throw new Error('holder_exit_tracked_result_mismatch')
    const simulated = result.simulation.status === 'success'
    return withCapacity(
      {
        ...base,
        ...(options.includeStusdsProtocolCapacity === true &&
        input.routeKey === 'USDS → StUsds [USDS]'
          ? { stusdsProtocolCapacityObservation: result.protocolCapacityObservation ?? null }
          : {}),
        status: 'assessed',
        source: {
          chainId: 1,
          blockNumber: result.source.blockNumber,
          blockHash: result.source.blockHash,
          blockTime: result.source.blockTime,
          originValidation: 'single_provider',
        },
        stages: [
          {
            name: 'withdrawal',
            assetAddress: subject.payoutAsset,
            status: simulated ? 'simulated' : 'reverted',
            amountRaw: input.assetsRaw,
            relatedToRequest: true,
          },
        ],
        finalPayout: {
          assetAddress: subject.payoutAsset,
          status: simulated ? 'simulated' : 'unassessed',
          amountRaw: simulated ? input.assetsRaw : null,
        },
      },
      {
        entitlementRaw: result.position?.entitlementAssetsRaw ?? null,
        ...(options.includeCapacityFacts === true &&
        input.routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]'
          ? {
              sourceHolderPosition: {
                sharesRaw: result.position.holderSharesRaw,
                shareDecimals: result.vault.shareDecimals,
                method: 'balance_of_owner_at_source' as const,
              },
              ...(result.fluidUsdcBridgeNativeCapacity
                ? { fluidUsdcBridgeNativeCapacity: result.fluidUsdcBridgeNativeCapacity }
                : {}),
            }
          : {}),
        quotedMaxWithdrawRaw: result.position?.maxWithdrawAssetsRaw ?? null,
        quotedMaxWithdrawStatus: 'quoted',
        effectiveLimitRaw: null,
        withdrawalsPaused: null,
      },
      Boolean(result.position),
    )
  }
  if (subject.kind === 'direct') {
    const directRequest = {
      routeKey: input.routeKey,
      destinationAddress: input.destinationAddress,
      owner: input.owner,
      assetsRaw: input.assetsRaw,
    }
    const result = await readDirectSupplyExitQuote(
      clients.direct,
      directRequest,
      () => Date.now(),
      pin,
      options.includeCapacityFacts === true ? { includeCapacityFacts: true } : {},
    )
    verifyAtomicUnits('market' in result ? result.market : undefined)
    const simulated = result.simulation.status === 'success'
    return withCapacity(
      {
        ...base,
        status: 'assessed',
        ...(result.cometFacts ? { cometFacts: result.cometFacts } : {}),
        source: {
          chainId: 1,
          blockNumber: result.source.blockNumber,
          blockHash: result.source.blockHash,
          blockTime: result.source.blockTime,
          originValidation: 'single_provider',
        },
        stages: [
          {
            name: 'withdrawal',
            assetAddress: subject.payoutAsset,
            status: simulated
              ? 'simulated'
              : result.simulation.status === 'evm_revert'
                ? 'reverted'
                : 'unassessed',
            amountRaw: input.assetsRaw,
            relatedToRequest: true,
          },
        ],
        finalPayout: {
          assetAddress: subject.payoutAsset,
          status: simulated ? 'simulated' : 'unassessed',
          amountRaw: simulated ? input.assetsRaw : null,
        },
      },
      {
        entitlementRaw: result.position?.suppliedBalanceRaw ?? null,
        quotedMaxWithdrawRaw: null,
        quotedMaxWithdrawStatus: 'not_read',
        effectiveLimitRaw: null,
        withdrawalsPaused: null,
      },
      Boolean(result.position),
    )
  }
  if (subject.kind === 'apy') {
    const result = await readApyUsdExit(clients.apy, {
      routeKey: input.routeKey,
      destinationAddress: input.destinationAddress,
      holder: input.owner,
      assetsRaw: input.assetsRaw,
      ...(input.receiptTokenId ? { receiptTokenId: input.receiptTokenId } : {}),
    })
    const ownerCode = await clients.apy.request({
      method: 'eth_getCode',
      params: [input.owner, { blockHash: result.evidence.blockHash, requireCanonical: true }],
    })
    if (!isEoaTransactionOriginCode(ownerCode)) throw new Error('holder_exit_eoa_unverified')
    const current = result.status === 'observed' ? result.current : undefined
    const receipt = current?.existingReceipt
    const currentFeeCurve =
      current?.currentFeeCurve && validApyUsdFeeCurve(current.currentFeeCurve)
        ? { ...current.currentFeeCurve }
        : null
    const originalReceiptCreatedAt =
      receipt &&
      Number.isSafeInteger(receipt.createdAt) &&
      receipt.createdAt !== null &&
      receipt.createdAt > 0 &&
      receipt.createdAt <= result.evidence.blockTimestamp &&
      Number.isSafeInteger(receipt.claimableAt) &&
      receipt.claimableAt !== null &&
      receipt.createdAt <= receipt.claimableAt
        ? receipt.createdAt
        : null
    const matchingReceipt =
      input.receiptTokenId !== undefined &&
      receipt?.tokenId === input.receiptTokenId &&
      receipt.ownership === 'holder'
    const simulatedReceiptClaimAmountRaw =
      matchingReceipt &&
      receipt.claimSimulation === 'success' &&
      validRaw(receipt.simulatedClaimPayoutRaw)
        ? receipt.simulatedClaimPayoutRaw
        : null
    const existingReceiptClaim =
      receipt && input.receiptTokenId !== undefined && simulatedReceiptClaimAmountRaw !== null
        ? {
            tokenId: receipt.tokenId,
            assetAddress: subject.payoutAsset,
            status: 'simulated' as const,
            amountRaw: simulatedReceiptClaimAmountRaw,
            delivery: 'not_observed' as const,
          }
        : undefined
    return {
      ...base,
      status: result.status === 'observed' ? 'partial' : 'unsupported',
      source: {
        chainId: 1,
        blockNumber: result.evidence.blockNumber,
        blockHash: result.evidence.blockHash,
        blockTime: new Date(result.evidence.blockTimestamp * 1000).toISOString(),
        originValidation: 'single_provider',
      },
      stages: [
        {
          name: 'receipt_initiation',
          assetAddress: null,
          status:
            current?.initiation.status === 'success'
              ? 'simulated'
              : current?.initiation.status === 'evm_revert'
                ? 'reverted'
                : 'unassessed',
          amountRaw: input.assetsRaw,
          relatedToRequest: true,
        },
        {
          name: 'receipt_claim',
          assetAddress: subject.payoutAsset,
          status:
            simulatedReceiptClaimAmountRaw !== null
              ? 'simulated'
              : matchingReceipt && receipt.claimSimulation === 'evm_revert'
                ? 'reverted'
                : 'unassessed',
          amountRaw: simulatedReceiptClaimAmountRaw,
          relatedToRequest: false,
        },
      ],
      // An existing receipt is independent of the newly simulated Q. Do not join them.
      finalPayout: { assetAddress: subject.payoutAsset, status: 'unassessed', amountRaw: null },
      ...(existingReceiptClaim ? { existingReceiptClaim } : {}),
      ...(current
        ? {
            apyUsdCondition: {
              currentMinimumClaimDelaySeconds: current.currentMinimumClaimDelaySeconds,
              currentFeeCurve,
              existingReceipt: receipt
                ? {
                    tokenId: receipt.tokenId,
                    ownership: receipt.ownership,
                    escrowRaw: receipt.escrowRaw,
                    currentFeeRaw: receipt.currentFeeRaw,
                    createdAt: originalReceiptCreatedAt,
                    claimableAt: receipt.claimableAt,
                    claimableNow: receipt.claimableNow,
                    receiptPaused: receipt.receiptPaused,
                    currentPreviewPayoutRaw: receipt.currentPreviewPayoutRaw,
                    claimSimulation: receipt.claimSimulation,
                    simulatedClaimPayoutRaw: receipt.simulatedClaimPayoutRaw,
                    delivery: receipt.delivery,
                  }
                : null,
              ifInitiatedAtCheckedBlockClaimableAt: current.ifInitiatedAtCheckedBlockClaimableAt,
              ifInitiatedAtCheckedBlockEarliestNetRaw:
                current.ifInitiatedAtCheckedBlockEarliestNetRaw,
              ifInitiatedAtCheckedBlockMinimumFeeAt: current.ifInitiatedAtCheckedBlockMinimumFeeAt,
              ifInitiatedAtCheckedBlockMinimumFeeNetRaw:
                current.ifInitiatedAtCheckedBlockMinimumFeeNetRaw,
              ifInitiatedAtCheckedBlockHorizonNetRaw:
                current.initiation.status === 'success' &&
                current.currentMinimumClaimDelaySeconds !== null &&
                currentFeeCurve !== null &&
                input.horizonHours * 3600 >= current.currentMinimumClaimDelaySeconds
                  ? (projectApyUsdNet(input.assetsRaw, input.horizonHours * 3600, currentFeeCurve)
                      ?.netRaw ?? null)
                  : null,
            },
          }
        : {}),
    }
  }
  const result = await readTrackedDirectVaultExit(clients.tracked, {
    routeKey: input.routeKey,
    destinationAddress: input.destinationAddress,
    owner: input.owner,
    assetsRaw: input.firstLegUsdcRaw!,
    assetUnit: 'USDC',
  })
  const simulated = result.simulation.status === 'success'
  return {
    ...base,
    status: 'partial',
    source: {
      chainId: 1,
      blockNumber: result.source.blockNumber,
      blockHash: result.source.blockHash,
      blockTime: result.source.blockTime,
      originValidation: 'single_provider',
    },
    stages: [
      {
        name: 'usdc_vault_withdrawal',
        assetAddress: USDC,
        status: simulated
          ? 'simulated'
          : result.simulation.status === 'evm_revert'
            ? 'reverted'
            : 'unassessed',
        amountRaw: input.firstLegUsdcRaw!,
        relatedToRequest: false,
      },
      {
        name: 'usdc_to_usdt_conversion',
        assetAddress: USDT,
        status: 'unassessed',
        amountRaw: null,
        relatedToRequest: false,
      },
      {
        name: 'usdt_delivery',
        assetAddress: USDT,
        status: 'unassessed',
        amountRaw: null,
        relatedToRequest: true,
      },
    ],
    finalPayout: { assetAddress: USDT, status: 'unassessed', amountRaw: null },
  }
}
