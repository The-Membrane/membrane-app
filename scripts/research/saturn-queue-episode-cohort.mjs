// Exact request-to-processing episodes for the fixed Saturn queue event window.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { requestWithRetries, writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { OUT as EVENTS_OUT, TO, verifyQueueEvents } from './saturn-queue-event-cohort.mjs'

export const OUT = resolve(
  'data/research/venue-signals/saturn-queue-episodes-26007302-26107302-v1.json',
)
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const ZERO = '0x0000000000000000000000000000000000000000'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const blockHex = (n) => `0x${n.toString(16)}`
const id = (log) => BigInt(log.topics[log.kind === 'transfer' ? 3 : 1]).toString()
const address = (topic) => `0x${topic.slice(-40)}`
const word = (data, index) => BigInt(`0x${data.slice(2 + index * 64, 66 + index * 64)}`).toString()
const position = (log) =>
  `${String(log.blockNumber).padStart(9, '0')}:${String(log.logIndex).padStart(6, '0')}`

function normalizeHeader(block, expectedNumber, expectedHash) {
  const number = Number(BigInt(block?.number ?? '0x0'))
  const hash = block?.hash?.toLowerCase()
  const timestamp = Number(BigInt(block?.timestamp ?? '0x0'))
  if (
    number !== expectedNumber ||
    hash !== expectedHash ||
    !HASH.test(hash) ||
    !Number.isSafeInteger(timestamp)
  )
    throw Error('saturn_queue_header_invalid')
  return { number, hash, timestamp }
}

function validateHeader(row, number, hash) {
  if (
    row?.study !== 'saturn_queue_two_origin_header_v1' ||
    row.number !== number ||
    (hash && row.hash !== hash) ||
    !HASH.test(row.hash ?? '') ||
    !Number.isSafeInteger(row.timestamp) ||
    row.timestamp <= 0 ||
    canonical(row.origins) !== canonical(['rpc.ankr.com', 'eth-mainnet.g.alchemy.com']) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('saturn_queue_header_checkpoint_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body)))
    throw Error('saturn_queue_header_checkpoint_hash_invalid')
  return row
}

async function headerCheckpoint(path, number, hash) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.length > 2048) throw Error('saturn_queue_header_checkpoint_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('saturn_queue_header_checkpoint_encoding_invalid')
  return validateHeader(row, number, hash)
}

function requiredHeaders(events) {
  const map = new Map()
  for (const log of events.logs)
    if (log.kind === 'processed') {
      const before = map.get(log.blockNumber)
      if (before && before !== log.blockHash) throw Error('saturn_queue_block_hash_disagreement')
      map.set(log.blockNumber, log.blockHash)
    }
  if (!map.has(TO)) map.set(TO, null)
  return [...map].sort((a, b) => a[0] - b[0])
}

async function captureHeader(number, expectedHash, origins, out) {
  const path = `${out}.headers/${number}.json`
  let row = await headerCheckpoint(path, number, expectedHash)
  if (row) return row
  const reads = await Promise.all(
    origins.map((origin) =>
      requestWithRetries(origin, 'eth_getBlockByNumber', [blockHex(number), false]),
    ),
  )
  const firstHash = expectedHash ?? reads[0]?.hash?.toLowerCase()
  const headers = reads.map((block) => normalizeHeader(block, number, firstHash))
  if (canonical(headers[0]) !== canonical(headers[1]))
    throw Error('saturn_queue_header_origins_disagree')
  const body = {
    study: 'saturn_queue_two_origin_header_v1',
    ...headers[0],
    origins: ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'],
  }
  row = validateHeader({ ...body, sha256: sha(canonical(body)) }, number, firstHash)
  await writeExclusive(path, row)
  return row
}

function buildEpisodes(events, headers) {
  const byId = new Map()
  const transfers = new Map()
  for (const log of events.logs) {
    const ticket = id(log)
    if (log.kind === 'transfer') {
      if (!transfers.has(ticket)) transfers.set(ticket, [])
      transfers.get(ticket).push(log)
      continue
    }
    if (!byId.has(ticket)) byId.set(ticket, {})
    const entry = byId.get(ticket)
    if (entry[log.kind]) throw Error('saturn_queue_duplicate_ticket_event')
    entry[log.kind] = log
  }
  const episodes = []
  for (const [ticket, entry] of byId) {
    const request = entry.requested
    if (!request) continue // Left-truncated requests are not denominator members.
    const mint = transfers
      .get(ticket)
      ?.find(
        (log) =>
          log.transactionHash === request.transactionHash &&
          address(log.topics[1]) === ZERO &&
          address(log.topics[2]) === address(request.topics[2]),
      )
    if (!mint || position(mint) >= position(request))
      throw Error('saturn_queue_request_mint_missing')
    if (entry.cancelled) throw Error('saturn_queue_cancelled_cohort_unhandled')
    const process = entry.processed
    const claim = entry.claimed
    if (claim && !process) throw Error('saturn_queue_claim_without_process')
    if (process && position(process) <= position(request))
      throw Error('saturn_queue_process_order_invalid')
    if (claim && position(claim) <= position(process))
      throw Error('saturn_queue_claim_order_invalid')
    const requestTimestamp = Number(BigInt(word(request.data, 1)))
    if (!Number.isSafeInteger(requestTimestamp)) throw Error('saturn_queue_request_time_invalid')
    if (process && word(request.data, 0) !== word(process.data, 0))
      throw Error('saturn_queue_share_mismatch')
    if (claim && word(process.data, 1) !== word(claim.data, 0))
      throw Error('saturn_queue_claim_amount_mismatch')
    const currentHolder = claim ? address(claim.topics[2]) : address(request.topics[2])
    const burn =
      claim &&
      transfers
        .get(ticket)
        ?.find(
          (log) =>
            log.transactionHash === claim.transactionHash &&
            address(log.topics[1]) === currentHolder &&
            address(log.topics[2]) === ZERO,
        )
    if (claim && !burn) throw Error('saturn_queue_claim_burn_missing')
    const priorTransfers = (transfers.get(ticket) ?? []).filter(
      (log) => position(log) > position(mint) && (!claim || position(log) < position(burn)),
    )
    let owner = address(request.topics[2])
    for (const log of priorTransfers) {
      if (address(log.topics[1]) !== owner || address(log.topics[2]) === ZERO)
        throw Error('saturn_queue_holder_continuity_invalid')
      owner = address(log.topics[2])
    }
    if (claim && owner !== currentHolder) throw Error('saturn_queue_claim_holder_invalid')
    const endHeader = headers.get(process?.blockNumber ?? TO)
    if (!endHeader || endHeader.timestamp < requestTimestamp)
      throw Error('saturn_queue_episode_time_invalid')
    episodes.push({
      ticketId: ticket,
      requestBlock: request.blockNumber,
      requestTimestamp,
      requestHolder: address(request.topics[2]),
      currentHolder: owner,
      holderTransfers: priorTransfers.length,
      sharesRaw: word(request.data, 0),
      processedBlock: process?.blockNumber ?? null,
      usdatOwedRaw: process ? word(process.data, 1) : null,
      claimedBlock: claim?.blockNumber ?? null,
      claimedHolder: claim ? currentHolder : null,
      status: claim ? 'claimed' : process ? 'processed_unclaimed' : 'pending_at_cutoff',
      waitSeconds: endHeader.timestamp - requestTimestamp,
      waitCensored: !process,
    })
  }
  return episodes.sort(
    (a, b) =>
      a.requestBlock - b.requestBlock ||
      (BigInt(a.ticketId) < BigInt(b.ticketId)
        ? -1
        : BigInt(a.ticketId) > BigInt(b.ticketId)
          ? 1
          : 0),
  )
}

function waitSummary(episodes) {
  const observed = episodes
    .filter((row) => !row.waitCensored)
    .map((row) => row.waitSeconds)
    .sort((a, b) => a - b)
  const quantile = (p) => observed[Math.floor((observed.length - 1) * p)]
  const counts = {
    requested: episodes.length,
    processed: observed.length,
    claimed: episodes.filter((row) => row.status === 'claimed').length,
    processedUnclaimed: episodes.filter((row) => row.status === 'processed_unclaimed').length,
    pendingCensored: episodes.filter((row) => row.waitCensored).length,
    holderTransfers: episodes.reduce((sum, row) => sum + row.holderTransfers, 0),
  }
  return {
    counts,
    observedWaitSeconds: observed.length
      ? {
          min: observed[0],
          p25: quantile(0.25),
          median: quantile(0.5),
          p75: quantile(0.75),
          max: observed.at(-1),
        }
      : null,
  }
}

async function sourceEvents() {
  const events = await verifyQueueEvents()
  const bytes = await readFile(EVENTS_OUT)
  return { events, sourcePhysicalSha256: sha(bytes) }
}

export async function captureEpisodes({
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
  limit = 8,
} = {}) {
  const { events, sourcePhysicalSha256 } = await sourceEvents()
  const clients = publicRpcClients(urls)
  const origins = ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'].map((host) =>
    clients.find((client) => new URL(client.url).hostname === host),
  )
  if (origins.some((origin) => !origin)) throw Error('saturn_queue_header_origins_unavailable')
  const headers = new Map()
  let captured = 0
  for (const [number, hash] of requiredHeaders(events)) {
    const path = `${out}.headers/${number}.json`
    let row = await headerCheckpoint(path, number, hash)
    if (!row && captured < limit) {
      row = await captureHeader(number, hash, origins, out)
      captured++
    }
    if (row) headers.set(number, row)
  }
  if (headers.size < requiredHeaders(events).length)
    return { partial: true, headers: headers.size, totalHeaders: requiredHeaders(events).length }
  const episodes = buildEpisodes(events, headers)
  const body = {
    study: 'saturn_queue_episode_cohort_v1',
    sourcePhysicalSha256,
    sourceSha256: events.sha256,
    fromBlock: events.fromBlock,
    toBlock: events.toBlock,
    headers: [...headers.values()].map(({ number, hash, timestamp, sha256 }) => ({
      number,
      hash,
      timestamp,
      sha256,
    })),
    episodes,
    summary: waitSummary(episodes),
  }
  const row = { ...body, sha256: sha(canonical(body)) }
  await writeExclusive(out, row)
  return row
}

export async function verifyEpisodes(out = OUT) {
  const { events, sourcePhysicalSha256 } = await sourceEvents()
  const bytes = await readFile(out)
  if (bytes.length > 262_144) throw Error('saturn_queue_episode_cohort_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  const { sha256: _seal, ...body } = row
  if (
    bytes.toString('utf8') !== `${canonical(row)}\n` ||
    row.study !== 'saturn_queue_episode_cohort_v1' ||
    row.sourcePhysicalSha256 !== sourcePhysicalSha256 ||
    row.sourceSha256 !== events.sha256 ||
    row.sha256 !== sha(canonical(body))
  )
    throw Error('saturn_queue_episode_cohort_invalid')
  const headers = new Map()
  for (const [number, hash] of requiredHeaders(events)) {
    const saved = await headerCheckpoint(`${out}.headers/${number}.json`, number, hash)
    if (!saved) throw Error('saturn_queue_header_missing')
    headers.set(number, saved)
  }
  const rebuilt = buildEpisodes(events, headers)
  if (
    canonical(row.headers) !==
      canonical(
        [...headers.values()].map(({ number, hash, timestamp, sha256 }) => ({
          number,
          hash,
          timestamp,
          sha256,
        })),
      ) ||
    canonical(row.episodes) !== canonical(rebuilt) ||
    canonical(row.summary) !== canonical(waitSummary(rebuilt))
  )
    throw Error('saturn_queue_episode_replay_changed')
  return row
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify')) {
    const row = await verifyEpisodes()
    console.log(JSON.stringify({ summary: row.summary, sha256: row.sha256 }))
  } else {
    const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
    const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 8
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw Error('saturn_queue_limit_invalid')
    const row = await captureEpisodes({ limit })
    console.log(JSON.stringify(row.partial ? row : { summary: row.summary, sha256: row.sha256 }))
  }
}
