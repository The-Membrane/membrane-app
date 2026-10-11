// A verified historical payout supplies only an address shortlist. A fresh,
// two-origin pinned share and claim read establishes current holder eligibility.
import { createHash } from 'node:crypto'

import { freezeMorphoQLadder } from './carry-exit-v2-morpho-issuer-prep.mjs'
import { resolveCarryExitV2Route } from './carry-exit-v2-rpc-proof.mjs'
import { readPinned } from './carry-exit-v2-morpho-api-candidate.mjs'
import {
  LOCAL_MORPHO_ROOT,
  verifyLocalMorphoEnrollment,
  verifyLocalMorphoVault,
} from './localMorphoV2FlowStore.mjs'
import { loadMorphoFlowSubjects } from '../record-carry-morpho-v2-flows.mjs'
import {
  candidateTransactions,
  readLocalPayoutRecord,
  runLocalPayout,
} from '../reconcile-carry-morpho-v2-withdrawals-local.mjs'

export const LOCAL_PAYOUT_SCHEMA = 'carry_exit_v2_morpho_local_payout_candidate_v1'
const ADDRESS = /^0x[0-9a-f]{40}$/
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const LIMIT = 8
const sha = (value) => createHash('sha256').update(value).digest('hex')
const host = (url) =>
  new URL(url).hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
const commitment = (vault, owner) => sha(`${vault}:${owner}`)
const fail = () => {
  throw Error('morpho_local_payout_candidate_invalid')
}

export function rankVerifiedPayoutOwners(candidates, recordFor, limit = LIMIT) {
  if (!Array.isArray(candidates) || typeof recordFor !== 'function' || limit !== LIMIT) fail()
  const rows = []
  for (const candidate of candidates) {
    const record = recordFor(candidate)
    if (!record) fail()
    if (record.outcome.status !== 'receipt_reconciled') continue
    for (const row of candidate.rows) {
      if (row.flow_class !== 'external_receiver_unreconciled') continue
      if (!ADDRESS.test(row.owner) || !SHA.test(record.sha256)) fail()
      rows.push({ owner: row.owner, receiptSha256: record.sha256, block: BigInt(row.block) })
    }
  }
  rows.sort((a, b) =>
    a.block === b.block ? a.owner.localeCompare(b.owner) : a.block > b.block ? -1 : 1,
  )
  const seen = new Set()
  return rows
    .filter((row) => {
      if (seen.has(row.owner)) return false
      seen.add(row.owner)
      return true
    })
    .slice(0, LIMIT)
    .map(({ owner, receiptSha256 }) => ({ owner, receiptSha256 }))
}

export async function readVerifiedPayoutOwnerShortlist(baseline) {
  const subjects = await loadMorphoFlowSubjects()
  const subject = subjects.find(
    (row) => row.vault === baseline.destination && row.asset === baseline.asset,
  )
  if (!subject || subjects.filter((row) => row.vault === subject.vault).length !== 1) fail()
  // Verifies every sealed candidate receipt and rejects orphan proof files.
  const audit = await runLocalPayout(['--verify'], { includeBySubject: true })
  if (audit.remainingTransactions !== 0 || audit.bySubject.length !== subjects.length) fail()
  const enrollment = verifyLocalMorphoEnrollment(subjects, LOCAL_MORPHO_ROOT)
  const candidates = candidateTransactions(
    subject,
    verifyLocalMorphoVault(subject, enrollment, LOCAL_MORPHO_ROOT),
  )
  return rankVerifiedPayoutOwners(candidates, readLocalPayoutRecord)
}

export function verifyPayoutSourceRows(doc, candidates, recordFor) {
  if (!Array.isArray(candidates) || typeof recordFor !== 'function') fail()
  const found = new Set()
  for (const candidate of candidates) {
    const record = recordFor(candidate)
    // New archive candidates may still be awaiting receipts. Only an issue's
    // referenced sources must already have reconciled proof.
    if (!record) continue
    if (record.outcome.status !== 'receipt_reconciled') continue
    if (BigInt(candidate.block) > BigInt(doc.baselineBlock)) continue
    for (const row of candidate.rows) {
      if (row.flow_class !== 'external_receiver_unreconciled') continue
      found.add(`${commitment(doc.destination, row.owner)}:${record.sha256}`)
    }
  }
  if (
    doc.discovery.sourceRows.some(
      (row) => !found.has(`${row.holderCommitment}:${row.receiptSha256}`),
    )
  )
    fail()
  return true
}

export async function verifyLocalPayoutIssueSources(issues) {
  const local = issues.filter(
    (issue) => issue.candidate?.evidenceDoc?.schema === LOCAL_PAYOUT_SCHEMA,
  )
  if (!local.length) return true
  const subjects = await loadMorphoFlowSubjects()
  // Verify all sealed receipts and reject orphan files, while allowing later
  // append-only flow candidates to remain pending.
  await runLocalPayout(['--verify'])
  const enrollment = verifyLocalMorphoEnrollment(subjects, LOCAL_MORPHO_ROOT)
  const candidatesByVault = new Map()
  for (const issue of local) {
    if (!candidatesByVault.has(issue.destination)) {
      const subject = subjects.find(
        (row) => row.vault === issue.destination && row.asset === issue.asset,
      )
      if (!subject || subjects.filter((row) => row.vault === subject.vault).length !== 1) fail()
      candidatesByVault.set(
        issue.destination,
        candidateTransactions(
          subject,
          verifyLocalMorphoVault(subject, enrollment, LOCAL_MORPHO_ROOT),
        ),
      )
    }
    verifyPayoutSourceRows(
      issue.candidate.evidenceDoc,
      candidatesByVault.get(issue.destination),
      readLocalPayoutRecord,
    )
  }
  return true
}

export async function discoverMorphoLocalPayoutCandidate({
  baseline,
  primary,
  secondary,
  readShortlist = readVerifiedPayoutOwnerShortlist,
  pinnedRead = readPinned,
}) {
  const route = resolveCarryExitV2Route(baseline?.routeKey, baseline?.destination, baseline?.asset)
  if (
    route.kind !== 'morpho' ||
    baseline.canonicalityEvidenceDoc?.schema !== 'carry_exit_v2_headers_v1' ||
    baseline.canonicalityEvidenceDoc.targetHeader?.hash !== baseline.targetHash ||
    baseline.canonicalityEvidenceDoc.targetHeader?.number !== baseline.targetBlock ||
    !HASH.test(baseline.targetHash ?? '') ||
    !DECIMAL.test(baseline.totalAssetsRaw ?? '') ||
    typeof primary?.request !== 'function' ||
    typeof secondary?.request !== 'function' ||
    host(primary.provider) === host(secondary.provider)
  )
    fail()
  const shortlist = await readShortlist(baseline)
  if (
    !Array.isArray(shortlist) ||
    shortlist.length > LIMIT ||
    shortlist.some((row) => !ADDRESS.test(row.owner) || !SHA.test(row.receiptSha256)) ||
    new Set(shortlist.map((row) => row.owner)).size !== shortlist.length
  )
    fail()
  const hostCommitments = [sha(host(primary.provider)), sha(host(secondary.provider))]
  const sourceRows = shortlist.map((row) => ({
    holderCommitment: commitment(baseline.destination, row.owner),
    receiptSha256: row.receiptSha256,
  }))
  const screenedCandidates = []
  let selected = null
  for (const [rank, item] of shortlist.entries()) {
    const row = { ...sourceRows[rank], payoutRank: rank, status: 'rpc_unavailable' }
    screenedCandidates.push(row)
    try {
      const first = await pinnedRead(primary.request.bind(primary), baseline, item.owner)
      const second = await pinnedRead(secondary.request.bind(secondary), baseline, item.owner)
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        row.status = 'rpc_disagreement'
        continue
      }
      row.status = first.status
      row.pinnedProof = {
        block: baseline.targetBlock,
        hash: baseline.targetHash,
        parentHash: baseline.targetParentHash,
        hostCommitments,
        holderCommitment: row.holderCommitment,
        first,
        second,
      }
      row.pinnedProofSha256 = sha(JSON.stringify(row.pinnedProof))
      if (first.status !== 'eligible_holder') continue
      row.sharesRaw = first.sharesRaw
      row.claimRaw = first.claimRaw
      if (!selected || BigInt(first.claimRaw) > BigInt(selected.claimRaw))
        selected = { holder: item.owner, holderCommitment: row.holderCommitment, ...first }
    } catch {
      row.status = 'rpc_unavailable'
      delete row.pinnedProof
      delete row.pinnedProofSha256
      delete row.sharesRaw
      delete row.claimRaw
    }
  }
  const evidenceDoc = {
    schema: LOCAL_PAYOUT_SCHEMA,
    chainId: '1',
    routeKey: baseline.routeKey,
    destination: baseline.destination,
    asset: baseline.asset,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    parentHash: baseline.targetParentHash,
    baselineState: {
      totalAssetsRaw: baseline.totalAssetsRaw,
      assetDecimals: baseline.assetDecimals,
    },
    discovery: {
      source: 'verified_local_morpho_payout_archive',
      scope: 'non_exhaustive_recent_paid_owner_shortlist',
      candidateLimit: LIMIT,
      exhaustiveHolderSearch: false,
      historicalHolderProof: false,
      sourceRows,
      sourceRowsSha256: sha(JSON.stringify(sourceRows)),
      attempted: screenedCandidates.length,
    },
    screenedCandidates,
    selectionRule: 'largest_two_host_pinned_claim_among_recent_paid_eoas_tie_by_payout_rank',
    selectedHolderCommitment: selected?.holderCommitment ?? null,
    selectedSharesRaw: selected?.sharesRaw ?? null,
    selectedClaimRaw: selected?.claimRaw ?? null,
    unavailableReason: selected ? null : 'no_two_host_verified_payout_owner',
    ladder: freezeMorphoQLadder({
      totalAssetsRaw: baseline.totalAssetsRaw,
      selectedClaimRaw: selected?.claimRaw ?? null,
    }),
  }
  return { holder: selected?.holder ?? null, evidenceDoc, digest: sha(JSON.stringify(evidenceDoc)) }
}

export function validateMorphoLocalPayoutCandidateEvidence(doc, hostCommitments) {
  const discovery = doc?.discovery
  const sources = discovery?.sourceRows
  if (
    doc?.schema !== LOCAL_PAYOUT_SCHEMA ||
    doc.chainId !== '1' ||
    discovery?.source !== 'verified_local_morpho_payout_archive' ||
    discovery.scope !== 'non_exhaustive_recent_paid_owner_shortlist' ||
    discovery.candidateLimit !== LIMIT ||
    discovery.exhaustiveHolderSearch !== false ||
    discovery.historicalHolderProof !== false ||
    !Array.isArray(sources) ||
    sources.length > LIMIT ||
    sources.some((row) => !SHA.test(row.holderCommitment) || !SHA.test(row.receiptSha256)) ||
    new Set(sources.map((row) => row.holderCommitment)).size !== sources.length ||
    sha(JSON.stringify(sources)) !== discovery.sourceRowsSha256 ||
    !Array.isArray(doc.screenedCandidates) ||
    doc.screenedCandidates.length !== sources.length ||
    discovery.attempted !== sources.length ||
    !Array.isArray(hostCommitments) ||
    hostCommitments.length !== 2 ||
    hostCommitments[0] === hostCommitments[1] ||
    doc.selectionRule !== 'largest_two_host_pinned_claim_among_recent_paid_eoas_tie_by_payout_rank'
  )
    fail()
  let selected = null
  for (const [rank, row] of doc.screenedCandidates.entries()) {
    const source = sources[rank]
    if (
      row.payoutRank !== rank ||
      row.holderCommitment !== source.holderCommitment ||
      row.receiptSha256 !== source.receiptSha256 ||
      ![
        'rpc_unavailable',
        'rpc_disagreement',
        'contract_holder',
        'no_pinned_shares',
        'no_pinned_claim',
        'eligible_holder',
      ].includes(row.status)
    )
      fail()
    if (row.status === 'rpc_unavailable' || row.status === 'rpc_disagreement') {
      if (
        row.pinnedProof !== undefined ||
        row.pinnedProofSha256 !== undefined ||
        row.sharesRaw !== undefined ||
        row.claimRaw !== undefined
      )
        fail()
      continue
    }
    const proof = row.pinnedProof
    if (
      !proof ||
      proof.block !== doc.baselineBlock ||
      proof.hash !== doc.baselineHash ||
      proof.parentHash !== doc.parentHash ||
      proof.holderCommitment !== row.holderCommitment ||
      JSON.stringify(proof.hostCommitments) !== JSON.stringify(hostCommitments) ||
      JSON.stringify(proof.first) !== JSON.stringify(proof.second) ||
      proof.first?.status !== row.status ||
      row.pinnedProofSha256 !== sha(JSON.stringify(proof))
    )
      fail()
    if (row.status === 'eligible_holder') {
      if (
        !DECIMAL.test(row.sharesRaw ?? '') ||
        !DECIMAL.test(row.claimRaw ?? '') ||
        row.sharesRaw !== proof.first.sharesRaw ||
        row.claimRaw !== proof.first.claimRaw ||
        BigInt(row.sharesRaw) === 0n ||
        BigInt(row.claimRaw) === 0n
      )
        fail()
      if (!selected || BigInt(row.claimRaw) > BigInt(selected.claimRaw)) selected = row
    } else if (row.sharesRaw !== undefined || row.claimRaw !== undefined) fail()
  }
  if (
    doc.selectedHolderCommitment !== (selected?.holderCommitment ?? null) ||
    doc.selectedSharesRaw !== (selected?.sharesRaw ?? null) ||
    doc.selectedClaimRaw !== (selected?.claimRaw ?? null) ||
    doc.unavailableReason !== (selected ? null : 'no_two_host_verified_payout_owner') ||
    JSON.stringify(doc.ladder) !==
      JSON.stringify(
        freezeMorphoQLadder({
          totalAssetsRaw: doc.baselineState?.totalAssetsRaw,
          selectedClaimRaw: selected?.claimRaw ?? null,
        }),
      )
  )
    fail()
  return doc
}
