// Alchemy transfer API candidate discovery, NOT a canonical-log or borrower certificate.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { ROOT, readEnv } from '../lib/venue-reads.mjs'
import { configuredAlchemyUrl, normalizeTransfer } from './alchemy-mint-capability.mjs'
import {
  CHUNK_BLOCKS,
  DEFAULT_OUT,
  MIN_FREE_BYTES,
  TOKEN,
  verify as verifyLogs,
} from './usde-debt-mint-baseline.mjs'

export const OUT = join(ROOT, 'data/research/venue-signals/usde-alchemy-mint-discovery')
export const SCHEMA = 1
export const MAX_CHUNKS = 4
export const MAX_PAGES = 4
export const DEADLINE_MS = 20_000
export const MAX_RESPONSE_BYTES = 2_000_000
export const MAX_SEAL_BYTES = 4_000_000
const ZERO = `0x${'0'.repeat(40)}`
const HASH = /^0x[0-9a-f]{64}$/
const NAME = /^\d{12}-\d{12}-[0-9a-f]{64}\.json$/
const LOCK = '.alchemy-mint-discovery.lock'
const fail = (code) => {
  throw new Error(`alchemy_mint_discovery_${code}`)
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hex = (number) => `0x${number.toString(16)}`
const safeInt = (value) => Number.isSafeInteger(value) && value >= 0

export function sourceIdentity(frontier) {
  if (!safeInt(frontier?.throughBlock) || !HASH.test(frontier?.frontierHash))
    fail('frontier_invalid')
  return {
    schemaVersion: SCHEMA,
    source: 'alchemy_getAssetTransfers_erc20_zero_origin_candidate_discovery',
    rpcFrontierBlock: frontier.throughBlock,
    rpcFrontierHash: frontier.frontierHash,
    token: TOKEN,
    windowBlocks: CHUNK_BLOCKS,
    maxPages: MAX_PAGES,
    maxCount: 1000,
    excludeZeroValue: false,
    comparisonScope: 'block_transaction_recipient_raw_amount_only',
    finalizedBoundaryWitness: 'eth_getBlockByNumber_finalized_first_and_exact_boundary_parent_link',
    canonicalLogClaim: false,
    borrowerCensusClaim: false,
  }
}

function query(fromBlock, toBlock, pageKey) {
  const params = {
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
    fromAddress: ZERO,
    contractAddresses: [TOKEN],
    category: ['erc20'],
    excludeZeroValue: false,
    maxCount: hex(1000),
  }
  if (pageKey) params.pageKey = pageKey
  return params
}

async function jsonWithinCap(response, signal) {
  if (!response?.ok || !response.body?.getReader) fail('request_failed')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      if (signal.aborted) fail('deadline')
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_RESPONSE_BYTES) fail('response_size_cap')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail('response_invalid')
  }
}

export async function fetchWindow({
  fromBlock,
  toBlock,
  url,
  fetchImpl = fetch,
  deadlineMs = DEADLINE_MS,
}) {
  if (
    !safeInt(fromBlock) ||
    !safeInt(toBlock) ||
    toBlock < fromBlock ||
    !url ||
    !safeInt(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > DEADLINE_MS
  )
    fail('input_invalid')
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('alchemy_mint_discovery_deadline'))
    }, deadlineMs)
  })
  try {
    return await Promise.race([
      (async () => {
        const rows = []
        const seenKeys = new Set()
        const seenRows = new Set()
        let pageKey
        let pages = 0
        do {
          if (controller.signal.aborted) fail('deadline')
          if (++pages > MAX_PAGES) fail('page_cap')
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'alchemy_getAssetTransfers',
              params: [query(fromBlock, toBlock, pageKey)],
            }),
            signal: controller.signal,
          })
          if (controller.signal.aborted) fail('deadline')
          const body = await jsonWithinCap(response, controller.signal)
          if (controller.signal.aborted) fail('deadline')
          if (
            body?.jsonrpc !== '2.0' ||
            body?.id !== 1 ||
            body?.error ||
            !Array.isArray(body?.result?.transfers) ||
            body.result.transfers.length > 1000
          )
            fail('response_invalid')
          for (const transfer of body.result.transfers) {
            let tuple
            try {
              tuple = normalizeTransfer(transfer, fromBlock, toBlock)
            } catch {
              fail('transfer_invalid')
            }
            if (seenRows.has(tuple)) fail('duplicate_transfer')
            seenRows.add(tuple)
            rows.push(tuple)
          }
          const next = body.result.pageKey
          if (next === undefined || next === null || next === '') pageKey = undefined
          else {
            if (typeof next !== 'string' || next.length > 1024 || seenKeys.has(next))
              fail('page_key_invalid')
            seenKeys.add(next)
            pageKey = next
          }
        } while (pageKey)
        return { rows: rows.sort(), pages, pageKeyExhausted: true }
      })(),
      timeout,
    ])
  } catch (cause) {
    if (String(cause?.message).startsWith('alchemy_mint_discovery_')) throw cause
    fail(controller.signal.aborted ? 'deadline' : 'request_failed')
  } finally {
    clearTimeout(timer)
  }
}

export async function readFinalizedWitness({
  fromBlock,
  toBlock,
  expectedParentHash,
  url,
  fetchImpl = fetch,
  deadlineMs = DEADLINE_MS,
}) {
  if (
    !safeInt(fromBlock) ||
    !safeInt(toBlock) ||
    fromBlock > toBlock ||
    !HASH.test(expectedParentHash) ||
    !url ||
    !safeInt(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > DEADLINE_MS
  )
    fail('witness_input_invalid')
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('alchemy_mint_discovery_deadline'))
    }, deadlineMs)
  })
  const call = async (tag) => {
    if (controller.signal.aborted) fail('deadline')
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_getBlockByNumber',
        params: [tag, false],
      }),
      signal: controller.signal,
    })
    if (controller.signal.aborted) fail('deadline')
    const body = await jsonWithinCap(response, controller.signal)
    if (controller.signal.aborted) fail('deadline')
    const block = body?.result
    if (
      body?.jsonrpc !== '2.0' ||
      body?.id !== 2 ||
      body?.error ||
      !block ||
      !/^0x[0-9a-f]+$/i.test(block.number) ||
      !HASH.test(String(block.hash).toLowerCase()) ||
      !HASH.test(String(block.parentHash).toLowerCase())
    )
      fail('witness_invalid')
    const number = Number(BigInt(block.number))
    if (!safeInt(number)) fail('witness_invalid')
    return {
      number,
      hash: String(block.hash).toLowerCase(),
      parentHash: String(block.parentHash).toLowerCase(),
    }
  }
  try {
    return await Promise.race([
      (async () => {
        const finalized = await call('finalized')
        if (finalized.number < toBlock) fail('boundary_not_finalized')
        const first = await call(hex(fromBlock))
        if (first.number !== fromBlock || first.parentHash !== expectedParentHash)
          fail('parent_hash_mismatch')
        const boundary = await call(hex(toBlock))
        if (boundary.number !== toBlock) fail('witness_invalid')
        return {
          finalizedHead: finalized.number,
          finalizedHeadHash: finalized.hash,
          fromBlockHash: first.hash,
          fromBlockParentHash: first.parentHash,
          boundaryHash: boundary.hash,
        }
      })(),
      timeout,
    ])
  } catch (cause) {
    if (String(cause?.message).startsWith('alchemy_mint_discovery_')) throw cause
    fail(controller.signal.aborted ? 'deadline' : 'witness_request_failed')
  } finally {
    clearTimeout(timer)
  }
}

function sealName(segment, bytes) {
  return `${String(segment.fromBlock).padStart(12, '0')}-${String(segment.toBlock).padStart(12, '0')}-${sha(bytes)}.json`
}

export function candidateOwners(rows) {
  return [
    ...new Set(
      rows.filter((row) => BigInt(row.split(':')[3]) > 0n).map((row) => row.split(':')[2]),
    ),
  ].sort()
}

export function verify({ out = OUT, frontier } = {}) {
  const source = sourceIdentity(frontier)
  const names = existsSync(out)
    ? readdirSync(out)
        .filter((name) => name !== LOCK)
        .sort()
    : []
  let throughBlock = frontier.throughBlock
  let parentHash = frontier.frontierHash
  let transferCount = 0
  for (const name of names) {
    if (!NAME.test(name)) fail('artifact_invalid')
    const bytes = readFileSync(join(out, name))
    if (bytes.length > MAX_SEAL_BYTES) fail('seal_size_cap')
    let segment
    try {
      segment = JSON.parse(bytes)
    } catch {
      fail('seal_invalid')
    }
    if (
      sealName(segment, bytes) !== name ||
      JSON.stringify(segment.sourceIdentity) !== JSON.stringify(source) ||
      segment.fromBlock !== throughBlock + 1 ||
      !safeInt(segment.toBlock) ||
      segment.toBlock < segment.fromBlock ||
      segment.toBlock - segment.fromBlock + 1 !== CHUNK_BLOCKS ||
      !safeInt(segment.pages) ||
      segment.pages < 1 ||
      segment.pages > MAX_PAGES ||
      segment.pageKeyExhausted !== true ||
      !safeInt(segment.finalizedHead) ||
      segment.finalizedHead < segment.toBlock ||
      !HASH.test(segment.finalizedHeadHash) ||
      !HASH.test(segment.fromBlockHash) ||
      segment.fromBlockParentHash !== parentHash ||
      !HASH.test(segment.boundaryHash) ||
      !Number.isFinite(Date.parse(segment.fetchedAt)) ||
      !Array.isArray(segment.rows) ||
      !Array.isArray(segment.candidateOwners) ||
      segment.rows.length > MAX_PAGES * 1000 ||
      segment.canonicalLogClaim !== false ||
      segment.borrowerCensusClaim !== false
    )
      fail('seal_invalid')
    const rows = segment.rows
    if (rows.some((row) => typeof row !== 'string')) fail('rows_invalid')
    if (JSON.stringify(rows) !== JSON.stringify([...new Set(rows)].sort())) fail('rows_invalid')
    for (const row of rows) {
      const parts = row.split(':')
      const block = Number(parts[0])
      if (
        parts.length !== 4 ||
        !safeInt(block) ||
        block < segment.fromBlock ||
        block > segment.toBlock ||
        !HASH.test(parts[1]) ||
        !/^0x[0-9a-f]{40}$/.test(parts[2]) ||
        parts[2] === ZERO ||
        !/^(0|[1-9][0-9]*)$/.test(parts[3])
      )
        fail('rows_invalid')
    }
    if (JSON.stringify(segment.candidateOwners) !== JSON.stringify(candidateOwners(rows)))
      fail('candidate_mismatch')
    throughBlock = segment.toBlock
    parentHash = segment.boundaryHash
    transferCount += rows.length
  }
  return {
    throughBlock,
    segmentCount: names.length,
    transferCount,
    boundaryHash: parentHash,
    sourceIdentity: source,
    candidateDiscoveryOnly: true,
  }
}

export function assertDiskFloor(out, stat = statfsSync, bytes = 0) {
  // Check the same volume that will receive the seal, before even creating its directory.
  let path = out
  while (!existsSync(path) && path !== '/') path = join(path, '..')
  const space = stat(path)
  if (Number(space.bavail) * Number(space.bsize) - bytes < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
}

export function append(out, segment, { stat = statfsSync } = {}) {
  const bytes = Buffer.from(JSON.stringify(segment))
  if (bytes.length > MAX_SEAL_BYTES) fail('seal_size_cap')
  assertDiskFloor(out, stat, bytes.length)
  mkdirSync(out, { recursive: true })
  const target = join(out, sealName(segment, bytes))
  const temporary = `${target}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) fail('write_failed')
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temporary, target) // Exclusive promotion: existing seals are never replaced.
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return target
}

export async function collect({
  frontier,
  throughBlock,
  maxChunks = MAX_CHUNKS,
  out = OUT,
  url,
  fetchImpl = fetch,
  stat = statfsSync,
  fetchedAt = () => new Date().toISOString(),
  readWitness = readFinalizedWitness,
} = {}) {
  const source = sourceIdentity(frontier)
  if (
    !safeInt(throughBlock) ||
    throughBlock <= frontier.throughBlock ||
    (throughBlock - frontier.throughBlock) % CHUNK_BLOCKS !== 0 ||
    !safeInt(maxChunks) ||
    maxChunks < 1 ||
    maxChunks > MAX_CHUNKS
  )
    fail('input_invalid')
  assertDiskFloor(out, stat, 1024)
  mkdirSync(out, { recursive: true })
  const lockPath = join(out, LOCK)
  let lock
  try {
    lock = openSync(lockPath, 'wx', 0o600)
  } catch {
    fail('lock_held')
  }
  try {
    const starting = verify({ out, frontier })
    let current = starting.throughBlock
    let parentHash = starting.boundaryHash ?? frontier.frontierHash
    let sealed = 0
    while (current < throughBlock && sealed < maxChunks) {
      const fromBlock = current + 1
      const toBlock = fromBlock + CHUNK_BLOCKS - 1
      assertDiskFloor(out, stat)
      const witness = await readWitness({
        fromBlock,
        toBlock,
        expectedParentHash: parentHash,
        url,
        fetchImpl,
      })
      if (
        !safeInt(witness?.finalizedHead) ||
        witness.finalizedHead < toBlock ||
        !HASH.test(witness.finalizedHeadHash) ||
        !HASH.test(witness.fromBlockHash) ||
        witness.fromBlockParentHash !== parentHash ||
        !HASH.test(witness.boundaryHash)
      )
        fail('witness_invalid')
      const result = await fetchWindow({ fromBlock, toBlock, url, fetchImpl })
      const segment = {
        sourceIdentity: source,
        fromBlock,
        toBlock,
        ...witness,
        fetchedAt: fetchedAt(),
        pages: result.pages,
        pageKeyExhausted: result.pageKeyExhausted,
        rows: result.rows,
        candidateOwners: candidateOwners(result.rows),
        canonicalLogClaim: false,
        borrowerCensusClaim: false,
      }
      // Recheck before every write; a slow request may have consumed the reserve.
      append(out, segment, { stat })
      current = toBlock
      parentHash = witness.boundaryHash
      sealed++
    }
    return verify({ out, frontier })
  } finally {
    closeSync(lock)
    unlinkSync(lockPath)
  }
}

export function parseArgs(argv) {
  if (argv.length < 1 || !['--verify', '--run'].includes(argv[0])) fail('cli_invalid')
  if (
    argv[1] !== '--frontier-block' ||
    !/^\d+$/.test(argv[2] ?? '') ||
    argv[3] !== '--frontier-hash' ||
    !HASH.test(argv[4] ?? '')
  )
    fail('cli_invalid')
  const frontier = { throughBlock: Number(argv[2]), frontierHash: argv[4] }
  sourceIdentity(frontier)
  if (argv[0] === '--verify' && argv.length !== 5) fail('cli_invalid')
  if (
    argv[0] === '--run' &&
    (argv.length !== 9 ||
      argv[5] !== '--through' ||
      !/^\d+$/.test(argv[6]) ||
      argv[7] !== '--max-chunks' ||
      !/^\d+$/.test(argv[8]))
  )
    fail('cli_invalid')
  return argv[0] === '--verify'
    ? { run: false, frontier }
    : { run: true, frontier, throughBlock: Number(argv[6]), maxChunks: Number(argv[8]) }
}

export function assertVerifiedFrontier(frontier, logs, directory = DEFAULT_OUT) {
  sourceIdentity(frontier)
  if (frontier.throughBlock > logs?.throughBlock) fail('frontier_unverified')
  if (frontier.throughBlock === logs.throughBlock) {
    if (frontier.frontierHash !== logs.frontierHash) fail('frontier_unverified')
    return
  }
  // The whole prefix has just passed the canonical eth_getLogs verifier.
  // Resolve a historical segment boundary from that verified prefix only.
  const suffix = `-${String(frontier.throughBlock).padStart(12, '0')}-`
  const matches = readdirSync(directory).filter((name) => NAME.test(name) && name.includes(suffix))
  if (matches.length !== 1) fail('frontier_unverified')
  const segment = JSON.parse(readFileSync(join(directory, matches[0])))
  if (segment.toBlock !== frontier.throughBlock || segment.toHeader?.hash !== frontier.frontierHash)
    fail('frontier_unverified')
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  const logs = (dependencies.verifyLogs ?? verifyLogs)()
  const frontier = args.frontier
  assertVerifiedFrontier(frontier, logs)
  if (!args.run) return verify({ out: OUT, frontier })
  let env
  try {
    env = readEnv()
  } catch {
    env = { get: () => undefined }
  }
  const raw = [
    process.env.RECORDER_RPC_URLS,
    process.env.RECORDER_RPC_URL,
    env.get('RECORDER_RPC_URLS'),
    env.get('RECORDER_RPC_URL'),
  ]
    .filter(Boolean)
    .join(',')
  const url = configuredAlchemyUrl(raw)
  return collect({
    frontier,
    throughBlock: args.throughBlock,
    maxChunks: args.maxChunks,
    url,
    fetchImpl: dependencies.fetchImpl ?? fetch,
  })
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((cause) => {
      const code = String(cause?.message).startsWith('alchemy_mint_discovery_')
        ? cause.message
        : 'alchemy_mint_discovery_failed'
      process.stderr.write(`${code}\n`)
      process.exitCode = 1
    })
}
