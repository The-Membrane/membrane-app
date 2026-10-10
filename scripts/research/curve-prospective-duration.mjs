// Offline prospective first-breach duration research for the nominal $1m two-pool quote.
// Neither a vault withdrawal nor an executable fill. Dry/verify by default.
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
import { readHistorical } from './curve-prospective-forecast.mjs'
import {
  OUT as CHECKPOINTS,
  readValidatedCheckpoints,
  RESERVE_BYTES,
} from './curve-prospective-quote.mjs'
import {
  HORIZONS,
  THRESHOLD,
  firstBreach,
  forecastAt,
  observedAtHorizon,
  prepareRows,
} from './curve-quote-duration-study.mjs'

export const STUDY = 'curve-crvusd-secondary-prospective-duration-v1'
export const OUT = resolve('data/research/venue-signals/curve-prospective-duration')
const HISTORICAL_SHA = 'ad1ef837f8050fec53dadd220553168510a8227e83e0520b57185b122a16224a'
const HOUR = 3600
const ENDPOINT_TOLERANCE = 90 * 60
const MAX_ISSUE_LAG = 2 * HOUR
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ sha256: _seal, ...rest }) => rest
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
// Closed physical-byte migration set for the six receipts issued before the
// checkpoint reader retained its validated logical seal.
const LEGACY_ISSUE_PHYSICAL_SHA256 = new Set([
  '452eda630e2aac524257428b8d828cf486f2bb171dae81437aeb559695ff8a29',
  'e0ee06222c9c9293bb604c4c65c701cd42ec4d9b21e56a95b9677d8768c7f8d8',
  '476f2728f36fc95548d191d397c192331dbdcb5b59ec992f677d17137b52c7ae',
  '3f39799026fd8d5208aacca2b98b4f8e0db27a9cc1b43116c15505b3f06529f0',
  '0af492724b257a59aea37eac7685d5628bc1e28883b29562e16ca91c72cf9f47',
  'cb8b22300842accf222f683b6086e8b372d91367db601571b67bf810b2b62bff',
])

function quoteRow(item) {
  const p = item.checkpoint
  const quote = p.routes?.['1000000']?.bestQuote
  if (!Number.isFinite(quote) || quote < 0) throw new Error('Invalid prospective quote')
  return { at: p.block.timestamp, block: p.block.number, quote }
}

function checkChronology(history, checkpoints) {
  let at = history.at(-1)?.at ?? -Infinity
  let block = history.at(-1)?.block ?? -Infinity
  for (const item of checkpoints) {
    if (item.checkpoint.block.timestamp <= at || item.checkpoint.block.number <= block)
      throw new Error('Prospective checkpoint chronology overlaps or regresses')
    at = item.checkpoint.block.timestamp
    block = item.checkpoint.block.number
  }
}

function issueName(issue) {
  return `${String(issue.block.number).padStart(12, '0')}-${issue.block.hash.slice(2)}-${issue.horizonHours}h.json`
}

function diskGuard(out, stat = statfsSync, extra = 0) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) throw new Error('No output ancestor')
    path = parent
  }
  const fs = stat(path)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Duration research disk reserve reached')
}

function immutableWrite(path, payload, stat = statfsSync) {
  const bytes = JSON.stringify(payload) + '\n'
  diskGuard(dirname(path), stat, Buffer.byteLength(bytes))
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function readSealed(path) {
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (saved?.sha256 !== sha(JSON.stringify(unsigned(saved))))
    throw new Error('Duration artifact SHA mismatch')
  return saved
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
    issueMs >= (p.block.timestamp + horizonHours * HOUR - ENDPOINT_TOLERANCE) * 1000
  )
    throw new Error('Issue clock outside prospective issuance window')
  const rows = prepareRows([...history, ...checkpoints.map(quoteRow)])
  const result = forecastAt(rows, rows.length - 1, horizonHours)
  return seal({
    study: STUDY,
    issuedAtUtc,
    source: {
      historicalName: 'scrvusd-size-aware-400d',
      historicalPhysicalSha256: HISTORICAL_SHA,
      checkpointStudy: p.study,
      checkpointSourceIdentitySha256: p.source.identitySha256,
      checkpointSha256: p.sha256,
      checkpointPhysicalSha256: captured.physicalSha256,
      checkpointFilename: captured.filename,
    },
    block: p.block,
    horizonHours,
    threshold: THRESHOLD,
    currentQuote: quoteRow(captured).quote,
    status: result.status,
    analog: result.analog ?? null,
    unconditional: result.unconditional ?? null,
    availablePastAnchors: result.availablePastAnchors ?? null,
    selectedAnalogs: result.selectedAnalogs ?? null,
    caveats: [
      'Nominal $1m two-pool get_dy quote only; not a vault withdrawal or executable fill.',
      'USDT and USDC assumed at $1; gas, MEV, depeg and route execution omitted.',
      'Explored correlated source; intervals are descriptive and are not calibrated probabilities or alerts.',
      'Past-only candidates and as-of checkpoint inputs; unavailable or sparse risk sets abstain.',
    ],
  })
}

export function verifyIssues({ history, checkpoints, out = OUT }) {
  checkChronology(history, checkpoints)
  if (!existsSync(out)) return { issues: 0, scores: 0, partialGroups: [] }
  const byFilename = new Map(checkpoints.map((item, i) => [item.filename, i]))
  const issued = new Map()
  const groups = new Map()
  let issues = 0,
    scores = 0
  const filenames = readdirSync(out).filter((name) => name.endsWith('.json'))
  for (const filename of filenames.filter((name) => !name.endsWith('.score.json'))) {
    const path = join(out, filename)
    const saved = readSealed(path)
    const legacy = !Object.hasOwn(saved.source ?? {}, 'checkpointSha256')
    if (legacy && !LEGACY_ISSUE_PHYSICAL_SHA256.has(sha(readFileSync(path))))
      throw new Error('Unrecognized legacy duration issue physical seal')
    const index = byFilename.get(saved.source?.checkpointFilename)
    if (index === undefined || saved.study !== STUDY || filename !== issueName(saved))
      throw new Error('Duration issue identity or filename mismatch')
    const captured = checkpoints[index]
    if (
      saved.source.checkpointPhysicalSha256 !== captured.physicalSha256 ||
      (!legacy && saved.source.checkpointSha256 !== captured.checkpoint.sha256) ||
      saved.block.hash !== captured.checkpoint.block.hash ||
      saved.currentQuote !== quoteRow(captured).quote ||
      !HORIZONS.includes(saved.horizonHours)
    )
      throw new Error('Duration issue provenance mismatch')
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
      throw new Error('Duration issue as-of recomputation mismatch')
    issued.set(filename, saved)
    if (!groups.has(index)) groups.set(index, new Set())
    groups.get(index).add(saved.horizonHours)
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
      throw new Error('Invalid duration score artifact')
    const expected = scoreIssue(issue, checkpoints)
    if (!expected || JSON.stringify(expected) !== JSON.stringify(saved))
      throw new Error('Duration score provenance or outcome mismatch')
    scores++
  }
  const partialGroups = [...groups]
    .filter(([, horizons]) => horizons.size !== HORIZONS.length)
    .map(([index, horizons]) => ({
      checkpointFilename: checkpoints[index].filename,
      missingHorizons: HORIZONS.filter((h) => !horizons.has(h)),
    }))
  return { issues, scores, partialGroups }
}

function issueAt({ history, checkpoints, index, out, currentUtc, stat }) {
  const asOf = checkpoints.slice(0, index + 1)
  const captured = asOf.at(-1).checkpoint
  const paths = HORIZONS.map((horizonHours) =>
    join(out, issueName({ block: captured.block, horizonHours })),
  )
  const existing = paths.map(existsSync)
  const missingHorizons = HORIZONS.filter((_, i) => !existing[i])
  if (missingHorizons.length === 0)
    return {
      checkpointFilename: checkpoints[index].filename,
      status: 'existing',
      receipts: paths.map((path, i) => ({ path, horizonHours: HORIZONS[i], existing: true })),
    }
  const currentMs = Date.parse(currentUtc)
  const captureEndMs = Date.parse(captured.captureEndUtc)
  if (!Number.isFinite(currentMs) || currentMs < captureEndMs)
    throw new Error('Current clock precedes checkpoint capture')
  if (
    currentMs - captureEndMs > MAX_ISSUE_LAG * 1000 ||
    currentMs >= (captured.block.timestamp + HORIZONS[0] * HOUR - ENDPOINT_TOLERANCE) * 1000
  )
    return {
      checkpointFilename: checkpoints[index].filename,
      status: 'missing_stale',
      missingHorizons,
      existingHorizons: HORIZONS.filter((_, i) => existing[i]),
    }
  const issuedAtUtc = existing.some(Boolean)
    ? readSealed(paths[existing.indexOf(true)]).issuedAtUtc
    : currentUtc
  const results = HORIZONS.map((horizonHours) =>
    buildIssue({ history, checkpoints: asOf, horizonHours, issuedAtUtc }),
  )
  for (let i = 0; i < paths.length; i++)
    if (!existing[i]) immutableWrite(paths[i], results[i], stat)
  return {
    checkpointFilename: checkpoints[index].filename,
    status: 'issued',
    receipts: results.map((result, i) => ({
      path: paths[i],
      status: result.status,
      horizonHours: result.horizonHours,
      ...(existing[i] ? { existing: true } : {}),
    })),
  }
}

export function issueFresh({
  history,
  checkpoints,
  out = OUT,
  now = () => new Date(),
  stat = statfsSync,
}) {
  if (!checkpoints.length) throw new Error('No prospective checkpoints')
  verifyIssues({ history, checkpoints, out })
  const currentUtc = now().toISOString()
  const results = checkpoints.map((_, index) =>
    issueAt({ history, checkpoints, index, out, currentUtc, stat }),
  )
  return {
    checkpoints: checkpoints.length,
    issued: results.filter((x) => x.status === 'issued').length,
    existing: results.filter((x) => x.status === 'existing').length,
    missingStale: results.filter((x) => x.status === 'missing_stale'),
    results: results.filter((x) => x.status === 'issued'),
  }
}

// Single-checkpoint helper retained for focused tests; the CLI uses the full fresh sweep.
export function issueLatest({
  history,
  checkpoints,
  out = OUT,
  now = () => new Date(),
  stat = statfsSync,
}) {
  if (!checkpoints.length) throw new Error('No prospective checkpoints')
  verifyIssues({ history, checkpoints, out })
  const result = issueAt({
    history,
    checkpoints,
    index: checkpoints.length - 1,
    out,
    currentUtc: now().toISOString(),
    stat,
  })
  if (result.status === 'missing_stale')
    throw new Error('Issue clock outside prospective issuance window')
  return result.receipts
}

// The outcome window must close before either a breach or censor receipt is frozen.
export function scoreIssue(issue, checkpoints) {
  const anchor = checkpoints.findIndex((item) => item.filename === issue.source.checkpointFilename)
  if (anchor < 0) throw new Error('Duration issue checkpoint missing')
  const targetAt = issue.block.timestamp + issue.horizonHours * HOUR
  const endAt = targetAt + ENDPOINT_TOLERANCE
  if ((checkpoints.at(-1)?.checkpoint.block.timestamp ?? -Infinity) < endAt) return null
  const observed = checkpoints
    .slice(anchor)
    .filter((item) => item.checkpoint.block.timestamp <= endAt)
  const rows = prepareRows(observed.map(quoteRow))
  const outcome = firstBreach(rows, 0)
  const stateAtHorizon =
    outcome.status === 'ineligible_anchor' ? null : observedAtHorizon(outcome, issue.horizonHours)
  const indexAt = (at) => rows.findIndex((row) => row.at === at)
  const evidence = (at) => {
    const index = indexAt(at)
    return index < 0
      ? null
      : {
          filename: observed[index].filename,
          checkpointSha256: observed[index].checkpoint.sha256,
          physicalSha256: observed[index].physicalSha256,
          block: observed[index].checkpoint.block,
          quote: rows[index].quote,
        }
  }
  const gapNextIndex = outcome.status === 'censored_gap' ? indexAt(outcome.lastNotBelowAt) + 1 : -1
  return seal({
    study: `${STUDY}-score-v1`,
    issueFilename: issueName(issue),
    issueSha256: issue.sha256,
    threshold: THRESHOLD,
    horizonHours: issue.horizonHours,
    targetAt,
    endpointWindowSeconds: ENDPOINT_TOLERANCE,
    maximumContinuousGapSeconds: 4 * HOUR,
    status: outcome.status,
    stateAtHorizon:
      outcome.status === 'ineligible_anchor'
        ? 'already_at_or_below_anchor_threshold'
        : stateAtHorizon === null
          ? 'unresolved'
          : stateAtHorizon === 1
            ? 'no_below_threshold_breach_observed'
            : 'first_breach_observed',
    breachInterval: outcome.status === 'breach' ? outcome.interval : null,
    lastNotBelowAt: outcome.lastNotBelowAt ?? null,
    previousObservation:
      outcome.status === 'breach'
        ? evidence(outcome.interval[0])
        : outcome.lastNotBelowAt === undefined
          ? null
          : evidence(outcome.lastNotBelowAt),
    breachObservation: outcome.status === 'breach' ? evidence(outcome.interval[1]) : null,
    gapNextObservation:
      gapNextIndex >= 0 && gapNextIndex < rows.length ? evidence(rows[gapNextIndex].at) : null,
    observedThrough: evidence(rows.at(-1).at),
    caveat:
      'First observed below-threshold nominal quote; no continuous execution or vault withdrawal claim.',
  })
}

export function scoreMatured({ history, checkpoints, out = OUT, stat = statfsSync }) {
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
    immutableWrite(path, score, stat)
    written++
  }
  return { written, pending }
}

function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && !['--run', '--verify', '--score'].includes(args[0])))
    throw new Error('Usage: curve-prospective-duration.mjs [--run|--verify|--score]')
  const history = readHistorical()
  const checkpoints = readValidatedCheckpoints({ out: CHECKPOINTS })
  if (args[0] === '--run') return console.log(JSON.stringify(issueFresh({ history, checkpoints })))
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
    console.error('Prospective duration verification or issuance failed')
    process.exitCode = 1
  }
}
