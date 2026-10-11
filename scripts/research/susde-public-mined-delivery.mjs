// Positive mined USDe delivery. Attribution to the pending issue's queue
// episode is explicitly unresolved until full continuity is attested elsewhere.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFunctionData, parseAbi, toEventSelector } from 'viem'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { OUT as ISSUE_OUT, verifyIssues } from './susde-public-pending-exit-issue.mjs'
import {
  ADDRESS,
  HASH,
  ROUTE_KEY,
  SILO,
  USDE,
  VAULT,
  appendLedger,
  readLedger,
  same,
  seal,
  sha,
  utc,
} from './susde-public-pending-exit-common.mjs'

export const STUDY = 'susde_public_mined_delivery_v1'
export const OUT = resolve('data/research/venue-signals/susde-public-mined-deliveries')
const ABI = parseAbi([
  'function unstake(address)',
  'function asset() view returns (address)',
  'function silo() view returns (address)',
])
const TRANSFER = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const MAX_MS = 180_000
const MAX_CALLS = 100
const MAX_RECORD_BYTES = 120 * 1024
const topic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const providerHost = (provider) => {
  if (typeof provider !== 'string' || !provider) throw Error('susde_delivery_origin_invalid')
  const hostname = provider.includes('://') ? new URL(provider).hostname : provider
  return hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}
const hexNumber = (value) => {
  if (!/^0x[0-9a-f]+$/i.test(value ?? '')) throw Error('susde_delivery_hex_invalid')
  return BigInt(value)
}
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const fingerprint = (value) => {
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(value ?? '') || value.length > 49_154)
    throw Error('susde_delivery_code_invalid')
  return { sha256: sha(Buffer.from(value.slice(2), 'hex')), byteLength: (value.length - 2) / 2 }
}
const addressWord = (value) => {
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(value ?? '')) throw Error('susde_delivery_identity_invalid')
  return `0x${value.slice(-40).toLowerCase()}`
}
const header = (value) => {
  if (
    !HASH.test(value?.hash ?? '') ||
    !HASH.test(value?.parentHash ?? '') ||
    !/^0x[0-9a-f]+$/i.test(value?.number ?? '') ||
    !/^0x[0-9a-f]+$/i.test(value?.timestamp ?? '')
  )
    throw Error('susde_delivery_header_invalid')
  return {
    number: value.number,
    hash: value.hash,
    parentHash: value.parentHash,
    timestamp: value.timestamp,
  }
}
const compactTx = (value) => {
  if (
    !HASH.test(value?.hash ?? '') ||
    !HASH.test(value?.blockHash ?? '') ||
    !ADDRESS.test(value?.from ?? '') ||
    !ADDRESS.test(value?.to ?? '') ||
    !/^0x[0-9a-f]*$/i.test(value?.input ?? '')
  )
    throw Error('susde_delivery_tx_invalid')
  return {
    hash: value.hash,
    blockHash: value.blockHash,
    blockNumber: value.blockNumber,
    transactionIndex: value.transactionIndex,
    from: value.from.toLowerCase(),
    to: value.to.toLowerCase(),
    input: value.input.toLowerCase(),
  }
}
const compactLog = (value) => {
  if (
    !ADDRESS.test(value?.address ?? '') ||
    !Array.isArray(value?.topics) ||
    value.topics.length > 4 ||
    !value.topics.every((x) => HASH.test(x)) ||
    !/^0x[0-9a-f]*$/i.test(value?.data ?? '') ||
    !HASH.test(value?.transactionHash ?? '') ||
    !HASH.test(value?.blockHash ?? '')
  )
    throw Error('susde_delivery_log_invalid')
  return {
    address: value.address.toLowerCase(),
    topics: value.topics.map((x) => x.toLowerCase()),
    data: value.data.toLowerCase(),
    transactionHash: value.transactionHash,
    blockHash: value.blockHash,
    blockNumber: value.blockNumber,
    transactionIndex: value.transactionIndex,
    logIndex: value.logIndex,
    removed: value.removed ?? false,
  }
}
const compactReceipt = (value) => {
  if (
    !HASH.test(value?.transactionHash ?? '') ||
    !HASH.test(value?.blockHash ?? '') ||
    !Array.isArray(value?.logs) ||
    value.logs.length > 128 ||
    Buffer.byteLength(JSON.stringify(value.logs)) > 80 * 1024
  )
    throw Error('susde_delivery_receipt_invalid')
  return {
    transactionHash: value.transactionHash,
    blockHash: value.blockHash,
    blockNumber: value.blockNumber,
    transactionIndex: value.transactionIndex,
    status: value.status,
    logs: value.logs.map(compactLog),
  }
}

/** Replay only a positive delivery claim; queue episode/duration stay unresolved. */
export function validateDelivery(row, issues) {
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
    row.frozenPendingAssetsRaw !== issue.pendingAssetsRaw ||
    row.transactionHash == null ||
    row.deliveryStatus !== 'mined_transfer_attested' ||
    row.episodeAttribution !== 'unresolved' ||
    row.durationEstimated !== false ||
    row.forecastValidated !== false ||
    row.minedDeliveryProven !== true ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !Array.isArray(row.origins) ||
    row.origins.length !== 2 ||
    providerHost(row.origins[0]?.provider) === providerHost(row.origins[1]?.provider)
  )
    throw Error('susde_delivery_binding_invalid')
  const [a, b] = row.origins
  if (!equal({ ...a, provider: null, finalized: null }, { ...b, provider: null, finalized: null }))
    throw Error('susde_delivery_origin_disagreement')
  for (const origin of row.origins) {
    if (origin.chainId !== '0x1') throw Error('susde_delivery_chain_invalid')
    if (
      !equal(header(origin.block), origin.block) ||
      !equal(header(origin.finalized), origin.finalized) ||
      !equal(compactTx(origin.tx), origin.tx) ||
      !equal(compactReceipt(origin.receipt), origin.receipt)
    )
      throw Error('susde_delivery_evidence_invalid')
    if (
      hexNumber(origin.finalized?.number) < hexNumber(origin.block?.number) ||
      (hexNumber(origin.finalized.number) === hexNumber(origin.block.number) &&
        origin.finalized.hash !== origin.block.hash)
    )
      throw Error('susde_delivery_not_finalized')
  }
  const proof = a
  const tx = proof.tx
  const receipt = proof.receipt
  const block = proof.block
  const blockNumber = hexNumber(block.number)
  const blockAtUtc = new Date(Number(hexNumber(block.timestamp)) * 1000).toISOString()
  if (
    !HASH.test(row.transactionHash ?? '') ||
    tx?.hash !== row.transactionHash ||
    receipt?.transactionHash !== tx.hash ||
    tx.blockHash !== block.hash ||
    receipt.blockHash !== block.hash ||
    hexNumber(tx.blockNumber) !== blockNumber ||
    hexNumber(receipt.blockNumber) !== blockNumber ||
    hexNumber(tx.transactionIndex) !== hexNumber(receipt.transactionIndex) ||
    blockNumber <= BigInt(issue.anchor.blockNumber) ||
    !same(tx.from, issue.holder) ||
    !same(tx.to, VAULT) ||
    tx.input !==
      encodeFunctionData({
        abi: ABI,
        functionName: 'unstake',
        args: [issue.holder],
      }).toLowerCase() ||
    receipt.status !== '0x1' ||
    row.deliveredAtUtc !== blockAtUtc ||
    utc(blockAtUtc) < utc(issue.issuedAtUtc) ||
    utc(row.witnessedAtUtc) < utc(blockAtUtc) ||
    proof.holderCode !== '0x' ||
    !equal(proof.vaultCode, issue.measurement.evidence[0].calls.vaultCode.result) ||
    !equal(proof.assetCode, issue.measurement.evidence[0].calls.assetCode.result) ||
    !equal(proof.siloCode, issue.measurement.evidence[0].calls.siloCode.result) ||
    !same(addressWord(proof.asset), USDE) ||
    !same(addressWord(proof.silo), SILO)
  )
    throw Error('susde_delivery_tx_proof_invalid')
  const siloTransfers = receipt.logs.filter(
    (log) =>
      same(log.address, USDE) && log.topics?.[0] === TRANSFER && log.topics?.[1] === topic(SILO),
  )
  if (
    siloTransfers.length !== 1 ||
    siloTransfers[0].topics.length !== 3 ||
    siloTransfers[0].topics[2] !== topic(issue.holder) ||
    hexNumber(siloTransfers[0].data) !== BigInt(issue.pendingAssetsRaw) ||
    siloTransfers[0].transactionHash !== tx.hash ||
    siloTransfers[0].blockHash !== block.hash ||
    hexNumber(siloTransfers[0].blockNumber) !== blockNumber ||
    hexNumber(siloTransfers[0].transactionIndex) !== hexNumber(tx.transactionIndex) ||
    siloTransfers[0].removed !== false
  )
    throw Error('susde_delivery_transfer_invalid')
  if (Buffer.byteLength(JSON.stringify(row)) > MAX_RECORD_BYTES)
    throw Error('susde_delivery_record_large')
  return row
}

export async function verifyDeliveries(out = OUT, issueOut = ISSUE_OUT) {
  const [rows, issues] = await Promise.all([readLedger(out), verifyIssues(issueOut)])
  rows.forEach((row) => validateDelivery(row, issues))
  const seen = new Set()
  const seenIssues = new Set()
  for (const row of rows) {
    if (seen.has(row.transactionHash) || seenIssues.has(row.issueSequence))
      throw Error('susde_delivery_duplicate')
    seen.add(row.transactionHash)
    seenIssues.add(row.issueSequence)
  }
  return rows
}

const captureOrigin = async (client, issue, txHash, request) => {
  const [chainId, rawTx, rawReceipt, rawFinalized] = await Promise.all([
    request(client, 'eth_chainId', []),
    request(client, 'eth_getTransactionByHash', [txHash]),
    request(client, 'eth_getTransactionReceipt', [txHash]),
    request(client, 'eth_getBlockByNumber', ['finalized', false]),
  ])
  const tx = compactTx(rawTx)
  const receipt = compactReceipt(rawReceipt)
  const finalized = header(rawFinalized)
  const block = header(await request(client, 'eth_getBlockByNumber', [tx.blockNumber, false]))
  const pinned = pin(block.hash)
  const [holderCode, vaultCode, assetCode, siloCode, asset, silo] = await Promise.all([
    request(client, 'eth_getCode', [issue.holder, pinned]),
    request(client, 'eth_getCode', [VAULT, pinned]),
    request(client, 'eth_getCode', [USDE, pinned]),
    request(client, 'eth_getCode', [SILO, pinned]),
    request(client, 'eth_call', [
      { to: VAULT, data: encodeFunctionData({ abi: ABI, functionName: 'asset' }) },
      pinned,
    ]),
    request(client, 'eth_call', [
      { to: VAULT, data: encodeFunctionData({ abi: ABI, functionName: 'silo' }) },
      pinned,
    ]),
  ])
  return {
    provider: client.provider,
    chainId,
    tx,
    receipt,
    block,
    finalized,
    holderCode,
    vaultCode: fingerprint(vaultCode),
    assetCode: fingerprint(assetCode),
    siloCode: fingerprint(siloCode),
    asset,
    silo,
  }
}

/** A bounded transport retry cannot override an origin/economic disagreement. */
export async function captureDelivery(issue, transactionHash, peers, nowMs = Date.now) {
  if (
    !HASH.test(transactionHash ?? '') ||
    !Array.isArray(peers) ||
    peers.length < 2 ||
    peers.length > 8
  )
    throw Error('susde_delivery_input_invalid')
  const budget = { calls: 0, deadline: nowMs() + MAX_MS }
  const request = async (client, method, params) => {
    if (++budget.calls > MAX_CALLS || nowMs() > budget.deadline)
      throw Error('susde_delivery_budget_exhausted')
    return client.request(method, params)
  }
  const preflight = await Promise.allSettled(peers.map((peer) => request(peer, 'eth_chainId', [])))
  if (preflight.some((result) => result.status === 'fulfilled' && result.value !== '0x1'))
    return { status: 'susde_delivery_chain_invalid' }
  if (nowMs() > budget.deadline || budget.calls >= MAX_CALLS)
    return { status: 'susde_delivery_budget_exhausted' }
  const healthy = peers.filter((_, index) => preflight[index].status === 'fulfilled')
  if (healthy.length < 2) return { status: 'susde_delivery_rpc_unavailable' }
  const seen = new Set()
  let attempted = 0
  for (let offset = 1; offset < healthy.length && attempted < 6; offset++) {
    for (let i = 0; i < healthy.length && attempted < 6; i++) {
      const j = (i + offset) % healthy.length
      const id = [Math.min(i, j), Math.max(i, j)].join(':')
      if (seen.has(id)) continue
      seen.add(id)
      if (providerHost(healthy[i].provider) === providerHost(healthy[j].provider)) continue
      attempted++
      let origins
      try {
        origins = await Promise.all(
          [healthy[i], healthy[j]].map((peer) =>
            captureOrigin(peer, issue, transactionHash, request),
          ),
        )
      } catch (error) {
        if (error?.message === 'susde_delivery_budget_exhausted') return { status: error.message }
        if (/^susde_delivery_[a-z0-9_]+$/.test(error?.message ?? ''))
          return { status: 'susde_delivery_evidence_invalid' }
        continue // transport outage only
      }
      if (nowMs() > budget.deadline || budget.calls >= MAX_CALLS)
        return { status: 'susde_delivery_budget_exhausted' }
      if (
        !equal(
          { ...origins[0], provider: null, finalized: null },
          { ...origins[1], provider: null, finalized: null },
        )
      )
        return { status: 'susde_delivery_origin_disagreement' }
      return { status: 'captured', origins }
    }
  }
  return { status: attempted ? 'susde_delivery_rpc_unavailable' : 'susde_delivery_origins_invalid' }
}

export async function attestMinedDelivery({
  issueSequence,
  transactionHash,
  urls,
  out = OUT,
  issueOut = ISSUE_OUT,
  clients = publicRpcClients,
  now = () => new Date(),
  nowMs = Date.now,
} = {}) {
  const issues = await verifyIssues(issueOut)
  const issue = issues[issueSequence - 1]
  if (!issue || !HASH.test(transactionHash ?? '')) throw Error('susde_delivery_input_invalid')
  const existing = await verifyDeliveries(out, issueOut)
  if (existing.some((row) => row.transactionHash === transactionHash))
    return { status: 'already_attested' }
  if (existing.some((row) => row.issueSequence === issueSequence))
    return { status: 'susde_delivery_issue_already_attested' }
  const capture = await captureDelivery(issue, transactionHash, clients(urls), nowMs)
  if (capture.status !== 'captured') return capture
  const origins = capture.origins
  const deliveredAtUtc = new Date(
    Number(hexNumber(origins[0].block.timestamp)) * 1000,
  ).toISOString()
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
    frozenPendingAssetsRaw: issue.pendingAssetsRaw,
    transactionHash,
    deliveredAtUtc,
    witnessedAtUtc: now().toISOString(),
    deliveryStatus: 'mined_transfer_attested',
    episodeAttribution: 'unresolved',
    durationEstimated: false,
    forecastValidated: false,
    minedDeliveryProven: true,
    origins,
  }
  try {
    validateDelivery(body, issues)
  } catch (error) {
    return {
      status: /^susde_delivery_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'susde_delivery_evidence_invalid',
    }
  }
  const row = seal(body)
  await appendLedger(out, row, (directory) => verifyDeliveries(directory, issueOut))
  return { status: 'attested', sequence: row.sequence, transactionHash }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--verify')
      console.log(JSON.stringify({ verified: (await verifyDeliveries()).length }))
    else if (process.argv[2] === '--attest') {
      const issueSequence = Number(process.argv[3])
      if (!Number.isSafeInteger(issueSequence) || issueSequence < 1)
        throw Error('susde_delivery_input_invalid')
      const result = await attestMinedDelivery({
        issueSequence,
        transactionHash: process.argv[4],
        urls: configuredPublicRpcUrls(readEnv()),
      })
      console.log(JSON.stringify(result))
      if (!['attested', 'already_attested'].includes(result.status)) process.exitCode = 1
    } else throw Error('susde_delivery_usage')
  } catch (error) {
    console.error(
      /^susde_delivery_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'susde_delivery_failed',
    )
    process.exitCode = 1
  }
}
