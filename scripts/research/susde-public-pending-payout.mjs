// A mined payout of the SAME already-pending sUSDe queue episode. This is a
// separate proof lane: pending issue/score semantics remain simulation-only.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFunctionData, parseAbi, toEventSelector } from 'viem'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { OUT as ISSUE_OUT, verifyIssues } from './susde-public-pending-exit-issue.mjs'
import {
  ADDRESS,
  DECIMAL,
  HASH,
  ROUTE_KEY,
  SILO,
  USDE,
  VAULT,
  WITHDRAW_TOPIC,
  appendLedger,
  numberHex,
  readLedger,
  same,
  seal,
  sha,
  utc,
} from './susde-public-pending-exit-common.mjs'

export const STUDY = 'susde_public_pending_payout_v1'
export const OUT = resolve('data/research/venue-signals/susde-public-pending-payouts')
const ABI = parseAbi([
  'function unstake(address receiver)',
  'function cooldowns(address) view returns (uint104,uint256)',
  'function asset() view returns (address)',
  'function silo() view returns (address)',
])
const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const CHUNK_BLOCKS = 512n
export const MAX_CHUNKS = 128
const MAX_CALLS = 300
const MAX_MS = 180_000
const MAX_PROOF_BYTES = 220 * 1024
const topic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
const number = (value) => {
  if (!/^0x[0-9a-f]+$/i.test(value ?? '')) throw Error('susde_payout_hex_invalid')
  return BigInt(value)
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const providerHost = (provider) => {
  if (typeof provider !== 'string' || !provider) throw Error('susde_payout_origins_invalid')
  const hostname = provider.includes('://') ? new URL(provider).hostname : provider
  return hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const unstakeData = (holder) =>
  encodeFunctionData({ abi: ABI, functionName: 'unstake', args: [holder] })
const cooldownData = (holder) =>
  encodeFunctionData({ abi: ABI, functionName: 'cooldowns', args: [holder] })
const fingerprint = (hex) => {
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(hex ?? '') || hex.length > 49_154)
    throw Error('susde_payout_code_invalid')
  return { sha256: sha(Buffer.from(hex.slice(2), 'hex')), byteLength: (hex.length - 2) / 2 }
}
const addressWord = (hex) => {
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(hex ?? '')) throw Error('susde_payout_identity_invalid')
  return `0x${hex.slice(-40).toLowerCase()}`
}
const queue = (hex) => {
  if (!/^0x[0-9a-f]{128}$/i.test(hex ?? '')) throw Error('susde_payout_queue_invalid')
  return [BigInt(`0x${hex.slice(2, 66)}`), BigInt(`0x${hex.slice(66)}`)]
}
const header = (row) => {
  if (
    !HASH.test(row?.hash ?? '') ||
    !DECIMAL.test(number(row?.number).toString()) ||
    !HASH.test(row?.parentHash ?? '') ||
    !/^0x[0-9a-f]+$/i.test(row?.timestamp ?? '')
  )
    throw Error('susde_payout_header_invalid')
  return {
    number: row.number,
    hash: row.hash,
    parentHash: row.parentHash,
    timestamp: row.timestamp,
  }
}
const compactTx = (row) => {
  if (
    !HASH.test(row?.hash ?? '') ||
    !HASH.test(row?.blockHash ?? '') ||
    !ADDRESS.test(row?.from ?? '') ||
    !ADDRESS.test(row?.to ?? '') ||
    !/^0x[0-9a-f]*$/i.test(row?.input ?? '')
  )
    throw Error('susde_payout_tx_invalid')
  return {
    hash: row.hash,
    blockHash: row.blockHash,
    blockNumber: row.blockNumber,
    transactionIndex: row.transactionIndex,
    from: row.from.toLowerCase(),
    to: row.to.toLowerCase(),
    input: row.input.toLowerCase(),
    nonce: row.nonce,
  }
}
const compactLog = (row) => ({
  address: row.address?.toLowerCase(),
  topics: row.topics?.map((v) => v.toLowerCase()),
  data: row.data?.toLowerCase(),
  blockNumber: row.blockNumber,
  blockHash: row.blockHash,
  transactionHash: row.transactionHash,
  transactionIndex: row.transactionIndex,
  logIndex: row.logIndex,
  removed: row.removed ?? false,
})
const compactReceipt = (row) => {
  if (
    !HASH.test(row?.transactionHash ?? '') ||
    !HASH.test(row?.blockHash ?? '') ||
    !Array.isArray(row.logs) ||
    row.logs.length > 128
  )
    throw Error('susde_payout_receipt_invalid')
  return {
    transactionHash: row.transactionHash,
    blockHash: row.blockHash,
    blockNumber: row.blockNumber,
    transactionIndex: row.transactionIndex,
    status: row.status,
    logs: row.logs.map(compactLog),
  }
}
const chunks = (from, to) => {
  const rows = []
  for (let start = from; start <= to; start += CHUNK_BLOCKS) {
    if (rows.length >= MAX_CHUNKS) return null
    const end = start + CHUNK_BLOCKS - 1n < to ? start + CHUNK_BLOCKS - 1n : to
    rows.push({ fromBlock: numberHex(start), toBlock: numberHex(end) })
  }
  return rows
}
const filter = (range, holder) => ({
  address: VAULT,
  topics: [WITHDRAW_TOPIC, null, topic(SILO), topic(holder)],
  ...range,
})
const transferFilter = (range, holder) => ({
  address: USDE,
  topics: [TRANSFER_TOPIC, topic(SILO), topic(holder)],
  ...range,
})
const validateLog = (log, range, holder, payoutBlock) => {
  if (
    !same(log.address, VAULT) ||
    log.topics?.length !== 4 ||
    !log.topics.every((value) => /^0x[0-9a-f]{64}$/i.test(value ?? '')) ||
    !equal(log.topics, [WITHDRAW_TOPIC, log.topics?.[1], topic(SILO), topic(holder)]) ||
    !/^0x[0-9a-f]{128}$/i.test(log.data ?? '') ||
    log.removed !== false ||
    !HASH.test(log.blockHash ?? '') ||
    !HASH.test(log.transactionHash ?? '') ||
    number(log.blockNumber) < number(range.fromBlock) ||
    number(log.blockNumber) > number(range.toBlock) ||
    number(log.blockNumber) > payoutBlock ||
    number(log.transactionIndex) < 0n ||
    number(log.logIndex) < 0n
  )
    throw Error('susde_payout_continuity_log_invalid')
}

/** Replays the bounded two-origin witness without contacting RPC. */
export function validatePayout(row, issues) {
  const issue = issues[row?.issueSequence - 1]
  if (
    !issue ||
    row.study !== STUDY ||
    row.issueSha256 !== issue.sha256 ||
    row.routeKey !== ROUTE_KEY ||
    row.vault !== VAULT ||
    row.asset !== USDE ||
    row.silo !== SILO ||
    row.holder !== issue.holder ||
    row.pendingAssetsRaw !== issue.pendingAssetsRaw ||
    row.cooldownEndUtc !== issue.cooldownEndUtc ||
    row.outcome !== 'mined_payout_episode_attested' ||
    row.sameEpisodeEvidenceLevel !== 'two_origin_rpc_log_attested' ||
    row.cryptographicAbsenceProven !== false ||
    row.minedDeliveryProven !== true ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !Array.isArray(row.origins) ||
    row.origins.length !== 2 ||
    providerHost(row.origins[0]?.provider) === providerHost(row.origins[1]?.provider)
  )
    throw Error('susde_payout_issue_binding_invalid')
  const [a, b] = row.origins
  // Origins may have different (later) finalized heads; the payout block and
  // every economic witness must agree byte for byte.
  if (!equal({ ...a, provider: null, finalized: null }, { ...b, provider: null, finalized: null }))
    throw Error('susde_payout_origin_disagreement')
  const proof = a
  for (const origin of row.origins) {
    if (origin.chainId !== '0x1') throw Error('susde_payout_chain_invalid')
    if (
      number(origin.finalized?.number) < number(origin.block?.number) ||
      (number(origin.finalized.number) === number(origin.block.number) &&
        origin.finalized.hash !== origin.block.hash)
    )
      throw Error('susde_payout_not_finalized')
  }
  const tx = proof.tx
  const receipt = proof.receipt
  const payoutBlock = number(proof.block?.number)
  const payoutTime = new Date(Number(number(proof.block?.timestamp)) * 1000).toISOString()
  if (
    !HASH.test(row.transactionHash ?? '') ||
    tx?.hash !== row.transactionHash ||
    receipt?.transactionHash !== tx.hash ||
    tx.blockHash !== proof.block?.hash ||
    receipt.blockHash !== proof.block.hash ||
    number(tx.blockNumber) !== payoutBlock ||
    number(receipt.blockNumber) !== payoutBlock ||
    number(tx.transactionIndex) !== number(receipt.transactionIndex) ||
    !same(tx.from, issue.holder) ||
    !same(tx.to, VAULT) ||
    tx.input !== unstakeData(issue.holder).toLowerCase() ||
    receipt.status !== '0x1' ||
    payoutBlock <= BigInt(issue.anchor.blockNumber) ||
    row.paidAtUtc !== payoutTime ||
    utc(payoutTime) < utc(issue.issuedAtUtc) ||
    utc(payoutTime) < utc(issue.cooldownEndUtc) ||
    utc(row.witnessedAtUtc) < utc(payoutTime) ||
    number(proof.anchorNonce) !== number(tx.nonce) ||
    number(proof.postNonce) !== number(tx.nonce) + 1n ||
    proof.ownerCode !== '0x' ||
    !equal(proof.vaultCode, issue.measurement.evidence[0].calls.vaultCode.result) ||
    !equal(proof.assetCode, issue.measurement.evidence[0].calls.assetCode.result) ||
    !equal(proof.siloCode, issue.measurement.evidence[0].calls.siloCode.result) ||
    !same(addressWord(proof.asset), USDE) ||
    !same(addressWord(proof.silo), SILO)
  )
    throw Error('susde_payout_tx_proof_invalid')
  const [end, amount] = queue(proof.postCooldown)
  if (end !== 0n || amount !== 0n) throw Error('susde_payout_queue_not_cleared')
  const transfers = receipt.logs.filter(
    (log) =>
      same(log.address, USDE) &&
      log.topics?.[0] === TRANSFER_TOPIC &&
      log.topics?.[1] === topic(SILO),
  )
  if (
    transfers.length !== 1 ||
    transfers[0].topics.length !== 3 ||
    transfers[0].topics[2] !== topic(issue.holder) ||
    number(transfers[0].data) !== BigInt(issue.pendingAssetsRaw) ||
    transfers[0].transactionHash !== tx.hash ||
    transfers[0].blockHash !== proof.block.hash ||
    number(transfers[0].transactionIndex) !== number(tx.transactionIndex) ||
    number(transfers[0].blockNumber) !== payoutBlock ||
    transfers[0].removed !== false
  )
    throw Error('susde_payout_transfer_invalid')
  const expected = chunks(BigInt(issue.anchor.blockNumber) + 1n, payoutBlock)
  if (
    !expected ||
    !equal(
      proof.continuity.map((item) => item.range),
      expected,
    )
  )
    throw Error('susde_payout_continuity_incomplete')
  for (const item of proof.continuity) {
    if (!Array.isArray(item.logs) || item.logs.length > 128)
      throw Error('susde_payout_logs_invalid')
    for (const log of item.logs) {
      validateLog(log, item.range, issue.holder, payoutBlock)
      if (
        number(log.blockNumber) < payoutBlock ||
        number(log.transactionIndex) <= number(tx.transactionIndex)
      )
        throw Error('susde_payout_queue_reset_ambiguous')
    }
  }
  if (Buffer.byteLength(JSON.stringify(row)) > MAX_PROOF_BYTES)
    throw Error('susde_payout_proof_large')
  return row
}

export async function verifyPayouts(out = OUT, issueOut = ISSUE_OUT) {
  const [rows, issues] = await Promise.all([readLedger(out), verifyIssues(issueOut)])
  rows.forEach((row) => validatePayout(row, issues))
  const seen = new Set()
  for (const row of rows) {
    const key = row.issueSequence
    if (seen.has(key)) throw Error('susde_payout_duplicate')
    seen.add(key)
  }
  return rows
}

/** Candidate discovery is a complete bounded RPC log scan, never payout proof. */
export async function discoverCandidateHashes(
  issue,
  primary,
  secondary,
  nowMs = Date.now,
  budget = { calls: 0, deadline: nowMs() + MAX_MS },
) {
  if (primary?.provider === secondary?.provider || !DECIMAL.test(issue?.anchor?.blockNumber ?? ''))
    throw Error('susde_payout_discovery_input_invalid')
  const request = async (client, method, params) => {
    if (++budget.calls > MAX_CALLS || nowMs() > budget.deadline)
      throw Error('susde_payout_discovery_budget_exhausted')
    return client.request(method, params)
  }
  try {
    const [chainA, chainB, finalizedA, finalizedB] = await Promise.all([
      request(primary, 'eth_chainId', []),
      request(secondary, 'eth_chainId', []),
      request(primary, 'eth_getBlockByNumber', ['finalized', false]),
      request(secondary, 'eth_getBlockByNumber', ['finalized', false]),
    ])
    if (chainA !== '0x1' || chainB !== '0x1') throw Error('susde_payout_discovery_chain_invalid')
    const finalizedHeaderA = header(finalizedA)
    const finalizedHeaderB = header(finalizedB)
    const end =
      number(finalizedHeaderA.number) < number(finalizedHeaderB.number)
        ? number(finalizedHeaderA.number)
        : number(finalizedHeaderB.number)
    const start = BigInt(issue.anchor.blockNumber) + 1n
    if (end < start) return { status: 'susde_payout_discovery_not_yet_finalized' }
    const ranges = chunks(start, end)
    if (!ranges) return { status: 'susde_payout_discovery_range_unavailable' }
    const [headA, headB] = await Promise.all([
      request(primary, 'eth_getBlockByNumber', [numberHex(end), false]),
      request(secondary, 'eth_getBlockByNumber', [numberHex(end), false]),
    ])
    const hA = header(headA)
    const hB = header(headB)
    if (
      number(hA.number) !== end ||
      !equal(hA, hB) ||
      (number(finalizedA.number) === end && finalizedA.hash !== hA.hash) ||
      (number(finalizedB.number) === end && finalizedB.hash !== hB.hash)
    )
      throw Error('susde_payout_discovery_origin_disagreement')
    const found = new Set()
    for (const range of ranges) {
      const query = transferFilter(range, issue.holder)
      const [rawA, rawB] = await Promise.all([
        request(primary, 'eth_getLogs', [query]),
        request(secondary, 'eth_getLogs', [query]),
      ])
      if (
        !Array.isArray(rawA) ||
        !Array.isArray(rawB) ||
        rawA.length > 128 ||
        rawB.length > 128 ||
        Buffer.byteLength(JSON.stringify(rawA)) > 64 * 1024 ||
        Buffer.byteLength(JSON.stringify(rawB)) > 64 * 1024
      )
        throw Error('susde_payout_discovery_logs_unavailable')
      let logsA
      let logsB
      try {
        logsA = rawA.map(compactLog)
        logsB = rawB.map(compactLog)
      } catch {
        throw Error('susde_payout_discovery_log_invalid')
      }
      if (!equal(logsA, logsB)) throw Error('susde_payout_discovery_origin_disagreement')
      for (const log of logsA) {
        if (
          !same(log.address, USDE) ||
          log.topics?.length !== 3 ||
          !equal(log.topics, [TRANSFER_TOPIC, topic(SILO), topic(issue.holder)]) ||
          !/^0x[0-9a-f]{64}$/i.test(log.data ?? '') ||
          log.removed !== false ||
          !HASH.test(log.blockHash ?? '') ||
          !HASH.test(log.transactionHash ?? '') ||
          number(log.blockNumber) < number(range.fromBlock) ||
          number(log.blockNumber) > number(range.toBlock) ||
          number(log.transactionIndex) < 0n ||
          number(log.logIndex) < 0n
        )
          throw Error('susde_payout_discovery_log_invalid')
        found.add(log.transactionHash)
        if (found.size > 128) throw Error('susde_payout_discovery_candidates_large')
      }
    }
    if (nowMs() > budget.deadline) throw Error('susde_payout_discovery_budget_exhausted')
    return {
      status: 'complete',
      candidateTransactionHashes: [...found],
      fromBlock: start.toString(),
      throughFinalizedBlock: end.toString(),
      scannedWindows: ranges.length,
    }
  } catch (error) {
    const code = ['susde_payout_header_invalid', 'susde_payout_hex_invalid'].includes(
      error?.message,
    )
      ? 'susde_payout_discovery_evidence_invalid'
      : error?.message
    return {
      status: /^susde_payout_discovery_[a-z0-9_]+$/.test(code ?? '')
        ? code
        : 'susde_payout_discovery_rpc_unavailable',
    }
  }
}

/** A transport outage can be retried; any economic disagreement stops the search. */
export async function discoverAcrossPairs(issue, peers, nowMs = Date.now) {
  if (!Array.isArray(peers) || peers.length < 2 || peers.length > 8)
    throw Error('susde_payout_discovery_origins_invalid')
  const budget = { calls: 0, deadline: nowMs() + MAX_MS }
  const screened = await Promise.allSettled(
    peers.map(async (peer) => {
      if (++budget.calls > MAX_CALLS || nowMs() > budget.deadline)
        throw Error('susde_payout_discovery_budget_exhausted')
      return peer.request('eth_chainId', [])
    }),
  )
  if (screened.some((result) => result.status === 'fulfilled' && result.value !== '0x1'))
    return { status: 'susde_payout_discovery_chain_invalid' }
  if (nowMs() > budget.deadline || budget.calls >= MAX_CALLS)
    return { status: 'susde_payout_discovery_budget_exhausted' }
  const healthy = peers.filter((_, index) => screened[index].status === 'fulfilled')
  if (healthy.length < 2) return { status: 'susde_payout_discovery_rpc_unavailable' }
  let attempted = 0
  const seen = new Set()
  for (let offset = 1; offset < healthy.length && attempted < 6; offset++) {
    for (let i = 0; i < healthy.length && attempted < 6; i++) {
      const j = (i + offset) % healthy.length
      const pairKey = [Math.min(i, j), Math.max(i, j)].join(':')
      if (seen.has(pairKey)) continue
      seen.add(pairKey)
      if (healthy[i].provider === healthy[j].provider) continue
      attempted++
      const result = await discoverCandidateHashes(issue, healthy[i], healthy[j], nowMs, budget)
      if (result.status !== 'susde_payout_discovery_rpc_unavailable') return result
      if (nowMs() > budget.deadline || budget.calls >= MAX_CALLS)
        return { status: 'susde_payout_discovery_budget_exhausted' }
    }
  }
  return {
    status: attempted
      ? 'susde_payout_discovery_rpc_unavailable'
      : 'susde_payout_discovery_origins_invalid',
  }
}

export async function discoverPayoutCandidates({
  issueSequence,
  urls,
  issueOut = ISSUE_OUT,
  clients = publicRpcClients,
  nowMs = Date.now,
} = {}) {
  const issues = await verifyIssues(issueOut)
  const issue = issues[issueSequence - 1]
  if (!issue) throw Error('susde_payout_discovery_issue_unknown')
  return discoverAcrossPairs(issue, clients(urls), nowMs)
}

const captureOrigin = async (client, issue, transactionHash, budget) => {
  const request = async (method, params) => {
    if (++budget.calls > MAX_CALLS || Date.now() > budget.deadline)
      throw Error('susde_payout_budget_exhausted')
    return client.request(method, params)
  }
  const [chainId, rawTx, rawReceipt, finalized] = await Promise.all([
    request('eth_chainId', []),
    request('eth_getTransactionByHash', [transactionHash]),
    request('eth_getTransactionReceipt', [transactionHash]),
    request('eth_getBlockByNumber', ['finalized', false]),
  ])
  const tx = compactTx(rawTx)
  const receipt = compactReceipt(rawReceipt)
  const block = header(await request('eth_getBlockByNumber', [tx.blockNumber, false]))
  const payoutBlock = number(block.number)
  if (payoutBlock > number(finalized?.number)) throw Error('susde_payout_not_finalized')
  const pinned = pin(block.hash)
  const [
    anchorNonce,
    postNonce,
    ownerCode,
    vaultCode,
    assetCode,
    siloCode,
    asset,
    silo,
    postCooldown,
  ] = await Promise.all([
    request('eth_getTransactionCount', [issue.holder, pin(issue.anchor.blockHash)]),
    request('eth_getTransactionCount', [issue.holder, pinned]),
    request('eth_getCode', [issue.holder, pinned]),
    request('eth_getCode', [VAULT, pinned]),
    request('eth_getCode', [USDE, pinned]),
    request('eth_getCode', [SILO, pinned]),
    request('eth_call', [
      { to: VAULT, data: encodeFunctionData({ abi: ABI, functionName: 'asset' }) },
      pinned,
    ]),
    request('eth_call', [
      { to: VAULT, data: encodeFunctionData({ abi: ABI, functionName: 'silo' }) },
      pinned,
    ]),
    request('eth_call', [{ to: VAULT, data: cooldownData(issue.holder) }, pinned]),
  ])
  const ranges = chunks(BigInt(issue.anchor.blockNumber) + 1n, payoutBlock)
  if (!ranges) throw Error('susde_payout_continuity_range_unavailable')
  const continuity = []
  for (const range of ranges) {
    const raw = await request('eth_getLogs', [filter(range, issue.holder)])
    if (!Array.isArray(raw) || raw.length > 128) throw Error('susde_payout_logs_unavailable')
    continuity.push({ range, logs: raw.map(compactLog) })
  }
  return {
    provider: client.provider,
    chainId,
    tx,
    receipt,
    block,
    finalized: header(finalized),
    anchorNonce,
    postNonce,
    ownerCode,
    vaultCode: fingerprint(vaultCode),
    assetCode: fingerprint(assetCode),
    siloCode: fingerprint(siloCode),
    asset,
    silo,
    postCooldown,
    continuity,
  }
}

/** Caller supplies an observed transaction hash; capture never broadcasts. */
export async function attestPayout({
  issueSequence,
  transactionHash,
  urls,
  out = OUT,
  issueOut = ISSUE_OUT,
  clients = publicRpcClients,
  now = () => new Date(),
} = {}) {
  const issues = await verifyIssues(issueOut)
  const issue = issues[issueSequence - 1]
  if (!issue || !HASH.test(transactionHash ?? '')) throw Error('susde_payout_input_invalid')
  const existing = await verifyPayouts(out, issueOut)
  if (
    existing.some((r) => r.issueSequence === issueSequence && r.transactionHash === transactionHash)
  )
    return { status: 'already_proven' }
  if (existing.some((r) => r.issueSequence === issueSequence))
    return { status: 'susde_payout_issue_already_proven' }
  const pair = clients(urls)
  if (
    !Array.isArray(pair) ||
    pair.length < 2 ||
    providerHost(pair[0].provider) === providerHost(pair[1].provider)
  )
    throw Error('susde_payout_origins_invalid')
  const budget = { calls: 0, deadline: Date.now() + MAX_MS }
  let origins
  try {
    origins = await Promise.all(
      pair.slice(0, 2).map((client) => captureOrigin(client, issue, transactionHash, budget)),
    )
  } catch (error) {
    return {
      status: /^susde_payout_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'susde_payout_rpc_unavailable',
    }
  }
  const body = {
    study: STUDY,
    sequence: existing.length + 1,
    previousSha256: existing.at(-1)?.sha256 ?? null,
    issueSequence,
    issueSha256: issue.sha256,
    routeKey: ROUTE_KEY,
    vault: VAULT,
    asset: USDE,
    silo: SILO,
    holder: issue.holder,
    pendingAssetsRaw: issue.pendingAssetsRaw,
    cooldownEndUtc: issue.cooldownEndUtc,
    transactionHash,
    paidAtUtc: new Date(Number(number(origins[0].block.timestamp)) * 1000).toISOString(),
    witnessedAtUtc: now().toISOString(),
    outcome: 'mined_payout_episode_attested',
    sameEpisodeEvidenceLevel: 'two_origin_rpc_log_attested',
    cryptographicAbsenceProven: false,
    minedDeliveryProven: true,
    origins,
  }
  try {
    validatePayout(body, issues)
  } catch (error) {
    return {
      status: /^susde_payout_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'susde_payout_ambiguous',
    }
  }
  const row = seal(body)
  await appendLedger(out, row, (directory) => verifyPayouts(directory, issueOut))
  return { status: 'proven', sequence: row.sequence, transactionHash }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--verify')
      console.log(JSON.stringify({ verified: (await verifyPayouts()).length }))
    else if (process.argv[2] === '--discover') {
      const issueSequence = Number(process.argv[3])
      if (!Number.isSafeInteger(issueSequence) || issueSequence < 1)
        throw Error('susde_payout_discovery_issue_unknown')
      const result = await discoverPayoutCandidates({
        issueSequence,
        urls: configuredPublicRpcUrls(readEnv()),
      })
      console.log(JSON.stringify(result))
      if (result.status !== 'complete') process.exitCode = 1
    } else if (process.argv[2] === '--attest') {
      const issueSequence = Number(process.argv[3])
      const transactionHash = process.argv[4]
      const result = await attestPayout({
        issueSequence,
        transactionHash,
        urls: configuredPublicRpcUrls(readEnv()),
      })
      console.log(JSON.stringify(result))
      if (result.status !== 'proven' && result.status !== 'already_proven') process.exitCode = 1
    } else throw Error('susde_payout_usage')
  } catch (error) {
    console.error(
      /^susde_payout_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'susde_payout_failed',
    )
    process.exitCode = 1
  }
}
