// Pre-outcome cUSDS holder selection at A=B-1,800. This module has no B read or
// withdrawal path. Freeze and offline-verify its checkpoint before any replay.
// node scripts/research/cusds-asof-holder-first5.mjs --plan
// node scripts/research/cusds-asof-holder-first5.mjs --run --max-candidates 25
// node scripts/research/cusds-asof-holder-first5.mjs --verify offline
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  BASE,
  COMET,
  DISK_FLOOR_BYTES,
  MAX_ADDRESSES,
  MAX_LOGS,
  ONSETS,
  Q,
  digest,
  discoverCandidates,
  selectHolder,
  validateCheckpoint,
} from './cusds-holder-feasibility-first5.mjs'

export const STUDY = 'cusds-asof-holder-first5-preoutcome-v1'
export const SOURCE_SHA256 = 'adb34fc7d9f63bf68a1e06151d77ba2e4678378041a6678f9f327eeca18585f1'
export const DEFAULT_SOURCE = resolve(
  'data/research/venue-signals/cusds-holder-feasibility-first5-v2.json',
)
export const DEFAULT_OUT = resolve('data/research/venue-signals/cusds-asof-holder-first5-v1.json')
export const LEAD_BLOCKS = 1_800
const ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const RAW = /^\d+$/
const shaBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function freezeSource(path = DEFAULT_SOURCE) {
  const bytes = readFileSync(path)
  if (shaBytes(bytes) !== SOURCE_SHA256) throw new Error('Source file SHA mismatch')
  const source = validateCheckpoint(JSON.parse(bytes.toString('utf8')))
  if (source.status !== 'complete') throw new Error('Source log checkpoint incomplete')
  const logs = source.chunks.flatMap((chunk) => chunk.logs)
  if (logs.length > MAX_LOGS || discoverCandidates(logs).length > MAX_ADDRESSES)
    throw new Error('Source log/address guard exceeded')
  const rows = ONSETS.map((onset) => {
    const asofBlock = onset - LEAD_BLOCKS
    if (source.nextBlock <= asofBlock) throw new Error('Source lacks complete as-of logs')
    const candidates = discoverCandidates(logs, asofBlock)
    if (candidates.length > MAX_ADDRESSES) throw new Error('As-of address guard exceeded')
    return { onset, asofBlock, candidates }
  })
  return { fileSha256: SOURCE_SHA256, payloadSha256: digest(source), logCount: logs.length, rows }
}

function identity(source) {
  return {
    study: STUDY,
    chainId: 1,
    comet: COMET,
    base: BASE,
    qRaw: Q.toString(),
    leadBlocks: LEAD_BLOCKS,
    sourceFileSha256: source.fileSha256,
    sourcePayloadSha256: source.payloadSha256,
    sourceLogCount: source.logCount,
    onsets: [...ONSETS],
  }
}
function initial(source) {
  return {
    ...identity(source),
    phase: 'partial',
    rows: source.rows.map(({ onset, asofBlock, candidates }) => ({
      onset,
      asofBlock,
      candidateCount: candidates.length,
      candidateSha256: digest(candidates),
      blockHash: null,
      reads: [],
    })),
  }
}
function envelope(payload) {
  return { payload, sha256: digest(payload) }
}
function atomic(path, payload) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(envelope(payload)), { mode: 0o600 })
  renameSync(tmp, path)
}
function diskOk(path) {
  const dir = existsSync(dirname(path)) ? dirname(path) : resolve('.')
  const stat = statfsSync(dir)
  if (stat.bavail * stat.bsize < DISK_FLOOR_BYTES) throw new Error('Disk floor below 2.5 GiB')
}
function safeNumber(value) {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe RPC integer')
  return n
}
export function rowSummary(row) {
  const failures = row.reads.filter((read) => read.status === 'error').length
  const complete = !!row.blockHash && row.reads.length === row.candidateCount
  const holder = complete && !failures ? selectHolder(row.reads) : null
  return {
    onset: row.onset,
    asofBlock: row.asofBlock,
    status: !complete
      ? 'pending'
      : failures
        ? 'read-failure'
        : holder
          ? 'holder'
          : 'no-qualifying-eoa',
    candidateCount: row.candidateCount,
    readCount: row.reads.length,
    readFailures: failures,
    eoaCount: row.reads.filter((read) => read.status === 'ok' && read.eoa).length,
    qualifiedCount: row.reads.filter(
      (read) => read.status === 'ok' && read.eoa && BigInt(read.balanceRaw) >= Q,
    ).length,
    holder: holder && { address: holder.address, balanceRaw: holder.balanceRaw },
  }
}
export function validateAsOfCheckpoint(envelopeValue, source) {
  if (!envelopeValue || digest(envelopeValue.payload) !== envelopeValue.sha256)
    throw new Error('As-of checkpoint SHA mismatch')
  const payload = envelopeValue.payload
  for (const [key, value] of Object.entries(identity(source)))
    if (JSON.stringify(payload[key]) !== JSON.stringify(value))
      throw new Error('As-of checkpoint identity mismatch')
  if (!Array.isArray(payload.rows) || payload.rows.length !== ONSETS.length)
    throw new Error('As-of row count mismatch')
  if (!['partial', 'frozen'].includes(payload.phase)) throw new Error('As-of phase invalid')
  for (let i = 0; i < source.rows.length; i++) {
    const expected = source.rows[i],
      row = payload.rows[i]
    if (
      row?.onset !== expected.onset ||
      row.asofBlock !== expected.asofBlock ||
      row.candidateCount !== expected.candidates.length ||
      row.candidateSha256 !== digest(expected.candidates) ||
      (row.blockHash !== null && !HASH.test(row.blockHash)) ||
      !Array.isArray(row.reads) ||
      row.reads.length > expected.candidates.length
    )
      throw new Error('As-of row identity invalid')
    if (row.reads.length && !row.blockHash) throw new Error('As-of reads lack pinned hash')
    for (let j = 0; j < row.reads.length; j++) {
      const read = row.reads[j]
      if (read?.address !== expected.candidates[j] || !['ok', 'error'].includes(read.status))
        throw new Error('As-of read order invalid')
      if (read.status === 'ok' && (!RAW.test(read.balanceRaw) || typeof read.eoa !== 'boolean'))
        throw new Error('As-of balance/code read invalid')
      if (read.status === 'error' && read.reason !== 'pinned-balance-or-code-read-failed')
        throw new Error('As-of read failure invalid')
    }
    if (payload.phase === 'frozen' && rowSummary(row).status === 'pending')
      throw new Error('Frozen as-of selection has pending reads')
  }
  if (payload.phase === 'frozen' && payload.frozenSha256 !== digest(payload.rows))
    throw new Error('Frozen as-of row SHA mismatch')
  if (payload.phase === 'partial' && payload.frozenSha256 !== undefined)
    throw new Error('Partial as-of checkpoint cannot claim freeze')
  return payload
}
export function loadAsOfCheckpoint(path, source) {
  return existsSync(path)
    ? validateAsOfCheckpoint(JSON.parse(readFileSync(path, 'utf8')), source)
    : initial(source)
}
function save(path, payload, checkDisk) {
  checkDisk(path)
  atomic(path, payload)
}

export async function run({
  sourcePath = DEFAULT_SOURCE,
  out = DEFAULT_OUT,
  client,
  maxCandidates = 0,
  checkDisk = diskOk,
} = {}) {
  if (!sourcePath.startsWith('/') || !out.startsWith('/'))
    throw new Error('Input/output paths must be absolute')
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 0 || maxCandidates > 500)
    throw new Error('max-candidates must be 0..500')
  const source = freezeSource(sourcePath)
  const saved = loadAsOfCheckpoint(out, source)
  if (saved.phase === 'frozen' || maxCandidates === 0)
    return {
      phase: saved.phase,
      processed: 0,
      rows: saved.rows.map(rowSummary),
      frozenSha256: saved.frozenSha256 || null,
    }
  if (!client) throw new Error('RPC client required')
  const chainId = await client.request({ method: 'eth_chainId', params: [] })
  if (safeNumber(chainId) !== 1) throw new Error('RPC chainId is not Ethereum mainnet')
  let processed = 0
  for (let i = 0; i < source.rows.length && processed < maxCandidates; i++) {
    const expected = source.rows[i],
      row = saved.rows[i]
    if (row.reads.length === expected.candidates.length && row.blockHash) continue
    checkDisk(out)
    const header = await client.getBlock({ blockNumber: BigInt(row.asofBlock) })
    if (safeNumber(header.number) !== row.asofBlock || !HASH.test(header.hash?.toLowerCase()))
      throw new Error('As-of block identity invalid')
    const hash = header.hash.toLowerCase()
    if (row.blockHash && row.blockHash !== hash) throw new Error('As-of canonical block changed')
    row.blockHash = hash
    // Persist the A identity even when this call performs no candidate reads.
    save(out, saved, checkDisk)
    while (row.reads.length < expected.candidates.length && processed < maxCandidates) {
      checkDisk(out)
      const address = expected.candidates[row.reads.length]
      const pin = { blockHash: hash, requireCanonical: true }
      let read
      try {
        const [hex, code] = await Promise.all([
          client.request({
            method: 'eth_call',
            params: [
              {
                to: COMET,
                data: encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [address] }),
              },
              pin,
            ],
          }),
          client.request({ method: 'eth_getCode', params: [address, pin] }),
        ])
        const balance = decodeFunctionResult({ abi: ABI, functionName: 'balanceOf', data: hex })
        if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code))
          throw new Error('Invalid pinned code response')
        read = {
          address,
          status: 'ok',
          balanceRaw: balance.toString(),
          eoa: code.toLowerCase() === '0x',
        }
      } catch {
        // Never persist provider error text: it can contain RPC URLs and secrets.
        read = { address, status: 'error', reason: 'pinned-balance-or-code-read-failed' }
      }
      row.reads.push(read)
      processed++
      save(out, saved, checkDisk)
    }
  }
  if (saved.rows.every((row) => rowSummary(row).status !== 'pending')) {
    saved.phase = 'frozen'
    saved.frozenSha256 = digest(saved.rows)
    save(out, saved, checkDisk)
  }
  return {
    phase: saved.phase,
    processed,
    rows: saved.rows.map(rowSummary),
    frozenSha256: saved.frozenSha256 || null,
  }
}

function options(argv) {
  const mode = argv[0]
  if (
    !['--plan', '--run', '--verify'].includes(mode) ||
    (mode === '--verify' && argv[1] !== 'offline')
  )
    throw new Error('Expected --plan, --run, or --verify offline')
  const opts = {}
  for (let i = mode === '--verify' ? 2 : 1; i < argv.length; i += 2) {
    if (!['--source', '--out', '--max-candidates'].includes(argv[i]) || argv[i + 1] === undefined)
      throw new Error('Invalid CLI option')
    if (opts[argv[i]] !== undefined) throw new Error('Duplicate CLI option')
    opts[argv[i]] = argv[i + 1]
  }
  if (mode !== '--run' && opts['--max-candidates'] !== undefined)
    throw new Error('max-candidates is run-only')
  return { mode, opts }
}
async function main() {
  const { mode, opts } = options(process.argv.slice(2))
  const sourcePath = opts['--source'] ? resolve(opts['--source']) : DEFAULT_SOURCE
  const out = opts['--out'] ? resolve(opts['--out']) : DEFAULT_OUT
  const source = freezeSource(sourcePath)
  if (mode === '--verify' && !existsSync(out)) throw new Error('No checkpoint to verify')
  const saved = loadAsOfCheckpoint(out, source)
  if (mode === '--plan' || mode === '--verify') {
    console.log(
      JSON.stringify({
        valid: mode === '--verify' ? true : undefined,
        phase: saved.phase,
        sourceFileSha256: source.fileSha256,
        checkpointSha256: existsSync(out) ? digest(saved) : null,
        frozenSha256: saved.frozenSha256 || null,
        rows: saved.rows.map(rowSummary),
      }),
    )
    return
  }
  const maxCandidates = Number(opts['--max-candidates'] ?? 0)
  const client =
    maxCandidates && saved.phase !== 'frozen'
      ? makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
      : null
  console.log(JSON.stringify(await run({ sourcePath, out, client, maxCandidates })))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('As-of holder stage failed (details withheld to protect RPC credentials)')
    process.exitCode = 1
  })
