// One prospective sUSDS holder/q selection certificate. No exit outcome is read here.
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
  OUT as CHECKPOINT_OUT,
} from './susds-finalized-checkpoint.mjs'
import { FIXED_Q_RAW, OUT as SEED_OUT, validateReceipt } from './susds-holder-seed.mjs'

export const STUDY = 'susds-holder-plan-v1'
export const OUT = resolve('data/research/venue-signals/susds-holder-plan')
const RESERVE_BYTES = 1_073_741_824
const SHA = /^[0-9a-f]{64}$/
const CAVEAT =
  'Local creation time is an operator attestation, not independent timestamp proof. One Blockscout first-page EOA sample is not a holder census or an executable exit outcome.'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ sha256: _sha256, ...rest }) => rest
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const seedName = (seed) =>
  `${String(seed.anchor.number).padStart(12, '0')}-${seed.anchor.hash.slice(2)}-${seed.captureEndMs}.json`
const checkpointRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.checkpoint.sha256,
  physicalSha256: row.physicalSha256,
  block: row.checkpoint.block,
  vaultCodeHash: row.checkpoint.contract.vaultCodeHash,
  implementation: row.checkpoint.contract.implementation,
  implementationCodeHash: row.checkpoint.contract.implementationCodeHash,
})

export function readSources({
  seedOut = SEED_OUT,
  checkpointOut = CHECKPOINT_OUT,
  identity = sourceIdentity(),
  seedFilename,
  nowMs = Date.now(),
} = {}) {
  const checkpoints = readValidatedCheckpoints({ out: checkpointOut, identity })
  if (seedFilename && !/^[0-9]{12}-[0-9a-f]{64}-[0-9]+\.json$/.test(seedFilename))
    throw new Error('Invalid seed filename')
  if (!existsSync(seedOut)) throw new Error('No holder seed')
  const names = readdirSync(seedOut)
    .filter((name) => name.endsWith('.json'))
    .sort()
  if (names.length !== 1 || (seedFilename && seedFilename !== names[0]))
    throw new Error('Expected exactly one holder seed')
  const filename = names[0]
  const seedBytes = readFileSync(join(seedOut, filename))
  const seed = validateReceipt(JSON.parse(seedBytes), { identity, checkpoints, nowMs })
  if (filename !== seedName(seed) || !seedBytes.equals(Buffer.from(`${JSON.stringify(seed)}\n`)))
    throw new Error('Holder seed physical file mismatch')
  const checkpoint = checkpoints.find((row) => row.filename === seed.checkpoint.filename)
  if (!checkpoint || JSON.stringify(checkpointRef(checkpoint)) !== JSON.stringify(seed.checkpoint))
    throw new Error('Holder seed checkpoint mismatch')
  return { identity, seed, seedBytes, seedFilename: filename, checkpoint, checkpoints }
}

export function makePlan({ sources, createdUtc = new Date().toISOString(), nowMs = Date.now() }) {
  const { identity, seed, seedBytes, seedFilename, checkpoint, checkpoints } = sources
  validateReceipt(seed, { identity, checkpoints, nowMs })
  if (
    seedFilename !== seedName(seed) ||
    !seedBytes.equals(Buffer.from(`${JSON.stringify(seed)}\n`)) ||
    JSON.stringify(checkpointRef(checkpoint)) !== JSON.stringify(seed.checkpoint)
  )
    throw new Error('Selection source bytes mismatch')
  const createdMs = Date.parse(createdUtc)
  const checkpointEndMs = Date.parse(checkpoint.checkpoint.captureEndUtc)
  if (
    !Number.isSafeInteger(createdMs) ||
    createdMs > nowMs ||
    seed.captureEndMs > createdMs ||
    checkpointEndMs > seed.captureStartMs ||
    !['sampled', 'no_eligible'].includes(seed.status) ||
    seed.results.some((row) => row.readError !== null) ||
    !SHA.test(checkpoint.physicalSha256) ||
    checkpoints.some(
      (row) =>
        row.checkpoint.block.number > checkpoint.checkpoint.block.number &&
        Date.parse(row.checkpoint.captureEndUtc) <= createdMs,
    )
  )
    throw new Error('Selection is not prospective or complete')
  const holder = seed.candidates[0] ?? null
  if ((seed.status === 'sampled') !== Boolean(holder))
    throw new Error('Inconsistent no-eligible selection')
  return seal({
    study: STUDY,
    kind: 'prospective-holder-selection',
    source: identity,
    createdUtc,
    seed: {
      filename: seedFilename,
      logicalSha256: seed.sha256,
      physicalSha256: sha(seedBytes),
    },
    checkpoint: checkpointRef(checkpoint),
    holder,
    rawUsds: FIXED_Q_RAW.toString(),
    status: holder ? 'selected' : 'no_eligible',
    caveat: CAVEAT,
  })
}

export function validatePlan(plan, { sources, nowMs = Date.now() } = {}) {
  if (!plan || plan.sha256 !== sha(JSON.stringify(unsigned(plan))))
    throw new Error('Plan SHA mismatch')
  if (!sources && typeof plan.seed?.filename !== 'string') throw new Error('Missing plan seed')
  sources ??= readSources({ seedFilename: plan.seed.filename, nowMs })
  const expected = makePlan({ sources, createdUtc: plan.createdUtc, nowMs })
  if (JSON.stringify(plan) !== JSON.stringify(expected)) throw new Error('Plan source mismatch')
  return plan
}

export function readPlan({ out = OUT, sourceOptions = {}, nowMs = Date.now() } = {}) {
  const path = join(out, 'plan.json')
  if (!existsSync(path)) return null
  const bytes = readFileSync(path)
  const plan = JSON.parse(bytes.toString('utf8'))
  const sources = readSources({ ...sourceOptions, seedFilename: plan.seed?.filename, nowMs })
  validatePlan(plan, { sources, nowMs })
  if (!bytes.equals(Buffer.from(`${JSON.stringify(plan)}\n`)))
    throw new Error('Plan physical file mismatch')
  return plan
}

export function savePlan({ plan, sources, out = OUT, stat = statfsSync } = {}) {
  validatePlan(plan, { sources })
  const file = join(out, 'plan.json')
  if (existsSync(file)) throw new Error('Holder plan already exists')
  const bytes = `${JSON.stringify(plan)}\n`
  let ancestor = out
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No output ancestor')
    ancestor = parent
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('Holder plan disk reserve reached')
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

export function verify({ out = OUT, sourceOptions = {} } = {}) {
  const plan = readPlan({ out, sourceOptions })
  if (!plan) return { status: 'unavailable', reason: 'no_plan' }
  return { status: plan.status, holder: plan.holder, rawUsds: plan.rawUsds, sha256: plan.sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--verify'
    if (!['--run', '--verify'].includes(mode) || process.argv.length > 3)
      throw new Error('Invalid mode')
    if (mode === '--verify') console.log(JSON.stringify(verify()))
    else {
      if (readPlan()) throw new Error('Plan already exists')
      const sources = readSources()
      const plan = makePlan({ sources })
      const file = savePlan({ plan, sources })
      console.log(
        JSON.stringify({ status: plan.status, file, holder: plan.holder, rawUsds: plan.rawUsds }),
      )
    }
  } catch {
    console.error('[susds-holder-plan] unavailable')
    process.exitCode = 1
  }
}
