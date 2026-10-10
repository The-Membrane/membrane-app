// Native prospective gross supplier deposit capture for the four frozen direct
// Carry markets. Independent of withdrawal receipts and the private forecast DB.
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
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeClient, readEnv } from './lib/venue-reads.mjs'
import {
  backfillDirectSupplierFlow,
  MIN_FREE_BYTES,
} from './research/backfill-carry-direct-supplier-flow.mjs'
import { DIRECT_FLOW_DIR, freezeDirectFlowTarget } from './record-carry-direct-supplier-flow.mjs'

export const SUPPLY_MARKETS = Object.freeze([
  'aaveV3Usdc',
  'aaveV3Usde',
  'sparkLendUsdt',
  'compoundV3Usdc',
])
export const MAX_SUPPLY_SEGMENTS_PER_MARKET_TICK = 2
const MARKET_ROTATION_MS = 15 * 60_000
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const fail = (okay, code) => {
  if (!okay) throw new Error(code)
}
const seal = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const anchorName = (marketKey) => `supply-start-${marketKey}.json`

function diskReserve(outDir, stat = statfsSync) {
  const space = stat(outDir)
  fail(Number(space.bavail) * Number(space.bsize) >= MIN_FREE_BYTES, 'direct_supply_disk_reserve')
}

/** A market enrolls once at a corroborated finalized frontier. Never backdate. */
export function freshSupplyFlowStart({ marketKey, outDir, frozen, nowMs, stat = statfsSync }) {
  fail(SUPPLY_MARKETS.includes(marketKey), 'unsupported_direct_market')
  const path = join(outDir, anchorName(marketKey))
  const readAnchor = () => {
    const file = lstatSync(path)
    fail(file.isFile() && file.size > 0 && file.size <= 4096, 'invalid_direct_supply_anchor')
    let row
    try {
      row = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw Error('invalid_direct_supply_anchor')
    }
    const { sha256, ...body } = row
    fail(
      body.schema === 'carry_direct_supplier_supply_start_v1' &&
        body.marketKey === marketKey &&
        Number.isSafeInteger(body.fromBlock) &&
        body.fromBlock > 1 &&
        HASH.test(body.firstBlockHash) &&
        Number.isSafeInteger(body.firstBlockAtMs) &&
        Number.isSafeInteger(body.operatorRecordedAtMs) &&
        body.operatorRecordedAtMs >= body.firstBlockAtMs &&
        body.operatorRecordedAtMs - body.firstBlockAtMs <= 2 * 60 * 60 * 1000 &&
        body.fromBlock <= frozen.targetBlock &&
        SHA.test(sha256) &&
        seal(body) === sha256,
      'invalid_direct_supply_anchor',
    )
    return { fromBlock: body.fromBlock, firstBlockHash: body.firstBlockHash }
  }
  try {
    return readAnchor()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  fail(
    !readdirSync(outDir).some((name) =>
      new RegExp(`^supply-${marketKey}-[0-9]+-[0-9]+\\.json$`).test(name),
    ),
    'unanchored_direct_supply_segments',
  )
  fail(
    Number.isSafeInteger(frozen.targetBlock) &&
      frozen.targetBlock > 1 &&
      HASH.test(frozen.targetHash) &&
      Number.isSafeInteger(frozen.targetAtMs) &&
      frozen.targetAtMs <= nowMs &&
      nowMs - frozen.targetAtMs <= 2 * 60 * 60 * 1000,
    'invalid_direct_supply_frontier',
  )
  diskReserve(outDir, stat)
  const body = {
    schema: 'carry_direct_supplier_supply_start_v1',
    marketKey,
    fromBlock: frozen.targetBlock,
    firstBlockHash: frozen.targetHash,
    firstBlockAtMs: frozen.targetAtMs,
    operatorRecordedAtMs: nowMs,
  }
  const stage = join(outDir, `.direct-supply-start-${randomUUID()}.tmp`)
  let fd = null
  try {
    fd = openSync(
      stage,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o444,
    )
    writeFileSync(fd, `${JSON.stringify({ ...body, sha256: seal(body) })}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    try {
      linkSync(stage, path)
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
      unlinkSync(stage)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return readAnchor()
}

export async function recordDirectSupplierSupplyTick({
  rpcUrls,
  outDir = DIRECT_FLOW_DIR,
  clientFactory = makeClient,
  backfill = backfillDirectSupplierFlow,
  freshStart = freshSupplyFlowStart,
  nowMs = Date.now(),
  stat = statfsSync,
}) {
  diskReserve(outDir, stat)
  const frozen = await freezeDirectFlowTarget({ rpcUrls, clientFactory, nowMs })
  const results = []
  const firstMarket = Math.floor(nowMs / MARKET_ROTATION_MS) % SUPPLY_MARKETS.length
  for (let offset = 0; offset < SUPPLY_MARKETS.length; offset++) {
    const marketKey = SUPPLY_MARKETS[(firstMarket + offset) % SUPPLY_MARKETS.length]
    try {
      diskReserve(outDir, stat)
      const start = freshStart({ marketKey, outDir, frozen, nowMs, stat })
      const result = await backfill({
        marketKey,
        flowKind: 'supply',
        fromBlock: start.fromBlock,
        expectedFirstBlockHash: start.firstBlockHash,
        toBlock: frozen.targetBlock,
        outDir,
        maxSegments: MAX_SUPPLY_SEGMENTS_PER_MARKET_TICK,
        rpcUrls: frozen.rpcUrls,
        clientFactory,
        stat,
      })
      fail(
        result.marketKey === marketKey &&
          result.flowKind === 'supply' &&
          ['complete', 'budget_reached'].includes(result.status) &&
          Number.isSafeInteger(result.throughBlock) &&
          result.throughBlock <= frozen.targetBlock &&
          Number.isSafeInteger(result.newSegments) &&
          result.newSegments >= 0 &&
          result.newSegments <= MAX_SUPPLY_SEGMENTS_PER_MARKET_TICK,
        'invalid_direct_supply_tick_result',
      )
      results.push({
        marketKey,
        status: result.status,
        throughBlock: result.throughBlock,
        newSegments: result.newSegments,
      })
    } catch {
      // One venue's incomplete source does not stop the other three.
      results.push({ marketKey, status: 'failed' })
    }
  }
  return { targetBlock: frozen.targetBlock, originCount: frozen.originCount, results }
}

async function main() {
  fail(process.argv.length === 2, 'invalid_direct_supply_tick_options')
  const local = !process.env.RECORDER_RPC_URLS && !process.env.RECORDER_RPC_URL ? readEnv() : null
  const rpcUrls =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    local?.get('RECORDER_RPC_URLS') ||
    local?.get('RECORDER_RPC_URL')
  const result = await recordDirectSupplierSupplyTick({ rpcUrls })
  if (result.results.some((row) => row.status === 'failed')) {
    process.stderr.write('direct_supplier_supply_tick_market_failed\n')
    process.exitCode = 1
  } else process.stdout.write('direct_supplier_supply_tick_ok\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('direct_supplier_supply_tick_failed\n')
    process.exitCode = 1
  })
}
