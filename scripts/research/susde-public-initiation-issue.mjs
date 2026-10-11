// Prospective hypothetical initiation cases are frozen before any future read.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFunctionData } from 'viem'

import { freezeSyncVaultQLadder } from '../lib/carry-exit-v2-sync-vault-issuer-prep.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import {
  ADDRESS,
  BLOCK_HASH,
  DEADLINE_HOURS,
  DECIMAL,
  HASH,
  HORIZONS_HOURS,
  ROUTE,
  appendNumbered,
  header,
  measureInitiation,
  readNumbered,
  readVaultTotals,
  rotatingSusdeOriginPairs,
  same,
  seal,
  sha,
  utc,
  verifyMeasurement,
  witnessBlock,
} from './susde-public-initiation-common.mjs'

export const STUDY = 'susde_public_hypothetical_initiation_issue_v2'
const LEGACY_STUDY = 'susde_public_hypothetical_initiation_issue_v1'
const DEPLOYED_MEASUREMENT = 'susde_public_cooldown_initiation_measurement_v2'
export const OUT = resolve('data/research/venue-signals/susde-public-initiation-issues')
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const SLOT_MS = 15 * 60_000
const CANDIDATE_WINDOW_BLOCKS = 512n
const MAX_CANDIDATE_LOGS = 512
const MAX_SCREENED_CANDIDATES = 48
const MAX_ELIGIBLE_CANDIDATES = 3
const HEX = /^0x[0-9a-f]+$/
const WORD = /^0x[0-9a-f]{64}$/
const CONVERT_ABI = [
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
]

function ownerFrom(log) {
  if (
    log?.address?.toLowerCase() !== ROUTE.vault ||
    log.topics?.[0] !== TRANSFER ||
    log.topics.length !== 3 ||
    !WORD.test(log.topics[1] ?? '') ||
    !WORD.test(log.topics[2] ?? '') ||
    !WORD.test(log.data ?? '') ||
    !BLOCK_HASH.test(log.blockHash ?? '') ||
    !BLOCK_HASH.test(log.transactionHash ?? '') ||
    !HEX.test(log.blockNumber ?? '') ||
    !HEX.test(log.logIndex ?? '') ||
    log.removed === true
  )
    throw Error('susde_candidate_log_invalid')
  const owner = `0x${log.topics[2].slice(-40)}`
  return owner === '0x0000000000000000000000000000000000000000' || BigInt(log.data) === 0n
    ? null
    : { owner, log, shares: BigInt(log.data) }
}

function canonicalLogs(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_CANDIDATE_LOGS)
    throw Error('susde_candidate_logs_unavailable')
  const logs = raw.map((log) => ({
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    removed: log.removed === true,
  }))
  logs.forEach(ownerFrom)
  logs.sort((a, b) =>
    BigInt(a.blockNumber) === BigInt(b.blockNumber)
      ? BigInt(a.logIndex) === BigInt(b.logIndex)
        ? a.transactionHash.localeCompare(b.transactionHash)
        : BigInt(a.logIndex) < BigInt(b.logIndex)
          ? -1
          : 1
      : BigInt(a.blockNumber) < BigInt(b.blockNumber)
        ? -1
        : 1,
  )
  if (
    logs.some(
      (log, index) =>
        index > 0 &&
        log.blockNumber === logs[index - 1].blockNumber &&
        log.logIndex === logs[index - 1].logIndex,
    )
  )
    throw Error('susde_candidate_logs_duplicate')
  return logs
}

function rankedDistinct(logs) {
  const ranked = logs
    .map(ownerFrom)
    .filter(Boolean)
    .sort((a, b) =>
      a.shares === b.shares
        ? BigInt(a.log.blockNumber) === BigInt(b.log.blockNumber)
          ? a.owner.localeCompare(b.owner)
          : BigInt(a.log.blockNumber) > BigInt(b.log.blockNumber)
            ? -1
            : 1
        : a.shares > b.shares
          ? -1
          : 1,
    )
  const seen = new Set()
  return ranked.filter((row) => {
    if (seen.has(row.owner)) return false
    seen.add(row.owner)
    return true
  })
}

/** Bounded recent-transfer sample; no population inference follows from this screen. */
export async function discoverCandidate(pair, block) {
  const end = BigInt(block.number) - 1n
  if (end < 1n) throw Error('susde_candidate_window_invalid')
  const start = end >= CANDIDATE_WINDOW_BLOCKS ? end - CANDIDATE_WINDOW_BLOCKS + 1n : 1n
  const observations = pair.map(() => [])
  for (let from = start; from <= end; from += 10n) {
    const to = from + 9n <= end ? from + 9n : end
    const query = {
      address: ROUTE.vault,
      topics: [TRANSFER],
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
    }
    const parts = await Promise.all(pair.map((client) => client.request('eth_getLogs', [query])))
    for (let index = 0; index < 2; index++) {
      const part = parts[index]
      if (
        !Array.isArray(part) ||
        part.length > MAX_CANDIDATE_LOGS ||
        observations[index].length + part.length > MAX_CANDIDATE_LOGS
      )
        throw Error('susde_candidate_logs_unavailable')
      observations[index].push(...part)
    }
  }
  const logs = canonicalLogs(observations[0])
  if (!same(logs, canonicalLogs(observations[1])))
    throw Error('susde_candidate_log_origin_disagreement')
  const distinct = rankedDistinct(logs)
  const screened = []
  const eligible = []
  const selectionSlot = Math.floor(utc(block.at) / SLOT_MS)
  const evidence = (selectedHolderCommitment) => ({
    schema: 'susde_public_receipt_screen_v2',
    windowStart: start.toString(),
    windowEnd: end.toString(),
    logCount: logs.length,
    rawLogs: logs,
    logWitnesses: pair.map((client) => ({
      provider: client.provider,
      logSetSha256: sha(JSON.stringify(logs)),
    })),
    selectionAudit: {
      rankingFromStoredTwoOriginLogResponses: true,
      rejectionRpcEvidenceRetained: false,
      chainCompletenessProved: false,
    },
    rankedDistinctCount: distinct.length,
    screenLimit: MAX_SCREENED_CANDIDATES,
    eligibleLimit: MAX_ELIGIBLE_CANDIDATES,
    attemptedCount: screened.length,
    unscreenedDistinctCount: distinct.length - screened.length,
    eligibleCount: eligible.length,
    rejectionCounts: Object.fromEntries(
      [
        'discovery_hash_mismatch',
        'discovery_origin_disagreement',
        'receipt_unverified',
        'not_proven_eoa',
        'no_positive_claim',
      ].map((reason) => [reason, screened.filter((entry) => entry.status === reason).length]),
    ),
    selectionSlot,
    selectionIndex: eligible.length ? selectionSlot % eligible.length : null,
    screened,
    selectedHolderCommitment,
    selectionRule: 'ranked_receipt_proven_eoa_baseline_slot_rotation',
  })
  for (const row of distinct.slice(0, MAX_SCREENED_CANDIDATES)) {
    const entry = {
      holderCommitment: sha(`${ROUTE.vault}:${row.owner}`),
      discoveryBlock: BigInt(row.log.blockNumber).toString(),
      discoveryTransactionHash: row.log.transactionHash,
      discoveryLogIndex: BigInt(row.log.logIndex).toString(),
      transferSharesRaw: row.shares.toString(),
      status: null,
    }
    screened.push(entry)
    const discovery = await header(pair[0], BigInt(row.log.blockNumber))
    if (discovery.hash !== row.log.blockHash) {
      entry.status = 'discovery_hash_mismatch'
      continue
    }
    const independentDiscovery = await header(pair[1], BigInt(row.log.blockNumber))
    if (independentDiscovery.hash !== discovery.hash) {
      entry.status = 'discovery_origin_disagreement'
      continue
    }
    const receipts = await Promise.all(
      pair.map((client) => client.request('eth_getTransactionReceipt', [row.log.transactionHash])),
    )
    const exact = receipts.map((receipt) =>
      receipt?.logs?.filter((entry) => entry.logIndex === row.log.logIndex),
    )
    if (
      receipts.some(
        (receipt) =>
          receipt?.status !== '0x1' ||
          receipt.transactionHash !== row.log.transactionHash ||
          receipt.blockHash !== discovery.hash ||
          receipt.blockNumber !== row.log.blockNumber,
      ) ||
      exact.some(
        (entries) =>
          entries?.length !== 1 ||
          entries[0].address?.toLowerCase() !== ROUTE.vault ||
          !same(entries[0].topics, row.log.topics) ||
          entries[0].data !== row.log.data ||
          entries[0].removed === true,
      )
    ) {
      entry.status = 'receipt_unverified'
      continue
    }
    const code = await Promise.all(
      pair.map((client) =>
        client.request('eth_getCode', [
          row.owner,
          { blockHash: block.hash, requireCanonical: true },
        ]),
      ),
    )
    // Missing eth_getCode is unavailable evidence, never proof of an EOA.
    if (!code.every((value) => value === '0x')) {
      entry.status = 'not_proven_eoa'
      continue
    }
    const balanceData = `0x70a08231${row.owner.slice(2).padStart(64, '0')}`
    const balances = await Promise.all(
      pair.map((client) =>
        client.request('eth_call', [
          { to: ROUTE.vault, data: balanceData },
          { blockHash: block.hash, requireCanonical: true },
        ]),
      ),
    )
    if (!balances.every((value) => WORD.test(value ?? '')) || balances[0] !== balances[1])
      throw Error('susde_candidate_balance_disagreement')
    const shares = BigInt(balances[0])
    const claimData = encodeFunctionData({
      abi: CONVERT_ABI,
      functionName: 'convertToAssets',
      args: [shares],
    })
    const claims = await Promise.all(
      pair.map((client) =>
        client.request('eth_call', [
          { to: ROUTE.vault, data: claimData },
          { blockHash: block.hash, requireCanonical: true },
        ]),
      ),
    )
    if (!claims.every((value) => WORD.test(value ?? '')) || claims[0] !== claims[1])
      throw Error('susde_candidate_claim_disagreement')
    const claim = BigInt(claims[0])
    entry.status = shares > 0n && claim > 0n ? 'eligible_unselected' : 'no_positive_claim'
    entry.sharesRaw = shares.toString()
    entry.claimRaw = claim.toString()
    if (shares > 0n && claim > 0n) {
      entry.proof = {
        discoveryHash: discovery.hash,
        baselineHash: block.hash,
        transfer: {
          address: row.log.address,
          topics: row.log.topics,
          data: row.log.data,
          blockHash: row.log.blockHash,
          transactionHash: row.log.transactionHash,
          blockNumber: row.log.blockNumber,
          logIndex: row.log.logIndex,
        },
        origins: pair.map((client, index) => ({
          provider: client.provider,
          discoveryHash: index === 0 ? discovery.hash : independentDiscovery.hash,
          receiptSha256: sha(
            JSON.stringify({
              status: receipts[index].status,
              transactionHash: receipts[index].transactionHash,
              blockHash: receipts[index].blockHash,
              blockNumber: receipts[index].blockNumber,
              selectedLog: {
                address: exact[index][0].address,
                topics: exact[index][0].topics,
                data: exact[index][0].data,
                blockHash: exact[index][0].blockHash,
                transactionHash: exact[index][0].transactionHash,
                blockNumber: exact[index][0].blockNumber,
                logIndex: exact[index][0].logIndex,
              },
            }),
          ),
          receipt: {
            status: receipts[index].status,
            transactionHash: receipts[index].transactionHash,
            blockHash: receipts[index].blockHash,
            blockNumber: receipts[index].blockNumber,
            selectedLog: {
              address: exact[index][0].address,
              topics: exact[index][0].topics,
              data: exact[index][0].data,
              blockHash: exact[index][0].blockHash,
              transactionHash: exact[index][0].transactionHash,
              blockNumber: exact[index][0].blockNumber,
              logIndex: exact[index][0].logIndex,
            },
          },
          code: code[index],
          sharesRaw: balances[index],
          claimRaw: claims[index],
        })),
      }
      eligible.push({ holder: row.owner, entry })
      if (eligible.length >= MAX_ELIGIBLE_CANDIDATES) break
    }
  }
  if (eligible.length) {
    const { holder, entry } = eligible[selectionSlot % eligible.length]
    entry.status = 'selected'
    return {
      holder,
      selectedSharesRaw: entry.sharesRaw,
      selectedClaimRaw: entry.claimRaw,
      evidence: evidence(entry.holderCommitment),
    }
  }
  return {
    holder: null,
    selectedSharesRaw: null,
    selectedClaimRaw: null,
    evidence: evidence(null),
  }
}

function qLadder(totalAssetsRaw, selectedClaimRaw) {
  return freezeSyncVaultQLadder({
    totalAssetsRaw,
    selectedClaimRaw,
  }).labels.map((row) => ({ label: row.label, assetsRaw: row.assetsRaw, reason: row.reason }))
}

export function buildSusdeIssue({
  baseline,
  candidate,
  cases,
  issuedAtUtc,
  sequence,
  previousSha256,
}) {
  const issued = utc(issuedAtUtc)
  return seal({
    study: STUDY,
    sequence,
    previousSha256,
    route: ROUTE,
    issuedAtUtc,
    slot: Math.floor(issued / SLOT_MS),
    clock: { kind: 'local_operator_clock', externalTimestampProof: false },
    baseline,
    candidate,
    cases,
    targets: HORIZONS_HOURS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(issued + horizonHours * 3_600_000).toISOString(),
      captureDeadlineUtc: new Date(
        issued + (horizonHours + DEADLINE_HOURS) * 3_600_000,
      ).toISOString(),
    })),
    interpretation: 'hypothetical_future_cooldown_initiation_only',
  })
}

function validateCandidateEvidenceV2(candidate, baseline) {
  const evidence = candidate.evidence
  const end = BigInt(baseline.block.number) - 1n
  const start = end >= CANDIDATE_WINDOW_BLOCKS ? end - CANDIDATE_WINDOW_BLOCKS + 1n : 1n
  const logs = canonicalLogs(evidence.rawLogs)
  const distinct = rankedDistinct(logs)
  const logSetSha256 = sha(JSON.stringify(logs))
  if (
    evidence.windowStart !== start.toString() ||
    evidence.windowEnd !== end.toString() ||
    !same(evidence.rawLogs, logs) ||
    logs.some((log) => BigInt(log.blockNumber) < start || BigInt(log.blockNumber) > end) ||
    !Array.isArray(evidence.logWitnesses) ||
    evidence.logWitnesses.length !== 2 ||
    evidence.logWitnesses.some(
      (witness, index) =>
        witness.provider !== baseline.witnesses[index].provider ||
        witness.logSetSha256 !== logSetSha256,
    ) ||
    !same(evidence.selectionAudit, {
      rankingFromStoredTwoOriginLogResponses: true,
      rejectionRpcEvidenceRetained: false,
      chainCompletenessProved: false,
    }) ||
    !Number.isSafeInteger(evidence.logCount) ||
    evidence.logCount !== logs.length ||
    !Number.isSafeInteger(evidence.rankedDistinctCount) ||
    evidence.rankedDistinctCount !== distinct.length ||
    evidence.screenLimit !== MAX_SCREENED_CANDIDATES ||
    evidence.eligibleLimit !== MAX_ELIGIBLE_CANDIDATES ||
    evidence.attemptedCount !== evidence.screened?.length ||
    evidence.unscreenedDistinctCount !== evidence.rankedDistinctCount - evidence.screened?.length ||
    evidence.selectionSlot !== Math.floor(utc(baseline.block.at) / SLOT_MS) ||
    evidence.selectionRule !== 'ranked_receipt_proven_eoa_baseline_slot_rotation' ||
    !Array.isArray(evidence.screened) ||
    evidence.screened.length > Math.min(MAX_SCREENED_CANDIDATES, evidence.rankedDistinctCount)
  )
    throw Error('susde_candidate_screen_invalid')
  const holders = new Set()
  const eligible = []
  const reasons = new Set([
    'discovery_hash_mismatch',
    'discovery_origin_disagreement',
    'receipt_unverified',
    'not_proven_eoa',
    'no_positive_claim',
  ])
  for (const [index, row] of evidence.screened.entries()) {
    const rank = distinct[index]
    if (
      !HASH.test(row?.holderCommitment ?? '') ||
      row.holderCommitment !== sha(`${ROUTE.vault}:${rank.owner}`) ||
      holders.has(row.holderCommitment) ||
      !DECIMAL.test(row.discoveryBlock ?? '') ||
      row.discoveryBlock !== BigInt(rank.log.blockNumber).toString() ||
      BigInt(row.discoveryBlock) < start ||
      BigInt(row.discoveryBlock) > end ||
      !BLOCK_HASH.test(row.discoveryTransactionHash ?? '') ||
      row.discoveryTransactionHash !== rank.log.transactionHash ||
      !DECIMAL.test(row.discoveryLogIndex ?? '') ||
      row.discoveryLogIndex !== BigInt(rank.log.logIndex).toString() ||
      !DECIMAL.test(row.transferSharesRaw ?? '') ||
      row.transferSharesRaw !== rank.shares.toString() ||
      BigInt(row.transferSharesRaw) === 0n ||
      (!reasons.has(row.status) && !['selected', 'eligible_unselected'].includes(row.status))
    )
      throw Error('susde_candidate_screen_invalid')
    holders.add(row.holderCommitment)
    if (['selected', 'eligible_unselected'].includes(row.status)) {
      eligible.push(row)
      const proof = row.proof
      const transfer = proof?.transfer
      const { removed: _removed, ...rankedTransfer } = rank.log
      const expectedLog = {
        address: transfer?.address,
        topics: transfer?.topics,
        data: transfer?.data,
        blockHash: transfer?.blockHash,
        transactionHash: transfer?.transactionHash,
        blockNumber: transfer?.blockNumber,
        logIndex: transfer?.logIndex,
      }
      if (
        !DECIMAL.test(row.sharesRaw ?? '') ||
        BigInt(row.sharesRaw) === 0n ||
        !DECIMAL.test(row.claimRaw ?? '') ||
        BigInt(row.claimRaw) === 0n ||
        !BLOCK_HASH.test(proof?.discoveryHash ?? '') ||
        proof.baselineHash !== baseline.block.hash ||
        !same(transfer, rankedTransfer) ||
        transfer?.address?.toLowerCase() !== ROUTE.vault ||
        transfer.topics?.[0] !== TRANSFER ||
        transfer.topics?.length !== 3 ||
        !WORD.test(transfer.topics[2] ?? '') ||
        sha(`${ROUTE.vault}:0x${transfer.topics[2].slice(-40)}`) !== row.holderCommitment ||
        (`0x${transfer.topics[2].slice(-40)}` !== candidate.holder && row.status === 'selected') ||
        transfer.data !== `0x${BigInt(row.transferSharesRaw).toString(16).padStart(64, '0')}` ||
        transfer.blockHash !== proof.discoveryHash ||
        transfer.transactionHash !== row.discoveryTransactionHash ||
        BigInt(transfer.blockNumber ?? '-1') !== BigInt(row.discoveryBlock) ||
        BigInt(transfer.logIndex ?? '-1') !== BigInt(row.discoveryLogIndex) ||
        !Array.isArray(proof.origins) ||
        proof.origins.length !== 2 ||
        proof.origins.some(
          (origin, index) =>
            origin.provider !== baseline.witnesses[index].provider ||
            origin.discoveryHash !== proof.discoveryHash ||
            origin.receiptSha256 !== sha(JSON.stringify(origin.receipt)) ||
            origin.receipt?.status !== '0x1' ||
            origin.receipt.transactionHash !== transfer.transactionHash ||
            origin.receipt.blockHash !== proof.discoveryHash ||
            origin.receipt.blockNumber !== transfer.blockNumber ||
            !same(origin.receipt.selectedLog, expectedLog) ||
            origin.code !== '0x' ||
            !WORD.test(origin.sharesRaw ?? '') ||
            !WORD.test(origin.claimRaw ?? '') ||
            BigInt(origin.sharesRaw) !== BigInt(row.sharesRaw) ||
            BigInt(origin.claimRaw) !== BigInt(row.claimRaw),
        )
      )
        throw Error('susde_candidate_selection_proof_invalid')
    } else if (row.proof !== undefined) {
      throw Error('susde_candidate_rejection_invalid')
    }
  }
  const selected = eligible.filter((row) => row.status === 'selected')
  if (
    eligible.length > MAX_ELIGIBLE_CANDIDATES ||
    evidence.eligibleCount !== eligible.length ||
    Boolean(candidate.holder) !== Boolean(eligible.length) ||
    (evidence.screened.length < Math.min(MAX_SCREENED_CANDIDATES, evidence.rankedDistinctCount) &&
      eligible.length !== MAX_ELIGIBLE_CANDIDATES) ||
    [...reasons].some(
      (reason) =>
        evidence.rejectionCounts?.[reason] !==
        evidence.screened.filter((row) => row.status === reason).length,
    ) ||
    Object.keys(evidence.rejectionCounts ?? {}).length !== reasons.size ||
    evidence.selectionIndex !==
      (eligible.length ? evidence.selectionSlot % eligible.length : null) ||
    selected.length !== (candidate.holder ? 1 : 0) ||
    (candidate.holder && selected[0] !== eligible[evidence.selectionIndex]) ||
    evidence.selectedHolderCommitment !== (selected[0]?.holderCommitment ?? null) ||
    (candidate.holder &&
      selected[0].holderCommitment !== sha(`${ROUTE.vault}:${candidate.holder}`)) ||
    (candidate.holder &&
      (candidate.selectedSharesRaw !== selected[0].sharesRaw ||
        candidate.selectedClaimRaw !== selected[0].claimRaw)) ||
    (!candidate.holder &&
      (candidate.selectedSharesRaw !== null || candidate.selectedClaimRaw !== null))
  )
    throw Error('susde_candidate_selection_invalid')
}

export function validateSusdeIssue(issue) {
  if (
    ![LEGACY_STUDY, STUDY].includes(issue?.study) ||
    !Number.isSafeInteger(issue.sequence) ||
    issue.sequence < 1 ||
    !same(issue.route, ROUTE) ||
    (issue.sequence === 1
      ? issue.previousSha256 !== null
      : !HASH.test(issue.previousSha256 ?? '')) ||
    issue.interpretation !== 'hypothetical_future_cooldown_initiation_only' ||
    issue.clock?.kind !== 'local_operator_clock' ||
    issue.clock.externalTimestampProof !== false ||
    issue.slot !== Math.floor(utc(issue.issuedAtUtc) / SLOT_MS) ||
    !same(
      issue.targets,
      HORIZONS_HOURS.map((hours) => ({
        horizonHours: hours,
        targetAtUtc: new Date(utc(issue.issuedAtUtc) + hours * 3_600_000).toISOString(),
        captureDeadlineUtc: new Date(
          utc(issue.issuedAtUtc) + (hours + DEADLINE_HOURS) * 3_600_000,
        ).toISOString(),
      })),
    )
  )
    throw Error('susde_issue_identity_invalid')
  const baseline = issue.baseline
  if (
    !DECIMAL.test(baseline?.block?.number ?? '') ||
    !BLOCK_HASH.test(baseline.block.hash) ||
    !BLOCK_HASH.test(baseline.block.parentHash) ||
    !DECIMAL.test(baseline.totalAssetsRaw ?? '') ||
    !DECIMAL.test(baseline.totalSupplyRaw ?? '') ||
    utc(baseline.block.at) > utc(baseline.observedAtUtc) ||
    utc(baseline.observedAtUtc) > utc(issue.issuedAtUtc) ||
    utc(issue.issuedAtUtc) - utc(baseline.block.at) > 3_600_000 ||
    !Array.isArray(baseline.witnesses) ||
    baseline.witnesses.length !== 2 ||
    baseline.witnesses[0].provider === baseline.witnesses[1].provider ||
    baseline.witnesses.some(
      (row) =>
        !same(row.observed, baseline.block) ||
        !DECIMAL.test(row.finalized?.number ?? '') ||
        BigInt(row.finalized.number) < BigInt(baseline.block.number) ||
        utc(row.observedAtUtc) > utc(issue.issuedAtUtc),
    )
  )
    throw Error('susde_issue_baseline_invalid')
  const candidate = issue.candidate
  // The legacy first issue predates retained v2 proof; later issues cannot downgrade it.
  if (candidate?.evidence?.schema === 'susde_public_receipt_screen_v1' && issue.sequence !== 1)
    throw Error('susde_issue_candidate_schema_downgrade')
  if (
    !candidate ||
    (candidate.holder !== null && !ADDRESS.test(candidate.holder ?? '')) ||
    !['susde_public_receipt_screen_v1', 'susde_public_receipt_screen_v2'].includes(
      candidate.evidence?.schema,
    ) ||
    !DECIMAL.test(candidate.evidence.windowStart ?? '') ||
    candidate.evidence.windowEnd !== (BigInt(baseline.block.number) - 1n).toString() ||
    !Array.isArray(candidate.evidence.screened) ||
    candidate.evidence.screened.length >
      (candidate.evidence.schema === 'susde_public_receipt_screen_v1'
        ? 8
        : MAX_SCREENED_CANDIDATES) ||
    candidate.evidence.selectedHolderCommitment !==
      (candidate.holder ? sha(`${ROUTE.vault}:${candidate.holder}`) : null) ||
    (candidate.holder &&
      (!DECIMAL.test(candidate.selectedClaimRaw ?? '') ||
        BigInt(candidate.selectedClaimRaw) === 0n ||
        !DECIMAL.test(candidate.selectedSharesRaw ?? '') ||
        BigInt(candidate.selectedSharesRaw) === 0n ||
        !candidate.evidence.screened.some(
          (row) =>
            row.holderCommitment === candidate.evidence.selectedHolderCommitment &&
            row.sharesRaw === candidate.selectedSharesRaw &&
            row.claimRaw === candidate.selectedClaimRaw,
        ))) ||
    !Array.isArray(issue.cases) ||
    issue.cases.length !== 6
  )
    throw Error('susde_issue_candidate_invalid')
  if (candidate.evidence.schema === 'susde_public_receipt_screen_v2')
    validateCandidateEvidenceV2(candidate, baseline)
  const ladder = qLadder(baseline.totalAssetsRaw, candidate.selectedClaimRaw)
  for (let i = 0; i < 6; i++) {
    const row = issue.cases[i]
    if (
      row.label !== ladder[i].label ||
      row.assetsRaw !== ladder[i].assetsRaw ||
      !['measured', 'unavailable'].includes(row.status)
    )
      throw Error('susde_issue_q_invalid')
    if (row.status === 'measured') {
      if (!candidate.holder || !row.assetsRaw || row.reason !== null)
        throw Error('susde_issue_measurement_invalid')
      verifyMeasurement(row.measurement, {
        block: baseline.block,
        holder: candidate.holder,
        assetsRaw: row.assetsRaw,
        earliestUtc: baseline.observedAtUtc,
        latestUtc: issue.issuedAtUtc,
        allowLegacy: issue.study === LEGACY_STUDY,
      })
      if (
        row.measurement.evidence.schema !==
        (issue.study === STUDY
          ? DEPLOYED_MEASUREMENT
          : 'susde_public_cooldown_initiation_measurement_v1')
      )
        throw Error('susde_issue_legacy_selector_invalid')
      if (
        row.measurement.evidence.origins[0].provider !== baseline.witnesses[0].provider ||
        row.measurement.evidence.origins[1].provider !== baseline.witnesses[1].provider
      )
        throw Error('susde_issue_measurement_origin_invalid')
    } else if (
      row.measurement !== null ||
      !['no_holder', 'omitted_duplicate_or_zero', 'rpc_unavailable'].includes(row.reason)
    )
      throw Error('susde_issue_unavailable_invalid')
  }
  const { sha256: _seal, ...body } = issue
  if (issue.sha256 !== sha(JSON.stringify(body))) throw Error('susde_issue_seal_invalid')
  return issue
}

export async function verifySusdeIssues(out = OUT) {
  const rows = await readNumbered(out)
  const slots = new Set()
  for (const row of rows) {
    validateSusdeIssue(row)
    if (slots.has(row.slot)) throw Error('susde_issue_duplicate_slot')
    slots.add(row.slot)
  }
  return rows
}

export async function appendSusdeIssue(issue, out = OUT) {
  validateSusdeIssue(issue)
  if (issue.study !== STUDY) throw Error('susde_issue_study_downgrade')
  const prior = await verifySusdeIssues(out)
  if (prior.some((row) => row.slot === issue.slot)) throw Error('susde_issue_duplicate_slot')
  return appendNumbered(issue, out, verifySusdeIssues)
}

export async function issuePublicSusdeInitiation({
  originPairs,
  out = OUT,
  now = () => new Date(),
  discover = discoverCandidate,
  measure = measureInitiation,
  append = appendSusdeIssue,
  load = verifySusdeIssues,
}) {
  if (!Array.isArray(originPairs) || !originPairs.length || originPairs.length > 24)
    throw Error('susde_origins_invalid')
  const prior = await load(out)
  let prepared = null
  for (const pair of originPairs) {
    try {
      const block = await header(pair[0])
      const witnesses = await witnessBlock(pair, block, now)
      const observedAtUtc = now().toISOString()
      const { totalAssetsRaw, totalSupplyRaw } = await readVaultTotals(pair, block)
      const candidate = await discover(pair, block)
      if (!candidate.holder) {
        if (!prepared)
          prepared = {
            block,
            witnesses,
            observedAtUtc,
            totalAssetsRaw,
            totalSupplyRaw,
            candidate,
            cases: qLadder(totalAssetsRaw, null).map((entry) => ({
              ...entry,
              status: 'unavailable',
              reason: entry.assetsRaw === null ? 'omitted_duplicate_or_zero' : 'no_holder',
              measurement: null,
            })),
          }
        continue
      }
      const measurements = []
      // Claim is a pinned convertToAssets view, only a sizing basis, not executability.
      const ladder = qLadder(totalAssetsRaw, candidate.selectedClaimRaw)
      for (const entry of ladder) {
        if (!entry.assetsRaw || entry.reason) {
          measurements.push({
            ...entry,
            status: 'unavailable',
            reason: 'omitted_duplicate_or_zero',
            measurement: null,
          })
          continue
        }
        try {
          measurements.push({
            ...entry,
            status: 'measured',
            reason: null,
            measurement: await measure({
              pair,
              block,
              holder: candidate.holder,
              assetsRaw: entry.assetsRaw,
              now,
            }),
          })
        } catch {
          measurements.push({
            ...entry,
            status: 'unavailable',
            reason: 'rpc_unavailable',
            measurement: null,
          })
        }
      }
      prepared = {
        block,
        witnesses,
        observedAtUtc,
        totalAssetsRaw,
        totalSupplyRaw,
        candidate,
        cases: measurements,
      }
      if (measurements.some((row) => row.measurement?.status === 'simulated_initiation_success'))
        break
    } catch {
      // Rotate bounded independent origin pairs on provider failure.
    }
  }
  if (!prepared) throw Error('susde_issue_unavailable')
  const { candidate, cases, ...baseline } = prepared
  const issue = buildSusdeIssue({
    baseline,
    candidate,
    cases,
    issuedAtUtc: now().toISOString(),
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
  })
  return append(issue, out)
}

async function cli() {
  const [mode] = process.argv.slice(2)
  if (mode === '--verify') {
    process.stdout.write(
      `${JSON.stringify({ status: 'verified', issues: (await verifySusdeIssues()).length })}\n`,
    )
    return
  }
  if (mode !== '--issue') throw Error('susde_issue_usage')
  const originPairs = rotatingSusdeOriginPairs(configuredPublicRpcUrls(readEnv()))
  const result = await issuePublicSusdeInitiation({ originPairs })
  process.stdout.write(`${JSON.stringify({ status: 'issued', ...result })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stderr.write('susde_public_issue_failed\n')
    process.exitCode = 1
  })
}
