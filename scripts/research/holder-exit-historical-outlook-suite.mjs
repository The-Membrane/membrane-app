// Offline, app-consumable historical holder-exit evidence for the tracked routes.
// The August 25/67 cohort stays frozen; newer routes are appended as explicit
// supplemental subjects with separately verified evidence.
// Every evidence block keeps its own endpoint. No route-level probability is produced.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import {
  buildHistoricalFlowSummary,
  replayFullArchiveJoin,
} from './aave-usdc-flow-shadow-forecast.mjs'
import { readVerifiedApyUsdTimingDiagnostic } from './apyusd-receipt-timing-backtest.mjs'
import { auditQCashHoldout } from './carry-q-cash-holdout-audit.mjs'
import { buildHolderExitHistoricalBacktest } from './holder-exit-backtest.mjs'
import { readVerifiedHolderExitEpisodePanel } from './holder-exit-episode-panel.mjs'
import {
  readVerifiedHolderExitForceabilityMatrix,
  validateHistoricalSupplierPayoutEvidence,
} from './holder-exit-forceability-matrix.mjs'
import { readSavedLedger } from './morpho-v2-usdc-10k-holder-risk-ledger.mjs'
import { readVerifiedSaturnFinalPaymentBacktest } from './saturn-final-payment-duration-backtest.mjs'
import { readVerifiedSaturnProcessingDiagnostic } from './saturn-queue-processing-backtest.mjs'
import {
  buildSusdePayoutEvidence,
  readVerifiedSusdePayoutEvidence,
} from './holder-exit-susde-payout-evidence.mjs'

export const SCHEMA = 'holder-exit-historical-outlook-suite-v1'
export const AAVE_USDC_ROUTE = 'USDC → supply on Aave V3'
export const AAVE_USDE_ROUTE = 'USDe → supply on Aave V3'
export const AAVE_USDE_DESTINATION = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
export const AAVE_USDE_ASSET = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
export const MORPHO_USDC_ROUTE = 'USDC → VaultV2 [USDC]'
export const SATURN_ROUTE = 'AUSD → Staked USDat [USDat]'
export const APYUSD_ROUTE = 'apxUSD → ApyUSD [apxUSD]'
export const SUSDE_ROUTE = 'USDe → Staked USDe [USDe]'
export const SUSDE_DESTINATION = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
export const UMBRELLA_GHO_ROUTE = 'GHO → UmbrellaStakeToken [GHO]'
export const FLUID_BRIDGE_USDC_ROUTE = 'USDC → FluidBridgeAggregatorProxy [USDC]'
export const EXACT_DIRECT_WITHDRAW_ROUTES = Object.freeze({
  'GHO → sGho [GHO]': 'sgho_v1',
  'USDC → USD3 [USDC]': 'usd3',
  'USDS → StUsds [USDS]': 'stusds',
  'USDS → SUsds [USDS]': 'susds',
})
export const AAVE_USDC_FLOW_EXPORT = resolve(
  'data/research/venue-signals/aave-usdc-flow-stress-summary-v1.json',
)
export const AAVE_USDC_FLOW_EXPORT_SHA256 =
  '3a2360d0a26f47599f6bcd432ae6527b3b4d2c851372f0b44f4eca726ef5762f'
export const HOLDER_ASSAY_ROUTE_SPECS = Object.freeze({
  'AUSD → Staked USDat [USDat]': {
    mechanism: 'staged',
    stageScopes: ['staked_usdat_redeem_eth_call'],
  },
  'AUSD → VaultV2 [AUSD]': {
    mechanism: 'atomic',
    stageScopes: ['direct_morpho_vaultv2_withdraw_eth_call'],
  },
  'EURCV → VaultV2 [EURCV]': {
    mechanism: 'atomic',
    stageScopes: ['direct_morpho_vaultv2_withdraw_eth_call'],
  },
  'GHO → UmbrellaStakeToken [GHO]': {
    mechanism: 'staged',
    stageScopes: ['direct_umbrella_redeem_eth_call'],
  },
  'GHO → fToken [GHO]': {
    mechanism: 'atomic',
    stageScopes: ['direct_fluid_ftoken_withdraw_eth_call'],
  },
  'GHO → sGho [GHO]': { mechanism: 'atomic', stageScopes: ['direct_sgho_withdraw_eth_call'] },
  'LINK → VaultV2 [LINK]': {
    mechanism: 'atomic',
    stageScopes: ['direct_morpho_vaultv2_withdraw_eth_call'],
  },
  'PYUSD → StakingVault [wYLDS]': {
    mechanism: 'staged',
    stageScopes: ['pyusd_staking_first_stage_eth_call'],
  },
  'PYUSD → VaultV2 [PYUSD]': {
    mechanism: 'atomic',
    stageScopes: ['direct_morpho_vaultv2_withdraw_eth_call'],
  },
  'RLUSD → VaultV2 [RLUSD]': {
    mechanism: 'atomic',
    stageScopes: ['direct_morpho_vaultv2_withdraw_eth_call'],
  },
  'USDC → Fluid USD Coin [USDC]': {
    mechanism: 'atomic',
    stageScopes: ['direct_fluid_ftoken_withdraw_eth_call'],
  },
  'USDC → FluidBridgeAggregatorProxy [USDC]': {
    mechanism: 'staged',
    stageScopes: ['fluid_bridge_usdc_first_leg_eth_call'],
  },
  'USDC → USD3 [USDC]': { mechanism: 'atomic', stageScopes: ['direct_usd3_withdraw_eth_call'] },
  'USDC → VaultV2 [USDC]': {
    mechanism: 'atomic',
    stageScopes: ['direct_morpho_vaultv2_withdraw_eth_call'],
  },
  'USDC → supply on Aave V3': {
    mechanism: 'atomic',
    stageScopes: ['direct_aave_withdraw_eth_call'],
  },
  'USDC → supply on Compound v3': {
    mechanism: 'atomic',
    stageScopes: ['direct_compound_v3_withdraw_eth_call'],
  },
  'USDS → SUsds [USDS]': {
    mechanism: 'atomic',
    stageScopes: ['direct_susds_withdraw_eth_call'],
  },
  'USDS → StUsds [USDS]': {
    mechanism: 'atomic',
    stageScopes: ['direct_stusds_withdraw_eth_call'],
  },
  'USDT → FluidBridgeAggregatorProxy [USDC]': {
    mechanism: 'staged',
    stageScopes: ['fluid_bridge_usdt_first_leg_eth_call'],
  },
  'USDT → VaultV2 [USDT]': {
    mechanism: 'atomic',
    stageScopes: ['direct_morpho_vaultv2_withdraw_eth_call'],
  },
  'USDT → fToken [USDT]': {
    mechanism: 'atomic',
    stageScopes: ['direct_fluid_ftoken_withdraw_eth_call'],
  },
  'USDT → supply on Spark': {
    mechanism: 'atomic',
    stageScopes: ['direct_spark_withdraw_eth_call'],
  },
  'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]': {
    mechanism: 'staged',
    stageScopes: ['twyne_pt_borrower_first_leg_eth_call'],
  },
  'USDe → Staked USDe [USDe]': {
    mechanism: 'staged',
    stageScopes: ['susde_pending_unstake_eth_call'],
  },
  'apxUSD → ApyUSD [apxUSD]': {
    mechanism: 'staged',
    stageScopes: ['apyusd_withdraw_initiation_eth_call'],
  },
})

const SOURCE_IDS = Object.freeze([
  'holderAssayBacktest',
  'holderStageEndpointStates',
  'aaveUsdcGrossFlow',
  'morphoUsdcFixed10k',
  'saturnProcessing',
  'saturnFinalPayment',
  'apyUsdTiming',
  'aggregateCashHoldout',
  'susdeRequestToPayout',
])

const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0)
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0
const utc = (value) => {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString()
  if (nonnegative(value))
    return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString()
  return null
}
const compact = (values) => values.filter((value) => value != null)

function sourceFailureReason(error) {
  const message = String(error?.message ?? error ?? 'offline_source_unavailable')
    .trim()
    .split(/\s+/)[0]
  return /^[a-zA-Z0-9_.:-]+$/.test(message) ? message : 'offline_source_unavailable'
}

/** Canonical export produced by a prior full sealed replay; no archive or network access. */
export function readSavedAaveFlowSummary(
  path = AAVE_USDC_FLOW_EXPORT,
  expectedSha256 = AAVE_USDC_FLOW_EXPORT_SHA256,
) {
  const bytes = readFileSync(path)
  if (bytes.length === 0 || bytes.length > 256 * 1024)
    throw Error('historical_outlook_aave_flow_export_size')
  if (
    !/^[0-9a-f]{64}$/.test(expectedSha256) ||
    createHash('sha256').update(bytes).digest('hex') !== expectedSha256
  )
    throw Error('historical_outlook_aave_flow_export_sha256_mismatch')
  const text = bytes.toString('utf8')
  const summary = JSON.parse(text)
  if (
    text !== `${JSON.stringify(summary)}\n` ||
    summary?.study !== 'aave-usdc-historical-flow-summary-v1' ||
    summary?.sourceVerification !== 'full_sealed_replay' ||
    summary?.identity?.chainId !== 1 ||
    summary?.identity?.routeKey !== AAVE_USDC_ROUTE ||
    summary?.identity?.destination?.toLowerCase() !==
      '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c' ||
    summary?.identity?.asset?.toLowerCase() !== '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' ||
    !/^[0-9a-f]{64}$/.test(summary?.source?.joinContentSha256 ?? '')
  )
    throw Error('historical_outlook_aave_flow_export_invalid')
  return summary
}

export function readAaveFlowSummaryWithFallback({
  replay = replayFullArchiveJoin,
  summarize = (joined) => buildHistoricalFlowSummary({ joined, horizonBlocks: 256 }),
  readSaved = readSavedAaveFlowSummary,
} = {}) {
  try {
    return summarize(replay())
  } catch (error) {
    const reason = sourceFailureReason(error)
    if (reason !== 'archive_unexpected_entry') throw error
    return {
      ...readSaved(),
      suiteSource: {
        status: 'pinned_saved_export',
        mode: 'canonical_full_replay_export_fallback',
        replayUnavailableReason: reason,
      },
    }
  }
}

function historicalWindow(values, basis) {
  const instants = compact(values.map(utc)).sort()
  return {
    fromUtc: instants[0] ?? null,
    throughUtc: instants.at(-1) ?? null,
    basis,
  }
}

function evidenceBlock({
  evidenceId,
  evidenceClass,
  endpoint,
  proxyLabel = null,
  samples,
  historicalWindow: window,
  design,
  outcomes,
  limits,
  historicalUse = 'available',
}) {
  if (!['historical_endpoint', 'historical_proxy'].includes(evidenceClass))
    throw Error('historical_outlook_evidence_class_invalid')
  if (!['available', 'abstain'].includes(historicalUse))
    throw Error('historical_outlook_evidence_use_invalid')
  return {
    evidenceId,
    evidenceClass,
    endpoint,
    proxyLabel,
    samples,
    historicalWindow: window,
    design,
    outcomes,
    retrospectiveOnly: true,
    prospectiveValidated: false,
    historicalUse,
    limits,
  }
}

function validateMatrix(matrix) {
  const subjects = matrix?.subjects
  if (
    matrix?.scope !== 'offline_frozen_holder_exit_forceability_gate' ||
    matrix?.summary?.routeGroups !== 25 ||
    matrix?.summary?.exactSubjects !== 67 ||
    !Array.isArray(subjects) ||
    subjects.length !== 67
  )
    throw Error('historical_outlook_matrix_invalid')
  const routes = new Map()
  for (const subject of subjects) {
    if (
      typeof subject?.routeKey !== 'string' ||
      !subject.routeKey ||
      typeof subject.destination !== 'string' ||
      typeof subject.originalAsset !== 'string' ||
      !['atomic', 'staged'].includes(subject.mechanism)
    )
      throw Error('historical_outlook_subject_invalid')
    const group = routes.get(subject.routeKey) ?? []
    if (group.some((row) => row.mechanism !== subject.mechanism))
      throw Error('historical_outlook_mechanism_conflict')
    group.push(subject)
    routes.set(subject.routeKey, group)
  }
  if (routes.size !== 25) throw Error('historical_outlook_route_count_invalid')
  return routes
}

function validateSupplementalSubject(matrix, frozenGroups) {
  const supplemental = matrix?.supplemental
  if (!Array.isArray(supplemental) || supplemental.length !== 1)
    throw Error('historical_outlook_supplemental_invalid')
  const subject = supplemental[0]
  const payout = subject?.historicalSupplierPayoutEvidence
  if (
    subject?.routeKey !== AAVE_USDE_ROUTE ||
    subject.destination?.toLowerCase() !== AAVE_USDE_DESTINATION ||
    subject.originalAsset?.toLowerCase() !== AAVE_USDE_ASSET ||
    subject.scope !== 'outside_frozen_25_67' ||
    subject.mechanism !== 'unassessed' ||
    subject.holderExecutableExit !== false ||
    subject.forecastValidated !== false ||
    frozenGroups.has(AAVE_USDE_ROUTE)
  )
    throw Error('historical_outlook_supplemental_invalid')
  if (payout != null && !validateHistoricalSupplierPayoutEvidence(payout))
    throw Error('historical_outlook_supplemental_evidence_invalid')
  return {
    ...subject,
    mechanism: 'atomic',
    directIssueCellObservations: 0,
    measuredDirectBaselineCellObservations: 0,
    stageIssueObservations: 0,
    minedDeliveryAttestations: 0,
    terminalSameEpisodeFinalAssetPaidProofs: 0,
  }
}

function directCallEvidence(subjects) {
  const stableReverts = subjects.flatMap((row) => row.historicalStableSimulatedReverts ?? [])
  if (stableReverts.length === 0) return null
  return evidenceBlock({
    evidenceId: 'historical_fixed_10k_stable_revert_history',
    evidenceClass: 'historical_endpoint',
    endpoint: 'fixed_10k_exact_holder_withdrawal_call_at_sampled_horizon',
    samples: {
      fixed10kStableRevertEpisodes: stableReverts.length,
      sampledHorizonCells: sum(stableReverts, (row) => row.sampledHours?.length ?? 0),
    },
    historicalWindow: historicalWindow(
      stableReverts.map((row) => row.anchorAtUtc),
      'fixed_q_anchor_times_from_sealed_cells',
    ),
    design: {
      unit: 'holder_vault_anchor_episode',
      execution: 'saved_historical_eth_call_cell',
    },
    outcomes: {
      stableRevertEpisodes: stableReverts.length,
    },
    limits: [
      'call_result_is_not_mined_holder_payment',
      'q_by_horizon_cells_can_share_one_episode',
      'cause_of_revert_is_not_identified',
    ],
  })
}

function directPayoutEvidence(subjects) {
  const reconciledTransactions = sum(
    subjects,
    (row) => row.historicalDirectFinalAssetPayoutTransactions ?? 0,
  )
  const supplier = subjects
    .map((row) => row.historicalSupplierPayoutEvidence)
    .filter((row) => row?.status === 'observed')
  const sameHolderSupplierPayouts = sum(supplier, (row) => row.sameHolderPayoutCount ?? 0)
  if (reconciledTransactions + sameHolderSupplierPayouts === 0) return null
  return evidenceBlock({
    evidenceId: 'bounded_mined_holder_payout_history',
    evidenceClass: 'historical_endpoint',
    endpoint: 'mined_final_asset_transfer_to_holder',
    samples: {
      reconciledTransactions,
      supplierArchives: supplier.length,
      sameHolderSupplierPayouts,
    },
    historicalWindow: historicalWindow(
      supplier.flatMap((row) => [row.coverage?.startMs, row.coverage?.endMs]),
      supplier.length
        ? 'selected_bounded_contiguous_supplier_archives'
        : 'bounded_reconciled_transaction_archives_without_a_common_route_window',
    ),
    design: {
      unit: 'mined_transaction_or_classified_receipt_payout',
      denominator: 'bounded_archive_only',
    },
    outcomes: {
      reconciledTransactions,
      sameHolderSupplierPayouts,
    },
    limits: [
      'not_an_exhaustive_historical_total',
      'positive_only_no_failure_denominator',
      'supplier_and_reconciled_archives_are_separate_denominators',
      'no_counterfactual_requested_q_for_each_transaction',
    ],
  })
}

function susdeRequestToPayoutEvidence(facts, subjects, asOfUtc) {
  if (facts == null) return null
  if (!Array.isArray(facts) || facts.length > 5)
    throw Error('historical_outlook_susde_payout_invalid')
  const subject = subjects.find(
    (row) =>
      row.destination.toLowerCase() === SUSDE_DESTINATION &&
      row.originalAsset.toLowerCase() === AAVE_USDE_ASSET,
  )
  if (!subject || subjects.length !== 1) throw Error('historical_outlook_susde_subject_invalid')
  const cutoff = asOfUtc == null ? Infinity : Date.parse(asOfUtc)
  if (asOfUtc != null && utc(asOfUtc) !== asOfUtc) throw Error('historical_outlook_as_of_invalid')
  const seenIssues = new Set()
  const seenPayouts = new Set()
  const available = []
  for (const fact of facts) {
    const requestMs = Date.parse(fact?.requestAtUtc)
    const payoutMs = Date.parse(fact?.payoutAtUtc)
    const availableMs = Date.parse(fact?.localEvidenceAvailableAtUtc)
    if (
      fact?.subject !== `${SUSDE_ROUTE}\0${SUSDE_DESTINATION}\0${AAVE_USDE_ASSET}` ||
      !nonnegative(fact.issueSequence) ||
      fact.issueSequence < 1 ||
      !/^[0-9a-f]{64}$/.test(fact.issueSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(fact.holderCommitment ?? '') ||
      !/^[1-9][0-9]*$/.test(fact.qRaw ?? '') ||
      fact.qUnit !== 'USDe_pending_whole_queue_assets' ||
      !/^[0-9a-f]{64}$/.test(fact.sidecarSha256 ?? '') ||
      !/^0x[0-9a-f]{64}$/.test(fact.payoutTransactionHash ?? '') ||
      utc(fact.requestAtUtc) !== fact.requestAtUtc ||
      utc(fact.payoutAtUtc) !== fact.payoutAtUtc ||
      utc(fact.localEvidenceAvailableAtUtc) !== fact.localEvidenceAvailableAtUtc ||
      !(requestMs < payoutMs && payoutMs <= availableMs) ||
      fact.observedRequestToPayoutSeconds !== Math.floor((payoutMs - requestMs) / 1_000) ||
      fact.minedFinalAssetPayoutProven !== true ||
      fact.forecastEligible !== false ||
      fact.calibratedRestrictionDuration !== false ||
      fact.localEvidenceAvailabilityClock !== 'unwitnessed_local_wall_clock' ||
      seenIssues.has(fact.issueSequence) ||
      seenPayouts.has(fact.payoutTransactionHash)
    )
      throw Error('historical_outlook_susde_payout_invalid')
    seenIssues.add(fact.issueSequence)
    seenPayouts.add(fact.payoutTransactionHash)
    if (payoutMs <= cutoff && availableMs <= cutoff) available.push(fact)
  }
  if (!available.length) return null
  return evidenceBlock({
    evidenceId: 'susde_exact_request_to_mined_usde_payout_history',
    evidenceClass: 'historical_endpoint',
    endpoint: 'same_holder_same_queue_request_to_mined_final_usde_payout',
    samples: {
      linkedRequestPayoutEpisodes: available.length,
      distinctHolderCommitments: new Set(available.map((fact) => fact.holderCommitment)).size,
    },
    historicalWindow: {
      ...historicalWindow(
        available.flatMap((fact) => [fact.requestAtUtc, fact.payoutAtUtc]),
        'verified_request_and_mined_payout_block_times',
      ),
      localEvidenceAvailableThroughUtc: available
        .map((fact) => fact.localEvidenceAvailableAtUtc)
        .sort()
        .at(-1),
    },
    design: {
      unit: 'same_holder_same_queue_exact_raw_q_episode',
      paymentAsset: 'USDe',
      elapsedTimeIncludes: ['protocol_cooldown', 'holder_action'],
      localEvidenceAvailabilityClock: 'unwitnessed_local_wall_clock',
    },
    outcomes: {
      episodes: available.map((fact) => ({
        issueSequence: fact.issueSequence,
        issueSha256: fact.issueSha256,
        holderCommitment: fact.holderCommitment,
        qRaw: fact.qRaw,
        requestAtUtc: fact.requestAtUtc,
        payoutAtUtc: fact.payoutAtUtc,
        localEvidenceAvailableAtUtc: fact.localEvidenceAvailableAtUtc,
        observedRequestToPayoutSeconds: fact.observedRequestToPayoutSeconds,
        sidecarSha256: fact.sidecarSha256,
        payoutTransactionHash: fact.payoutTransactionHash,
      })),
    },
    limits: [
      'observed_elapsed_time_includes_holder_action',
      'not_a_restriction_recovery_duration',
      'not_a_future_payment_probability_or_duration_forecast',
      'bounded_positive_episode_sample_without_failure_denominator',
      'local_evidence_availability_clock_is_not_independently_witnessed',
    ],
  })
}

function sampledConditionEvidence(subjects) {
  const observations = sum(subjects, (row) => row.sampledConditionObservations ?? 0)
  if (observations === 0) return null
  const zeroAssetSubjects = subjects.filter((row) => row.sampledZeroAssetsPositiveShares).length
  return evidenceBlock({
    evidenceId: 'sampled_vault_condition_history',
    evidenceClass: 'historical_proxy',
    endpoint: 'vault_assets_and_share_supply_condition',
    proxyLabel: 'vault_state_proxy_not_holder_exit',
    samples: { observations, zeroAssetsPositiveSharesSubjects: zeroAssetSubjects },
    historicalWindow: historicalWindow(
      subjects.map((row) => row.latestSampledCondition?.blockTime),
      'verified_condition_sample_times',
    ),
    design: { unit: 'hash_pinned_vault_condition_sample' },
    outcomes: { latestZeroAssetsPositiveSharesSubjects: zeroAssetSubjects },
    limits: ['point_samples_do_not_prove_continuity', 'no_holder_q_execution'],
  })
}

function receiptCohortEvidence(subjects) {
  const cohorts = subjects.map((row) => row.historicalReceiptCohort).filter(Boolean)
  if (!cohorts.length) return null
  const timing = cohorts[0].historicalRequestToMinedPaymentTiming
  return evidenceBlock({
    evidenceId: 'historical_receipt_to_holder_payment',
    evidenceClass: 'historical_endpoint',
    endpoint: 'holder_request_to_mined_holder_payment',
    samples: {
      mintedReceipts: sum(cohorts, (row) => row.mintedReceipts),
      paidReceipts: sum(cohorts, (row) => row.sameReceiptHolderPaidClaims),
      openRightCensored: sum(cohorts, (row) => row.openCensoredReceipts),
    },
    historicalWindow: historicalWindow(
      cohorts.map((row) => row.historicalRequestToMinedPaymentTiming?.censorTimestamp),
      'frozen_receipt_cohort_through_last_verified_payment',
    ),
    design: {
      unit: 'receipt',
      censoring: 'open_receipts_are_right_censored',
    },
    outcomes: timing
      ? {
          paidWithin7Days: timing.paidWithin7Days,
          paidWithin21Days: timing.paidWithin21Days,
          paidWithin28Days: timing.paidWithin28Days,
          medianRequestToMinedPayoutSeconds: timing.medianRequestToMinedPayoutSeconds,
        }
      : null,
    limits: [
      'historical_cohort_not_prospective_validation',
      'payment_timing_does_not_establish_future_claimability',
    ],
  })
}

function publicConversionEvidence(subjects) {
  const quotes = subjects.map((row) => row.historicalPublicConversionQuote).filter(Boolean)
  if (!quotes.length) return null
  return evidenceBlock({
    evidenceId: 'historical_intermediate_conversion_quote',
    evidenceClass: 'historical_proxy',
    endpoint: 'intermediate_asset_to_final_asset_public_quote',
    proxyLabel: 'quote_only_not_mined_conversion',
    samples: { quoteSizes: sum(quotes, (row) => row.sizes?.length ?? 0) },
    historicalWindow: {
      fromUtc: null,
      throughUtc: null,
      fromBlock: Math.min(...quotes.map((row) => row.cutoffBlock)),
      throughBlock: Math.max(...quotes.map((row) => row.cutoffBlock)),
      basis: 'verified_quote_cutoff_blocks',
    },
    design: { unit: 'public_conversion_quote_at_fixed_size' },
    outcomes: { quoteSets: quotes.length },
    limits: ['quote_is_not_execution', 'intermediate_stage_is_not_full_route_exit'],
  })
}

function matrixEvidence(subjects) {
  return compact([
    subjects[0].mechanism === 'atomic' ? directCallEvidence(subjects) : null,
    subjects[0].mechanism === 'atomic'
      ? directPayoutEvidence(subjects)
      : receiptCohortEvidence(subjects),
    sampledConditionEvidence(subjects),
    publicConversionEvidence(subjects),
  ])
}

function collectionReadiness(subjects) {
  return {
    directIssueCells: sum(subjects, (row) => row.directIssueCellObservations ?? 0),
    measuredDirectBaselineCells: sum(
      subjects,
      (row) => row.measuredDirectBaselineCellObservations ?? 0,
    ),
    stageIssueObservations: sum(subjects, (row) => row.stageIssueObservations ?? 0),
    minedDeliveryAttestations: sum(subjects, (row) => row.minedDeliveryAttestations ?? 0),
    sameEpisodeFinalAssetPaidProofs: sum(
      subjects,
      (row) => row.terminalSameEpisodeFinalAssetPaidProofs ?? 0,
    ),
    forecastValidated: false,
  }
}

function assayEvaluationMetrics(value) {
  if (!value || typeof value !== 'object') throw Error('historical_outlook_assay_metrics_invalid')
  return {
    scoredRows: value.scoredRows,
    uniqueIssueClusters: value.uniqueIssueClusters,
    observedCallableRows: value.observedCallableRows,
    observedImpairedRows: value.observedImpairedRows,
    rowsAreIndependentSamples: value.rowsAreIndependentSamples,
    statisticalIndependenceValidated: value.statisticalIndependenceValidated,
    accuracy: value.accuracy,
    brierScore: value.brierScore,
    logLoss: value.logLoss,
    clusterBalancedAccuracy: value.clusterBalancedAccuracy,
    clusterBalancedBrierScore: value.clusterBalancedBrierScore,
  }
}

function holderAssayEvidenceByRoute(backtest, groups, manifestSha256) {
  if (backtest == null) return new Map()
  if (
    backtest.scope !== 'holder_exit_historical_walk_forward_backtest_v1' ||
    backtest.studyType !== 'retrospective_walk_forward_backtest' ||
    backtest.summary?.routeGroups !== 25 ||
    backtest.summary?.exactSubjects !== 67 ||
    backtest.manifestSha256 !== manifestSha256 ||
    backtest.forecastValidated !== false ||
    backtest.prospectiveValidation !== false ||
    backtest.statisticalIndependenceValidated !== false ||
    backtest.labelAvailabilityClockIndependentlyWitnessed !== false ||
    backtest.summary?.rowsAreIndependentSamples !== false ||
    backtest.summary?.independentSampleCount !== null ||
    !Array.isArray(backtest.byVenueGroup) ||
    backtest.byVenueGroup.length !== 25
  )
    throw Error('historical_outlook_assay_backtest_invalid')
  const expected = new Set(groups.keys())
  if (Object.keys(HOLDER_ASSAY_ROUTE_SPECS).length !== expected.size)
    throw Error('historical_outlook_assay_route_specs_invalid')
  for (const [routeKey, subjects] of groups) {
    const spec = HOLDER_ASSAY_ROUTE_SPECS[routeKey]
    if (!spec || subjects.some((subject) => subject.mechanism !== spec.mechanism))
      throw Error('historical_outlook_assay_route_specs_invalid')
  }
  const byRoute = new Map()
  for (const group of backtest.byVenueGroup) {
    const subjects = groups.get(group?.routeKey)
    const spec = HOLDER_ASSAY_ROUTE_SPECS[group?.routeKey]
    if (
      !expected.has(group?.routeKey) ||
      byRoute.has(group.routeKey) ||
      group.exactSubjects !== subjects?.length ||
      !Array.isArray(group.stageScopes) ||
      JSON.stringify([...group.stageScopes].sort()) !== JSON.stringify(spec?.stageScopes) ||
      !nonnegative(group.rawRows) ||
      !nonnegative(group.primaryRows) ||
      !nonnegative(group.scorableRows) ||
      !nonnegative(group.uniqueIssueClusters) ||
      group.rowsAreIndependentSamples !== false ||
      group.statisticalIndependenceValidated !== false ||
      !['no_episode_rows', 'no_scorable_outcomes', 'retrospectively_scorable'].includes(
        group.availability,
      )
    )
      throw Error('historical_outlook_assay_group_invalid')
    const historical = group.historicalAssayStateBaseline
    const persistence = historical?.pairedAssayStatePersistence
    const transitions = group.transitions ?? {}
    const transitionEvents =
      (transitions.lost_exitability ?? 0) + (transitions.recovered_exitability ?? 0)
    const scorable = group.scorableRows > 0
    byRoute.set(
      group.routeKey,
      evidenceBlock({
        evidenceId: 'common_holder_assay_walk_forward_backtest',
        evidenceClass: 'historical_proxy',
        endpoint: 'holder_specific_protocol_stage_assay_state_at_saved_horizon',
        proxyLabel: 'saved_stage_assay_not_full_route_holder_exit',
        samples: {
          rawRows: group.rawRows,
          primaryRows: group.primaryRows,
          scorableRows: group.scorableRows,
          scorableIssueClusters: group.uniqueIssueClusters,
          subjectsWithScorableRows: group.subjectsWithScorableRows,
          historicalBaselineScoredRows: historical.scoredRows,
          historicalBaselineScoredClusters: historical.uniqueIssueClusters,
        },
        historicalWindow: {
          fromUtc: null,
          throughUtc: backtest.asOfUtc,
          basis: 'saved_episode_panel_issue_and_local_score_clocks',
        },
        design: {
          unit: 'correlated_holder_q_by_horizon_assay_row',
          availability: group.availability,
          stageScopes: [...group.stageScopes],
          abstentions: group.abstentions,
          historicalBaselineAbstentions: historical.abstentionReasons,
          historicalBaselineTrainingTiers: historical.trainingTiers,
        },
        outcomes: {
          transitions,
          observedTransitionEvents: transitionEvents,
          zeroObservedTransitionEvents: transitionEvents === 0,
          historicalAssayStateBaseline: assayEvaluationMetrics(historical),
          pairedAssayStatePersistence: assayEvaluationMetrics(persistence),
          pairedDeltasVersusPersistence: historical.pairedDeltasVersusPersistence,
          independence: {
            rowsAreIndependentSamples: false,
            statisticalIndependenceValidated: false,
            independentSampleCount: null,
          },
        },
        historicalUse: scorable ? 'available' : 'abstain',
        limits: [
          'saved_assay_state_is_not_mined_holder_payment',
          'protocol_stage_assay_is_not_full_route_exit',
          'not_a_capacity_forecast',
          'rows_and_issue_cells_are_not_independent_samples',
          'saved_local_label_availability_clock_is_not_independently_witnessed',
          ...(transitionEvents === 0
            ? [
                'zero_observed_state_transitions_prevent_alert_discrimination_and_duration_estimation',
              ]
            : []),
          ...(!scorable ? ['no_scorable_historical_outcomes'] : []),
        ],
      }),
    )
  }
  if (byRoute.size !== expected.size) throw Error('historical_outlook_assay_group_missing')
  return byRoute
}

function holderStageEndpointEvidenceByRoute(panel, groups, manifestSha256, asOfUtc) {
  if (panel == null) return new Map()
  if (
    panel.scope !== 'offline_frozen_25_67_holder_episode_panel' ||
    !['offline_sealed_replay', 'caller_supplied'].includes(panel.sourceVerification) ||
    panel.manifestSha256 !== manifestSha256 ||
    panel.forecastValidated !== false ||
    panel.holderExecutableExit !== false ||
    panel.summary?.routeGroups !== 25 ||
    panel.summary?.exactSubjects !== 67 ||
    !Array.isArray(panel.subjects) ||
    panel.subjects.length !== 67
  )
    throw Error('historical_outlook_stage_panel_invalid')

  const selected = new Map()
  for (const routeKey of [UMBRELLA_GHO_ROUTE, FLUID_BRIDGE_USDC_ROUTE]) {
    const expected = groups.get(routeKey)
    const matches = panel.subjects.filter((row) => row.routeKey === routeKey)
    const stageScope = HOLDER_ASSAY_ROUTE_SPECS[routeKey].stageScopes[0]
    if (
      expected?.length !== 1 ||
      matches.length !== 1 ||
      matches[0].destination?.toLowerCase() !== expected[0].destination.toLowerCase() ||
      matches[0].asset?.toLowerCase() !== expected[0].originalAsset.toLowerCase() ||
      matches[0].stageScope !== stageScope ||
      !Array.isArray(matches[0].episodes) ||
      matches[0].episodes.length > 100
    )
      throw Error('historical_outlook_stage_subject_invalid')
    const subject = matches[0]
    const primaryRows = subject.episodes.filter((row) => row.analysisPrimaryForCell === true)
    if (primaryRows.length !== subject.episodes.length) {
      // These two lanes have no overlapping assay versions. A future overlap
      // needs an explicit issue/Q/horizon selection rule before publication.
      throw Error('historical_outlook_stage_primary_invalid')
    }
    const holderByIssue = new Map()
    for (const row of primaryRows) {
      if (!/^[0-9a-f]{64}$/.test(row.holderCommitment ?? ''))
        throw Error('historical_outlook_stage_row_invalid')
      const priorHolder = holderByIssue.get(row.issueSha256)
      if (priorHolder != null && priorHolder !== row.holderCommitment)
        throw Error('historical_outlook_stage_issue_conflict')
      holderByIssue.set(row.issueSha256, row.holderCommitment)
    }
    const rows = primaryRows.filter((row) =>
      routeKey === UMBRELLA_GHO_ROUTE
        ? row.rawBaselineStatus === 'evm_revert'
        : row.rawBaselineStatus === 'success',
    )
    if (!rows.length) continue
    const issueRows = new Map()
    const seenCells = new Set()
    const scoreByIssueHorizon = new Map()
    const scoreOwner = new Map()
    const cutoff = asOfUtc == null ? Infinity : Date.parse(asOfUtc)
    for (const row of rows) {
      const issueAt = Date.parse(row.issueAtUtc)
      const targetAt = Date.parse(row.targetAtUtc)
      const deadlineAt = Date.parse(row.deadlineAtUtc)
      const observedAt = row.observedAtUtc == null ? null : Date.parse(row.observedAtUtc)
      const availableAt =
        row.labelAvailableAtUtc == null ? null : Date.parse(row.labelAvailableAtUtc)
      const cell = `${row.issueSha256}:${row.qRaw}:${row.plannedHorizonHours}`
      const scoreCell = `${row.issueSha256}:${row.plannedHorizonHours}`
      const scored = row.rawScoreStatus === 'measured' || row.rawScoreStatus === 'missed_window'
      const measured = row.rawScoreStatus === 'measured'
      if (
        row.stageScope !== stageScope ||
        row.subject !==
          `${routeKey}\0${subject.destination.toLowerCase()}\0${subject.asset.toLowerCase()}` ||
        !/^[0-9a-f]{64}$/.test(row.issueSha256 ?? '') ||
        !/^[0-9a-f]{64}$/.test(row.holderCommitment ?? '') ||
        row.issueClusterSha256 !== row.issueSha256 ||
        !/^[1-9][0-9]*$/.test(row.qRaw ?? '') ||
        !nonnegative(row.plannedHorizonHours) ||
        row.plannedHorizonHours === 0 ||
        utc(row.issueAtUtc) !== row.issueAtUtc ||
        utc(row.targetAtUtc) !== row.targetAtUtc ||
        utc(row.deadlineAtUtc) !== row.deadlineAtUtc ||
        targetAt <= issueAt ||
        deadlineAt <= targetAt ||
        issueAt > cutoff ||
        (scored
          ? !/^[0-9a-f]{64}$/.test(row.scoreSha256 ?? '') ||
            row.scoreSha256 === row.issueSha256 ||
            utc(row.labelAvailableAtUtc) !== row.labelAvailableAtUtc ||
            availableAt < targetAt ||
            availableAt > cutoff ||
            (measured
              ? utc(row.observedAtUtc) !== row.observedAtUtc ||
                observedAt < targetAt ||
                observedAt > availableAt ||
                availableAt > deadlineAt
              : row.observedAtUtc != null ||
                availableAt <= deadlineAt ||
                row.rawScoreOutcome != null ||
                row.rawScoreSimulationStatus != null ||
                row.rawTransition != null)
          : row.rawScoreStatus != null ||
            row.scoreSha256 != null ||
            row.labelAvailableAtUtc != null ||
            row.observedAtUtc != null ||
            row.rawScoreOutcome != null ||
            row.rawScoreSimulationStatus != null ||
            row.rawScoreGate != null ||
            row.rawTransition != null) ||
        seenCells.has(cell)
      )
        throw Error('historical_outlook_stage_row_invalid')
      seenCells.add(cell)
      const scoreIdentity = `${row.scoreSha256}:${row.rawScoreStatus}:${row.labelAvailableAtUtc}:${row.observedAtUtc}`
      const priorScore = scoreByIssueHorizon.get(scoreCell)
      if (priorScore && priorScore !== scoreIdentity)
        throw Error('historical_outlook_stage_score_link_invalid')
      scoreByIssueHorizon.set(scoreCell, scoreIdentity)
      if (scored) {
        const priorOwner = scoreOwner.get(row.scoreSha256)
        if (priorOwner && priorOwner !== scoreCell)
          throw Error('historical_outlook_stage_score_link_invalid')
        scoreOwner.set(row.scoreSha256, scoreCell)
      }
      const prior = issueRows.get(row.issueSha256)
      if (
        prior &&
        (prior.issueAtUtc !== row.issueAtUtc ||
          prior.rawBaselineGate !== row.rawBaselineGate ||
          prior.holderCommitment !== row.holderCommitment)
      )
        throw Error('historical_outlook_stage_issue_conflict')
      issueRows.set(row.issueSha256, row)
    }
    if (!nonnegative(subject.issueClusters) || subject.issueClusters < issueRows.size)
      throw Error('historical_outlook_stage_issue_count_invalid')

    const issueTimes = [...issueRows.values()].map((row) => row.issueAtUtc)
    const scoreTimes = rows.map((row) => row.labelAvailableAtUtc).filter(Boolean)
    const window = historicalWindow(
      [...issueTimes, ...scoreTimes],
      'verified_issue_and_score_artifact_clocks_unwitnessed_local_availability',
    )
    const common = {
      historicalWindow: window,
      limits: [
        'historical_eth_call_is_not_mined_holder_payment',
        'first_leg_is_not_full_route_exit',
        'rows_share_issue_clusters_and_are_not_independent',
        'local_evidence_availability_clock_is_not_independently_witnessed',
        'no_transition_probability_or_duration_estimate',
        'historical_q_cases_are_not_the_requested_user_amount',
      ],
    }
    if (routeKey === UMBRELLA_GHO_ROUTE) {
      if (
        rows.some(
          (row) =>
            row.lane !== 'umbrella_stkgho' ||
            row.qRaw !== '1000000000000000000' ||
            row.qUnit !== 'stkGHO_shares' ||
            row.baseline !== 'inconclusive' ||
            row.rawBaselineStatus !== 'evm_revert' ||
            row.outcome?.status !== 'not_at_risk' ||
            !['waiting', 'cooldown_not_started', 'window_expired'].includes(row.rawBaselineGate) ||
            (row.rawScoreStatus === 'measured' &&
              !(
                (row.rawScoreOutcome === 'evm_revert' && row.rawTransition === 'still_reverting') ||
                (row.rawScoreOutcome === 'success' &&
                  row.rawTransition === 'simulated_call_recovery')
              )) ||
            (row.rawScoreStatus !== 'measured' && row.rawScoreStatus !== null),
        )
      )
        throw Error('historical_outlook_umbrella_state_invalid')
      const baselineGates = Object.fromEntries(
        ['waiting', 'cooldown_not_started', 'window_expired'].map((gate) => [
          gate,
          [...issueRows.values()].filter((row) => row.rawBaselineGate === gate).length,
        ]),
      )
      const measuredStillReverting = rows.filter(
        (row) => row.rawTransition === 'still_reverting',
      ).length
      const measuredLaterCallable = rows.filter(
        (row) => row.rawTransition === 'simulated_call_recovery',
      ).length
      selected.set(
        routeKey,
        evidenceBlock({
          evidenceId: 'umbrella_gho_exact_stage_revert_states',
          evidenceClass: 'historical_endpoint',
          endpoint: 'holder_specific_umbrella_redeem_eth_call_and_gate_state',
          samples: {
            issueClusters: issueRows.size,
            qHorizonCells: rows.length,
            measuredFollowupCells: measuredStillReverting + measuredLaterCallable,
          },
          design: {
            unit: 'correlated_one_stkgho_share_by_horizon_eth_call',
            stageScope,
          },
          outcomes: {
            baselineRevertIssueClusters: issueRows.size,
            baselineGates,
            measuredStillReverting,
            measuredLaterCallable,
            observedCallableToImpairedTransitions: 0,
            observedImpairedToCallableTransitions: 0,
            capacityProjection: null,
            durationProjection: null,
          },
          ...common,
        }),
      )
    } else {
      if (
        rows.some(
          (row) =>
            row.lane !== 'fluid_bridge_usdc' ||
            row.qUnit !== 'USDC_first_leg_assets' ||
            row.originalAsset?.toLowerCase() !== subject.asset.toLowerCase() ||
            row.firstLegAsset?.toLowerCase() !== subject.asset.toLowerCase() ||
            row.firstLegOnly !== true ||
            row.baseline !== 'simulated_callable' ||
            row.rawBaselineStatus !== 'success' ||
            !['censored', 'missing', 'pending', 'simulated_callable', 'inconclusive'].includes(
              row.outcome?.status,
            ) ||
            (row.outcome.status === 'censored' &&
              !['missed_window', 'measured'].includes(row.rawScoreStatus)) ||
            (row.rawScoreStatus === 'missed_window' &&
              (row.outcome.status !== 'censored' ||
                row.outcome.reason !== 'capture_window_missed')) ||
            (row.rawScoreStatus === 'measured' &&
              !(
                (row.outcome.status === 'simulated_callable' &&
                  row.rawScoreOutcome === 'simulated_success' &&
                  row.rawScoreSimulationStatus === 'success') ||
                (row.outcome.status === 'inconclusive' &&
                  ['simulated_revert', 'unavailable'].includes(row.rawScoreOutcome)) ||
                (row.outcome.status === 'censored' &&
                  row.outcome.reason === 'holder_attrition' &&
                  ['holder_absent', 'simulated_revert'].includes(row.rawScoreOutcome) &&
                  row.rawScoreSimulationStatus === 'position_insufficient')
              )) ||
            (['missing', 'pending'].includes(row.outcome.status) && row.rawScoreStatus !== null) ||
            (['simulated_callable', 'inconclusive'].includes(row.outcome.status) &&
              row.rawScoreStatus !== 'measured'),
        )
      )
        throw Error('historical_outlook_fluid_bridge_state_invalid')
      const qCases = new Set(rows.map((row) => row.qRaw))
      const byHorizon = [...new Set(rows.map((row) => row.plannedHorizonHours))]
        .sort((a, b) => a - b)
        .map((horizonHours) => ({
          horizonHours,
          qCases: rows.filter((row) => row.plannedHorizonHours === horizonHours).length,
          missedWindow: rows.filter(
            (row) =>
              row.plannedHorizonHours === horizonHours && row.rawScoreStatus === 'missed_window',
          ).length,
          otherCensored: rows.filter(
            (row) =>
              row.plannedHorizonHours === horizonHours &&
              row.outcome.status === 'censored' &&
              row.rawScoreStatus !== 'missed_window',
          ).length,
          missing: rows.filter(
            (row) => row.plannedHorizonHours === horizonHours && row.outcome.status === 'missing',
          ).length,
          pending: rows.filter(
            (row) => row.plannedHorizonHours === horizonHours && row.outcome.status === 'pending',
          ).length,
          measuredCallable: rows.filter(
            (row) =>
              row.plannedHorizonHours === horizonHours &&
              row.outcome.status === 'simulated_callable',
          ).length,
          inconclusive: rows.filter(
            (row) =>
              row.plannedHorizonHours === horizonHours && row.outcome.status === 'inconclusive',
          ).length,
        }))
      const measuredFollowupCells = rows.filter((row) => row.rawScoreStatus === 'measured').length
      selected.set(
        routeKey,
        evidenceBlock({
          evidenceId: 'fluid_bridge_usdc_first_leg_baseline_and_censoring',
          evidenceClass: 'historical_endpoint',
          endpoint: 'holder_specific_usdc_bridge_first_leg_eth_call_and_followup_censoring',
          samples: {
            issueClusters: issueRows.size,
            qCases: qCases.size,
            qHorizonCells: rows.length,
            measuredFollowupCells,
          },
          design: {
            unit: 'correlated_holder_usdc_first_leg_q_by_horizon_eth_call',
            stageScope,
          },
          outcomes: {
            baselineCallableQCases: qCases.size,
            byHorizon,
            measuredLaterCallableCells: sum(byHorizon, (row) => row.measuredCallable),
            measuredLaterInconclusiveCells: sum(byHorizon, (row) => row.inconclusive),
            observedCallableToImpairedTransitions: 0,
            observedImpairedToCallableTransitions: 0,
            capacityProjection: null,
            durationProjection: null,
          },
          ...common,
        }),
      )
    }
  }
  return selected
}

function exactDirectWithdrawEvidenceByRoute(panel, groups, manifestSha256, asOfUtc) {
  if (panel == null) return new Map()
  if (
    panel.scope !== 'offline_frozen_25_67_holder_episode_panel' ||
    !['offline_sealed_replay', 'caller_supplied'].includes(panel.sourceVerification) ||
    panel.manifestSha256 !== manifestSha256 ||
    panel.forecastValidated !== false ||
    panel.holderExecutableExit !== false ||
    panel.summary?.routeGroups !== 25 ||
    panel.summary?.exactSubjects !== 67 ||
    !Array.isArray(panel.subjects) ||
    panel.subjects.length !== 67
  )
    throw Error('historical_outlook_direct_panel_invalid')
  const cutoff = asOfUtc == null ? Infinity : Date.parse(asOfUtc)
  const result = new Map()
  for (const [routeKey, lane] of Object.entries(EXACT_DIRECT_WITHDRAW_ROUTES)) {
    const expected = groups.get(routeKey)
    const matches = panel.subjects.filter((row) => row.routeKey === routeKey)
    const stageScope = HOLDER_ASSAY_ROUTE_SPECS[routeKey].stageScopes[0]
    if (matches.every((row) => Array.isArray(row.episodes) && row.episodes.length === 0)) continue
    if (
      expected?.length !== 1 ||
      matches.length !== 1 ||
      matches[0].destination?.toLowerCase() !== expected[0].destination.toLowerCase() ||
      matches[0].asset?.toLowerCase() !== expected[0].originalAsset.toLowerCase() ||
      matches[0].stageScope !== stageScope ||
      !Array.isArray(matches[0].episodes) ||
      matches[0].episodes.length > 1_000
    )
      throw Error('historical_outlook_direct_subject_invalid')
    const subject = matches[0]
    const identity = `${routeKey}\0${subject.destination.toLowerCase()}\0${subject.asset.toLowerCase()}`
    const seenCells = new Set()
    const holderByIssue = new Map()
    const baselineByIssue = new Map()
    const scoreByIssueHorizon = new Map()
    const scoreOwner = new Map()
    const rows = []
    for (const row of subject.episodes) {
      // A row is one sealed same-holder, exact-Q simulated withdrawal, not a mined transfer.
      if (row.analysisPrimaryForCell !== true) continue
      if (row.subject !== identity || row.stageScope !== stageScope || row.lane !== lane)
        throw Error('historical_outlook_direct_row_invalid')
      if (row.rawBaselineStatus !== 'success') continue
      if (
        row.qUnit !== 'asset_raw' ||
        !/^[1-9][0-9]*$/.test(row.qRaw ?? '') ||
        !/^[0-9a-f]{64}$/.test(row.issueSha256 ?? '') ||
        !/^[0-9a-f]{64}$/.test(row.holderCommitment ?? '') ||
        !/^[0-9a-f]{64}$/.test(row.baselineBlockHash?.slice(2) ?? '') ||
        !/^[1-9][0-9]*$/.test(row.baselineBlock ?? '') ||
        row.issueClusterSha256 !== row.issueSha256 ||
        !nonnegative(row.plannedHorizonHours) ||
        row.plannedHorizonHours === 0 ||
        row.forecastEligible !== false ||
        row.fullRoutePaidProofSha256 !== null ||
        utc(row.baselineAtUtc) !== row.baselineAtUtc ||
        utc(row.issueAtUtc) !== row.issueAtUtc ||
        utc(row.targetAtUtc) !== row.targetAtUtc ||
        utc(row.deadlineAtUtc) !== row.deadlineAtUtc ||
        Date.parse(row.baselineAtUtc) > Date.parse(row.issueAtUtc) ||
        Date.parse(row.targetAtUtc) - Date.parse(row.issueAtUtc) !==
          row.plannedHorizonHours * 3_600_000 ||
        Date.parse(row.deadlineAtUtc) - Date.parse(row.targetAtUtc) !== 2 * 3_600_000 ||
        row.issueClock !== 'local_operator_clock_unwitnessed' ||
        row.scoreClock !== 'local_operator_clock_unwitnessed' ||
        row.baseline !== 'simulated_callable' ||
        seenCells.has(`${row.issueSha256}:${row.qRaw}:${row.plannedHorizonHours}`)
      )
        throw Error('historical_outlook_direct_row_invalid')
      seenCells.add(`${row.issueSha256}:${row.qRaw}:${row.plannedHorizonHours}`)
      const priorHolder = holderByIssue.get(row.issueSha256)
      if (priorHolder && priorHolder !== row.holderCommitment)
        throw Error('historical_outlook_direct_holder_conflict')
      holderByIssue.set(row.issueSha256, row.holderCommitment)
      const baselineIdentity = `${row.baselineBlock}:${row.baselineBlockHash}:${row.baselineAtUtc}:${row.issueAtUtc}`
      const priorBaseline = baselineByIssue.get(row.issueSha256)
      if (priorBaseline && priorBaseline !== baselineIdentity)
        throw Error('historical_outlook_direct_baseline_conflict')
      baselineByIssue.set(row.issueSha256, baselineIdentity)
      if (row.rawScoreStatus !== 'measured') continue
      if (
        !/^[0-9a-f]{64}$/.test(row.scoreSha256 ?? '') ||
        row.scoreSha256 === row.issueSha256 ||
        utc(row.observedAtUtc) !== row.observedAtUtc ||
        utc(row.labelAvailableAtUtc) !== row.labelAvailableAtUtc ||
        Date.parse(row.observedAtUtc) < Date.parse(row.targetAtUtc) ||
        Date.parse(row.observedAtUtc) > Date.parse(row.deadlineAtUtc) ||
        Date.parse(row.labelAvailableAtUtc) < Date.parse(row.observedAtUtc) ||
        !['simulated_withdraw_success', 'holder_shares_zero'].includes(row.rawScoreOutcome)
      )
        throw Error('historical_outlook_direct_score_invalid')
      const scoreCell = `${row.issueSha256}:${row.plannedHorizonHours}`
      const priorScore = scoreByIssueHorizon.get(scoreCell)
      const scoreIdentity = `${row.scoreSha256}:${row.targetAtUtc}:${row.deadlineAtUtc}:${row.observedAtUtc}:${row.labelAvailableAtUtc}`
      if (priorScore && priorScore !== scoreIdentity)
        throw Error('historical_outlook_direct_score_conflict')
      scoreByIssueHorizon.set(scoreCell, scoreIdentity)
      const priorOwner = scoreOwner.get(row.scoreSha256)
      if (priorOwner && priorOwner !== scoreCell)
        throw Error('historical_outlook_direct_score_conflict')
      scoreOwner.set(row.scoreSha256, scoreCell)
      if (Date.parse(row.labelAvailableAtUtc) > cutoff) continue
      if (row.rawScoreOutcome !== 'simulated_withdraw_success') continue
      if (row.outcome?.status !== 'simulated_callable')
        throw Error('historical_outlook_direct_score_invalid')
      rows.push({
        subject: identity,
        stageScope,
        finalPayoutAsset: subject.asset.toLowerCase(),
        issueSha256: row.issueSha256,
        scoreSha256: row.scoreSha256,
        holderCommitment: row.holderCommitment,
        qRaw: row.qRaw,
        baselineBlock: row.baselineBlock,
        baselineBlockHash: row.baselineBlockHash,
        baselineAtUtc: row.baselineAtUtc,
        issueAtUtc: row.issueAtUtc,
        plannedHorizonHours: row.plannedHorizonHours,
        targetAtUtc: row.targetAtUtc,
        deadlineAtUtc: row.deadlineAtUtc,
        observedAtUtc: row.observedAtUtc,
        localEvidenceAvailableAtUtc: row.labelAvailableAtUtc,
      })
    }
    if (!rows.length) continue
    if (!nonnegative(subject.issueClusters) || subject.issueClusters < holderByIssue.size)
      throw Error('historical_outlook_direct_issue_count_invalid')
    result.set(
      routeKey,
      evidenceBlock({
        evidenceId: 'exact_holder_final_asset_withdraw_call_history',
        evidenceClass: 'historical_endpoint',
        endpoint: 'same_holder_exact_q_final_original_asset_withdraw_eth_call',
        samples: {
          successfulCallCells: rows.length,
          issueClusters: new Set(rows.map((row) => row.issueSha256)).size,
          finalPayoutAsset: subject.asset.toLowerCase(),
        },
        historicalWindow: historicalWindow(
          rows.map((row) => row.observedAtUtc),
          'verified_scored_eth_call_block_times',
        ),
        design: {
          unit: 'same_holder_exact_raw_q_scored_eth_call',
          subject: identity,
          stageScope,
          evidenceAvailabilityClock: 'unwitnessed_local_operator_clock',
        },
        outcomes: {
          successfulCallCells: rows.length,
          observations: rows,
          capacityProjection: null,
          durationProjection: null,
        },
        limits: [
          'historical_eth_call_is_not_mined_holder_payment',
          'positive_only_no_failure_denominator',
          'q_by_horizon_cells_share_holder_issue_clusters',
          'local_evidence_availability_clock_is_not_independently_witnessed',
          'no_transition_probability_or_restriction_duration_estimate',
          'historical_q_is_not_requested_user_amount',
        ],
      }),
    )
  }
  return result
}

function aaveFlowEvidence(summary) {
  if (summary == null) return null
  if (
    summary.study !== 'aave-usdc-historical-flow-summary-v1' ||
    !nonnegative(summary.exactHorizonWindows) ||
    !nonnegative(summary.nonoverlappingWindowCount)
  )
    throw Error('historical_outlook_aave_flow_invalid')
  return evidenceBlock({
    evidenceId: 'aave_usdc_gross_flow_history',
    evidenceClass: 'historical_proxy',
    endpoint: 'aggregate_reserve_gross_in_out_and_cash_delta',
    proxyLabel: 'market_flow_proxy_not_holder_execution',
    samples: {
      exactHorizonWindows: summary.exactHorizonWindows,
      nonoverlappingWindows: summary.nonoverlappingWindowCount,
      horizonBlocks: summary.horizonBlocks,
    },
    historicalWindow: {
      fromUtc: null,
      throughUtc: null,
      fromBlock: summary.source.fromBlock,
      throughBlock: summary.source.toBlock,
      basis: 'verified_joined_archive_blocks',
    },
    design: {
      unit: 'nonoverlapping_exact_block_window',
      flowMeasure: summary.flowMeasure,
    },
    outcomes: {
      distributions: summary.nonoverlappingDistributions,
      extrema: summary.exactWindowExtrema,
    },
    limits: [
      'aggregate_market_flow_is_not_holder_specific',
      'unscaled_replay_is_not_a_future_probability',
      'within_horizon_exit_duration_is_not_estimated',
    ],
  })
}

function morphoLedgerEvidence(ledger) {
  if (ledger == null) return null
  if (ledger.study !== 'morpho-v2-usdc-10k-holder-risk-ledger-v1' || !ledger.counts?.all)
    throw Error('historical_outlook_morpho_ledger_invalid')
  const anchors = (ledger.cells ?? []).map((row) => row.anchorBlock).filter(nonnegative)
  const destinationSlices = [
    ...new Set((ledger.cells ?? []).map((cell) => cell.vault.toLowerCase())),
  ].map((destination) => {
    const cells = ledger.cells.filter((cell) => cell.vault.toLowerCase() === destination)
    const episodes = ledger.episodes.filter(
      (episode) => episode.vault.toLowerCase() === destination,
    )
    const counts = (split) => {
      const selectedCells = cells.filter((cell) => split === 'all' || cell.split === split)
      const selectedEpisodes = episodes.filter(
        (episode) => split === 'all' || episode.split === split,
      )
      return {
        plannedCells: selectedCells.length,
        completedCells: selectedCells.filter((cell) => cell.cellSha256 != null).length,
        baselineSuccessEpisodes: selectedEpisodes.length,
        holderVaultClusters: new Set(selectedEpisodes.map((episode) => episode.holderVaultCluster))
          .size,
        observedFirstLossEpisodes: selectedEpisodes.filter(
          (episode) => episode.firstObservedLossIntervalHours != null,
        ).length,
        observedRecoveryEpisodes: selectedEpisodes.filter(
          (episode) => episode.observedRecoveryIntervalHours != null,
        ).length,
        firstLossRightCensoredEpisodes: selectedEpisodes.filter(
          (episode) => episode.firstLossRightCensoredAtHours != null,
        ).length,
      }
    }
    const blocks = cells.map((cell) => cell.anchorBlock)
    return {
      destination,
      fromBlock: Math.min(...blocks),
      throughBlock: Math.max(...blocks),
      development: counts('development'),
      reservedHoldout: counts('reservedHoldout'),
      all: counts('all'),
    }
  })
  return evidenceBlock({
    evidenceId: 'morpho_fixed_10k_holder_call_ledger',
    evidenceClass: 'historical_endpoint',
    endpoint: 'fixed_10k_exact_holder_withdrawal_call_at_sampled_horizon',
    samples: {
      qAssetsRaw: ledger.qAssetsRaw,
      plannedCells: ledger.counts.all.plannedCells,
      completedCells: ledger.counts.all.completedCells,
      baselineSuccessEpisodes: ledger.counts.all.baselineSuccessEpisodes,
      holderVaultClusters: ledger.counts.all.holderVaultClusters,
      development: ledger.counts.development,
      reservedHoldout: ledger.counts.reservedHoldout,
      destinationSlices,
    },
    historicalWindow: {
      fromUtc: null,
      throughUtc: null,
      fromBlock: anchors.length ? Math.min(...anchors) : null,
      throughBlock: anchors.length ? Math.max(...anchors) : null,
      sampledHorizonHours: [1, 4, 24, 48, 168],
      basis: 'frozen_anchor_blocks_with_discrete_followup_calls',
    },
    design: {
      unit: 'holder_vault_anchor_episode',
      reservedHoldoutAnchor: ledger.reservedHoldoutAnchor,
      sharedClustersAcrossSplits: ledger.counts.all.sharedHolderVaultClustersAcrossSplits,
    },
    outcomes: {
      observedFirstLossEpisodes: ledger.counts.all.observedFirstLossEpisodes,
      observedRecoveryEpisodes: ledger.counts.all.observedRecoveryEpisodes,
      firstLossRightCensoredEpisodes: ledger.counts.all.firstLossRightCensoredEpisodes,
      holderAttritionCensoredEpisodes: ledger.counts.all.holderAttritionCensoredEpisodes,
      missingHorizonEpisodes: ledger.counts.all.episodesWithMissingHorizonSamples,
    },
    limits: [
      'historical_eth_call_is_not_mined_payment',
      'intervals_are_between_discrete_samples',
      'development_and_reserved_holdout_may_share_holder_vault_clusters',
    ],
  })
}

function saturnEvidence(diagnostic) {
  if (diagnostic == null) return null
  if (
    diagnostic.study !== 'saturn_queue_processing_chronological_diagnostic_v1' ||
    !diagnostic.train ||
    !diagnostic.later
  )
    throw Error('historical_outlook_saturn_invalid')
  return evidenceBlock({
    evidenceId: 'saturn_queue_processing_regime_check',
    evidenceClass: 'historical_proxy',
    endpoint: 'request_to_operator_processing_within_24h',
    proxyLabel: 'intermediate_queue_stage_not_final_asset_exit',
    samples: {
      trainRequested: diagnostic.train.requested,
      trainEvaluable: diagnostic.train.evaluable,
      laterRequested: diagnostic.later.requested,
      laterEvaluable: diagnostic.later.evaluable,
      horizonSeconds: diagnostic.horizonSeconds,
    },
    historicalWindow: {
      fromUtc: null,
      throughUtc: diagnostic.split.finalCutoffAtUtc,
      splitAtUtc: diagnostic.split.atUtc,
      basis: 'chronological_ticket_split',
    },
    design: {
      unit: 'queue_ticket',
      split: diagnostic.split.method,
      censoring: 'unevaluable_tickets_remain_censored',
    },
    outcomes: {
      train: diagnostic.train,
      later: diagnostic.later,
      comparison: diagnostic.comparison,
    },
    limits: [
      'operator_processing_is_not_holder_payment',
      'retrospective_median_split_is_not_untouched_prospective_validation',
      'regime_change_makes_early_rate_nonportable',
    ],
  })
}

function saturnFinalPaymentEvidence(report) {
  if (report == null) return null
  const cohort = report.cohort
  const full = report.fullCohortAtCutoff
  const split = report.chronologicalSplit
  const payment = full?.requestToFinalHolderPayment
  const horizons = payment?.horizons
  const median = payment?.intervalDurationSeconds?.median
  if (
    report.study !== 'saturn_final_holder_payment_duration_backtest_v1' ||
    report.scope?.paymentAsset !== 'USDat' ||
    report.scope?.routeFinalAusdPaymentAssessed !== false ||
    !nonnegative(cohort?.requests) ||
    cohort.requests < 1 ||
    !nonnegative(cohort?.verifiedFinalHolderPayments) ||
    cohort.verifiedFinalHolderPayments > cohort.requests ||
    cohort.exactHolderMatches !== cohort.verifiedFinalHolderPayments ||
    !Array.isArray(horizons) ||
    ![24, 72, 168, 336, 672].every((hours) =>
      horizons.some(
        (row) =>
          row?.horizonHours === hours &&
          row?.subjects === cohort.requests &&
          typeof row?.historicalPaymentFractionBounds?.lower === 'number' &&
          typeof row?.historicalPaymentFractionBounds?.upper === 'number' &&
          row.historicalPaymentFractionBounds.lower >= 0 &&
          row.historicalPaymentFractionBounds.upper <= 1 &&
          row.historicalPaymentFractionBounds.lower <= row.historicalPaymentFractionBounds.upper,
      ),
    ) ||
    !nonnegative(median?.lowerSeconds) ||
    !nonnegative(median?.upperSeconds) ||
    median.lowerSeconds > median.upperSeconds ||
    split?.development?.subjects + split?.holdout?.subjects !== cohort.requests ||
    report.validation?.status !== 'not_validated' ||
    report.validation?.forecastValidated !== false
  )
    throw Error('historical_outlook_saturn_final_payment_invalid')
  return evidenceBlock({
    evidenceId: 'saturn_exact_holder_usdat_payment_duration',
    evidenceClass: 'historical_proxy',
    endpoint: 'request_to_exact_holder_usdat_payment_by_horizon',
    proxyLabel: 'intermediate_usdat_payment_not_final_ausd_exit',
    samples: {
      requests: cohort.requests,
      holders: cohort.holders,
      verifiedFinalHolderPayments: cohort.verifiedFinalHolderPayments,
      finalPaymentTransactions: cohort.finalPaymentTransactions,
      medianDurationLowerSeconds: median.lowerSeconds,
      medianDurationUpperSeconds: median.upperSeconds,
    },
    historicalWindow: {
      fromUtc: null,
      throughUtc: full.asOf.atUtc,
      splitAtUtc: split.splitAtUtc,
      basis: 'frozen_ticket_cohort_with_interval_censored_payment_times',
    },
    design: {
      unit: 'queue_ticket',
      paymentAsset: 'USDat',
      horizonsHours: horizons.map((row) => row.horizonHours),
      intervalBasis: payment.intervalDurationSeconds.intervalBasis,
      split: split.method,
    },
    outcomes: {
      fullCohortHorizonBounds: horizons,
      chronologicalSplit: split,
      medianDurationSeconds: median,
    },
    limits: [
      'payment_timestamps_are_interval_censored',
      'verified_usdat_payment_is_not_final_ausd_route_completion',
      'retrospective_split_is_not_prospective_validation',
      'holdout_crosses_saved_queue_implementation_boundary',
    ],
  })
}

function apyUsdEvidence(diagnostic) {
  if (diagnostic == null) return null
  if (
    diagnostic.scope !== 'retrospective_request_to_holder_payment_as_of_split' ||
    diagnostic.cohort !== 96 ||
    !diagnostic.train ||
    !diagnostic.holdout
  )
    throw Error('historical_outlook_apyusd_invalid')
  return evidenceBlock({
    evidenceId: 'apyusd_request_to_payment_asof_split',
    evidenceClass: 'historical_endpoint',
    endpoint: 'holder_request_to_mined_holder_payment_by_horizon',
    samples: {
      cohort: diagnostic.cohort,
      trainRequests: diagnostic.train.requests,
      holdoutRequests: diagnostic.holdout.requests,
      trainHolders: diagnostic.train.holders,
      holdoutHolders: diagnostic.holdout.holders,
      holdersAlsoInTrain: diagnostic.holdout.holdersAlsoInTrain,
    },
    historicalWindow: {
      fromUtc: null,
      throughUtc: diagnostic.observedThroughUtc,
      splitAtUtc: diagnostic.splitAtUtc,
      trainingAsOfUtc: diagnostic.trainingAsOfUtc,
      basis: 'frozen_receipt_cohort_chronological_split',
    },
    design: {
      unit: 'receipt',
      horizonsDays: diagnostic.holdout.horizons.map((row) => row.days),
      trainingOutcomesKnownAtSplit: diagnostic.train.knownPayoutsAtSplit,
    },
    outcomes: {
      trainAsOfSplit: diagnostic.train.horizons,
      holdoutAtFinalCutoff: diagnostic.holdout.horizons,
    },
    limits: [
      'many_training_outcomes_were_censored_at_split',
      'claimability_was_not_assessed_by_this_diagnostic',
      'historical_split_is_not_prospective_validation',
    ],
  })
}

function cashHoldoutByRoute(audit) {
  if (audit == null) return new Map()
  if (
    audit.study !== 'frozen25-aggregate-cash-q-ratio-h24-historical-holdout-v1' ||
    audit.routeGroupCount !== 25 ||
    audit.subjectCount !== 67 ||
    !Array.isArray(audit.byFraction)
  )
    throw Error('historical_outlook_cash_holdout_invalid')
  const byRoute = new Map()
  for (const fraction of audit.byFraction) {
    for (const subject of fraction.qualifiedSubjects ?? []) {
      const rows = byRoute.get(subject.routeKey) ?? []
      rows.push({
        destination: subject.destination,
        percentOfCurrentCash: fraction.percentOfCurrentCash,
        requestedFraction: subject.requestedFraction,
        fitBreaches: subject.fitBreaches,
        calibrationBreaches: subject.calibrationBreaches,
        holdoutBreaches: subject.holdoutBreaches,
        holdoutBrier: subject.holdoutBrier,
        holdoutPersistenceBrier: subject.holdoutPersistenceBrier,
      })
      byRoute.set(subject.routeKey, rows)
    }
  }
  for (const [routeKey, rows] of byRoute) {
    byRoute.set(
      routeKey,
      evidenceBlock({
        evidenceId: 'aggregate_cash_q_holdout',
        evidenceClass: 'historical_proxy',
        endpoint: 'aggregate_market_cash_below_q_at_24h',
        proxyLabel: 'aggregate_cash_proxy_not_holder_execution',
        samples: {
          qualifiedSubjectFractions: rows.length,
          fitPairs: Math.max(...rows.map((row) => row.fitBreaches.denominator)),
          calibrationPairs: Math.max(...rows.map((row) => row.calibrationBreaches.denominator)),
          holdoutPairs: Math.max(...rows.map((row) => row.holdoutBreaches.denominator)),
        },
        historicalWindow: {
          fromUtc: null,
          throughUtc: audit.asOfBlockAt,
          throughBlock: audit.currentBlock,
          basis: 'sealed_cash_archive_with_disjoint_h24_pairs',
        },
        design: {
          unit: 'nonoverlapping_24h_aggregate_cash_pair',
          qualification: 'calibration_and_holdout_brier_both_beat_no_breach_persistence',
        },
        outcomes: { qualifiedFractions: rows },
        limits: [
          'aggregate_cash_is_not_holder_execution',
          'qualified_subject_fraction_is_not_an_arbitrary_q_model',
          'historical_frequency_is_not_a_future_probability',
        ],
      }),
    )
  }
  return byRoute
}

function routePromotion(evidence) {
  const available = evidence.filter((row) => row.historicalUse === 'available')
  const exact = available.filter((row) => row.evidenceClass === 'historical_endpoint')
  const proxy = available.filter((row) => row.evidenceClass === 'historical_proxy')
  const historicalOutlook = exact.length
    ? 'eligible_exact_endpoint_history'
    : proxy.length
      ? 'eligible_proxy_history'
      : 'abstain'
  return {
    historicalOutlook,
    liveForecast: 'abstain',
    reasonCodes: compact([
      exact.length ? null : 'no_historical_exact_holder_endpoint_block',
      proxy.length ? 'proxy_blocks_must_keep_proxy_label' : null,
      'prospective_validation_absent',
      'no_cross_endpoint_probability',
    ]),
  }
}

function sourceReport(sourceStatus, values) {
  return {
    holderExitMatrix: { status: 'verified', required: true },
    ...Object.fromEntries(
      SOURCE_IDS.map((id) => [
        id,
        sourceStatus?.[id] ?? {
          status: values[id] == null ? 'unavailable' : 'verified',
          required: false,
          ...(values[id] == null ? { reason: 'source_not_supplied' } : {}),
        },
      ]),
    ),
  }
}

/** Pure composition boundary. Tests inject fixtures; the CLI injects verified local readers. */
export function buildHistoricalOutlookSuite({
  matrix,
  holderAssayBacktest = null,
  holderStageEndpointStates = null,
  aaveUsdcGrossFlow = null,
  morphoUsdcFixed10k = null,
  saturnProcessing = null,
  saturnFinalPayment = null,
  apyUsdTiming = null,
  aggregateCashHoldout = null,
  susdeRequestToPayout = null,
  asOfUtc = null,
  sourceStatus = null,
}) {
  if (asOfUtc != null && utc(asOfUtc) !== asOfUtc) throw Error('historical_outlook_as_of_invalid')
  const frozenGroups = validateMatrix(matrix)
  const supplementalSubject = validateSupplementalSubject(matrix, frozenGroups)
  const groups = new Map(frozenGroups)
  groups.set(AAVE_USDE_ROUTE, [supplementalSubject])
  const values = {
    holderAssayBacktest,
    holderStageEndpointStates,
    aaveUsdcGrossFlow,
    morphoUsdcFixed10k,
    saturnProcessing,
    saturnFinalPayment,
    apyUsdTiming,
    aggregateCashHoldout,
    susdeRequestToPayout,
  }
  const extras = new Map([
    [AAVE_USDC_ROUTE, compact([aaveFlowEvidence(aaveUsdcGrossFlow)])],
    [MORPHO_USDC_ROUTE, compact([morphoLedgerEvidence(morphoUsdcFixed10k)])],
    [
      SATURN_ROUTE,
      compact([saturnFinalPaymentEvidence(saturnFinalPayment), saturnEvidence(saturnProcessing)]),
    ],
    [APYUSD_ROUTE, compact([apyUsdEvidence(apyUsdTiming)])],
    [
      SUSDE_ROUTE,
      compact([
        susdeRequestToPayoutEvidence(
          susdeRequestToPayout,
          frozenGroups.get(SUSDE_ROUTE) ?? [],
          asOfUtc,
        ),
      ]),
    ],
  ])
  const cashByRoute = cashHoldoutByRoute(aggregateCashHoldout)
  const assayByRoute = holderAssayEvidenceByRoute(
    holderAssayBacktest,
    frozenGroups,
    matrix.manifestSha256 ?? null,
  )
  const stageByRoute = holderStageEndpointEvidenceByRoute(
    holderStageEndpointStates,
    frozenGroups,
    matrix.manifestSha256 ?? null,
    asOfUtc,
  )
  const directByRoute = exactDirectWithdrawEvidenceByRoute(
    holderStageEndpointStates,
    frozenGroups,
    matrix.manifestSha256 ?? null,
    asOfUtc,
  )
  const routes = [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([routeKey, subjects]) => {
      const evidence = [
        ...matrixEvidence(subjects),
        ...compact([stageByRoute.get(routeKey)]),
        ...compact([directByRoute.get(routeKey)]),
        ...compact([assayByRoute.get(routeKey)]),
        ...(extras.get(routeKey) ?? []),
        ...compact([cashByRoute.get(routeKey)]),
      ]
      return {
        routeKey,
        mechanism: subjects[0].mechanism,
        exactSubjects: subjects.length,
        subjects: subjects.map((row) => ({
          destination: row.destination,
          originalAsset: row.originalAsset,
        })),
        collectionReadiness: collectionReadiness(subjects),
        promotion: routePromotion(evidence),
        evidence,
      }
    })
  const historicalExact = routes.filter(
    (route) => route.promotion.historicalOutlook === 'eligible_exact_endpoint_history',
  ).length
  const historicalProxy = routes.filter(
    (route) => route.promotion.historicalOutlook === 'eligible_proxy_history',
  ).length
  const abstain = routes.length - historicalExact - historicalProxy
  return {
    schema: SCHEMA,
    scope: 'offline_tracked_26_route_historical_holder_exit_outlook',
    claimClass: 'retrospective_historical_outlook',
    asOfUtc,
    manifestSha256: matrix.manifestSha256 ?? null,
    mechanismVersion: matrix.mechanismVersion ?? null,
    sourcePolicy: {
      networkReads: false,
      databaseReads: false,
      localVerifiedArtifactsOnly: true,
    },
    limits: {
      prospectiveValidated: false,
      liveForecast: false,
      capacityForecast: false,
      fullRouteExitClaim: false,
      routeLevelProbability: false,
      incompatibleEndpointsPooled: false,
    },
    promotionRules: {
      exactEndpointHistory:
        'at_least_one_historical_block_measures_an_exact_holder_call_or_mined_holder_payment',
      proxyHistory: 'historical_blocks_exist_but_only_for_market_or_intermediate_stage_proxies',
      abstain: 'no_usable_historical_endpoint_or_proxy_block',
      liveForecast: 'always_abstain_until_separately_prospectively_validated',
    },
    coverage: {
      routeGroups: routes.length,
      exactSubjects: sum(routes, (route) => route.exactSubjects),
      frozenCohortRouteGroups: frozenGroups.size,
      frozenCohortExactSubjects: sum([...frozenGroups.values()], (subjects) => subjects.length),
      supplementalRouteGroups: 1,
      supplementalExactSubjects: 1,
      exactEndpointHistoryRouteGroups: historicalExact,
      proxyOnlyHistoryRouteGroups: historicalProxy,
      abstainingRouteGroups: abstain,
      evidenceBlocks: sum(routes, (route) => route.evidence.length),
    },
    sources: sourceReport(sourceStatus, values),
    routes,
  }
}

const DEFAULT_READERS = Object.freeze({
  holderExitMatrix: readVerifiedHolderExitForceabilityMatrix,
  holderAssayBacktest: async () =>
    buildHolderExitHistoricalBacktest({ panel: await readVerifiedHolderExitEpisodePanel() }),
  holderStageEndpointStates: async ({ asOfUtc } = {}) =>
    readVerifiedHolderExitEpisodePanel({
      nowMs: asOfUtc == null ? Date.now() : Date.parse(asOfUtc),
    }),
  aaveUsdcGrossFlow: readAaveFlowSummaryWithFallback,
  morphoUsdcFixed10k: () => readSavedLedger(),
  saturnProcessing: readVerifiedSaturnProcessingDiagnostic,
  saturnFinalPayment: readVerifiedSaturnFinalPaymentBacktest,
  apyUsdTiming: readVerifiedApyUsdTimingDiagnostic,
  aggregateCashHoldout: auditQCashHoldout,
  susdeRequestToPayout: async () => {
    const issues = (await import('./susde-public-pending-exit-issue.mjs')).verifyIssues()
    return buildSusdePayoutEvidence({
      issues: await issues,
      records: await readVerifiedSusdePayoutEvidence(),
    }).facts
  },
})

/** No RPC, database, or network fallback. Optional local sources fail into explicit abstentions. */
export async function readOfflineHistoricalOutlook({
  readers = DEFAULT_READERS,
  asOfUtc = null,
} = {}) {
  if (asOfUtc != null && utc(asOfUtc) !== asOfUtc) throw Error('historical_outlook_as_of_invalid')
  // Both historical uses need the same verified panel and the same cutoff.
  // Share one replay within this read, while allowing the next read to see new seals.
  let activeReaders = readers
  if (readers === DEFAULT_READERS) {
    let panelPromise
    const panel = () =>
      (panelPromise ??= readVerifiedHolderExitEpisodePanel({
        nowMs: asOfUtc == null ? Date.now() : Date.parse(asOfUtc),
      }))
    activeReaders = {
      ...readers,
      holderAssayBacktest: async () => buildHolderExitHistoricalBacktest({ panel: await panel() }),
      holderStageEndpointStates: panel,
    }
  }
  const matrix = await activeReaders.holderExitMatrix()
  const values = {}
  const sourceStatus = {}
  for (const id of SOURCE_IDS) {
    try {
      values[id] = await activeReaders[id]({ asOfUtc })
      if (values[id] == null) {
        sourceStatus[id] = {
          status: 'unavailable',
          required: false,
          reason: 'source_returned_null',
        }
        continue
      }
      sourceStatus[id] = {
        status: 'verified',
        required: false,
        ...(values[id]?.suiteSource ?? {}),
      }
    } catch (error) {
      values[id] = null
      sourceStatus[id] = {
        status: 'unavailable',
        required: false,
        reason: sourceFailureReason(error),
      }
    }
  }
  return buildHistoricalOutlookSuite({ matrix, ...values, asOfUtc, sourceStatus })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2] ?? '--json'
  if (!['--json', '--summary'].includes(mode)) throw Error('usage: --json|--summary')
  readOfflineHistoricalOutlook()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(mode === '--summary' ? report.coverage : report)}\n`)
    })
    .catch((error) => {
      process.stderr.write(`${sourceFailureReason(error)}\n`)
      process.exitCode = 1
    })
}
