// One read-only, two-origin snapshot of the fixed Saturn pending-ticket cohort.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { keccak256, parseAbi } from 'viem'

import { writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import {
  configuredClients,
  finalizedPair,
  retryTransient,
} from './carry-local-staked-usdat-holder.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'
import { verifyPending } from './saturn-queue-pending-terms.mjs'

export const OUT = resolve(
  'data/research/venue-signals/saturn-queue-pending-current-20261003-v1.json',
)
const QUEUE = '0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e'
const VAULT = '0xd166337499e176bbc38a1fbd113ab144e5bd2df7'
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const PINS = [
  {
    proxy: QUEUE,
    implementation: '0xdaf6f8523d7a707d173a12041e1523fdf1373f23',
    codeHash: '0x537d27c7b1574e4ab94867b9f5719414169c5941387346bca88b84643612256d',
  },
  {
    proxy: VAULT,
    implementation: '0x2b7074cf6681382b70e239063931ebe83c0f4e0a',
    codeHash: '0xec3b77f722a89eec23e7dfb2ddfe63e4d82f37adbc5f75a269ed2c82c3ad0300',
  },
]
const QUEUE_ABI = parseAbi([
  'function requests(uint256) view returns (uint256 shares,uint256 usdatOwed,uint256 timestamp,uint256 minSharePrice,uint8 status)',
  'function ownerOf(uint256) view returns (address)',
])
const VAULT_ABI = parseAbi(['function previewRedeem(uint256) view returns (uint256)'])
const hash = (value) => createHash('sha256').update(value).digest('hex')
const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase()
const decimal = (value) => typeof value === 'string' && /^\d+$/.test(value)
const address = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
const blockHash = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

async function pinnedDeployment(entry, block) {
  for (const pin of PINS) {
    const implementation = await entry.client.getStorageAt({
      address: pin.proxy,
      slot: SLOT,
      blockNumber: BigInt(block.number),
    })
    if (!same(`0x${implementation.slice(-40)}`, pin.implementation))
      throw Error('saturn_current_implementation_changed')
    const code = await entry.client.getCode({
      address: pin.implementation,
      blockNumber: BigInt(block.number),
    })
    if (!code || !same(keccak256(code), pin.codeHash)) throw Error('saturn_current_code_changed')
  }
}

export async function ticketAt(entry, block, original) {
  const pinned = { blockHash: block.hash, requireCanonical: true }
  const id = BigInt(original.ticketId)
  const [shares, usdatOwed, timestamp, minSharePrice, rawStatus] = await entry.client.readContract({
    address: QUEUE,
    abi: QUEUE_ABI,
    functionName: 'requests',
    args: [id],
    ...pinned,
  })
  const status = Number(rawStatus)
  if (
    !Number.isSafeInteger(status) ||
    status < 0 ||
    status > 5 ||
    (status === 1 &&
      (shares.toString() !== original.sharesRaw ||
        timestamp.toString() !== original.requestTimestamp))
  )
    throw Error('saturn_current_ticket_identity_changed')
  let owner = null
  let quote = null
  let belowMin = null
  if (status === 1) {
    owner = await entry.client.readContract({
      address: QUEUE,
      abi: QUEUE_ABI,
      functionName: 'ownerOf',
      args: [id],
      ...pinned,
    })
    quote = await entry.client.readContract({
      address: VAULT,
      abi: VAULT_ABI,
      functionName: 'previewRedeem',
      args: [shares],
      ...pinned,
    })
    belowMin = (quote * 10n ** 18n) / shares < minSharePrice
  }
  return {
    ticketId: original.ticketId,
    status,
    sharesRaw: shares.toString(),
    usdatOwedRaw: usdatOwed.toString(),
    requestTimestamp: timestamp.toString(),
    minSharePriceRaw: minSharePrice.toString(),
    owner,
    originalHolder: original.holder,
    quoteUsdatRaw: quote?.toString() ?? null,
    belowMin,
  }
}

export function summarize(rows) {
  const requested = rows.filter((row) => row.status === 1)
  return {
    cohort: rows.length,
    stillRequested: requested.length,
    noLongerRequested: rows.length - requested.length,
    requestedPriceGated: requested.filter((row) => row.belowMin === true).length,
    requestedQuoteEligible: requested.filter((row) => row.belowMin === false).length,
    requestedHolderChanged: requested.filter((row) => !same(row.owner, row.originalHolder)).length,
  }
}

export function summarizeElapsedPriceGate(rows, blockTimestamp) {
  if (!Number.isSafeInteger(blockTimestamp) || blockTimestamp <= 0)
    throw Error('saturn_current_block_time_invalid')
  const elapsed = rows
    .filter((row) => row.status === 1 && row.belowMin === true)
    .map((row) => {
      const requestedAt = Number(row.requestTimestamp)
      if (!Number.isSafeInteger(requestedAt) || requestedAt <= 0 || requestedAt > blockTimestamp)
        throw Error('saturn_current_request_time_invalid')
      return blockTimestamp - requestedAt
    })
    .sort((left, right) => left - right)
  const middle = Math.floor(elapsed.length / 2)
  return {
    medianElapsedSeconds:
      elapsed.length === 0
        ? null
        : elapsed.length % 2 === 1
          ? elapsed[middle]
          : Math.floor((elapsed[middle - 1] + elapsed[middle]) / 2),
    atLeastSevenDays: elapsed.filter((seconds) => seconds >= 7 * 86400).length,
  }
}

export function validateSnapshotRow(ticket, original, requestTimestamp) {
  if (
    ticket?.ticketId !== original.ticketId ||
    ticket.originalHolder !== original.holder ||
    !Number.isSafeInteger(ticket.status) ||
    ticket.status < 0 ||
    ticket.status > 5 ||
    !decimal(ticket.sharesRaw) ||
    !decimal(ticket.usdatOwedRaw) ||
    !decimal(ticket.requestTimestamp) ||
    !decimal(ticket.minSharePriceRaw)
  )
    throw Error('saturn_current_ticket_mismatch')
  if (ticket.status === 1) {
    if (
      ticket.sharesRaw !== original.sharesRaw ||
      ticket.requestTimestamp !== String(requestTimestamp) ||
      !address(ticket.owner) ||
      !decimal(ticket.quoteUsdatRaw) ||
      BigInt(ticket.sharesRaw) === 0n ||
      ticket.belowMin !==
        (BigInt(ticket.quoteUsdatRaw) * 10n ** 18n) / BigInt(ticket.sharesRaw) <
          BigInt(ticket.minSharePriceRaw)
    )
      throw Error('saturn_current_ticket_mismatch')
  } else if (ticket.owner !== null || ticket.quoteUsdatRaw !== null || ticket.belowMin !== null) {
    throw Error('saturn_current_ticket_mismatch')
  }
  return ticket
}

export async function observe() {
  const cohort = await verifyPending()
  const episodes = await verifyEpisodes()
  const originalById = new Map(episodes.episodes.map((episode) => [episode.ticketId, episode]))
  const allowed = new Set(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
  const { pair, block } = await finalizedPair(
    configuredClients().filter((entry) => allowed.has(entry.source)),
  )
  await Promise.all(pair.map((entry) => pinnedDeployment(entry, block)))
  const rows = []
  for (const original of cohort.tickets) {
    const requestTimestamp = originalById.get(original.ticketId)?.requestTimestamp
    if (requestTimestamp === undefined) throw Error('saturn_current_episode_missing')
    const expected = { ...original, requestTimestamp: String(requestTimestamp) }
    const [left, right] = await Promise.all(
      pair.map((entry) => retryTransient(() => ticketAt(entry, block, expected))),
    )
    if (JSON.stringify(left) !== JSON.stringify(right))
      throw Error('saturn_current_origins_disagree')
    rows.push(validateSnapshotRow(left, original, requestTimestamp))
    await new Promise((done) => setTimeout(done, 200))
  }
  const body = {
    study: 'saturn_queue_pending_current_v1',
    sourceSha256: cohort.sha256,
    capturedAtUtc: new Date().toISOString(),
    block: {
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
    },
    sources: pair.map((entry) => entry.source),
    rows,
    summary: summarize(rows),
  }
  const result = { ...body, sha256: hash(JSON.stringify(body)) }
  return result
}

export async function capture(out = OUT) {
  const result = await observe()
  await writeExclusive(out, result)
  return result
}

export function validateCurrentSnapshot(row, cohort, episodes) {
  const originalById = new Map(episodes.episodes.map((episode) => [episode.ticketId, episode]))
  const { sha256, ...body } = row
  if (
    row.study !== 'saturn_queue_pending_current_v1' ||
    row.sourceSha256 !== cohort.sha256 ||
    !Number.isSafeInteger(row.block?.number) ||
    row.block.number <= cohort.cutoffBlock ||
    !blockHash(row.block.hash) ||
    !Number.isSafeInteger(row.block.timestamp) ||
    row.block.timestamp <= 0 ||
    JSON.stringify(row.sources) !== JSON.stringify(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']) ||
    sha256 !== hash(JSON.stringify(body)) ||
    row.rows.length !== cohort.tickets.length ||
    JSON.stringify(row.summary) !== JSON.stringify(summarize(row.rows))
  )
    throw Error('saturn_current_invalid')
  for (const [index, original] of cohort.tickets.entries()) {
    validateSnapshotRow(
      row.rows[index],
      original,
      originalById.get(original.ticketId)?.requestTimestamp,
    )
  }
  summarizeElapsedPriceGate(row.rows, row.block.timestamp)
  return row
}

export async function verify(out = OUT) {
  const cohort = await verifyPending()
  const episodes = await verifyEpisodes()
  const bytes = await readFile(out, 'utf8')
  if (Buffer.byteLength(bytes) > 80_000) throw Error('saturn_current_oversize')
  const row = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(row)}\n`) throw Error('saturn_current_invalid')
  return validateCurrentSnapshot(row, cohort, episodes)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2]
    if (!['--capture', '--verify'].includes(mode)) throw Error('usage: --capture|--verify')
    const row = mode === '--capture' ? await capture() : await verify()
    console.log(
      JSON.stringify({ block: row.block.number, summary: row.summary, sha256: row.sha256 }),
    )
  } catch (error) {
    const code = /^saturn_[a-z0-9_]+$/.test(String(error.message))
      ? error.message
      : 'rpc_or_unexpected_failure'
    console.error(`saturn_current:${code}`)
    process.exitCode = 1
  }
}
