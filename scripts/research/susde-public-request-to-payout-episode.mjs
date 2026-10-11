// Offline join of a verified request and a verified pending→payout
// sidecar. Observed duration only; no future-duration or absence claim.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toEventSelector } from 'viem'
import { OUT as ISSUE_OUT } from './susde-public-pending-exit-issue.mjs'
import { OUT as DELIVERY_OUT, verifyDeliveries } from './susde-public-mined-delivery.mjs'
import {
  OUT as ARCHIVE_OUT,
  verifyContinuityArchive,
} from './susde-public-pending-continuity-archive.mjs'
import { OUT as SIDECAR_OUT, verifyEpisodes } from './susde-public-pending-payout-v2.mjs'
import { OUT as REQUEST_OUT, verifyPreanchor } from './susde-public-preanchor-request-proof.mjs'
import { SILO, USDE, utc } from './susde-public-pending-exit-common.mjs'

export const STUDY = 'susde_public_request_to_payout_episode_v1'
const TRANSFER = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const hex = (value) => {
  if (!/^0x[0-9a-f]+$/i.test(value ?? '')) throw Error('request_payout_hex_invalid')
  return BigInt(value)
}
const fail = (reason) => {
  throw Error(`request_payout_${reason}`)
}
const issuePath = (prefix, issueSequence) =>
  resolve(`data/research/venue-signals/${prefix}-issue-${issueSequence}`)

/** Inputs must come from their respective offline SHA-chain verifiers. */
export function linkVerifiedRequestToPayout({ request, issue, sidecars, deliveries, archive }) {
  if (!request || !issue || !archive) fail('evidence_missing')
  if (!Array.isArray(sidecars) || sidecars.length === 0)
    return { study: STUDY, status: 'sidecar_missing', issueSequence: issue.sequence }
  if (sidecars.length !== 1) fail('sidecar_ambiguous')
  const sidecar = sidecars[0]
  const matching = deliveries?.filter((row) => row.issueSequence === issue.sequence) ?? []
  if (matching.length !== 1) fail('delivery_missing_or_ambiguous')
  const delivery = matching[0]
  const selected = issue.screened?.filter((row) => row.status === 'selected') ?? []
  if (selected.length !== 1) fail('request_selection_ambiguous')
  const discovery = selected[0]
  const selectedLog = request.selectedLog
  const requestBlock = hex(selectedLog?.blockNumber)
  const payoutBlock = hex(delivery.origins?.[0]?.block?.number)
  const requestAtMs = Number(hex(request.origins?.[0]?.selectedHeader?.timestamp)) * 1000
  const anchorAtMs = utc(issue.anchor?.blockAtUtc)
  const cooldownEndMs = utc(issue.cooldownEndUtc)
  const payoutAtMs = utc(delivery.deliveredAtUtc)
  const requestAssets = hex(`0x${selectedLog.data.slice(2, 66)}`).toString()
  const requestShares = hex(`0x${selectedLog.data.slice(66, 130)}`).toString()
  const final = archive.rows?.at(-1)
  const transfer =
    delivery.origins?.[0]?.receipt?.logs?.filter(
      (row) =>
        row.address === USDE &&
        row.topics?.[0] === TRANSFER &&
        row.topics?.[1] === topic(SILO) &&
        row.topics?.[2] === topic(issue.holder),
    ) ?? []

  if (
    !Number.isInteger(issue.sequence) ||
    issue.sequence < 1 ||
    request.issueSequence !== issue.sequence ||
    sidecar.issueSequence !== issue.sequence ||
    delivery.issueSequence !== issue.sequence ||
    request.issueSha256 !== issue.sha256 ||
    sidecar.issueSha256 !== issue.sha256 ||
    delivery.issueSha256 !== issue.sha256 ||
    request.holder !== issue.holder ||
    sidecar.holder !== issue.holder ||
    delivery.holder !== issue.holder ||
    request.anchorHash !== issue.anchor.blockHash ||
    discovery.discoveryBlock !== requestBlock.toString() ||
    discovery.discoveryTransactionHash !== selectedLog.transactionHash ||
    discovery.discoveryLogIndex !== hex(selectedLog.logIndex).toString() ||
    discovery.receiptProof?.discoveryLog?.data !== selectedLog.data ||
    discovery.receiptProof?.discoveryLog?.blockHash !== selectedLog.blockHash ||
    discovery.receiptProof?.receiptLog?.data !== selectedLog.data ||
    request.origins[0].transaction.hash !== selectedLog.transactionHash ||
    request.origins[0].receipt.transactionHash !== selectedLog.transactionHash ||
    requestAssets !== issue.pendingAssetsRaw ||
    delivery.frozenPendingAssetsRaw !== issue.pendingAssetsRaw ||
    transfer.length !== 1 ||
    hex(transfer[0].data).toString() !== issue.pendingAssetsRaw ||
    sidecar.deliverySha256 !== delivery.sha256 ||
    sidecar.transactionHash !== delivery.transactionHash ||
    delivery.origins[0].tx.hash !== sidecar.transactionHash ||
    request.selectedLog.transactionHash === sidecar.transactionHash ||
    archive.summary?.complete !== true ||
    archive.summary?.preDeliveryWithdrawLogs !== 0 ||
    archive.summary.issueSha256 !== issue.sha256 ||
    archive.summary.deliverySha256 !== delivery.sha256 ||
    !final ||
    sidecar.archiveFinalSha256 !== final.sha256 ||
    sidecar.archiveWindows !== archive.rows.length ||
    sidecar.sameEpisodeEvidenceLevel !== 'two_origin_rpc_log_attested' ||
    sidecar.cryptographicAbsenceProven !== false ||
    sidecar.forecastValidated !== false ||
    request.twoOriginObservedLogAgreement !== true ||
    request.headerChainContinuityProven !== false ||
    request.cooldownAtExecutionProven !== false ||
    request.cryptographicAbsenceProven !== false ||
    request.sameEpisodePayoutProven !== false
  )
    fail('binding_invalid')
  if (
    !Number.isSafeInteger(requestAtMs) ||
    requestAtMs >= anchorAtMs ||
    requestBlock >= BigInt(issue.anchor.blockNumber) ||
    payoutBlock <= BigInt(issue.anchor.blockNumber) ||
    requestAtMs >= cooldownEndMs ||
    cooldownEndMs > payoutAtMs ||
    anchorAtMs >= payoutAtMs ||
    sidecar.observedPendingToPayoutSeconds !== Math.floor((payoutAtMs - anchorAtMs) / 1000)
  )
    fail('chronology_invalid')
  const observedRequestToPayoutSeconds = Math.floor((payoutAtMs - requestAtMs) / 1000)
  if (!Number.isSafeInteger(observedRequestToPayoutSeconds) || observedRequestToPayoutSeconds < 0)
    fail('duration_invalid')
  let localEvidenceAvailableAtMs = Math.max(
    utc(issue.issuedAtUtc),
    utc(request.capturedAtUtc),
    utc(delivery.witnessedAtUtc),
    utc(sidecar.attestedAtUtc),
  )
  for (const row of archive.rows)
    localEvidenceAvailableAtMs = Math.max(localEvidenceAvailableAtMs, utc(row.capturedAtUtc))
  return {
    study: STUDY,
    status: 'linked_observed_episode',
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    requestProofSha256: request.sha256,
    sidecarSha256: sidecar.sha256,
    deliverySha256: delivery.sha256,
    archiveFinalSha256: final.sha256,
    holder: issue.holder,
    rawAssets: issue.pendingAssetsRaw,
    requestSharesRaw: requestShares,
    requestTransactionHash: selectedLog.transactionHash,
    requestLogIndex: hex(selectedLog.logIndex).toString(),
    payoutTransactionHash: delivery.transactionHash,
    requestAtUtc: new Date(requestAtMs).toISOString(),
    cooldownEndUtc: issue.cooldownEndUtc,
    payoutAtUtc: delivery.deliveredAtUtc,
    localEvidenceAvailableAtUtc: new Date(localEvidenceAvailableAtMs).toISOString(),
    localEvidenceAvailabilityClock: 'unwitnessed_local_wall_clock',
    observedRequestToPayoutSeconds,
    observedPendingToPayoutSeconds: sidecar.observedPendingToPayoutSeconds,
    cryptographicAbsenceProven: false,
    headerChainContinuityProven: false,
    implementationIdentityVerified: false,
    forecastValidated: false,
    futureDurationClaim: false,
  }
}

/** No RPC calls and no writes. Missing sidecar remains an explicit status. */
export async function readVerifiedRequestToPayout({
  issueSequence = 3,
  requestOut = issueSequence === 3
    ? REQUEST_OUT
    : issuePath('susde-public-preanchor-request', issueSequence),
  sidecarOut = issueSequence === 3
    ? SIDECAR_OUT
    : resolve(`data/research/venue-signals/susde-public-pending-payout-v2-issue-${issueSequence}`),
  issueOut = ISSUE_OUT,
  deliveryOut = DELIVERY_OUT,
  archiveOut = issueSequence === 3
    ? ARCHIVE_OUT
    : issuePath('susde-public-pending-continuity', issueSequence),
  loadRequest = verifyPreanchor,
  loadArchive = verifyContinuityArchive,
  loadSidecars = verifyEpisodes,
  loadDeliveries = verifyDeliveries,
} = {}) {
  const [{ issue, rows: requests }, archive, deliveries] = await Promise.all([
    loadRequest(requestOut, issueOut, undefined, issueSequence),
    loadArchive(archiveOut, issueOut, deliveryOut, undefined, issueSequence),
    loadDeliveries(deliveryOut, issueOut),
  ])
  if (requests.length !== 1) fail('request_missing_or_ambiguous')
  const sidecars = await loadSidecars(
    sidecarOut,
    issueOut,
    deliveryOut,
    archiveOut,
    async () => archive,
    issueSequence,
  )
  return linkVerifiedRequestToPayout({ request: requests[0], issue, sidecars, deliveries, archive })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--verify')
    throw Error(
      'usage: node scripts/research/susde-public-request-to-payout-episode.mjs --verify [issueSequence]',
    )
  const issueSequence = process.argv[3] === undefined ? 3 : Number(process.argv[3])
  if (!Number.isInteger(issueSequence) || issueSequence < 1)
    throw Error('request_payout_issue_unknown')
  console.log(JSON.stringify(await readVerifiedRequestToPayout({ issueSequence })))
}
