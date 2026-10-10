import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSnapshot, normalizeSeed } from './collector.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeCheckpoint(path, snapshot) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

export async function run(argv = process.argv.slice(2)) {
  if (argv.length !== 2 && (argv.length !== 4 || argv[2] !== '--route-id')) {
    throw new Error(
      'Usage: node scripts/route-cohort/run.mjs <seed.json> <snapshot.json> [--route-id "exact route label"]',
    )
  }
  const [seedPath, outputPath] = argv.slice(0, 2).map((path) => resolve(path))
  if (seedPath === outputPath) throw new Error('Input and output paths must differ')
  const seed = filterSeed(await loadJson(seedPath), argv[3])
  let checkpoint
  try {
    checkpoint = await loadJson(outputPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const rpc =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    readEnv().get('RECORDER_RPC_URLS') ||
    readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('RECORDER_RPC_URLS or RECORDER_RPC_URL is required')
  const snapshot = await collectSnapshot(makeClient(rpc), seed, {
    snapshot: checkpointForRun(checkpoint),
    onProgress: (progress) => writeCheckpoint(outputPath, progress),
  })
  process.stdout.write(
    JSON.stringify({
      output: outputPath,
      blockNumber: snapshot.blockNumber,
      asOf: snapshot.asOf,
      okCount: snapshot.okCount,
      unknownCount: snapshot.unknownCount,
      complete: snapshot.complete,
    }) + '\n',
  )
  if (!snapshot.complete) process.exitCode = 2
}

/** Retry an interrupted tick, but never allow an old block to masquerade as live. */
export function checkpointForRun(checkpoint, now = Date.now()) {
  if (!checkpoint || checkpoint.complete) return undefined
  const started = Date.parse(checkpoint.startedAt)
  if (!Number.isFinite(started) || now - started >= 60 * 60 * 1000 || started > now)
    return undefined
  return checkpoint
}

/** Keep full route identities on each holder row; this is a query subset, not attribution. */
export function filterSeed(seed, routeId) {
  if (routeId === undefined) return seed
  const positions = seed.positions.filter((position) => position.routeIds?.includes(routeId))
  if (positions.length === 0) throw new Error(`No seeded ERC-4626 positions for route: ${routeId}`)
  const filtered = { ...seed, selection: { routeId }, positions }
  normalizeSeed(filtered)
  return filtered
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
