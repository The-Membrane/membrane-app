// Predeclared 1%-of-vault (holder-capped) secondary withdrawal-size comparison.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import { BASELINE_SHA, probeExit } from './morpho-v2-exit-outcome-pilot.mjs'

export const STUDY = 'morpho-v2-size-ladder-first20-v1'
export const PRIMARY_SHA = '7fb48d74c07eb49d06ac133fd147dcef5d80885a19815cea4c58035a2aa9b6a4'
export const BOUNDARY_SHA = 'ef634f845f4dc207b9d378bec2a6d1c75695f3ddc59e803978c39dc316b15223'
const MIN_FREE_BYTES = 2.5 * 1024 ** 3
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned study input SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
export function secondaryQ(baseline) {
  if (baseline.status !== 'baseline-success') return 0n
  const byVault = BigInt(baseline.totalAssets) / 100n
  const byHolder = BigInt(baseline.previewRedeemableAssets) / 10n
  return byVault < byHolder ? byVault : byHolder
}
export function classifySecondary(baselineProbe, laterProbe, expectedCode) {
  if (!baselineProbe || !laterProbe) return 'missing-probe'
  if (baselineProbe.runtimeCodeHash !== expectedCode || laterProbe.runtimeCodeHash !== expectedCode)
    return 'code-censored'
  const ordinary = new Set(['success', 'evm-revert'])
  if (!ordinary.has(baselineProbe.status) || !ordinary.has(laterProbe.status))
    return 'state-or-rpc-censored'
  if (baselineProbe.status === 'evm-revert') return 'preexisting-1pct-revert'
  return laterProbe.status === 'evm-revert' ? 'new-1pct-revert' : 'success-both'
}

function inputs(paths) {
  const baseline = pinned(paths.baselinePath, BASELINE_SHA)
  const primary = pinned(paths.primaryPath, PRIMARY_SHA)
  const boundary = pinned(paths.boundaryPath, BOUNDARY_SHA)
  const stage1 = pinned(paths.stage1Path, STAGE1_SHA)
  if (baseline.results?.length !== 20 || primary.results?.length !== 20 ||
      primary.status !== 'complete' || boundary.status !== 'complete' || boundary.rows?.length !== 18)
    throw new Error('Frozen first-20 inputs mismatch')
  return { baseline, primary, stage1 }
}

export function verifyOffline(paths) {
  const { baseline, primary } = inputs(paths)
  const bytes = readFileSync(paths.out)
  const saved = JSON.parse(bytes)
  if (saved.study !== STUDY || saved.status !== (saved.results?.length === 20 ? 'complete' : 'partial') ||
      saved.baselineSha256 !== BASELINE_SHA || saved.primarySha256 !== PRIMARY_SHA ||
      saved.boundarySha256 !== BOUNDARY_SHA || saved.stage1Sha256 !== STAGE1_SHA ||
      !Array.isArray(saved.results) || saved.results.length > 20)
    throw new Error('Size-ladder checkpoint mismatch')
  for (let i = 0; i < saved.results.length; i++) {
    const row = saved.results[i], source = baseline.results[i], primaryRow = primary.results[i]
    if (row.vault !== source.vault || row.qAssets !== secondaryQ(source).toString() ||
        row.anchorBlock !== source.block || row.plus24hBlock !== primaryRow.probes.plus24h?.block ||
        row.verdict !== (row.qAssets === '0' ? 'baseline-excluded' : classifySecondary(row.baselineProbe, row.plus24hProbe, source.runtimeCodeHash)))
      throw new Error('Size-ladder row mismatch')
  }
  return { checkpointSha256: sha(bytes), status: saved.status, completed: saved.results.length,
    verdicts: saved.results.reduce((counts, row) => (counts[row.verdict] = (counts[row.verdict] || 0) + 1, counts), {}) }
}

export async function run({ client, ...paths }) {
  const { baseline, primary, stage1 } = inputs(paths)
  if (existsSync(paths.out)) verifyOffline(paths)
  let saved = existsSync(paths.out) ? JSON.parse(readFileSync(paths.out, 'utf8')) : {
    study: STUDY, status: 'partial', baselineSha256: BASELINE_SHA, primarySha256: PRIMARY_SHA,
    boundarySha256: BOUNDARY_SHA, stage1Sha256: STAGE1_SHA, results: [],
  }
  if (saved.status === 'complete') return verifyOffline(paths)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  for (let i = saved.results.length; i < 20; i++) {
    const disk = statfsSync(dirname(paths.out))
    if (Number(disk.bavail) * Number(disk.bsize) < MIN_FREE_BYTES) throw new Error('Disk reserve reached')
    const source = baseline.results[i], primaryRow = primary.results[i]
    const q = secondaryQ(source)
    let baselineProbe = null, plus24hProbe = null
    if (q > 0n) {
      const baselineHeader = await client.getBlock({ blockNumber: BigInt(source.preBlock) })
      const laterHeader = await client.getBlock({ blockNumber: BigInt(primaryRow.probes.plus24h.block) })
      if (baselineHeader.hash.toLowerCase() !== source.preBlockHash.toLowerCase() ||
          laterHeader.hash.toLowerCase() !== primaryRow.probes.plus24h.hash.toLowerCase())
        throw new Error('Historical block hash mismatch')
      const toHeader = (header) => ({ block: Number(header.number), hash: header.hash, timestamp: Number(header.timestamp) })
      baselineProbe = await probeExit({ client, vault: source.vault, holder: source.holder, q: q.toString(),
        header: toHeader(baselineHeader), executableAt: primaryRow.anchor.executableAt,
        stage1, anchorBlock: source.block, control: false })
      plus24hProbe = await probeExit({ client, vault: source.vault, holder: source.holder, q: q.toString(),
        header: toHeader(laterHeader), executableAt: primaryRow.anchor.executableAt,
        stage1, anchorBlock: source.block, control: false })
    }
    const result = { vault: source.vault, anchorBlock: source.block,
      plus24hBlock: primaryRow.probes.plus24h?.block, qAssets: q.toString(),
      baselineProbe, plus24hProbe,
      verdict: q === 0n ? 'baseline-excluded' : classifySecondary(baselineProbe, plus24hProbe, source.runtimeCodeHash),
    }
    saved = { ...saved, results: [...saved.results, result], status: i === 19 ? 'complete' : 'partial' }
    if (Buffer.byteLength(JSON.stringify(saved)) > 2 * 1024 ** 2) throw new Error('Checkpoint size cap reached')
    atomic(paths.out, saved)
    process.stdout.write(JSON.stringify({ completed: i + 1, verdict: result.verdict }) + '\n')
  }
  return verifyOffline(paths)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-size-ladder-first20.json'),
    baselinePath: resolve('data/research/venue-signals/morpho-v2-exit-baseline-first20.json'),
    primaryPath: resolve('data/research/venue-signals/morpho-v2-treated-exit-first20.json'),
    boundaryPath: resolve('data/research/venue-signals/morpho-v2-first20-boundary-proof.json'),
    stage1Path: resolve(`data/research/venue-signals/${STAGE1_SHA}.json`),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Size-ladder check stopped; checkpoint retained.\n')
    process.exitCode = 1
  }
}
