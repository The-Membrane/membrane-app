// Fixed retrospective Saturn queue event window, including zero-event windows.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { keccak256, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { requestWithRetries, writeExclusive } from './apyusd-receipt-cohort-source.mjs'

export const OUT = resolve(
  'data/research/venue-signals/saturn-queue-events-26007302-26107302-v1.json',
)
export const FROM = 26_007_302
export const TO = 26_107_302
export const QUEUE = '0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e'
const STEP = 10_000
const EVENTS = Object.freeze({
  requested: keccak256(stringToHex('WithdrawalRequested(uint256,address,uint256,uint256)')),
  processed: keccak256(stringToHex('WithdrawalProcessed(uint256,uint256,uint256)')),
  claimed: keccak256(stringToHex('Claimed(uint256,address,uint256)')),
  cancelled: keccak256(stringToHex('RequestCancelled(uint256,address,uint256)')),
  transfer: keccak256(stringToHex('Transfer(address,address,uint256)')),
})
const KINDS = new Map(Object.entries(EVENTS).map(([kind, topic]) => [topic, kind]))
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const ORIGIN_PAIRS = [
  ['rpc.ankr.com', 'mainnet.infura.io'],
  ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com'],
]
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const hex = (n) => `0x${n.toString(16)}`

export function normalize(log, low, high) {
  const blockNumber = Number(BigInt(log.blockNumber ?? '0x0'))
  const logIndex = Number(BigInt(log.logIndex ?? '0x0'))
  const topics = log.topics?.map((topic) => topic.toLowerCase())
  const kind = KINDS.get(topics?.[0])
  if (
    log.address?.toLowerCase() !== QUEUE ||
    !kind ||
    !Number.isSafeInteger(blockNumber) ||
    blockNumber < low ||
    blockNumber > high ||
    !Number.isSafeInteger(logIndex) ||
    logIndex < 0 ||
    !HASH.test(log.blockHash?.toLowerCase() ?? '') ||
    !HASH.test(log.transactionHash?.toLowerCase() ?? '') ||
    !Array.isArray(topics) ||
    !topics.every((topic) => HASH.test(topic)) ||
    !/^0x(?:[0-9a-f]{64})*$/.test(log.data?.toLowerCase() ?? '') ||
    topics.length !== (kind === 'transfer' ? 4 : kind === 'processed' ? 2 : 3) ||
    log.data.length !==
      (kind === 'transfer' ? 2 : kind === 'requested' || kind === 'processed' ? 130 : 66)
  )
    throw Error('saturn_queue_event_invalid')
  return {
    kind,
    blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex,
    topics,
    data: log.data.toLowerCase(),
  }
}

function validateWindow(row, low, high) {
  if (
    row?.study !== 'saturn_queue_event_window_v1' ||
    row.fromBlock !== low ||
    row.toBlock !== high ||
    !ORIGIN_PAIRS.some((pair) => canonical(row.origins) === canonical(pair)) ||
    !Array.isArray(row.logs) ||
    row.logsSha256 !== sha(canonical(row.logs)) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('saturn_queue_window_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('saturn_queue_window_hash_invalid')
  for (const [index, log] of row.logs.entries()) {
    const raw = {
      ...log,
      address: QUEUE,
      blockNumber: hex(log.blockNumber),
      logIndex: hex(log.logIndex),
    }
    if (canonical(normalize(raw, low, high)) !== canonical(log))
      throw Error('saturn_queue_window_log_invalid')
    if (
      index > 0 &&
      (log.blockNumber < row.logs[index - 1].blockNumber ||
        (log.blockNumber === row.logs[index - 1].blockNumber &&
          log.logIndex <= row.logs[index - 1].logIndex))
    )
      throw Error('saturn_queue_window_order_invalid')
  }
  return row
}

async function checkpoint(path, low, high) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.length > 262_144) throw Error('saturn_queue_window_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('saturn_queue_window_encoding_invalid')
  return validateWindow(row, low, high)
}

async function logsAt(origin, low, high) {
  const raw = await requestWithRetries(origin, 'eth_getLogs', [
    { address: QUEUE, fromBlock: hex(low), toBlock: hex(high), topics: [Object.values(EVENTS)] },
  ])
  if (!Array.isArray(raw)) throw Error('saturn_queue_logs_invalid')
  return raw.map((log) => normalize(log, low, high))
}

function validateSubrange(row, low, high) {
  if (
    row?.study !== 'saturn_queue_infura_subrange_v1' ||
    row.fromBlock !== low ||
    row.toBlock !== high ||
    row.origin !== 'mainnet.infura.io' ||
    !Array.isArray(row.logs) ||
    row.logsSha256 !== sha(canonical(row.logs)) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('saturn_queue_subrange_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('saturn_queue_subrange_hash_invalid')
  for (const log of row.logs)
    if (
      canonical(
        normalize(
          {
            ...log,
            address: QUEUE,
            blockNumber: hex(log.blockNumber),
            logIndex: hex(log.logIndex),
          },
          low,
          high,
        ),
      ) !== canonical(log)
    )
      throw Error('saturn_queue_subrange_log_invalid')
  return row
}

async function subrangeCheckpoint(path, low, high) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.length > 65_536) throw Error('saturn_queue_subrange_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('saturn_queue_subrange_encoding_invalid')
  return validateSubrange(row, low, high)
}

async function boundedInfuraLogs(origin, low, high, outPath) {
  const logs = []
  for (let start = low; start <= high; start += 1_000) {
    const end = Math.min(high, start + 999)
    const path = `${outPath}.infura-subranges/${start}-${end}.json`
    let row = await subrangeCheckpoint(path, start, end)
    if (!row) {
      // Infura's compute throttle accepts short ranges but rejects rapid repeats.
      await new Promise((done) => setTimeout(done, 3_000))
      const found = await logsAt(origin, start, end)
      const body = {
        study: 'saturn_queue_infura_subrange_v1',
        fromBlock: start,
        toBlock: end,
        origin: 'mainnet.infura.io',
        logs: found,
        logsSha256: sha(canonical(found)),
      }
      row = validateSubrange({ ...body, sha256: sha(canonical(body)) }, start, end)
      await writeExclusive(path, row)
      console.error(`saturn_infura_subrange ${start}-${end} logs=${found.length}`)
    }
    logs.push(...row.logs)
  }
  return logs
}

const windowBounds = () => {
  const out = []
  for (let low = FROM; low <= TO; low += STEP) out.push([low, Math.min(TO, low + STEP - 1)])
  return out
}

export async function captureQueueEvents({
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
  limit = 3,
} = {}) {
  const origins = publicRpcClients(urls)
  const ankr = origins.find((origin) => new URL(origin.url).hostname === 'rpc.ankr.com')
  const infura = origins.find((origin) => new URL(origin.url).hostname === 'mainnet.infura.io')
  if (!ankr || !infura) throw Error('saturn_queue_origins_unavailable')
  const windows = []
  const logs = []
  let newWindows = 0
  for (const [low, high] of windowBounds()) {
    const path = `${out}.windows/${low}-${high}.json`
    let row = await checkpoint(path, low, high)
    if (!row) {
      if (newWindows >= limit) break
      const left = await logsAt(ankr, low, high)
      const right = await boundedInfuraLogs(infura, low, high, out)
      if (canonical(left) !== canonical(right)) throw Error('saturn_queue_origins_disagree')
      const body = {
        study: 'saturn_queue_event_window_v1',
        fromBlock: low,
        toBlock: high,
        origins: ['rpc.ankr.com', 'mainnet.infura.io'],
        logs: left,
        logsSha256: sha(canonical(left)),
      }
      row = validateWindow({ ...body, sha256: sha(canonical(body)) }, low, high)
      await writeExclusive(path, row)
      newWindows++
      console.error(`saturn_queue_window ${low}-${high} logs=${row.logs.length}`)
    }
    windows.push({ fromBlock: low, toBlock: high, logs: row.logs.length, sha256: row.sha256 })
    logs.push(...row.logs)
  }
  if (windows.length < windowBounds().length)
    return { partial: true, windows: windows.length, logs: logs.length }
  const counts = Object.fromEntries(Object.keys(EVENTS).map((kind) => [kind, 0]))
  for (const log of logs) counts[log.kind]++
  const body = {
    study: 'saturn_queue_event_cohort_v1',
    fromBlock: FROM,
    toBlock: TO,
    windows,
    logs,
    logsSha256: sha(canonical(logs)),
    counts,
  }
  const row = { ...body, sha256: sha(canonical(body)) }
  await writeExclusive(out, row)
  return row
}

export async function verifyQueueEvents(out = OUT) {
  const bytes = await readFile(out)
  if (bytes.length > 1_048_576) throw Error('saturn_queue_cohort_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  const { sha256: _seal, ...body } = row
  const bounds = windowBounds()
  if (
    bytes.toString('utf8') !== `${canonical(row)}\n` ||
    row.study !== 'saturn_queue_event_cohort_v1' ||
    row.fromBlock !== FROM ||
    row.toBlock !== TO ||
    !Array.isArray(row.windows) ||
    row.windows.length !== bounds.length ||
    !Array.isArray(row.logs) ||
    row.logsSha256 !== sha(canonical(row.logs)) ||
    row.sha256 !== sha(canonical(body))
  )
    throw Error('saturn_queue_cohort_invalid')
  const all = []
  for (const [index, [low, high]] of bounds.entries()) {
    const saved = await checkpoint(`${out}.windows/${low}-${high}.json`, low, high)
    if (
      row.windows[index].fromBlock !== low ||
      row.windows[index].toBlock !== high ||
      row.windows[index].logs !== saved?.logs.length ||
      row.windows[index].sha256 !== saved.sha256
    )
      throw Error('saturn_queue_window_changed')
    all.push(...saved.logs)
  }
  if (canonical(all) !== canonical(row.logs)) throw Error('saturn_queue_logs_changed')
  const counts = Object.fromEntries(Object.keys(EVENTS).map((kind) => [kind, 0]))
  for (const log of all) counts[log.kind]++
  if (canonical(counts) !== canonical(row.counts)) throw Error('saturn_queue_counts_invalid')
  return row
}

export async function verifyPartial(out = OUT) {
  let windows = 0
  let logs = 0
  let gap = false
  for (const [low, high] of windowBounds()) {
    const row = await checkpoint(`${out}.windows/${low}-${high}.json`, low, high)
    if (!row) gap = true
    else {
      if (gap) throw Error('saturn_queue_checkpoint_gap')
      windows++
      logs += row.logs.length
    }
  }
  return { windows, logs, totalWindows: windowBounds().length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify-partial')) console.log(JSON.stringify(await verifyPartial()))
  else if (process.argv.includes('--verify')) {
    const row = await verifyQueueEvents()
    console.log(JSON.stringify({ counts: row.counts, sha256: row.sha256 }))
  } else {
    const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
    const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 3
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4)
      throw Error('saturn_queue_limit_invalid')
    const row = await captureQueueEvents({ limit })
    console.log(JSON.stringify(row.partial ? row : { counts: row.counts, sha256: row.sha256 }))
  }
}
