// Frozen, PRE-OUTCOME cUSDS holder feasibility. Never reads B state or withdraw calls;
// later log scans are gated on the earlier as-of-B−1 holder cohort being frozen.
// node scripts/research/cusds-holder-feasibility-first5.mjs --plan
// node scripts/research/cusds-holder-feasibility-first5.mjs --run --max-new-chunks 1 --max-candidates 0
// node scripts/research/cusds-holder-feasibility-first5.mjs --verify offline
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, parseAbi, toEventSelector, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { MARKETS } from './compound-comet-usds-weekly-screen.mjs'

export const STUDY = 'cusds-holder-feasibility-first5-preoutcome-v2'
export const COMET = MARKETS[0].comet.toLowerCase()
export const BASE = MARKETS[0].base.toLowerCase()
export const CREATION_BLOCK = 20_987_551
export const ONSETS = Object.freeze([23_253_206, 23_285_606, 23_328_806, 23_490_806, 23_553_806])
export const Q = 1_000_000n * 10n ** 18n
export const MAX_CHUNK_BLOCKS = 2_000
export const MAX_LOGS = 100_000
export const MAX_ADDRESSES = 20_000
export const DISK_FLOOR_BYTES = 2.5 * 1024 ** 3
export const TOPICS = Object.freeze([
  toEventSelector('Transfer(address,address,uint256)'),
  toEventSelector('Supply(address,address,uint256)'),
])
const ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const ZERO = `0x${'0'.repeat(40)}`
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const DEFAULT_OUT = resolve('data/research/venue-signals/cusds-holder-feasibility-first5-v2.json')

export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const number = (x) => {
  const n = Number(BigInt(x))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe RPC integer')
  return n
}
const lower = (x) => x?.toLowerCase()
const validAddress = (x) => ADDRESS.test(x)
const validHash = (x) => HASH.test(x)
const topicAddress = (x) => {
  if (!WORD.test(x) || !/^0x0{24}/.test(x)) throw new Error('Malformed address topic')
  return `0x${x.slice(26)}`
}

export function decodeCandidateLog(log, fromBlock, toBlock) {
  const kind = TOPICS.findIndex((topic) => lower(topic) === lower(log.topics?.[0]))
  if (
    lower(log.address) !== COMET ||
    kind < 0 ||
    log.topics?.length !== 3 ||
    !WORD.test(log.data) ||
    log.removed === true ||
    !validHash(log.blockHash) ||
    !validHash(log.transactionHash)
  )
    throw new Error('Malformed Comet candidate log')
  const block = number(log.blockNumber),
    index = number(log.logIndex)
  if (block < fromBlock || block > toBlock || index < 0)
    throw new Error('Out-of-range Comet candidate log')
  return {
    kind: kind === 0 ? 'Transfer' : 'Supply',
    block,
    blockHash: lower(log.blockHash),
    txHash: lower(log.transactionHash),
    index,
    from: topicAddress(lower(log.topics[1])),
    to: topicAddress(lower(log.topics[2])),
    amount: BigInt(log.data).toString(),
  }
}

export function discoverCandidates(logs, throughBlock = ONSETS.at(-1) - 1) {
  const set = new Set()
  for (const log of logs) {
    if (log.block > throughBlock) continue
    if (
      !['Transfer', 'Supply'].includes(log.kind) ||
      !validAddress(log.from) ||
      !validAddress(log.to) ||
      !/^\d+$/.test(log.amount)
    )
      throw new Error('Invalid stored candidate log')
    if (log.from !== ZERO) set.add(log.from)
    if (log.to !== ZERO) set.add(log.to)
  }
  return [...set].sort()
}

function identity() {
  return {
    study: STUDY,
    chainId: 1,
    comet: COMET,
    base: BASE,
    creationBlock: CREATION_BLOCK,
    onsets: [...ONSETS],
    qRaw: Q.toString(),
  }
}
function initial() {
  return {
    ...identity(),
    status: 'partial',
    nextBlock: CREATION_BLOCK,
    chunks: [],
    probes: Object.fromEntries(
      ONSETS.map((b) => [b, { block: b - 1, blockHash: null, reads: [] }]),
    ),
  }
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, path)
}
function seal(payload) {
  return { payload, sha256: digest(payload) }
}
export function validateCheckpoint(envelope) {
  if (!envelope || digest(envelope.payload) !== envelope.sha256)
    throw new Error('Checkpoint SHA mismatch')
  const saved = envelope.payload
  for (const [k, v] of Object.entries(identity()))
    if (JSON.stringify(saved[k]) !== JSON.stringify(v))
      throw new Error(`Checkpoint identity mismatch: ${k}`)
  if (
    !Number.isSafeInteger(saved.nextBlock) ||
    saved.nextBlock < CREATION_BLOCK ||
    saved.nextBlock > ONSETS.at(-1) ||
    !Array.isArray(saved.chunks)
  )
    throw new Error('Checkpoint frontier invalid')
  let frontier = CREATION_BLOCK,
    logCount = 0
  const seen = new Set(),
    logs = []
  for (const chunk of saved.chunks) {
    if (
      chunk.from !== frontier ||
      !Number.isSafeInteger(chunk.to) ||
      chunk.to < chunk.from ||
      chunk.to - chunk.from + 1 > MAX_CHUNK_BLOCKS ||
      !validHash(chunk.fromHash) ||
      !validHash(chunk.toHash) ||
      !Array.isArray(chunk.logs) ||
      digest(chunk.logs) !== chunk.logsSha256
    )
      throw new Error('Checkpoint chunk coverage/hash invalid')
    let previous = [-1, -1]
    for (const log of chunk.logs) {
      if (
        log.block < chunk.from ||
        log.block > chunk.to ||
        !validHash(log.blockHash) ||
        !validHash(log.txHash) ||
        !Number.isSafeInteger(log.index) ||
        log.index < 0 ||
        !['Transfer', 'Supply'].includes(log.kind) ||
        !validAddress(log.from) ||
        !validAddress(log.to) ||
        !/^\d+$/.test(log.amount)
      )
        throw new Error('Invalid stored log')
      if (log.block < previous[0] || (log.block === previous[0] && log.index <= previous[1]))
        throw new Error('Unordered stored log')
      if (
        (log.block === chunk.from && log.blockHash !== chunk.fromHash) ||
        (log.block === chunk.to && log.blockHash !== chunk.toHash)
      )
        throw new Error('Log disagrees with pinned chunk boundary')
      previous = [log.block, log.index]
      const id = `${log.blockHash}:${log.txHash}:${log.index}`
      if (seen.has(id)) throw new Error('Duplicate stored log identity')
      seen.add(id)
      logs.push(log)
    }
    logCount += chunk.logs.length
    frontier = chunk.to + 1
  }
  if (
    frontier !== saved.nextBlock ||
    logCount > MAX_LOGS ||
    discoverCandidates(logs).length > MAX_ADDRESSES
  )
    throw new Error('Checkpoint frontier or resource limit invalid')
  if (!saved.probes || Object.keys(saved.probes).length !== ONSETS.length)
    throw new Error('Checkpoint probes missing')
  for (const onset of ONSETS) {
    const probe = saved.probes[onset]
    if (
      probe?.block !== onset - 1 ||
      !Array.isArray(probe.reads) ||
      (probe.blockHash !== null && !validHash(probe.blockHash))
    )
      throw new Error('Checkpoint probe invalid')
    const eligible = new Set(discoverCandidates(logs, onset - 1))
    const readSet = new Set()
    for (const read of probe.reads) {
      if (
        !eligible.has(read.address) ||
        readSet.has(read.address) ||
        !['ok', 'error'].includes(read.status)
      )
        throw new Error('Checkpoint read invalid')
      readSet.add(read.address)
      if (read.status === 'ok' && (!/^\d+$/.test(read.balanceRaw) || typeof read.eoa !== 'boolean'))
        throw new Error('Checkpoint balance invalid')
      if (
        !Number.isSafeInteger(read.attempts) ||
        read.attempts < 1 ||
        (read.status === 'error' && typeof read.error !== 'string') ||
        (read.lastError !== undefined && typeof read.lastError !== 'string')
      )
        throw new Error('Checkpoint read failure invalid')
    }
    if (probe.blockHash && saved.nextBlock <= onset - 1)
      throw new Error('Probe ran before log coverage')
  }
  if (!['partial', 'complete'].includes(saved.status)) throw new Error('Checkpoint status invalid')
  const fullyResolved =
    saved.nextBlock === ONSETS.at(-1) &&
    summarize(saved).every((row) => ['holder', 'no-qualifying-eoa'].includes(row.status))
  if (saved.status === 'complete' && !fullyResolved)
    throw new Error('Checkpoint claims complete with pending/failed rows')
  return saved
}
export function loadCheckpoint(path) {
  return existsSync(path) ? validateCheckpoint(JSON.parse(readFileSync(path, 'utf8'))) : initial()
}
function save(path, saved) {
  atomic(path, seal(saved))
}
function diskOk(path) {
  const dir = existsSync(dirname(path)) ? dirname(path) : resolve('.')
  const stat = statfsSync(dir)
  if (stat.bavail * stat.bsize < DISK_FLOOR_BYTES)
    throw new Error('Disk floor <2.5 GiB; stopped safely')
}
function requireBudget(name, x) {
  if (!Number.isSafeInteger(x) || x < 0) throw new Error(`${name} must be a nonnegative integer`)
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
export function selectHolder(reads) {
  const eligible = reads
    .filter((r) => r.status === 'ok' && r.eoa && BigInt(r.balanceRaw) >= Q)
    .sort((a, b) => {
      const d = BigInt(a.balanceRaw) - BigInt(b.balanceRaw)
      return d === 0n ? a.address.localeCompare(b.address) : d > 0n ? -1 : 1
    })
  return eligible[0] || null
}
export function summarize(saved) {
  const logs = saved.chunks.flatMap((c) => c.logs)
  return ONSETS.map((onset) => {
    const p = saved.probes[onset],
      candidates = discoverCandidates(logs, onset - 1)
    const completeLogs = saved.nextBlock > onset - 1
    const completeReads = completeLogs && p.blockHash && p.reads.length === candidates.length
    return {
      onset,
      preBlock: onset - 1,
      status: !completeLogs
        ? 'logs-pending'
        : !completeReads
          ? 'reads-pending'
          : p.reads.some((x) => x.status === 'error')
            ? 'read-failure'
            : selectHolder(p.reads)
              ? 'holder'
              : 'no-qualifying-eoa',
      candidateCount: candidates.length,
      readCount: p.reads.length,
      eoaCount: p.reads.filter((x) => x.status === 'ok' && x.eoa).length,
      qualifiedCount: p.reads.filter((x) => x.status === 'ok' && x.eoa && BigInt(x.balanceRaw) >= Q)
        .length,
      readFailures: p.reads.filter((x) => x.status === 'error').length,
      holder:
        completeReads && !p.reads.some((x) => x.status === 'error') ? selectHolder(p.reads) : null,
    }
  })
}
export async function run({
  out = DEFAULT_OUT,
  client,
  maxNewChunks = 0,
  maxCandidates = 0,
  chunkBlocks = MAX_CHUNK_BLOCKS,
  checkDisk = diskOk,
} = {}) {
  if (!out.startsWith('/')) throw new Error('Output path must be absolute')
  requireBudget('max-new-chunks', maxNewChunks)
  requireBudget('max-candidates', maxCandidates)
  if (!Number.isSafeInteger(chunkBlocks) || chunkBlocks < 1 || chunkBlocks > MAX_CHUNK_BLOCKS)
    throw new Error('chunkBlocks must be 1..2000')
  let saved = loadCheckpoint(out)
  if ((maxNewChunks || maxCandidates) && !client) throw new Error('RPC client required')
  if (maxNewChunks || maxCandidates) {
    const chainId = await retry(() => client.request({ method: 'eth_chainId', params: [] }))
    if (number(chainId) !== 1) throw new Error('RPC chainId is not Ethereum mainnet')
  }
  for (let n = 0; n < maxNewChunks && saved.nextBlock < ONSETS.at(-1); n++) {
    const rows = summarize(saved)
    const firstUnresolved = rows.find(
      (row) => !['holder', 'no-qualifying-eoa'].includes(row.status),
    )
    if (!firstUnresolved || saved.nextBlock > firstUnresolved.preBlock) break
    checkDisk(out)
    const from = saved.nextBlock,
      to = Math.min(from + chunkBlocks - 1, firstUnresolved.preBlock)
    const rpcLogs = await retry(() =>
      client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: COMET,
            fromBlock: toHex(from),
            toBlock: toHex(to),
            topics: [TOPICS],
          },
        ],
      }),
    )
    const additions = rpcLogs
      .map((x) => decodeCandidateLog(x, from, to))
      .sort((a, b) => a.block - b.block || a.index - b.index)
    const [fromHeader, toHeader] = await Promise.all([
      retry(() => client.getBlock({ blockNumber: BigInt(from) })),
      from === to
        ? retry(() => client.getBlock({ blockNumber: BigInt(from) }))
        : retry(() => client.getBlock({ blockNumber: BigInt(to) })),
    ])
    if (
      number(fromHeader.number) !== from ||
      number(toHeader.number) !== to ||
      !validHash(fromHeader.hash) ||
      !validHash(toHeader.hash)
    )
      throw new Error('Log-chunk boundary block identity mismatch')
    const all = saved.chunks.flatMap((c) => c.logs).concat(additions)
    if (all.length > MAX_LOGS || discoverCandidates(all).length > MAX_ADDRESSES)
      throw new Error('Log/candidate guard exceeded; stopped without sampling')
    const next = {
      ...saved,
      nextBlock: to + 1,
      chunks: saved.chunks.concat({
        from,
        to,
        fromHash: lower(fromHeader.hash),
        toHash: lower(toHeader.hash),
        logs: additions,
        logsSha256: digest(additions),
      }),
    }
    validateCheckpoint(seal(next))
    checkDisk(out)
    save(out, next)
    saved = next
  }
  let remaining = maxCandidates
  for (const onset of ONSETS) {
    if (!remaining || saved.nextBlock <= onset - 1) continue
    const logs = saved.chunks.flatMap((c) => c.logs)
    const candidates = discoverCandidates(logs, onset - 1)
    const p = saved.probes[onset]
    if (!p.blockHash) {
      const block = await retry(() => client.getBlock({ blockNumber: BigInt(onset - 1) }))
      if (number(block.number) !== onset - 1 || !validHash(block.hash))
        throw new Error('Pre-block identity mismatch')
      p.blockHash = lower(block.hash)
      checkDisk(out)
      save(out, saved)
    }
    const done = new Set(p.reads.filter((x) => x.status === 'ok').map((x) => x.address))
    let unsaved = 0
    for (const address of candidates) {
      if (!remaining) break
      if (done.has(address)) continue
      checkDisk(out)
      let read
      const priorIndex = p.reads.findIndex((x) => x.address === address)
      const prior = priorIndex < 0 ? null : p.reads[priorIndex]
      const pinnedBlock = { blockHash: p.blockHash, requireCanonical: true }
      try {
        const [hex, code] = await Promise.all([
          retry(() =>
            client.request({
              method: 'eth_call',
              params: [
                {
                  to: COMET,
                  data: encodeFunctionData({
                    abi: ABI,
                    functionName: 'balanceOf',
                    args: [address],
                  }),
                },
                pinnedBlock,
              ],
            }),
          ),
          retry(() => client.request({ method: 'eth_getCode', params: [address, pinnedBlock] })),
        ])
        const balance = decodeFunctionResult({ abi: ABI, functionName: 'balanceOf', data: hex })
        if (typeof code !== 'string' || !/^0x[0-9a-f]*$/i.test(code))
          throw new Error('Invalid code response')
        read = {
          address,
          status: 'ok',
          balanceRaw: balance.toString(),
          eoa: code === '0x',
          attempts: (prior?.attempts || 0) + 1,
          ...(prior?.error || prior?.lastError
            ? { lastError: prior.error || prior.lastError }
            : {}),
        }
      } catch (error) {
        read = {
          address,
          status: 'error',
          error: String(error?.message || error).slice(0, 300),
          attempts: (prior?.attempts || 0) + 1,
        }
      }
      if (priorIndex < 0) p.reads.push(read)
      else p.reads[priorIndex] = read
      remaining--
      unsaved++
      if (unsaved >= 50) {
        checkDisk(out)
        save(out, saved)
        unsaved = 0
      }
    }
    if (unsaved) {
      checkDisk(out)
      save(out, saved)
    }
  }
  const rows = summarize(saved)
  saved.status =
    saved.nextBlock === ONSETS.at(-1) &&
    rows.every((r) => ['holder', 'no-qualifying-eoa'].includes(r.status))
      ? 'complete'
      : 'partial'
  if (existsSync(out) || maxNewChunks || maxCandidates) {
    checkDisk(out)
    save(out, saved)
  }
  return {
    path: out,
    status: saved.status,
    nextBlock: saved.nextBlock,
    chunkCount: saved.chunks.length,
    logCount: saved.chunks.reduce((s, c) => s + c.logs.length, 0),
    rows,
  }
}

function options(argv) {
  const mode = argv[0]
  if (!['--plan', '--run', '--verify'].includes(mode))
    throw new Error('Expected --plan, --run, or --verify offline')
  const opts = {}
  if (mode === '--verify' && argv[1] !== 'offline') throw new Error('Use --verify offline')
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
        nextBlock: saved.nextBlock,
        remainingBlocks: ONSETS.at(-1) - saved.nextBlock,
        rows: summarize(saved),
      }),
    )
  } else if (mode === '--verify') {
    if (!existsSync(out)) throw new Error('No checkpoint to verify')
    const saved = loadCheckpoint(out)
    console.log(JSON.stringify({ valid: true, sha256: digest(saved), rows: summarize(saved) }))
  } else {
    const maxNewChunks = Number(opts['max-new-chunks'] ?? 0)
    const maxCandidates = Number(opts['max-candidates'] ?? 0)
    const client =
      maxNewChunks || maxCandidates
        ? makeClient(opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
        : null
    console.log(JSON.stringify(await run({ out, client, maxNewChunks, maxCandidates })))
  }
}
