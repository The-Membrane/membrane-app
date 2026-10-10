// Prospective research forecasts of a nominal $1m crvUSD two-pool get_dy quote.
// Offline only. --run issues every still-fresh checkpoint; --score evaluates matured issues.
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
import { forecastAt, prepareSeries } from './curve-quote-forecast-backtest.mjs'
import { OUT as CHECKPOINTS, readValidatedCheckpoints } from './curve-prospective-quote.mjs'

export const STUDY = 'curve-crvusd-secondary-prospective-forecast-v1'
export const OUT = resolve('data/research/venue-signals/curve-prospective-forecasts')
export const HORIZONS = [24, 168]
const HISTORICAL_NAME = 'scrvusd-size-aware-400d'
const HISTORICAL_SHA = 'ad1ef837f8050fec53dadd220553168510a8227e83e0520b57185b122a16224a'
const HOUR = 3600
const GAP = 4 * HOUR
const TOLERANCE = 90 * 60
const MAX_ISSUE_LAG = 2 * HOUR
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ sha256: _seal, ...rest }) => rest
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
// Physical bytes of the four receipts issued before the checkpoint reader
// retained its logical seal. This is a closed migration set, not a format
// exception for future receipts.
const LEGACY_ISSUE_PHYSICAL_SHA256 = new Set([
  'a78a3372ecf3c7010bddd0eccd30bc57d0712e9b196e2348de69cf632d1f3df0',
  'd30742f9bee4fb8898e703496f049291164657da1c31e7d16920a3a8e9c0c2fc',
  '39b1a482f3392115e8a44b4941d45066995e292177fe2d50dbe4ab85f8e800db',
  '474fd530f584ba9cf160fe5cccdffb001baf46516629ac4aff13075d2df499b8',
])

export function readHistorical() {
  const path = artifactPath({ name: HISTORICAL_NAME })
  if (!path.endsWith(`/${HISTORICAL_SHA}.json`)) throw new Error('Unexpected historical source SHA')
  const source = JSON.parse(readFileSync(path, 'utf8'))
  if (source.rows?.length !== 3184) throw new Error('Historical row count changed')
  return source.rows
}

function quoteRow(item) {
  const { checkpoint: p } = item
  const quote = p.routes?.['1000000']?.bestQuote
  if (!Number.isFinite(quote) || quote < 0) throw new Error('Invalid checkpoint quote')
  return { at: p.block.timestamp, block: p.block.number, quote }
}

function issueName(issue) {
  return `${String(issue.block.number).padStart(12, '0')}-${issue.block.hash.slice(2)}-${issue.horizonHours}h.json`
}

function immutableWrite(path, payload) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(payload) + '\n', { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function checkChronology(history, checkpoints) {
  let at = history.at(-1)?.at ?? -Infinity
  let block = history.at(-1)?.block ?? -Infinity
  for (const item of checkpoints) {
    const p = item.checkpoint
    if (p.block.timestamp <= at || p.block.number <= block)
      throw new Error('Prospective checkpoint chronology overlaps or regresses')
    at = p.block.timestamp
    block = p.block.number
  }
}

export function buildIssue({ history, checkpoints, horizonHours, issuedAtUtc }) {
  if (!HORIZONS.includes(horizonHours)) throw new Error('Unsupported predeclared horizon')
  if (!checkpoints.length) throw new Error('No prospective checkpoint')
  checkChronology(history, checkpoints)
  const captured = checkpoints.at(-1)
  const p = captured.checkpoint
  const issueMs = Date.parse(issuedAtUtc)
  const captureEndMs = Date.parse(p.captureEndUtc)
  if (
    !Number.isFinite(issueMs) ||
    issueMs < captureEndMs ||
    issueMs - captureEndMs > MAX_ISSUE_LAG * 1000 ||
    issueMs >= (p.block.timestamp + horizonHours * HOUR - TOLERANCE) * 1000
  )
    throw new Error('Issue clock outside prospective issuance window')
  const rows = [...history, ...checkpoints.map(quoteRow)]
  const series = prepareSeries(rows, horizonHours)
  const result = forecastAt(series, rows.length - 1, { variant: 'quote' })
  return seal({
    study: STUDY,
    issuedAtUtc,
    source: {
      historicalName: HISTORICAL_NAME,
      historicalPhysicalSha256: HISTORICAL_SHA,
      checkpointStudy: p.study,
      checkpointSourceIdentitySha256: p.source.identitySha256,
      checkpointSha256: p.sha256,
      checkpointPhysicalSha256: captured.physicalSha256,
      checkpointFilename: captured.filename,
    },
    block: p.block,
    horizonHours,
    currentQuote: quoteRow(captured).quote,
    status: result.status,
    reason: result.reason ?? null,
    projectedQuote: result.projectedQuote ?? null,
    empiricalAnalogInterval: result.empiricalAnalogInterval ?? null,
    availableAnalogs: result.availableAnalogs ?? null,
    selectedAnalogs: result.selectedAnalogs ?? null,
    caveats: [
      'Nominal $1m get_dy quote only; not a vault withdrawal or executable fill.',
      'USDT and USDC assumed at $1; gas, MEV, depeg, and route execution omitted.',
      'Analog p10-p90 range is uncalibrated and is not a probability or alert.',
      'Forecast uses only sealed observations and completed historical analog outcomes available by this checkpoint.',
    ],
  })
}

function readSealed(path) {
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (saved?.sha256 !== sha(JSON.stringify(unsigned(saved))))
    throw new Error('Forecast artifact SHA mismatch')
  return saved
}

export function verifyIssues({ out = OUT, checkpoints, history }) {
  if (!existsSync(out)) return { issues: 0, scores: 0 }
  checkChronology(history, checkpoints)
  const byFilename = new Map(checkpoints.map((item, i) => [item.filename, i]))
  const issued = new Map()
  let issues = 0,
    scores = 0
  const filenames = readdirSync(out).filter((name) => name.endsWith('.json'))
  for (const filename of filenames.filter((name) => !name.endsWith('.score.json'))) {
    const path = join(out, filename)
    const saved = readSealed(path)
    const legacy = !Object.hasOwn(saved.source ?? {}, 'checkpointSha256')
    if (legacy && !LEGACY_ISSUE_PHYSICAL_SHA256.has(sha(readFileSync(path))))
      throw new Error('Unrecognized legacy issue physical seal')
    const index = byFilename.get(saved.source?.checkpointFilename)
    if (index === undefined || saved.study !== STUDY || filename !== issueName(saved))
      throw new Error('Issue checkpoint identity or filename mismatch')
    const captured = checkpoints[index]
    if (
      saved.source.checkpointPhysicalSha256 !== captured.physicalSha256 ||
      (!legacy && saved.source.checkpointSha256 !== captured.checkpoint.sha256) ||
      saved.block.hash !== captured.checkpoint.block.hash ||
      saved.currentQuote !== quoteRow(captured).quote ||
      !HORIZONS.includes(saved.horizonHours) ||
      Date.parse(saved.issuedAtUtc) < Date.parse(captured.checkpoint.captureEndUtc)
    )
      throw new Error('Issue provenance mismatch')
    const expected = buildIssue({
      history,
      checkpoints: checkpoints.slice(0, index + 1),
      horizonHours: saved.horizonHours,
      issuedAtUtc: saved.issuedAtUtc,
    })
    const replay = legacy
      ? seal({
          ...unsigned(expected),
          source: (({ checkpointSha256: _logical, ...source }) => source)(expected.source),
        })
      : expected
    if (JSON.stringify(replay) !== JSON.stringify(saved))
      throw new Error('Issue as-of forecast mismatch')
    issued.set(filename, saved)
    issues++
  }
  for (const filename of filenames.filter((name) => name.endsWith('.score.json'))) {
    const saved = readSealed(join(out, filename))
    const issue = issued.get(saved.issueFilename)
    if (
      !issue ||
      saved.study !== `${STUDY}-score-v1` ||
      filename !== `${saved.issueFilename}.score.json`
    )
      throw new Error('Invalid score artifact')
    const expected = scoreIssue(issue, checkpoints)
    if (!expected || JSON.stringify(expected) !== JSON.stringify(saved))
      throw new Error('Score provenance or outcome mismatch')
    scores++
  }
  return { issues, scores }
}

function issueAtPrefix({ history, checkpoints, out, now }) {
  if (!checkpoints.length) throw new Error('No prospective checkpoints')
  const block = checkpoints.at(-1).checkpoint.block
  const paths = HORIZONS.map((horizonHours) => join(out, issueName({ block, horizonHours })))
  const existing = paths.map(existsSync)
  if (existing.every(Boolean))
    return paths.map((path) => {
      const saved = readSealed(path) // verifyIssues checked as-of provenance above.
      return { path, status: saved.status, horizonHours: saved.horizonHours, existing: true }
    })
  const currentUtc = now().toISOString()
  if (existing.some(Boolean)) {
    const currentMs = Date.parse(currentUtc)
    const captured = checkpoints.at(-1).checkpoint
    if (
      !Number.isFinite(currentMs) ||
      currentMs < Date.parse(captured.captureEndUtc) ||
      currentMs - Date.parse(captured.captureEndUtc) > MAX_ISSUE_LAG * 1000 ||
      currentMs >= (captured.block.timestamp + HORIZONS[0] * HOUR - TOLERANCE) * 1000
    )
      throw new Error('Partial issue cannot be recovered outside prospective issuance window')
  }
  const issuedAtUtc = existing.some(Boolean)
    ? readSealed(paths[existing.indexOf(true)]).issuedAtUtc
    : currentUtc
  const results = HORIZONS.map((horizonHours) =>
    buildIssue({ history, checkpoints, horizonHours, issuedAtUtc }),
  )
  for (let i = 0; i < paths.length; i++) if (!existing[i]) immutableWrite(paths[i], results[i])
  return results.map((result, i) => ({
    path: paths[i],
    status: result.status,
    horizonHours: result.horizonHours,
    ...(existing[i] ? { existing: true } : {}),
  }))
}

export function issueLatest({ history, checkpoints, out = OUT, now = () => new Date() }) {
  verifyIssues({ out, checkpoints, history })
  return issueAtPrefix({ history, checkpoints, out, now })
}

export function issueFreshCheckpoints({ history, checkpoints, out = OUT, now = () => new Date() }) {
  verifyIssues({ history, checkpoints, out })
  const current = now()
  const currentMs = current.getTime()
  if (!Number.isFinite(currentMs)) throw new Error('Invalid issue clock')
  const results = []
  for (let i = 0; i < checkpoints.length; i++) {
    const captured = checkpoints[i].checkpoint
    const captureEndMs = Date.parse(captured.captureEndUtc)
    if (!Number.isFinite(captureEndMs) || currentMs < captureEndMs)
      throw new Error('Issue clock precedes checkpoint capture')
    const paths = HORIZONS.map((horizonHours) =>
      join(out, issueName({ block: captured.block, horizonHours })),
    )
    const existing = paths.map(existsSync)
    if (existing.every(Boolean)) {
      results.push({
        block: captured.block.number,
        status: 'existing',
        issues: paths.map((path) => {
          const saved = readSealed(path)
          return { path, status: saved.status, horizonHours: saved.horizonHours, existing: true }
        }),
      })
      continue
    }
    if (
      currentMs - captureEndMs > MAX_ISSUE_LAG * 1000 ||
      currentMs >= (captured.block.timestamp + HORIZONS[0] * HOUR - TOLERANCE) * 1000
    ) {
      results.push({
        block: captured.block.number,
        status: 'stale_missing',
        existingHorizons: HORIZONS.filter((_, index) => existing[index]),
        missingHorizons: HORIZONS.filter((_, index) => !existing[index]),
      })
      continue
    }
    const issues = issueAtPrefix({
      history,
      checkpoints: checkpoints.slice(0, i + 1),
      out,
      now: () => current,
    })
    results.push({ block: captured.block.number, status: 'issued', issues })
  }
  return results
}

export function scoreIssue(issue, checkpoints) {
  const anchor = checkpoints.findIndex((item) => item.filename === issue.source.checkpointFilename)
  if (anchor < 0) throw new Error('Issue checkpoint missing')
  const target = issue.block.timestamp + issue.horizonHours * HOUR
  const latest = checkpoints.at(-1)?.checkpoint.block.timestamp ?? -Infinity
  if (latest < target + TOLERANCE) return null // wait for the complete endpoint window
  const future = checkpoints.slice(anchor + 1)
  const candidate = future
    .filter((item) => Math.abs(item.checkpoint.block.timestamp - target) <= TOLERANCE)
    .sort(
      (a, b) =>
        Math.abs(a.checkpoint.block.timestamp - target) -
        Math.abs(b.checkpoint.block.timestamp - target),
    )[0]
  let status = candidate ? 'observed' : 'missing_target'
  if (candidate) {
    const endpoint = checkpoints.indexOf(candidate)
    for (let i = anchor + 1; i <= endpoint; i++) {
      if (
        checkpoints[i].checkpoint.block.timestamp - checkpoints[i - 1].checkpoint.block.timestamp >
        GAP
      )
        status = 'censored_gap'
    }
  }
  const actualQuote = status === 'observed' ? quoteRow(candidate).quote : null
  return seal({
    study: `${STUDY}-score-v1`,
    issueFilename: issueName(issue),
    issueSha256: issue.sha256,
    horizonHours: issue.horizonHours,
    targetAt: target,
    endpointWindowSeconds: TOLERANCE,
    maximumContinuousGapSeconds: GAP,
    status,
    actualQuote,
    endpointCheckpointSha256: status === 'observed' ? candidate.checkpoint.sha256 : null,
    endpointPhysicalSha256: status === 'observed' ? candidate.physicalSha256 : null,
    forecastError:
      status === 'observed' && issue.status === 'research_forecast'
        ? issue.projectedQuote - actualQuote
        : null,
    persistenceError:
      status === 'observed' && issue.status === 'research_forecast'
        ? issue.currentQuote - actualQuote
        : null,
    intervalCovered:
      status === 'observed' && issue.status === 'research_forecast'
        ? actualQuote >= issue.empiricalAnalogInterval[0] &&
          actualQuote <= issue.empiricalAnalogInterval[1]
        : null,
  })
}

export function scoreMatured({ history, checkpoints, out = OUT }) {
  verifyIssues({ history, checkpoints, out })
  if (!existsSync(out)) return { written: 0, pending: 0 }
  let written = 0,
    pending = 0
  for (const filename of readdirSync(out).filter(
    (name) => name.endsWith('.json') && !name.endsWith('.score.json'),
  )) {
    const issue = readSealed(join(out, filename))
    const score = scoreIssue(issue, checkpoints)
    if (!score) {
      pending++
      continue
    }
    const path = join(out, `${filename}.score.json`)
    if (existsSync(path)) continue
    immutableWrite(path, score)
    written++
  }
  return { written, pending }
}

function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && !['--run', '--verify', '--score'].includes(args[0])))
    throw new Error('Usage: curve-prospective-forecast.mjs [--run|--verify|--score]')
  const history = readHistorical()
  const checkpoints = readValidatedCheckpoints({ out: CHECKPOINTS })
  if (args[0] === '--run')
    return console.log(JSON.stringify(issueFreshCheckpoints({ history, checkpoints })))
  if (args[0] === '--score')
    return console.log(JSON.stringify(scoreMatured({ history, checkpoints })))
  const result = verifyIssues({ history, checkpoints })
  console.log(
    JSON.stringify({
      mode: args[0] === '--verify' ? 'verify' : 'dry',
      checkpoints: checkpoints.length,
      out: OUT,
      ...result,
    }),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch {
    console.error('Prospective forecast verification or issuance failed')
    process.exitCode = 1
  }
}
