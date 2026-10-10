// Public-chain-only continuation of sealed direct supplier withdrawal receipts.
// This job never opens the private forecast DB or reads holder/size scenarios.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  directRpcRing,
  backfillDirectSupplierFlow,
} from './research/backfill-carry-direct-supplier-flow.mjs'
import { ROOT, makeClient, readEnv } from './lib/venue-reads.mjs'

export const DIRECT_FLOW_DIR = resolve(ROOT, 'data/research/venue-signals/direct-supplier-flow')
export const MAX_SEGMENTS_PER_MARKET_TICK = 8
export const MAX_FINALIZED_HEAD_AGE_MS = 2 * 60 * 60 * 1000
export const DIRECT_FLOW_MARKETS = Object.freeze([
  { marketKey: 'aaveV3Usde', fromBlock: 'fresh_finalized_anchor' },
  { marketKey: 'aaveV3Usdc', fromBlock: 26079847 },
  { marketKey: 'sparkLendUsdt', fromBlock: 26079849 },
  { marketKey: 'compoundV3Usdc', fromBlock: 26079847 },
])
const MARKET_ROTATION_MS = 60 * 60_000

const HASH = /^0x[0-9a-f]{64}$/
const SAFE_DIRECT_ERROR_CODES = new Set([
  'invalid_direct_tick_options',
  'invalid_direct_tick_time',
  'invalid_direct_rpc_config',
  'two_distinct_direct_rpc_origins_required',
  'too_many_direct_rpc_origins',
  'two_healthy_direct_rpc_origins_required',
  'invalid_direct_finalized_target',
  'two_common_direct_rpc_origins_required',
  'direct_finalized_target_disagreement',
  'direct_finalized_target_stale',
  'direct_segment_unavailable',
  'direct_source_disagreement',
  'direct_resume_gap',
  'direct_resume_overlap',
  'direct_resume_range_mismatch',
  'direct_segment_too_large',
  'direct_disk_reserve',
  'direct_stage_cleanup_failed',
  'invalid_direct_segment_json',
  'invalid_direct_output_directory',
])
const fail = (condition, code) => {
  if (!condition) throw new Error(code)
}

const USDE_ANCHOR = 'start-aaveV3Usde.json'
const seal = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')

/** A new market starts at its first observed finalized frontier, never at USDC's old block. */
export function freshUsdeFlowStart({ outDir, frozen, nowMs }) {
  const path = join(outDir, USDE_ANCHOR)
  const readAnchor = () => {
    const file = lstatSync(path)
    fail(file.isFile() && file.size > 0 && file.size <= 4096, 'invalid_direct_usde_anchor')
    let row
    try {
      row = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw Error('invalid_direct_usde_anchor')
    }
    const { sha256, ...body } = row
    fail(
      body.schema === 'carry_direct_fresh_flow_start_v1' &&
        body.marketKey === 'aaveV3Usde' &&
        Number.isSafeInteger(body.fromBlock) &&
        body.fromBlock > 1 &&
        body.fromBlock === body.firstFinalizedTargetBlock &&
        HASH.test(body.firstFinalizedTargetHash) &&
        Number.isSafeInteger(body.firstFinalizedTargetAtMs) &&
        Number.isSafeInteger(body.operatorRecordedAtMs) &&
        body.operatorRecordedAtMs >= body.firstFinalizedTargetAtMs &&
        body.operatorRecordedAtMs - body.firstFinalizedTargetAtMs <= MAX_FINALIZED_HEAD_AGE_MS &&
        body.fromBlock <= frozen.targetBlock &&
        seal(body) === sha256,
      'invalid_direct_usde_anchor',
    )
    return { fromBlock: body.fromBlock, firstBlockHash: body.firstFinalizedTargetHash }
  }
  try {
    return readAnchor()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  fail(
    !readdirSync(outDir).some((name) => /^aaveV3Usde-[0-9]+-[0-9]+\.json$/.test(name)),
    'direct_usde_unanchored_segments',
  )
  fail(
    Number.isSafeInteger(frozen.targetBlock) &&
      frozen.targetBlock > 1 &&
      HASH.test(frozen.targetHash) &&
      Number.isSafeInteger(frozen.targetAtMs) &&
      frozen.targetAtMs <= nowMs &&
      nowMs - frozen.targetAtMs <= MAX_FINALIZED_HEAD_AGE_MS,
    'invalid_direct_usde_frontier',
  )
  const body = {
    schema: 'carry_direct_fresh_flow_start_v1',
    marketKey: 'aaveV3Usde',
    fromBlock: frozen.targetBlock,
    firstFinalizedTargetBlock: frozen.targetBlock,
    firstFinalizedTargetHash: frozen.targetHash,
    firstFinalizedTargetAtMs: frozen.targetAtMs,
    operatorRecordedAtMs: nowMs,
  }
  const staged = join(outDir, `.direct-usde-start-${randomUUID()}.tmp`)
  let fd = null
  try {
    fd = openSync(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o444,
    )
    writeFileSync(fd, `${JSON.stringify({ ...body, sha256: seal(body) })}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    try {
      linkSync(staged, path)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const dir = openSync(outDir, constants.O_RDONLY)
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } finally {
    if (fd !== null) closeSync(fd)
    try {
      unlinkSync(staged)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw Error('direct_usde_stage_cleanup_failed')
    }
  }
  return readAnchor()
}

export function safeDirectFlowErrorCode(error) {
  return SAFE_DIRECT_ERROR_CODES.has(error?.message) ? error.message : 'direct_unknown_failure'
}

function block(raw, expected = null) {
  const number = raw?.number
  const timestamp = raw?.timestamp
  const parsedNumber =
    typeof number === 'string' && /^0x[0-9a-f]+$/i.test(number) ? Number(BigInt(number)) : NaN
  const parsedTimestamp =
    typeof timestamp === 'string' && /^0x[0-9a-f]+$/i.test(timestamp)
      ? Number(BigInt(timestamp))
      : NaN
  fail(
    Number.isSafeInteger(parsedNumber) &&
      parsedNumber > 1 &&
      Number.isSafeInteger(parsedTimestamp) &&
      parsedTimestamp > 0 &&
      Number.isSafeInteger(parsedTimestamp * 1000) &&
      HASH.test(String(raw?.hash || '').toLowerCase()) &&
      HASH.test(String(raw?.parentHash || '').toLowerCase()) &&
      (expected === null || parsedNumber === expected),
    'invalid_direct_finalized_header',
  )
  return {
    number: parsedNumber,
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
    timestampMs: parsedTimestamp * 1000,
  }
}

async function originHead(origin, clientFactory, nowMs) {
  try {
    const client = clientFactory(origin.url)
    const chainId = await client.request({ method: 'eth_chainId' })
    if (chainId !== '0x1') return null
    const raw = await client.request({
      method: 'eth_getBlockByNumber',
      params: ['finalized', false],
    })
    const head = block(raw)
    if (head.timestampMs > nowMs || nowMs - head.timestampMs > MAX_FINALIZED_HEAD_AGE_MS)
      return null
    return { ...origin, client, head }
  } catch {
    // A single unusable origin cannot prevent two healthy independent sources.
    // Transport failures can contain RPC credentials in their messages.
    return null
  }
}

/** Freeze a common block strictly below every selected origin's finalized head. */
export async function freezeDirectFlowTarget({
  rpcUrls,
  clientFactory = makeClient,
  nowMs = Date.now(),
}) {
  fail(Number.isSafeInteger(nowMs) && nowMs >= 0, 'invalid_direct_tick_time')
  const origins = directRpcRing(rpcUrls)
  const heads = (
    await Promise.all(origins.map((origin) => originHead(origin, clientFactory, nowMs)))
  ).filter(Boolean)
  fail(heads.length >= 2, 'two_healthy_direct_rpc_origins_required')
  const targetBlock = Math.min(...heads.map((entry) => entry.head.number)) - 1
  fail(targetBlock > 1, 'invalid_direct_finalized_target')
  const selected = []
  for (const entry of heads) {
    try {
      const raw = await entry.client.request({
        method: 'eth_getBlockByNumber',
        params: [`0x${targetBlock.toString(16)}`, false],
      })
      selected.push({ ...entry, target: block(raw, targetBlock) })
    } catch {
      continue
    }
  }
  fail(selected.length >= 2, 'two_common_direct_rpc_origins_required')
  const groups = new Map()
  for (const entry of selected) {
    const key = JSON.stringify(entry.target)
    const group = groups.get(key) || []
    group.push(entry)
    groups.set(key, group)
  }
  // A single disagreeing origin cannot veto two independent exact headers.
  // Competing pairs remain ambiguous and fail closed.
  const agreeing = [...groups.values()].filter((group) => group.length >= 2)
  fail(agreeing.length === 1, 'direct_finalized_target_disagreement')
  const corroborated = agreeing[0]
  const first = corroborated[0].target
  fail(
    first.timestampMs <= nowMs && nowMs - first.timestampMs <= MAX_FINALIZED_HEAD_AGE_MS,
    'direct_finalized_target_stale',
  )
  return {
    targetBlock,
    targetHash: first.hash,
    targetAtMs: first.timestampMs,
    rpcUrls: corroborated.map((entry) => entry.url).join(','),
    originCount: corroborated.length,
  }
}

/** Each market receives the same frozen target and independent failure handling. */
export async function recordDirectSupplierFlowTick({
  rpcUrls,
  outDir = DIRECT_FLOW_DIR,
  clientFactory = makeClient,
  backfill = backfillDirectSupplierFlow,
  freshStart = freshUsdeFlowStart,
  nowMs = Date.now(),
  maxSegmentsPerMarket = MAX_SEGMENTS_PER_MARKET_TICK,
}) {
  fail(
    Number.isSafeInteger(maxSegmentsPerMarket) &&
      maxSegmentsPerMarket >= 1 &&
      maxSegmentsPerMarket <= MAX_SEGMENTS_PER_MARKET_TICK,
    'invalid_direct_tick_options',
  )
  const frozen = await freezeDirectFlowTarget({ rpcUrls, clientFactory, nowMs })
  const results = []
  const firstMarket = Math.floor(nowMs / MARKET_ROTATION_MS) % DIRECT_FLOW_MARKETS.length
  for (let offset = 0; offset < DIRECT_FLOW_MARKETS.length; offset++) {
    const market = DIRECT_FLOW_MARKETS[(firstMarket + offset) % DIRECT_FLOW_MARKETS.length]
    let phase = 'start'
    try {
      const start =
        market.fromBlock === 'fresh_finalized_anchor'
          ? freshStart({ outDir, frozen, nowMs })
          : { fromBlock: market.fromBlock, firstBlockHash: null }
      phase = 'backfill'
      const result = await backfill({
        marketKey: market.marketKey,
        fromBlock: start.fromBlock,
        ...(market.marketKey === 'aaveV3Usde'
          ? { expectedFirstBlockHash: start.firstBlockHash }
          : {}),
        toBlock: frozen.targetBlock,
        outDir,
        maxSegments: maxSegmentsPerMarket,
        rpcUrls: frozen.rpcUrls,
        clientFactory,
      })
      fail(
        result.marketKey === market.marketKey &&
          ['complete', 'budget_reached'].includes(result.status) &&
          Number.isSafeInteger(result.throughBlock) &&
          result.throughBlock <= frozen.targetBlock &&
          Number.isSafeInteger(result.newSegments) &&
          result.newSegments >= 0 &&
          result.newSegments <= maxSegmentsPerMarket,
        'invalid_direct_tick_result',
      )
      results.push({
        marketKey: market.marketKey,
        status: result.status,
        throughBlock: result.throughBlock,
        newSegments: result.newSegments,
      })
    } catch (error) {
      const errorCode = safeDirectFlowErrorCode(error)
      const sourceClass = /^[a-z0-9_]{1,24}$/.test(error?.diagnosticClass ?? '')
        ? error.diagnosticClass
        : 'none'
      results.push({
        marketKey: market.marketKey,
        status: 'failed',
        phase,
        errorCode,
        sourceClass,
        retryable: errorCode === 'direct_segment_unavailable',
      })
    }
  }
  return { targetBlock: frozen.targetBlock, originCount: frozen.originCount, results }
}

async function main() {
  fail(process.argv.length === 2, 'invalid_direct_tick_options')
  const supplementalCap = process.env.DIRECT_FLOW_MAX_SEGMENTS_PER_MARKET_TICK
  const maxSegmentsPerMarket =
    supplementalCap === undefined ? MAX_SEGMENTS_PER_MARKET_TICK : Number(supplementalCap)
  fail(
    Number.isSafeInteger(maxSegmentsPerMarket) &&
      maxSegmentsPerMarket >= 1 &&
      maxSegmentsPerMarket <= MAX_SEGMENTS_PER_MARKET_TICK,
    'invalid_direct_tick_options',
  )
  const local = !process.env.RECORDER_RPC_URLS && !process.env.RECORDER_RPC_URL ? readEnv() : null
  const rpcUrls =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    local?.get('RECORDER_RPC_URLS') ||
    local?.get('RECORDER_RPC_URL')
  const result = await recordDirectSupplierFlowTick({ rpcUrls, maxSegmentsPerMarket })
  // The evidence files are authoritative. Persistent logs get a fixed code only.
  if (process.env.DIRECT_FLOW_DIAGNOSTIC === '1') {
    process.stdout.write(
      `direct_supplier_flow_target:${result.targetBlock}:${result.originCount}\n`,
    )
    for (const entry of result.results)
      process.stdout.write(
        `direct_supplier_flow_market:${entry.marketKey}:${entry.status}:${entry.phase ?? 'done'}:${entry.throughBlock ?? 0}:${entry.newSegments ?? 0}:${entry.errorCode ?? 'none'}:${entry.sourceClass ?? 'none'}:${entry.retryable ? 1 : 0}\n`,
      )
  }
  if (result.results.some((entry) => entry.status === 'failed')) {
    process.stderr.write('direct_supplier_flow_tick_market_failed\n')
    process.exitCode = 1
  } else {
    process.stdout.write('direct_supplier_flow_tick_ok\n')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code =
      process.env.DIRECT_FLOW_DIAGNOSTIC === '1' ? `:${safeDirectFlowErrorCode(error)}` : ''
    process.stderr.write(`direct_supplier_flow_tick_failed${code}\n`)
    process.exitCode = 1
  })
}
