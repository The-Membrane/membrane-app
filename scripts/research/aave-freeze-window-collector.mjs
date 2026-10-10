// Read-only, block-pinned Aave USDe cash collection for the three non-April
// q=$100m-eligible cross-reserve configuration incidents and matched controls.
// Collection timing/coverage is frozen in the logic module before outcomes.
// Usage: node scripts/research/aave-freeze-window-collector.mjs \
//   --out /private/tmp/aave-freeze-dense-windows-20260925.json
// Re-running resumes successful reads from --out; cached Aave dense/sparse rows
// are reused by exact block. No local Next server is started.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseAbiItem } from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  blockGrid,
  COLLECTION,
  collectionStatus,
  coverageFor,
  selectWindows,
} from './aave-freeze-window-collector-logic.mjs'

const opts = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, i, args) => (arg.startsWith('--') ? [[arg.slice(2), args[i + 1]]] : [])),
)
if (!opts.out) throw new Error('Pass an explicit --out path for the raw artifact')

const catalogDir = 'data/research/venue-signals'
const manifest = JSON.parse(readFileSync(`${catalogDir}/manifest.json`, 'utf8'))
const studyId = 'aave-freeze-incidents-400d'
const denseId = 'aave-usde-cash-mar-jun-2026'
const sparseId = 'aave-usde-cash-sparse-400d'
const sourceIds = [studyId, denseId, sparseId]
function loadCatalog(id) {
  const entry = manifest.artifacts[id]
  if (!entry?.file) throw new Error(`Missing catalog source ${id}`)
  const bytes = readFileSync(`${catalogDir}/${entry.file}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== entry.sha256) throw new Error(`Catalog source hash mismatch: ${id}`)
  const parsed = JSON.parse(bytes)
  if (parsed.status !== 'complete') throw new Error(`Incomplete source ${id}`)
  return { artifact: parsed, provenance: { id, file: entry.file, sha256 } }
}
const sources = Object.fromEntries(sourceIds.map((id) => [id, loadCatalog(id)]))
const study = sources[studyId].artifact
const aprilAt = 1776539039
const windows = selectWindows(study, { excludeAt: aprilAt })
const schedules = windows.map((window) => ({
  ...window,
  blocks: blockGrid(window.anchorBlock),
}))
const plannedBlocks = [...new Set(schedules.flatMap((window) => window.blocks))].sort(
  (a, b) => a - b,
)
const config = loadConfig().find((row) => row.name === 'aave-v3-usde' && row.enabled)
if (!config?.address || !config?.underlying) throw new Error('Aave USDe config missing')
if (
  sources[denseId].artifact.aToken.toLowerCase() !== config.address.toLowerCase() ||
  sources[sparseId].artifact.aToken.toLowerCase() !== config.address.toLowerCase() ||
  sources[denseId].artifact.underlying.toLowerCase() !== config.underlying.toLowerCase() ||
  sources[sparseId].artifact.underlying.toLowerCase() !== config.underlying.toLowerCase()
)
  throw new Error('Catalog Aave reserve identity mismatch')

const byBlock = new Map()
for (const id of [denseId, sparseId]) {
  for (const row of sources[id].artifact.rows) {
    if (!Number.isFinite(row.at) || !Number.isFinite(row.cash))
      throw new Error(`Invalid cached row in ${id}`)
    const earlier = byBlock.get(row.block)
    if (earlier && (earlier.at !== row.at || earlier.cash !== row.cash))
      throw new Error(`Cached cash conflict at block ${row.block}`)
    byBlock.set(row.block, {
      block: row.block,
      at: row.at,
      cash: row.cash,
      status: 'ok',
      origin: earlier?.origin ?? id,
    })
  }
}

const provenance = {
  chainId: 1,
  pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  aToken: config.address,
  underlying: config.underlying,
  cashSemantics:
    'USDe.balanceOf(aEthUSDe) / 1e18 at the pinned block; reserve-wide unencumbered cash, not wallet withdrawability',
  sources: sourceIds.map((id) => sources[id].provenance),
}
const signature = createHash('sha256')
  .update(JSON.stringify({ collection: COLLECTION, provenance, schedules }))
  .digest('hex')
if (existsSync(opts.out)) {
  const prior = JSON.parse(readFileSync(opts.out, 'utf8'))
  if (prior.signature !== signature || !Array.isArray(prior.uniqueRows))
    throw new Error('Existing output has a different fixed collection plan')
  for (const row of prior.uniqueRows) {
    if (row.status === 'ok' && !byBlock.has(row.block)) byBlock.set(row.block, row)
  }
}

const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
if (!rpc) throw new Error('Set RECORDER_RPC_URL or --rpc')
const client = makeClient(rpc)
const balanceAbi = [parseAbiItem('function balanceOf(address) view returns (uint256)')]
async function readPinned(block) {
  try {
    const [header, balance] = await Promise.all([
      client.getBlock({ blockNumber: BigInt(block) }),
      client.readContract({
        address: config.underlying,
        abi: balanceAbi,
        functionName: 'balanceOf',
        args: [config.address],
        blockNumber: BigInt(block),
      }),
    ])
    return {
      block,
      at: Number(header.timestamp),
      cash: Number(balance) / 1e18,
      cashRaw: balance.toString(),
      status: 'ok',
      origin: 'read-only archive RPC',
    }
  } catch (error) {
    return {
      block,
      status: 'failed',
      error: String(error?.shortMessage || error?.message || error).slice(0, 320),
    }
  }
}
function artifact(status) {
  const allWindows = schedules.map(({ blocks, ...window }) => {
    const rows = blocks.map(
      (block) => byBlock.get(block) ?? { block, status: 'failed', error: 'not attempted' },
    )
    return { ...window, rows, coverage: coverageFor(window, rows) }
  })
  return {
    study: 'Aave USDe dense pre-incident cash windows and matched controls',
    status,
    collection: COLLECTION,
    provenance,
    signature,
    rpcRange: { firstBlock: plannedBlocks[0], lastBlock: plannedBlocks.at(-1) },
    uniqueScheduledBlocks: plannedBlocks.length,
    uniqueRows: plannedBlocks.map(
      (block) => byBlock.get(block) ?? { block, status: 'failed', error: 'not attempted' },
    ),
    windows: allWindows,
  }
}
function save(status) {
  const tmp = `${opts.out}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(artifact(status)))
  renameSync(tmp, opts.out)
}

const missing = plannedBlocks.filter((block) => !byBlock.has(block))
for (let i = 0; i < missing.length; i += 4) {
  const batch = await Promise.all(missing.slice(i, i + 4).map(readPinned))
  for (const row of batch) byBlock.set(row.block, row)
  if (i % 40 === 0 || i + 4 >= missing.length) {
    save('partial')
    process.stderr.write(`Aave cash blocks ${Math.min(i + 4, missing.length)}/${missing.length}\n`)
  }
}
const candidate = artifact('partial')
const finalStatus = collectionStatus(candidate.windows)
const result = artifact(finalStatus)
save(finalStatus)
console.log(
  JSON.stringify({
    status: result.status,
    uniqueScheduledBlocks: result.uniqueScheduledBlocks,
    cached: result.uniqueRows.filter((row) => row.origin?.startsWith('aave-')).length,
    rpcRead: result.uniqueRows.filter((row) => row.origin === 'read-only archive RPC').length,
    failures: result.uniqueRows.filter((row) => row.status === 'failed').length,
    windows: result.windows.map((window) => ({
      kind: window.kind,
      incidentAt: window.incidentAt,
      ...window.coverage,
    })),
    rpcRange: result.rpcRange,
  }),
)
if (finalStatus !== 'complete') process.exitCode = 1
