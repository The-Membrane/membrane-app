// Prospective, public-only study of an existing sUSDe pending claim.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  ADDRESS,
  DECIMAL,
  DEADLINE_HOURS,
  HASH,
  HORIZONS_HOURS,
  ROUTE_KEY,
  SILO,
  USDE,
  VAULT,
  WITHDRAW_TOPIC,
  appendLedger,
  finalizedAnchor,
  measureTwoOrigins,
  numberHex,
  publicOriginPairs,
  readLedger,
  same,
  seal,
  sha,
  utc,
  validatePendingMeasurement,
} from './susde-public-pending-exit-common.mjs'

export const STUDY = 'susde_public_pending_exit_issue_v1'
export const OUT = resolve('data/research/venue-signals/susde-public-pending-exit-issues')
const LOOKBACK = 512n
const MAX_SCREENED = 8
const ZERO = `0x${'0'.repeat(40)}`
const word = /^0x[0-9a-f]{64}$/

function candidateFromLog(log, earliest, latest) {
  if (
    !same(log.address, VAULT) ||
    log.topics?.length !== 4 ||
    log.topics[0] !== WITHDRAW_TOPIC ||
    !log.topics.slice(1).every((t) => word.test(t ?? '')) ||
    !/^0x[0-9a-f]{128}$/.test(log.data ?? '') ||
    log.removed === true ||
    !HASH.test(log.blockHash ?? '') ||
    !HASH.test(log.transactionHash ?? '') ||
    !DECIMAL.test(BigInt(log.blockNumber ?? -1).toString())
  )
    throw Error('susde_candidate_log_invalid')
  const block = BigInt(log.blockNumber)
  if (block < earliest || block >= latest) throw Error('susde_candidate_log_range_invalid')
  const receiver = `0x${log.topics[2].slice(-40)}`
  const owner = `0x${log.topics[3].slice(-40)}`
  const assetsRaw = BigInt(`0x${log.data.slice(2, 66)}`).toString()
  if (
    !same(receiver, SILO) ||
    !ADDRESS.test(owner) ||
    same(owner, ZERO) ||
    BigInt(assetsRaw) === 0n
  )
    return null
  return {
    holder: owner,
    blockNumber: block.toString(),
    transactionHash: log.transactionHash,
    logIndex: BigInt(log.logIndex).toString(),
    assetsRaw,
    log,
  }
}

function receiptAttests(candidate, receipt, header) {
  const log = candidate.log
  const matching = receipt?.logs?.filter((item) => item.logIndex === log.logIndex) ?? []
  return (
    receipt?.status === '0x1' &&
    receipt.transactionHash === log.transactionHash &&
    receipt.blockHash === log.blockHash &&
    receipt.blockNumber === log.blockNumber &&
    header?.hash === log.blockHash &&
    matching.length === 1 &&
    same(matching[0].address, VAULT) &&
    matching[0].data === log.data &&
    JSON.stringify(matching[0].topics) === JSON.stringify(log.topics) &&
    matching[0].transactionHash === log.transactionHash &&
    matching[0].blockHash === log.blockHash
  )
}

/** Recent request log is a screening source; current pinned cooldown state decides eligibility. */
export async function findPendingCandidate(primary, secondary, anchor) {
  const end = BigInt(anchor.blockNumber)
  const start = end > LOOKBACK ? end - LOOKBACK : 1n
  const seen = new Set()
  const candidates = []
  for (let from = start; from < end; from += 10n) {
    const to = from + 9n < end ? from + 9n : end - 1n
    const logs = await primary.request('eth_getLogs', [
      {
        address: VAULT,
        topics: [WITHDRAW_TOPIC],
        fromBlock: numberHex(from),
        toBlock: numberHex(to),
      },
    ])
    if (!Array.isArray(logs) || logs.length > 256) throw Error('susde_candidate_logs_unavailable')
    for (const log of logs) {
      const candidate = candidateFromLog(log, start, end)
      if (candidate) candidates.push(candidate)
    }
  }
  candidates.sort((a, b) =>
    BigInt(b.blockNumber) > BigInt(a.blockNumber)
      ? 1
      : BigInt(b.blockNumber) < BigInt(a.blockNumber)
        ? -1
        : BigInt(b.logIndex) > BigInt(a.logIndex)
          ? 1
          : -1,
  )
  const screened = []
  for (const candidate of candidates) {
    if (seen.has(candidate.holder)) continue
    seen.add(candidate.holder)
    if (screened.length >= MAX_SCREENED) break
    const row = {
      holderCommitment: sha(`${VAULT}:${candidate.holder}`),
      discoveryTransactionHash: candidate.transactionHash,
      discoveryLogIndex: candidate.logIndex,
      discoveryBlock: candidate.blockNumber,
      status: 'unchecked',
    }
    screened.push(row)
    const [receipt, header, peerHeader] = await Promise.all([
      primary.request('eth_getTransactionReceipt', [candidate.transactionHash]),
      primary.request('eth_getBlockByNumber', [numberHex(candidate.blockNumber), false]),
      secondary.request('eth_getBlockByNumber', [numberHex(candidate.blockNumber), false]),
    ])
    if (!receiptAttests(candidate, receipt, header) || peerHeader?.hash !== header.hash) {
      row.status = 'receipt_or_header_mismatch'
      continue
    }
    row.receiptDigest = sha(
      JSON.stringify({
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        status: receipt.status,
        logs: receipt.logs,
      }),
    )
    row.receiptProof = {
      status: receipt.status,
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      discoveryLog: candidate.log,
      receiptLog: receipt.logs.find((item) => item.logIndex === candidate.log.logIndex),
      witnessBlockHash: peerHeader.hash,
    }
    const measurement = await measureTwoOrigins(primary, secondary, anchor, candidate.holder)
    if (BigInt(measurement.pendingAssetsRaw) === 0n) {
      row.status = 'no_current_pending'
      continue
    }
    row.status = 'selected'
    return { holder: candidate.holder, measurement, screened }
  }
  return { holder: null, measurement: null, screened }
}

export function validateIssue(issue) {
  if (
    issue?.study !== STUDY ||
    !Number.isSafeInteger(issue.sequence) ||
    issue.sequence < 1 ||
    issue.chainId !== 1 ||
    issue.routeKey !== ROUTE_KEY ||
    issue.vault !== VAULT ||
    issue.originalAsset !== USDE ||
    issue.silo !== SILO ||
    !HORIZONS_HOURS.every((h, i) => issue.targets?.[i]?.horizonHours === h) ||
    issue.targets?.length !== HORIZONS_HOURS.length ||
    !DECIMAL.test(issue.anchor?.blockNumber ?? '') ||
    !HASH.test(issue.anchor?.blockHash ?? '') ||
    !ADDRESS.test(issue.holder ?? '') ||
    !DECIMAL.test(issue.pendingAssetsRaw ?? '') ||
    BigInt(issue.pendingAssetsRaw) === 0n ||
    issue.measurement?.holder !== issue.holder ||
    issue.measurement?.pendingAssetsRaw !== issue.pendingAssetsRaw ||
    issue.measurement?.cooldownEndUtc !== issue.cooldownEndUtc ||
    issue.measurement?.blockHash !== issue.anchor.blockHash ||
    issue.measurement?.blockNumber !== issue.anchor.blockNumber ||
    issue.measurement?.minedDeliveryProven !== false ||
    issue.measurement?.readOnly !== true ||
    issue.measurement?.primaryProvider !== issue.anchor.primaryProvider ||
    issue.measurement?.secondaryProvider !== issue.anchor.secondaryProvider ||
    issue.measurement.primaryProvider === issue.measurement.secondaryProvider ||
    !Array.isArray(issue.screened) ||
    !issue.screened.some((r) => {
      const proof = r.receiptProof
      const log = proof?.discoveryLog
      return (
        r.status === 'selected' &&
        r.holderCommitment === sha(`${VAULT}:${issue.holder}`) &&
        r.discoveryTransactionHash === proof?.transactionHash &&
        r.discoveryBlock === BigInt(proof?.blockNumber ?? -1).toString() &&
        r.discoveryLogIndex === BigInt(log?.logIndex ?? -1).toString() &&
        proof?.status === '0x1' &&
        proof.blockHash === log?.blockHash &&
        proof.witnessBlockHash === proof.blockHash &&
        proof.transactionHash === log.transactionHash &&
        proof.blockNumber === log.blockNumber &&
        proof.receiptLog?.logIndex === log.logIndex &&
        proof.receiptLog?.transactionHash === log.transactionHash &&
        proof.receiptLog?.blockHash === log.blockHash &&
        proof.receiptLog?.blockNumber === log.blockNumber &&
        proof.receiptLog?.data === log.data &&
        JSON.stringify(proof.receiptLog?.topics) === JSON.stringify(log.topics) &&
        log.address === VAULT &&
        log.topics?.[0] === WITHDRAW_TOPIC &&
        `0x${log.topics?.[2]?.slice(-40)}` === SILO &&
        `0x${log.topics?.[3]?.slice(-40)}` === issue.holder &&
        /^0x[0-9a-f]{128}$/.test(log.data ?? '') &&
        BigInt(`0x${log.data.slice(2, 66)}`) > 0n &&
        BigInt(r.discoveryBlock) < BigInt(issue.anchor.blockNumber)
      )
    })
  )
    throw Error('susde_issue_invalid')
  const issued = utc(issue.issuedAtUtc)
  if (
    utc(issue.anchor.observedAtUtc) > issued ||
    issued - utc(issue.anchor.observedAtUtc) > 10 * 60_000 ||
    issued - utc(issue.anchor.blockAtUtc) > 60 * 60_000 ||
    issued - utc(issue.anchor.blockAtUtc) < -120_000 ||
    utc(issue.cooldownEndUtc) <= 0 ||
    issue.targets.some(
      (t) =>
        t.targetAtUtc !== new Date(issued + t.horizonHours * 3_600_000).toISOString() ||
        t.captureDeadlineUtc !==
          new Date(issued + (t.horizonHours + DEADLINE_HOURS) * 3_600_000).toISOString(),
    )
  )
    throw Error('susde_issue_time_invalid')
  validatePendingMeasurement(issue.measurement, issue.anchor, issue.holder)
  return issue
}

export function buildIssue({ anchor, candidate, issuedAtUtc, sequence, previousSha256 }) {
  if (!candidate?.holder || !candidate.measurement) throw Error('susde_no_pending_candidate')
  const issued = utc(issuedAtUtc)
  const body = {
    study: STUDY,
    sequence,
    previousSha256,
    chainId: 1,
    routeKey: ROUTE_KEY,
    vault: VAULT,
    originalAsset: USDE,
    silo: SILO,
    issuedAtUtc,
    anchor,
    holder: candidate.holder,
    pendingAssetsRaw: candidate.measurement.pendingAssetsRaw,
    cooldownEndUtc: candidate.measurement.cooldownEndUtc,
    measurement: candidate.measurement,
    screened: candidate.screened,
    targets: HORIZONS_HOURS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(issued + horizonHours * 3_600_000).toISOString(),
      captureDeadlineUtc: new Date(
        issued + (horizonHours + DEADLINE_HOURS) * 3_600_000,
      ).toISOString(),
    })),
    estimand: 'existing_pending_whole_queue_unstake_simulation',
    minedDeliveryProven: false,
    representativeCohort: false,
  }
  validateIssue(body)
  return seal(body)
}

export async function verifyIssues(out = OUT) {
  const rows = await readLedger(out)
  rows.forEach(validateIssue)
  return rows
}

export async function issuePending({
  urls,
  out = OUT,
  now = () => new Date(),
  clients = publicRpcClients,
} = {}) {
  const rows = await verifyIssues(out)
  let lastError = Error('susde_public_issue_unavailable')
  let selectedCandidateFailed = false
  const diagnostic = {
    pairsAttempted: 0,
    completedNoCandidateScans: 0,
    screenedStatuses: {
      receipt_or_header_mismatch: 0,
      no_current_pending: 0,
    },
    failures: {},
  }
  for (const [primary, secondary] of publicOriginPairs(urls, clients)) {
    diagnostic.pairsAttempted++
    try {
      const anchor = await finalizedAnchor(primary, secondary, now)
      const candidate = await findPendingCandidate(primary, secondary, anchor)
      if (!candidate.holder) {
        diagnostic.completedNoCandidateScans++
        for (const row of candidate.screened) {
          if (Object.hasOwn(diagnostic.screenedStatuses, row.status))
            diagnostic.screenedStatuses[row.status]++
        }
        continue
      }
      selectedCandidateFailed = true
      const issue = buildIssue({
        anchor,
        candidate,
        issuedAtUtc: now().toISOString(),
        sequence: rows.length + 1,
        previousSha256: rows.at(-1)?.sha256 ?? null,
      })
      await appendLedger(out, issue, verifyIssues)
      return { sequence: issue.sequence, pendingAssetsRaw: issue.pendingAssetsRaw }
    } catch (error) {
      lastError = error
      const code = /^susde_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'rpc_or_provider_unavailable'
      diagnostic.failures[code] = (diagnostic.failures[code] ?? 0) + 1
    }
  }
  const status =
    diagnostic.completedNoCandidateScans && !selectedCandidateFailed
      ? 'susde_no_screened_pending_candidate'
      : /^susde_[a-z0-9_]+$/.test(lastError.message)
        ? lastError.message
        : 'susde_public_issue_unavailable'
  const failure = Error(status)
  failure.diagnostic = diagnostic
  throw failure
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  try {
    if (mode === '--verify')
      console.log(JSON.stringify({ verified: (await verifyIssues()).length }))
    else if (mode === '--issue' || mode === '--diagnose') {
      const result = await issuePending({ urls: configuredPublicRpcUrls(readEnv()) })
      console.log(JSON.stringify({ sequence: result.sequence, status: 'issued' }))
    } else throw Error('susde_issue_usage')
  } catch (error) {
    const status = /^susde_[a-z0-9_]+$/.test(error?.message ?? '')
      ? error.message
      : 'susde_issue_failed'
    console.error(
      mode === '--diagnose'
        ? JSON.stringify({ status, diagnostic: error.diagnostic ?? null })
        : status,
    )
    process.exitCode = 1
  }
}
