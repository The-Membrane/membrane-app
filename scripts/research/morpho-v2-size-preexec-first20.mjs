// Secondary-size pre-executable probe; separates early deterioration from post-timelock onset.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import { probeExit } from './morpho-v2-exit-outcome-pilot.mjs'

export const STUDY = 'morpho-v2-size-preexec-first20-v1'
export const LADDER_SHA = 'f3df9691128f8b080a283df725bc9a9822c3b7f0f0d2c7e53dae2f22868ecf52'
export const PRIMARY_SHA = '7fb48d74c07eb49d06ac133fd147dcef5d80885a19815cea4c58035a2aa9b6a4'
const MIN_FREE_BYTES = 2.5 * 1024 ** 3
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned input SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
export function onset(ladder, preExec) {
  if (ladder.qAssets === '0') return 'baseline-excluded'
  const before = ladder.baselineProbe?.status, middle = preExec?.status, after = ladder.plus24hProbe?.status
  if (![before, middle, after].every((status) => status === 'success' || status === 'evm-revert'))
    return 'state-or-rpc-censored'
  if (before === 'evm-revert') return 'preexisting'
  if (middle === 'evm-revert') return 'pre-executable-onset'
  if (after === 'evm-revert') return 'post-executable-onset'
  return 'success-through-plus24h'
}

function sources(paths) {
  const ladder = pinned(paths.ladderPath, LADDER_SHA)
  const primary = pinned(paths.primaryPath, PRIMARY_SHA)
  const stage1 = pinned(paths.stage1Path, STAGE1_SHA)
  if (ladder.status !== 'complete' || primary.status !== 'complete' ||
      ladder.results?.length !== 20 || primary.results?.length !== 20)
    throw new Error('Frozen secondary cohort mismatch')
  return { ladder, primary, stage1 }
}
export function verifyOffline(paths) {
  const { ladder, primary } = sources(paths)
  const bytes = readFileSync(paths.out)
  const saved = JSON.parse(bytes)
  if (saved.study !== STUDY || saved.ladderSha256 !== LADDER_SHA || saved.primarySha256 !== PRIMARY_SHA ||
      saved.stage1Sha256 !== STAGE1_SHA || !Array.isArray(saved.results) || saved.results.length > 20 ||
      saved.status !== (saved.results.length === 20 ? 'complete' : 'partial'))
    throw new Error('Pre-executable checkpoint mismatch')
  for (let i = 0; i < saved.results.length; i++) {
    const row = saved.results[i], source = ladder.results[i]
    if (row.vault !== source.vault || row.qAssets !== source.qAssets ||
        row.block !== primary.results[i].probes.preExecutable?.block ||
        row.probe?.hash !== primary.results[i].probes.preExecutable?.hash && row.qAssets !== '0' ||
        row.onset !== onset(source, row.probe))
      throw new Error('Pre-executable result mismatch')
  }
  return { checkpointSha256: sha(bytes), status: saved.status, completed: saved.results.length,
    onset: saved.results.reduce((counts, row) => (counts[row.onset] = (counts[row.onset] || 0) + 1, counts), {}) }
}

export async function run({ client, ...paths }) {
  const { ladder, primary, stage1 } = sources(paths)
  if (existsSync(paths.out)) verifyOffline(paths)
  let saved = existsSync(paths.out) ? JSON.parse(readFileSync(paths.out, 'utf8')) : {
    study: STUDY, ladderSha256: LADDER_SHA, primarySha256: PRIMARY_SHA,
    stage1Sha256: STAGE1_SHA, status: 'partial', results: [],
  }
  if (saved.status === 'complete') return verifyOffline(paths)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  for (let i = saved.results.length; i < 20; i++) {
    const disk = statfsSync(dirname(paths.out))
    if (Number(disk.bavail) * Number(disk.bsize) < MIN_FREE_BYTES) throw new Error('Disk reserve reached')
    const source = ladder.results[i], primaryRow = primary.results[i]
    let probe = null
    if (source.qAssets !== '0') {
      const reference = primaryRow.probes.preExecutable
      const block = await client.getBlock({ blockNumber: BigInt(reference.block) })
      if (block.hash.toLowerCase() !== reference.hash.toLowerCase()) throw new Error('Historical block hash mismatch')
      probe = await probeExit({ client, vault: source.vault, holder: primaryRow.anchor.holder,
        q: source.qAssets, header: { block: Number(block.number), hash: block.hash, timestamp: Number(block.timestamp) },
        executableAt: primaryRow.anchor.executableAt, stage1, anchorBlock: source.anchorBlock, control: false })
    }
    const row = { vault: source.vault, qAssets: source.qAssets,
      block: primaryRow.probes.preExecutable?.block, probe, onset: onset(source, probe) }
    saved = { ...saved, results: [...saved.results, row], status: i === 19 ? 'complete' : 'partial' }
    if (Buffer.byteLength(JSON.stringify(saved)) > 2 * 1024 ** 2) throw new Error('Checkpoint size cap reached')
    atomic(paths.out, saved)
    process.stdout.write(JSON.stringify({ completed: i + 1, onset: row.onset }) + '\n')
  }
  return verifyOffline(paths)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-size-preexec-first20.json'),
    ladderPath: resolve('data/research/venue-signals/morpho-v2-size-ladder-first20.json'),
    primaryPath: resolve('data/research/venue-signals/morpho-v2-treated-exit-first20.json'),
    stage1Path: resolve(`data/research/venue-signals/${STAGE1_SHA}.json`),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Pre-executable size check stopped; checkpoint retained.\n')
    process.exitCode = 1
  }
}
