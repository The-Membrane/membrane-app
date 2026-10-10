// Research only: prospective, level-only nominal $1m Curve quote analogs.
// No vault exit claim, calibrated probability, notification, or live RPC.
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
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactPath } from './local-artifacts.mjs'
import { OUT as QUOTES, readValidatedCheckpoints } from './curve-prospective-quote.mjs'

export const STUDY = 'curve-crvusd-secondary-prospective-level-forecast-v2'
export const OUT = resolve('data/research/venue-signals/curve-prospective-level-forecasts-v2')
export const HORIZONS = [24, 168]
const HISTORICAL_NAME = 'scrvusd-size-aware-400d'
const HISTORICAL_SHA = 'ad1ef837f8050fec53dadd220553168510a8227e83e0520b57185b122a16224a'
const HOUR = 3600
const GAP = 4 * HOUR
const TOLERANCE = 90 * 60
const MAX_LAG = 2 * HOUR
const K = 40
const MIN = 30
const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const unsigned = ({ sha256: _seal, ...value }) => value

export function readHistorical() {
  const path = artifactPath({ name: HISTORICAL_NAME })
  if (!path.endsWith(`/${HISTORICAL_SHA}.json`))
    throw new Error('Historical physical source mismatch')
  const bytes = readFileSync(path)
  if (sha(bytes) !== HISTORICAL_SHA) throw new Error('Historical physical SHA mismatch')
  const source = JSON.parse(bytes)
  if (source.rows?.length !== 3184) throw new Error('Historical row count changed')
  return source.rows.map((row) => ({
    at: row.at,
    block: row.block,
    quote: row.routes?.['1000000']?.bestQuote,
  }))
}

function checkRows(rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (
      !Number.isSafeInteger(row.at) ||
      !Number.isSafeInteger(row.block) ||
      !Number.isFinite(row.quote) ||
      row.quote < 0 ||
      (i && (row.at <= rows[i - 1].at || row.block <= rows[i - 1].block))
    )
      throw new Error('Invalid or nonmonotonic quote history')
  }
}

function rowOf(item) {
  const p = item.checkpoint
  return { at: p.block.timestamp, block: p.block.number, quote: p.routes?.['1000000']?.bestQuote }
}

function checkSources(history, checkpoints) {
  const rows = [...history, ...checkpoints.map(rowOf)]
  checkRows(rows)
  for (const item of checkpoints) {
    if (
      !/^[a-f0-9]{64}$/.test(item.physicalSha256) ||
      !/^[a-f0-9]{64}$/.test(item.checkpoint.sha256) ||
      !Number.isFinite(Date.parse(item.checkpoint.captureEndUtc)) ||
      Date.parse(item.checkpoint.captureEndUtc) < item.checkpoint.block.timestamp * 1000
    )
      throw new Error('Incomplete checkpoint source provenance')
  }
  return rows
}

function issueName(issue) {
  return `${String(issue.block.number).padStart(12, '0')}-${issue.block.hash.slice(2)}-${issue.horizonHours}h.json`
}

function immutableWrite(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function readSealed(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value?.sha256 !== sha(JSON.stringify(unsigned(value))))
    throw new Error('Artifact seal mismatch')
  return value
}

function quantile(sorted, p) {
  const at = (sorted.length - 1) * p
  const lo = Math.floor(at)
  return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo)
}

function outcome(rows, index, horizonHours, maxObservedAt = Infinity) {
  const target = rows[index].at + horizonHours * HOUR
  let best = -1
  for (let j = index + 1; j < rows.length && rows[j].at <= maxObservedAt; j++) {
    if (rows[j].at > target + TOLERANCE) break
    if (
      Math.abs(rows[j].at - target) <= TOLERANCE &&
      (best < 0 || Math.abs(rows[j].at - target) < Math.abs(rows[best].at - target))
    )
      best = j
  }
  if (best < 0) return { status: 'missing_target', target }
  for (let j = index + 1; j <= best; j++)
    if (rows[j].at - rows[j - 1].at > GAP) return { status: 'censored_gap', target, endpoint: best }
  return { status: 'observed', target, endpoint: best, quote: rows[best].quote }
}

export function buildIssue({ history, checkpoints, horizonHours, issuedAtUtc }) {
  if (!HORIZONS.includes(horizonHours)) throw new Error('Unsupported predeclared horizon')
  if (!checkpoints.length) throw new Error('No prospective checkpoint')
  const rows = checkSources(history, checkpoints)
  const item = checkpoints.at(-1)
  const anchor = rowOf(item)
  const issuedMs = Date.parse(issuedAtUtc)
  const capturedMs = Date.parse(item.checkpoint.captureEndUtc)
  if (
    !Number.isFinite(issuedMs) ||
    issuedMs < capturedMs ||
    issuedMs - capturedMs > MAX_LAG * 1000 ||
    issuedMs >= (anchor.at + horizonHours * HOUR - TOLERANCE) * 1000
  )
    throw new Error('Issue clock outside fresh prospective window')
  // A checkpoint whose capture completed after issue time is not a source, even if its block predates issue.
  if (checkpoints.some((entry) => Date.parse(entry.checkpoint.captureEndUtc) > issuedMs))
    throw new Error('Future checkpoint capture in issue prefix')
  const candidates = []
  for (let i = 0; i < rows.length - 1; i++) {
    const end = outcome(rows, i, horizonHours, Math.floor(issuedMs / 1000))
    if (rows[i].quote === 0 || end.status !== 'observed') continue
    const endItem =
      end.endpoint >= history.length ? checkpoints[end.endpoint - history.length] : null
    if (endItem && Date.parse(endItem.checkpoint.captureEndUtc) > issuedMs) continue
    candidates.push({
      index: i,
      distance: Math.abs(rows[i].quote - anchor.quote),
      delta: end.quote - rows[i].quote,
    })
  }
  candidates.sort((a, b) => a.distance - b.distance || b.index - a.index)
  const selected = candidates.slice(0, K)
  const deltas = selected.map((candidate) => candidate.delta).sort((a, b) => a - b)
  const available = candidates.length >= MIN && anchor.quote > 0
  return seal({
    study: STUDY,
    issuedAtUtc,
    source: {
      historicalName: HISTORICAL_NAME,
      historicalPhysicalSha256: HISTORICAL_SHA,
      checkpointFilename: item.filename,
      checkpointSha256: item.checkpoint.sha256,
      checkpointPhysicalSha256: item.physicalSha256,
      checkpointSourceIdentitySha256: item.checkpoint.source?.identitySha256,
    },
    block: item.checkpoint.block,
    horizonHours,
    currentQuote: anchor.quote,
    status: available ? 'research_forecast' : 'insufficient_sample',
    reason: available
      ? null
      : anchor.quote === 0
        ? 'zero_quote'
        : 'fewer_than_30_completed_analogs',
    availableAnalogs: candidates.length,
    selectedAnalogs: selected.length,
    projectedQuote: available ? anchor.quote + quantile(deltas, 0.5) : null,
    empiricalAnalogInterval: available
      ? [anchor.quote + quantile(deltas, 0.1), anchor.quote + quantile(deltas, 0.9)]
      : null,
    persistenceQuote: anchor.quote,
    method: {
      feature: 'current_quote_level_only',
      k: K,
      minimum: MIN,
      endpointToleranceSeconds: TOLERANCE,
      maximumGapSeconds: GAP,
    },
    caveats: [
      'Exploratory analog interval, not calibrated coverage or a probability.',
      'Nominal $1m two-pool get_dy quote; not a vault withdrawal or executable fill.',
      'USDT and USDC assumed at $1; gas, MEV, depeg, and route execution omitted.',
      'Dense historical analogs share regimes and are not independent episodes.',
    ],
  })
}

export function scoreIssue(issue, checkpoints, scoredAtUtc) {
  const scoredMs = Date.parse(scoredAtUtc)
  if (!Number.isFinite(scoredMs) || scoredMs < Date.parse(issue.issuedAtUtc))
    throw new Error('Invalid score time')
  const anchor = checkpoints.findIndex(
    (entry) => entry.filename === issue.source.checkpointFilename,
  )
  if (anchor < 0) throw new Error('Missing anchor checkpoint')
  const eligible = checkpoints
    .slice(0)
    .filter((entry) => Date.parse(entry.checkpoint.captureEndUtc) <= scoredMs)
  const target = issue.block.timestamp + issue.horizonHours * HOUR
  if (!eligible.length || eligible.at(-1).checkpoint.block.timestamp < target + TOLERANCE)
    return null
  const rows = eligible.map(rowOf)
  const result = outcome(rows, anchor, issue.horizonHours)
  const endpoint = result.status === 'observed' ? eligible[result.endpoint] : null
  return seal({
    study: `${STUDY}-score-v1`,
    issueFilename: issueName(issue),
    issueSha256: issue.sha256,
    scoredAtUtc,
    sourceFrontierFilename: eligible.at(-1).filename,
    sourceFrontierPhysicalSha256: eligible.at(-1).physicalSha256,
    horizonHours: issue.horizonHours,
    targetAt: target,
    status: result.status,
    actualQuote: endpoint ? result.quote : null,
    endpointCheckpointSha256: endpoint ? endpoint.checkpoint.sha256 : null,
    endpointPhysicalSha256: endpoint ? endpoint.physicalSha256 : null,
    forecastError:
      endpoint && issue.status === 'research_forecast' ? issue.projectedQuote - result.quote : null,
    persistenceError:
      endpoint && issue.status === 'research_forecast' ? issue.currentQuote - result.quote : null,
    intervalCovered:
      endpoint && issue.status === 'research_forecast'
        ? result.quote >= issue.empiricalAnalogInterval[0] &&
          result.quote <= issue.empiricalAnalogInterval[1]
        : null,
  })
}

export function verifyIssues({ history, checkpoints, out = OUT }) {
  checkSources(history, checkpoints)
  if (!existsSync(out)) return { issues: 0, scores: 0 }
  const byName = new Map(checkpoints.map((entry, index) => [entry.filename, index]))
  const issues = new Map()
  const files = readdirSync(out).filter((name) => name.endsWith('.json'))
  for (const filename of files.filter((name) => !name.endsWith('.score.json'))) {
    const saved = readSealed(join(out, filename))
    const index = byName.get(saved.source?.checkpointFilename)
    if (index === undefined || saved.study !== STUDY || filename !== issueName(saved))
      throw new Error('Issue identity mismatch')
    const expected = buildIssue({
      history,
      checkpoints: checkpoints.slice(0, index + 1),
      horizonHours: saved.horizonHours,
      issuedAtUtc: saved.issuedAtUtc,
    })
    if (JSON.stringify(saved) !== JSON.stringify(expected))
      throw new Error('Issue as-of replay mismatch')
    issues.set(filename, saved)
  }
  let scores = 0
  for (const filename of files.filter((name) => name.endsWith('.score.json'))) {
    const saved = readSealed(join(out, filename))
    const issue = issues.get(saved.issueFilename)
    if (!issue || filename !== `${saved.issueFilename}.score.json`)
      throw new Error('Score identity mismatch')
    const expected = scoreIssue(issue, checkpoints, saved.scoredAtUtc)
    if (!expected || JSON.stringify(saved) !== JSON.stringify(expected))
      throw new Error('Score as-of replay mismatch')
    scores++
  }
  return { issues: issues.size, scores }
}

export function issueLatest({ history, checkpoints, out = OUT, now = () => new Date() }) {
  verifyIssues({ history, checkpoints, out })
  if (!checkpoints.length) return { status: 'no_checkpoint' }
  const item = checkpoints.at(-1)
  const paths = HORIZONS.map((horizonHours) =>
    join(out, issueName({ block: item.checkpoint.block, horizonHours })),
  )
  if (paths.every(existsSync)) return { status: 'existing', paths }
  // A missing sibling cannot claim the first receipt's earlier issue time.
  if (paths.some(existsSync))
    return { status: 'partial_missing', block: item.checkpoint.block.number, paths }
  const issuedAtUtc = now().toISOString()
  const capturedMs = Date.parse(item.checkpoint.captureEndUtc)
  if (
    Date.parse(issuedAtUtc) < capturedMs ||
    Date.parse(issuedAtUtc) - capturedMs > MAX_LAG * 1000 ||
    Date.parse(issuedAtUtc) >=
      (item.checkpoint.block.timestamp + HORIZONS[0] * HOUR - TOLERANCE) * 1000
  )
    return { status: 'stale_missing', block: item.checkpoint.block.number }
  const values = HORIZONS.map((horizonHours) =>
    buildIssue({ history, checkpoints, horizonHours, issuedAtUtc }),
  )
  for (let i = 0; i < paths.length; i++) immutableWrite(paths[i], values[i])
  return { status: 'issued', paths }
}

export function scoreMatured({ history, checkpoints, out = OUT, now = () => new Date() }) {
  verifyIssues({ history, checkpoints, out })
  if (!existsSync(out)) return { written: 0, pending: 0 }
  let written = 0,
    pending = 0
  for (const filename of readdirSync(out).filter(
    (name) => name.endsWith('.json') && !name.endsWith('.score.json'),
  )) {
    const path = join(out, `${filename}.score.json`)
    if (existsSync(path)) continue
    const score = scoreIssue(readSealed(join(out, filename)), checkpoints, now().toISOString())
    if (!score) {
      pending++
      continue
    }
    immutableWrite(path, score)
    written++
  }
  return { written, pending }
}

function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && !['--issue', '--score', '--verify'].includes(args[0])))
    throw new Error('Usage: curve-prospective-level-forecast.mjs [--issue|--score|--verify]')
  const history = readHistorical()
  const checkpoints = readValidatedCheckpoints({ out: QUOTES })
  const result =
    args[0] === '--issue'
      ? issueLatest({ history, checkpoints })
      : args[0] === '--score'
        ? scoreMatured({ history, checkpoints })
        : {
            mode: args[0] === '--verify' ? 'verify' : 'dry',
            checkpoints: checkpoints.length,
            ...verifyIssues({ history, checkpoints }),
          }
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch {
    console.error('Prospective level forecast operation failed')
    process.exitCode = 1
  }
}
