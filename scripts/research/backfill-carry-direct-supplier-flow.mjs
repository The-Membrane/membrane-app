// Bounded, public-chain-only historical direct supplier withdrawal backfill.
// Existing sealed segments are verified before any new range is collected.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  collectDirectSupplierFlowSegment,
  SEGMENT_BLOCKS,
  verifyDirectSupplierFlowSegment,
  verifyDirectSupplierFlowSegments,
} from './collect-carry-direct-supplier-flow.mjs'
import { writeDirectSupplierFlowPublicationWitness } from './carry-direct-supplier-flow-publication-witness.mjs'

export const MIN_FREE_BYTES = 2 * 1024 ** 3
export const MAX_BACKFILL_SEGMENTS = 16
export const MAX_RPC_ORIGINS = 8
const MAX_EXISTING_BYTES = 64 * 1024 ** 2
const HASH = /^0x[0-9a-f]{64}$/
const MARKETS = new Set(['aaveV3Usdc', 'aaveV3Usde', 'sparkLendUsdt', 'compoundV3Usdc'])
const fail = (condition, code) => {
  if (!condition) throw new Error(code)
}

function integer(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : NaN
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return NaN
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : NaN
}

export function directRpcRing(configured) {
  const urls = String(configured || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const byOrigin = new Map()
  for (const url of urls) {
    let origin
    try {
      const parsed = new URL(url)
      fail(parsed.protocol === 'https:' || parsed.protocol === 'http:', 'invalid_direct_rpc_config')
      origin = parsed.origin
    } catch {
      throw new Error('invalid_direct_rpc_config')
    }
    if (!byOrigin.has(origin)) byOrigin.set(origin, { url, origin })
  }
  fail(byOrigin.size >= 2, 'two_distinct_direct_rpc_origins_required')
  fail(byOrigin.size <= MAX_RPC_ORIGINS, 'too_many_direct_rpc_origins')
  return [...byOrigin.values()]
}

function diskReserve(outDir, serializedBytes, stat = statfsSync) {
  const fs = stat(outDir)
  const free = Number(fs.bavail) * Number(fs.bsize)
  fail(
    Number.isSafeInteger(free) && free - serializedBytes >= MIN_FREE_BYTES,
    'direct_disk_reserve',
  )
}

function retryableRpcFailure(error) {
  const seen = new Set()
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current)
    if (current.name === 'TimeoutError' || current.name === 'SocketClosedError') return true
    if (
      current.name === 'HttpRequestError' &&
      (current.status === undefined || [408, 429, 502, 503, 504].includes(current.status))
    )
      return true
    // -32615 rejected eth_getLogs on one origin while another independent
    // pair produced a fully verifiable segment. Try the next pair; never
    // accept a segment with disagreeing valid responses.
    if (current.name === 'RpcRequestError' && [-32615, -32005, -32016, 429].includes(current.code))
      return true
  }
  return false
}

/** Fixed transport class only; never serialize provider messages or URLs. */
export function safeDirectOriginFailureClass(error) {
  const seen = new Set()
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current)
    if (current.name === 'TimeoutError') return 'timeout'
    if (current.name === 'SocketClosedError') return 'socket_closed'
    if (current.name === 'HttpRequestError') {
      const status = Number(current.status)
      return [401, 403, 408, 429, 500, 502, 503, 504].includes(status)
        ? `http_${status}`
        : 'http_other'
    }
    if (current.name === 'RpcRequestError') {
      if (Number(current.code) === -32615) return 'rpc_origin_unavailable'
      return [-32005, -32016, 429].includes(Number(current.code)) ? 'rpc_rate_limited' : 'rpc_other'
    }
  }
  return 'source_or_proof'
}

function segmentName(marketKey, fromBlock, toBlock) {
  return `${marketKey}-${fromBlock}-${toBlock}.json`
}

function flowSegmentName(flowKind, marketKey, fromBlock, toBlock) {
  return flowKind === 'supply'
    ? `supply-${segmentName(marketKey, fromBlock, toBlock)}`
    : segmentName(marketKey, fromBlock, toBlock)
}

function publishSegment(outDir, name, body) {
  // A crash before the hard link leaves only a hidden, ignored staging file.
  // A crash after the link leaves a complete, fsynced immutable final file.
  const staged = join(outDir, `.direct-flow-stage-${randomUUID()}.tmp`)
  const final = join(outDir, name)
  let fd = null
  try {
    fd = openSync(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(fd, body)
    fchmodSync(fd, 0o444)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    linkSync(staged, final) // No overwrite even if another process won the race.
    const directoryFd = openSync(outDir, constants.O_RDONLY)
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  } finally {
    if (fd !== null) closeSync(fd)
    try {
      unlinkSync(staged)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('direct_stage_cleanup_failed')
    }
  }
}

function existingSegments(outDir, marketKey, flowKind = 'withdraw') {
  const prefix = flowKind === 'supply' ? `supply-${marketKey}-` : `${marketKey}-`
  const entries = []
  for (const name of readdirSync(outDir)) {
    if (!name.startsWith(prefix)) continue
    const match = new RegExp(`^${prefix}(0|[1-9][0-9]*)-(0|[1-9][0-9]*)\\.json$`).exec(name)
    fail(match, 'invalid_direct_segment_filename')
    const fromBlock = integer(match[1])
    const toBlock = integer(match[2])
    fail(fromBlock >= 0 && toBlock >= fromBlock, 'invalid_direct_segment_filename')
    entries.push({ name, fromBlock, toBlock })
  }
  entries.sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock)
  for (let i = 1; i < entries.length; i++) {
    fail(entries[i].fromBlock > entries[i - 1].toBlock, 'overlapping_direct_segments')
  }
  return entries
}

function readExisting(outDir, entry, marketKey, flowKind = 'withdraw') {
  const path = join(outDir, entry.name)
  const stat = lstatSync(path)
  fail(
    stat.isFile() && stat.size > 0 && stat.size <= MAX_EXISTING_BYTES,
    'invalid_direct_segment_file',
  )
  let document
  try {
    document = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('invalid_direct_segment_json')
  }
  const verified = verifyDirectSupplierFlowSegment(document)
  fail(
    verified.marketKey === marketKey &&
      verified.flowKind === flowKind &&
      verified.fromBlock === entry.fromBlock &&
      verified.toBlock === entry.toBlock,
    'direct_segment_filename_mismatch',
  )
  return document
}

function validateOptions({
  marketKey,
  fromBlock,
  toBlock,
  outDir,
  maxSegments,
  expectedFirstBlockHash,
  flowKind = 'withdraw',
}) {
  fail(MARKETS.has(marketKey), 'unsupported_direct_market')
  fail(flowKind === 'withdraw' || flowKind === 'supply', 'unsupported_direct_flow_kind')
  fail(
    (marketKey !== 'aaveV3Usde' ||
      flowKind === 'supply' ||
      HASH.test(expectedFirstBlockHash ?? '')) &&
      (expectedFirstBlockHash == null || HASH.test(expectedFirstBlockHash)),
    'direct_usde_anchor_hash_required',
  )
  fail(
    Number.isSafeInteger(fromBlock) &&
      Number.isSafeInteger(toBlock) &&
      fromBlock >= 0 &&
      toBlock >= fromBlock &&
      toBlock < Number.MAX_SAFE_INTEGER,
    'invalid_direct_backfill_range',
  )
  fail(
    typeof outDir === 'string' && isAbsolute(outDir) && resolve(outDir) === outDir,
    'absolute_direct_output_directory_required',
  )
  fail(
    Number.isSafeInteger(maxSegments) && maxSegments >= 1 && maxSegments <= MAX_BACKFILL_SEGMENTS,
    'invalid_direct_backfill_budget',
  )
  fail(lstatSync(outDir).isDirectory(), 'invalid_direct_output_directory')
}

/** Returns only fixed status codes and aggregate counts; never logs RPC URLs or holders. */
export async function backfillDirectSupplierFlow({
  marketKey,
  fromBlock,
  toBlock,
  outDir,
  maxSegments,
  expectedFirstBlockHash = null,
  flowKind = 'withdraw',
  rpcUrls,
  clientFactory = makeClient,
  collect = collectDirectSupplierFlowSegment,
  stat = statfsSync,
}) {
  validateOptions({
    marketKey,
    fromBlock,
    toBlock,
    outDir,
    maxSegments,
    expectedFirstBlockHash,
    flowKind,
  })
  const origins = directRpcRing(rpcUrls)
  const existing = existingSegments(outDir, marketKey, flowKind)
  const selected = []
  let cursor = fromBlock
  let added = 0
  let resumed = 0
  while (cursor <= toBlock) {
    const overlap = existing.find((entry) => entry.fromBlock <= cursor && entry.toBlock >= cursor)
    fail(!overlap || overlap.fromBlock === cursor, 'direct_resume_overlap')
    const atCursor = overlap
    if (atCursor) {
      fail(atCursor.toBlock <= toBlock, 'direct_resume_range_mismatch')
      const document = readExisting(outDir, atCursor, marketKey, flowKind)
      if (cursor === fromBlock)
        fail(
          expectedFirstBlockHash == null ||
            verifyDirectSupplierFlowSegment(document).firstBlockHash === expectedFirstBlockHash,
          'direct_usde_anchor_segment_mismatch',
        )
      if (selected.length) verifyDirectSupplierFlowSegments([selected.at(-1), document])
      selected.push(document)
      cursor = atCursor.toBlock + 1
      resumed++
      continue
    }
    if (added >= maxSegments) break
    const nextExisting = existing.find((entry) => entry.fromBlock > cursor)
    const end = Math.min(
      cursor + SEGMENT_BLOCKS - 1,
      toBlock,
      nextExisting ? nextExisting.fromBlock - 1 : toBlock,
    )
    fail(end >= cursor, 'direct_resume_gap')
    // The budget check precedes RPC work. The size-aware check runs again at write.
    diskReserve(outDir, 0, stat)
    let accepted = null
    for (let i = 0; i < origins.length && !accepted; i++) {
      for (let j = i + 1; j < origins.length && !accepted; j++) {
        try {
          const result = await collect({
            primary: clientFactory(origins[i].url),
            secondary: clientFactory(origins[j].url),
            primaryOrigin: origins[i].origin,
            secondaryOrigin: origins[j].origin,
            marketKey,
            flowKind,
            fromBlock: cursor,
            toBlock: end,
          })
          const verified = verifyDirectSupplierFlowSegment(result.document)
          fail(
            verified.marketKey === marketKey &&
              verified.flowKind === flowKind &&
              verified.fromBlock === cursor &&
              verified.toBlock === end,
            'direct_collector_range_mismatch',
          )
          fail(
            expectedFirstBlockHash == null ||
              cursor !== fromBlock ||
              verified.firstBlockHash === expectedFirstBlockHash,
            'direct_usde_anchor_segment_mismatch',
          )
          if (selected.length) verifyDirectSupplierFlowSegments([selected.at(-1), result.document])
          accepted = result.document
        } catch (error) {
          // Disagreement is evidence of an incomplete source, even if a third
          // origin agrees with one side. Never publish a majority-empty seal.
          if (!retryableRpcFailure(error)) {
            const rejected = new Error('direct_source_disagreement')
            rejected.diagnosticClass = safeDirectOriginFailureClass(error)
            throw rejected
          }
          // Transport/rate-limit errors can include credential-bearing URLs.
          // Try another independent pair without surfacing upstream messages.
        }
      }
    }
    fail(accepted, 'direct_segment_unavailable')
    const body = `${JSON.stringify(accepted)}\n`
    const bytes = Buffer.byteLength(body)
    fail(bytes <= MAX_EXISTING_BYTES, 'direct_segment_too_large')
    // Reserve the bounded sidecar as well as the segment before publication.
    diskReserve(outDir, bytes + 2 * 1024, stat)
    const name = flowSegmentName(flowKind, marketKey, cursor, end)
    publishSegment(outDir, name, body)
    // The local receipt is created only after the immutable segment and its
    // directory entry have both been fsynced. Resume never backdates one.
    writeDirectSupplierFlowPublicationWitness(join(outDir, name), accepted)
    selected.push(accepted)
    added++
    cursor = end + 1
  }
  const combined = verifyDirectSupplierFlowSegments(selected)
  return {
    status: cursor > toBlock ? 'complete' : 'budget_reached',
    marketKey,
    flowKind,
    fromBlock,
    throughBlock: cursor - 1,
    requestedToBlock: toBlock,
    resumedSegments: resumed,
    newSegments: added,
    reconciledWithdrawals: combined.withdrawals.length,
    unclassifiedWithdrawals: combined.unclassifiedWithdrawals.length,
    reconciledSupplies: combined.supplies.length,
    coverageStartMs: combined.coverage.startMs,
    coverageEndMs: combined.coverage.endMs,
  }
}

function cliOptions(args) {
  const values = {}
  fail(args.length > 0 && args.length % 2 === 0, 'invalid_direct_backfill_option')
  for (let i = 0; i < args.length; i += 2) {
    fail(
      ['--market', '--from', '--to', '--out-dir', '--max-segments', '--flow'].includes(args[i]) &&
        args[i + 1] !== undefined &&
        values[args[i]] === undefined,
      'invalid_direct_backfill_option',
    )
    values[args[i]] = args[i + 1]
  }
  fail(
    ['--market', '--from', '--to', '--out-dir', '--max-segments'].every(
      (key) => values[key] !== undefined,
    ),
    'invalid_direct_backfill_option',
  )
  return values
}

async function main() {
  const cli = cliOptions(process.argv.slice(2))
  const local = !process.env.RECORDER_RPC_URLS && !process.env.RECORDER_RPC_URL ? readEnv() : null
  const result = await backfillDirectSupplierFlow({
    marketKey: cli['--market'],
    flowKind: cli['--flow'] ?? 'withdraw',
    fromBlock: integer(cli['--from']),
    toBlock: integer(cli['--to']),
    outDir: cli['--out-dir'],
    maxSegments: integer(cli['--max-segments']),
    rpcUrls:
      process.env.RECORDER_RPC_URLS ||
      process.env.RECORDER_RPC_URL ||
      local?.get('RECORDER_RPC_URLS') ||
      local?.get('RECORDER_RPC_URL'),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('direct_backfill_failed\n')
    process.exitCode = 1
  })
}
