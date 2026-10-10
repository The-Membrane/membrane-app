// Exploratory, post-result localization only. A grid onset is not an advance warning.
// node scripts/research/cusds-threshold-crossings-first5.mjs --plan
// node scripts/research/cusds-threshold-crossings-first5.mjs --run --max-new-intervals 1 --max-reads 1000
// node scripts/research/cusds-threshold-crossings-first5.mjs --verify offline
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, parseAbi, toEventSelector, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { BASE, COMET, ONSETS, Q } from './cusds-holder-feasibility-first5.mjs'

export const STUDY = 'cusds-threshold-crossings-first5-exploratory-v1'
export const INTERVAL = 1_800
export const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
export const MAX_LOGS_PER_INTERVAL = 20_000
export const MAX_READS_PER_INTERVAL = INTERVAL + 1
export const SAVE_EVERY_READS = 50
export const DISK_FLOOR_BYTES = 2.5 * 1024 ** 3
const ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const HASH = /^0x[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const DEFAULT_OUT = resolve('data/research/venue-signals/cusds-threshold-crossings-first5.json')
const topicAddress = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const lower = (value) => value?.toLowerCase()
const safeNumber = (value) => {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe RPC number')
  return n
}
const intervals = () => ONSETS.map((b) => ({ from: b - INTERVAL, to: b }))
const identity = () => ({
  study: STUDY,
  chainId: 1,
  comet: COMET,
  base: BASE,
  onsets: [...ONSETS],
  intervalBlocks: INTERVAL,
  qRaw: Q.toString(),
})
const initial = () => ({
  ...identity(),
  intervals: intervals().map(({ from, to }) => ({
    from,
    to,
    logs: null,
    logsSha256: null,
    reads: [],
  })),
})
const seal = (payload) => ({ payload, sha256: digest(payload) })
function atomic(path, payload) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(seal(payload)), { mode: 0o600 })
  renameSync(temp, path)
}
function diskOk(path) {
  const dir = existsSync(dirname(path)) ? dirname(path) : resolve('.')
  const fs = statfsSync(dir)
  if (fs.bavail * fs.bsize < DISK_FLOOR_BYTES) throw new Error('Disk floor <2.5 GiB')
}
const count = (name, n) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be nonnegative integer`)
}
async function retry(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i === 2) throw error
      await new Promise((r) => setTimeout(r, 500 * 2 ** i))
    }
  }
}

export function decodeTransfer(log, from, to) {
  if (
    lower(log.address) !== BASE ||
    lower(log.topics?.[0]) !== lower(TRANSFER) ||
    log.topics?.length !== 3 ||
    !WORD.test(lower(log.topics[1])) ||
    !WORD.test(lower(log.topics[2])) ||
    !WORD.test(lower(log.data)) ||
    !/^0x0{24}/.test(lower(log.topics[1])) ||
    !/^0x0{24}/.test(lower(log.topics[2])) ||
    !HASH.test(lower(log.blockHash)) ||
    !HASH.test(lower(log.transactionHash)) ||
    log.removed === true
  )
    throw new Error('Malformed USDS Transfer log')
  const block = safeNumber(log.blockNumber),
    index = safeNumber(log.logIndex)
  if (block <= from || block > to || index < 0) throw new Error('Out-of-interval Transfer log')
  const sender = `0x${lower(log.topics[1]).slice(26)}`
  const recipient = `0x${lower(log.topics[2]).slice(26)}`
  if (sender !== COMET && recipient !== COMET) throw new Error('Unrelated Transfer log')
  return {
    block,
    blockHash: lower(log.blockHash),
    txHash: lower(log.transactionHash),
    index,
    from: sender,
    to: recipient,
    amount: BigInt(log.data).toString(),
  }
}

export function mergeTransfers(outgoing, incoming, from, to) {
  const merged = new Map()
  for (const [side, collection] of [
    ['out', outgoing],
    ['in', incoming],
  ]) {
    for (const raw of collection) {
      const log = decodeTransfer(raw, from, to)
      if ((side === 'out' && log.from !== COMET) || (side === 'in' && log.to !== COMET))
        throw new Error('RPC topic filter returned unrelated side')
      const key = `${log.blockHash}:${log.txHash}:${log.index}`
      if (merged.has(key) && JSON.stringify(merged.get(key)) !== JSON.stringify(log))
        throw new Error('Conflicting duplicate Transfer identity')
      merged.set(key, log) // A self-transfer appears in both queries; it has zero cash delta.
      if (merged.size > MAX_LOGS_PER_INTERVAL) throw new Error('Transfer log cap exceeded')
    }
  }
  const logs = [...merged.values()].sort((a, b) => a.block - b.block || a.index - b.index)
  for (let i = 1; i < logs.length; i++) {
    if (logs[i].block === logs[i - 1].block && logs[i].index === logs[i - 1].index)
      throw new Error('Conflicting log index in a block')
  }
  return logs
}

function requiredBlocks(row) {
  return Array.from({ length: row.to - row.from + 1 }, (_, index) => row.from + index)
}
async function recheckSavedCanonical(row, client) {
  const expected = new Map()
  for (const read of [row.reads[0], row.reads.at(-1)])
    if (read) expected.set(read.block, read.blockHash)
  for (const log of row.logs || []) {
    const prior = expected.get(log.block)
    if (prior && prior !== log.blockHash) throw new Error('Saved log/read hash conflict')
    expected.set(log.block, log.blockHash)
  }
  for (const [number, hash] of expected) {
    const header = await retry(() => client.getBlock({ blockNumber: BigInt(number) }))
    if (safeNumber(header.number) !== number || lower(header.hash) !== hash)
      throw new Error('Saved hash no longer canonical')
  }
}
export function validateCheckpoint(envelope) {
  if (!envelope || digest(envelope.payload) !== envelope.sha256)
    throw new Error('Checkpoint SHA mismatch')
  const saved = envelope.payload
  for (const [key, value] of Object.entries(identity()))
    if (JSON.stringify(saved[key]) !== JSON.stringify(value))
      throw new Error(`Checkpoint identity mismatch: ${key}`)
  const expected = intervals()
  if (!Array.isArray(saved.intervals) || saved.intervals.length !== expected.length)
    throw new Error('Checkpoint interval count invalid')
  for (let i = 0; i < expected.length; i++) {
    const row = saved.intervals[i]
    if (row.from !== expected[i].from || row.to !== expected[i].to || !Array.isArray(row.reads))
      throw new Error('Checkpoint interval identity invalid')
    if (row.logs === null) {
      if (row.logsSha256 !== null || row.reads.length)
        throw new Error('Unfetched interval has reads')
      continue
    }
    if (
      !Array.isArray(row.logs) ||
      row.logs.length > MAX_LOGS_PER_INTERVAL ||
      digest(row.logs) !== row.logsSha256 ||
      row.reads.length > MAX_READS_PER_INTERVAL
    )
      throw new Error('Checkpoint logs invalid')
    const seen = new Set()
    const logHashByBlock = new Map()
    let prior = [-1, -1]
    for (const log of row.logs) {
      if (
        !Number.isSafeInteger(log.block) ||
        log.block <= row.from ||
        log.block > row.to ||
        !Number.isSafeInteger(log.index) ||
        log.index < 0 ||
        !HASH.test(log.blockHash) ||
        !HASH.test(log.txHash) ||
        !ADDRESS.test(log.from) ||
        !ADDRESS.test(log.to) ||
        (log.from !== COMET && log.to !== COMET) ||
        !/^\d+$/.test(log.amount) ||
        log.block < prior[0] ||
        (log.block === prior[0] && log.index <= prior[1])
      )
        throw new Error('Invalid stored Transfer')
      const id = `${log.blockHash}:${log.txHash}:${log.index}`
      if (seen.has(id)) throw new Error('Duplicate stored Transfer')
      if (logHashByBlock.has(log.block) && logHashByBlock.get(log.block) !== log.blockHash)
        throw new Error('Conflicting stored block hashes')
      seen.add(id)
      logHashByBlock.set(log.block, log.blockHash)
      prior = [log.block, log.index]
    }
    const blocks = requiredBlocks(row)
    if (row.reads.length > blocks.length) throw new Error('Too many balance reads')
    row.reads.forEach((read, index) => {
      if (read.block !== blocks[index] || !HASH.test(read.blockHash) || !/^\d+$/.test(read.cashRaw))
        throw new Error('Invalid balance read')
      if (logHashByBlock.has(read.block) && logHashByBlock.get(read.block) !== read.blockHash)
        throw new Error('Transfer disagrees with pinned block hash')
    })
  }
  return saved
}
export function loadCheckpoint(path) {
  return existsSync(path) ? validateCheckpoint(JSON.parse(readFileSync(path, 'utf8'))) : initial()
}

export function evaluate(row) {
  if (row.logs === null) return { status: 'logs-pending' }
  const blocks = requiredBlocks(row)
  if (row.reads.length !== blocks.length)
    return { status: 'reads-pending', reads: row.reads.length, requiredReads: blocks.length }
  let firstCrossing = null
  const mismatches = []
  const netByBlock = new Map()
  for (const log of row.logs) {
    const delta =
      log.from === COMET && log.to === COMET
        ? 0n
        : log.to === COMET
          ? BigInt(log.amount)
          : -BigInt(log.amount)
    netByBlock.set(log.block, (netByBlock.get(log.block) || 0n) + delta)
  }
  for (let i = 1; i < row.reads.length; i++) {
    const previous = row.reads[i - 1],
      current = row.reads[i]
    const net = netByBlock.get(current.block) || 0n
    const actual = BigInt(current.cashRaw) - BigInt(previous.cashRaw)
    if (net !== actual)
      mismatches.push({
        from: previous.block,
        to: current.block,
        netRaw: net.toString(),
        actualRaw: actual.toString(),
      })
    if (firstCrossing === null && BigInt(previous.cashRaw) >= Q && BigInt(current.cashRaw) < Q)
      firstCrossing = current.block
  }
  const startRaw = row.reads[0].cashRaw,
    endRaw = row.reads.at(-1).cashRaw
  if (mismatches.length)
    return {
      status: 'not-localized',
      reason: 'transfer-cash-mismatch',
      startRaw,
      endRaw,
      mismatches,
    }
  return {
    status: firstCrossing === null ? 'no-crossing' : 'localized',
    firstCrossingBlock: firstCrossing,
    startRaw,
    endRaw,
    transferCount: row.logs.length,
    ...(firstCrossing === null && BigInt(startRaw) < Q
      ? { reason: 'already-below-at-anchor' }
      : {}),
    // Intentionally no lead-time or predictive interpretation.
  }
}

export async function run({
  out = DEFAULT_OUT,
  client,
  maxNewIntervals = 0,
  maxReads = 0,
  checkDisk = diskOk,
} = {}) {
  if (!out.startsWith('/')) throw new Error('Output path must be absolute')
  count('max-new-intervals', maxNewIntervals)
  count('max-reads', maxReads)
  const saved = loadCheckpoint(out)
  if (maxNewIntervals || maxReads) {
    if (!client) throw new Error('RPC client required')
    if (safeNumber(await retry(() => client.request({ method: 'eth_chainId', params: [] }))) !== 1)
      throw new Error('RPC is not Ethereum mainnet')
  }
  let intervalsLeft = maxNewIntervals,
    readsLeft = maxReads
  for (const row of saved.intervals) {
    if (row.logs === null && intervalsLeft) {
      checkDisk(out)
      const common = { address: BASE, fromBlock: toHex(row.from + 1), toBlock: toHex(row.to) }
      const [outgoing, incoming] = await Promise.all([
        retry(() =>
          client.request({
            method: 'eth_getLogs',
            params: [{ ...common, topics: [TRANSFER, topicAddress(COMET)] }],
          }),
        ),
        retry(() =>
          client.request({
            method: 'eth_getLogs',
            params: [{ ...common, topics: [TRANSFER, null, topicAddress(COMET)] }],
          }),
        ),
      ])
      row.logs = mergeTransfers(outgoing, incoming, row.from, row.to)
      row.logsSha256 = digest(row.logs)
      intervalsLeft--
      checkDisk(out)
      atomic(out, saved)
    }
    if (row.logs !== null && readsLeft) {
      // Local SHA proves integrity of our cache, not archive-provider exhaustiveness.
      // Recheck boundary and log-bearing hashes before extending a partial interval.
      await recheckSavedCanonical(row, client)
      const blocks = requiredBlocks(row)
      let unsaved = 0
      try {
        while (row.reads.length < blocks.length && readsLeft) {
          checkDisk(out)
          const number = blocks[row.reads.length]
          const header = await retry(() => client.getBlock({ blockNumber: BigInt(number) }))
          if (safeNumber(header.number) !== number || !HASH.test(lower(header.hash)))
            throw new Error('Canonical block header mismatch')
          const blockHash = lower(header.hash)
          for (const log of row.logs)
            if (log.block === number && log.blockHash !== blockHash)
              throw new Error('Transfer block hash differs from canonical header')
          const hex = await retry(() =>
            client.request({
              method: 'eth_call',
              params: [
                {
                  to: BASE,
                  data: encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [COMET] }),
                },
                { blockHash, requireCanonical: true },
              ],
            }),
          )
          const cashRaw = decodeFunctionResult({ abi: ABI, functionName: 'balanceOf', data: hex })
          row.reads.push({ block: number, blockHash, cashRaw: cashRaw.toString() })
          readsLeft--
          unsaved++
          if (unsaved >= SAVE_EVERY_READS) {
            checkDisk(out)
            atomic(out, saved)
            unsaved = 0
          }
        }
      } finally {
        if (unsaved) {
          checkDisk(out)
          atomic(out, saved)
        }
      }
    }
  }
  validateCheckpoint(seal(saved))
  return {
    path: out,
    rows: saved.intervals.map((row) => ({ from: row.from, to: row.to, ...evaluate(row) })),
  }
}

function options(argv) {
  const mode = argv[0] ?? '--plan'
  if (!['--plan', '--run', '--verify'].includes(mode))
    throw new Error('Expected --plan, --run, or --verify offline')
  if (mode === '--verify' && argv[1] !== 'offline') throw new Error('Use --verify offline')
  const opts = {}
  for (let i = mode === '--verify' ? 2 : 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error('Bad CLI options')
    opts[argv[i].slice(2)] = argv[i + 1]
  }
  return { mode, opts }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mode, opts } = options(process.argv.slice(2))
  const out = opts.out ? resolve(opts.out) : DEFAULT_OUT
  if (mode === '--plan') {
    const saved = loadCheckpoint(out)
    console.log(
      JSON.stringify({
        ...identity(),
        path: out,
        rows: saved.intervals.map((row) => ({ from: row.from, to: row.to, ...evaluate(row) })),
      }),
    )
  } else if (mode === '--verify') {
    if (!existsSync(out)) throw new Error('No checkpoint to verify')
    const saved = loadCheckpoint(out)
    console.log(
      JSON.stringify({
        valid: true,
        sha256: digest(saved),
        rows: saved.intervals.map((row) => ({ from: row.from, to: row.to, ...evaluate(row) })),
      }),
    )
  } else {
    const maxNewIntervals = Number(opts['max-new-intervals'] ?? 0)
    const maxReads = Number(opts['max-reads'] ?? 0)
    const client =
      maxNewIntervals || maxReads
        ? makeClient(opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
        : null
    console.log(JSON.stringify(await run({ out, client, maxNewIntervals, maxReads })))
  }
}
