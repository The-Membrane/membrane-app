// Fixed-q exit simulation immediately around the suspect allocator route changes.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import { probeExit } from './morpho-v2-exit-outcome-pilot.mjs'

export const STUDY = 'morpho-v2-route-switch-exit-check-v1'
export const ROUTES_SHA = '26ee816dfb68168a3cdc43d2a74b68c23688ad9beeb3e288c4e2da3de1b636da'
export const PRIMARY_SHA = '7fb48d74c07eb49d06ac133fd147dcef5d80885a19815cea4c58035a2aa9b6a4'
export const LADDER_SHA = 'f3df9691128f8b080a283df725bc9a9822c3b7f0f0d2c7e53dae2f22868ecf52'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const EXPECTED = [
  ['success', 'success'], ['evm-revert', 'evm-revert'],
  ['success', 'evm-revert'], ['evm-revert', 'evm-revert'],
  ['evm-revert', 'evm-revert'], ['success', 'success'],
]

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned route-check input SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function sources(paths) {
  const routes = pinned(paths.routesPath, ROUTES_SHA)
  const primary = pinned(paths.primaryPath, PRIMARY_SHA).results[15]
  const ladder = pinned(paths.ladderPath, LADDER_SHA).results[15]
  const stage1 = pinned(paths.stage1Path, STAGE1_SHA)
  if (routes.status !== 'complete' || routes.routeEvents?.length !== 2 ||
      routes.vault !== primary.anchor.vault || routes.vault !== ladder.vault ||
      primary.verdict !== 'plus24h-revert' || ladder.verdict !== 'new-1pct-revert')
    throw new Error('Frozen route-switch incident mismatch')
  return { routes, primary, ladder, stage1 }
}
function frozenBlocks(routes) {
  const first = routes.routeEvents[0].block, second = routes.routeEvents[1].block
  return [first - 1, first, 24_657_188, 24_660_732, second - 1, second]
}
export function verifyOffline(paths) {
  const { routes, primary, ladder } = sources(paths)
  const bytes = readFileSync(paths.out)
  const saved = JSON.parse(bytes)
  const blocks = frozenBlocks(routes)
  if (saved.study !== STUDY || saved.status !== 'complete' ||
      saved.routesSha256 !== ROUTES_SHA || saved.primarySha256 !== PRIMARY_SHA ||
      saved.ladderSha256 !== LADDER_SHA || saved.stage1Sha256 !== STAGE1_SHA ||
      saved.vault !== routes.vault || saved.samples?.length !== blocks.length)
    throw new Error('Route-switch checkpoint mismatch')
  for (let i = 0; i < blocks.length; i++) {
    const row = saved.samples[i]
    if (row.block !== blocks[i] || row.small.qAssets !== primary.anchor.qAssets ||
        row.large.qAssets !== ladder.qAssets || row.small.probe?.block !== blocks[i] ||
        row.large.probe?.block !== blocks[i] || row.small.probe?.hash !== row.large.probe?.hash ||
        row.small.probe?.timestamp !== row.timestamp || row.large.probe?.timestamp !== row.timestamp ||
        row.small.probe?.secondsFromExecutable !== row.timestamp - Number(primary.anchor.executableAt) ||
        row.large.probe?.secondsFromExecutable !== row.timestamp - Number(primary.anchor.executableAt) ||
        row.small.probe?.crossover !== null || row.large.probe?.crossover !== null ||
        row.small.probe?.status !== EXPECTED[i][0] || row.large.probe?.status !== EXPECTED[i][1])
      throw new Error('Route-switch sample mismatch')
    const route = routes.routeEvents.find((event) => event.block === blocks[i])
    if (route && row.small.probe.hash.toLowerCase() !== route.blockHash.toLowerCase())
      throw new Error('Route-switch block hash mismatch')
    for (const probe of [row.small.probe, row.large.probe])
      if (probe.status === 'evm-revert' && probe.errorChain?.[0]?.data?.slice(0, 10) !== '0xe450d38c')
        throw new Error('Route-switch revert reason mismatch')
  }
  return { checkpointSha256: sha(bytes), vault: saved.vault,
    samples: saved.samples.map((row) => ({ block: row.block, timestamp: row.timestamp,
      small: row.small.probe.status, large: row.large.probe.status,
      smallError: row.small.probe.errorChain?.[0]?.data?.slice(0, 10) || null,
      largeError: row.large.probe.errorChain?.[0]?.data?.slice(0, 10) || null })) }
}

export async function run({ client, ...paths }) {
  if (existsSync(paths.out)) return verifyOffline(paths)
  const { routes, primary, ladder, stage1 } = sources(paths)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const samples = []
  for (const block of frozenBlocks(routes)) {
    const raw = await client.getBlock({ blockNumber: BigInt(block) })
    const savedRoute = routes.routeStates.find((state) => state.block === block)
    if (savedRoute && savedRoute.blockHash.toLowerCase() !== raw.hash.toLowerCase())
      throw new Error('Historical route block hash mismatch')
    const header = { block, hash: raw.hash, timestamp: Number(raw.timestamp) }
    const simulate = async (qAssets) => ({ qAssets, probe: await probeExit({ client,
      vault: routes.vault, holder: primary.anchor.holder, q: qAssets, header,
      executableAt: primary.anchor.executableAt, stage1, anchorBlock: primary.anchor.anchorBlock, control: false }) })
    const small = await simulate(primary.anchor.qAssets)
    const large = await simulate(ladder.qAssets)
    samples.push({ block, timestamp: header.timestamp, small, large })
  }
  const value = { study: STUDY, status: 'complete', routesSha256: ROUTES_SHA,
    primarySha256: PRIMARY_SHA, ladderSha256: LADDER_SHA, stage1Sha256: STAGE1_SHA,
    vault: routes.vault, samples }
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 ** 2) throw new Error('Route-switch cache size cap reached')
  atomic(paths.out, value)
  return verifyOffline(paths)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-route-switch-exit-check.json'),
    routesPath: resolve('data/research/venue-signals/morpho-v2-first20-route-events.json'),
    primaryPath: resolve('data/research/venue-signals/morpho-v2-treated-exit-first20.json'),
    ladderPath: resolve('data/research/venue-signals/morpho-v2-size-ladder-first20.json'),
    stage1Path: resolve(`data/research/venue-signals/${STAGE1_SHA}.json`),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Route-switch exit check failed; no result was published.\n')
    process.exitCode = 1
  }
}
