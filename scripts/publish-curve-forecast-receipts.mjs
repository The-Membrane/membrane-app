// Offline-first bridge from locally verified, sealed research receipts to Neon.
// Default: verify and preview. Only --publish opens a database connection.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readEnv } from './lib/venue-reads.mjs'
import {
  OUT as CHECKPOINT_OUT,
  readValidatedCheckpoints,
} from './research/curve-prospective-quote.mjs'
import {
  OUT as POINT_OUT,
  STUDY as POINT_STUDY,
  readHistorical as readPointHistorical,
  verifyIssues as verifyPointIssues,
} from './research/curve-prospective-forecast.mjs'
import {
  OUT as DURATION_OUT,
  STUDY as DURATION_STUDY,
  verifyIssues as verifyDurationIssues,
} from './research/curve-prospective-duration.mjs'

const SHA = /^[0-9a-f]{64}$/
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fields = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key] ?? null]))
const POINT_ISSUE = [
  'currentQuote',
  'reason',
  'projectedQuote',
  'empiricalAnalogInterval',
  'availableAnalogs',
  'selectedAnalogs',
  'caveats',
]
const DURATION_ISSUE = [
  'threshold',
  'currentQuote',
  'analog',
  'unconditional',
  'availablePastAnchors',
  'selectedAnalogs',
  'caveats',
]
const POINT_SCORE = [
  'targetAt',
  'endpointWindowSeconds',
  'maximumContinuousGapSeconds',
  'actualQuote',
  'endpointCheckpointSha256',
  'endpointPhysicalSha256',
  'forecastError',
  'persistenceError',
  'intervalCovered',
]
const DURATION_SCORE = [
  'targetAt',
  'endpointWindowSeconds',
  'maximumContinuousGapSeconds',
  'threshold',
  'stateAtHorizon',
  'breachInterval',
  'lastNotBelowAt',
  'previousObservation',
  'breachObservation',
  'gapNextObservation',
  'observedThrough',
  'caveat',
]

function utc(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error(`Invalid ${label}`)
  return new Date(value).toISOString()
}

export function receiptToRow({ bytes, filename, study, checkpoint }) {
  const artifact = JSON.parse(bytes.toString('utf8'))
  const isScore = filename.endsWith('.score.json')
  const kind = `${study === POINT_STUDY ? 'point' : 'duration'}_${isScore ? 'score' : 'issue'}`
  const issue = isScore ? checkpoint.issue : artifact
  const source = issue?.source
  const captured = checkpoint.checkpoint
  // The reader validates the original checkpoint seal. Early issue receipts
  // omitted its logical SHA; it is reconstructed only from the validated
  // checkpoint, never asserted to have been embedded in those old issues.
  const { sha256: savedCheckpointSha256, ...unsignedCheckpoint } = captured
  const checkpointSha256 = hash(JSON.stringify(unsignedCheckpoint))
  const content = { ...artifact }
  delete content.sha256
  if (
    ![POINT_STUDY, DURATION_STUDY].includes(study) ||
    (savedCheckpointSha256 !== undefined && savedCheckpointSha256 !== checkpointSha256) ||
    artifact.study !== `${study}${isScore ? '-score-v1' : ''}` ||
    !SHA.test(artifact?.sha256) ||
    hash(JSON.stringify(content)) !== artifact.sha256 ||
    (source?.checkpointSha256 !== undefined && source.checkpointSha256 !== checkpointSha256) ||
    !SHA.test(source?.checkpointPhysicalSha256) ||
    source.checkpointPhysicalSha256 !== checkpoint.physicalSha256 ||
    issue.block?.number !== captured.block.number ||
    issue.block?.hash !== captured.block.hash ||
    issue.block?.timestamp !== captured.block.timestamp ||
    !Number.isSafeInteger(issue.horizonHours) ||
    issue.horizonHours <= 0 ||
    (isScore &&
      (artifact.issueSha256 !== issue.sha256 ||
        artifact.horizonHours !== issue.horizonHours ||
        artifact.issueFilename !== filename.slice(0, -'.score.json'.length))) ||
    (!isScore && source.checkpointFilename !== checkpoint.filename)
  )
    throw new Error(`Invalid receipt provenance: ${filename}`)

  const captureStartAt = utc(captured.captureStartUtc, 'capture start')
  const captureEndAt = utc(captured.captureEndUtc, 'capture end')
  const issuedAt = utc(issue.issuedAtUtc, 'issue time')
  const sourceBlockAt = new Date(captured.block.timestamp * 1000).toISOString()
  if (
    Date.parse(sourceBlockAt) > Date.parse(captureStartAt) ||
    Date.parse(captureStartAt) > Date.parse(captureEndAt) ||
    Date.parse(captureEndAt) > Date.parse(issuedAt) ||
    Date.parse(issuedAt) >= (captured.block.timestamp + issue.horizonHours * 3600) * 1000
  )
    throw new Error(`Impossible receipt chronology: ${filename}`)

  const keys = isScore
    ? study === POINT_STUDY
      ? POINT_SCORE
      : DURATION_SCORE
    : study === POINT_STUDY
      ? POINT_ISSUE
      : DURATION_ISSUE
  // This allowlist excludes wallet/account data, RPC URLs, raw source rows and secrets.
  const payload = fields(artifact, keys)
  return {
    receiptKey: `${kind}:${filename}`,
    study: artifact.study,
    kind,
    status: artifact.status,
    horizonHours: issue.horizonHours,
    sourceBlock: captured.block.number,
    sourceBlockHash: captured.block.hash,
    sourceBlockAt,
    captureStartAt,
    captureEndAt,
    issuedAt,
    sourceCheckpointSha256: checkpointSha256,
    sourceCheckpointPhysicalSha256: checkpoint.physicalSha256,
    artifactSha256: artifact.sha256,
    artifactPhysicalSha256: hash(bytes),
    payload,
  }
}

function laneRows({ out, study, checkpoints }) {
  if (!existsSync(out)) return []
  const byCheckpoint = new Map(checkpoints.map((entry) => [entry.filename, entry]))
  const names = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const issueByName = new Map()
  const rows = []
  for (const filename of names.filter((name) => !name.endsWith('.score.json'))) {
    const bytes = readFileSync(join(out, filename))
    const issue = JSON.parse(bytes.toString('utf8'))
    const checkpoint = byCheckpoint.get(issue.source?.checkpointFilename)
    if (!checkpoint) throw new Error(`Missing checkpoint for ${filename}`)
    rows.push(receiptToRow({ bytes, filename, study, checkpoint }))
    issueByName.set(filename, { issue, checkpoint })
  }
  for (const filename of names.filter((name) => name.endsWith('.score.json'))) {
    const bytes = readFileSync(join(out, filename))
    const issueName = filename.slice(0, -'.score.json'.length)
    const matched = issueByName.get(issueName)
    if (!matched) throw new Error(`Missing issue for ${filename}`)
    rows.push(
      receiptToRow({
        bytes,
        filename,
        study,
        checkpoint: { ...matched.checkpoint, issue: matched.issue },
      }),
    )
  }
  return rows
}

export function collectVerifiedRows({
  checkpointOut = CHECKPOINT_OUT,
  pointOut = POINT_OUT,
  durationOut = DURATION_OUT,
} = {}) {
  const checkpoints = readValidatedCheckpoints({ out: checkpointOut })
  const pointHistory = readPointHistorical()
  const durationHistory = pointHistory
  verifyPointIssues({ out: pointOut, checkpoints, history: pointHistory })
  verifyDurationIssues({ out: durationOut, checkpoints, history: durationHistory })
  const rows = [
    ...laneRows({ out: pointOut, study: POINT_STUDY, checkpoints }),
    ...laneRows({ out: durationOut, study: DURATION_STUDY, checkpoints }),
  ]
  // Reverify after reading bytes, then check exact physical source again. Any
  // concurrent replacement must fail before opening Neon, not be published.
  const afterCheckpoints = readValidatedCheckpoints({ out: checkpointOut })
  if (JSON.stringify(checkpoints) !== JSON.stringify(afterCheckpoints))
    throw new Error('Checkpoint changed during publication preparation')
  verifyPointIssues({ out: pointOut, checkpoints, history: pointHistory })
  verifyDurationIssues({ out: durationOut, checkpoints, history: durationHistory })
  const reread = [
    ...laneRows({ out: pointOut, study: POINT_STUDY, checkpoints }),
    ...laneRows({ out: durationOut, study: DURATION_STUDY, checkpoints }),
  ]
  if (JSON.stringify(rows) !== JSON.stringify(reread))
    throw new Error('Receipt changed during publication preparation')
  return rows
}

export async function publishVerifiedRows({ collect = collectVerifiedRows, connect }) {
  const rows = collect() // No DB connection or write occurs before every local lane verifies.
  if (!rows.length) return { verified: 0, inserted: 0, existing: 0 }
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.sourceBlock}:${row.sourceBlockHash}:${row.sourceCheckpointSha256}:${row.sourceCheckpointPhysicalSha256}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const requiredIssues = [
    'point_issue:24',
    'point_issue:168',
    'duration_issue:24',
    'duration_issue:72',
    'duration_issue:168',
  ]
  for (const group of groups.values()) {
    const issues = group
      .filter((row) => row.kind.endsWith('_issue'))
      .map((row) => `${row.kind}:${row.horizonHours}`)
    if (
      issues.length !== requiredIssues.length ||
      issues.some((issue) => !requiredIssues.includes(issue)) ||
      new Set(issues).size !== requiredIssues.length
    )
      throw new Error('Incomplete forecast checkpoint issue group')
  }
  const sql = await connect()
  let inserted = 0
  // Neon HTTP transactions execute every query in a group atomically. A
  // failure on the fifth issue cannot leave a newer, partial API-visible group.
  for (const group of [...groups.values()].sort((a, b) => a[0].sourceBlock - b[0].sourceBlock)) {
    const results = await sql.transaction(
      group.map(
        (row) =>
          sql`SELECT public.publish_curve_forecast_receipt(${JSON.stringify(row)}::jsonb) AS inserted`,
      ),
    )
    if (
      !Array.isArray(results) ||
      results.length !== group.length ||
      results.some((result) => result.length !== 1 || typeof result[0]?.inserted !== 'boolean')
    )
      throw new Error('Invalid publication acknowledgment')
    inserted += results.reduce((count, result) => count + Number(result[0].inserted), 0)
  }
  return { verified: rows.length, inserted, existing: rows.length - inserted }
}

export function forecastPublishDatabaseUrl({ env = process.env, get } = {}) {
  const url =
    env.FORECAST_PUBLISH_DATABASE_URL || (get ?? readEnv().get)('FORECAST_PUBLISH_DATABASE_URL')
  if (!url) throw new Error('FORECAST_PUBLISH_DATABASE_URL is required')
  return url
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && !['--verify', '--publish'].includes(args[0])))
    throw new Error('Usage: publish-curve-forecast-receipts.mjs [--verify|--publish]')
  if (args[0] !== '--publish') {
    const rows = collectVerifiedRows()
    return {
      mode: 'verify',
      verified: rows.length,
      byKind: Object.fromEntries(
        ['point_issue', 'point_score', 'duration_issue', 'duration_score'].map((kind) => [
          kind,
          rows.filter((row) => row.kind === kind).length,
        ]),
      ),
    }
  }
  // Fail closed even when the verified local ledger is empty. A generic app
  // DATABASE_URL must never silently become the forecast publication role.
  const url = forecastPublishDatabaseUrl()
  return {
    mode: 'publish',
    ...(await publishVerifiedRows({
      connect: async () => {
        const { neon } = await import('@neondatabase/serverless')
        return neon(url)
      },
    })),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await main()))
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }))
    process.exitCode = 1
  }
}
