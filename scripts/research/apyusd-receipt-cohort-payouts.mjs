// Same-receipt ApyUSD request-to-holder-payout evidence for the frozen 96-ID cohort.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { keccak256, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { ASSET, VAULT } from './carry-public-apyusd-exit-common.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  RECEIPT,
  requestWithRetries,
  verifySource,
  writeExclusive,
} from './apyusd-receipt-cohort-source.mjs'
import { verifyTransfers } from './apyusd-receipt-cohort-transfers.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-receipt-cohort-payouts-v1.json')
const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'))
const WITHDRAW = keccak256(stringToHex('Withdraw(address,address,address,uint256,uint256)'))
const ZERO = `0x${'0'.repeat(64)}`
const WORD = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const id = (event) => BigInt(event.topics[3]).toString()
const address = (topic) => `0x${topic.slice(-40)}`

function receiptEvent(log) {
  return {
    address: log.address?.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex ?? '0x0')),
    topics: log.topics?.map((topic) => topic.toLowerCase()),
    data: log.data?.toLowerCase(),
  }
}

function uniqueEvent(receipt, expected) {
  const rows = receipt.logs.filter(
    (log) =>
      log.address?.toLowerCase() === RECEIPT &&
      Number(BigInt(log.logIndex ?? '0x0')) === expected.logIndex &&
      canonical(log.topics?.map((topic) => topic.toLowerCase())) === canonical(expected.topics) &&
      log.data?.toLowerCase() === expected.data,
  )
  if (rows.length !== 1) throw Error('apyusd_cohort_ticket_receipt_log_missing')
}

function fixedStatus(receipt, event) {
  if (
    receipt?.status !== '0x1' ||
    receipt.transactionHash?.toLowerCase() !== event.transactionHash ||
    receipt.blockHash?.toLowerCase() !== event.blockHash ||
    Number(BigInt(receipt.blockNumber ?? '0x0')) !== event.blockNumber ||
    !Array.isArray(receipt.logs)
  )
    throw Error('apyusd_cohort_transaction_receipt_invalid')
  uniqueEvent(receipt, event)
}

function readRequestAmount(receipt) {
  // The ERC-4626 Withdraw event reports gross assets burned from the vault.
  // ReceiptIssued/getReceipt reports the smaller post-upfront-fee escrow;
  // see the separately sealed apyusd-receipt-cohort-escrow-v1 join.
  const withdrawals = receipt.logs
    .map(receiptEvent)
    .filter((log) => log.address === VAULT && log.topics?.[0] === WITHDRAW)
  if (withdrawals.length !== 1 || !/^0x[0-9a-f]{128}$/.test(withdrawals[0].data ?? ''))
    throw Error('apyusd_cohort_request_withdraw_invalid')
  const amount = BigInt(`0x${withdrawals[0].data.slice(2, 66)}`)
  if (amount === 0n) throw Error('apyusd_cohort_request_zero')
  return amount.toString()
}

export function readHolderPayoutWitness(receipt, holder) {
  const rows = receipt.logs
    .map(receiptEvent)
    .filter(
      (log) =>
        log.address === ASSET &&
        log.topics?.[0] === TRANSFER &&
        log.topics?.[1] === `0x${RECEIPT.slice(2).padStart(64, '0')}` &&
        log.topics?.[2] === `0x${holder.slice(2).padStart(64, '0')}`,
    )
  if (rows.length !== 1 || !WORD.test(rows[0].data ?? '0x'))
    throw Error('apyusd_cohort_holder_payout_invalid')
  if (
    !Number.isSafeInteger(rows[0].logIndex) ||
    rows[0].logIndex < 0 ||
    rows[0].topics?.length !== 3 ||
    !rows[0].topics.every((topic) => WORD.test(topic))
  )
    throw Error('apyusd_cohort_holder_payout_invalid')
  const amount = BigInt(rows[0].data)
  if (amount === 0n) throw Error('apyusd_cohort_holder_payout_zero')
  return rows[0]
}

export function readHolderPayout(receipt, holder) {
  return BigInt(readHolderPayoutWitness(receipt, holder).data).toString()
}

function checkedHeader(block, event) {
  if (
    block?.hash?.toLowerCase() !== event.blockHash ||
    Number(BigInt(block.number ?? '0x0')) !== event.blockNumber
  )
    throw Error('apyusd_cohort_payout_header_invalid')
  const timestamp = Number(BigInt(block.timestamp ?? '0x0'))
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
    throw Error('apyusd_cohort_payout_timestamp_invalid')
  return timestamp
}

export async function readOne(
  origin,
  mint,
  burn,
  { requireUniqueBurn = false, includePayoutWitness = false, requireCanonicalBurn = false } = {},
) {
  const holder = address(mint.topics[2])
  if (burn.topics[1] !== mint.topics[2] || burn.topics[2] !== ZERO || id(mint) !== id(burn))
    throw Error('apyusd_cohort_holder_continuity_invalid')
  const [requestReceipt, payoutReceipt, requestBlock, payoutBlock] = await Promise.all([
    requestWithRetries(origin, 'eth_getTransactionReceipt', [mint.transactionHash]),
    requestWithRetries(origin, 'eth_getTransactionReceipt', [burn.transactionHash]),
    requestWithRetries(origin, 'eth_getBlockByHash', [mint.blockHash, false]),
    requestWithRetries(origin, 'eth_getBlockByHash', [burn.blockHash, false]),
  ])
  fixedStatus(requestReceipt, mint)
  fixedStatus(payoutReceipt, burn)
  if (requireUniqueBurn) {
    const burns = payoutReceipt.logs
      .map(receiptEvent)
      .filter(
        (log) =>
          log.address === RECEIPT && log.topics?.[0] === TRANSFER && log.topics?.[2] === ZERO,
      )
    if (burns.length !== 1 || burns[0].logIndex !== burn.logIndex)
      throw Error('apyusd_cohort_ambiguous_burn_transaction')
  }
  const requestedAssetRaw = readRequestAmount(requestReceipt)
  const payoutTransferWitness = readHolderPayoutWitness(payoutReceipt, holder)
  const paidAssetRaw = BigInt(payoutTransferWitness.data).toString()
  const requestTimestamp = checkedHeader(requestBlock, mint)
  const payoutTimestamp = checkedHeader(payoutBlock, burn)
  if (requireCanonicalBurn) {
    const canonicalBlock = await requestWithRetries(origin, 'eth_getBlockByNumber', [
      `0x${burn.blockNumber.toString(16)}`,
      false,
    ])
    if (checkedHeader(canonicalBlock, burn) !== payoutTimestamp)
      throw Error('apyusd_cohort_payout_canonical_header_invalid')
  }
  if (payoutTimestamp <= requestTimestamp) throw Error('apyusd_cohort_payout_order_invalid')
  return {
    tokenId: id(mint),
    holder,
    request: {
      blockNumber: mint.blockNumber,
      blockHash: mint.blockHash,
      transactionHash: mint.transactionHash,
      logIndex: mint.logIndex,
      timestamp: requestTimestamp,
      requestedAssetRaw,
    },
    payout: {
      blockNumber: burn.blockNumber,
      blockHash: burn.blockHash,
      transactionHash: burn.transactionHash,
      logIndex: burn.logIndex,
      timestamp: payoutTimestamp,
      paidAssetRaw,
      ...(includePayoutWitness ? { payoutTransferWitness } : {}),
    },
    requestToPayoutSeconds: payoutTimestamp - requestTimestamp,
    payoutBpsFloor: Number((BigInt(paidAssetRaw) * 10_000n) / BigInt(requestedAssetRaw)),
  }
}

function expectedBurns(source, transfers) {
  const selected = new Set(source.mints.map(id))
  const burns = transfers.transfers.filter(
    (event) => event.topics[2] === ZERO && selected.has(id(event)),
  )
  return new Map(burns.map((burn) => [id(burn), burn]))
}

function validateCheckpoint(row, mint, burn) {
  if (
    row?.study !== 'apyusd_receipt_holder_payout_v1' ||
    row.sourceMintSha256 !== sha(canonical(mint)) ||
    row.sourceBurnSha256 !== sha(canonical(burn)) ||
    canonical(row.origins) !== canonical(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']) ||
    row.proof?.tokenId !== id(mint) ||
    row.proof?.holder !== address(mint.topics[2]) ||
    row.proof?.request?.transactionHash !== mint.transactionHash ||
    row.proof?.payout?.transactionHash !== burn.transactionHash ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('apyusd_cohort_payout_checkpoint_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body)))
    throw Error('apyusd_cohort_payout_checkpoint_hash_invalid')
  return row
}

async function checkpoint(path, mint, burn) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.length > 8_192) throw Error('apyusd_cohort_payout_checkpoint_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('apyusd_cohort_payout_checkpoint_encoding_invalid')
  return validateCheckpoint(row, mint, burn)
}

export async function capturePayouts({
  source = null,
  transfers = null,
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
} = {}) {
  source = source ?? (await verifySource())
  transfers = transfers ?? (await verifyTransfers())
  const burns = expectedBurns(source, transfers)
  if (burns.size !== transfers.cohort.burned) throw Error('apyusd_cohort_burn_set_invalid')
  const origins = publicRpcClients(urls)
  const alchemy = origins.find(
    (origin) => new URL(origin.url).hostname === 'eth-mainnet.g.alchemy.com',
  )
  const ankr = origins.find((origin) => new URL(origin.url).hostname === 'rpc.ankr.com')
  if (!alchemy || !ankr) throw Error('apyusd_cohort_payout_origins_unavailable')
  const proofs = []
  for (const mint of source.mints) {
    const burn = burns.get(id(mint))
    if (!burn) continue
    const path = `${out}.receipts/${id(mint)}.json`
    let row = await checkpoint(path, mint, burn)
    if (!row) {
      const [a, b] = await Promise.all([readOne(alchemy, mint, burn), readOne(ankr, mint, burn)])
      if (canonical(a) !== canonical(b)) throw Error('apyusd_cohort_payout_origins_disagree')
      const body = {
        study: 'apyusd_receipt_holder_payout_v1',
        sourceMintSha256: sha(canonical(mint)),
        sourceBurnSha256: sha(canonical(burn)),
        origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
        proof: a,
      }
      row = validateCheckpoint({ ...body, sha256: sha(canonical(body)) }, mint, burn)
      await writeExclusive(path, row)
      console.error(`apyusd_holder_payout token=${id(mint)}`)
    }
    proofs.push(row.proof)
  }
  if (proofs.length !== burns.size) throw Error('apyusd_cohort_payout_incomplete')
  const body = {
    study: 'apyusd_receipt_cohort_holder_payouts_v1',
    sourceSha256: source.sha256,
    transfersSha256: transfers.sha256,
    asOfBlock: transfers.toBlock,
    cohortSize: source.mints.length,
    paidCount: proofs.length,
    openIds: transfers.cohort.openIds,
    proofs,
    proofsSha256: sha(canonical(proofs)),
  }
  const row = validatePayouts({ ...body, sha256: sha(canonical(body)) }, source, transfers)
  await writeExclusive(out, row)
  return row
}

export function validatePayouts(row, source, transfers) {
  if (
    row?.study !== 'apyusd_receipt_cohort_holder_payouts_v1' ||
    row.sourceSha256 !== source.sha256 ||
    row.transfersSha256 !== transfers.sha256 ||
    row.asOfBlock !== transfers.toBlock ||
    row.cohortSize !== source.mints.length ||
    row.paidCount !== transfers.cohort.burned ||
    canonical(row.openIds) !== canonical(transfers.cohort.openIds) ||
    !Array.isArray(row.proofs) ||
    row.proofs.length !== row.paidCount ||
    row.proofsSha256 !== sha(canonical(row.proofs)) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('apyusd_cohort_payouts_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('apyusd_cohort_payouts_hash_invalid')
  const burns = expectedBurns(source, transfers)
  const seen = new Set()
  for (const proof of row.proofs) {
    const mint = source.mints.find((event) => id(event) === proof.tokenId)
    const burn = burns.get(proof.tokenId)
    if (!mint || !burn || seen.has(proof.tokenId))
      throw Error('apyusd_cohort_payout_subject_invalid')
    seen.add(proof.tokenId)
    if (
      proof.holder !== address(mint.topics[2]) ||
      proof.request.blockNumber !== mint.blockNumber ||
      proof.request.blockHash !== mint.blockHash ||
      proof.request.transactionHash !== mint.transactionHash ||
      proof.request.logIndex !== mint.logIndex ||
      proof.payout.blockNumber !== burn.blockNumber ||
      proof.payout.blockHash !== burn.blockHash ||
      proof.payout.transactionHash !== burn.transactionHash ||
      proof.payout.logIndex !== burn.logIndex ||
      proof.requestToPayoutSeconds !== proof.payout.timestamp - proof.request.timestamp ||
      proof.payoutBpsFloor !==
        Number(
          (BigInt(proof.payout.paidAssetRaw) * 10_000n) / BigInt(proof.request.requestedAssetRaw),
        )
    )
      throw Error('apyusd_cohort_payout_proof_invalid')
  }
  return row
}

export async function verifyPayouts(out = OUT) {
  const [source, transfers, bytes] = await Promise.all([
    verifySource(),
    verifyTransfers(),
    readFile(out),
  ])
  if (bytes.length > 131_072) throw Error('apyusd_cohort_payouts_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('apyusd_cohort_payouts_encoding_invalid')
  return validatePayouts(row, source, transfers)
}

export async function verifyPartial(out = OUT) {
  const [source, transfers] = await Promise.all([verifySource(), verifyTransfers()])
  const burns = expectedBurns(source, transfers)
  let paid = 0
  let gap = false
  for (const mint of source.mints) {
    const burn = burns.get(id(mint))
    if (!burn) continue
    const row = await checkpoint(`${out}.receipts/${id(mint)}.json`, mint, burn)
    if (!row) {
      gap = true
      continue
    }
    if (gap) throw Error('apyusd_cohort_payout_checkpoint_gap')
    paid++
  }
  return { paid, expectedPaid: burns.size, censoredOpen: transfers.cohort.openIds.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify-partial')) {
    console.log(JSON.stringify(await verifyPartial()))
    process.exit(0)
  }
  const row = process.argv.includes('--verify') ? await verifyPayouts() : await capturePayouts()
  console.log(
    JSON.stringify({
      study: row.study,
      cohortSize: row.cohortSize,
      paidCount: row.paidCount,
      openIds: row.openIds,
      proofsSha256: row.proofsSha256,
      sha256: row.sha256,
    }),
  )
}
