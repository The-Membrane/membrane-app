// Two-origin archived proof of the Saturn queue v1-to-v2 implementation boundary.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { requestWithRetries, writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'
import { verifyPending } from './saturn-queue-pending-terms.mjs'

export const OUT = resolve('data/research/venue-signals/saturn-queue-v2-boundary-v1.json')
const QUEUE = '0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e'
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const OLD = '0x256fa0ba1b6dfb50ee883955c5a99d3c1b017fd5'
const NEW = '0xdaf6f8523d7a707d173a12041e1523fdf1373f23'
const LOW = 26_087_302
const HIGH = 26_107_302
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const hex = (n) => `0x${n.toString(16)}`

async function implementation(origins, block) {
  const reads = await Promise.all(
    origins.map((origin) =>
      requestWithRetries(origin, 'eth_getStorageAt', [QUEUE, SLOT, hex(block)]),
    ),
  )
  const left = `0x${reads[0]?.slice(-40).toLowerCase()}`
  const right = `0x${reads[1]?.slice(-40).toLowerCase()}`
  if (left !== right || ![OLD, NEW].includes(left)) throw Error('saturn_upgrade_origins_disagree')
  return { block, implementation: left }
}

async function header(origins, block) {
  const reads = await Promise.all(
    origins.map((origin) =>
      requestWithRetries(origin, 'eth_getBlockByNumber', [hex(block), false]),
    ),
  )
  const normalize = (value) => ({
    number: Number(BigInt(value?.number ?? '0x0')),
    hash: value?.hash?.toLowerCase(),
    timestamp: Number(BigInt(value?.timestamp ?? '0x0')),
  })
  const left = normalize(reads[0])
  if (
    canonical(left) !== canonical(normalize(reads[1])) ||
    left.number !== block ||
    !HASH.test(left.hash ?? '') ||
    !Number.isSafeInteger(left.timestamp)
  )
    throw Error('saturn_upgrade_header_disagreement')
  return left
}

function classify(episodes, pending, boundary) {
  const pendingIds = new Set(pending.tickets.map((ticket) => ticket.ticketId))
  const before = episodes.episodes.filter(
    (episode) => pendingIds.has(episode.ticketId) && episode.requestBlock < boundary,
  )
  const same = episodes.episodes.filter(
    (episode) => pendingIds.has(episode.ticketId) && episode.requestBlock === boundary,
  )
  const after = episodes.episodes.filter(
    (episode) => pendingIds.has(episode.ticketId) && episode.requestBlock > boundary,
  )
  return {
    pendingBeforeUpgrade: before.length,
    pendingAtUpgradeBlock: same.length,
    pendingAfterUpgrade: after.length,
    beforeUpgradeTicketIds: before.map((episode) => episode.ticketId),
    afterUpgradeTicketIds: after.map((episode) => episode.ticketId),
  }
}

export async function captureBoundary({
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
} = {}) {
  const [episodes, pending] = await Promise.all([verifyEpisodes(), verifyPending()])
  const clients = publicRpcClients(urls)
  const origins = ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'].map((host) =>
    clients.find((client) => new URL(client.url).hostname === host),
  )
  if (origins.some((origin) => !origin)) throw Error('saturn_upgrade_origins_unavailable')
  const probes = []
  let low = LOW
  let high = HIGH
  probes.push(await implementation(origins, low), await implementation(origins, high))
  if (probes[0].implementation !== OLD || probes[1].implementation !== NEW)
    throw Error('saturn_upgrade_boundary_changed')
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    const probe = await implementation(origins, mid)
    probes.push(probe)
    if (probe.implementation === OLD) low = mid
    else high = mid
  }
  const [beforeHeader, afterHeader] = await Promise.all([
    header(origins, low),
    header(origins, high),
  ])
  const classification = classify(episodes, pending, high)
  const body = {
    study: 'saturn_queue_v2_boundary_v1',
    sourceEpisodeSha256: episodes.sha256,
    sourcePendingSha256: pending.sha256,
    origins: ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'],
    oldImplementation: OLD,
    newImplementation: NEW,
    lastOldBlock: low,
    firstNewBlock: high,
    beforeHeader,
    afterHeader,
    probes,
    classification,
  }
  const row = { ...body, sha256: sha(canonical(body)) }
  await writeExclusive(out, row)
  return row
}

export async function verifyBoundary(out = OUT) {
  const [episodes, pending] = await Promise.all([verifyEpisodes(), verifyPending()])
  const bytes = await readFile(out)
  if (bytes.length > 16_384) throw Error('saturn_upgrade_artifact_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  const { sha256: _seal, ...body } = row
  if (
    bytes.toString('utf8') !== `${canonical(row)}\n` ||
    row.study !== 'saturn_queue_v2_boundary_v1' ||
    row.sourceEpisodeSha256 !== episodes.sha256 ||
    row.sourcePendingSha256 !== pending.sha256 ||
    row.oldImplementation !== OLD ||
    row.newImplementation !== NEW ||
    !SHA.test(row.sha256 ?? '') ||
    row.sha256 !== sha(canonical(body)) ||
    row.lastOldBlock + 1 !== row.firstNewBlock ||
    row.beforeHeader.number !== row.lastOldBlock ||
    row.afterHeader.number !== row.firstNewBlock ||
    canonical(row.classification) !== canonical(classify(episodes, pending, row.firstNewBlock))
  )
    throw Error('saturn_upgrade_artifact_invalid')
  let low = LOW
  let high = HIGH
  if (
    canonical(row.probes.slice(0, 2)) !==
    canonical([
      { block: LOW, implementation: OLD },
      { block: HIGH, implementation: NEW },
    ])
  )
    throw Error('saturn_upgrade_endpoint_invalid')
  for (const probe of row.probes.slice(2)) {
    const mid = Math.floor((low + high) / 2)
    if (probe.block !== mid || ![OLD, NEW].includes(probe.implementation))
      throw Error('saturn_upgrade_probe_invalid')
    if (probe.implementation === OLD) low = mid
    else high = mid
  }
  if (low !== row.lastOldBlock || high !== row.firstNewBlock)
    throw Error('saturn_upgrade_replay_changed')
  return row
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const row = process.argv.includes('--verify') ? await verifyBoundary() : await captureBoundary()
  console.log(
    JSON.stringify({
      lastOldBlock: row.lastOldBlock,
      firstNewBlock: row.firstNewBlock,
      firstNewAt: new Date(row.afterHeader.timestamp * 1000).toISOString(),
      classification: row.classification,
      sha256: row.sha256,
    }),
  )
}
