// Offline, immutable NOW-origin receipt for the historical Morpho first64 panel.
// This module never invokes the RPC collector or weakens its disk reserve.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FACTORY_SHA } from './morpho-v2-full-cohort-baseline.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import { readSummary } from './morpho-v2-first64-duration-summary.mjs'

export const STUDY = 'morpho-exit-panel-snapshot-v3'
const LEGACY_STUDY = 'morpho-exit-panel-snapshot-v1'
const V2_STUDY = 'morpho-exit-panel-snapshot-v2'
const base = 'data/research/venue-signals/'
export const DEFAULT_PATHS = {
  treatedPath: `${base}morpho-v2-signer-baseline-v2.json`,
  manifestPath: `${base}morpho-v2-full-cohort-manifest.json`,
  factoryPath: `${base}${FACTORY_SHA}.json`,
  stage1Path: `${base}${STAGE1_SHA}.json`,
  out: `${base}morpho-v2-first64-treated-outcomes-v1.json`,
}
export const DEFAULT_DIR = `${base}morpho-exit-panel-snapshots`
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hash = (value) => typeof value === 'string' && /^[a-f\d]{64}$/.test(value)
const utc = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  new Date(value).toISOString() === value
const assert = (value, message) => {
  if (!value) throw new Error(message)
}
const sourceName = (physicalSha256) => `source-${physicalSha256}.json`
const receiptName = (physicalSha256, version = 3) =>
  version === 1 ? `snapshot-${physicalSha256}.json` : `snapshot-v${version}-${physicalSha256}.json`
const ancestryName = (name, physicalSha256) => `ancestry-${name}-${physicalSha256}.json`
const ancestryKeys = {
  treated: 'treatedPath',
  manifest: 'manifestPath',
  factory: 'factoryPath',
  stage1: 'stage1Path',
}

function seal(payload) {
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

function exclusiveBytes(path, bytes) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function inspect(paths) {
  const summary = readSummary(paths)
  const raw = readFileSync(paths.out)
  assert(sha(raw) === summary.outcomePhysicalSha256, 'Mutable source changed during summary read')
  assert(summary.forecast.status === 'unavailable', 'Historical snapshot cannot issue a forecast')
  assert(
    summary.counts.frozenRows === 64 && summary.counts.baselineEligible === 58,
    'Cohort changed',
  )
  const ancestryBytes = Object.fromEntries(
    Object.entries(ancestryKeys).map(([name, pathKey]) => {
      const bytes = readFileSync(paths[pathKey])
      assert(
        sha(bytes) === summary.sourcePhysicalSha256[name],
        `Ancestry ${name} changed during read`,
      )
      return [name, bytes]
    }),
  )
  return { summary, sourceBytes: raw, ancestryBytes }
}

// Dry inspection has no issue timestamp or seal; it cannot masquerade as an issued receipt.
export function preview({ paths = DEFAULT_PATHS, ...unsupported } = {}) {
  assert(Object.keys(unsupported).length === 0, 'Dry preview does not accept issue fields')
  const { summary } = inspect(paths)
  return { study: STUDY, status: 'dry-unissued', summary }
}

function buildReceipt({ summary, sourceBytes, paths, issuedAtUtc }) {
  return seal({
    study: STUDY,
    version: 3,
    issuedAtUtc,
    issueClock: 'local-operator-system-clock-claim',
    source: {
      filename: sourceName(summary.outcomePhysicalSha256),
      physicalSha256: summary.outcomePhysicalSha256,
      checkpointSha256: JSON.parse(sourceBytes).checkpointSha256,
      ancestryPhysicalSha256: summary.sourcePhysicalSha256,
      ancestryRefs: Object.fromEntries(
        Object.entries(ancestryKeys).map(([name, pathKey]) => [
          name,
          {
            filename: ancestryName(name, summary.sourcePhysicalSha256[name]),
            originalFilename: basename(paths[pathKey]),
            physicalSha256: summary.sourcePhysicalSha256[name],
          },
        ]),
      ),
    },
    evidenceScope: {
      chainId: 1,
      cohort: 'historical-first64-treated-only',
      route: 'simulated-same-holder-fixed-q-erc4626-withdraw',
      baselineClock: 'pre-block-B-minus-1',
      scheduledClock: 'first-eligible-executableAt-not-verified-execution',
      horizons: ['plus24h', 'plus7d'],
      prospectiveLead: 'unavailable',
      futureExitForecast: 'unavailable',
      arbitraryHorizonExtrapolation: 'unavailable',
    },
    summary,
  })
}

export function verifyReceipt({ filename, dir = DEFAULT_DIR, paths = DEFAULT_PATHS }) {
  assert(/^snapshot-(?:v[23]-)?[a-f\d]{64}\.json$/.test(filename), 'Invalid receipt filename')
  const bytes = readFileSync(join(dir, filename))
  const saved = JSON.parse(bytes)
  const { sha256, ...payload } = saved
  assert(sha256 === sha(JSON.stringify(payload)), 'Receipt logical seal mismatch')
  assert(bytes.equals(Buffer.from(`${JSON.stringify(saved)}\n`)), 'Receipt physical bytes changed')
  const legacy = saved.version === 1 && saved.study === LEGACY_STUDY
  assert(
    (legacy ||
      (saved.version === 2 && saved.study === V2_STUDY) ||
      (saved.version === 3 && saved.study === STUDY)) &&
      utc(saved.issuedAtUtc),
    'Invalid receipt',
  )
  const physical = saved.source?.physicalSha256
  assert(
    hash(physical) && filename === receiptName(physical, saved.version),
    'Receipt source identity changed',
  )
  assert(saved.source.filename === sourceName(physical), 'Source filename changed')
  const replayPaths = { ...paths, out: join(dir, saved.source.filename) }
  if (!legacy) {
    assert(saved.evidenceScope.chainId === 1, 'Chain identity changed')
    if (saved.version === 3)
      assert(saved.issueClock === 'local-operator-system-clock-claim', 'Issue clock label changed')
    for (const [name, pathKey] of Object.entries(ancestryKeys)) {
      const ref = saved.source.ancestryRefs?.[name]
      const expectedName =
        saved.version === 3
          ? ancestryName(name, saved.source.ancestryPhysicalSha256?.[name])
          : basename(paths[pathKey])
      const ancestryPath = saved.version === 3 ? join(dir, expectedName) : paths[pathKey]
      assert(
        ref?.filename === expectedName &&
          hash(ref.physicalSha256) &&
          ref.physicalSha256 === saved.source.ancestryPhysicalSha256?.[name],
        `Ancestry ${name} reference changed`,
      )
      if (saved.version === 3)
        assert(
          typeof ref.originalFilename === 'string' &&
            ref.originalFilename.length > 0 &&
            basename(ref.originalFilename) === ref.originalFilename,
          `Ancestry ${name} origin changed`,
        )
      assert(
        sha(readFileSync(ancestryPath)) === ref.physicalSha256,
        `Ancestry ${name} physical SHA changed`,
      )
      replayPaths[pathKey] = ancestryPath
    }
    assert(JSON.parse(readFileSync(replayPaths.stage1Path)).chainId === 1, 'Stage1 chain changed')
  }
  const sourceBytes = readFileSync(join(dir, saved.source.filename))
  assert(sha(sourceBytes) === physical, 'Copied checkpoint physical SHA mismatch')
  const raw = JSON.parse(sourceBytes)
  assert(
    raw.checkpointSha256 === saved.source.checkpointSha256,
    'Checkpoint seal reference changed',
  )
  const replay = readSummary(replayPaths)
  assert(
    JSON.stringify(replay) === JSON.stringify(saved.summary),
    'Snapshot summary differs from copied checkpoint replay',
  )
  assert(
    JSON.stringify(replay.sourcePhysicalSha256) ===
      JSON.stringify(saved.source.ancestryPhysicalSha256),
    'Ancestry reference changed',
  )
  assert(
    saved.evidenceScope.futureExitForecast === 'unavailable',
    'Historical forecast label changed',
  )
  return { filename, physicalSha256: sha(bytes), receipt: saved }
}

export function verifyAll({ dir = DEFAULT_DIR, paths = DEFAULT_PATHS } = {}) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.startsWith('snapshot-') && name.endsWith('.json'))
    .sort()
    .map((filename) => verifyReceipt({ filename, dir, paths }))
}

export function issue({ dir = DEFAULT_DIR, paths = DEFAULT_PATHS, ...unsupported } = {}) {
  assert(Object.keys(unsupported).length === 0, 'Issue timestamp is system controlled')
  const { summary, sourceBytes, ancestryBytes } = inspect(paths)
  mkdirSync(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(ancestryBytes)) {
    const physicalSha256 = summary.sourcePhysicalSha256[name]
    const copyPath = join(dir, ancestryName(name, physicalSha256))
    if (!existsSync(copyPath)) exclusiveBytes(copyPath, bytes)
    assert(sha(readFileSync(copyPath)) === physicalSha256, `Existing ancestry ${name} differs`)
  }
  const sourcePath = join(dir, sourceName(summary.outcomePhysicalSha256))
  if (!existsSync(sourcePath)) exclusiveBytes(sourcePath, sourceBytes)
  assert(sha(readFileSync(sourcePath)) === summary.outcomePhysicalSha256, 'Existing copy differs')
  const filename = receiptName(summary.outcomePhysicalSha256, 3)
  const receiptPath = join(dir, filename)
  if (existsSync(receiptPath))
    return { status: 'existing', ...verifyReceipt({ filename, dir, paths }) }
  const receipt = buildReceipt({
    summary,
    sourceBytes,
    paths,
    issuedAtUtc: new Date().toISOString(),
  })
  exclusiveBytes(receiptPath, Buffer.from(`${JSON.stringify(receipt)}\n`))
  return { status: 'issued', ...verifyReceipt({ filename, dir, paths }) }
}

export function readAsOf({ asOfUtc, dir = DEFAULT_DIR, paths = DEFAULT_PATHS } = {}) {
  assert(utc(asOfUtc), 'Invalid as-of UTC')
  if (!existsSync(dir)) return null
  const eligible = readdirSync(dir)
    .filter((name) => name.startsWith('snapshot-') && name.endsWith('.json'))
    .filter((name) => {
      const saved = JSON.parse(readFileSync(join(dir, name)))
      if (saved.version !== 3) return false
      assert(utc(saved.issuedAtUtc), 'Invalid receipt issue UTC')
      return saved.issuedAtUtc <= asOfUtc
    })
    .map((filename) => verifyReceipt({ filename, dir, paths }))
    .sort(
      (a, b) =>
        a.receipt.issuedAtUtc.localeCompare(b.receipt.issuedAtUtc) ||
        a.filename.localeCompare(b.filename),
    )
  return eligible.at(-1) ?? null
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--dry'
    assert(
      ['--dry', '--issue', '--verify'].includes(mode) && process.argv.length <= 3,
      'Usage: --dry | --issue | --verify',
    )
    const result = mode === '--verify' ? verifyAll() : mode === '--issue' ? issue() : preview()
    const snapshots = Array.isArray(result) ? result : [result]
    process.stdout.write(
      `${JSON.stringify(
        snapshots.map((item) => ({
          status: item.status ?? (mode === '--verify' ? 'verified' : 'dry'),
          filename: item.filename ?? null,
          issuedAtUtc: item.receipt?.issuedAtUtc ?? null,
          sourcePhysicalSha256:
            item.receipt?.source.physicalSha256 ?? item.summary.outcomePhysicalSha256,
          counts: item.receipt?.summary.counts ?? item.summary.counts,
          forecast: item.receipt?.summary.forecast.status ?? item.summary.forecast.status,
        })),
      )}\n`,
    )
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
