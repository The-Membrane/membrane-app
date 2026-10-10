// Prospective common-Q Aave USDC arm. V1 receipts nominate a bounded public EOA set.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

import { toEventSelector, toFunctionSelector } from 'viem'

import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { assembleCarryExitV2CallEvidence } from '../lib/carry-exit-v2-proof-assembly.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  DIRECT_MARKETS,
  OUT as V1_OUT,
  configuredPublicRpcUrls,
  publicRpcClients,
  verifyPublicDirectIssues,
} from './carry-public-direct-exit-issue.mjs'
import {
  HASH,
  MAX_RECORD_BYTES,
  appendNumbered,
  readNumbered,
  same,
  sha,
  utc,
} from './carry-public-sgho-exit-common.mjs'

export const STUDY = 'carry_public_aave_usdc_common_q_issue_v3'
export const ATTEMPT_STUDY = 'carry_public_aave_usdc_common_q_attempt_v3'
export const OUT = resolve('data/research/venue-signals/carry-public-aave-usdc-common-q-v3-issues')
export const ATTEMPT_OUT = resolve(
  'data/research/venue-signals/carry-public-aave-usdc-common-q-v3-attempts',
)
export const Q = Object.freeze([
  { label: 'fixed_1_usdc', assetsRaw: '1000000' },
  { label: 'fixed_1000_usdc', assetsRaw: '1000000000' },
  { label: 'fixed_100000_usdc', assetsRaw: '100000000000' },
])
const ROUTE = DIRECT_MARKETS.aaveV3Usdc
const TRANSFER = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const BALANCE = toFunctionSelector('balanceOf(address)')
const ADDRESS = /^0x[0-9a-f]{40}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const MAX_BASELINE_AGE_MS = 45 * 60_000
const MAX_RECEIPT_BYTES = 64 * 1024
const MAX_RECEIPT_LOGS = 128
const tag = (hash) => ({ blockHash: hash, requireCanonical: true })

export function packAaveCommonReceipt(receipt) {
  const raw = Buffer.from(JSON.stringify(receipt))
  if (
    !Array.isArray(receipt?.logs) ||
    receipt.logs.length > MAX_RECEIPT_LOGS ||
    raw.length > MAX_RECEIPT_BYTES
  )
    throw Error('aave_common_receipt_too_large')
  return {
    encoding: 'deflate-raw-base64',
    rawBytes: raw.length,
    rawSha256: sha(raw),
    payload: deflateRawSync(raw, { level: 6 }).toString('base64'),
  }
}

export function unpackAaveCommonReceipt(packed) {
  if (
    packed?.encoding !== 'deflate-raw-base64' ||
    !Number.isSafeInteger(packed.rawBytes) ||
    packed.rawBytes < 1 ||
    packed.rawBytes > MAX_RECEIPT_BYTES ||
    !HASH.test(packed.rawSha256 ?? '') ||
    typeof packed.payload !== 'string' ||
    packed.payload.length > 90_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packed.payload)
  )
    throw Error('aave_common_packed_receipt_invalid')
  let raw
  try {
    raw = inflateRawSync(Buffer.from(packed.payload, 'base64'), {
      maxOutputLength: MAX_RECEIPT_BYTES,
    })
  } catch {
    throw Error('aave_common_packed_receipt_invalid')
  }
  if (raw.length !== packed.rawBytes || sha(raw) !== packed.rawSha256)
    throw Error('aave_common_packed_receipt_invalid')
  const receipt = JSON.parse(raw.toString('utf8'))
  if (JSON.stringify(receipt) !== raw.toString('utf8'))
    throw Error('aave_common_packed_receipt_invalid')
  packAaveCommonReceipt(receipt)
  return receipt
}

export function eligibleAaveCommonParent(parent, atUtc) {
  if (
    parent?.marketKey !== 'aaveV3Usdc' ||
    parent.candidate?.evidenceDoc?.schema !== 'carry_exit_v2_direct_candidate_v1'
  )
    return false
  const now = utc(atUtc)
  return (
    now >= utc(parent.issuedAtUtc) &&
    now < utc(parent.targets[0].targetAtUtc) &&
    now - utc(parent.baseline.targetBlockAt) <= MAX_BASELINE_AGE_MS &&
    parent.candidate.evidenceDoc.screenedCandidates?.some(
      (row) => row.status === 'eligible_holder',
    ) === true
  )
}

function normalizedReceiptLog(receipt, screened, parent) {
  if (
    !Array.isArray(receipt?.logs) ||
    receipt.logs.length > MAX_RECEIPT_LOGS ||
    Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES
  )
    throw Error('aave_common_receipt_too_large')
  if (
    receipt?.status !== '0x1' ||
    receipt.transactionHash !== screened.discoveryTransactionHash ||
    receipt.blockNumber !== `0x${BigInt(screened.discoveryBlock).toString(16)}` ||
    !BLOCK_HASH.test(receipt.blockHash ?? '') ||
    BigInt(screened.discoveryBlock) >= BigInt(parent.baseline.targetBlock)
  )
    throw Error('aave_common_receipt_invalid')
  const hits =
    receipt.logs?.filter(
      (log) => BigInt(log.logIndex ?? -1) === BigInt(screened.discoveryLogIndex),
    ) ?? []
  const log = hits[0]
  if (
    hits.length !== 1 ||
    log.removed === true ||
    log.address?.toLowerCase() !== ROUTE.destination ||
    log.transactionHash !== receipt.transactionHash ||
    log.blockHash !== receipt.blockHash ||
    log.blockNumber !== receipt.blockNumber ||
    log.topics?.length !== 3 ||
    log.topics[0]?.toLowerCase() !== TRANSFER ||
    !/^0x[0-9a-f]{64}$/.test(log.topics[2] ?? '') ||
    !/^0x[0-9a-f]{64}$/.test(log.data ?? '') ||
    BigInt(log.data).toString() !== screened.observedIncomingAssetsRaw
  )
    throw Error('aave_common_receipt_log_invalid')
  const owner = `0x${log.topics[2].slice(-40).toLowerCase()}`
  if (
    !ADDRESS.test(owner) ||
    owner === `0x${'0'.repeat(40)}` ||
    sha(`${ROUTE.destination}:${owner}`) !== screened.holderCommitment
  )
    throw Error('aave_common_commitment_invalid')
  return {
    owner,
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: screened.discoveryBlock,
    logIndex: screened.discoveryLogIndex,
    topics: log.topics.map((x) => x.toLowerCase()),
    data: log.data.toLowerCase(),
  }
}

export function recoverAaveCommonOwner(screened, receipt, parent) {
  if (
    screened?.status !== 'eligible_holder' ||
    !HASH.test(screened.receiptDigest ?? '') ||
    sha(
      JSON.stringify({
        transactionHash: receipt?.transactionHash,
        blockHash: receipt?.blockHash,
        status: receipt?.status,
        logs: receipt?.logs,
      }),
    ) !== screened.receiptDigest
  )
    throw Error('aave_common_receipt_digest_invalid')
  return normalizedReceiptLog(receipt, screened, parent)
}

async function candidateOnOrigin(screened, parent, client, requireOriginalDigest) {
  const request = client.request.bind(client)
  const receipt = await request('eth_getTransactionReceipt', [screened.discoveryTransactionHash])
  const log = requireOriginalDigest
    ? recoverAaveCommonOwner(screened, receipt, parent)
    : normalizedReceiptLog(receipt, screened, parent)
  const block = await request('eth_getBlockByNumber', [
    `0x${BigInt(screened.discoveryBlock).toString(16)}`,
    false,
  ])
  const baseline = await request('eth_getBlockByNumber', [
    `0x${BigInt(parent.baseline.targetBlock).toString(16)}`,
    false,
  ])
  const finalized = await request('eth_getBlockByNumber', ['finalized', false])
  if (
    block?.hash !== log.blockHash ||
    BigInt(block?.number ?? -1) !== BigInt(screened.discoveryBlock) ||
    baseline?.hash !== parent.baseline.targetHash ||
    BigInt(baseline?.number ?? -1) !== BigInt(parent.baseline.targetBlock) ||
    baseline?.parentHash !== parent.baseline.targetParentHash ||
    BigInt(finalized?.number ?? -1) < BigInt(parent.baseline.targetBlock) ||
    (BigInt(finalized.number) === BigInt(parent.baseline.targetBlock) &&
      finalized.hash !== parent.baseline.targetHash)
  )
    throw Error('aave_common_header_invalid')
  const code = await request('eth_getCode', [log.owner, tag(parent.baseline.targetHash)])
  const balance = await request('eth_call', [
    { to: ROUTE.destination, data: `${BALANCE}${log.owner.slice(2).padStart(64, '0')}` },
    tag(parent.baseline.targetHash),
  ])
  if (
    code !== '0x' ||
    !/^0x[0-9a-f]{64}$/.test(balance ?? '') ||
    BigInt(balance).toString() !== screened.assetBalanceRaw ||
    BigInt(balance) < 1n
  )
    throw Error('aave_common_coverage_invalid')
  return {
    provider: client.provider,
    log,
    packedReceipt: packAaveCommonReceipt(receipt),
    headers: {
      discovery: { number: block.number, hash: block.hash },
      baseline: { number: baseline.number, hash: baseline.hash, parentHash: baseline.parentHash },
      finalized: { number: finalized.number, hash: finalized.hash },
    },
    code,
    balanceWord: balance,
    balanceRaw: BigInt(balance).toString(),
    receiptDigest: sha(
      JSON.stringify({
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        status: receipt.status,
        logs: receipt.logs,
      }),
    ),
  }
}

export async function recoverAaveCommonCandidates(parent, pair, atUtc = new Date().toISOString()) {
  if (
    !eligibleAaveCommonParent(parent, atUtc) ||
    pair?.length !== 2 ||
    pair[0].provider !== parent.baseline.canonicalityEvidenceDoc.provider ||
    pair[1].provider !== parent.baselineWitness.provider
  )
    throw Error('aave_common_origin_or_parent_invalid')
  const screened = parent.candidate.evidenceDoc.screenedCandidates
  if (!Array.isArray(screened) || screened.length > 8) throw Error('aave_common_candidate_bound')
  const candidates = []
  for (const [screenedIndex, row] of screened.entries()) {
    if (row.status !== 'eligible_holder') continue
    // A failed attestation is retryable. Never silently remove a ranked EOA.
    const [primary, secondary] = await Promise.all([
      candidateOnOrigin(row, parent, pair[0], true),
      candidateOnOrigin(row, parent, pair[1], false),
    ])
    if (!same(primary.log, secondary.log) || primary.balanceRaw !== secondary.balanceRaw)
      throw Error('aave_common_origin_disagreement')
    candidates.push({
      screenedIndex,
      holder: primary.log.owner,
      holderCommitment: row.holderCommitment,
      assetBalanceRaw: primary.balanceRaw,
      source: { primary, secondary },
    })
  }
  if (!candidates.length) throw Error('aave_common_no_verified_candidates')
  return candidates
}

export function aaveCommonCandidateCensus(parent) {
  const screened = parent.candidate.evidenceDoc.screenedCandidates
  if (!Array.isArray(screened) || screened.length > 8) throw Error('aave_common_candidate_bound')
  const census = screened.flatMap((row, screenedIndex) =>
    row.status === 'eligible_holder'
      ? [{ screenedIndex, holderCommitment: row.holderCommitment }]
      : [],
  )
  if (!census.length) throw Error('aave_common_no_screened_candidates')
  return census
}

export async function recoverAaveCommonSelectedCandidate(
  parent,
  pair,
  selected,
  atUtc = new Date().toISOString(),
) {
  if (
    !eligibleAaveCommonParent(parent, atUtc) ||
    pair?.length !== 2 ||
    pair[0].provider !== parent.baseline.canonicalityEvidenceDoc.provider ||
    pair[1].provider !== parent.baselineWitness.provider
  )
    throw Error('aave_common_origin_or_parent_invalid')
  const row = parent.candidate.evidenceDoc.screenedCandidates[selected?.screenedIndex]
  if (row?.status !== 'eligible_holder' || row.holderCommitment !== selected.holderCommitment)
    throw Error('aave_common_selected_commitment_invalid')
  const [primary, secondary] = await Promise.all([
    candidateOnOrigin(row, parent, pair[0], true),
    candidateOnOrigin(row, parent, pair[1], false),
  ])
  if (!same(primary.log, secondary.log) || primary.balanceRaw !== secondary.balanceRaw)
    throw Error('aave_common_origin_disagreement')
  return {
    screenedIndex: selected.screenedIndex,
    holder: primary.log.owner,
    holderCommitment: row.holderCommitment,
    assetBalanceRaw: primary.balanceRaw,
    source: { primary, secondary },
  }
}

export function selectAaveCommonCandidate(candidates, prior, slot) {
  if (!Array.isArray(candidates) || !candidates.length || !Number.isSafeInteger(slot) || slot < 0)
    throw Error('aave_common_selection_invalid')
  const counts = new Map()
  for (const row of prior) {
    const commitment =
      row.selectedHolderCommitment ??
      row.candidates?.find((candidate) => candidate.holder === row.holder)?.holderCommitment
    if (commitment) counts.set(commitment, (counts.get(commitment) ?? 0) + 1)
  }
  const offset = slot % candidates.length
  return [...candidates].sort(
    (a, b) =>
      (counts.get(a.holderCommitment) ?? 0) - (counts.get(b.holderCommitment) ?? 0) ||
      ((a.screenedIndex - offset + candidates.length) % candidates.length) -
        ((b.screenedIndex - offset + candidates.length) % candidates.length) ||
      a.holderCommitment.localeCompare(b.holderCommitment),
  )[0]
}

async function measureBaseline(parent, candidate, assetsRaw, pair) {
  const verified = await measureCarryExitV2Verified({
    ...ROUTE,
    holder: candidate.holder,
    assetsRaw,
    target: parent.baseline,
    provider: pair[0].provider,
    source: STUDY,
    send: pair[0].send,
    primary: { url: pair[0].url, request: pair[0].send },
    secondary: { url: pair[1].url, request: pair[1].send },
  })
  if (verified.status !== 'verified') throw Error('aave_common_baseline_unavailable')
  const evidence = verified.callEvidenceDoc
  const decoded = validateCarryExitV2RpcProof({
    proof: evidence,
    ...ROUTE,
    holder: candidate.holder,
    assetsRaw,
    blockNumber: parent.baseline.targetBlock,
    blockHash: parent.baseline.targetHash,
  })
  const baselineStatus = classifyAaveCommonBaseline(decoded, assetsRaw)
  return {
    baselineStatus,
    holderCoverageRaw: decoded.holderCoverageRaw,
    simulationStatus: decoded.simulationStatus,
    coveredRevert: decoded.coveredRevert,
    evidence,
    evidenceSha256: sha(JSON.stringify(evidence)),
  }
}

export function classifyAaveCommonBaseline(decoded, assetsRaw) {
  if (decoded?.routeKind !== 'aave') throw Error('aave_common_baseline_kind_invalid')
  if (decoded.simulationStatus === 'success') return 'success'
  if (decoded.simulationStatus !== 'evm_revert') throw Error('aave_common_baseline_status_invalid')
  if (BigInt(decoded.holderCoverageRaw) < BigInt(assetsRaw)) return 'holder_insufficient_coverage'
  return decoded.coveredRevert ? 'covered_revert' : 'inconclusive_covered_revert'
}

export async function planAaveCommonCases(candidate, parent, pair, measure = measureBaseline) {
  const cases = []
  for (const q of Q) {
    let measurement
    try {
      measurement = await measure(parent, candidate, q.assetsRaw, pair)
    } catch (cause) {
      if (cause?.message !== 'aave_common_baseline_unavailable') throw cause
      const error = Error('aave_common_baseline_assay_failed')
      error.caseLabel = q.label
      error.assetsRaw = q.assetsRaw
      throw error
    }
    const inconclusive = measurement.baselineStatus === 'inconclusive_covered_revert'
    const insufficient = measurement.baselineStatus === 'holder_insufficient_coverage'
    cases.push({
      ...q,
      status: insufficient ? 'unavailable' : inconclusive ? 'inconclusive' : 'measured',
      reason: insufficient
        ? 'holder_insufficient_coverage'
        : inconclusive
          ? 'covered_revert_cause_unknown'
          : null,
      measurement,
    })
  }
  return cases
}

export function validateAaveCommonIssue(issue, parents, prior) {
  const parent = parents[issue?.v1IssueSequence - 1]
  if (
    !parent ||
    issue.study !== STUDY ||
    issue.sequence !== prior.length + 1 ||
    issue.previousSha256 !== (prior.at(-1)?.sha256 ?? null) ||
    issue.v1IssueSha256 !== parent.sha256 ||
    !eligibleAaveCommonParent(parent, issue.issuedAtUtc) ||
    issue.marketKey !== 'aaveV3Usdc' ||
    issue.routeKey !== ROUTE.routeKey ||
    issue.destination !== ROUTE.destination ||
    issue.originalAsset !== ROUTE.asset ||
    !same(issue.targets, parent.targets) ||
    !Array.isArray(issue.candidates) ||
    issue.candidates.length < 1 ||
    issue.candidates.length > 8 ||
    issue.originPrimary !== parent.baseline.canonicalityEvidenceDoc.provider ||
    issue.originSecondary !== parent.baselineWitness.provider ||
    !same(issue.candidates, aaveCommonCandidateCensus(parent)) ||
    issue.selectedHolderCommitment !==
      selectAaveCommonCandidate(issue.candidates, prior, parent.slot).holderCommitment ||
    issue.selectedScreenedIndex !==
      selectAaveCommonCandidate(issue.candidates, prior, parent.slot).screenedIndex ||
    issue.holder !== issue.selectedCandidate?.holder ||
    issue.selectedCandidate?.screenedIndex !== issue.selectedScreenedIndex ||
    issue.selectedCandidate?.holderCommitment !== issue.selectedHolderCommitment ||
    !Array.isArray(issue.cases) ||
    issue.cases.length !== Q.length
  )
    throw Error('aave_common_issue_binding_invalid')
  const seen = new Set()
  for (const candidate of [issue.selectedCandidate]) {
    const screened = parent.candidate.evidenceDoc.screenedCandidates[candidate.screenedIndex]
    let primaryLog
    let secondaryLog
    let secondaryReceipt
    try {
      primaryLog = recoverAaveCommonOwner(
        screened,
        unpackAaveCommonReceipt(candidate.source.primary.packedReceipt),
        parent,
      )
      secondaryReceipt = unpackAaveCommonReceipt(candidate.source.secondary.packedReceipt)
      secondaryLog = normalizedReceiptLog(secondaryReceipt, screened, parent)
    } catch {
      throw Error('aave_common_candidate_receipt_invalid')
    }
    const headersValid = [candidate.source.primary, candidate.source.secondary].every(
      (source) =>
        BigInt(source.headers?.discovery?.number ?? -1) === BigInt(screened.discoveryBlock) &&
        source.headers.discovery.hash === source.log.blockHash &&
        BigInt(source.headers?.baseline?.number ?? -1) === BigInt(parent.baseline.targetBlock) &&
        source.headers.baseline.hash === parent.baseline.targetHash &&
        source.headers.baseline.parentHash === parent.baseline.targetParentHash &&
        BigInt(source.headers?.finalized?.number ?? -1) >= BigInt(parent.baseline.targetBlock) &&
        (BigInt(source.headers.finalized.number) !== BigInt(parent.baseline.targetBlock) ||
          source.headers.finalized.hash === parent.baseline.targetHash),
    )
    if (
      !screened ||
      screened.status !== 'eligible_holder' ||
      seen.has(candidate.screenedIndex) ||
      candidate.holderCommitment !== screened.holderCommitment ||
      candidate.assetBalanceRaw !== screened.assetBalanceRaw ||
      sha(`${ROUTE.destination}:${candidate.holder}`) !== screened.holderCommitment ||
      candidate.source?.primary?.provider !== issue.originPrimary ||
      candidate.source?.secondary?.provider !== issue.originSecondary ||
      !same(candidate.source.primary.log, candidate.source.secondary.log) ||
      !same(primaryLog, candidate.source.primary.log) ||
      !same(secondaryLog, candidate.source.secondary.log) ||
      !headersValid ||
      candidate.source.primary.receiptDigest !== screened.receiptDigest ||
      candidate.source.primary.code !== '0x' ||
      candidate.source.secondary.code !== '0x' ||
      !/^0x[0-9a-f]{64}$/.test(candidate.source.primary.balanceWord ?? '') ||
      !/^0x[0-9a-f]{64}$/.test(candidate.source.secondary.balanceWord ?? '') ||
      BigInt(candidate.source.primary.balanceWord).toString() !== screened.assetBalanceRaw ||
      BigInt(candidate.source.secondary.balanceWord).toString() !== screened.assetBalanceRaw ||
      candidate.source.primary.balanceRaw !== screened.assetBalanceRaw ||
      candidate.source.secondary.balanceRaw !== screened.assetBalanceRaw ||
      candidate.source.secondary.receiptDigest !==
        sha(
          JSON.stringify({
            transactionHash: secondaryReceipt.transactionHash,
            blockHash: secondaryReceipt.blockHash,
            status: secondaryReceipt.status,
            logs: secondaryReceipt.logs,
          }),
        ) ||
      candidate.source.primary.log.owner !== candidate.holder ||
      candidate.source.primary.log.transactionHash !== screened.discoveryTransactionHash ||
      candidate.source.primary.log.logIndex !== screened.discoveryLogIndex ||
      candidate.source.primary.log.blockNumber !== screened.discoveryBlock ||
      BigInt(candidate.source.primary.log.data ?? 0).toString() !==
        screened.observedIncomingAssetsRaw
    )
      throw Error('aave_common_candidate_invalid')
    seen.add(candidate.screenedIndex)
  }
  if (seen.size !== 1) throw Error('aave_common_candidate_missing')
  for (const [index, entry] of issue.cases.entries()) {
    const q = Q[index]
    if (entry.label !== q.label || entry.assetsRaw !== q.assetsRaw)
      throw Error('aave_common_q_invalid')
    if (['measured', 'inconclusive', 'unavailable'].includes(entry.status)) {
      const m = entry.measurement
      if (
        !m ||
        ![
          'success',
          'covered_revert',
          'inconclusive_covered_revert',
          'holder_insufficient_coverage',
        ].includes(m.baselineStatus) ||
        (entry.status === 'inconclusive') !==
          (m.baselineStatus === 'inconclusive_covered_revert') ||
        (entry.status === 'unavailable') !==
          (m.baselineStatus === 'holder_insufficient_coverage') ||
        entry.reason !==
          (entry.status === 'inconclusive'
            ? 'covered_revert_cause_unknown'
            : entry.status === 'unavailable'
              ? 'holder_insufficient_coverage'
              : null) ||
        m.evidenceSha256 !== sha(JSON.stringify(m.evidence)) ||
        m.evidence?.verificationStatus !== 'verified' ||
        m.evidence?.identityEvidence?.holder !== issue.holder ||
        m.evidence.identityEvidence?.asset !== ROUTE.asset ||
        m.evidence.identityEvidence?.destination !== ROUTE.destination ||
        m.evidence.identityEvidence?.routeKey !== ROUTE.routeKey ||
        m.evidence.identityEvidence?.blockNumber !== parent.baseline.targetBlock ||
        m.evidence.identityEvidence.blockHash !== parent.baseline.targetHash ||
        m.evidence.identityEvidence.provider !== issue.originPrimary ||
        m.evidence.identityEvidence.source !== STUDY ||
        m.evidence.replayEvidenceDoc?.blockNumber !== parent.baseline.targetBlock ||
        m.evidence.replayEvidenceDoc?.blockHash !== parent.baseline.targetHash ||
        m.evidence.replayEvidenceDoc?.origins?.primary !== issue.originPrimary ||
        m.evidence.replayEvidenceDoc?.origins?.secondary !== issue.originSecondary ||
        utc(m.evidence.replayEvidenceDoc?.observedAt) < utc(parent.baseline.targetBlockAt) ||
        utc(m.evidence.replayEvidenceDoc?.observedAt) > utc(issue.issuedAtUtc)
      )
        throw Error('aave_common_measurement_invalid')
      const frozen = {
        ...ROUTE,
        holder: issue.holder,
        assetsRaw: q.assetsRaw,
        blockNumber: parent.baseline.targetBlock,
        blockHash: parent.baseline.targetHash,
      }
      const decoded = validateCarryExitV2RpcProof({
        proof: m.evidence,
        ...frozen,
      })
      for (const origin of ['primary', 'secondary'])
        for (const phase of ['before', 'after']) {
          const header = m.evidence.replayEvidenceDoc.headers?.[origin]?.[phase]?.target
          if (
            header?.hash !== parent.baseline.targetHash ||
            header?.parentHash !== parent.baseline.targetParentHash ||
            BigInt(header?.number ?? -1) !== BigInt(parent.baseline.targetBlock) ||
            new Date(Number(BigInt(header?.timestamp ?? -1)) * 1000).toISOString() !==
              parent.baseline.targetBlockAt
          )
            throw Error('aave_common_measurement_header_invalid')
        }
      const reconstructed = assembleCarryExitV2CallEvidence({
        frozen,
        collector: {
          status: 'raw_rpc_collected',
          blockNumber: parent.baseline.targetBlock,
          blockHash: parent.baseline.targetHash,
          routeKind: 'aave',
          provider: issue.originPrimary,
          source: STUDY,
          proof: m.evidence,
          identityEvidence: m.evidence.identityEvidence,
        },
        replay: {
          status: 'verified',
          verdict: {
            simulationStatus: decoded.simulationStatus,
            coveredRevert: decoded.coveredRevert,
          },
          replayEvidenceDoc: m.evidence.replayEvidenceDoc,
        },
      })
      if (
        !same(reconstructed, m.evidence) ||
        decoded.holderCoverageRaw !== m.holderCoverageRaw ||
        decoded.simulationStatus !== m.simulationStatus ||
        decoded.coveredRevert !== m.coveredRevert ||
        classifyAaveCommonBaseline(decoded, q.assetsRaw) !== m.baselineStatus
      )
        throw Error('aave_common_measurement_replay_invalid')
    } else throw Error('aave_common_case_invalid')
  }
  return issue
}

export async function verifyAaveCommonIssues(out = OUT, v1Out = V1_OUT) {
  const [parents, rows] = await Promise.all([verifyPublicDirectIssues(v1Out), readNumbered(out)])
  const prior = []
  for (const row of rows) {
    if (prior.some((x) => x.v1IssueSequence === row.v1IssueSequence))
      throw Error('aave_common_duplicate_parent')
    validateAaveCommonIssue(row, parents, prior)
    prior.push(row)
  }
  return rows
}

export async function appendAaveCommonIssue(row, out = OUT, v1Out = V1_OUT) {
  const [parents, prior] = await Promise.all([
    verifyPublicDirectIssues(v1Out),
    verifyAaveCommonIssues(out, v1Out),
  ])
  validateAaveCommonIssue(row, parents, prior)
  if (prior.some((x) => x.v1IssueSequence === row.v1IssueSequence))
    throw Error('aave_common_duplicate_parent')
  return appendNumbered(row, out, (path) => verifyAaveCommonIssues(path, v1Out))
}

export function validateAaveCommonAttempt(row, parents, prior) {
  const parent = parents[row?.v1IssueSequence - 1]
  if (
    !parent ||
    row.study !== ATTEMPT_STUDY ||
    row.sequence !== prior.length + 1 ||
    row.previousSha256 !== (prior.at(-1)?.sha256 ?? null) ||
    row.v1IssueSha256 !== parent.sha256 ||
    !eligibleAaveCommonParent(parent, row.atUtc) ||
    utc(row.recordedAtUtc) < utc(row.atUtc) ||
    row.observationStatus !== 'operator_observed_unverified' ||
    row.verifiedCensor !== false ||
    !['receipt_guard_triggered', 'issue_record_guard_triggered', 'baseline_assay_failed'].includes(
      row.observedCondition,
    ) ||
    (row.observedCondition === 'issue_record_guard_triggered'
      ? !Number.isSafeInteger(row.proposedBytes) || row.proposedBytes <= MAX_RECORD_BYTES
      : row.proposedBytes !== null) ||
    (row.observedCondition === 'baseline_assay_failed'
      ? !Q.some((q) => q.label === row.caseLabel && q.assetsRaw === row.assetsRaw)
      : row.caseLabel !== null || row.assetsRaw !== null) ||
    !same(row.q, Q) ||
    !same(
      row.eligibleCommitments,
      parent.candidate.evidenceDoc.screenedCandidates
        .filter((x) => x.status === 'eligible_holder')
        .map((x) => x.holderCommitment),
    ) ||
    (row.selectedHolderCommitment !== null &&
      !row.eligibleCommitments.includes(row.selectedHolderCommitment))
  )
    throw Error('aave_common_attempt_invalid')
  return row
}

export async function verifyAaveCommonAttempts(out = ATTEMPT_OUT, v1Out = V1_OUT) {
  const [parents, rows] = await Promise.all([verifyPublicDirectIssues(v1Out), readNumbered(out)])
  const prior = []
  for (const row of rows) {
    if (prior.some((x) => x.v1IssueSequence === row.v1IssueSequence))
      throw Error('aave_common_attempt_duplicate_parent')
    validateAaveCommonAttempt(row, parents, prior)
    prior.push(row)
  }
  return rows
}

export async function recordAaveCommonDiagnostic({
  parent,
  parents,
  observedCondition,
  caseLabel = null,
  assetsRaw = null,
  selectedHolderCommitment = null,
  proposedBytes = null,
  atUtc,
  recordedAtUtc = new Date().toISOString(),
  out = ATTEMPT_OUT,
  v1Out = V1_OUT,
  load = verifyAaveCommonAttempts,
  append = (row, path) =>
    appendNumbered(row, path, (where) => verifyAaveCommonAttempts(where, v1Out)),
}) {
  const prior = await load(out, v1Out)
  const existing = prior.find((x) => x.v1IssueSequence === parent.sequence)
  if (existing)
    return {
      status: 'operator_diagnostic_recorded',
      sequence: existing.sequence,
      observedCondition: existing.observedCondition,
    }
  const payload = {
    study: ATTEMPT_STUDY,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
    v1IssueSequence: parent.sequence,
    v1IssueSha256: parent.sha256,
    atUtc,
    recordedAtUtc,
    observationStatus: 'operator_observed_unverified',
    verifiedCensor: false,
    observedCondition,
    caseLabel,
    assetsRaw,
    selectedHolderCommitment,
    proposedBytes,
    q: Q,
    eligibleCommitments: parent.candidate.evidenceDoc.screenedCandidates
      .filter((x) => x.status === 'eligible_holder')
      .map((x) => x.holderCommitment),
  }
  validateAaveCommonAttempt(payload, parents, prior)
  const row = { ...payload, sha256: sha(JSON.stringify(payload)) }
  return { status: 'operator_diagnostic_recorded', observedCondition, ...(await append(row, out)) }
}

export async function issueAaveCommonQ({
  out = OUT,
  v1Out = V1_OUT,
  now = () => new Date(),
  loadParents = verifyPublicDirectIssues,
  load = verifyAaveCommonIssues,
  recover = recoverAaveCommonSelectedCandidate,
  measure = measureBaseline,
  append = appendAaveCommonIssue,
  recordDiagnostic = recordAaveCommonDiagnostic,
  clients,
}) {
  const [parents, prior] = await Promise.all([loadParents(v1Out), load(out, v1Out)])
  // Diagnostics are unverified operator observations. They never remove a parent from retry.
  const used = new Set(prior.map((x) => x.v1IssueSequence))
  const parent = parents.findLast(
    (x) => !used.has(x.sequence) && eligibleAaveCommonParent(x, now().toISOString()),
  )
  if (!parent) return { status: 'no_eligible_fresh_v1_issue' }
  const attemptStartedAtUtc = now().toISOString()
  const pair = [
    clients?.find((x) => x.provider === parent.baseline.canonicalityEvidenceDoc.provider),
    clients?.find((x) => x.provider === parent.baselineWitness.provider),
  ]
  if (!pair[0] || !pair[1] || pair[0] === pair[1])
    return { status: 'retry_original_origins_unavailable' }
  const candidates = aaveCommonCandidateCensus(parent)
  const selected = selectAaveCommonCandidate(candidates, prior, parent.slot)
  let candidate
  try {
    candidate = await recover(parent, pair, selected, now().toISOString())
  } catch (error) {
    if (error?.message !== 'aave_common_receipt_too_large') throw error
    return recordDiagnostic({
      parent,
      parents,
      observedCondition: 'receipt_guard_triggered',
      atUtc: attemptStartedAtUtc,
      recordedAtUtc: now().toISOString(),
    })
  }
  let cases
  try {
    cases = await planAaveCommonCases(candidate, parent, pair, measure)
  } catch (error) {
    if (error?.message !== 'aave_common_baseline_assay_failed') throw error
    return recordDiagnostic({
      parent,
      parents,
      observedCondition: 'baseline_assay_failed',
      caseLabel: error.caseLabel,
      assetsRaw: error.assetsRaw,
      selectedHolderCommitment: candidate.holderCommitment,
      atUtc: attemptStartedAtUtc,
      recordedAtUtc: now().toISOString(),
    })
  }
  const issuedAtUtc = now().toISOString()
  const payload = {
    study: STUDY,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
    v1IssueSequence: parent.sequence,
    v1IssueSha256: parent.sha256,
    marketKey: 'aaveV3Usdc',
    routeKey: parent.routeKey,
    destination: parent.destination,
    originalAsset: parent.originalAsset,
    issuedAtUtc,
    targets: parent.targets,
    originPrimary: pair[0].provider,
    originSecondary: pair[1].provider,
    candidates,
    holder: candidate.holder,
    selectedHolderCommitment: candidate.holderCommitment,
    selectedCandidate: candidate,
    selectedScreenedIndex: candidate.screenedIndex,
    cases,
  }
  validateAaveCommonIssue(payload, parents, prior)
  const proposedBytes = Buffer.byteLength(JSON.stringify(payload)) + 80
  if (proposedBytes > MAX_RECORD_BYTES)
    return recordDiagnostic({
      parent,
      parents,
      observedCondition: 'issue_record_guard_triggered',
      selectedHolderCommitment: candidate.holderCommitment,
      proposedBytes,
      atUtc: issuedAtUtc,
      recordedAtUtc: issuedAtUtc,
    })
  return {
    status: 'issued',
    ...(await append({ ...payload, sha256: sha(JSON.stringify(payload)) }, out, v1Out)),
  }
}

async function cli() {
  if (process.argv[2] === '--verify') {
    const rows = await verifyAaveCommonIssues()
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', issues: rows.length })}\n`,
    )
    return
  }
  if (process.argv[2] !== '--issue-latest') throw Error('aave_common_issue_usage')
  const clients = publicRpcClients(configuredPublicRpcUrls(readEnv()))
  process.stdout.write(`${JSON.stringify(await issueAaveCommonQ({ clients }))}\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli().catch(() => {
    process.stderr.write('public_aave_common_issue_failed\n')
    process.exitCode = 1
  })
