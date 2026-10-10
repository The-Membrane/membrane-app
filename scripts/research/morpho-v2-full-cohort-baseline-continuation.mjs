// Versioned continuation of the immutable v1 mechanical baseline; no future outcomes.
// Dry by default. --run true seeds a distinct checkpoint and resumes rows 64..303.
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  FACTORY_SHA,
  guardDisk,
  MANIFEST_SHA,
  run as collectBaseline,
  selectAnchors,
  verifyCheckpoint,
} from './morpho-v2-full-cohort-baseline.mjs'

export const STUDY = 'morpho-v2-full-cohort-treated-baseline-continuation-v2'
export const VERSION = 2
export const SEED_SHA = '76f5c5654240c383c3553c098002cd7eb4a1166322da8be728bbf7952c54928c'
export const SEED_ROWS = 64
const BASE = resolve('data/research/venue-signals')
export const SEED_PATH = resolve(BASE, 'morpho-v2-full-cohort-baseline.json')
export const OUTPUT_PATH = resolve(BASE, 'morpho-v2-full-cohort-baseline-continuation-v2.json')
export const RAW_DIR = resolve(BASE, 'morpho-v2-full-cohort-baseline-raw')
export const MANIFEST_PATH = resolve(BASE, 'morpho-v2-full-cohort-manifest.json')
export const FACTORY_PATH = resolve(BASE, `${FACTORY_SHA}.json`)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const readPinned = (path, expected) => {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned source physical SHA mismatch')
  return JSON.parse(bytes)
}
const lineageUnsigned = ({ lineageSha256, ...rest }) => rest
const sealLineage = (value) => ({
  ...value,
  lineageSha256: sha(JSON.stringify(lineageUnsigned(value))),
})

export function verifySeed(seed, anchors) {
  verifyCheckpoint(seed, anchors)
  if (seed.results.length !== SEED_ROWS || seed.status !== 'partial')
    throw new Error('Seed is not the immutable first64 partial frontier')
  return seed
}

export function verifyContinuation(checkpoint, seed, anchors) {
  verifyCheckpoint(checkpoint, anchors)
  if (checkpoint.results.length < SEED_ROWS) throw new Error('Continuation is shorter than seed')
  for (let i = 0; i < SEED_ROWS; i++) {
    if (JSON.stringify(checkpoint.results[i]) !== JSON.stringify(seed.results[i]))
      throw new Error('Continuation seed prefix mismatch')
  }
  return checkpoint
}

function lineageFor(out, seed) {
  return sealLineage({
    study: STUDY,
    version: VERSION,
    chainId: 1,
    checkpointPath: resolve(out),
    collectorStudy: seed.study,
    seedPhysicalSha256: SEED_SHA,
    seedRows: SEED_ROWS,
    seedRowsSha256: sha(JSON.stringify(seed.results)),
    manifestSha256: MANIFEST_SHA,
    factorySha256: FACTORY_SHA,
    rawDir: RAW_DIR,
    interpretation: 'mechanical-baseline-only; signer-control-unproven; no-future-outcomes',
  })
}

export function verifyLineage(lineage, expected) {
  if (sha(JSON.stringify(lineageUnsigned(lineage))) !== lineage?.lineageSha256)
    throw new Error('Continuation lineage seal mismatch')
  if (JSON.stringify(lineage) !== JSON.stringify(expected))
    throw new Error('Continuation lineage/source identity mismatch')
  return lineage
}

function loadSources() {
  const anchors = selectAnchors(
    readPinned(MANIFEST_PATH, MANIFEST_SHA),
    readPinned(FACTORY_PATH, FACTORY_SHA),
  )
  const seed = verifySeed(readPinned(SEED_PATH, SEED_SHA), anchors)
  return { anchors, seed }
}

export async function continueBaseline({
  mode = 'dry',
  out = OUTPUT_PATH,
  maxAnchors = 304,
  client,
  collect = collectBaseline,
  diskGuard = guardDisk,
} = {}) {
  if (!['dry', 'verify', 'run'].includes(mode)) throw new Error('Invalid mode')
  if (!Number.isInteger(maxAnchors) || maxAnchors < SEED_ROWS || maxAnchors > 304)
    throw new Error('max-anchors must be 64..304')
  out = resolve(out)
  if (out === SEED_PATH || out === MANIFEST_PATH || out === FACTORY_PATH)
    throw new Error('Output may not overwrite a pinned source')
  const { anchors, seed } = loadSources()
  const expectedLineage = lineageFor(out, seed)
  const lineagePath = `${out}.lineage-v2.json`
  const hasOutput = existsSync(out)
  const hasLineage = existsSync(lineagePath)
  if (hasOutput) {
    const checkpoint = verifyContinuation(JSON.parse(readFileSync(out, 'utf8')), seed, anchors)
    if (hasLineage) verifyLineage(JSON.parse(readFileSync(lineagePath, 'utf8')), expectedLineage)
    else if (sha(readFileSync(out)) !== SEED_SHA)
      throw new Error('Existing continuation has no lineage and is not the exact seed')
    if (mode === 'dry') return { mode, completed: checkpoint.results.length, next: maxAnchors }
    if (mode === 'verify') {
      if (!hasLineage) throw new Error('Continuation lineage missing')
      return { mode, completed: checkpoint.results.length, checkpoint }
    }
  } else if (hasLineage) {
    throw new Error('Continuation lineage exists without checkpoint')
  } else if (mode === 'verify') {
    throw new Error('Continuation checkpoint missing')
  }
  if (mode === 'dry') return { mode, completed: SEED_ROWS, next: maxAnchors }
  if (!client) throw new Error('Missing RPC client')
  // Before any write or RPC, check that the archive guard remains satisfied.
  diskGuard(
    out,
    readFileSync(SEED_PATH).length + Buffer.byteLength(JSON.stringify(expectedLineage)),
  )
  if (!hasOutput) copyFileSync(SEED_PATH, out, constants.COPYFILE_EXCL)
  if (!hasLineage) {
    diskGuard(lineagePath, Buffer.byteLength(JSON.stringify(expectedLineage)))
    writeFileSync(lineagePath, JSON.stringify(expectedLineage), { flag: 'wx', mode: 0o600 })
  }
  const checkpoint = await collect({
    client,
    manifestPath: MANIFEST_PATH,
    factoryPath: FACTORY_PATH,
    out,
    rawDir: RAW_DIR,
    maxAnchors,
    legacyPath: resolve(BASE, 'morpho-v2-exit-baseline-first20.json'),
  })
  // The collector's v1 seal stays untouched; lineage is a separate versioned sidecar.
  verifyContinuation(checkpoint, seed, anchors)
  verifyLineage(JSON.parse(readFileSync(lineagePath, 'utf8')), expectedLineage)
  if (sha(readFileSync(SEED_PATH)) !== SEED_SHA)
    throw new Error('Immutable seed changed during continuation')
  return { mode, completed: checkpoint.results.length, checkpoint }
}

function options(args) {
  const opts = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --key value')
    opts[args[i].slice(2)] = args[i + 1]
  }
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2))
    if (opts.run && opts.verify) throw new Error('Conflicting modes')
    const mode = opts.run === 'true' ? 'run' : opts.verify === 'true' ? 'verify' : 'dry'
    const client =
      mode === 'run'
        ? makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
        : undefined
    const result = await continueBaseline({
      mode,
      client,
      out: opts.out || OUTPUT_PATH,
      maxAnchors: opts['max-anchors'] === undefined ? 304 : Number(opts['max-anchors']),
    })
    process.stdout.write(JSON.stringify({ ...result, checkpoint: undefined }) + '\n')
  } catch {
    // Provider errors can contain credential-bearing URLs.
    process.stderr.write('Baseline continuation stopped; source, RPC, or resource check failed.\n')
    process.exitCode = 1
  }
}
