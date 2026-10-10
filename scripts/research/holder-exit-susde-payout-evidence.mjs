// Offline, issue-level payout facts for verified EXISTING sUSDe pending queues.
// Observed request-to-payment time includes cooldown and holder action. It is
// neither a restriction-recovery duration nor a forecast feature for H cells.
import { createHash } from 'node:crypto'

const ROUTE = 'USDe → Staked USDe [USDe]'
const VAULT = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const ISSUE_STUDY = 'susde_public_pending_exit_issue_v1'
const PAYOUT_STUDY = 'susde_public_request_to_payout_episode_v1'
const LOCAL_SIDECAR_ISSUES = Object.freeze([1, 3, 6, 8, 10])
const MAX_ISSUES = 2_000
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/

const sha = (value) => createHash('sha256').update(value).digest('hex')
const check = (ok, reason) => {
  if (!ok) throw Error(`holder_episode_panel_susde_payout_${reason}`)
}
const utcMs = (value) => {
  const ms = Date.parse(value)
  check(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}
const secondsBetween = (earlier, later) => Math.floor((later - earlier) / 1_000)

/** Load only the five locally saved sidecars, one verified read at a time. */
export async function readVerifiedSusdePayoutEvidence({ loadOne } = {}) {
  const reader =
    loadOne ??
    (await import('./susde-public-request-to-payout-episode.mjs')).readVerifiedRequestToPayout
  check(typeof reader === 'function', 'loader_invalid')
  const records = []
  for (const issueSequence of LOCAL_SIDECAR_ISSUES) records.push(await reader({ issueSequence }))
  return records
}

/** Project reader-verified payout records against caller-verified pending issues. */
export function buildSusdePayoutEvidence({ issues, records, asOfMs = Number.MAX_SAFE_INTEGER }) {
  check(
    Array.isArray(issues) &&
      issues.length <= MAX_ISSUES &&
      Array.isArray(records) &&
      records.length <= LOCAL_SIDECAR_ISSUES.length &&
      Number.isSafeInteger(asOfMs) &&
      asOfMs >= 0,
    'input_limit',
  )
  const facts = []
  let notYetAvailablePayoutFactsExcluded = 0
  const seenIssues = new Set()
  const seenDeliveries = new Set()
  const seenTransactions = new Set()
  for (const record of records) {
    const issue = issues[record?.issueSequence - 1]
    check(
      LOCAL_SIDECAR_ISSUES.includes(record?.issueSequence) &&
        issue?.study === ISSUE_STUDY &&
        issue.sequence === record.issueSequence &&
        issue.routeKey === ROUTE &&
        issue.vault === VAULT &&
        issue.originalAsset === USDE &&
        issue.estimand === 'existing_pending_whole_queue_unstake_simulation' &&
        issue.minedDeliveryProven === false &&
        SHA.test(issue.sha256 ?? '') &&
        ADDRESS.test(issue.holder ?? '') &&
        DECIMAL.test(issue.pendingAssetsRaw ?? '') &&
        BigInt(issue.pendingAssetsRaw) > 0n &&
        record.study === PAYOUT_STUDY &&
        record.status === 'linked_observed_episode' &&
        record.issueSha256 === issue.sha256 &&
        record.holder === issue.holder &&
        record.rawAssets === issue.pendingAssetsRaw &&
        record.cooldownEndUtc === issue.cooldownEndUtc &&
        SHA.test(record.requestProofSha256 ?? '') &&
        SHA.test(record.sidecarSha256 ?? '') &&
        SHA.test(record.deliverySha256 ?? '') &&
        SHA.test(record.archiveFinalSha256 ?? '') &&
        HASH.test(record.requestTransactionHash ?? '') &&
        HASH.test(record.payoutTransactionHash ?? '') &&
        record.requestTransactionHash !== record.payoutTransactionHash &&
        DECIMAL.test(record.requestLogIndex ?? '') &&
        DECIMAL.test(record.requestSharesRaw ?? '') &&
        BigInt(record.requestSharesRaw) > 0n &&
        record.cryptographicAbsenceProven === false &&
        record.headerChainContinuityProven === false &&
        record.implementationIdentityVerified === false &&
        record.forecastValidated === false &&
        record.futureDurationClaim === false &&
        record.localEvidenceAvailabilityClock === 'unwitnessed_local_wall_clock',
      'binding_invalid',
    )
    check(
      !seenIssues.has(issue.sequence) &&
        !seenDeliveries.has(record.deliverySha256) &&
        !seenTransactions.has(record.payoutTransactionHash),
      'duplicate_payout',
    )
    seenIssues.add(issue.sequence)
    seenDeliveries.add(record.deliverySha256)
    seenTransactions.add(record.payoutTransactionHash)
    const requestMs = utcMs(record.requestAtUtc)
    const anchorMs = utcMs(issue.anchor?.blockAtUtc)
    const issueMs = utcMs(issue.issuedAtUtc)
    const cooldownEndMs = utcMs(issue.cooldownEndUtc)
    const payoutMs = utcMs(record.payoutAtUtc)
    const localEvidenceAvailableAtMs = utcMs(record.localEvidenceAvailableAtUtc)
    check(
      requestMs < anchorMs &&
        anchorMs <= issueMs &&
        issueMs < payoutMs &&
        requestMs < cooldownEndMs &&
        cooldownEndMs <= payoutMs &&
        localEvidenceAvailableAtMs >= payoutMs &&
        Number.isSafeInteger(record.observedRequestToPayoutSeconds) &&
        record.observedRequestToPayoutSeconds === secondsBetween(requestMs, payoutMs) &&
        Number.isSafeInteger(record.observedPendingToPayoutSeconds) &&
        record.observedPendingToPayoutSeconds === secondsBetween(anchorMs, payoutMs),
      'timing_invalid',
    )
    const fact = {
      subject: `${ROUTE}\0${VAULT}\0${USDE}`,
      issueSequence: issue.sequence,
      issueSha256: issue.sha256,
      holderCommitment: sha(`${VAULT}:${issue.holder}`),
      qRaw: issue.pendingAssetsRaw,
      qUnit: 'USDe_pending_whole_queue_assets',
      cooldownEndUtc: issue.cooldownEndUtc,
      requestAtUtc: record.requestAtUtc,
      payoutAtUtc: record.payoutAtUtc,
      localEvidenceAvailableAtUtc: record.localEvidenceAvailableAtUtc,
      localEvidenceAvailabilityClock: record.localEvidenceAvailabilityClock,
      observedRequestToPayoutSeconds: record.observedRequestToPayoutSeconds,
      observedPendingToPayoutSeconds: record.observedPendingToPayoutSeconds,
      requestProofSha256: record.requestProofSha256,
      sidecarSha256: record.sidecarSha256,
      deliverySha256: record.deliverySha256,
      archiveFinalSha256: record.archiveFinalSha256,
      requestTransactionHash: record.requestTransactionHash,
      requestLogIndex: record.requestLogIndex,
      payoutTransactionHash: record.payoutTransactionHash,
      minedFinalAssetPayoutProven: true,
      sameEpisodeEvidenceLevel: 'two_origin_rpc_log_attested',
      cryptographicAbsenceProven: false,
      forecastEligible: false,
      calibratedRestrictionDuration: false,
    }
    if (localEvidenceAvailableAtMs <= asOfMs) facts.push(fact)
    else notYetAvailablePayoutFactsExcluded++
  }
  facts.sort((a, b) => a.issueSequence - b.issueSequence)
  return {
    facts,
    diagnostics: {
      verifiedPayoutRecords: records.length,
      sameEpisodeMinedPayouts: facts.length,
      notYetAvailablePayoutFactsExcluded,
      futurePayoutFactsExcluded: notYetAvailablePayoutFactsExcluded,
      calibratedRestrictionDurations: 0,
      forecastValidated: false,
    },
  }
}
