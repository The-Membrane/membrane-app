// Historical exact-holder claim calls at the first eligible block for all frozen receipts.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { pin } from './carry-public-apyusd-exit-common.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  RECEIPT,
  requestWithRetries,
  verifySource,
  writeExclusive,
} from './apyusd-receipt-cohort-source.mjs'
import { verifyTransfers } from './apyusd-receipt-cohort-transfers.mjs'
import { verifyPayouts } from './apyusd-receipt-cohort-payouts.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-receipt-cohort-boundaries-v1.json')
const ABI = parseAbi([
  'function getReceipt(uint256) view returns (uint208,uint208,uint48,uint48)',
  'function isClaimable(uint256) view returns (bool)',
  'function claim(uint256,address) returns (uint256)',
])
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const EXPECTED_IMPL = '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
const SHA = /^[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const hex = (n) => `0x${n.toString(16)}`
const id = (mint) => BigInt(mint.topics[3]).toString()
const holder = (mint) => `0x${mint.topics[2].slice(-40)}`

function header(block, expectedNumber = null) {
  if (
    !/^0x[0-9a-f]{64}$/.test(block?.hash ?? '') ||
    !Number.isSafeInteger(Number(BigInt(block.number ?? '0x0'))) ||
    (expectedNumber !== null && Number(BigInt(block.number)) !== expectedNumber)
  )
    throw Error('apyusd_boundary_header_invalid')
  return {
    number: Number(BigInt(block.number)),
    hash: block.hash.toLowerCase(),
    timestamp: Number(BigInt(block.timestamp ?? '0x0')),
  }
}

async function blockAt(origin, number) {
  return header(
    await requestWithRetries(origin, 'eth_getBlockByNumber', [hex(number), false]),
    number,
  )
}

async function locateBoundary(origin, mintBlock, claimableAt) {
  let low = await blockAt(origin, mintBlock)
  let high = await blockAt(origin, mintBlock + 25_000)
  if (low.timestamp >= claimableAt || high.timestamp < claimableAt)
    throw Error('apyusd_boundary_bracket_invalid')
  while (high.number - low.number > 1) {
    const mid = await blockAt(origin, Math.floor((low.number + high.number) / 2))
    if (mid.timestamp >= claimableAt) high = mid
    else low = mid
  }
  return { before: low, firstEligible: high }
}

async function receiptSchedule(origin, mint) {
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'getReceipt',
    args: [BigInt(id(mint))],
  })
  const raw = await requestWithRetries(origin, 'eth_call', [
    { to: RECEIPT, data },
    pin(mint.blockHash),
  ])
  const [, , issuedAt, claimableAt] = decodeFunctionResult({
    abi: ABI,
    functionName: 'getReceipt',
    data: raw,
  })
  if (
    !Number.isSafeInteger(Number(issuedAt)) ||
    !Number.isSafeInteger(Number(claimableAt)) ||
    Number(claimableAt) <= Number(issuedAt)
  )
    throw Error('apyusd_boundary_schedule_invalid')
  return { issuedAt: Number(issuedAt), claimableAt: Number(claimableAt) }
}

async function claimAt(origin, mint, block) {
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'claim',
    args: [BigInt(id(mint)), holder(mint)],
  })
  const response = await origin.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: RECEIPT, data, from: holder(mint) }, pin(block.hash)],
  })
  if (Object.hasOwn(response, 'error')) {
    if (response.error?.message !== 'execution reverted')
      throw Error('apyusd_boundary_call_rpc_retry')
    return { status: 'evm_revert', amountRaw: null }
  }
  const amount = decodeFunctionResult({ abi: ABI, functionName: 'claim', data: response.result })
  return { status: 'success', amountRaw: amount.toString() }
}

async function stateAt(origin, mint, block) {
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'isClaimable',
    args: [BigInt(id(mint))],
  })
  const [raw, implementationSlot, claim] = await Promise.all([
    requestWithRetries(origin, 'eth_call', [{ to: RECEIPT, data }, pin(block.hash)]),
    requestWithRetries(origin, 'eth_getStorageAt', [RECEIPT, SLOT, pin(block.hash)]),
    claimAt(origin, mint, block),
  ])
  const isClaimable = decodeFunctionResult({ abi: ABI, functionName: 'isClaimable', data: raw })
  if (!/^0x[0-9a-f]{64}$/.test(implementationSlot ?? ''))
    throw Error('apyusd_boundary_implementation_invalid')
  return {
    isClaimable,
    implementationMatched: `0x${implementationSlot.slice(-40)}` === EXPECTED_IMPL,
    claim,
  }
}

async function boundaryProof(primary, secondary, mint) {
  const schedules = await Promise.all([
    receiptSchedule(primary, mint),
    receiptSchedule(secondary, mint),
  ])
  if (canonical(schedules[0]) !== canonical(schedules[1]))
    throw Error('apyusd_boundary_schedule_origins_disagree')
  const boundary = await locateBoundary(primary, mint.blockNumber, schedules[0].claimableAt)
  const witnessHeaders = await Promise.all([
    blockAt(secondary, boundary.before.number),
    blockAt(secondary, boundary.firstEligible.number),
  ])
  if (
    canonical(witnessHeaders[0]) !== canonical(boundary.before) ||
    canonical(witnessHeaders[1]) !== canonical(boundary.firstEligible)
  )
    throw Error('apyusd_boundary_header_origins_disagree')
  const primaryStates = await Promise.all([
    stateAt(primary, mint, boundary.before),
    stateAt(primary, mint, boundary.firstEligible),
  ])
  const secondaryStates = await Promise.all([
    stateAt(secondary, mint, boundary.before),
    stateAt(secondary, mint, boundary.firstEligible),
  ])
  if (canonical(primaryStates) !== canonical(secondaryStates))
    throw Error('apyusd_boundary_call_origins_disagree')
  return {
    tokenId: id(mint),
    holder: holder(mint),
    mintBlock: mint.blockNumber,
    schedule: schedules[0],
    before: { ...boundary.before, ...primaryStates[0] },
    firstEligible: { ...boundary.firstEligible, ...primaryStates[1] },
  }
}

function validateCheckpoint(row, mint) {
  const proof = row?.proof
  if (
    row?.study !== 'apyusd_receipt_eligibility_boundary_v1' ||
    row.sourceMintSha256 !== sha(canonical(mint)) ||
    canonical(row.origins) !== canonical(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']) ||
    proof?.tokenId !== id(mint) ||
    proof.holder !== holder(mint) ||
    proof.mintBlock !== mint.blockNumber ||
    proof.before.number + 1 !== proof.firstEligible.number ||
    proof.before.timestamp >= proof.schedule.claimableAt ||
    proof.firstEligible.timestamp < proof.schedule.claimableAt ||
    proof.schedule.claimableAt <= proof.schedule.issuedAt ||
    !['success', 'evm_revert'].includes(proof.before.claim.status) ||
    !['success', 'evm_revert'].includes(proof.firstEligible.claim.status) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('apyusd_boundary_checkpoint_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('apyusd_boundary_checkpoint_hash_invalid')
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
  if (bytes.length > 8_192) throw Error('apyusd_boundary_checkpoint_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('apyusd_boundary_checkpoint_encoding_invalid')
  return validateCheckpoint(row, mint)
}

function summary(proofs) {
  return {
    observed: proofs.length,
    scheduled72h: proofs.filter(
      (proof) => proof.schedule.claimableAt - proof.schedule.issuedAt === 259_200,
    ).length,
    beforeReverted: proofs.filter((proof) => proof.before.claim.status === 'evm_revert').length,
    firstEligibleSucceeded: proofs.filter(
      (proof) =>
        proof.firstEligible.claim.status === 'success' &&
        BigInt(proof.firstEligible.claim.amountRaw ?? '0') > 0n,
    ).length,
    sameImplementation: proofs.filter(
      (proof) => proof.before.implementationMatched && proof.firstEligible.implementationMatched,
    ).length,
  }
}

export async function captureBoundaries({
  source = null,
  transfers = null,
  payouts = null,
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
  limit = 12,
} = {}) {
  source = source ?? (await verifySource())
  transfers = transfers ?? (await verifyTransfers())
  payouts = payouts ?? (await verifyPayouts())
  const origins = publicRpcClients(urls)
  const alchemy = origins.find(
    (origin) => new URL(origin.url).hostname === 'eth-mainnet.g.alchemy.com',
  )
  const ankr = origins.find((origin) => new URL(origin.url).hostname === 'rpc.ankr.com')
  if (!alchemy || !ankr) throw Error('apyusd_boundary_origins_unavailable')
  const proofs = []
  let newProofs = 0
  for (const mint of source.mints) {
    const path = `${out}.receipts/${id(mint)}.json`
    let row = await checkpoint(path, mint)
    if (!row) {
      if (newProofs >= limit) break
      const proof = await boundaryProof(alchemy, ankr, mint)
      const body = {
        study: 'apyusd_receipt_eligibility_boundary_v1',
        sourceMintSha256: sha(canonical(mint)),
        origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
        proof,
      }
      row = validateCheckpoint({ ...body, sha256: sha(canonical(body)) }, mint)
      await writeExclusive(path, row)
      newProofs++
      console.error(`apyusd_boundary token=${id(mint)}`)
    }
    proofs.push(row.proof)
  }
  if (proofs.length < source.mints.length) return { partial: true, ...summary(proofs) }
  const body = {
    study: 'apyusd_receipt_cohort_eligibility_boundaries_v1',
    sourceSha256: source.sha256,
    transfersSha256: transfers.sha256,
    payoutsSha256: payouts.sha256,
    cohortSize: source.mints.length,
    proofs,
    proofSha256: sha(canonical(proofs)),
    summary: summary(proofs),
  }
  const row = validateBoundaries(
    { ...body, sha256: sha(canonical(body)) },
    source,
    transfers,
    payouts,
  )
  await writeExclusive(out, row)
  return row
}

export function validateBoundaries(row, source, transfers, payouts) {
  if (
    row?.study !== 'apyusd_receipt_cohort_eligibility_boundaries_v1' ||
    row.sourceSha256 !== source.sha256 ||
    row.transfersSha256 !== transfers.sha256 ||
    row.payoutsSha256 !== payouts.sha256 ||
    row.cohortSize !== source.mints.length ||
    !Array.isArray(row.proofs) ||
    row.proofs.length !== source.mints.length ||
    row.proofSha256 !== sha(canonical(row.proofs)) ||
    canonical(row.summary) !== canonical(summary(row.proofs)) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('apyusd_boundaries_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('apyusd_boundaries_hash_invalid')
  for (const [index, proof] of row.proofs.entries()) {
    const mint = source.mints[index]
    if (
      proof.tokenId !== id(mint) ||
      proof.holder !== holder(mint) ||
      proof.before.number + 1 !== proof.firstEligible.number ||
      proof.before.timestamp >= proof.schedule.claimableAt ||
      proof.firstEligible.timestamp < proof.schedule.claimableAt
    )
      throw Error('apyusd_boundary_subject_invalid')
  }
  return row
}

export async function verifyBoundaries(out = OUT) {
  const [source, transfers, payouts, bytes] = await Promise.all([
    verifySource(),
    verifyTransfers(),
    verifyPayouts(),
    readFile(out),
  ])
  if (bytes.length > 131_072) throw Error('apyusd_boundaries_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('apyusd_boundaries_encoding_invalid')
  return validateBoundaries(row, source, transfers, payouts)
}

export async function verifyPartial(out = OUT) {
  const source = await verifySource()
  const proofs = []
  let gap = false
  for (const mint of source.mints) {
    const row = await checkpoint(`${out}.receipts/${id(mint)}.json`, mint)
    if (!row) {
      gap = true
      continue
    }
    if (gap) throw Error('apyusd_boundary_checkpoint_gap')
    proofs.push(row.proof)
  }
  return { ...summary(proofs), cohortSize: source.mints.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify-partial')) {
    console.log(JSON.stringify(await verifyPartial()))
    process.exit(0)
  }
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 12
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24)
    throw Error('apyusd_boundary_limit_invalid')
  const row = process.argv.includes('--verify')
    ? await verifyBoundaries()
    : await captureBoundaries({ limit })
  console.log(JSON.stringify(row.partial ? row : { ...row.summary, sha256: row.sha256 }))
}
