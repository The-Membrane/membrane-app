// Bounded historical Hastra wYLDS request → completion → USDC transfer evidence.
// Discovery coverage is one origin; each found event and receipt is paired.
import { createHash, randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeEventLog, keccak256, parseAbiItem, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { STUDY as ROUTE_STUDY, USDC, WYLDS } from './pyusd-staking-economic-exit.mjs'

export const STUDY = 'pyusd_staking_redemption_history_v1'
export const ROOT = resolve('data/research/venue-signals/pyusd-staking-redemption-history-v1')
const REQUEST = parseAbiItem(
  'event RedemptionRequested(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
)
const COMPLETE = parseAbiItem(
  'event RedemptionCompleted(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
)
const CANCEL = parseAbiItem('event RedemptionCancelled(address indexed user,uint256 shares)')
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const TOPICS = [REQUEST, COMPLETE, CANCEL].map((item) =>
  keccak256(stringToHex(`${item.name}(${item.inputs.map((i) => i.type).join(',')})`)),
)
const TRANSFER_TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const HASH = /^0x[0-9a-f]{64}$/
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase()
const sha = (v) => createHash('sha256').update(v).digest('hex')
const hex = (n) => `0x${BigInt(n).toString(16)}`
const key = (log) => `${log.transactionHash}:${BigInt(log.logIndex)}`
const materialLog = (log) => ({
  address: log.address?.toLowerCase(),
  blockHash: log.blockHash?.toLowerCase(),
  transactionHash: log.transactionHash?.toLowerCase(),
  logIndex: BigInt(log.logIndex).toString(),
  topics: log.topics?.map((topic) => topic.toLowerCase()),
  data: log.data?.toLowerCase(),
})
const materialReceipt = (receipt) => ({
  transactionHash: receipt.transactionHash?.toLowerCase(),
  blockHash: receipt.blockHash?.toLowerCase(),
  status: receipt.status,
  logs: receipt.logs?.map(materialLog),
})
const chronological = (events) =>
  [...events].sort((a, b) =>
    BigInt(a.blockNumber) < BigInt(b.blockNumber)
      ? -1
      : BigInt(a.blockNumber) > BigInt(b.blockNumber)
        ? 1
        : a.logIndex - b.logIndex,
  )
const decimal = /^(0|[1-9][0-9]*)$/

export function assertDiscoveryLogInRange(log, start, end) {
  if (
    !log ||
    !log.blockNumber ||
    !HASH.test(log.blockHash ?? '') ||
    !Array.isArray(log.topics) ||
    !TOPICS.includes(log.topics[0]?.toLowerCase()) ||
    !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1] ?? '')
  )
    throw Error('pyusd_history_log_range_invalid')
  let blockNumber
  try {
    blockNumber = BigInt(log.blockNumber)
  } catch {
    throw Error('pyusd_history_log_range_invalid')
  }
  if (blockNumber < start || blockNumber > end) throw Error('pyusd_history_log_range_invalid')
}

function eventInRange(event, start, end) {
  return (
    event &&
    decimal.test(event.blockNumber ?? '') &&
    BigInt(event.blockNumber) >= start &&
    BigInt(event.blockNumber) <= end &&
    HASH.test(event.blockHash ?? '') &&
    HASH.test(event.transactionHash ?? '') &&
    Number.isSafeInteger(event.logIndex) &&
    event.logIndex >= 0
  )
}

function sorted(logs) {
  return [...logs].sort((a, b) =>
    BigInt(a.blockNumber) < BigInt(b.blockNumber)
      ? -1
      : BigInt(a.blockNumber) > BigInt(b.blockNumber)
        ? 1
        : BigInt(a.transactionIndex) < BigInt(b.transactionIndex)
          ? -1
          : BigInt(a.transactionIndex) > BigInt(b.transactionIndex)
            ? 1
            : Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
  )
}

export function reconcile(events) {
  const pending = new Map()
  const rows = []
  for (const event of events) {
    const user = event.user.toLowerCase()
    if (event.kind === 'request') {
      if (pending.has(user)) throw Error('pyusd_history_duplicate_request')
      pending.set(user, event)
    } else if (event.kind === 'cancel') {
      const start = pending.get(user)
      if (start) {
        rows.push({ kind: 'cancelled', user, request: start, end: event, durationSeconds: null })
        pending.delete(user)
      } else
        rows.push({
          kind: 'left_censored_cancel',
          user,
          request: null,
          end: event,
          durationSeconds: null,
        })
    } else if (event.kind === 'completion') {
      const start = pending.get(user)
      if (start && (start.sharesRaw !== event.sharesRaw || start.assetsRaw !== event.assetsRaw))
        throw Error('pyusd_history_amount_mismatch')
      rows.push({
        kind: start
          ? event.usdcPayout === 'receipt_transfer_attested'
            ? 'completed_paid'
            : 'completed_unpaid_unproven'
          : 'left_censored_completion',
        user,
        request: start ?? null,
        end: event,
        durationSeconds: start ? event.timestamp - start.timestamp : null,
      })
      pending.delete(user)
    }
  }
  for (const [user, start] of pending)
    rows.push({
      kind: 'right_censored_pending',
      user,
      request: start,
      end: null,
      durationSeconds: null,
    })
  if (rows.some((row) => row.durationSeconds !== null && row.durationSeconds < 0))
    throw Error('pyusd_history_clock_invalid')
  return rows
}

function normalize(log) {
  if (
    !same(log.address, WYLDS) ||
    !TOPICS.includes(log.topics?.[0]?.toLowerCase()) ||
    !HASH.test(log.blockHash ?? '') ||
    !HASH.test(log.transactionHash ?? '')
  )
    throw Error('pyusd_history_log_invalid')
  const index = TOPICS.indexOf(log.topics[0].toLowerCase())
  const decoded = decodeEventLog({
    abi: [REQUEST, COMPLETE, CANCEL],
    data: log.data,
    topics: log.topics,
    strict: true,
  })
  return {
    kind: ['request', 'completion', 'cancel'][index],
    user: decoded.args.user.toLowerCase(),
    sharesRaw: decoded.args.shares.toString(),
    assetsRaw: index === 2 ? null : decoded.args.assets.toString(),
    timestamp: index === 2 ? null : Number(decoded.args.timestamp),
    blockNumber: BigInt(log.blockNumber).toString(),
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex)),
  }
}

function payout(receipt, event, redeemVault) {
  if (event.kind !== 'completion') return 'not_applicable'
  const expected = BigInt(event.assetsRaw)
  const matches = receipt.logs
    .filter((log) => same(log.address, USDC) && same(log.topics?.[0], TRANSFER_TOPIC))
    .map((log) => {
      try {
        return decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics, strict: true })
          .args
      } catch {
        return null
      }
    })
    .filter(
      (args) =>
        args &&
        same(args.from, redeemVault) &&
        same(args.to, event.user) &&
        args.value === expected,
    )
  return matches.length === 1 ? 'receipt_transfer_attested' : 'receipt_transfer_not_found'
}

export async function collectHistory([first, second], blocks = 5000, fullWindow = false) {
  if (
    !first ||
    !second ||
    first.provider === second.provider ||
    !Number.isSafeInteger(blocks) ||
    blocks < 1 ||
    blocks > 5000
  )
    throw Error('pyusd_history_input_invalid')
  const [head, secondHead] = await Promise.all([
    first.request('eth_getBlockByNumber', ['finalized', false]),
    second.request('eth_getBlockByNumber', ['finalized', false]),
  ])
  if (!HASH.test(head?.hash ?? '') || BigInt(secondHead?.number ?? -1) < BigInt(head.number))
    throw Error('pyusd_history_finalized_unavailable')
  const end = BigInt(head.number)
  const start = end - BigInt(blocks) + 1n
  const secondPinned = await second.request('eth_getBlockByNumber', [hex(end), false])
  if (!same(head.hash, secondPinned?.hash)) throw Error('pyusd_history_header_disagreement')
  // One origin supplies complete-window candidate discovery. Provider co-omission is unproved.
  const discovered = []
  for (let high = end; high >= start; high -= 5000n) {
    const low = high - 4999n >= start ? high - 4999n : start
    const logs = await first.request('eth_getLogs', [
      { address: WYLDS, topics: [TOPICS], fromBlock: hex(low), toBlock: hex(high) },
    ])
    if (!Array.isArray(logs) || logs.length > 2000) throw Error('pyusd_history_logs_invalid')
    discovered.push(...logs)
  }
  for (const log of discovered) assertDiscoveryLogInRange(log, start, end)
  const raw = sorted(discovered)
  if (new Set(raw.map(key)).size !== raw.length) throw Error('pyusd_history_duplicate_log')
  if (fullWindow) {
    const replay = []
    for (let low = start; low <= end; low += 50n) {
      const high = low + 49n < end ? low + 49n : end
      const logs = await second.request('eth_getLogs', [
        { address: WYLDS, topics: [TOPICS], fromBlock: hex(low), toBlock: hex(high) },
      ])
      if (!Array.isArray(logs) || logs.length > 2000)
        throw Error('pyusd_history_replay_logs_invalid')
      for (const log of logs) assertDiscoveryLogInRange(log, low, high)
      replay.push(...logs)
    }
    if (JSON.stringify(sorted(replay).map(materialLog)) !== JSON.stringify(raw.map(materialLog)))
      throw Error('pyusd_history_full_window_disagreement')
  }
  const events = []
  for (const log of raw) {
    const [firstBlock, block] = await Promise.all([
      first.request('eth_getBlockByNumber', [log.blockNumber, false]),
      second.request('eth_getBlockByNumber', [log.blockNumber, false]),
    ])
    const witnessed = await second.request('eth_getLogs', [
      { address: WYLDS, topics: [log.topics[0], log.topics[1]], blockHash: log.blockHash },
    ])
    if (
      !same(firstBlock?.hash, log.blockHash) ||
      !same(block?.hash, log.blockHash) ||
      BigInt(firstBlock?.number ?? -1) !== BigInt(log.blockNumber) ||
      BigInt(block?.number ?? -1) !== BigInt(log.blockNumber) ||
      !same(firstBlock?.hash, block?.hash) ||
      !Array.isArray(witnessed) ||
      !witnessed.some(
        (row) =>
          key(row) === key(log) &&
          JSON.stringify(materialLog(row)) === JSON.stringify(materialLog(log)),
      )
    )
      throw Error('pyusd_history_event_disagreement')
    const [receiptA, receiptB] = await Promise.all([
      first.request('eth_getTransactionReceipt', [log.transactionHash]),
      second.request('eth_getTransactionReceipt', [log.transactionHash]),
    ])
    if (
      !receiptA ||
      !receiptB ||
      !same(receiptA.blockHash, log.blockHash) ||
      receiptA.status !== '0x1' ||
      JSON.stringify(materialReceipt(receiptA)) !== JSON.stringify(materialReceipt(receiptB)) ||
      !receiptA.logs.some(
        (row) =>
          key(row) === key(log) &&
          JSON.stringify(materialLog(row)) === JSON.stringify(materialLog(log)),
      )
    )
      throw Error('pyusd_history_receipt_disagreement')
    const event = normalize(log)
    if (event.timestamp !== null && event.timestamp !== Number(BigInt(block.timestamp)))
      throw Error('pyusd_history_event_clock_invalid')
    const redeemVaultWord = await first.request('eth_call', [
      { to: WYLDS, data: '0x' + keccak256(stringToHex('redeemVault()')).slice(2, 10) },
      { blockHash: log.blockHash, requireCanonical: true },
    ])
    if (!HASH.test(redeemVaultWord ?? '')) throw Error('pyusd_history_redeem_vault_invalid')
    event.redeemVault = `0x${redeemVaultWord.slice(-40)}`.toLowerCase()
    event.usdcPayout = payout(receiptA, event, event.redeemVault)
    event.receiptSha256 = sha(JSON.stringify(materialReceipt(receiptA)))
    events.push(event)
  }
  const episodes = reconcile(events)
  return {
    study: STUDY,
    routeStudy: ROUTE_STUDY,
    chainId: 1,
    range: {
      startBlock: start.toString(),
      endBlock: end.toString(),
      endHash: head.hash.toLowerCase(),
    },
    origins: [first.provider, second.provider],
    discoveryCompleteness: fullWindow ? 'two_origin_raw_log_agreement' : 'single_origin_not_proven',
    foundEvents: events.length,
    episodes,
    paidMatchedEpisodes: episodes.filter((x) => x.kind === 'completed_paid').length,
    finalPyusdPayout: 'not_attested',
  }
}

export function validateHistoryRow(row, sequence, previousSha256) {
  const { sha256, ...body } = row ?? {}
  const start = row?.range?.startBlock
  const end = row?.range?.endBlock
  const allowedKeys = [
    'study',
    'routeStudy',
    'chainId',
    'range',
    'origins',
    'discoveryCompleteness',
    'foundEvents',
    'episodes',
    'paidMatchedEpisodes',
    'finalPyusdPayout',
    'sequence',
    'previousSha256',
    'sha256',
  ]
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    row?.sequence !== sequence ||
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(allowedKeys.sort()) ||
    row.previousSha256 !== previousSha256 ||
    row.study !== STUDY ||
    row.routeStudy !== ROUTE_STUDY ||
    row.chainId !== 1 ||
    !decimal.test(start ?? '') ||
    !decimal.test(end ?? '') ||
    BigInt(start) > BigInt(end) ||
    BigInt(end) - BigInt(start) >= 5000n ||
    !HASH.test(row.range.endHash ?? '') ||
    !Array.isArray(row.origins) ||
    row.origins.length !== 2 ||
    row.origins.some(
      (origin) => typeof origin !== 'string' || !/^https?:\/\/[^/]+$/.test(origin),
    ) ||
    row.origins[0] === row.origins[1] ||
    !['single_origin_not_proven', 'two_origin_raw_log_agreement'].includes(
      row.discoveryCompleteness,
    ) ||
    row.finalPyusdPayout !== 'not_attested' ||
    !Array.isArray(row.episodes) ||
    !Number.isSafeInteger(row.foundEvents) ||
    row.foundEvents < 0 ||
    !Number.isSafeInteger(row.paidMatchedEpisodes) ||
    row.paidMatchedEpisodes < 0 ||
    !/^[0-9a-f]{64}$/.test(sha256 ?? '') ||
    sha256 !== sha(JSON.stringify(body))
  )
    throw Error('pyusd_history_ledger_invalid')
  const events = chronological(
    row.episodes.flatMap((episode) => [episode.request, episode.end].filter(Boolean)),
  )
  if (
    events.some((event) => !eventInRange(event, BigInt(start), BigInt(end))) ||
    new Set(events.map((event) => `${event.transactionHash}:${event.logIndex}`)).size !==
      events.length ||
    row.foundEvents !== events.length ||
    row.paidMatchedEpisodes !==
      row.episodes.filter((episode) => episode.kind === 'completed_paid').length ||
    JSON.stringify(reconcile(events)) !== JSON.stringify(row.episodes)
  )
    throw Error('pyusd_history_ledger_invalid')
  return row
}

export async function readLedger(root = ROOT) {
  let names
  try {
    if (!(await lstat(root)).isDirectory()) throw Error('pyusd_history_root_invalid')
    names = await readdir(root)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  if (names.some((name) => !/^\d{8}\.json$/.test(name))) throw Error('pyusd_history_stray_file')
  const rows = []
  for (const name of names.sort()) {
    if (name !== `${String(rows.length + 1).padStart(8, '0')}.json`)
      throw Error('pyusd_history_gap')
    const fd = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const st = await fd.stat()
      if (!st.isFile() || st.size < 1 || st.size > 200_000) throw Error('pyusd_history_file_size')
      bytes = await fd.readFile()
      if ((await fd.stat()).size !== st.size) throw Error('pyusd_history_file_changed')
    } finally {
      await fd.close()
    }
    const row = JSON.parse(bytes.toString('utf8'))
    if (bytes.toString('utf8') !== `${JSON.stringify(row)}\n`)
      throw Error('pyusd_history_ledger_invalid')
    validateHistoryRow(row, rows.length + 1, rows.at(-1)?.sha256 ?? null)
    rows.push(row)
  }
  return rows
}

export async function appendHistory(snapshot, root = ROOT) {
  await mkdir(root, { recursive: true })
  if (!(await lstat(root)).isDirectory()) throw Error('pyusd_history_root_invalid')
  const rows = await readLedger(root)
  const body = {
    ...snapshot,
    sequence: rows.length + 1,
    previousSha256: rows.at(-1)?.sha256 ?? null,
  }
  const row = { ...body, sha256: sha(JSON.stringify(body)) }
  validateHistoryRow(row, rows.length + 1, rows.at(-1)?.sha256 ?? null)
  const data = `${JSON.stringify(row)}\n`
  if (Buffer.byteLength(data) > 200_000) throw Error('pyusd_history_file_size')
  const fs = statfsSync(root)
  if (Number(fs.bavail) * Number(fs.bsize) < 1_073_741_824 + Buffer.byteLength(data))
    throw Error('pyusd_history_disk_reserve')
  const temp = join(root, `.pyusd-history-${randomUUID()}.tmp`)
  try {
    const fd = await open(temp, 'wx', 0o600)
    try {
      await fd.writeFile(data)
      await fd.sync()
    } finally {
      await fd.close()
    }
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
  return row
}

export async function collectAndAppendHistory(
  origins,
  blocks = 5000,
  fullWindow = false,
  root = ROOT,
) {
  return appendHistory(await collectHistory(origins, blocks, fullWindow), root)
}

async function main() {
  if (process.argv[2] === '--verify') {
    const rows = await readLedger()
    console.log(
      JSON.stringify({
        study: STUDY,
        snapshots: rows.length,
        tipSha256: rows.at(-1)?.sha256 ?? null,
        offlineReceiptReplay: false,
      }),
    )
    return
  }
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--attest-window'))
    throw Error('usage: node pyusd-staking-redemption-history.mjs [--attest-window] | --verify')
  const fullWindow = process.argv[2] === '--attest-window'
  const urls = configuredPublicRpcUrls(readEnv())
  let lastError
  for (let i = 0; i < urls.length; i++)
    for (let j = i + 1; j < urls.length; j++) {
      try {
        const origins = publicRpcClients([urls[i], urls[j]])
        const row = await collectAndAppendHistory(origins, 5000, fullWindow)
        console.log(
          JSON.stringify({
            study: STUDY,
            sequence: row.sequence,
            range: row.range,
            foundEvents: row.foundEvents,
            paidMatchedEpisodes: row.paidMatchedEpisodes,
            completeness: row.discoveryCompleteness,
            sha256: row.sha256,
          }),
        )
        return
      } catch (error) {
        lastError = error
        console.error(
          `pair ${new URL(urls[i]).hostname}/${new URL(urls[j]).hostname}: ${error.message}`,
        )
      }
    }
  throw lastError ?? Error('pyusd_history_origins_unavailable')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
