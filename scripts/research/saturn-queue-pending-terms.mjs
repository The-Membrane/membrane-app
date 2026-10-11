// Archived exact pending-ticket terms and net redemption quotes at the fixed cutoff.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { requestWithRetries, writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'

export const OUT = resolve(
  'data/research/venue-signals/saturn-queue-pending-terms-26107302-v1.json',
)
const QUEUE = '0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e'
const VAULT = '0xd166337499e176bbc38a1fbd113ab144e5bd2df7'
const CUTOFF = 26_107_302
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const IMPLEMENTATIONS = [
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
const ABI = parseAbi([
  'function requests(uint256) view returns (uint256 shares,uint256 usdatOwed,uint256 timestamp,uint256 minSharePrice,uint8 status)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function usdatBalance() view returns (uint256)',
  'function paused() view returns (bool)',
  'function marketMode() view returns (uint8)',
])
const SHA = /^[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const BLOCK_TAG = `0x${CUTOFF.toString(16)}`

async function call(origin, to, functionName, args = []) {
  const data = encodeFunctionData({ abi: ABI, functionName, args })
  const raw = await requestWithRetries(origin, 'eth_call', [{ to, data }, BLOCK_TAG])
  return decodeFunctionResult({ abi: ABI, functionName, data: raw })
}

async function deployment(origin) {
  for (const expected of IMPLEMENTATIONS) {
    const raw = await requestWithRetries(origin, 'eth_getStorageAt', [
      expected.proxy,
      SLOT,
      BLOCK_TAG,
    ])
    const implementation = `0x${raw.slice(-40)}`
    if (implementation !== expected.implementation)
      throw Error('saturn_pending_implementation_changed')
    const code = await requestWithRetries(origin, 'eth_getCode', [implementation, BLOCK_TAG])
    if (keccak256(code) !== expected.codeHash) throw Error('saturn_pending_code_changed')
  }
  const [queuePaused, vaultPaused, marketMode, balance] = await Promise.all([
    call(origin, QUEUE, 'paused'),
    call(origin, VAULT, 'paused'),
    call(origin, VAULT, 'marketMode'),
    call(origin, VAULT, 'usdatBalance'),
  ])
  return {
    implementations: IMPLEMENTATIONS,
    queuePaused,
    vaultPaused,
    marketMode: Number(marketMode),
    vaultUsdatBalanceRaw: balance.toString(),
  }
}

async function readTicket(origin, episode) {
  const ticket = await call(origin, QUEUE, 'requests', [BigInt(episode.ticketId)])
  const [shares, usdatOwed, timestamp, minSharePrice, status] = ticket
  if (
    shares.toString() !== episode.sharesRaw ||
    timestamp !== BigInt(episode.requestTimestamp) ||
    usdatOwed !== 0n ||
    status !== 1
  )
    throw Error('saturn_pending_ticket_state_mismatch')
  const quote = await call(origin, VAULT, 'previewRedeem', [shares])
  const netSharePrice = (quote * 10n ** 18n) / shares
  return {
    ticketId: episode.ticketId,
    holder: episode.currentHolder,
    sharesRaw: shares.toString(),
    minSharePriceRaw: minSharePrice.toString(),
    netUsdatQuoteRaw: quote.toString(),
    netSharePriceRaw: netSharePrice.toString(),
    belowCurrentMin: netSharePrice < minSharePrice,
    ageSecondsAtCutoff: episode.waitSeconds,
  }
}

function validateTicket(row, episode) {
  if (
    row?.study !== 'saturn_queue_pending_ticket_terms_v1' ||
    row.ticketId !== episode.ticketId ||
    row.holder !== episode.currentHolder ||
    row.sharesRaw !== episode.sharesRaw ||
    row.ageSecondsAtCutoff !== episode.waitSeconds ||
    !SHA.test(row.sha256 ?? '') ||
    canonical(row.origins) !== canonical(['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'])
  )
    throw Error('saturn_pending_checkpoint_invalid')
  const price = (BigInt(row.netUsdatQuoteRaw) * 10n ** 18n) / BigInt(row.sharesRaw)
  if (
    price.toString() !== row.netSharePriceRaw ||
    price < BigInt(row.minSharePriceRaw) !== row.belowCurrentMin
  )
    throw Error('saturn_pending_price_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('saturn_pending_checkpoint_hash_invalid')
  return row
}

async function checkpoint(path, episode) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.length > 2048) throw Error('saturn_pending_checkpoint_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('saturn_pending_checkpoint_encoding_invalid')
  return validateTicket(row, episode)
}

function pendingEpisodes(episodes) {
  if (episodes.toBlock !== CUTOFF) throw Error('saturn_pending_cutoff_changed')
  return episodes.episodes.filter((episode) => episode.status === 'pending_at_cutoff')
}

function summary(tickets) {
  const below = tickets.filter((ticket) => ticket.belowCurrentMin)
  const quoteEligible = tickets.filter((ticket) => !ticket.belowCurrentMin)
  return {
    pending: tickets.length,
    belowCurrentMin: below.length,
    atOrBelowCurrentQuote: quoteEligible.length,
    belowMinAgedAtLeast7d: below.filter((ticket) => ticket.ageSecondsAtCutoff >= 604800).length,
    quoteEligibleUsdatRaw: quoteEligible
      .reduce((sum, ticket) => sum + BigInt(ticket.netUsdatQuoteRaw), 0n)
      .toString(),
  }
}

export async function capturePending({
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
  limit = 10,
} = {}) {
  const episodes = await verifyEpisodes()
  const pending = pendingEpisodes(episodes)
  const clients = publicRpcClients(urls)
  const origins = ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'].map((host) =>
    clients.find((client) => new URL(client.url).hostname === host),
  )
  if (origins.some((origin) => !origin)) throw Error('saturn_pending_origins_unavailable')
  const [leftDeployment, rightDeployment] = await Promise.all(origins.map(deployment))
  if (canonical(leftDeployment) !== canonical(rightDeployment))
    throw Error('saturn_pending_deployment_origins_disagree')
  const tickets = []
  let captured = 0
  for (const episode of pending) {
    const path = `${out}.tickets/${episode.ticketId}.json`
    let row = await checkpoint(path, episode)
    if (!row && captured < limit) {
      const reads = await Promise.all(origins.map((origin) => readTicket(origin, episode)))
      if (canonical(reads[0]) !== canonical(reads[1]))
        throw Error('saturn_pending_origins_disagree')
      const body = {
        study: 'saturn_queue_pending_ticket_terms_v1',
        ...reads[0],
        origins: ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'],
      }
      row = validateTicket({ ...body, sha256: sha(canonical(body)) }, episode)
      await writeExclusive(path, row)
      captured++
    }
    if (row) tickets.push(row)
  }
  if (tickets.length < pending.length)
    return { partial: true, tickets: tickets.length, totalTickets: pending.length }
  const body = {
    study: 'saturn_queue_pending_terms_cohort_v1',
    sourceEpisodeSha256: episodes.sha256,
    cutoffBlock: CUTOFF,
    cutoffHash: episodes.headers.find((header) => header.number === CUTOFF)?.hash,
    deployment: leftDeployment,
    tickets: tickets.map(({ sha256, ...row }) => ({ ...row, sha256 })),
    summary: summary(tickets),
  }
  const row = { ...body, sha256: sha(canonical(body)) }
  await writeExclusive(out, row)
  return row
}

export async function verifyPending(out = OUT) {
  const episodes = await verifyEpisodes()
  const bytes = await readFile(out)
  if (bytes.length > 65_536) throw Error('saturn_pending_cohort_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  const { sha256: _seal, ...body } = row
  if (
    bytes.toString('utf8') !== `${canonical(row)}\n` ||
    row.study !== 'saturn_queue_pending_terms_cohort_v1' ||
    row.sourceEpisodeSha256 !== episodes.sha256 ||
    row.cutoffBlock !== CUTOFF ||
    row.cutoffHash !== episodes.headers.find((header) => header.number === CUTOFF)?.hash ||
    canonical(row.deployment?.implementations) !== canonical(IMPLEMENTATIONS) ||
    row.sha256 !== sha(canonical(body))
  )
    throw Error('saturn_pending_cohort_invalid')
  const tickets = []
  for (const episode of pendingEpisodes(episodes)) {
    const saved = await checkpoint(`${out}.tickets/${episode.ticketId}.json`, episode)
    if (!saved) throw Error('saturn_pending_checkpoint_missing')
    tickets.push(saved)
  }
  if (
    canonical(row.tickets) !== canonical(tickets) ||
    canonical(row.summary) !== canonical(summary(tickets))
  )
    throw Error('saturn_pending_replay_changed')
  return row
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify')) {
    const row = await verifyPending()
    console.log(JSON.stringify({ summary: row.summary, sha256: row.sha256 }))
  } else {
    const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
    const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 10
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw Error('saturn_pending_limit_invalid')
    const row = await capturePending({ limit })
    console.log(JSON.stringify(row.partial ? row : { summary: row.summary, sha256: row.sha256 }))
  }
}
