// Join the frozen receipt cohort's gross vault Withdraw to its net receipt escrow.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  RECEIPT,
  requestWithRetries,
  verifySource,
  writeExclusive,
} from './apyusd-receipt-cohort-source.mjs'
import { verifyBoundaries } from './apyusd-receipt-cohort-boundaries.mjs'
import { verifyPayouts } from './apyusd-receipt-cohort-payouts.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-receipt-cohort-escrow-v1.json')
const VAULT = '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'
const ASSET = '0x98a878b1cd98131b271883b390f68d2c90674665'
const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'))
const WITHDRAW = keccak256(stringToHex('Withdraw(address,address,address,uint256,uint256)'))
const ISSUED = keccak256(stringToHex('ReceiptIssued(address,address,uint256,uint256)'))
const ABI = parseAbi([
  'function getReceipt(uint256) view returns (uint208,uint208,uint48,uint48)',
  'function unlockingFee() view returns (uint256)',
])
const SHA = /^[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const tokenId = (mint) => BigInt(mint.topics[3]).toString()
const holder = (mint) => `0x${mint.topics[2].slice(-40)}`
const topicAddress = (address) => `0x${address.slice(2).padStart(64, '0')}`
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })

function event(log) {
  return {
    address: log.address?.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex ?? '0x0')),
    topics: log.topics?.map((topic) => topic.toLowerCase()),
    data: log.data?.toLowerCase(),
  }
}

export function escrowFromReceipt(receipt, mint, feeWad, position, blockTime) {
  const logs = receipt?.logs?.map(event)
  if (
    receipt?.status !== '0x1' ||
    receipt.transactionHash?.toLowerCase() !== mint.transactionHash ||
    receipt.blockHash?.toLowerCase() !== mint.blockHash ||
    Number(BigInt(receipt.blockNumber ?? '0x0')) !== mint.blockNumber ||
    !Array.isArray(logs) ||
    !logs.some(
      (log) =>
        log.address === RECEIPT &&
        log.logIndex === mint.logIndex &&
        canonical(log.topics) === canonical(mint.topics) &&
        log.data === mint.data,
    )
  )
    throw Error('apyusd_escrow_mint_receipt_invalid')
  const id = tokenId(mint)
  const owner = holder(mint)
  const issues = logs.filter(
    (log) =>
      log.address === VAULT &&
      log.topics?.[0] === ISSUED &&
      log.topics?.[1] === topicAddress(owner) &&
      log.topics?.[2] === topicAddress(owner) &&
      log.topics?.[3] === `0x${BigInt(id).toString(16).padStart(64, '0')}` &&
      /^0x[0-9a-f]{64}$/.test(log.data ?? '') &&
      log.logIndex > mint.logIndex,
  )
  if (issues.length !== 1) throw Error('apyusd_escrow_issue_missing')
  const issue = issues[0]
  const net = BigInt(issue.data)
  if (net <= 0n || net !== BigInt(position[0])) throw Error('apyusd_escrow_amount_mismatch')
  const transfer = logs.filter(
    (log) =>
      log.address === ASSET &&
      log.topics?.[0] === TRANSFER &&
      log.topics?.[1] === topicAddress(VAULT) &&
      log.topics?.[2] === topicAddress(RECEIPT) &&
      /^0x[0-9a-f]{64}$/.test(log.data ?? '') &&
      BigInt(log.data) === net &&
      log.logIndex < mint.logIndex,
  )
  if (transfer.length !== 1) throw Error('apyusd_escrow_transfer_missing')
  const expectedFee = (net * BigInt(feeWad) + 10n ** 18n - 1n) / 10n ** 18n
  const gross = net + expectedFee
  const withdrawals = logs.filter(
    (log) =>
      log.address === VAULT &&
      log.topics?.[0] === WITHDRAW &&
      log.topics?.[2] === topicAddress(VAULT) &&
      log.topics?.[3] === topicAddress(owner) &&
      /^0x[0-9a-f]{128}$/.test(log.data ?? '') &&
      BigInt(`0x${log.data.slice(2, 66)}`) === gross &&
      log.logIndex < transfer[0].logIndex,
  )
  if (withdrawals.length !== 1) throw Error('apyusd_escrow_withdraw_missing')
  if (Number(position[2]) !== blockTime || Number(position[3]) <= blockTime)
    throw Error('apyusd_escrow_schedule_invalid')
  return {
    tokenId: id,
    holder: owner,
    mintBlock: mint.blockNumber,
    mintTransactionHash: mint.transactionHash,
    withdrawalLogIndex: withdrawals[0].logIndex,
    transferLogIndex: transfer[0].logIndex,
    mintLogIndex: mint.logIndex,
    issueLogIndex: issue.logIndex,
    grossWithdrawRaw: gross.toString(),
    vaultFeeRaw: expectedFee.toString(),
    receiptEscrowRaw: net.toString(),
    vaultFeeRateWad: feeWad.toString(),
    issuedAt: Number(position[2]),
    claimableAt: Number(position[3]),
  }
}

async function readOne(origin, mint) {
  const [receipt, block] = await Promise.all([
    requestWithRetries(origin, 'eth_getTransactionReceipt', [mint.transactionHash]),
    requestWithRetries(origin, 'eth_getBlockByNumber', [
      `0x${mint.blockNumber.toString(16)}`,
      false,
    ]),
  ])
  if (block?.hash?.toLowerCase() !== mint.blockHash) throw Error('apyusd_escrow_block_changed')
  const blockTime = Number(BigInt(block.timestamp ?? '0x0'))
  const read = async (address, functionName, args = []) => {
    const raw = await requestWithRetries(origin, 'eth_call', [
      { to: address, data: encodeFunctionData({ abi: ABI, functionName, args }) },
      pin(mint.blockHash),
    ])
    return decodeFunctionResult({ abi: ABI, functionName, data: raw })
  }
  const [feeWad, position] = await Promise.all([
    read(VAULT, 'unlockingFee'),
    read(RECEIPT, 'getReceipt', [BigInt(tokenId(mint))]),
  ])
  return escrowFromReceipt(receipt, mint, feeWad, position, blockTime)
}

function validateCheckpoint(row, mint) {
  if (
    row?.study !== 'apyusd_receipt_escrow_proof_v1' ||
    row.sourceMintSha256 !== sha(canonical(mint)) ||
    canonical(row.origins) !== canonical(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']) ||
    row.proof?.tokenId !== tokenId(mint) ||
    row.proof?.holder !== holder(mint) ||
    row.proof?.mintBlock !== mint.blockNumber ||
    BigInt(row.proof.grossWithdrawRaw) !==
      BigInt(row.proof.receiptEscrowRaw) + BigInt(row.proof.vaultFeeRaw) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('apyusd_escrow_checkpoint_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('apyusd_escrow_checkpoint_hash_invalid')
  return row
}

async function checkpoint(path, mint) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.length > 8_192) throw Error('apyusd_escrow_checkpoint_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('apyusd_escrow_checkpoint_encoding_invalid')
  return validateCheckpoint(row, mint)
}

export async function captureEscrow({
  source = null,
  payouts = null,
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
  limit = 12,
} = {}) {
  source = source ?? (await verifySource())
  payouts = payouts ?? (await verifyPayouts())
  const origins = publicRpcClients(urls)
  const primary = origins.find(
    (origin) => new URL(origin.url).hostname === 'eth-mainnet.g.alchemy.com',
  )
  const secondary = origins.find((origin) => new URL(origin.url).hostname === 'rpc.ankr.com')
  if (!primary || !secondary) throw Error('apyusd_escrow_origins_unavailable')
  const proofs = []
  let newProofs = 0
  for (const mint of source.mints) {
    const path = `${out}.receipts/${tokenId(mint)}.json`
    let row = await checkpoint(path, mint)
    if (!row) {
      if (newProofs >= limit) break
      const [left, right] = await Promise.all([readOne(primary, mint), readOne(secondary, mint)])
      if (canonical(left) !== canonical(right)) throw Error('apyusd_escrow_origins_disagree')
      const body = {
        study: 'apyusd_receipt_escrow_proof_v1',
        sourceMintSha256: sha(canonical(mint)),
        origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
        proof: left,
      }
      row = validateCheckpoint({ ...body, sha256: sha(canonical(body)) }, mint)
      await writeExclusive(path, row)
      newProofs++
      console.error(`apyusd_escrow token=${tokenId(mint)}`)
    }
    proofs.push(row.proof)
  }
  if (proofs.length < source.mints.length) return { partial: true, observed: proofs.length }
  const paidById = new Map(payouts.proofs.map((proof) => [proof.tokenId, proof]))
  for (const proof of proofs) {
    const paid = paidById.get(proof.tokenId)
    if (paid && paid.request.requestedAssetRaw !== proof.grossWithdrawRaw)
      throw Error('apyusd_escrow_payout_source_disagree')
  }
  const body = {
    study: 'apyusd_receipt_cohort_escrow_v1',
    sourceSha256: source.sha256,
    payoutsSha256: payouts.sha256,
    cohortSize: source.mints.length,
    proofs,
    proofsSha256: sha(canonical(proofs)),
    summary: {
      verifiedEscrow: proofs.length,
      paidCrosschecked: paidById.size,
      vaultFeePositive: proofs.filter((proof) => BigInt(proof.vaultFeeRaw) > 0n).length,
    },
  }
  const row = { ...body, sha256: sha(canonical(body)) }
  await writeExclusive(out, row)
  return row
}

export async function verifyEscrow(out = OUT) {
  const [source, payouts, boundaries, bytes] = await Promise.all([
    verifySource(),
    verifyPayouts(),
    verifyBoundaries(),
    readFile(out),
  ])
  if (bytes.length > 131_072) throw Error('apyusd_escrow_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  const { sha256: _seal, ...body } = row
  if (
    bytes.toString('utf8') !== `${canonical(row)}\n` ||
    row.study !== 'apyusd_receipt_cohort_escrow_v1' ||
    row.sourceSha256 !== source.sha256 ||
    row.payoutsSha256 !== payouts.sha256 ||
    row.cohortSize !== source.mints.length ||
    row.proofsSha256 !== sha(canonical(row.proofs)) ||
    row.proofs.length !== source.mints.length ||
    row.summary.verifiedEscrow !== source.mints.length ||
    row.summary.paidCrosschecked !== payouts.proofs.length ||
    row.summary.vaultFeePositive !==
      row.proofs.filter((proof) => BigInt(proof.vaultFeeRaw) > 0n).length ||
    row.sha256 !== sha(canonical(body))
  )
    throw Error('apyusd_escrow_invalid')
  for (const [index, proof] of row.proofs.entries()) {
    const mint = source.mints[index]
    const saved = await checkpoint(`${out}.receipts/${tokenId(mint)}.json`, mint)
    if (canonical(proof) !== canonical(saved?.proof)) throw Error('apyusd_escrow_proof_changed')
    const paid = payouts.proofs.find((item) => item.tokenId === proof.tokenId)
    if (paid && paid.request.requestedAssetRaw !== proof.grossWithdrawRaw)
      throw Error('apyusd_escrow_payout_source_disagree')
    const boundary = boundaries.proofs[index]
    const escrow = BigInt(proof.receiptEscrowRaw)
    const fee = (escrow * 34_000_000_000_000_000n + 10n ** 18n - 1n) / 10n ** 18n
    if (
      boundary.tokenId !== proof.tokenId ||
      boundary.holder !== proof.holder ||
      boundary.firstEligible.claim.status !== 'success' ||
      boundary.firstEligible.claim.amountRaw !== (escrow - fee).toString()
    )
      throw Error('apyusd_escrow_boundary_fee_disagree')
  }
  return row
}

export async function verifyPartial(out = OUT) {
  const source = await verifySource()
  let observed = 0
  let gap = false
  for (const mint of source.mints) {
    const row = await checkpoint(`${out}.receipts/${tokenId(mint)}.json`, mint)
    if (!row) gap = true
    else {
      if (gap) throw Error('apyusd_escrow_checkpoint_gap')
      observed++
    }
  }
  return { observed, cohortSize: source.mints.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify-partial')) {
    console.log(JSON.stringify(await verifyPartial()))
  } else if (process.argv.includes('--verify')) {
    const row = await verifyEscrow()
    console.log(JSON.stringify({ ...row.summary, sha256: row.sha256 }))
  } else {
    const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
    const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 12
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24)
      throw Error('apyusd_escrow_limit_invalid')
    const row = await captureEscrow({ limit })
    console.log(JSON.stringify(row.partial ? row : { ...row.summary, sha256: row.sha256 }))
  }
}
