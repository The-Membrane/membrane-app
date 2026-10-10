// Offline certificate that commits a prospective holder plan to its sampled seed.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  sourceIdentity,
  readValidatedCheckpoints,
  OUT as QUOTE_OUT,
} from './curve-prospective-quote.mjs'
import { OUT as PLAN_OUT, readPlan } from './scrvusd-fixed-holder-exit.mjs'
import { OUT as SEED_OUT, MIN_ASSETS_RAW, validateReceipt } from './scrvusd-index-holder-seed.mjs'

export const OUT = resolve('data/research/venue-signals/scrvusd-holder-selection-link')
export const STUDY = 'scrvusd-holder-selection-link-v1'
const RESERVE_BYTES = 1_073_741_824
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const unsigned = ({ sha256: _sha256, ...body }) => body
const seedName = (seed) =>
  `${String(seed.anchor.number).padStart(12, '0')}-${seed.anchor.hash.slice(2)}-${seed.captureEndMs}.json`

export function readSources({
  planOut = PLAN_OUT,
  seedOut = SEED_OUT,
  quoteOut = QUOTE_OUT,
  identity = sourceIdentity(),
  nowMs = Date.now(),
  seedFilename,
} = {}) {
  const plan = readPlan({ out: planOut, identity })
  if (!plan) throw new Error('Missing holder plan')
  const planBytes = readFileSync(join(planOut, 'plan.json'))
  if (seedFilename && !/^[0-9]{12}-[0-9a-f]{64}-[0-9]+\.json$/.test(seedFilename))
    throw new Error('Invalid seed filename')
  const seeds = seedFilename
    ? [seedFilename]
    : readdirSync(seedOut)
        .filter((name) => name.endsWith('.json'))
        .sort()
  const rows = seeds
    .map((name) => {
      const bytes = readFileSync(join(seedOut, name))
      const seed = validateReceipt(JSON.parse(bytes), { identity, nowMs })
      if (name !== seedName(seed)) throw new Error('Seed filename mismatch')
      return { name, bytes, seed }
    })
    .filter(
      ({ seed }) =>
        seed.candidates[0] === plan.holder && seed.captureEndMs <= Date.parse(plan.createdUtc),
    )
  if (rows.length !== 1) throw new Error('Expected exactly one matching seed')
  const { name, bytes, seed } = rows[0]
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  return { plan, planBytes, seed, seedBytes: bytes, seedFilename: name, checkpoints }
}

export function makeSelection({ sources, capturedUtc = new Date().toISOString() }) {
  const { plan, planBytes, seed, seedBytes, seedFilename, checkpoints } = sources
  const capturedMs = Date.parse(capturedUtc)
  const planMs = Date.parse(plan.createdUtc)
  if (
    !Number.isFinite(capturedMs) ||
    capturedMs < planMs ||
    capturedMs > Date.now() ||
    seed.status !== 'sampled' ||
    seed.results.some((row) => row.readError !== null) ||
    seed.candidates[0] !== plan.holder ||
    plan.rawCrvUsd !== MIN_ASSETS_RAW.toString() ||
    seed.captureEndMs > planMs ||
    checkpoints.some(
      (row) =>
        row.checkpoint.block.timestamp * 1000 >= planMs &&
        row.checkpoint.block.timestamp * 1000 <= capturedMs,
    )
  )
    throw new Error('Selection is not prospective or source-consistent')
  return seal({
    study: STUDY,
    kind: 'prospective-holder-selection',
    capturedUtc,
    plan: { filename: 'plan.json', logicalSha256: plan.sha256, physicalSha256: sha(planBytes) },
    seed: { filename: seedFilename, logicalSha256: seed.sha256, physicalSha256: sha(seedBytes) },
    holder: plan.holder,
    rawCrvUsd: plan.rawCrvUsd,
    caveat:
      'Local certificate time is an operator attestation, not an independent timestamp; seed is a first-page sample, not a holder census or executable outcome.',
  })
}

export function verify({ out = OUT, sources, sourceOptions = {}, nowMs = Date.now() } = {}) {
  const file = join(out, 'selection.json')
  if (!existsSync(file)) return { status: 'unavailable', reason: 'no_selection' }
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  if (!sources && typeof saved.seed?.filename !== 'string')
    throw new Error('Selection seed filename missing')
  sources ??= readSources({ ...sourceOptions, seedFilename: saved.seed?.filename, nowMs })
  const expected = makeSelection({ sources, capturedUtc: saved.capturedUtc })
  if (
    saved.sha256 !== sha(JSON.stringify(unsigned(saved))) ||
    JSON.stringify(saved) !== JSON.stringify(expected) ||
    Date.parse(saved.capturedUtc) > nowMs
  )
    throw new Error('Selection certificate mismatch')
  return {
    status: 'verified',
    sha256: saved.sha256,
    holder: saved.holder,
    capturedUtc: saved.capturedUtc,
  }
}

export function save({ out = OUT, selection, sources = readSources(), stat = statfsSync } = {}) {
  const expected = makeSelection({ sources, capturedUtc: selection.capturedUtc })
  if (JSON.stringify(selection) !== JSON.stringify(expected)) throw new Error('Invalid selection')
  const file = join(out, 'selection.json')
  if (existsSync(file)) throw new Error('Selection already exists')
  const bytes = `${JSON.stringify(selection)}\n`
  let ancestor = out
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No output ancestor')
    ancestor = parent
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('Selection disk reserve reached')
  mkdirSync(out, { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, file)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return file
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--dry'
    if (!['--dry', '--run', '--verify'].includes(mode) || process.argv.length > 3)
      throw new Error('Invalid mode')
    if (mode === '--verify') {
      const result = verify()
      if (result.status !== 'verified') throw new Error('Selection unavailable')
      console.log(JSON.stringify(result))
    } else {
      const sources = readSources()
      const selection = makeSelection({ sources })
      if (mode === '--run') save({ selection, sources })
      console.log(
        JSON.stringify({
          status: mode === '--run' ? 'saved' : 'dry',
          sha256: selection.sha256,
          holder: selection.holder,
          capturedUtc: selection.capturedUtc,
        }),
      )
    }
  } catch {
    console.error('holder_selection_link_failed')
    process.exitCode = 1
  }
}
