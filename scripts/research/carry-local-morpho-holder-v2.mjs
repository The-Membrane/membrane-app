// Versioned, multi-Q public Morpho VaultV2 holder issue/score lane. It keeps
// the same holder and exact Q values through H1/H24; eth_call is not payout.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  captureFreshMorphoBaseline,
  discoverMorphoIssuerCandidate,
} from '../lib/carry-exit-v2-morpho-issuer-prep.mjs'
import {
  discoverMorphoApiIssuerCandidate,
  discoverMorphoApiIssuerCandidateV2,
  validateMorphoApiCandidateEvidence,
  validateMorphoApiCandidateEvidenceV2,
} from '../lib/carry-exit-v2-morpho-api-candidate.mjs'
import {
  discoverMorphoSeedIssuerCandidate,
  validateMorphoSeedCandidateEvidence,
} from '../lib/carry-exit-v2-morpho-seed-candidate.mjs'
import {
  LOCAL_PAYOUT_SCHEMA,
  discoverMorphoLocalPayoutCandidate,
  validateMorphoLocalPayoutCandidateEvidence,
  verifyLocalPayoutIssueSources,
} from '../lib/carry-exit-v2-morpho-local-payout-candidate.mjs'
import {
  MORPHO_HISTORICAL_TRANSFER_SCHEMA,
  discoverMorphoHistoricalTransferCandidate,
  validateMorphoHistoricalTransferCandidateEvidence,
} from '../lib/carry-exit-v2-morpho-historical-transfer-candidate.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  configuredPublicRpcUrls,
  publicRpcClients,
  slicedCandidateRequest,
} from './carry-public-direct-exit-issue.mjs'
import {
  HORIZONS,
  ROUTES,
  baselineWitness,
  classify,
  originIdentity,
  validateTarget,
  verifyMeasurement,
} from './carry-local-morpho-holder.mjs'
import {
  V2_ATTEMPT_DIR,
  V2_ISSUE_DIR,
  V2_SCORE_DIR,
  appendChain,
  hash,
  readChain,
} from './carry-local-morpho-holder-store.mjs'

export const ISSUE_STUDY = 'carry_local_morpho_holder_issue_v2'
export const SCORE_STUDY = 'carry_local_morpho_holder_score_v2'
const BOARD_KEYS = new Set([
  'USDC → VaultV2 [USDC]',
  'EURCV → VaultV2 [EURCV]',
  'AUSD → VaultV2 [AUSD]',
  'USDT → VaultV2 [USDT]',
  'RLUSD → VaultV2 [RLUSD]',
  'LINK → VaultV2 [LINK]',
  'PYUSD → VaultV2 [PYUSD]',
])
export const BOARD_ROUTES = Object.freeze(ROUTES.filter((route) => BOARD_KEYS.has(route.routeKey)))
export const SUPPLEMENTAL_ROUTES = Object.freeze(
  ROUTES.filter((route) => !BOARD_KEYS.has(route.routeKey)),
)
if (BOARD_ROUTES.length !== 49 || SUPPLEMENTAL_ROUTES.length !== 19)
  throw Error('holder_v2_frozen_board_roster_changed')
const routeIdentity = (row) => {
  const asset = row?.asset ?? row?.originalAsset
  if (
    typeof row?.routeKey !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(row.destination ?? '') ||
    !/^0x[0-9a-f]{40}$/i.test(asset ?? '')
  )
    throw Error('holder_v2_missing_api_identity_invalid')
  return `${row.routeKey}\0${row.destination.toLowerCase()}\0${asset.toLowerCase()}`
}

const API_RETRY_BASE_MS = 30 * 60_000
const API_RETRY_MAX_MS = 6 * 60 * 60_000
const MISSING_BASELINE_REASONS = new Set([
  'no_verified_direct_issue',
  'no_measured_exact_holder_q_baseline',
])
const API_PAGE_V1 = 'carry_exit_v2_morpho_api_candidate_v1'
const API_PAGE_V2 = 'carry_exit_v2_morpho_api_candidate_page_v2'
const apiPage = (issue) => {
  const doc = issue.candidate?.evidenceDoc
  if (doc?.schema !== API_PAGE_V1 && doc?.schema !== API_PAGE_V2) return null
  return {
    doc,
    skip: doc.schema === API_PAGE_V2 ? doc.discovery?.pageSkip : 0,
  }
}
const conclusiveNegativePage = (issue) => {
  if (issue.status !== 'no_holder' || !apiPage(issue)) return false
  const { doc } = apiPage(issue)
  return (
    Array.isArray(doc.screenedCandidates) &&
    doc.discovery?.attempted === doc.screenedCandidates.length &&
    doc.screenedCandidates.every((row) =>
      ['contract_holder', 'no_pinned_shares', 'no_pinned_claim'].includes(row.status),
    )
  )
}

/** Select one unmeasured exact subject from the verified matrix and local attempt ledger. */
export function selectMissingMorphoApiSubject({
  eligibleSubjects,
  issues,
  attempts,
  nowMs = Date.now(),
}) {
  if (!Array.isArray(eligibleSubjects) || !Array.isArray(issues) || !Array.isArray(attempts))
    throw Error('holder_v2_missing_api_selection_invalid')
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw Error('holder_v2_missing_api_selection_invalid')
  const eligible = new Set()
  for (const subject of eligibleSubjects) {
    if (
      !subject?.reasons?.some((reason) => MISSING_BASELINE_REASONS.has(reason)) ||
      subject.scope !== 'frozen_25_67' ||
      !subject.routeKey ||
      !subject.destination ||
      !subject.originalAsset
    )
      throw Error('holder_v2_missing_api_selection_invalid')
    const key = routeIdentity(subject)
    if (eligible.has(key) || !BOARD_ROUTES.some((route) => routeIdentity(route) === key))
      throw Error('holder_v2_missing_api_selection_invalid')
    eligible.add(key)
  }
  const cooling = []
  const selected = BOARD_ROUTES.map((route, routeIndex) => {
    const key = routeIdentity(route)
    if (!eligible.has(key)) return null
    const subjectIssues = issues.filter((issue) => routeIdentity(issue) === key)
    // The matrix is read first, but an already measured V2 issue still wins if the
    // local ledger advances before selection.
    if (
      subjectIssues.some(
        (issue) =>
          issue.cases?.some((entry) =>
            ['simulated_withdraw_success', 'baseline_revert'].includes(entry.baselineStatus),
          ) || issue.status === 'issued',
      )
    )
      return null
    const lastApiIssue = subjectIssues.filter((issue) => apiPage(issue)).at(-1)
    let apiPageSkip = 0
    let cycleComplete = false
    if (lastApiIssue) {
      const page = apiPage(lastApiIssue)
      if (!Number.isSafeInteger(page.skip) || page.skip < 0 || page.skip % 8 !== 0)
        throw Error('holder_v2_missing_api_page_invalid')
      apiPageSkip = page.skip
      if (conclusiveNegativePage(lastApiIssue)) {
        apiPageSkip += page.doc.screenedCandidates.length
        cycleComplete =
          page.doc.screenedCandidates.length < 8 ||
          apiPageSkip >= page.doc.discovery.pageInfo.countTotal
        if (cycleComplete) apiPageSkip = 0
      }
    }
    const subjectAttempts = attempts.filter((attempt) => routeIdentity(attempt) === key)
    const apiIssueHashes = new Set(
      subjectIssues
        .filter((issue) => apiPage(issue))
        .map((issue) => issue.sha256)
        .filter((value) => HASH.test(value ?? '')),
    )
    const apiAttempts = subjectAttempts.filter(
      (attempt) =>
        attempt.candidateSource === 'morpho-api' || apiIssueHashes.has(attempt.issueSha256),
    )
    const apiIssues = subjectIssues.filter((issue) => apiPage(issue))
    if (apiAttempts.length || apiIssues.length) {
      let latestAtMs = 0
      for (const value of [
        ...apiAttempts.map((attempt) => attempt.finishedAtUtc),
        ...apiIssues.map((issue) => issue.issuedAtUtc),
      ]) {
        const time = Date.parse(value ?? '')
        if (!Number.isFinite(time)) throw Error('holder_v2_missing_api_selection_invalid')
        latestAtMs = Math.max(latestAtMs, time)
      }
      const count = Math.max(1, apiAttempts.length, apiIssues.length)
      const delay = cycleComplete
        ? 24 * HOUR
        : Math.min(API_RETRY_MAX_MS, API_RETRY_BASE_MS * 2 ** Math.min(count - 1, 4))
      if (nowMs < latestAtMs + delay) {
        cooling.push(latestAtMs + delay)
        return null
      }
    }
    const noHolder = subjectIssues.some((issue) => issue.status === 'no_holder')
    return {
      status: 'selected',
      routeIndex,
      apiPageSkip,
      category:
        subjectAttempts.length === 0
          ? 'never_attempted'
          : noHolder
            ? 'no_holder'
            : 'attempted_unavailable',
      attemptCount: subjectAttempts.length,
      lastAttemptSequence: subjectAttempts.at(-1)?.sequence ?? 0,
      apiAttemptCount: apiAttempts.length,
      lastApiAttemptSequence: apiAttempts.at(-1)?.sequence ?? 0,
    }
  })
    .filter(Boolean)
    .sort(
      (a, b) =>
        ['never_attempted', 'no_holder', 'attempted_unavailable'].indexOf(a.category) -
          ['never_attempted', 'no_holder', 'attempted_unavailable'].indexOf(b.category) ||
        a.apiAttemptCount - b.apiAttemptCount ||
        a.lastApiAttemptSequence - b.lastApiAttemptSequence ||
        a.attemptCount - b.attemptCount ||
        a.lastAttemptSequence - b.lastAttemptSequence ||
        a.routeIndex - b.routeIndex,
    )
  if (selected.length) return selected[0]
  const unmeasured = BOARD_ROUTES.some(
    (route) =>
      eligible.has(routeIdentity(route)) &&
      !issues.some(
        (issue) =>
          routeIdentity(issue) === routeIdentity(route) &&
          (issue.status === 'issued' ||
            issue.cases?.some((entry) =>
              ['simulated_withdraw_success', 'baseline_revert'].includes(entry.baselineStatus),
            )),
      ),
  )
  if (cooling.length)
    return { status: 'retry_backoff', retryAtUtc: new Date(Math.min(...cooling)).toISOString() }
  return { status: unmeasured ? 'api_selection_unavailable' : 'no_missing_morpho_subject' }
}
const HOUR = 3_600_000
const SLOT = 15 * 60_000
const DECIMAL = /^[1-9][0-9]*$/
const HASH = /^[0-9a-f]{64}$/
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const utc = (value) => {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
    throw Error('holder_v2_time_invalid')
  return ms
}
const independent = (a, b) => originIdentity(a) !== originIdentity(b)
const apiHostCommitment = (provider) =>
  hash(
    new URL(provider).hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, ''),
  )
const SCORE_STAGES = Object.freeze([
  'target_primary',
  'target_witness',
  'target_consensus',
  'measurement',
  'proof_decode',
])
const SCORE_ERRORS = Object.freeze([
  'target_not_finalized',
  'baseline_not_canonical',
  'target_precedes_baseline',
  'rpc_unavailable',
  'invalid_rpc_header',
  'wrong_chain',
  'noncanonical_target_boundary',
  'audit_input_invalid',
  'audit_clock_invalid',
  'target_disagreement',
  'replay_unavailable',
  'rate_limited',
  'timeout',
  'transport',
  'proof_invalid',
  'unclassified',
])
const zeroCounts = (keys) => Object.fromEntries(keys.map((key) => [key, 0]))

/** Deliberately discard raw RPC messages, URLs, holder, and Q. */
export function scoreRetryErrorCode(error) {
  const message = String(error?.message ?? '')
  const code = String(error?.code ?? '')
  if (code === 'rpc_unavailable' || message === 'rpc_unavailable') {
    const cause = String(error?.cause?.message ?? '')
    if (/(?:429|rate.limit|too many requests)/i.test(cause)) return 'rate_limited'
    if (/timed? out|timeout|deadline exceeded/i.test(cause)) return 'timeout'
    if (/http request failed|fetch failed|network|socket|connection|503|502|504/i.test(cause))
      return 'transport'
    return 'rpc_unavailable'
  }
  for (const safe of SCORE_ERRORS) if (message === safe || code === safe) return safe
  if (
    /^(?:invalid_target_at|invalid_baseline_block|invalid_audit_input|block_search_limit)$/.test(
      message,
    )
  )
    return 'audit_input_invalid'
  if (/^(?:observation_clock_before_block|finalized_head_after_observation)$/.test(message))
    return 'audit_clock_invalid'
  if (message === 'holder_v2_target_disagreement') return 'target_disagreement'
  if (message === 'holder_v2_replay_unavailable') return 'replay_unavailable'
  if (/(?:429|rate.limit|too many requests)/i.test(message)) return 'rate_limited'
  if (/timed? out|timeout|deadline exceeded/i.test(message)) return 'timeout'
  if (/http request failed|fetch failed|network|socket|connection|503|502|504/i.test(message))
    return 'transport'
  if (/proof|decode|invalid|canonical|reorg|block/i.test(message)) return 'proof_invalid'
  return 'unclassified'
}

export function formatV2ScoreTickSummary(value) {
  const counts = value?.counts
  const scalar = ['scanned', 'measured', 'censored', 'retry', 'pairAttempts']
  const num = (entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 1_000_000
  if (
    !value ||
    Object.keys(value).sort().join() !== 'counts,forecastValidated,scanned' ||
    value.forecastValidated !== false ||
    !counts ||
    Object.keys(counts).sort().join() !==
      'censored,measured,pairAttempts,retry,retryByError,retryByStage' ||
    scalar.some((key) => !num(key === 'scanned' ? value.scanned : counts[key])) ||
    value.scanned !== counts.measured + counts.censored + counts.retry ||
    counts.pairAttempts < counts.measured ||
    ![...SCORE_STAGES, ...SCORE_ERRORS].every((key) =>
      num(SCORE_STAGES.includes(key) ? counts.retryByStage?.[key] : counts.retryByError?.[key]),
    ) ||
    Object.keys(counts.retryByStage ?? {})
      .sort()
      .join() !== [...SCORE_STAGES].sort().join() ||
    Object.keys(counts.retryByError ?? {})
      .sort()
      .join() !== [...SCORE_ERRORS].sort().join()
  )
    throw Error('holder_v2_score_summary_invalid')
  const stage = SCORE_STAGES.map((key) => `${key}:${counts.retryByStage[key]}`).join(',')
  const error = SCORE_ERRORS.map((key) => `${key}:${counts.retryByError[key]}`).join(',')
  return `carry-local-morpho-holder:v2score ok scanned=${value.scanned} measured=${counts.measured} censored=${counts.censored} retry=${counts.retry} pairAttempts=${counts.pairAttempts} stage=${stage} error=${error}`
}

/** One small sentinel, one holder-near-boundary Q, and the largest vault tier
 * within the sampled holder's pinned claim. Duplicate Qs stay explicit. */
export function freezeQCases(candidate) {
  const doc = candidate?.evidenceDoc
  const ladder = doc?.ladder
  const claim = BigInt(ladder?.selectedClaimRaw ?? 0)
  if (claim <= 0n || !candidate.holder) throw Error('holder_v2_claim_missing')
  const small = ladder.labels.find(
    (entry) => entry.label === 'holder_half_claim_capped_vault_0p001pct',
  )
  if (!DECIMAL.test(small?.assetsRaw ?? '')) throw Error('holder_v2_small_q_missing')
  const tiers = ladder.labels.filter(
    (entry) =>
      entry.label.startsWith('vault_') &&
      DECIMAL.test(entry.assetsRaw ?? '') &&
      BigInt(entry.assetsRaw) <= claim,
  )
  const largest = tiers.sort((a, b) => (BigInt(a.assetsRaw) > BigInt(b.assetsRaw) ? -1 : 1))[0]
  const near = (claim * 9n) / 10n || 1n
  const entries = [
    {
      label: 'holder_small_sentinel',
      assetsRaw: small.assetsRaw,
      basis: 'holder_half_claim_capped_vault_0p001pct',
    },
    {
      label: 'holder_near_claim_90pct',
      assetsRaw: near.toString(),
      basis: 'floor(90pct_of_selected_pinned_claim)',
    },
    {
      label: 'largest_vault_tier_within_claim',
      assetsRaw: largest?.assetsRaw ?? null,
      basis: largest?.label ?? 'no_vault_tier_within_claim',
    },
  ]
  const seen = new Set()
  return entries.map((entry) => {
    const q = entry.assetsRaw
    if (q === null) return { ...entry, assetsRaw: null, omittedReason: 'no_tier' }
    if (BigInt(q) > claim) throw Error('holder_v2_q_over_claim')
    if (seen.has(q)) return { ...entry, assetsRaw: null, omittedReason: 'duplicate_q' }
    seen.add(q)
    return { ...entry, omittedReason: null }
  })
}

export function validateV2NoHolderCandidate(issue) {
  if (
    issue.holder !== null ||
    issue.cases.length ||
    issue.candidate.evidenceDoc.selectedHolderCommitment !== null ||
    issue.candidate.evidenceDoc.selectedSharesRaw !== null ||
    issue.candidate.evidenceDoc.selectedClaimRaw !== null ||
    issue.candidate.evidenceDoc.ladder?.selectedClaimRaw !== null
  )
    throw Error('holder_v2_no_holder_invalid')
  return issue
}

function expectedTargets(issuedAtUtc) {
  return HORIZONS.map((horizonHours) => ({
    horizonHours,
    targetAtUtc: new Date(utc(issuedAtUtc) + horizonHours * HOUR).toISOString(),
    captureDeadlineUtc: new Date(utc(issuedAtUtc) + (horizonHours + 2) * HOUR).toISOString(),
  }))
}

export function validateV2Issue(issue) {
  const route = ROUTES.find(
    (row) =>
      row.routeKey === issue?.routeKey &&
      row.destination === issue.destination &&
      row.asset === issue.asset,
  )
  if (
    !route ||
    issue.study !== ISSUE_STUDY ||
    issue.chainId !== 1 ||
    issue.scope !== (BOARD_KEYS.has(route.routeKey) ? 'frozen_board_25' : 'supplemental_seed') ||
    !Number.isSafeInteger(issue.slot) ||
    issue.slot < 0 ||
    issue.clock?.kind !== 'local_operator_clock' ||
    issue.clock.independentWitness !== null ||
    issue.clock.externalTimestampProof !== false ||
    issue.clock.operatorIssuedAtUtc !== issue.issuedAtUtc ||
    Math.floor(utc(issue.issuedAtUtc) / SLOT) !== issue.slot ||
    !equal(issue.horizonsHours, HORIZONS) ||
    !equal(issue.targets, expectedTargets(issue.issuedAtUtc)) ||
    issue.baseline?.routeKey !== route.routeKey ||
    issue.baseline?.destination !== route.destination ||
    issue.baseline?.asset !== route.asset ||
    issue.baseline.canonicalityEvidenceDoc?.source !== ISSUE_STUDY ||
    issue.baseline.canonicalityEvidenceDoc?.targetHeader?.hash !== issue.baseline.targetHash ||
    issue.baseline.canonicalityEvidenceDoc?.targetHeader?.number !== issue.baseline.targetBlock ||
    issue.baselineWitness?.hash !== issue.baseline.targetHash ||
    issue.baselineWitness?.block !== issue.baseline.targetBlock ||
    issue.baselineWitness?.asset !== route.asset ||
    issue.baselineWitness?.totalAssetsRaw !== issue.baseline.totalAssetsRaw ||
    issue.baselineWitness?.assetDecimals !== issue.baseline.assetDecimals ||
    !independent(issue.baseline.canonicalityEvidenceDoc.provider, issue.baselineWitness.provider) ||
    utc(issue.baseline.targetBlockAt) > utc(issue.baseline.targetObservedAt) ||
    utc(issue.baseline.targetObservedAt) > utc(issue.issuedAtUtc) ||
    utc(issue.issuedAtUtc) - utc(issue.baseline.targetBlockAt) > HOUR ||
    utc(issue.baselineWitness.observedAtUtc) > utc(issue.issuedAtUtc) ||
    !HASH.test(issue.candidate?.digest ?? '') ||
    issue.candidate.digest !== hash(JSON.stringify(issue.candidate.evidenceDoc)) ||
    issue.candidate.evidenceDoc?.routeKey !== route.routeKey ||
    issue.candidate.evidenceDoc?.destination !== route.destination ||
    issue.candidate.evidenceDoc?.asset !== route.asset ||
    issue.candidate.evidenceDoc?.baselineHash !== issue.baseline.targetHash ||
    !['issued', 'no_holder', 'baseline_unavailable'].includes(issue.status) ||
    !Array.isArray(issue.cases)
  )
    throw Error('holder_v2_issue_invalid')
  if ([API_PAGE_V1, API_PAGE_V2].includes(issue.candidate.evidenceDoc.schema)) {
    const api = issue.candidate.evidenceDoc
    const hostCommitments = [
      apiHostCommitment(issue.baseline.canonicalityEvidenceDoc.provider),
      apiHostCommitment(issue.baselineWitness.provider),
    ]
    if (
      api.baselineState?.totalAssetsRaw !== issue.baseline.totalAssetsRaw ||
      api.baselineState?.assetDecimals !== issue.baseline.assetDecimals ||
      api.baselineBlock !== issue.baseline.targetBlock ||
      api.parentHash !== issue.baseline.targetParentHash ||
      api.screenedCandidates?.some(
        (row) => row.pinnedProof && !equal(row.pinnedProof.hostCommitments, hostCommitments),
      )
    )
      throw Error('holder_v2_candidate_baseline_state_invalid')
    if (api.schema === API_PAGE_V1) validateMorphoApiCandidateEvidence(api)
    else validateMorphoApiCandidateEvidenceV2(api)
  } else if (issue.candidate.evidenceDoc.schema === LOCAL_PAYOUT_SCHEMA) {
    const doc = issue.candidate.evidenceDoc
    if (
      doc.baselineState?.totalAssetsRaw !== issue.baseline.totalAssetsRaw ||
      doc.baselineState?.assetDecimals !== issue.baseline.assetDecimals ||
      doc.baselineBlock !== issue.baseline.targetBlock ||
      doc.parentHash !== issue.baseline.targetParentHash
    )
      throw Error('holder_v2_candidate_baseline_state_invalid')
    validateMorphoLocalPayoutCandidateEvidence(doc, [
      apiHostCommitment(issue.baseline.canonicalityEvidenceDoc.provider),
      apiHostCommitment(issue.baselineWitness.provider),
    ])
  } else if (issue.candidate.evidenceDoc.schema === MORPHO_HISTORICAL_TRANSFER_SCHEMA) {
    const doc = issue.candidate.evidenceDoc
    if (
      doc.baselineState?.totalAssetsRaw !== issue.baseline.totalAssetsRaw ||
      doc.baselineState?.assetDecimals !== issue.baseline.assetDecimals ||
      doc.baselineBlock !== issue.baseline.targetBlock ||
      doc.parentHash !== issue.baseline.targetParentHash
    )
      throw Error('holder_v2_candidate_baseline_state_invalid')
    validateMorphoHistoricalTransferCandidateEvidence(doc, [
      apiHostCommitment(issue.baseline.canonicalityEvidenceDoc.provider),
      apiHostCommitment(issue.baselineWitness.provider),
    ])
  } else if (issue.candidate.evidenceDoc.schema === 'carry_exit_v2_morpho_seed_candidate_v1') {
    if (
      issue.candidate.evidenceDoc.baselineState?.totalAssetsRaw !== issue.baseline.totalAssetsRaw ||
      issue.candidate.evidenceDoc.baselineState?.assetDecimals !== issue.baseline.assetDecimals ||
      issue.candidate.evidenceDoc.baselineBlock !== issue.baseline.targetBlock ||
      issue.candidate.evidenceDoc.parentHash !== issue.baseline.targetParentHash
    )
      throw Error('holder_v2_candidate_baseline_state_invalid')
    validateMorphoSeedCandidateEvidence(issue.candidate.evidenceDoc, {
      primaryProvider: issue.baseline.canonicalityEvidenceDoc.provider,
      secondaryProvider: issue.baselineWitness.provider,
    })
  } else if (issue.candidate.evidenceDoc.schema !== 'carry_exit_v2_morpho_candidate_v1')
    throw Error('holder_v2_candidate_schema_invalid')
  if (issue.status === 'no_holder') {
    return validateV2NoHolderCandidate(issue)
  }
  if (
    !/^0x[0-9a-f]{40}$/.test(issue.holder ?? '') ||
    issue.candidate.evidenceDoc.selectedHolderCommitment !==
      hash(`${route.destination}:${issue.holder}`)
  )
    throw Error('holder_v2_holder_invalid')
  const ladder = issue.candidate.evidenceDoc.ladder
  if (
    ladder?.basis !== 'frozen_holder_claim_and_vault_total_assets_raw' ||
    ladder.totalAssetsRaw !== issue.baseline.totalAssetsRaw ||
    !DECIMAL.test(ladder.selectedClaimRaw ?? '')
  )
    throw Error('holder_v2_ladder_invalid')
  const frozen = freezeQCases(issue.candidate)
  if (
    issue.cases.length !== frozen.length ||
    issue.cases.some(
      (row, index) =>
        row.label !== frozen[index].label ||
        row.assetsRaw !== frozen[index].assetsRaw ||
        row.basis !== frozen[index].basis ||
        row.omittedReason !== frozen[index].omittedReason,
    )
  )
    throw Error('holder_v2_q_invalid')
  for (const row of issue.cases) {
    if (row.omittedReason) {
      if (row.baselineStatus !== 'omitted' || row.evidence !== null || row.evidenceSha256 !== null)
        throw Error('holder_v2_omitted_invalid')
      continue
    }
    if (
      !['simulated_withdraw_success', 'baseline_revert', 'unavailable'].includes(row.baselineStatus)
    )
      throw Error('holder_v2_case_status_invalid')
    if (row.baselineStatus === 'unavailable') {
      if (row.evidence !== null || row.evidenceSha256 !== null)
        throw Error('holder_v2_case_unavailable_invalid')
      if (row.unavailableReason != null && !/^[a-z0-9_]+$/.test(row.unavailableReason))
        throw Error('holder_v2_case_reason_invalid')
      continue
    }
    if (
      !HASH.test(row.evidenceSha256 ?? '') ||
      row.evidenceSha256 !== hash(JSON.stringify(row.evidence))
    )
      throw Error('holder_v2_case_digest_invalid')
    const decoded = verifyMeasurement({
      route,
      holder: issue.holder,
      assetsRaw: row.assetsRaw,
      blockNumber: issue.baseline.targetBlock,
      blockHash: issue.baseline.targetHash,
      blockAt: issue.baseline.targetBlockAt,
      source: ISSUE_STUDY,
      evidence: row.evidence,
      before: issue.baseline.targetBlockAt,
      after: issue.issuedAtUtc,
    })
    if (
      (decoded.simulationStatus === 'success'
        ? 'simulated_withdraw_success'
        : 'baseline_revert') !== row.baselineStatus
    )
      throw Error('holder_v2_case_result_invalid')
  }
  if (
    (issue.status === 'issued') !==
    issue.cases.some((row) => row.baselineStatus === 'simulated_withdraw_success')
  )
    throw Error('holder_v2_issue_status_invalid')
  return issue
}

export async function readV2Issues() {
  const issues = await readChain(V2_ISSUE_DIR, validateV2Issue)
  await verifyLocalPayoutIssueSources(issues)
  return issues
}

export function scoreTransition(baselineStatus, outcome) {
  if (!['simulated_withdraw_success', 'baseline_revert'].includes(baselineStatus))
    throw Error('holder_v2_transition_baseline_invalid')
  if (outcome === 'censored_capture_window_missed') return 'censored'
  if (outcome === 'simulated_withdraw_success')
    return baselineStatus === 'baseline_revert' ? 'simulated_recovery' : 'simulated_continuity'
  if (outcome === 'holder_attrition') return 'holder_attrition'
  if (outcome === 'inconclusive_revert') return 'inconclusive_revert'
  if (!['preview_gap', 'covered_revert_cause_unknown'].includes(outcome))
    throw Error('holder_v2_transition_outcome_invalid')
  return baselineStatus === 'baseline_revert' ? 'still_reverting' : 'new_revert'
}

export function validateV2Score(score, issues) {
  const issue = issues[score?.issueSequence - 1]
  const row = issue?.cases.find((entry) => entry.label === score.caseLabel)
  const plan = issue?.targets.find((target) => target.horizonHours === score.horizonHours)
  if (
    !issue ||
    !row ||
    !plan ||
    !['simulated_withdraw_success', 'baseline_revert'].includes(row.baselineStatus) ||
    score.study !== SCORE_STUDY ||
    score.issueSha256 !== issue.sha256 ||
    score.caseLabel !== row.label ||
    score.baselineStatus !== row.baselineStatus ||
    score.transition !== scoreTransition(row.baselineStatus, score.outcome) ||
    score.assetsRaw !== row.assetsRaw ||
    score.caseEvidenceSha256 !== row.evidenceSha256 ||
    score.routeKey !== issue.routeKey ||
    score.destination !== issue.destination ||
    score.asset !== issue.asset ||
    score.holder !== issue.holder ||
    score.targetAtUtc !== plan.targetAtUtc ||
    score.captureDeadlineUtc !== plan.captureDeadlineUtc ||
    utc(score.scoredAtUtc) < utc(plan.targetAtUtc)
  )
    throw Error('holder_v2_score_case_invalid')
  if (score.outcome === 'censored_capture_window_missed') {
    if (
      utc(score.scoredAtUtc) <= utc(plan.captureDeadlineUtc) ||
      score.target !== null ||
      score.targetWitness !== null ||
      score.evidence !== null
    )
      throw Error('holder_v2_censor_invalid')
    return score
  }
  if (
    utc(score.scoredAtUtc) > utc(plan.captureDeadlineUtc) ||
    !score.target ||
    !score.targetWitness ||
    !score.evidence ||
    score.target.targetBlock !== score.targetWitness.targetBlock ||
    score.target.targetHash !== score.targetWitness.targetHash ||
    score.target.targetParentHash !== score.targetWitness.targetParentHash ||
    !independent(
      score.target.canonicalityEvidenceDoc?.provider,
      score.targetWitness.canonicalityEvidenceDoc?.provider,
    ) ||
    !HASH.test(score.evidenceSha256 ?? '') ||
    score.evidenceSha256 !== hash(JSON.stringify(score.evidence))
  )
    throw Error('holder_v2_score_measurement_invalid')
  validateTarget(score.target, issue, plan, score.scoredAtUtc, SCORE_STUDY)
  validateTarget(score.targetWitness, issue, plan, score.scoredAtUtc, SCORE_STUDY)
  const decoded = verifyMeasurement({
    route: { routeKey: issue.routeKey, destination: issue.destination, asset: issue.asset },
    holder: issue.holder,
    assetsRaw: row.assetsRaw,
    blockNumber: score.target.targetBlock,
    blockHash: score.target.targetHash,
    blockAt: score.target.targetBlockAt,
    source: SCORE_STUDY,
    evidence: score.evidence,
    before: score.target.targetBlockAt,
    after: score.scoredAtUtc,
  })
  if (classify(decoded) !== score.outcome) throw Error('holder_v2_score_outcome_invalid')
  return score
}
export async function readV2Scores(issues = null) {
  const rows = issues ?? (await readV2Issues())
  return readChain(V2_SCORE_DIR, (score) => validateV2Score(score, rows))
}

export function validateV2Attempt(attempt) {
  const linksIssue = ['issued', 'no_holder', 'baseline_unavailable'].includes(attempt?.status)
  const reconstructed = attempt?.reconstructedFromSealedIssue === true
  if (
    attempt?.study !== 'carry_local_morpho_holder_v2_attempt_v1' ||
    !BOARD_ROUTES.some(
      (route) =>
        route.routeKey === attempt.routeKey &&
        route.destination === attempt.destination &&
        route.asset === attempt.asset,
    ) ||
    utc(attempt.finishedAtUtc) < utc(attempt.startedAtUtc) ||
    !['issued', 'no_holder', 'baseline_unavailable', 'duplicate', 'origin_unavailable'].includes(
      attempt.status,
    ) ||
    (attempt.candidateSource !== undefined &&
      !['morpho-api', 'morpho-api-page', 'local-payout', 'historical-transfer'].includes(
        attempt.candidateSource,
      )) ||
    (attempt.candidateSource === 'historical-transfer'
      ? !Array.isArray(attempt.historicalBlocks) ||
        attempt.historicalBlocks.length < 1 ||
        attempt.historicalBlocks.length > 8 ||
        attempt.historicalBlocks.some(
          (block, index) =>
            !DECIMAL.test(block) ||
            BigInt(block) < 1n ||
            (index > 0 && BigInt(block) <= BigInt(attempt.historicalBlocks[index - 1])),
        )
      : attempt.historicalBlocks !== undefined) ||
    (attempt.candidateSource === 'morpho-api-page' && attempt.apiPageSkip === undefined) ||
    (attempt.apiPageSkip !== undefined &&
      (!['morpho-api', 'morpho-api-page'].includes(attempt.candidateSource) ||
        !Number.isSafeInteger(attempt.apiPageSkip) ||
        attempt.apiPageSkip < 0 ||
        attempt.apiPageSkip % 8 !== 0)) ||
    (attempt.reconstructedFromSealedIssue !== undefined && !reconstructed) ||
    (reconstructed &&
      (attempt.status !== 'issued' ||
        attempt.candidateSource !== 'morpho-api' ||
        attempt.apiPageSkip === undefined ||
        !attempt.reconciledAtUtc ||
        utc(attempt.reconciledAtUtc) < utc(attempt.finishedAtUtc))) ||
    (!reconstructed && attempt.reconciledAtUtc !== undefined) ||
    (linksIssue ? !HASH.test(attempt.issueSha256 ?? '') : attempt.issueSha256 !== null) ||
    !attempt.originFailures ||
    typeof attempt.originFailures !== 'object' ||
    Object.entries(attempt.originFailures).some(
      ([reason, count]) =>
        !/^[a-z0-9_]+$/.test(reason) || !Number.isSafeInteger(count) || count < 1,
    )
  )
    throw Error('holder_v2_attempt_invalid')
  return attempt
}
export const readV2Attempts = () => readChain(V2_ATTEMPT_DIR, validateV2Attempt)

export function reconcileV2Attempts(issues, attempts) {
  const byHash = new Map(issues.map((issue) => [issue.sha256, issue]))
  const linked = new Set()
  let reconstructedIssues = 0
  const unissuedAttempts = []
  for (const attempt of attempts) {
    validateV2Attempt(attempt)
    if (attempt.issueSha256 === null) {
      unissuedAttempts.push({
        attemptSequence: attempt.sequence,
        status: attempt.status,
      })
      continue
    }
    const issue = byHash.get(attempt.issueSha256)
    if (
      !issue ||
      linked.has(issue.sha256) ||
      attempt.status !== issue.status ||
      attempt.routeKey !== issue.routeKey ||
      attempt.destination !== issue.destination ||
      attempt.asset !== issue.asset ||
      (attempt.candidateSource === 'morpho-api' && !apiPage(issue)) ||
      (attempt.candidateSource === 'morpho-api-page' &&
        issue.candidate?.evidenceDoc?.schema !== API_PAGE_V2) ||
      (attempt.candidateSource === 'local-payout' &&
        issue.candidate?.evidenceDoc?.schema !== LOCAL_PAYOUT_SCHEMA) ||
      (attempt.candidateSource === 'historical-transfer' &&
        (issue.candidate?.evidenceDoc?.schema !== MORPHO_HISTORICAL_TRANSFER_SCHEMA ||
          !equal(
            attempt.historicalBlocks,
            issue.candidate.evidenceDoc.discovery?.windows?.map((window) =>
              window.fromBlock === window.toBlock ? window.fromBlock : null,
            ),
          ))) ||
      (attempt.apiPageSkip !== undefined && apiPage(issue)?.skip !== attempt.apiPageSkip) ||
      utc(attempt.startedAtUtc) > utc(issue.issuedAtUtc) ||
      utc(attempt.finishedAtUtc) < utc(issue.issuedAtUtc)
    )
      throw Error('holder_v2_attempt_issue_mismatch')
    if (
      attempt.reconstructedFromSealedIssue === true &&
      (attempt.startedAtUtc !== issue.baseline?.targetObservedAt ||
        attempt.finishedAtUtc !== issue.issuedAtUtc ||
        Object.keys(attempt.originFailures).length !== 0)
    )
      throw Error('holder_v2_attempt_issue_mismatch')
    if (attempt.reconstructedFromSealedIssue === true) reconstructedIssues++
    linked.add(issue.sha256)
  }
  return {
    linkedIssues: linked.size,
    reconstructedIssues,
    unissuedAttempts,
    orphanIssues: issues
      .filter((issue) => !linked.has(issue.sha256))
      .map((issue) => ({
        issueSequence: issue.sequence,
        issueSha256: issue.sha256,
        status: 'orphan_issue_without_attempt',
      })),
  }
}

export async function issueV2({
  route,
  primary,
  secondary,
  fallbackPairs = [],
  lookbackBlocks = 4_096,
  candidateSource = 'transfer-logs',
  onlyMissing = false,
  apiPageSkip = 0,
  now = () => new Date(),
  capture = captureFreshMorphoBaseline,
  discover = discoverMorphoIssuerCandidate,
  discoverApi = discoverMorphoApiIssuerCandidate,
  discoverApiV2 = discoverMorphoApiIssuerCandidateV2,
  discoverSeed = discoverMorphoSeedIssuerCandidate,
  discoverPayout = discoverMorphoLocalPayoutCandidate,
  discoverHistorical = discoverMorphoHistoricalTransferCandidate,
  historicalWindows = [],
  measure = measureCarryExitV2Verified,
  append = appendChain,
}) {
  if (!Number.isSafeInteger(lookbackBlocks) || lookbackBlocks < 32 || lookbackBlocks > 4_096)
    throw Error('holder_v2_lookback_blocks_invalid')
  if (
    ![
      'transfer-logs',
      'morpho-api',
      'morpho-api-page',
      'frozen-seed',
      'local-payout',
      'historical-transfer',
    ].includes(candidateSource)
  )
    throw Error('holder_v2_candidate_source_invalid')
  if (candidateSource === 'historical-transfer' && !historicalWindows.length)
    throw Error('holder_v2_historical_windows_missing')
  if (!Number.isSafeInteger(apiPageSkip) || apiPageSkip < 0 || apiPageSkip % 8 !== 0)
    throw Error('holder_v2_api_page_invalid')
  if (
    candidateSource === 'frozen-seed' &&
    route.destination !== '0xbeeff0deac1aba71ef0d88c4291354eb92ef4589'
  )
    throw Error('holder_v2_seed_route_invalid')
  if (
    !ROUTES.some(
      (row) =>
        row.routeKey === route.routeKey &&
        row.destination === route.destination &&
        row.asset === route.asset,
    ) ||
    !independent(primary.provider, secondary.provider)
  )
    throw Error('holder_v2_route_or_origin_invalid')
  const baseline = await capture({
    ...route,
    provider: primary.provider,
    source: ISSUE_STUDY,
    request: primary.request.bind(primary),
    now,
  })
  const witness = await baselineWitness(route, baseline, secondary, now)
  const candidate =
    (candidateSource === 'morpho-api' && onlyMissing) || candidateSource === 'morpho-api-page'
      ? await discoverApiV2({ baseline, primary, secondary, pageSkip: apiPageSkip, now })
      : candidateSource === 'morpho-api'
        ? await discoverApi({ baseline, primary, secondary, now })
        : candidateSource === 'frozen-seed'
          ? await discoverSeed({ baseline, primary, secondary })
          : candidateSource === 'local-payout'
            ? await discoverPayout({ baseline, primary, secondary })
            : candidateSource === 'historical-transfer'
              ? await discoverHistorical({
                  baseline,
                  primary,
                  secondary,
                  windows: historicalWindows,
                })
              : await discover({
                  baseline,
                  request: slicedCandidateRequest(primary),
                  lookbackBlocks,
                })
  const holder = candidate.holder
  const cases = []
  const measureStarted = Date.now()
  if (holder)
    for (const entry of freezeQCases(candidate)) {
      const base = { ...entry, baselineStatus: 'unavailable', evidence: null, evidenceSha256: null }
      if (entry.omittedReason) {
        cases.push({ ...base, baselineStatus: 'omitted' })
        continue
      }
      let completed = false
      let reason = 'measurement_unavailable'
      for (const pair of [{ primary, secondary }, ...fallbackPairs].slice(0, 4)) {
        if (Date.now() - measureStarted > 7 * 60_000) break
        try {
          const measured = await measure({
            ...route,
            holder,
            assetsRaw: entry.assetsRaw,
            target: baseline,
            provider: pair.primary.provider,
            source: ISSUE_STUDY,
            send: pair.primary.send.bind(pair.primary),
            primary: { url: pair.primary.url, request: pair.primary.send.bind(pair.primary) },
            secondary: {
              url: pair.secondary.url,
              request: pair.secondary.send.bind(pair.secondary),
            },
            now,
          })
          if (measured.status !== 'verified') {
            reason = /^[a-z0-9_]+$/.test(measured.reason ?? '')
              ? measured.reason
              : 'measurement_unavailable'
            continue
          }
          const decoded = validateCarryExitV2RpcProof({
            proof: measured.callEvidenceDoc,
            ...route,
            holder,
            assetsRaw: entry.assetsRaw,
            blockNumber: baseline.targetBlock,
            blockHash: baseline.targetHash,
          })
          cases.push({
            ...base,
            baselineStatus:
              decoded.simulationStatus === 'success'
                ? 'simulated_withdraw_success'
                : 'baseline_revert',
            evidence: measured.callEvidenceDoc,
            evidenceSha256: hash(JSON.stringify(measured.callEvidenceDoc)),
          })
          completed = true
          break
        } catch {
          reason = 'measurement_unavailable'
        }
      }
      if (!completed) cases.push({ ...base, unavailableReason: reason })
    }
  const issuedAtUtc = now().toISOString()
  const prior = await readV2Issues()
  if (onlyMissing) {
    const { readVerifiedHolderExitForceabilityMatrix } =
      await import('./holder-exit-forceability-matrix.mjs')
    const matrix = await readVerifiedHolderExitForceabilityMatrix()
    const subject = matrix.subjects.find(
      (row) =>
        routeIdentity(row) === routeIdentity(route) &&
        row.reasons.some((reason) => MISSING_BASELINE_REASONS.has(reason)),
    )
    const selected = subject
      ? selectMissingMorphoApiSubject({
          eligibleSubjects: [subject],
          issues: prior,
          attempts: await readV2Attempts(),
        })
      : null
    if (selected?.status !== 'selected' || selected.apiPageSkip !== apiPageSkip)
      return { status: 'duplicate', sequence: prior.at(-1)?.sequence ?? null }
  }
  const slot = Math.floor(utc(issuedAtUtc) / SLOT)
  if (
    prior.some(
      (row) =>
        row.slot === slot &&
        row.routeKey === route.routeKey &&
        row.destination === route.destination,
    )
  )
    return { status: 'duplicate', sequence: prior.at(-1).sequence }
  const status = !holder
    ? 'no_holder'
    : cases.some((row) => row.baselineStatus === 'simulated_withdraw_success')
      ? 'issued'
      : 'baseline_unavailable'
  const issue = await append(
    V2_ISSUE_DIR,
    {
      study: ISSUE_STUDY,
      chainId: 1,
      scope: BOARD_KEYS.has(route.routeKey) ? 'frozen_board_25' : 'supplemental_seed',
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      slot,
      issuedAtUtc,
      clock: {
        kind: 'local_operator_clock',
        independentWitness: null,
        externalTimestampProof: false,
        operatorIssuedAtUtc: issuedAtUtc,
      },
      horizonsHours: HORIZONS,
      targets: expectedTargets(issuedAtUtc),
      status,
      holder,
      baseline,
      baselineWitness: witness,
      candidate,
      cases,
    },
    validateV2Issue,
  )
  return {
    status,
    sequence: issue.sequence,
    routeKey: route.routeKey,
    caseStatuses: cases.map((row) => ({ label: row.label, status: row.baselineStatus })),
    baselineBlock: baseline.targetBlock,
    sha256: issue.sha256,
  }
}

export function selectDueV2ScoreCells(issues, scores, asOfMs, limit = 6) {
  const scored = new Set(
    scores.map((score) => `${score.issueSequence}:${score.caseLabel}:${score.horizonHours}`),
  )
  return issues
    .flatMap((issue) =>
      issue.status === 'issued' || issue.status === 'baseline_unavailable'
        ? issue.cases
            .filter((row) =>
              ['simulated_withdraw_success', 'baseline_revert'].includes(row.baselineStatus),
            )
            .flatMap((row) => issue.targets.map((plan) => ({ issue, row, plan })))
        : [],
    )
    .filter(
      ({ issue, row, plan }) =>
        utc(plan.targetAtUtc) <= asOfMs &&
        !scored.has(`${issue.sequence}:${row.label}:${plan.horizonHours}`),
    )
    .sort(
      (a, b) =>
        Number(asOfMs > utc(a.plan.captureDeadlineUtc)) -
          Number(asOfMs > utc(b.plan.captureDeadlineUtc)) ||
        utc(a.plan.captureDeadlineUtc) - utc(b.plan.captureDeadlineUtc),
    )
    .slice(0, limit)
}

export async function scoreV2Due({
  pairs,
  now = () => new Date(),
  choose = selectCarryExitV2FirstFinalizedBlock,
  measure = measureCarryExitV2Verified,
  append = appendChain,
  decode = validateCarryExitV2RpcProof,
  readIssueRows = readV2Issues,
  readScoreRows = readV2Scores,
  limit = 6,
}) {
  if (
    !Array.isArray(pairs) ||
    !pairs.length ||
    pairs.length > 8 ||
    pairs.some(({ primary, secondary }) => !independent(primary.provider, secondary.provider))
  )
    throw Error('holder_v2_score_origins_invalid')
  const issues = await readIssueRows()
  const scores = await readScoreRows(issues)
  const asOfMs = now().getTime()
  const pending = selectDueV2ScoreCells(issues, scores, asOfMs, limit)
  const deadline = Date.now() + 210_000
  const counts = {
    measured: 0,
    censored: 0,
    retry: 0,
    pairAttempts: 0,
    retryByStage: zeroCounts(SCORE_STAGES),
    retryByError: zeroCounts(SCORE_ERRORS),
  }
  for (const { issue, row, plan } of pending) {
    const late = now().getTime() > utc(plan.captureDeadlineUtc)
    let target = null,
      targetWitness = null,
      evidence = null
    let outcome = 'censored_capture_window_missed'
    if (!late) {
      let succeeded = false
      for (const { primary, secondary } of pairs) {
        if (Date.now() >= deadline) break
        counts.pairAttempts++
        let stage = 'target_primary'
        try {
          const input = {
            targetAt: plan.targetAtUtc,
            baselineBlock: issue.baseline.targetBlock,
            baselineHash: issue.baseline.targetHash,
            provider: primary.provider,
            source: SCORE_STUDY,
            request: primary.request.bind(primary),
            now,
          }
          target = await choose(input)
          stage = 'target_witness'
          targetWitness = await choose({
            ...input,
            provider: secondary.provider,
            request: secondary.request.bind(secondary),
          })
          stage = 'target_consensus'
          if (
            target.targetBlock !== targetWitness.targetBlock ||
            target.targetHash !== targetWitness.targetHash
          )
            throw Error('holder_v2_target_disagreement')
          stage = 'measurement'
          const measured = await measure({
            routeKey: issue.routeKey,
            destination: issue.destination,
            asset: issue.asset,
            holder: issue.holder,
            assetsRaw: row.assetsRaw,
            target,
            provider: primary.provider,
            source: SCORE_STUDY,
            send: primary.send.bind(primary),
            primary: { url: primary.url, request: primary.send.bind(primary) },
            secondary: { url: secondary.url, request: secondary.send.bind(secondary) },
            now,
          })
          if (measured.status !== 'verified') throw Error('holder_v2_replay_unavailable')
          evidence = measured.callEvidenceDoc
          stage = 'proof_decode'
          const decoded = decode({
            proof: evidence,
            routeKey: issue.routeKey,
            destination: issue.destination,
            asset: issue.asset,
            holder: issue.holder,
            assetsRaw: row.assetsRaw,
            blockNumber: target.targetBlock,
            blockHash: target.targetHash,
          })
          outcome = classify(decoded)
          succeeded = true
          break
        } catch (error) {
          counts.retryByStage[stage]++
          counts.retryByError[scoreRetryErrorCode(error)]++
          target = null
          targetWitness = null
          evidence = null
        }
      }
      if (!succeeded) {
        counts.retry++
        continue
      }
    }
    const scoredAtUtc = now().toISOString()
    if (!late && utc(scoredAtUtc) > utc(plan.captureDeadlineUtc)) {
      counts.retry++
      continue
    }
    await append(
      V2_SCORE_DIR,
      {
        study: SCORE_STUDY,
        issueSequence: issue.sequence,
        issueSha256: issue.sha256,
        caseLabel: row.label,
        baselineStatus: row.baselineStatus,
        caseEvidenceSha256: row.evidenceSha256,
        routeKey: issue.routeKey,
        destination: issue.destination,
        asset: issue.asset,
        holder: issue.holder,
        assetsRaw: row.assetsRaw,
        horizonHours: plan.horizonHours,
        targetAtUtc: plan.targetAtUtc,
        captureDeadlineUtc: plan.captureDeadlineUtc,
        scoredAtUtc,
        outcome,
        transition: scoreTransition(row.baselineStatus, outcome),
        target,
        targetWitness,
        evidence,
        evidenceSha256: evidence ? hash(JSON.stringify(evidence)) : null,
      },
      (score) => validateV2Score(score, issues),
    )
    if (late) counts.censored++
    else counts.measured++
  }
  return { scanned: pending.length, counts, forecastValidated: false }
}

export function parseMorphoV2CliArgs(args, nowMs = Date.now()) {
  const [mode, ...rest] = args
  const usage =
    'usage: --issue [route-index] [--lookback-blocks N | --candidate-source morpho-api|frozen-seed|local-payout | --historical-blocks N[,N...]] | --issue-api-page route-index page-skip | --issue-missing-api | --score | --verify'
  if (mode === '--issue-api-page') {
    if (rest.length !== 2 || rest.some((value) => !/^(?:0|[1-9][0-9]*)$/.test(value)))
      throw Error(usage)
    const routeIndex = Number(rest[0])
    const apiPageSkip = Number(rest[1])
    if (
      !Number.isSafeInteger(routeIndex) ||
      routeIndex >= BOARD_ROUTES.length ||
      !Number.isSafeInteger(apiPageSkip) ||
      apiPageSkip % 8 !== 0
    )
      throw Error('holder_v2_api_page_invalid')
    return {
      mode,
      routeIndex,
      lookbackBlocks: 4_096,
      candidateSource: 'morpho-api-page',
      apiPageSkip,
    }
  }
  if (mode === '--issue-missing-api') {
    if (rest.length) throw Error(usage)
    return { mode }
  }
  if (mode === '--score' || mode === '--verify') {
    if (rest.length) throw Error(usage)
    return { mode }
  }
  if (mode !== '--issue') throw Error(usage)
  let routeIndex = Math.floor(nowMs / SLOT) % BOARD_ROUTES.length
  let offset = 0
  if (rest.length && !rest[0].startsWith('--')) {
    if (!/^(?:0|[1-9]\d*)$/.test(rest[0])) throw Error('holder_v2_route_index_invalid')
    routeIndex = Number(rest[0])
    offset = 1
  }
  if (!Number.isInteger(routeIndex) || routeIndex < 0 || routeIndex >= BOARD_ROUTES.length)
    throw Error('holder_v2_route_index_invalid')
  let lookbackBlocks = 4_096
  if (offset < rest.length) {
    if (rest[offset] === '--historical-blocks') {
      if (rest.length !== offset + 2) throw Error(usage)
      const blocks = rest[offset + 1].split(',')
      if (
        blocks.length < 1 ||
        blocks.length > 8 ||
        blocks.some(
          (block, index) =>
            !DECIMAL.test(block) ||
            BigInt(block) < 1n ||
            (index > 0 && BigInt(block) <= BigInt(blocks[index - 1])),
        )
      )
        throw Error('holder_v2_historical_blocks_invalid')
      return {
        mode,
        routeIndex,
        lookbackBlocks,
        candidateSource: 'historical-transfer',
        historicalBlocks: blocks,
      }
    }
    if (rest[offset] === '--candidate-source') {
      if (
        rest.length !== offset + 2 ||
        !['morpho-api', 'frozen-seed', 'local-payout'].includes(rest[offset + 1])
      )
        throw Error('holder_v2_candidate_source_invalid')
      return { mode, routeIndex, lookbackBlocks, candidateSource: rest[offset + 1] }
    }
    if (rest[offset] !== '--lookback-blocks' || rest.length > offset + 2) throw Error(usage)
    if (rest.length !== offset + 2) throw Error('holder_v2_lookback_blocks_invalid')
    if (!/^(?:0|[1-9]\d*)$/.test(rest[offset + 1])) throw Error('holder_v2_lookback_blocks_invalid')
    lookbackBlocks = Number(rest[offset + 1])
    if (!Number.isSafeInteger(lookbackBlocks) || lookbackBlocks < 32 || lookbackBlocks > 4_096)
      throw Error('holder_v2_lookback_blocks_invalid')
  }
  const implicitSeed =
    offset === 0 &&
    rest.length === 0 &&
    BOARD_ROUTES[routeIndex].routeKey === 'AUSD → VaultV2 [AUSD]' &&
    BOARD_ROUTES[routeIndex].destination === '0xbeeff0deac1aba71ef0d88c4291354eb92ef4589' &&
    BOARD_ROUTES[routeIndex].asset === '0x00000000efe302beaa2b3e6e1b18d08d69a9012a'
  return {
    mode,
    routeIndex,
    lookbackBlocks,
    ...(implicitSeed ? { candidateSource: 'frozen-seed' } : {}),
  }
}

async function main() {
  let {
    mode,
    routeIndex,
    lookbackBlocks,
    candidateSource,
    historicalBlocks,
    apiPageSkip = 0,
  } = parseMorphoV2CliArgs(process.argv.slice(2))
  const issues = await readV2Issues()
  const scores = await readV2Scores(issues)
  const attempts = await readV2Attempts()
  const attemptReconciliation = reconcileV2Attempts(issues, attempts)
  if (mode === '--verify')
    return {
      issues: issues.length,
      scores: scores.length,
      attempts: attempts.length,
      attemptReconciliation,
      issueSha256: issues.at(-1)?.sha256 ?? null,
      scoreSha256: scores.at(-1)?.sha256 ?? null,
    }
  if (mode === '--issue-missing-api') {
    const { readVerifiedHolderExitForceabilityMatrix } =
      await import('./holder-exit-forceability-matrix.mjs')
    const matrix = await readVerifiedHolderExitForceabilityMatrix()
    const selected = selectMissingMorphoApiSubject({
      eligibleSubjects: matrix.subjects.filter(
        (subject) =>
          subject.reasons.some((reason) => MISSING_BASELINE_REASONS.has(reason)) &&
          BOARD_ROUTES.some((route) => routeIdentity(route) === routeIdentity(subject)),
      ),
      issues,
      attempts,
    })
    if (selected.status !== 'selected') return { ...selected, forecastValidated: false }
    routeIndex = selected.routeIndex
    apiPageSkip = selected.apiPageSkip
    lookbackBlocks = 4_096
    candidateSource = 'morpho-api'
  }
  const { get } = readEnv()
  const urls = configuredPublicRpcUrls({ get })
  const origins = [...urls.slice(2), ...urls.slice(0, 2)]
  const pairs = origins.flatMap((url, index) => {
    for (let offset = 0; offset < origins.length; offset++) {
      if (offset === index) continue
      try {
        const [primary, secondary] = publicRpcClients([url, origins[offset]])
        return [{ primary, secondary }]
      } catch {
        /* Same host or invalid endpoint; keep looking. */
      }
    }
    return []
  })
  if (mode === '--score') return scoreV2Due({ pairs })
  const startedAtUtc = new Date().toISOString()
  const failures = {}
  const recordAttempt = async (status, issueSha256 = null) =>
    appendChain(
      V2_ATTEMPT_DIR,
      {
        study: 'carry_local_morpho_holder_v2_attempt_v1',
        routeKey: BOARD_ROUTES[routeIndex].routeKey,
        destination: BOARD_ROUTES[routeIndex].destination,
        asset: BOARD_ROUTES[routeIndex].asset,
        startedAtUtc,
        finishedAtUtc: new Date().toISOString(),
        status,
        issueSha256,
        ...(mode === '--issue-missing-api'
          ? { candidateSource: 'morpho-api' }
          : ['morpho-api-page', 'local-payout', 'historical-transfer'].includes(candidateSource)
            ? { candidateSource }
            : {}),
        ...(candidateSource === 'historical-transfer' ? { historicalBlocks } : {}),
        ...(['--issue-missing-api', '--issue-api-page'].includes(mode) ? { apiPageSkip } : {}),
        originFailures: failures,
      },
      validateV2Attempt,
    )
  const started = Date.now()
  for (const { primary, secondary } of pairs) {
    if (Date.now() - started >= 8 * 60_000) break
    let result
    try {
      result = await issueV2({
        route: BOARD_ROUTES[routeIndex],
        primary,
        secondary,
        lookbackBlocks,
        candidateSource,
        historicalWindows: historicalBlocks?.map((block) => ({
          fromBlock: block,
          toBlock: block,
        })),
        onlyMissing: mode === '--issue-missing-api',
        apiPageSkip,
        fallbackPairs: pairs
          .filter((pair) => pair.primary.provider !== primary.provider)
          .slice(0, 3),
      })
    } catch (error) {
      const code = /^[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'unavailable'
      failures[code] = (failures[code] ?? 0) + 1
      continue
    }
    await recordAttempt(result.status, result.sha256 ?? null)
    return result
  }
  await recordAttempt('origin_unavailable')
  throw Error('holder_v2_all_origins_unavailable')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main()
    .then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
    .catch((error) => {
      const code = /^[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'unavailable'
      process.stderr.write(`carry_local_morpho_holder_v2_failed:${code}\n`)
      process.exitCode = 1
    })
