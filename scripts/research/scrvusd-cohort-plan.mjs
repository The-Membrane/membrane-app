// One immutable, prospective multi-holder size roster. No outcome calls.
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
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import { OUT as SEED_OUT, SIZES, seedName, validateReceipt } from './scrvusd-cohort-seed.mjs'
import { OUT as PILOT_OUT, readPlan as readPilotPlan } from './scrvusd-fixed-holder-exit.mjs'
import {
  OUT as PILOT_SELECTION_OUT,
  verify as verifyPilotSelection,
} from './scrvusd-holder-selection-link.mjs'

export const STUDY = 'scrvusd-cohort-plan-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-cohort-plan')
const RESERVE_BYTES = 1_073_741_824
const SHA = /^[0-9a-f]{64}$/
const CAVEAT =
  'Local plan time is an operator attestation, not independent timestamp proof. First-page holders, overlapping q sizes and one shared vault are dependent; no census, executable outcome, or calibrated probability.'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const unsigned = ({ sha256: _sha256, ...body }) => body
const checkpointRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.checkpoint.sha256,
  physicalSha256: row.physicalSha256,
  block: row.checkpoint.block,
})
const ref = (filename, logicalSha256, bytes) => ({
  filename,
  logicalSha256,
  physicalSha256: sha(bytes),
})

export function readSources({
  seedOut = SEED_OUT,
  quoteOut = QUOTE_OUT,
  pilotOut = PILOT_OUT,
  pilotSelectionOut = PILOT_SELECTION_OUT,
  identity = sourceIdentity(),
  seedFilename,
  nowMs = Date.now(),
} = {}) {
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  if (seedFilename && !/^[0-9]{12}-[0-9a-f]{64}-[0-9]+\.json$/.test(seedFilename))
    throw new Error('Invalid seed filename')
  if (!existsSync(seedOut)) throw new Error('Missing seed')
  const names = readdirSync(seedOut)
    .filter((n) => n.endsWith('.json'))
    .sort()
  if (names.length !== 1 || (seedFilename && seedFilename !== names[0]))
    throw new Error('Exactly one cohort seed required')
  const seedBytes = readFileSync(join(seedOut, names[0])),
    seed = validateReceipt(JSON.parse(seedBytes), { identity, checkpoints, nowMs })
  if (names[0] !== seedName(seed) || !seedBytes.equals(Buffer.from(`${JSON.stringify(seed)}\n`)))
    throw new Error('Seed physical mismatch')
  const checkpoint = checkpoints.find(
    (r) => JSON.stringify(checkpointRef(r)) === JSON.stringify(seed.checkpoint),
  )
  if (!checkpoint) throw new Error('Missing checkpoint')
  const pilot = readPilotPlan({ out: pilotOut, identity }),
    pilotSelectionStatus = verifyPilotSelection({
      out: pilotSelectionOut,
      sourceOptions: { planOut: pilotOut, quoteOut, identity },
      nowMs,
    })
  if (
    !pilot ||
    pilotSelectionStatus.status !== 'verified' ||
    pilotSelectionStatus.holder !== pilot.holder
  )
    throw new Error('Old pilot selection not verified')
  const pilotBytes = readFileSync(join(pilotOut, 'plan.json')),
    pilotSelectionBytes = readFileSync(join(pilotSelectionOut, 'selection.json')),
    pilotSelection = JSON.parse(pilotSelectionBytes)
  if (
    !pilotBytes.equals(Buffer.from(`${JSON.stringify(pilot)}\n`)) ||
    !pilotSelectionBytes.equals(Buffer.from(`${JSON.stringify(pilotSelection)}\n`))
  )
    throw new Error('Old pilot physical mismatch')
  return {
    identity,
    checkpoints,
    checkpoint,
    seed,
    seedBytes,
    seedFilename: names[0],
    pilot,
    pilotBytes,
    pilotSelection,
    pilotSelectionBytes,
  }
}

export function makePlan({ sources, createdUtc = new Date().toISOString(), nowMs = Date.now() }) {
  const {
    identity,
    checkpoints,
    checkpoint,
    seed,
    seedBytes,
    seedFilename,
    pilot,
    pilotBytes,
    pilotSelection,
    pilotSelectionBytes,
  } = sources
  validateReceipt(seed, { identity, checkpoints, nowMs })
  const createdMs = Date.parse(createdUtc)
  if (
    !Number.isSafeInteger(createdMs) ||
    createdMs > nowMs ||
    createdMs < seed.captureEndMs ||
    createdMs < Date.parse(pilotSelection.capturedUtc) ||
    seed.captureStartMs < Date.parse(pilotSelection.capturedUtc) ||
    seedFilename !== seedName(seed) ||
    !seedBytes.equals(Buffer.from(`${JSON.stringify(seed)}\n`)) ||
    JSON.stringify(checkpointRef(checkpoint)) !== JSON.stringify(seed.checkpoint) ||
    Date.parse(checkpoint.checkpoint.captureEndUtc) > seed.captureStartMs ||
    !['sampled', 'no_eligible'].includes(seed.status) ||
    seed.results.some((r) => r.readError !== null) ||
    !SHA.test(checkpoint.physicalSha256) ||
    checkpoints.some(
      (r) =>
        r.checkpoint.block.number > checkpoint.checkpoint.block.number &&
        Date.parse(r.checkpoint.captureEndUtc) <= createdMs,
    )
  )
    throw new Error('Cohort plan not prospective or source complete')
  if (
    !pilotBytes.equals(Buffer.from(`${JSON.stringify(pilot)}\n`)) ||
    !pilotSelectionBytes.equals(Buffer.from(`${JSON.stringify(pilotSelection)}\n`)) ||
    pilot.holder !== pilotSelection.holder ||
    pilot.sha256 !== pilotSelection.plan.logicalSha256 ||
    sha(pilotBytes) !== pilotSelection.plan.physicalSha256
  )
    throw new Error('Old pilot exclusion mismatch')
  const strata = SIZES.map((q) => {
    const eligible = seed.eligible[q].filter((address) => address !== pilot.holder)
    const holders = eligible.slice(0, 5)
    return {
      rawCrvUsd: q,
      status: holders.length ? 'selected' : 'no_eligible',
      eligibleAfterExclusion: eligible.length,
      holders,
    }
  })
  return seal({
    study: STUDY,
    kind: 'prospective-multi-holder-size-plan',
    source: identity,
    createdUtc,
    seed: ref(seedFilename, seed.sha256, seedBytes),
    checkpoint: checkpointRef(checkpoint),
    excludedPilot: {
      holder: pilot.holder,
      plan: ref('plan.json', pilot.sha256, pilotBytes),
      selection: ref('selection.json', pilotSelection.sha256, pilotSelectionBytes),
    },
    sizesRaw: [...SIZES],
    strata,
    status: strata.some((row) => row.holders.length) ? 'selected' : 'no_eligible',
    caveat: CAVEAT,
  })
}

export function validatePlan(plan, { sources, nowMs = Date.now() } = {}) {
  if (
    !plan ||
    plan.sha256 !== sha(JSON.stringify(unsigned(plan))) ||
    typeof plan.seed?.filename !== 'string'
  )
    throw new Error('Plan seal mismatch')
  sources ??= readSources({ seedFilename: plan.seed.filename, nowMs })
  const expected = makePlan({ sources, createdUtc: plan.createdUtc, nowMs })
  if (JSON.stringify(plan) !== JSON.stringify(expected)) throw new Error('Cohort roster mismatch')
  return plan
}
export function readPlan({ out = OUT, sourceOptions = {}, nowMs = Date.now() } = {}) {
  const file = join(out, 'plan.json')
  if (!existsSync(file)) return null
  const bytes = readFileSync(file),
    plan = JSON.parse(bytes)
  const sources = readSources({ ...sourceOptions, seedFilename: plan.seed?.filename, nowMs })
  validatePlan(plan, { sources, nowMs })
  if (!bytes.equals(Buffer.from(`${JSON.stringify(plan)}\n`)))
    throw new Error('Plan physical mismatch')
  return plan
}
export function savePlan({ plan, sources, out = OUT, stat = statfsSync } = {}) {
  validatePlan(plan, { sources })
  const file = join(out, 'plan.json')
  if (existsSync(file)) throw new Error('Plan already exists')
  const bytes = `${JSON.stringify(plan)}\n`
  let ancestor = out
  while (!existsSync(ancestor)) {
    const p = dirname(ancestor)
    if (p === ancestor) throw new Error('No output ancestor')
    ancestor = p
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('Plan disk reserve')
  mkdirSync(out, { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(tmp, file)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
  return file
}
export function verify({ out = OUT, sourceOptions = {} } = {}) {
  const plan = readPlan({ out, sourceOptions })
  return plan
    ? {
        status: plan.status,
        sha256: plan.sha256,
        strata: plan.strata.map((s) => ({ rawCrvUsd: s.rawCrvUsd, count: s.holders.length })),
      }
    : { status: 'unavailable', reason: 'no_plan' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--verify'
    if (!['--run', '--verify'].includes(mode) || process.argv.length > 3)
      throw new Error('Invalid mode')
    if (mode === '--verify') console.log(JSON.stringify(verify()))
    else {
      if (readPlan()) throw new Error('Plan exists')
      const sources = readSources(),
        plan = makePlan({ sources }),
        file = savePlan({ plan, sources })
      console.log(
        JSON.stringify({
          status: plan.status,
          file,
          strata: plan.strata.map((s) => ({ rawCrvUsd: s.rawCrvUsd, count: s.holders.length })),
        }),
      )
    }
  } catch {
    console.error('[scrvusd-cohort-plan] unavailable')
    process.exitCode = 1
  }
}
