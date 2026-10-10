// Two-origin proof of an actual owner limit update in the pending Saturn cohort.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem'

import { writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { configuredClients } from './carry-local-staked-usdat-holder.mjs'
import { verify } from './saturn-queue-pending-current.mjs'
import { verifyPending } from './saturn-queue-pending-terms.mjs'

export const OUT = resolve('data/research/venue-signals/saturn-queue-limit-update-1659-v1.json')
const TX = '0x13adfb612bd15ea93f775b62a708ad683ac31d0f7f7b2eef4b74fa59cf1a63ab'
const QUEUE = '0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e'
const TOKEN_ID = '1659'
const TOPIC = keccak256(stringToHex('MinSharePriceUpdated(uint256,uint256)'))
const ABI = parseAbi(['function updateMinSharePrice(uint256 tokenId,uint256 newMinSharePrice)'])
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

export function normalizeProof(transaction, receipt, holder, newMin, snapshotBlock) {
  if (
    receipt.status !== 'success' ||
    !same(transaction.from, holder) ||
    !same(transaction.to, QUEUE) ||
    receipt.transactionHash !== TX ||
    Number(receipt.blockNumber) >= snapshotBlock
  )
    throw Error('saturn_limit_update_transaction_invalid')
  const call = decodeFunctionData({ abi: ABI, data: transaction.input })
  if (
    call.functionName !== 'updateMinSharePrice' ||
    call.args[0].toString() !== TOKEN_ID ||
    call.args[1].toString() !== newMin
  )
    throw Error('saturn_limit_update_calldata_invalid')
  const matches = receipt.logs.filter(
    (log) =>
      same(log.address, QUEUE) &&
      same(log.topics[0], TOPIC) &&
      log.topics.length === 2 &&
      BigInt(log.topics[1]) === BigInt(TOKEN_ID) &&
      BigInt(log.data) === BigInt(newMin),
  )
  if (matches.length !== 1) throw Error('saturn_limit_update_event_invalid')
  return {
    txHash: TX,
    block: Number(receipt.blockNumber),
    blockHash: receipt.blockHash,
    holder: transaction.from.toLowerCase(),
    queue: transaction.to.toLowerCase(),
    tokenId: TOKEN_ID,
    newMinSharePriceRaw: newMin,
    eventLogIndex: Number(matches[0].logIndex),
  }
}

export async function capture(out = OUT) {
  const snapshot = await verify()
  const historical = await verifyPending()
  const current = snapshot.rows.find((row) => row.ticketId === TOKEN_ID)
  const old = historical.tickets.find((row) => row.ticketId === TOKEN_ID)
  if (
    !current ||
    !old ||
    current.status !== 1 ||
    current.originalHolder.toLowerCase() !== current.owner.toLowerCase() ||
    BigInt(current.minSharePriceRaw) >= BigInt(old.minSharePriceRaw)
  )
    throw Error('saturn_limit_update_snapshots_invalid')
  const sources = configuredClients().filter((entry) =>
    ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].includes(entry.source),
  )
  if (sources.length !== 2) throw Error('saturn_limit_update_origins_missing')
  const proofs = await Promise.all(
    sources.map(async (entry) => {
      const [transaction, receipt] = await Promise.all([
        entry.client.getTransaction({ hash: TX }),
        entry.client.getTransactionReceipt({ hash: TX }),
      ])
      return normalizeProof(
        transaction,
        receipt,
        current.originalHolder,
        current.minSharePriceRaw,
        snapshot.block.number,
      )
    }),
  )
  if (JSON.stringify(proofs[0]) !== JSON.stringify(proofs[1]))
    throw Error('saturn_limit_update_origins_disagree')
  const body = {
    study: 'saturn_queue_limit_update_1659_v1',
    historicalSha256: historical.sha256,
    currentSha256: snapshot.sha256,
    oldMinSharePriceRaw: old.minSharePriceRaw,
    proof: proofs[0],
    origins: sources.map((entry) => entry.source),
  }
  const row = { ...body, sha256: sha(JSON.stringify(body)) }
  await writeExclusive(out, row)
  return row
}

export async function verifyProof(out = OUT) {
  const snapshot = await verify()
  const historical = await verifyPending()
  const bytes = await readFile(out, 'utf8')
  if (Buffer.byteLength(bytes) > 4096) throw Error('saturn_limit_update_oversize')
  const row = JSON.parse(bytes)
  const { sha256, ...body } = row
  const current = snapshot.rows.find((item) => item.ticketId === TOKEN_ID)
  const old = historical.tickets.find((item) => item.ticketId === TOKEN_ID)
  if (
    bytes !== `${JSON.stringify(row)}\n` ||
    row.study !== 'saturn_queue_limit_update_1659_v1' ||
    row.currentSha256 !== snapshot.sha256 ||
    row.historicalSha256 !== historical.sha256 ||
    row.oldMinSharePriceRaw !== old?.minSharePriceRaw ||
    row.proof?.newMinSharePriceRaw !== current?.minSharePriceRaw ||
    row.proof?.txHash !== TX ||
    row.proof?.tokenId !== TOKEN_ID ||
    !same(row.proof?.queue, QUEUE) ||
    !same(row.proof?.holder, current?.originalHolder) ||
    !Number.isSafeInteger(row.proof?.block) ||
    row.proof.block <= historical.cutoffBlock ||
    row.proof?.block >= snapshot.block.number ||
    !/^0x[0-9a-f]{64}$/.test(row.proof?.blockHash ?? '') ||
    !Number.isSafeInteger(row.proof?.eventLogIndex) ||
    JSON.stringify(row.origins) !== JSON.stringify(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']) ||
    sha256 !== sha(JSON.stringify(body))
  )
    throw Error('saturn_limit_update_proof_invalid')
  return row
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2]
    if (!['--capture', '--verify'].includes(mode)) throw Error('usage: --capture|--verify')
    const row = mode === '--capture' ? await capture() : await verifyProof()
    console.log(
      JSON.stringify({
        tokenId: row.proof.tokenId,
        block: row.proof.block,
        oldMin: row.oldMinSharePriceRaw,
        newMin: row.proof.newMinSharePriceRaw,
        sha256: row.sha256,
      }),
    )
  } catch (error) {
    const code = /^saturn_[a-z0-9_]+$/.test(String(error.message))
      ? error.message
      : 'rpc_or_unexpected_failure'
    console.error(`saturn_limit_update:${code}`)
    process.exitCode = 1
  }
}
