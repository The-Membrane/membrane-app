// Prospective enrollment of *new* ApyUSD ERC721 receipt mints. A mint is an
// issue event, not proof of the requested asset amount or a future payout.
import { createHash, randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { link, mkdir, open, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { keccak256, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { RECEIPT } from './carry-public-apyusd-exit-common.mjs'
import { normalizeMint } from './apyusd-receipt-cohort-source.mjs'
import { normalizeTransfer } from './apyusd-receipt-cohort-transfers.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-prospective-receipt-intake-v1')
const ANCHOR_STUDY = 'apyusd_prospective_receipt_intake_anchor_v1'
const WINDOW_STUDY = 'apyusd_prospective_receipt_intake_window_v1'
const STEP = 1_000
const MAX_EVENT_BLOCKS = 18
const MAX_TRANSFERS = 48
const MAX_MINTS = 24
const MAX_RPC_CALLS = 70
const MAX_WALL_MS = 135_000
const MAX_LOG_BYTES = 128 * 1024
const MAX_RECORD_BYTES = 128 * 1024
const MAX_VERIFY_BYTES = 64 * 1024 * 1024
const MAX_STORED_WINDOWS = 4_096
const MIN_FREE_BYTES = 1_073_741_824 + 262_144
const MAX_HEAD_AGE_MS = 45 * 60_000
const FUTURE_SKEW_MS = 120_000
const SHA = /^[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const ZERO = `0x${'0'.repeat(64)}`
const TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const ANCHOR_FIELDS = [
  'study',
  'receipt',
  'chainId',
  'origins',
  'reportedFinalizedHeads',
  'header',
  'observedAtUtc',
  'enrollmentFromBlock',
  'sha256',
]
  .sort()
  .join(',')
const WINDOW_FIELDS = [
  'study',
  'sequence',
  'previousSha256',
  'anchorSha256',
  'receipt',
  'chainId',
  'origins',
  'fromBlock',
  'toBlock',
  'fromHeader',
  'toHeader',
  'finalizedHead',
  'reportedFinalizedHeads',
  'observedAtUtc',
  'eventBlockHeaders',
  'transfers',
  'mints',
  'sha256',
]
  .sort()
  .join(',')
const MINT_FIELDS = [
  'tokenId',
  'initialHolder',
  'issueBlockNumber',
  'issueBlockHash',
  'issueBlockTimestamp',
  'transactionHash',
  'logIndex',
  'rawLog',
  'requestAssets',
]
  .sort()
  .join(',')
const UNKNOWN_ASSETS = Object.freeze({ status: 'unknown', assetsRaw: null, source: null })
const fail = (condition, code) => {
  if (!condition) throw Error(code)
}
const canonical = JSON.stringify
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hex = (number) => `0x${number.toString(16)}`
const name = (sequence) => `${String(sequence).padStart(8, '0')}.json`
const bodyHash = (row) => {
  const { sha256: _seal, ...body } = row
  return sha(canonical(body))
}
const seal = (body) => ({ ...body, sha256: sha(canonical(body)) })

function utcMs(value) {
  const ms = Date.parse(value ?? '')
  fail(
    Number.isSafeInteger(ms) && new Date(ms).toISOString() === value,
    'apyusd_intake_time_invalid',
  )
  return ms
}

function header(raw, expectedNumber = null) {
  const number = Number(BigInt(raw?.number ?? '0x0'))
  const timestamp = Number(BigInt(raw?.timestamp ?? '0x0'))
  const value = {
    number,
    hash: raw?.hash?.toLowerCase(),
    parentHash: raw?.parentHash?.toLowerCase(),
    timestamp,
  }
  fail(
    Number.isSafeInteger(number) &&
      number > 0 &&
      (expectedNumber === null || number === expectedNumber) &&
      WORD.test(value.hash ?? '') &&
      WORD.test(value.parentHash ?? '') &&
      Number.isSafeInteger(timestamp) &&
      timestamp > 0,
    'apyusd_intake_header_invalid',
  )
  return value
}

function exactHeader(value, expectedNumber = null) {
  return canonical(header(value, expectedNumber)) === canonical(value)
}

function validateReported(reported, agreed) {
  fail(
    Array.isArray(reported) &&
      reported.length === 2 &&
      reported.every(
        (item) =>
          exactHeader(item) &&
          item.number >= agreed.number &&
          (item.number !== agreed.number || canonical(item) === canonical(agreed)),
      ) &&
      Math.min(...reported.map((item) => item.number)) === agreed.number,
    'apyusd_intake_finality_invalid',
  )
}

function validateObserved(atUtc, head, previousAt = null) {
  const at = utcMs(atUtc)
  fail(
    at - head.timestamp * 1_000 >= -FUTURE_SKEW_MS &&
      at - head.timestamp * 1_000 <= MAX_HEAD_AGE_MS &&
      (previousAt === null || at >= utcMs(previousAt)),
    'apyusd_intake_time_invalid',
  )
}

function validateAnchor(anchor) {
  fail(
    anchor?.study === ANCHOR_STUDY &&
      Object.keys(anchor).sort().join(',') === ANCHOR_FIELDS &&
      anchor.receipt === RECEIPT &&
      anchor.chainId === 1 &&
      Array.isArray(anchor.origins) &&
      anchor.origins.length === 2 &&
      anchor.origins.every((host) => typeof host === 'string' && /^[a-z0-9.-]+$/.test(host)) &&
      anchor.origins[0] !== anchor.origins[1] &&
      exactHeader(anchor.header) &&
      anchor.enrollmentFromBlock === anchor.header.number + 1 &&
      SHA.test(anchor.sha256 ?? '') &&
      anchor.sha256 === bodyHash(anchor),
    'apyusd_intake_anchor_invalid',
  )
  validateReported(anchor.reportedFinalizedHeads, anchor.header)
  validateObserved(anchor.observedAtUtc, anchor.header)
  return anchor
}

function normalizeRawMint(rawLog, low, high) {
  fail(rawLog && typeof rawLog === 'object' && !Array.isArray(rawLog), 'apyusd_intake_mint_invalid')
  const normalized = normalizeMint(rawLog, low, high)
  fail(
    normalized.data === '0x' &&
      normalized.topics[1] === ZERO &&
      normalized.topics[2] !== ZERO &&
      BigInt(normalized.topics[3]) > 0n,
    'apyusd_intake_mint_invalid',
  )
  return normalized
}

function normalizeRawTransfer(rawLog, low, high) {
  const event = normalizeTransfer(rawLog, low, high)
  fail(
    event.data === '0x' &&
      event.topics[1].slice(2, 26) === '0'.repeat(24) &&
      event.topics[2].slice(2, 26) === '0'.repeat(24) &&
      !(event.topics[1] === ZERO && event.topics[2] === ZERO),
    'apyusd_intake_transfer_invalid',
  )
  return event
}

function validateMint(mint, low, high, headers) {
  fail(
    mint &&
      Object.keys(mint).sort().join(',') === MINT_FIELDS &&
      canonical(mint.requestAssets) === canonical(UNKNOWN_ASSETS),
    'apyusd_intake_mint_invalid',
  )
  const event = normalizeRawMint(mint.rawLog, low, high)
  const issueHeader = headers.get(event.blockNumber)
  fail(
    issueHeader &&
      issueHeader.hash === event.blockHash &&
      mint.tokenId === BigInt(event.topics[3]).toString() &&
      mint.initialHolder === `0x${event.topics[2].slice(-40)}` &&
      ADDRESS.test(mint.initialHolder) &&
      mint.issueBlockNumber === event.blockNumber &&
      mint.issueBlockHash === event.blockHash &&
      mint.issueBlockTimestamp === issueHeader.timestamp &&
      mint.transactionHash === event.transactionHash &&
      mint.logIndex === event.logIndex,
    'apyusd_intake_mint_invalid',
  )
  return event
}

function validateWindow(row, anchor, prior) {
  const low = (prior?.toBlock ?? anchor.header.number) + 1
  fail(
    row?.study === WINDOW_STUDY &&
      Object.keys(row).sort().join(',') === WINDOW_FIELDS &&
      row.sequence === (prior?.sequence ?? 0) + 1 &&
      row.previousSha256 === (prior?.sha256 ?? anchor.sha256) &&
      row.anchorSha256 === anchor.sha256 &&
      row.receipt === RECEIPT &&
      row.chainId === 1 &&
      canonical(row.origins) === canonical(anchor.origins) &&
      row.fromBlock === low &&
      Number.isSafeInteger(row.toBlock) &&
      row.toBlock >= low &&
      row.toBlock <= low + STEP - 1 &&
      exactHeader(row.fromHeader, low) &&
      exactHeader(row.toHeader, row.toBlock) &&
      exactHeader(row.finalizedHead) &&
      row.toBlock <= row.finalizedHead.number &&
      row.fromHeader.parentHash === (prior?.toHeader.hash ?? anchor.header.hash) &&
      row.fromHeader.timestamp <= row.toHeader.timestamp &&
      row.toHeader.timestamp <= row.finalizedHead.timestamp &&
      (low !== row.toBlock || canonical(row.fromHeader) === canonical(row.toHeader)) &&
      (row.toBlock !== low + 1 || row.toHeader.parentHash === row.fromHeader.hash) &&
      SHA.test(row.sha256 ?? '') &&
      row.sha256 === bodyHash(row),
    'apyusd_intake_window_invalid',
  )
  validateReported(row.reportedFinalizedHeads, row.finalizedHead)
  validateObserved(
    row.observedAtUtc,
    row.finalizedHead,
    prior?.observedAtUtc ?? anchor.observedAtUtc,
  )
  fail(
    Array.isArray(row.eventBlockHeaders) &&
      row.eventBlockHeaders.length <= MAX_EVENT_BLOCKS &&
      row.eventBlockHeaders.every(
        (item) =>
          exactHeader(item) &&
          item.number >= low &&
          item.number <= row.toBlock &&
          item.timestamp >= row.fromHeader.timestamp &&
          item.timestamp <= row.toHeader.timestamp &&
          (item.number !== low || item.hash === row.fromHeader.hash) &&
          (item.number !== row.toBlock || item.hash === row.toHeader.hash),
      ) &&
      row.eventBlockHeaders.every(
        (item, index) => index === 0 || row.eventBlockHeaders[index - 1].number < item.number,
      ) &&
      row.eventBlockHeaders.every(
        (item, index) =>
          index === 0 ||
          row.eventBlockHeaders[index - 1].number + 1 !== item.number ||
          item.parentHash === row.eventBlockHeaders[index - 1].hash,
      ) &&
      Array.isArray(row.transfers) &&
      row.transfers.length <= MAX_TRANSFERS &&
      Array.isArray(row.mints) &&
      row.mints.length <= MAX_MINTS,
    'apyusd_intake_events_invalid',
  )
  const headers = new Map(row.eventBlockHeaders.map((item) => [item.number, item]))
  const events = row.transfers.map((event) => {
    const normalized = normalizeRawTransfer(
      {
        ...event,
        address: RECEIPT,
        blockNumber: hex(event.blockNumber),
        logIndex: hex(event.logIndex),
      },
      low,
      row.toBlock,
    )
    fail(
      canonical(normalized) === canonical(event) &&
        headers.get(event.blockNumber)?.hash === event.blockHash,
      'apyusd_intake_transfer_invalid',
    )
    return event
  })
  const mintEvents = row.mints.map((mint) => validateMint(mint, low, row.toBlock, headers))
  fail(
    canonical([...new Set(events.map((event) => event.blockNumber))]) ===
      canonical(row.eventBlockHeaders.map((item) => item.number)) &&
      canonical(mintEvents) === canonical(events.filter((event) => event.topics[1] === ZERO)) &&
      events.every(
        (event, index) =>
          index === 0 ||
          event.blockNumber > events[index - 1].blockNumber ||
          (event.blockNumber === events[index - 1].blockNumber &&
            event.logIndex > events[index - 1].logIndex),
      ),
    'apyusd_intake_events_invalid',
  )
  return row
}

function checkNewMintIds(mints, seen) {
  for (const mint of mints) {
    fail(!seen.has(mint.tokenId), 'apyusd_intake_token_remint')
    seen.add(mint.tokenId)
  }
}

async function readRecord(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  try {
    const stat = await fd.stat()
    fail(stat.isFile() && stat.size <= MAX_RECORD_BYTES, 'apyusd_intake_record_size_invalid')
    bytes = await fd.readFile()
  } finally {
    await fd.close()
  }
  const row = JSON.parse(bytes.toString('utf8'))
  fail(bytes.toString('utf8') === `${canonical(row)}\n`, 'apyusd_intake_record_encoding_invalid')
  return row
}

export async function verifyProspectiveIntake(out = OUT) {
  let files
  try {
    files = await readdir(out)
  } catch (error) {
    if (error.code === 'ENOENT')
      return { anchor: null, windows: [], coveredThrough: null, mints: 0 }
    throw error
  }
  if (files.length === 0) return { anchor: null, windows: [], coveredThrough: null, mints: 0 }
  fail(
    files.every((entry) => entry === 'anchor.json' || /^\d{8}\.json$/.test(entry)),
    'apyusd_intake_unexpected_file',
  )
  fail(files.includes('anchor.json'), 'apyusd_intake_anchor_missing')
  const numbered = files.filter((entry) => entry !== 'anchor.json').sort()
  fail(numbered.length <= MAX_STORED_WINDOWS, 'apyusd_intake_chain_limit')
  const anchor = validateAnchor(await readRecord(join(out, 'anchor.json')))
  const windows = []
  const seenMintIds = new Set()
  let totalBytes = 0
  let mints = 0
  for (const file of numbered) {
    fail(file === name(windows.length + 1), 'apyusd_intake_chain_gap')
    const row = validateWindow(await readRecord(join(out, file)), anchor, windows.at(-1) ?? null)
    totalBytes += Buffer.byteLength(canonical(row))
    fail(totalBytes <= MAX_VERIFY_BYTES, 'apyusd_intake_verify_budget')
    checkNewMintIds(row.mints, seenMintIds)
    mints += row.mints.length
    windows.push(row)
  }
  return { anchor, windows, coveredThrough: windows.at(-1)?.toBlock ?? anchor.header.number, mints }
}

async function writeExclusive(path, row, freeBytes) {
  const body = `${canonical(row)}\n`
  fail(Buffer.byteLength(body) <= MAX_RECORD_BYTES, 'apyusd_intake_record_size_invalid')
  const targetDir = dirname(path)
  await mkdir(targetDir, { recursive: true })
  fail(freeBytes() >= MIN_FREE_BYTES + Buffer.byteLength(body), 'apyusd_intake_disk_reserve')
  // A crash can strand a staging file. Keep it outside the verified ledger
  // directory so the next capture can still replay the committed chain.
  const tmp = join(dirname(targetDir), `.${basename(targetDir)}-${randomUUID()}.tmp`)
  try {
    const fd = await open(tmp, 'wx', 0o600)
    try {
      await fd.writeFile(body)
      await fd.sync()
    } finally {
      await fd.close()
    }
    await link(tmp, path)
    const dir = await open(targetDir, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await rm(tmp, { force: true })
  }
}

function boundedOrigins(origins, clock, deadline) {
  let calls = 0
  const check = () => fail(calls < MAX_RPC_CALLS && clock() < deadline, 'apyusd_intake_rpc_budget')
  return {
    clients: origins.map((origin) => ({
      ...origin,
      async request(...args) {
        check()
        calls++
        return origin.request(...args)
      },
    })),
    checkTime: () => fail(clock() < deadline, 'apyusd_intake_rpc_budget'),
  }
}

async function sameHeader(origins, tag, expectedNumber = null) {
  const pair = await Promise.all(
    origins.map(async (origin) =>
      header(await origin.request('eth_getBlockByNumber', [tag, false]), expectedNumber),
    ),
  )
  fail(canonical(pair[0]) === canonical(pair[1]), 'apyusd_intake_headers_disagree')
  return pair[0]
}

async function finalizedHead(origins) {
  const reported = await Promise.all(
    origins.map(async (origin) =>
      header(await origin.request('eth_getBlockByNumber', ['finalized', false])),
    ),
  )
  const agreed = await sameHeader(
    origins,
    hex(Math.min(...reported.map((item) => item.number))),
    Math.min(...reported.map((item) => item.number)),
  )
  validateReported(reported, agreed)
  return { reported, agreed }
}

function normalizeLogs(logs, low, high) {
  fail(
    Array.isArray(logs) && Buffer.byteLength(canonical(logs)) <= MAX_LOG_BYTES,
    'apyusd_intake_logs_budget',
  )
  const events = logs.map((log) => normalizeRawTransfer(log, low, high))
  fail(
    events.length <= MAX_TRANSFERS &&
      events.filter((event) => event.topics[1] === ZERO).length <= MAX_MINTS,
    'apyusd_intake_events_budget',
  )
  fail(
    events.every(
      (event, index) =>
        index === 0 ||
        event.blockNumber > events[index - 1].blockNumber ||
        (event.blockNumber === events[index - 1].blockNumber &&
          event.logIndex > events[index - 1].logIndex),
    ),
    'apyusd_intake_logs_order_invalid',
  )
  return events
}

async function fetchWindow(origins, low, high) {
  const query = { address: RECEIPT, topics: [TOPIC], fromBlock: hex(low), toBlock: hex(high) }
  const [leftRaw, rightRaw] = await Promise.all([
    origins[0].request('eth_getLogs', [query]),
    origins[1].request('eth_getLogs', [query]),
  ])
  const left = normalizeLogs(leftRaw, low, high)
  const right = normalizeLogs(rightRaw, low, high)
  fail(canonical(left) === canonical(right), 'apyusd_intake_logs_disagree')
  const eventNumbers = [...new Set(left.map((event) => event.blockNumber))]
  fail(eventNumbers.length <= MAX_EVENT_BLOCKS, 'apyusd_intake_events_budget')
  const [fromHeader, toHeader] = await Promise.all([
    sameHeader(origins, hex(low), low),
    sameHeader(origins, hex(high), high),
  ])
  const headers = await Promise.all(
    eventNumbers.map((number) => sameHeader(origins, hex(number), number)),
  )
  const byNumber = new Map(headers.map((item) => [item.number, item]))
  const mints = left.flatMap((event, index) => {
    if (event.topics[1] !== ZERO) return []
    const issueHeader = byNumber.get(event.blockNumber)
    fail(issueHeader.hash === event.blockHash, 'apyusd_intake_log_header_disagree')
    return [
      {
        tokenId: BigInt(event.topics[3]).toString(),
        initialHolder: `0x${event.topics[2].slice(-40)}`,
        issueBlockNumber: event.blockNumber,
        issueBlockHash: event.blockHash,
        issueBlockTimestamp: issueHeader.timestamp,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        rawLog: leftRaw[index],
        requestAssets: { ...UNKNOWN_ASSETS },
      },
    ]
  })
  return { fromHeader, toHeader, eventBlockHeaders: headers, transfers: left, mints }
}

export async function captureProspectiveIntake({
  out = OUT,
  urls = null,
  clientsForUrls = publicRpcClients,
  now = Date.now,
  rpcClock = Date.now,
  freeBytes = () => {
    const disk = statfsSync(resolve(out, '..'))
    return Number(disk.bavail) * Number(disk.bsize)
  },
} = {}) {
  const deadline = rpcClock() + MAX_WALL_MS
  const checkTime = () => fail(rpcClock() < deadline, 'apyusd_intake_rpc_budget')
  fail(freeBytes() >= MIN_FREE_BYTES, 'apyusd_intake_disk_reserve')
  const prior = await verifyProspectiveIntake(out)
  checkTime()
  const configured = urls ?? configuredPublicRpcUrls(readEnv())
  const clients = clientsForUrls(configured)
  const selected = []
  for (const client of clients) {
    const host = new URL(client.url).hostname.toLowerCase()
    if (!selected.some((item) => item.host === host || item.client.provider === client.provider))
      selected.push({ host, client })
    if (selected.length === 2) break
  }
  fail(selected.length === 2, 'apyusd_intake_origins_invalid')
  const hosts = selected.map((item) => item.host)
  fail(
    !prior.anchor || canonical(hosts) === canonical(prior.anchor.origins),
    'apyusd_intake_origins_changed',
  )
  const { clients: origins } = boundedOrigins(
    selected.map((item) => item.client),
    rpcClock,
    deadline,
  )
  const chainIds = await Promise.all(origins.map((origin) => origin.request('eth_chainId', [])))
  fail(
    chainIds.every((id) => id === '0x1'),
    'apyusd_intake_chain_invalid',
  )
  const head = await finalizedHead(origins)
  const observedAtUtc = new Date(now()).toISOString()
  validateObserved(
    observedAtUtc,
    head.agreed,
    prior.windows.at(-1)?.observedAtUtc ?? prior.anchor?.observedAtUtc ?? null,
  )
  checkTime()
  if (!prior.anchor) {
    const anchor = validateAnchor(
      seal({
        study: ANCHOR_STUDY,
        receipt: RECEIPT,
        chainId: 1,
        origins: hosts,
        reportedFinalizedHeads: head.reported,
        header: head.agreed,
        observedAtUtc,
        enrollmentFromBlock: head.agreed.number + 1,
      }),
    )
    fail(!(await verifyProspectiveIntake(out)).anchor, 'apyusd_intake_chain_changed')
    checkTime()
    await writeExclusive(join(out, 'anchor.json'), anchor, freeBytes)
    return {
      status: 'anchored',
      anchorBlock: anchor.header.number,
      coveredThrough: anchor.header.number,
      mints: 0,
      windows: 0,
    }
  }
  const last = prior.windows.at(-1) ?? null
  const boundaryNumber = last?.toBlock ?? prior.anchor.header.number
  const boundary = await sameHeader(origins, hex(boundaryNumber), boundaryNumber)
  fail(
    boundary.hash === (last?.toHeader.hash ?? prior.anchor.header.hash),
    'apyusd_intake_previous_reorg',
  )
  const low = boundaryNumber + 1
  if (low > head.agreed.number)
    return {
      status: 'up_to_date',
      anchorBlock: prior.anchor.header.number,
      coveredThrough: boundaryNumber,
      mints: 0,
      windows: prior.windows.length,
    }
  fail(prior.windows.length < MAX_STORED_WINDOWS, 'apyusd_intake_chain_limit')
  let high = Math.min(low + STEP - 1, head.agreed.number)
  let window
  for (let probe = 0; probe < 11; probe++) {
    try {
      window = await fetchWindow(origins, low, high)
      break
    } catch (error) {
      if (
        !['apyusd_intake_events_budget', 'apyusd_intake_logs_budget'].includes(error.message) ||
        high === low ||
        probe === 10
      )
        throw error
      high = low + Math.floor((high - low) / 2)
    }
  }
  const row = seal({
    study: WINDOW_STUDY,
    sequence: (last?.sequence ?? 0) + 1,
    previousSha256: last?.sha256 ?? prior.anchor.sha256,
    anchorSha256: prior.anchor.sha256,
    receipt: RECEIPT,
    chainId: 1,
    origins: hosts,
    fromBlock: low,
    toBlock: high,
    fromHeader: window.fromHeader,
    toHeader: window.toHeader,
    finalizedHead: head.agreed,
    reportedFinalizedHeads: head.reported,
    observedAtUtc: new Date(now()).toISOString(),
    eventBlockHeaders: window.eventBlockHeaders,
    transfers: window.transfers,
    mints: window.mints,
  })
  validateWindow(row, prior.anchor, last)
  checkNewMintIds(
    row.mints,
    new Set(prior.windows.flatMap((window) => window.mints.map((mint) => mint.tokenId))),
  )
  checkTime()
  const current = await verifyProspectiveIntake(out)
  fail(
    current.anchor?.sha256 === prior.anchor.sha256 &&
      current.windows.length === prior.windows.length &&
      current.windows.at(-1)?.sha256 === last?.sha256,
    'apyusd_intake_chain_changed',
  )
  await writeExclusive(join(out, name(row.sequence)), row, freeBytes)
  return {
    status: 'captured',
    anchorBlock: prior.anchor.header.number,
    coveredThrough: row.toBlock,
    mints: row.mints.length,
    windows: row.sequence,
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    fail(
      process.argv.length === 3 && ['--capture', '--verify'].includes(process.argv[2]),
      'apyusd_intake_usage',
    )
    const result =
      process.argv[2] === '--capture'
        ? await captureProspectiveIntake()
        : await verifyProspectiveIntake()
    process.stdout.write(
      `${JSON.stringify(
        process.argv[2] === '--verify'
          ? {
              status: result.anchor ? 'verified' : 'not_enrolled',
              anchorBlock: result.anchor?.header.number ?? null,
              coveredThrough: result.coveredThrough,
              windows: result.windows.length,
              mints: result.mints,
            }
          : result,
      )}\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${
        /^apyusd_intake_[a-z0-9_]+$/.test(error?.message) ? error.message : 'apyusd_intake_failed'
      }\n`,
    )
    process.exitCode = 1
  }
}
