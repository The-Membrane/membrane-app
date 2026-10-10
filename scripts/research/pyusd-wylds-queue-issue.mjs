// Prospective, mined wYLDS redemption requests only. Admin completion and PYUSD payout are separate.
import { createHash, randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeEventLog, parseAbiItem, toEventSelector } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import {
  compareOrigins,
  header,
  makeRpc,
  requireResult,
  selectOrigins,
  verifyHeaderChain,
} from './carry-direct-vault-flow-preflight.mjs'
import { PRIME, ROUTE, USDC, WYLDS } from './pyusd-staking-economic-exit.mjs'

export const STUDY = 'pyusd_wylds_queue_issue_v1'
export const SCOPE = 'wylds_to_usdc_admin_queue'
const DISCOVERY = 'two_origin_contiguous_up_to_five_block_request_log_agreement'
const LEGACY_DISCOVERY = 'two_origin_contiguous_five_block_request_log_agreement'
export const ROOT = resolve('data/research/venue-signals/pyusd-wylds-queue-issue-v1')
export const WINDOW_BLOCKS = 5
export const MAX_WINDOWS_PER_RUN = 24
export const MAX_RUN_MS = 60_000
export const MAX_RPC_CALLS_PER_RUN = 480
// A dense five-block discovery is split at a block boundary; a single block over this cap fails closed.
export const MAX_REQUESTS_PER_WINDOW = 12
const MAX_DISCOVERY_LOGS = 256
const MAX_ROW_BYTES = 240_000
const DISK_RESERVE = 1_073_741_824
const CANONICAL_PROBE_ADDRESS = '0x0000000000000000000000000000000000000000'
const REQUEST = parseAbiItem(
  'event RedemptionRequested(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
)
const TOPIC = toEventSelector(REQUEST)
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const QUANTITY = /^0x[0-9a-fA-F]+$/
const WORD_ADDRESS = /^0x0{24}[0-9a-fA-F]{40}$/
const DATA = /^0x[0-9a-fA-F]{192}$/
const SHA = /^[0-9a-f]{64}$/
const HEADER_KEYS = ['hash', 'number', 'parentHash', 'timestamp']
const hex = (n) => `0x${n.toString(16)}`
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const eventKey = (event) => `${event.transactionHash}:${event.logIndex}`
const checkedHeader = (raw) => header({ response: { result: raw } })

function projectedHeader(raw) {
  const value = checkedHeader(raw)
  return {
    number: hex(value.number),
    hash: value.hash,
    parentHash: value.parentHash,
    timestamp: hex(value.timestamp),
  }
}

function safeQuantity(value) {
  if (!QUANTITY.test(value ?? '')) throw Error('wylds_queue_quantity_invalid')
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number)) throw Error('wylds_queue_quantity_invalid')
  return number
}

function normalizeRequest(log, headers, from) {
  if (
    log?.address?.toLowerCase() !== WYLDS ||
    !HASH.test(log?.blockHash ?? '') ||
    !HASH.test(log?.transactionHash ?? '') ||
    !QUANTITY.test(log?.blockNumber ?? '') ||
    !QUANTITY.test(log?.transactionIndex ?? '') ||
    !QUANTITY.test(log?.logIndex ?? '') ||
    !Array.isArray(log?.topics) ||
    log.topics.length !== 2 ||
    log.topics[0]?.toLowerCase() !== TOPIC ||
    !WORD_ADDRESS.test(log.topics[1] ?? '') ||
    !DATA.test(log?.data ?? '') ||
    log.removed === true
  )
    throw Error('wylds_queue_request_log_invalid')
  const blockNumber = safeQuantity(log.blockNumber)
  const transactionIndex = safeQuantity(log.transactionIndex)
  const logIndex = safeQuantity(log.logIndex)
  const block = headers[blockNumber - from]
  if (!block || block.hash !== log.blockHash.toLowerCase())
    throw Error('wylds_queue_request_header_mismatch')
  let decoded
  try {
    decoded = decodeEventLog({ abi: [REQUEST], topics: log.topics, data: log.data, strict: true })
  } catch {
    throw Error('wylds_queue_request_decode_invalid')
  }
  const timestamp = Number(decoded.args.timestamp)
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp !== block.timestamp ||
    decoded.args.shares <= 0n ||
    decoded.args.assets <= 0n
  )
    throw Error('wylds_queue_request_values_invalid')
  return {
    blockNumber,
    blockHash: block.hash,
    transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex,
    logIndex,
    user: decoded.args.user.toLowerCase(),
    sharesRaw: decoded.args.shares.toString(),
    usdcAssetsRaw: decoded.args.assets.toString(),
    requestTimestamp: timestamp,
    topics: log.topics.map((topic) => topic.toLowerCase()),
    data: log.data.toLowerCase(),
  }
}

function normalizeDiscovery(raw, headers, from, limit = MAX_REQUESTS_PER_WINDOW) {
  if (!Array.isArray(raw) || raw.length > limit)
    throw Error('wylds_queue_window_overflow_hard_blocker')
  const rows = raw.map((log) => normalizeRequest(log, headers, from))
  rows.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex,
  )
  if (new Set(rows.map(eventKey)).size !== rows.length)
    throw Error('wylds_queue_duplicate_request_log')
  if (new Set(rows.map((event) => `${event.blockNumber}:${event.logIndex}`)).size !== rows.length)
    throw Error('wylds_queue_duplicate_block_log_index')
  return rows
}

function boundedWindowTo(discovered, from, to) {
  let count = 0
  for (let block = from; block <= to; block++) {
    count += discovered.filter((event) => event.blockNumber === block).length
    if (count > MAX_REQUESTS_PER_WINDOW) {
      if (block === from) throw Error('wylds_queue_single_block_overflow_hard_blocker')
      return block - 1
    }
  }
  return to
}

function materialReceipt(receipt, event) {
  if (
    receipt?.transactionHash?.toLowerCase() !== event.transactionHash ||
    receipt?.blockHash?.toLowerCase() !== event.blockHash ||
    safeQuantity(receipt?.blockNumber) !== event.blockNumber ||
    safeQuantity(receipt?.transactionIndex) !== event.transactionIndex ||
    receipt?.status !== '0x1' ||
    !Array.isArray(receipt?.logs) ||
    receipt.logs.length > 512
  )
    throw Error('wylds_queue_receipt_invalid')
  const logs = receipt.logs.map((log) => {
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(log?.address ?? '') ||
      log?.transactionHash?.toLowerCase() !== event.transactionHash ||
      log?.blockHash?.toLowerCase() !== event.blockHash ||
      safeQuantity(log?.blockNumber) !== event.blockNumber ||
      safeQuantity(log?.transactionIndex) !== event.transactionIndex ||
      !QUANTITY.test(log?.logIndex ?? '') ||
      !Array.isArray(log?.topics) ||
      log.topics.some((topic) => !HASH.test(topic)) ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(log?.data ?? '') ||
      log.removed === true
    )
      throw Error('wylds_queue_receipt_log_invalid')
    return {
      address: log.address.toLowerCase(),
      blockNumber: safeQuantity(log.blockNumber),
      transactionIndex: safeQuantity(log.transactionIndex),
      logIndex: safeQuantity(log.logIndex),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
    }
  })
  if (new Set(logs.map((log) => log.logIndex)).size !== logs.length)
    throw Error('wylds_queue_duplicate_receipt_log_index')
  if (
    logs.filter(
      (log) =>
        log.address === WYLDS &&
        log.logIndex === event.logIndex &&
        same(log.topics, event.topics) &&
        log.data === event.data,
    ).length !== 1
  )
    throw Error('wylds_queue_request_missing_from_receipt')
  return {
    transactionHash: event.transactionHash,
    blockHash: event.blockHash,
    blockNumber: event.blockNumber,
    transactionIndex: event.transactionIndex,
    status: '0x1',
    logs,
  }
}

function replaySources(sources, scan, requests) {
  if (
    !Array.isArray(sources) ||
    sources.length !== 2 ||
    sources.some((source) => !/^[a-z0-9.-]+$/.test(source?.origin ?? '')) ||
    sources.some(
      (source) =>
        !same(Object.keys(source).sort(), [
          'canonicalRead',
          'chainId',
          'finalizedHead',
          'headers',
          'origin',
          'requestLogs',
        ]),
    ) ||
    sources.some((source) => source.chainId !== '0x1') ||
    sources[0].origin === sources[1].origin
  )
    throw Error('wylds_queue_origins_invalid')
  const canonicalBalances = []
  const chains = sources.map((source) => {
    const head = checkedHeader(source.finalizedHead)
    if (head.number < scan.to) throw Error('wylds_queue_unfinalized')
    if (head.number === scan.to) {
      if (head.hash !== scan.toHash || source.canonicalRead !== null)
        throw Error('wylds_queue_finalized_hash_mismatch')
    } else {
      const proof = source.canonicalRead
      if (
        proof?.request?.jsonrpc !== '2.0' ||
        !Number.isSafeInteger(proof.request.id) ||
        proof.request.id < 1 ||
        proof.request.method !== 'eth_getBalance' ||
        !same(proof.request.params, [
          CANONICAL_PROBE_ADDRESS,
          { blockHash: scan.toHash, requireCanonical: true },
        ]) ||
        proof.response?.jsonrpc !== '2.0' ||
        proof.response.id !== proof.request.id ||
        proof.response.error !== undefined ||
        !QUANTITY.test(proof.response.result ?? '')
      )
        throw Error('wylds_queue_canonicality_unproved')
      canonicalBalances.push(BigInt(proof.response.result).toString())
    }
    if (!Array.isArray(source.headers)) throw Error('wylds_queue_headers_invalid')
    const headers = source.headers.map(checkedHeader)
    verifyHeaderChain(headers, scan.from, scan.to)
    return headers
  })
  compareOrigins(chains[0], chains[1])
  if (canonicalBalances.length === 2) compareOrigins(canonicalBalances[0], canonicalBalances[1])
  if (chains[0][0].parentHash !== scan.fromParentHash || chains[0].at(-1).hash !== scan.toHash)
    throw Error('wylds_queue_pin_mismatch')
  const discovered = sources.map((source) =>
    normalizeDiscovery(source.requestLogs, chains[0], scan.from),
  )
  compareOrigins(discovered[0], discovered[1])
  if (
    !Array.isArray(requests) ||
    !same(
      requests.map((request) => request.event),
      discovered[0],
    )
  )
    throw Error('wylds_queue_request_not_discovered')
  for (const request of requests) {
    if (!Array.isArray(request.rawReceipts) || request.rawReceipts.length !== 2)
      throw Error('wylds_queue_receipt_invalid')
    const receipts = request.rawReceipts.map((receipt) => materialReceipt(receipt, request.event))
    if (!same(receipts[0], receipts[1])) throw Error('wylds_queue_receipt_disagreement')
  }
  return discovered[0]
}

function validateIssue(row, sequence, previous) {
  const { sha256, ...body } = row ?? {}
  const expectedKeys = [
    'study',
    'scope',
    'routeKey',
    'destination',
    'wylds',
    'usdc',
    'chainId',
    'discovery',
    'requestStatus',
    'queueOutstanding',
    'usdcPayout',
    'finalPyusdPayout',
    'issuedAtUtc',
    'bootstrap',
    'scan',
    'requests',
    'sources',
    'sequence',
    'previousSha256',
    'sha256',
  ]
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !same(Object.keys(row).sort(), expectedKeys.sort()) ||
    row?.sequence !== sequence ||
    row.previousSha256 !== (previous?.sha256 ?? null) ||
    row.study !== STUDY ||
    row.scope !== SCOPE ||
    row.routeKey !== ROUTE ||
    row.destination !== PRIME ||
    row.wylds !== WYLDS ||
    row.usdc !== USDC ||
    row.chainId !== 1 ||
    (row.discovery !== DISCOVERY && row.discovery !== LEGACY_DISCOVERY) ||
    row.requestStatus !== 'mined_requests_attested_completion_unassessed' ||
    row.queueOutstanding !== 'not_assessed' ||
    row.usdcPayout !== 'not_attested' ||
    row.finalPyusdPayout !== 'not_attested' ||
    !Number.isSafeInteger(row.scan?.from) ||
    row.scan.from < 0 ||
    !Number.isSafeInteger(row.scan?.to) ||
    !same(Object.keys(row.scan).sort(), ['from', 'fromParentHash', 'to', 'toHash']) ||
    row.scan.to < row.scan.from ||
    row.scan.to - row.scan.from >= WINDOW_BLOCKS ||
    (row.discovery === LEGACY_DISCOVERY && row.scan.to - row.scan.from !== WINDOW_BLOCKS - 1) ||
    (row.discovery === DISCOVERY &&
      row.sources?.some(
        (source) =>
          !same(Object.keys(source?.finalizedHead ?? {}).sort(), HEADER_KEYS) ||
          !Array.isArray(source?.headers) ||
          source.headers.some((raw) => !same(Object.keys(raw ?? {}).sort(), HEADER_KEYS)),
      )) ||
    !HASH.test(row.scan?.fromParentHash ?? '') ||
    !HASH.test(row.scan?.toHash ?? '') ||
    !Array.isArray(row.requests) ||
    row.requests.length > MAX_REQUESTS_PER_WINDOW ||
    row.requests.some(
      (request) =>
        !same(Object.keys(request).sort(), ['event', 'rawReceipts']) ||
        !ADDRESS.test(request.event?.user ?? ''),
    ) ||
    !same(Object.keys(row.bootstrap ?? {}).sort(), [
      'preStartHistory',
      'startBlock',
      'startHash',
    ]) ||
    row.bootstrap.preStartHistory !== 'unobserved' ||
    !Number.isSafeInteger(row.bootstrap.startBlock) ||
    !HASH.test(row.bootstrap.startHash ?? '') ||
    !SHA.test(sha256 ?? '') ||
    sha256 !== sha(JSON.stringify(body))
  )
    throw Error('wylds_queue_issue_invalid')
  const issuedMs = Date.parse(row.issuedAtUtc)
  if (!Number.isFinite(issuedMs) || new Date(issuedMs).toISOString() !== row.issuedAtUtc)
    throw Error('wylds_queue_issue_clock_invalid')
  if (previous) {
    if (
      row.scan.from !== previous.scan.to + 1 ||
      row.scan.fromParentHash !== previous.scan.toHash ||
      !same(row.bootstrap, previous.bootstrap) ||
      issuedMs < Date.parse(previous.issuedAtUtc)
    )
      throw Error('wylds_queue_cursor_gap')
  } else if (
    row.bootstrap.startBlock !== row.scan.from ||
    row.bootstrap.startHash !== row.sources?.[0]?.headers?.[0]?.hash?.toLowerCase()
  )
    throw Error('wylds_queue_bootstrap_invalid')
  const events = replaySources(row.sources, row.scan, row.requests)
  if (
    events.some((event) => event.requestTimestamp * 1000 > issuedMs + 120_000) ||
    (sequence === 1 &&
      issuedMs - checkedHeader(row.sources[0].headers.at(-1)).timestamp * 1000 > 7_200_000)
  )
    throw Error('wylds_queue_issue_clock_invalid')
  return row
}

function deadlineGuard(signal) {
  if (signal?.aborted) throw Error('wylds_queue_run_deadline')
}

async function withinDeadline(promise, signal) {
  deadlineGuard(signal)
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Error('wylds_queue_run_deadline'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(Error('wylds_queue_run_deadline'))
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(Error('wylds_queue_run_deadline'))
        else reject(error)
      },
    )
  })
}

async function readLedger(root, { retainRows = false, signal } = {}) {
  deadlineGuard(signal)
  let names
  try {
    if (!(await lstat(root)).isDirectory()) throw Error('wylds_queue_root_invalid')
    names = await readdir(root)
  } catch (error) {
    if (error.code === 'ENOENT') return { rows: [], tip: null, keys: new Set(), count: 0 }
    throw error
  }
  if (names.some((name) => !/^\d{8}\.json$/.test(name))) throw Error('wylds_queue_stray_file')
  const rows = retainRows ? [] : null
  const keys = new Set()
  let tip = null
  let count = 0
  for (const name of names.sort()) {
    deadlineGuard(signal)
    if (name !== `${String(count + 1).padStart(8, '0')}.json`) throw Error('wylds_queue_gap')
    const fd = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const st = await fd.stat()
      if (!st.isFile() || st.size < 1 || st.size > MAX_ROW_BYTES)
        throw Error('wylds_queue_file_size')
      bytes = await fd.readFile()
      if ((await fd.stat()).size !== st.size) throw Error('wylds_queue_file_changed')
    } finally {
      await fd.close()
    }
    const row = JSON.parse(bytes.toString('utf8'))
    if (bytes.toString('utf8') !== `${JSON.stringify(row)}\n`)
      throw Error('wylds_queue_issue_invalid')
    deadlineGuard(signal)
    validateIssue(row, count + 1, tip)
    for (const request of row.requests) {
      const key = eventKey(request.event)
      if (keys.has(key)) throw Error('wylds_queue_duplicate_issue')
      keys.add(key)
    }
    if (rows) rows.push(row)
    tip = row
    count++
  }
  deadlineGuard(signal)
  return { rows, tip, keys, count }
}

export async function readIssues(root = ROOT) {
  return (await readLedger(root, { retainRows: true })).rows
}

function diskGuard(root, minimumFreeBytes) {
  const disk = statfsSync(root)
  if (Number(disk.bavail) * Number(disk.bsize) < minimumFreeBytes)
    throw Error('wylds_queue_disk_reserve')
}

async function appendVerifiedIssue(snapshot, root, minimumFreeBytes, ledger, signal) {
  deadlineGuard(signal)
  await mkdir(root, { recursive: true })
  if (!(await lstat(root)).isDirectory()) throw Error('wylds_queue_root_invalid')
  if (snapshot.requests.some((request) => ledger.keys.has(eventKey(request.event))))
    throw Error('wylds_queue_duplicate_issue')
  const body = {
    ...snapshot,
    sequence: ledger.count + 1,
    previousSha256: ledger.tip?.sha256 ?? null,
  }
  const row = { ...body, sha256: sha(JSON.stringify(body)) }
  validateIssue(row, row.sequence, ledger.tip)
  const data = `${JSON.stringify(row)}\n`
  if (Buffer.byteLength(data) > MAX_ROW_BYTES) throw Error('wylds_queue_file_size')
  deadlineGuard(signal)
  diskGuard(root, minimumFreeBytes + Buffer.byteLength(data))
  // An interrupted write must not strand a temp file in the enumerated ledger.
  const temp = join(dirname(root), `.wylds-queue-${randomUUID()}.tmp`)
  try {
    const fd = await open(temp, 'wx', 0o600)
    try {
      await fd.writeFile(data)
      await fd.sync()
    } finally {
      await fd.close()
    }
    deadlineGuard(signal)
    await link(temp, join(root, `${String(row.sequence).padStart(8, '0')}.json`))
    const dir = await open(root, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
  ledger.tip = row
  ledger.count++
  for (const request of row.requests) ledger.keys.add(eventKey(request.event))
  return row
}

export async function appendIssue(snapshot, root = ROOT, minimumFreeBytes = DISK_RESERVE) {
  const ledger = await readLedger(root)
  return appendVerifiedIssue(snapshot, root, minimumFreeBytes, ledger)
}

/** The first call anchors near finalized head; later calls advance exactly one contiguous window. */
export async function collectQueueWindow({
  urls,
  fetchImpl = fetch,
  nowMs = Date.now,
  previous = null,
  signal,
  rpcBudget,
} = {}) {
  deadlineGuard(signal)
  const origins = selectOrigins(urls ?? configuredPublicRpcUrls(readEnv()))
  const timedFetch = signal
    ? (url, options) =>
        fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, signal]) })
    : fetchImpl
  const { rpc } = makeRpc(timedFetch, nowMs)
  const callRpc = async (origin, method, params) => {
    deadlineGuard(signal)
    if (rpcBudget && ++rpcBudget.calls > rpcBudget.limit)
      throw Error('wylds_queue_run_rpc_budget_exhausted')
    return withinDeadline(rpc(origin, method, params), signal)
  }
  const get = async (origin, method, params) => {
    return requireResult(await callRpc(origin, method, params))
  }
  const sources = origins.map((origin) => ({ origin: origin.host }))
  for (let i = 0; i < 2; i++) {
    const chainId = await get(origins[i], 'eth_chainId', [])
    if (!QUANTITY.test(chainId ?? '') || BigInt(chainId) !== 1n)
      throw Error('wylds_queue_chain_invalid')
    sources[i].chainId = '0x1'
    sources[i].finalizedHead = projectedHeader(
      await get(origins[i], 'eth_getBlockByNumber', ['finalized', false]),
    )
  }
  const finalizedTo = Math.min(
    ...sources.map((source) => checkedHeader(source.finalizedHead).number),
  )
  if (finalizedTo < WINDOW_BLOCKS - 1) throw Error('wylds_queue_finalized_unavailable')
  const from = previous ? previous.scan.to + 1 : finalizedTo - WINDOW_BLOCKS + 1
  const candidateTo = from + WINDOW_BLOCKS - 1
  if (candidateTo > finalizedTo) return null
  for (let i = 0; i < 2; i++) {
    sources[i].headers = []
    for (let number = from; number <= candidateTo; number++)
      sources[i].headers.push(
        projectedHeader(await get(origins[i], 'eth_getBlockByNumber', [hex(number), false])),
      )
  }
  const headers = sources.map((source) =>
    verifyHeaderChain(source.headers.map(checkedHeader), from, candidateTo),
  )
  compareOrigins(headers[0], headers[1])
  if (previous && headers[0][0].parentHash !== previous.scan.toHash)
    throw Error('wylds_queue_parent_mismatch')
  for (let i = 0; i < 2; i++)
    sources[i].requestLogs = await get(origins[i], 'eth_getLogs', [
      { address: WYLDS, fromBlock: hex(from), toBlock: hex(candidateTo), topics: [TOPIC] },
    ])
  const fullDiscoveries = sources.map((source) =>
    normalizeDiscovery(source.requestLogs, headers[0], from, MAX_DISCOVERY_LOGS),
  )
  compareOrigins(fullDiscoveries[0], fullDiscoveries[1])
  const to = boundedWindowTo(fullDiscoveries[0], from, candidateTo)
  if (to < candidateTo) {
    for (let i = 0; i < 2; i++) {
      sources[i].headers = sources[i].headers.slice(0, to - from + 1)
      sources[i].requestLogs = await get(origins[i], 'eth_getLogs', [
        { address: WYLDS, fromBlock: hex(from), toBlock: hex(to), topics: [TOPIC] },
      ])
    }
  }
  const scan = {
    from,
    to,
    fromParentHash: headers[0][0].parentHash,
    toHash: headers[0][to - from].hash,
  }
  const bootstrap = previous?.bootstrap ?? {
    startBlock: from,
    startHash: headers[0][0].hash,
    preStartHistory: 'unobserved',
  }
  for (let i = 0; i < 2; i++) {
    if (checkedHeader(sources[i].finalizedHead).number === to) {
      sources[i].canonicalRead = null
      continue
    }
    try {
      const proof = await callRpc(origins[i], 'eth_getBalance', [
        CANONICAL_PROBE_ADDRESS,
        { blockHash: scan.toHash, requireCanonical: true },
      ])
      requireResult(proof)
      sources[i].canonicalRead = { request: proof.request, response: proof.response }
    } catch {
      deadlineGuard(signal)
      if (rpcBudget && rpcBudget.calls > rpcBudget.limit)
        throw Error('wylds_queue_run_rpc_budget_exhausted')
      throw Error('wylds_queue_canonicality_unproved')
    }
  }
  const discoveries = sources.map((source) =>
    normalizeDiscovery(source.requestLogs, headers[0], from),
  )
  compareOrigins(discoveries[0], discoveries[1])
  if (
    !same(
      discoveries[0],
      fullDiscoveries[0].filter((event) => event.blockNumber <= to),
    )
  )
    throw Error('wylds_queue_subwindow_disagreement')
  deadlineGuard(signal)
  const issuedAtUtc = new Date(nowMs()).toISOString()
  const requests = []
  for (const event of discoveries[0]) {
    const rawReceipts = []
    for (let i = 0; i < 2; i++)
      rawReceipts.push(await get(origins[i], 'eth_getTransactionReceipt', [event.transactionHash]))
    requests.push({ event, rawReceipts })
  }
  const snapshot = {
    study: STUDY,
    scope: SCOPE,
    routeKey: ROUTE,
    destination: PRIME,
    wylds: WYLDS,
    usdc: USDC,
    chainId: 1,
    discovery: DISCOVERY,
    requestStatus: 'mined_requests_attested_completion_unassessed',
    queueOutstanding: 'not_assessed',
    usdcPayout: 'not_attested',
    finalPyusdPayout: 'not_attested',
    issuedAtUtc,
    bootstrap,
    scan,
    requests,
    sources,
  }
  replaySources(sources, scan, requests)
  return snapshot
}

export async function issueQueueRequests({
  root = ROOT,
  minimumFreeBytes = DISK_RESERVE,
  maxWindows = MAX_WINDOWS_PER_RUN,
  runTimeoutMs = MAX_RUN_MS,
  maxRunRpcCalls = MAX_RPC_CALLS_PER_RUN,
  ...collectOptions
} = {}) {
  if (!Number.isSafeInteger(maxWindows) || maxWindows < 1 || maxWindows > MAX_WINDOWS_PER_RUN)
    throw Error('wylds_queue_window_limit_invalid')
  if (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs < 1 || runTimeoutMs > MAX_RUN_MS)
    throw Error('wylds_queue_run_limit_invalid')
  if (
    !Number.isSafeInteger(maxRunRpcCalls) ||
    maxRunRpcCalls < 1 ||
    maxRunRpcCalls > MAX_RPC_CALLS_PER_RUN
  )
    throw Error('wylds_queue_run_rpc_limit_invalid')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), runTimeoutMs)
  try {
    await mkdir(root, { recursive: true })
    if (!(await lstat(root)).isDirectory()) throw Error('wylds_queue_root_invalid')
    deadlineGuard(controller.signal)
    diskGuard(root, minimumFreeBytes)
    // Replay the entire archive once before advancing; keep only the tip and event keys.
    const ledger = await readLedger(root, { signal: controller.signal })
    const rpcBudget = { calls: 0, limit: maxRunRpcCalls }
    const rows = []
    for (let i = 0; i < maxWindows; i++) {
      deadlineGuard(controller.signal)
      const snapshot = await collectQueueWindow({
        ...collectOptions,
        previous: ledger.tip,
        signal: controller.signal,
        rpcBudget,
      })
      if (!snapshot) break
      const row = await appendVerifiedIssue(
        snapshot,
        root,
        minimumFreeBytes,
        ledger,
        controller.signal,
      )
      rows.push(row)
    }
    return {
      study: STUDY,
      scope: SCOPE,
      windows: rows.length,
      issued: rows.reduce((count, row) => count + row.requests.length, 0),
      rows,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  if (process.argv.length !== 3 || !['--issue', '--verify'].includes(process.argv[2]))
    throw Error('usage: node pyusd-wylds-queue-issue.mjs --issue|--verify')
  if (process.argv[2] === '--verify') {
    const rows = await readIssues()
    console.log(
      JSON.stringify({
        study: STUDY,
        scope: SCOPE,
        windows: rows.length,
        issues: rows.reduce((count, row) => count + row.requests.length, 0),
        tipSha256: rows.at(-1)?.sha256 ?? null,
        preStartHistory: rows[0]?.bootstrap.preStartHistory ?? 'unobserved',
        coverage: 'bounded_contiguous_from_bootstrap_only',
        windowOverflowPolicy: 'adaptive_block_boundary_up_to_12_single_block_hard_blocker',
        payout: 'not_attested',
      }),
    )
    return
  }
  const result = await issueQueueRequests()
  console.log(
    JSON.stringify({
      study: STUDY,
      scope: SCOPE,
      windows: result.windows,
      issued: result.issued,
      sequences: result.rows.map((row) => row.sequence),
      coverage: 'bounded_contiguous_from_bootstrap_only',
      windowOverflowPolicy: 'adaptive_block_boundary_up_to_12_single_block_hard_blocker',
    }),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
