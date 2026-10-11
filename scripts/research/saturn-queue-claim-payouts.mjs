// Two-origin mined USDat transfer proofs for the fixed Saturn request cohort.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { keccak256, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { requestWithRetries, writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { QUEUE, verifyQueueEvents } from './saturn-queue-event-cohort.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'

export const OUT = resolve(
  'data/research/venue-signals/saturn-queue-claim-payouts-26007302-26107302-v2.json',
)
const USDAT = '0x23238f20b894f29041f48d88ee91131c395aaa71'
const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'))
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const ticketId = (log) => BigInt(log.topics[1]).toString()
const address = (topic) => `0x${topic.slice(-40)}`
const amount = (data) => BigInt(data).toString()

function claimsByTx(events, episodes) {
  const ids = new Set(
    episodes.episodes.filter((row) => row.status === 'claimed').map((row) => row.ticketId),
  )
  const claims = events.logs.filter((log) => log.kind === 'claimed' && ids.has(ticketId(log)))
  if (claims.length !== ids.size) throw Error('saturn_queue_claim_denominator_changed')
  const map = new Map()
  for (const log of claims) {
    if (!map.has(log.transactionHash)) map.set(log.transactionHash, [])
    map.get(log.transactionHash).push(log)
  }
  return map
}

function normalizeReceipt(receipt, tx, claims) {
  if (
    receipt?.transactionHash?.toLowerCase() !== tx ||
    receipt.status !== '0x1' ||
    !HASH.test(receipt.blockHash?.toLowerCase() ?? '')
  )
    throw Error('saturn_queue_receipt_invalid')
  const blockNumber = Number(BigInt(receipt.blockNumber ?? '0x0'))
  if (
    !Number.isSafeInteger(blockNumber) ||
    claims.some(
      (claim) =>
        claim.blockNumber !== blockNumber || claim.blockHash !== receipt.blockHash.toLowerCase(),
    )
  )
    throw Error('saturn_queue_claim_block_mismatch')
  const allClaims = receipt.logs.filter(
    (log) =>
      log.address?.toLowerCase() === QUEUE &&
      log.topics?.[0]?.toLowerCase() === claims[0].topics[0],
  )
  for (const claim of claims) {
    const match = allClaims.find((log) => Number(BigInt(log.logIndex)) === claim.logIndex)
    if (
      !match ||
      canonical(match.topics.map((topic) => topic.toLowerCase())) !== canonical(claim.topics) ||
      match.data.toLowerCase() !== claim.data
    )
      throw Error('saturn_queue_claim_receipt_event_mismatch')
  }
  const transfers = receipt.logs
    .filter(
      (log) =>
        log.address?.toLowerCase() === USDAT &&
        log.topics?.[0]?.toLowerCase() === TRANSFER &&
        log.topics?.length === 3 &&
        address(log.topics[1].toLowerCase()) === QUEUE,
    )
    .map((log) => ({
      logIndex: Number(BigInt(log.logIndex)),
      to: address(log.topics[2].toLowerCase()),
      amountRaw: amount(log.data),
    }))
    .sort((a, b) => a.logIndex - b.logIndex)
  const owedByHolder = new Map()
  for (const claim of claims) {
    const holder = address(claim.topics[2])
    owedByHolder.set(holder, (owedByHolder.get(holder) ?? 0n) + BigInt(claim.data))
  }
  for (const [holder, owed] of owedByHolder) {
    const delivered = transfers
      .filter((transfer) => transfer.to === holder)
      .reduce((sum, transfer) => sum + BigInt(transfer.amountRaw), 0n)
    if (delivered !== owed) throw Error('saturn_queue_usdat_transfer_missing')
  }
  return {
    transactionHash: tx,
    blockNumber,
    blockHash: receipt.blockHash.toLowerCase(),
    settlementTransfers: transfers,
    payouts: claims.map((claim) => ({
      ticketId: ticketId(claim),
      to: address(claim.topics[2]),
      amountRaw: amount(claim.data),
      claimLogIndex: claim.logIndex,
    })),
  }
}

function validateCheckpoint(row, tx, claims) {
  const owedByHolder = new Map()
  for (const claim of claims) {
    const holder = address(claim.topics[2])
    owedByHolder.set(holder, (owedByHolder.get(holder) ?? 0n) + BigInt(claim.data))
  }
  if (
    row?.study !== 'saturn_queue_two_origin_claim_payout_v2' ||
    row.transactionHash !== tx ||
    !HASH.test(row.blockHash ?? '') ||
    !SHA.test(row.sha256 ?? '') ||
    !Array.isArray(row.settlementTransfers) ||
    canonical(row.origins) !== canonical(['rpc.ankr.com', 'eth-mainnet.g.alchemy.com']) ||
    canonical(row.payouts) !==
      canonical(
        claims.map((claim) => ({
          ticketId: ticketId(claim),
          to: address(claim.topics[2]),
          amountRaw: amount(claim.data),
          claimLogIndex: claim.logIndex,
        })),
      ) ||
    claims.some(
      (claim) => claim.blockNumber !== row.blockNumber || claim.blockHash !== row.blockHash,
    ) ||
    row.settlementTransfers.some(
      (transfer) =>
        !Number.isSafeInteger(transfer.logIndex) ||
        transfer.logIndex < 0 ||
        !owedByHolder.has(transfer.to) ||
        !/^[0-9]+$/.test(transfer.amountRaw),
    ) ||
    [...owedByHolder].some(
      ([holder, owed]) =>
        row.settlementTransfers
          .filter((transfer) => transfer.to === holder)
          .reduce((sum, transfer) => sum + BigInt(transfer.amountRaw), 0n) !== owed,
    )
  )
    throw Error('saturn_queue_payout_checkpoint_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body)))
    throw Error('saturn_queue_payout_checkpoint_hash_invalid')
  return row
}

async function checkpoint(path, tx, claims) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.length > 8192) throw Error('saturn_queue_payout_checkpoint_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('saturn_queue_payout_checkpoint_encoding_invalid')
  return validateCheckpoint(row, tx, claims)
}

async function sources() {
  const [events, episodes] = await Promise.all([verifyQueueEvents(), verifyEpisodes()])
  return { events, episodes, txs: claimsByTx(events, episodes) }
}

export async function capturePayouts({
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
  limit = 16,
} = {}) {
  const { events, episodes, txs } = await sources()
  const clients = publicRpcClients(urls)
  const origins = ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'].map((host) =>
    clients.find((client) => new URL(client.url).hostname === host),
  )
  if (origins.some((origin) => !origin)) throw Error('saturn_queue_payout_origins_unavailable')
  const payouts = []
  let captured = 0
  for (const [tx, claims] of txs) {
    const path = `${out}.transactions/${tx}.json`
    let row = await checkpoint(path, tx, claims)
    if (!row && captured < limit) {
      const receipts = await Promise.all(
        origins.map((origin) => requestWithRetries(origin, 'eth_getTransactionReceipt', [tx])),
      )
      const left = normalizeReceipt(receipts[0], tx, claims)
      const right = normalizeReceipt(receipts[1], tx, claims)
      if (canonical(left) !== canonical(right)) throw Error('saturn_queue_payout_origins_disagree')
      const body = {
        study: 'saturn_queue_two_origin_claim_payout_v2',
        ...left,
        origins: ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'],
      }
      row = validateCheckpoint({ ...body, sha256: sha(canonical(body)) }, tx, claims)
      await writeExclusive(path, row)
      captured++
    }
    if (row)
      payouts.push({
        transactionHash: tx,
        sha256: row.sha256,
        payouts: row.payouts,
        settlementTransfers: row.settlementTransfers,
      })
  }
  if (payouts.length < txs.size)
    return { partial: true, transactions: payouts.length, totalTransactions: txs.size }
  const body = {
    study: 'saturn_queue_claim_payout_cohort_v2',
    sourceEventSha256: events.sha256,
    sourceEpisodeSha256: episodes.sha256,
    transactions: payouts,
    claimedTickets: payouts.reduce((sum, row) => sum + row.payouts.length, 0),
  }
  const row = { ...body, sha256: sha(canonical(body)) }
  await writeExclusive(out, row)
  return row
}

export async function verifyPayouts(out = OUT) {
  const { events, episodes, txs } = await sources()
  const bytes = await readFile(out)
  if (bytes.length > 65_536) throw Error('saturn_queue_payout_cohort_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  const { sha256: _seal, ...body } = row
  if (
    bytes.toString('utf8') !== `${canonical(row)}\n` ||
    row.study !== 'saturn_queue_claim_payout_cohort_v2' ||
    row.sourceEventSha256 !== events.sha256 ||
    row.sourceEpisodeSha256 !== episodes.sha256 ||
    row.sha256 !== sha(canonical(body))
  )
    throw Error('saturn_queue_payout_cohort_invalid')
  const payouts = []
  for (const [tx, claims] of txs) {
    const saved = await checkpoint(`${out}.transactions/${tx}.json`, tx, claims)
    if (!saved) throw Error('saturn_queue_payout_checkpoint_missing')
    payouts.push({
      transactionHash: tx,
      sha256: saved.sha256,
      payouts: saved.payouts,
      settlementTransfers: saved.settlementTransfers,
    })
  }
  if (
    canonical(row.transactions) !== canonical(payouts) ||
    row.claimedTickets !== payouts.reduce((sum, item) => sum + item.payouts.length, 0)
  )
    throw Error('saturn_queue_payout_replay_changed')
  return row
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify')) {
    const row = await verifyPayouts()
    console.log(
      JSON.stringify({
        transactions: row.transactions.length,
        claimedTickets: row.claimedTickets,
        sha256: row.sha256,
      }),
    )
  } else {
    const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
    const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 16
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
      throw Error('saturn_queue_limit_invalid')
    const row = await capturePayouts({ limit })
    console.log(
      JSON.stringify(
        row.partial
          ? row
          : {
              transactions: row.transactions.length,
              claimedTickets: row.claimedTickets,
              sha256: row.sha256,
            },
      ),
    )
  }
}
