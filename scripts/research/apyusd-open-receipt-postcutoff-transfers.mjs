// Bounded, two-origin ERC721 continuity after the frozen ApyUSD receipt cutoff.
// Transfer or burn evidence alone never establishes an apxUSD payout.
import { statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import {
  appendChain,
  canonical,
  pin,
  readChain,
  RECEIPT,
  sha,
} from './carry-public-apyusd-exit-common.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { requestWithRetries } from './apyusd-receipt-cohort-source.mjs'
import { normalizeTransfer, TO, verifyTransfers } from './apyusd-receipt-cohort-transfers.mjs'

export const OUT = resolve(
  'data/research/venue-signals/apyusd-open-receipt-postcutoff-transfers-v1',
)
export const FROM = TO + 1
const STUDY = 'apyusd_open_receipt_postcutoff_transfer_window_v1'
const SOURCE_SHA = '9d17e9eb90fabe22eb95270784e5d879908698aa93df9167251396f605426488'
const IDS = Object.freeze(['881', '891', '897', '906', '935', '941', '947'])
const HOSTS = Object.freeze(['rpc.ankr.com', 'mainnet.infura.io'])
const STEP = 1_000
const MAX_WINDOWS = 2
const DEFAULT_WINDOWS = 1
const MAX_EVENT_BLOCKS_PER_TICK = 5
const MAX_PROBES_PER_WINDOW = 3
const MAX_RPC_CALLS = 80
const MAX_WALL_MS = 150_000
const MIN_FREE_BYTES = 1_073_741_824
const MAX_HEAD_AGE_MS = 45 * 60_000
const FUTURE_SKEW_MS = 120_000
const TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const OWNER_ABI = parseAbi(['function ownerOf(uint256) view returns (address)'])
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`
const WORD = /^0x[0-9a-f]{64}$/
const FIELDS = [
  'study',
  'sequence',
  'previousSha256',
  'sourceSha256',
  'receipt',
  'ids',
  'origins',
  'anchorHash',
  'fromBlock',
  'toBlock',
  'fromHeader',
  'toHeader',
  'finalizedHead',
  'observedAtUtc',
  'transfers',
  'eventBlockHeaders',
  'ownersAtEnd',
  'terminalPayoutVerified',
  'sha256',
]
  .sort()
  .join(',')
const shaBody = (row) => {
  const { sha256: _seal, ...body } = row
  return sha(canonical(body))
}
const fail = (okay, code) => {
  if (!okay) throw Error(code)
}
const hex = (n) => `0x${n.toString(16)}`
const idWord = (id) => `0x${BigInt(id).toString(16).padStart(64, '0')}`

function assertSource(source) {
  fail(
    source?.sha256 === SOURCE_SHA &&
      source.toBlock === TO &&
      canonical(source.cohort?.openIds) === canonical(IDS),
    'apyusd_postcutoff_source_invalid',
  )
  return source
}

function header(raw, expectedNumber = null) {
  const number = Number(BigInt(raw?.number ?? '0x0'))
  const timestamp = Number(BigInt(raw?.timestamp ?? '0x0'))
  const result = {
    number,
    hash: raw?.hash?.toLowerCase(),
    parentHash: raw?.parentHash?.toLowerCase(),
    timestamp,
  }
  fail(
    Number.isSafeInteger(number) &&
      number > 0 &&
      (expectedNumber === null || number === expectedNumber) &&
      WORD.test(result.hash ?? '') &&
      WORD.test(result.parentHash ?? '') &&
      Number.isSafeInteger(timestamp) &&
      timestamp > 0,
    'apyusd_postcutoff_header_invalid',
  )
  return result
}

function normalizeEvents(logs, low, high) {
  fail(Array.isArray(logs), 'apyusd_postcutoff_logs_invalid')
  const events = logs.map((log) => normalizeTransfer(log, low, high))
  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    fail(
      event.data === '0x' &&
        IDS.includes(BigInt(event.topics[3]).toString()) &&
        (index === 0 ||
          event.blockNumber > events[index - 1].blockNumber ||
          (event.blockNumber === events[index - 1].blockNumber &&
            event.logIndex > events[index - 1].logIndex)),
      'apyusd_postcutoff_event_invalid',
    )
  }
  return events
}

const topicAddress = (topic) => `0x${topic.slice(-40)}`
const eventId = (event) => BigInt(event.topics[3]).toString()

export function initialOwners(source) {
  const owners = new Map(IDS.map((id) => [id, null]))
  fail(Array.isArray(source.transfers), 'apyusd_postcutoff_source_owners_invalid')
  for (const event of source.transfers) {
    const id = eventId(event)
    if (!owners.has(id)) continue
    const from = topicAddress(event.topics[1])
    const to = topicAddress(event.topics[2])
    fail(
      from === (owners.get(id) ?? ZERO_ADDRESS) && to !== ZERO_ADDRESS,
      'apyusd_postcutoff_source_owners_invalid',
    )
    owners.set(id, to)
  }
  fail(
    IDS.every((id) => owners.get(id)),
    'apyusd_postcutoff_source_owners_invalid',
  )
  return IDS.map((id) => owners.get(id))
}

function foldOwners(before, events) {
  const owners = new Map(IDS.map((id, index) => [id, before[index]]))
  for (const event of events) {
    const id = eventId(event)
    const from = topicAddress(event.topics[1])
    const to = topicAddress(event.topics[2])
    fail(
      owners.has(id) && owners.get(id) === from && from !== ZERO_ADDRESS,
      'apyusd_postcutoff_owner_flow_invalid',
    )
    owners.set(id, to === ZERO_ADDRESS ? null : to)
  }
  return IDS.map((id) => owners.get(id))
}

async function readOwners(origins, blockHash) {
  const states = await Promise.all(
    origins.map(async (origin) =>
      Promise.all(
        IDS.map(async (id) => {
          const response = await origin.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [
              {
                to: RECEIPT,
                data: encodeFunctionData({
                  abi: OWNER_ABI,
                  functionName: 'ownerOf',
                  args: [BigInt(id)],
                }),
              },
              pin(blockHash),
            ],
          })
          if (Object.hasOwn(response, 'error')) {
            fail(
              response.error?.message === 'execution reverted',
              'apyusd_postcutoff_owner_rpc_invalid',
            )
            return null
          }
          const owner = decodeFunctionResult({
            abi: OWNER_ABI,
            functionName: 'ownerOf',
            data: response.result,
          })
          fail(/^0x[0-9a-fA-F]{40}$/.test(owner), 'apyusd_postcutoff_owner_invalid')
          return owner.toLowerCase()
        }),
      ),
    ),
  )
  fail(canonical(states[0]) === canonical(states[1]), 'apyusd_postcutoff_owners_disagree')
  return states[0]
}

function validateRow(row, source, prior) {
  assertSource(source)
  const low = (prior?.toBlock ?? TO) + 1
  fail(
    row?.study === STUDY &&
      Object.keys(row).sort().join(',') === FIELDS &&
      row.sequence === (prior?.sequence ?? 0) + 1 &&
      row.previousSha256 === (prior?.sha256 ?? null) &&
      row.sourceSha256 === SOURCE_SHA &&
      row.receipt === RECEIPT &&
      canonical(row.ids) === canonical(IDS) &&
      canonical(row.origins) === canonical(HOSTS) &&
      WORD.test(row.anchorHash ?? '') &&
      (prior === null || row.anchorHash === prior.anchorHash) &&
      row.fromBlock === low &&
      Number.isSafeInteger(row.toBlock) &&
      row.toBlock >= low &&
      row.toBlock <= Math.min(low + STEP - 1, row.finalizedHead?.number) &&
      canonical(header(row.fromHeader, low)) === canonical(row.fromHeader) &&
      canonical(header(row.toHeader, row.toBlock)) === canonical(row.toHeader) &&
      canonical(header(row.finalizedHead)) === canonical(row.finalizedHead) &&
      row.finalizedHead?.number >= row.toBlock &&
      row.fromHeader.timestamp <= row.toHeader.timestamp &&
      row.toHeader.timestamp <= row.finalizedHead.timestamp &&
      row.fromHeader.parentHash === (prior?.toHeader.hash ?? row.anchorHash) &&
      (low !== row.toBlock || canonical(row.fromHeader) === canonical(row.toHeader)) &&
      (row.toBlock !== low + 1 || row.toHeader.parentHash === row.fromHeader.hash) &&
      row.terminalPayoutVerified === false &&
      Array.isArray(row.transfers) &&
      canonical(row.transfers) ===
        canonical(
          normalizeEvents(
            row.transfers.map((event) => ({
              ...event,
              address: RECEIPT,
              blockNumber: hex(event.blockNumber),
              logIndex: hex(event.logIndex),
            })),
            low,
            row.toBlock,
          ),
        ) &&
      Array.isArray(row.eventBlockHeaders) &&
      canonical(row.eventBlockHeaders.map((item) => item.number)) ===
        canonical([...new Set(row.transfers.map((event) => event.blockNumber))]) &&
      row.eventBlockHeaders.every(
        (item) =>
          canonical(header(item, item.number)) === canonical(item) &&
          item.timestamp >= row.fromHeader.timestamp &&
          item.timestamp <= row.toHeader.timestamp &&
          (item.number !== low || item.hash === row.fromHeader.hash) &&
          (item.number !== row.toBlock || item.hash === row.toHeader.hash),
      ) &&
      row.transfers.every(
        (event) =>
          row.eventBlockHeaders.find((item) => item.number === event.blockNumber)?.hash ===
          event.blockHash,
      ) &&
      Array.isArray(row.ownersAtEnd) &&
      row.ownersAtEnd.length === IDS.length &&
      row.ownersAtEnd.every((owner) => owner === null || /^0x[0-9a-f]{40}$/.test(owner)) &&
      canonical(row.ownersAtEnd) ===
        canonical(foldOwners(prior?.ownersAtEnd ?? initialOwners(source), row.transfers)) &&
      row.sha256 === shaBody(row),
    'apyusd_postcutoff_row_invalid',
  )
  const at = Date.parse(row.observedAtUtc ?? '')
  fail(
    Number.isSafeInteger(at) &&
      new Date(at).toISOString() === row.observedAtUtc &&
      at - row.finalizedHead.timestamp * 1_000 >= -FUTURE_SKEW_MS &&
      at - row.finalizedHead.timestamp * 1_000 <= MAX_HEAD_AGE_MS &&
      (!prior || at >= Date.parse(prior.observedAtUtc)),
    'apyusd_postcutoff_time_invalid',
  )
  return row
}

export function validatePostcutoffRows(rows, source) {
  assertSource(source)
  fail(Array.isArray(rows), 'apyusd_postcutoff_rows_invalid')
  for (let index = 0; index < rows.length; index++)
    validateRow(rows[index], source, rows[index - 1] ?? null)
  return rows
}

export function buildPostcutoffRow(window, prior, source) {
  assertSource(source)
  const body = {
    study: STUDY,
    sequence: (prior?.sequence ?? 0) + 1,
    previousSha256: prior?.sha256 ?? null,
    sourceSha256: SOURCE_SHA,
    receipt: RECEIPT,
    ids: IDS,
    origins: HOSTS,
    anchorHash: window.anchorHash,
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    fromHeader: window.fromHeader,
    toHeader: window.toHeader,
    finalizedHead: window.finalizedHead,
    observedAtUtc: window.observedAtUtc,
    transfers: window.transfers,
    eventBlockHeaders: window.eventBlockHeaders,
    ownersAtEnd: window.ownersAtEnd,
    terminalPayoutVerified: false,
  }
  const row = { ...body, sha256: sha(canonical(body)) }
  return validateRow(row, source, prior)
}

async function sameHeader(origins, tag, number = null) {
  const heads = await Promise.all(
    origins.map(async (origin) =>
      header(await requestWithRetries(origin, 'eth_getBlockByNumber', [tag, false]), number),
    ),
  )
  fail(canonical(heads[0]) === canonical(heads[1]), 'apyusd_postcutoff_headers_disagree')
  return heads[0]
}

export async function fetchPostcutoffWindow(
  origins,
  low,
  high,
  remainingEventBlocks = MAX_EVENT_BLOCKS_PER_TICK,
) {
  fail(origins.length === 2 && high >= low, 'apyusd_postcutoff_window_invalid')
  const query = {
    address: RECEIPT,
    topics: [TOPIC, null, null, IDS.map(idWord)],
    fromBlock: hex(low),
    toBlock: hex(high),
  }
  const [fromHeader, toHeader, a, b] = await Promise.all([
    sameHeader(origins, hex(low), low),
    sameHeader(origins, hex(high), high),
    requestWithRetries(origins[0], 'eth_getLogs', [query]),
    requestWithRetries(origins[1], 'eth_getLogs', [query]),
  ])
  const left = normalizeEvents(a, low, high)
  const right = normalizeEvents(b, low, high)
  fail(canonical(left) === canonical(right), 'apyusd_postcutoff_logs_disagree')
  const eventNumbers = [...new Set(left.map((event) => event.blockNumber))]
  fail(eventNumbers.length <= remainingEventBlocks, 'apyusd_postcutoff_event_budget')
  const eventBlockHeaders = await Promise.all(
    eventNumbers.map((number) => sameHeader(origins, hex(number), number)),
  )
  const ownersAtEnd = await readOwners(origins, toHeader.hash)
  return { fromHeader, toHeader, transfers: left, eventBlockHeaders, ownersAtEnd }
}

export async function verifyPostcutoff(out = OUT, sourceLoader = verifyTransfers) {
  const source = assertSource(await sourceLoader())
  return validatePostcutoffRows(await readChain(out), source)
}

function boundedOrigins(origins, clock) {
  const deadline = clock() + MAX_WALL_MS
  let calls = 0
  const check = () =>
    fail(calls < MAX_RPC_CALLS && clock() < deadline, 'apyusd_postcutoff_rpc_budget')
  const take = () => {
    check()
    calls++
  }
  return {
    origins: origins.map((origin) => ({
      ...origin,
      async request(...args) {
        take()
        return origin.request(...args)
      },
      async send(...args) {
        take()
        return origin.send(...args)
      },
    })),
    check: () => fail(clock() < deadline, 'apyusd_postcutoff_rpc_budget'),
  }
}

export async function capturePostcutoff({
  out = OUT,
  sourceLoader = verifyTransfers,
  clientsForUrls = publicRpcClients,
  urls = null,
  writer = appendChain,
  now = Date.now,
  rpcClock = Date.now,
  maxWindows = DEFAULT_WINDOWS,
  freeBytes = () => {
    const disk = statfsSync(dirname(out))
    return Number(disk.bavail) * Number(disk.bsize)
  },
} = {}) {
  fail(freeBytes() >= MIN_FREE_BYTES + 262_144, 'apyusd_postcutoff_disk_reserve')
  fail(
    Number.isSafeInteger(maxWindows) && maxWindows >= 1 && maxWindows <= MAX_WINDOWS,
    'apyusd_postcutoff_budget_invalid',
  )
  const source = assertSource(await sourceLoader())
  const rows = validatePostcutoffRows(await readChain(out), source)
  const clients = clientsForUrls(urls ?? configuredPublicRpcUrls(readEnv()))
  const selected = HOSTS.map((host) => clients.find((item) => new URL(item.url).hostname === host))
  fail(
    selected.every(Boolean) && selected[0].provider !== selected[1].provider,
    'apyusd_postcutoff_origins_invalid',
  )
  const { origins, check: checkBudget } = boundedOrigins(selected, rpcClock)
  const ids = await Promise.all(
    origins.map((origin) => requestWithRetries(origin, 'eth_chainId', [])),
  )
  fail(
    ids.every((id) => id === '0x1'),
    'apyusd_postcutoff_chain_invalid',
  )
  const reported = await Promise.all(
    origins.map(async (origin) =>
      header(await requestWithRetries(origin, 'eth_getBlockByNumber', ['finalized', false])),
    ),
  )
  const finalizedHead = await sameHeader(
    origins,
    hex(Math.min(...reported.map((head) => head.number))),
  )
  let prior = rows.at(-1) ?? null
  const boundary = await sameHeader(origins, hex(prior?.toBlock ?? TO), prior?.toBlock ?? TO)
  if (prior) fail(boundary.hash === prior.toHeader.hash, 'apyusd_postcutoff_previous_reorg')
  const anchorHash = prior?.anchorHash ?? boundary.hash
  let captured = 0
  let transferCount = rows.reduce((sum, row) => sum + row.transfers.length, 0)
  let eventBlockCount = 0
  for (let index = 0; index < maxWindows; index++) {
    const low = (prior?.toBlock ?? TO) + 1
    if (low > finalizedHead.number || eventBlockCount >= MAX_EVENT_BLOCKS_PER_TICK) break
    let high = Math.min(low + STEP - 1, finalizedHead.number)
    let window
    let reducedWindow = false
    for (let probe = 1; probe <= MAX_PROBES_PER_WINDOW; probe++) {
      try {
        window = await fetchPostcutoffWindow(
          origins,
          low,
          high,
          MAX_EVENT_BLOCKS_PER_TICK - eventBlockCount,
        )
        break
      } catch (error) {
        if (
          error.message !== 'apyusd_postcutoff_event_budget' ||
          high === low ||
          probe === MAX_PROBES_PER_WINDOW
        )
          throw error
        high = low + Math.floor((high - low) / 2)
        reducedWindow = true
      }
    }
    checkBudget()
    const row = buildPostcutoffRow(
      {
        ...window,
        anchorHash,
        fromBlock: low,
        toBlock: high,
        finalizedHead,
        observedAtUtc: new Date(now()).toISOString(),
      },
      prior,
      source,
    )
    checkBudget()
    await writer(row, out, (path) => verifyPostcutoff(path, sourceLoader))
    prior = row
    captured++
    transferCount += row.transfers.length
    eventBlockCount += window.eventBlockHeaders.length
    if (reducedWindow) break
  }
  return {
    status: captured ? 'captured' : 'up_to_date',
    windows: captured,
    coveredThrough: prior?.toBlock ?? TO,
    finalizedHead: finalizedHead.number,
    transfers: transferCount,
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2]
  try {
    fail(
      process.argv.length === 3 && ['--tick', '--verify'].includes(mode),
      'apyusd_postcutoff_usage',
    )
    const result = mode === '--tick' ? await capturePostcutoff() : null
    const rows = await verifyPostcutoff()
    process.stdout.write(
      `${JSON.stringify({ status: result?.status ?? 'verified', windows: rows.length, coveredThrough: rows.at(-1)?.toBlock ?? TO, transfers: rows.reduce((sum, row) => sum + row.transfers.length, 0), terminalPayoutVerified: false })}\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${/^apyusd_[a-z0-9_]+$/.test(error?.message) ? error.message : 'apyusd_postcutoff_failed'}\n`,
    )
    process.exitCode = 1
  }
}
