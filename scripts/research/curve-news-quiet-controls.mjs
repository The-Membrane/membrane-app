// Prospective feed-quiet controls and nominal quote outcomes for the existing
// news enrollment. RSS silence is only silence in one watched Google News feed.
// No holder-exit or directional headline claim follows from these artifacts.
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
  parsedItemIdentity,
  parsedItemIdentityV2,
  verifyPolls,
  sourceIdentity as rssSourceIdentity,
  OUT as POLL_OUT,
} from '../lib/newsPollLedger.mjs'
import { OUT as NEWS_OUT, verify as verifyNews } from './venue-news-event-ledger.mjs'
import {
  OUT as ENROLL_OUT,
  verifyIssues as verifyEnrollment,
} from './curve-news-prospective-enrollment.mjs'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'

export const STUDY = 'curve-news-feed-quiet-controls-v1'
export const OUT = resolve('data/research/venue-signals/curve-news-quiet-controls')
export const CONFIG_PATH = resolve('tools/venue-recorder.config.json')
export const HORIZONS_HOURS = [24, 168]
export const MAX_ARM_DELAY_MS = 10 * 60_000
export const MAX_QUOTE_AGE_MS = 6 * 3_600_000
export const MAX_POLL_GAP_MS = 2 * 3_600_000
export const PRE_ANCHOR_WASHOUT_HOURS = 168
export const QUOTE_GAP_SECONDS = 4 * 3600
export const ENDPOINT_TOLERANCE_SECONDS = 90 * 60
const RESERVE_BYTES = 1024 ** 3
const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _ignored, ...payload }) => payload
const ms = (value) => Date.parse(value)
const fileName = (sequence) => `${String(sequence).padStart(12, '0')}.json`

function clock(now) {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid control clock')
  return value.toISOString()
}

function diskGuard(out, stat, bytes) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) throw new Error('No output ancestor')
    path = parent
  }
  const fs = stat(path)
  if (Number(fs.bavail) * Number(fs.bsize) - bytes < RESERVE_BYTES)
    throw new Error('Quiet-control disk reserve reached')
}

function append(out, issue, stat) {
  const bytes = `${JSON.stringify(issue)}\n`
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Control issue too large')
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const path = join(out, fileName(issue.sequence))
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function armRef(arm, enrollOut) {
  return {
    sequence: arm.sequence,
    logicalSha256: arm.sha256,
    physicalSha256: sha(readFileSync(join(enrollOut, fileName(arm.sequence)))),
  }
}

function source(arm, enrollOut) {
  if (!arm.quote) return null
  return {
    arm: armRef(arm, enrollOut),
    quote: arm.quote,
    newsPrefixCount: arm.newsPrefixCount,
    newsPrefixLastSha256: arm.newsPrefixLastSha256,
  }
}

function configSnapshot(bytes) {
  const config = JSON.parse(bytes.toString('utf8'))
  const matches = config.venues?.filter((row) => row.name === 'scrvUSD' && row.newsQuery)
  if (matches?.length !== 1) throw new Error('scrvUSD news query unavailable or ambiguous')
  const newsQuery = matches[0].newsQuery
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(newsQuery)}&hl=en-US&gl=US&ceid=US:en`
  const physicalSha256 = sha(bytes)
  return {
    filename: `source-snapshots/${physicalSha256}.json`,
    physicalSha256,
    newsQuery,
    rssUrl,
    identity: rssSourceIdentity(newsQuery, rssUrl),
  }
}

function writeConfigSnapshot(out, configPath, stat) {
  const bytes = readFileSync(configPath)
  const snapshot = configSnapshot(bytes)
  const path = join(out, snapshot.filename)
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new Error('Source snapshot collision or edit')
  } else {
    diskGuard(out, stat, bytes.length)
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
      linkSync(temp, path)
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
  return snapshot
}

function verifyConfigSnapshot(out, reference) {
  if (!reference || !/^[0-9a-f]{64}$/.test(reference.physicalSha256))
    throw new Error('Invalid source snapshot reference')
  const filename = `source-snapshots/${reference.physicalSha256}.json`
  if (reference.filename !== filename) throw new Error('Source snapshot filename mismatch')
  const bytes = readFileSync(join(out, filename))
  const expected = configSnapshot(bytes)
  if (JSON.stringify(reference) !== JSON.stringify(expected))
    throw new Error('Source snapshot mismatch')
  return expected
}

function candidate(arm, issuedAtUtc, enrollOut, news, sourceSnapshot) {
  const armAge = ms(issuedAtUtc) - ms(arm.issuedAtUtc)
  const quoteAge = arm.quote ? ms(issuedAtUtc) - ms(arm.quote.captureEndUtc) : null
  const observed = news.receipts.filter((row) => ms(row.observation.fetchedAt) <= ms(issuedAtUtc))
  const preStart = ms(issuedAtUtc) - PRE_ANCHOR_WASHOUT_HOURS * 3_600_000
  const recentRelevant = observed.filter(
    (row) => relevantNews(row) && ms(row.observation.fetchedAt) > preStart,
  )
  let reason = null
  if (armAge < 0 || armAge > MAX_ARM_DELAY_MS) reason = 'arm_not_fresh'
  else if (!arm.quote) reason = 'missing_nominal_quote'
  else if (quoteAge <= 0 || quoteAge > MAX_QUOTE_AGE_MS) reason = 'quote_not_fresh'
  else if (recentRelevant.length) reason = 'recent_incident_in_washout'
  else if (observed.length !== arm.newsPrefixCount) reason = 'news_since_arm'
  return {
    kind: 'feed_quiet_candidate',
    anchorAtUtc: issuedAtUtc,
    status:
      reason === 'recent_incident_in_washout'
        ? 'recent_incident_excluded'
        : reason
          ? 'unassessable'
          : 'candidate_unconfirmed',
    reason,
    source: source(arm, enrollOut),
    sourceSnapshot,
    expectedNewsSource: sourceSnapshot.identity,
    newsCoverage: 'unknown_until_verified_poll_interval',
    preAnchorWashout: {
      hours: PRE_ANCHOR_WASHOUT_HOURS,
      startAtUtc: new Date(preStart).toISOString(),
      endAtUtc: issuedAtUtc,
      knownRelevantFirstSeenCount: recentRelevant.length,
      status: recentRelevant.length ? 'known_recent_incident' : 'pending_verified_feed_coverage',
    },
    sourceScope: 'configured Google News RSS search only; not venue-wide event absence',
    nominalInputCrvUsd: 1_000_000,
    targetHorizonHours: HORIZONS_HOURS,
  }
}

function quoteRef(row) {
  return {
    filename: row.filename,
    logicalSha256: row.checkpoint.sha256,
    physicalSha256: row.physicalSha256,
    block: row.checkpoint.block.number,
    blockTimeUtc: new Date(row.checkpoint.block.timestamp * 1000).toISOString(),
    captureEndUtc: row.checkpoint.captureEndUtc,
    bestOutputRaw: row.checkpoint.routes['1000000'].bestOutputRaw,
  }
}

// Requires a timestamped quote in the fixed endpoint window and a continuous
// <=4h observation grid from the pinned baseline. It never interpolates.
export function quoteOutcome(baseline, targetAtUtc, rows) {
  if (!baseline) return { status: 'missing_baseline' }
  const anchor = rows.findIndex((row) => row.filename === baseline.filename)
  if (anchor < 0) throw new Error('Baseline quote missing')
  const target = ms(targetAtUtc) / 1000
  const future = rows
    .slice(anchor + 1)
    .filter(
      (row) =>
        row.checkpoint.block.timestamp * 1000 > ms(baseline.captureEndUtc) &&
        Math.abs(row.checkpoint.block.timestamp - target) <= ENDPOINT_TOLERANCE_SECONDS,
    )
    .sort(
      (a, b) =>
        Math.abs(a.checkpoint.block.timestamp - target) -
          Math.abs(b.checkpoint.block.timestamp - target) ||
        a.checkpoint.block.timestamp - b.checkpoint.block.timestamp,
    )
  const endpoint = future[0]
  if (!endpoint) return { status: 'missing_target', endpoint: null }
  const endIndex = rows.indexOf(endpoint)
  for (let index = anchor + 1; index <= endIndex; index++) {
    if (
      rows[index].checkpoint.block.timestamp - rows[index - 1].checkpoint.block.timestamp >
      QUOTE_GAP_SECONDS
    )
      return { status: 'censored_quote_gap', endpoint: quoteRef(endpoint) }
  }
  const before = BigInt(baseline.bestOutputRaw)
  const after = BigInt(endpoint.checkpoint.routes['1000000'].bestOutputRaw)
  return {
    status: 'observed',
    endpoint: quoteRef(endpoint),
    nominalOutputDeltaRaw: String(after - before),
    nominalOutputDeltaUsd: Number(after - before) / 1e6,
  }
}

function relevantNews(receipt) {
  const venue = receipt.observation.venue.toLowerCase()
  const title = receipt.observation.title.toLowerCase()
  return venue === 'scrvusd' || /\bscrvusd\b|\bcrvusd\b/.test(title)
}

// Poll receipts certify only a bounded observation grid of one RSS query.
// A failure, cap, changed query, missing boundary, or >2h gap is unknown.
export function feedCoverage(polls, news, startAtUtc, targetAtUtc, expectedSource) {
  const start = ms(startAtUtc)
  const end = ms(targetAtUtc)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error('Invalid feed interval')
  const venue = polls.filter((poll) => poll.venue === 'scrvUSD')
  const first = [...venue].reverse().find((poll) => ms(poll.endedAtUtc) <= start)
  if (!first) return { status: 'unknown', reason: 'missing_start_poll' }
  if (start - ms(first.endedAtUtc) > MAX_POLL_GAP_MS)
    return { status: 'unknown', reason: 'stale_start_poll' }
  const afterStart = venue.filter((poll) => ms(poll.endedAtUtc) > ms(first.endedAtUtc))
  const endPoll = afterStart.find((poll) => ms(poll.endedAtUtc) >= end)
  if (!endPoll || ms(endPoll.endedAtUtc) - end > MAX_POLL_GAP_MS)
    return { status: 'unknown', reason: 'missing_end_poll' }
  const interval = afterStart.filter((poll) => poll.sequence <= endPoll.sequence)
  const chain = [first, ...interval]
  const query = first.source?.querySha256
  const url = first.source?.urlSha256
  if (
    !query ||
    !url ||
    first.source?.kind !== 'google-news-rss-search' ||
    JSON.stringify(first.source) !== JSON.stringify(expectedSource)
  )
    return { status: 'unknown', reason: 'invalid_poll_source' }
  if (
    chain.some(
      (poll) =>
        ![2, 3].includes(poll.receiptVersion) ||
        poll.status !== 'success' ||
        poll.coverageStatus !== 'observed_below_cap' ||
        poll.source?.kind !== 'google-news-rss-search' ||
        poll.source?.querySha256 !== query ||
        poll.source?.urlSha256 !== url,
    )
  )
    return { status: 'unknown', reason: 'failed_capped_or_changed_poll' }
  const imported = news.filter((receipt) => receipt.observation.venue === 'scrvUSD')
  const importedByVersion = new Map([
    [
      2,
      new Map(
        imported.map((receipt) => [
          parsedItemIdentityV2(receipt.observation),
          ms(receipt.observation.fetchedAt),
        ]),
      ),
    ],
    [
      3,
      new Map(
        imported.map((receipt) => [
          parsedItemIdentity(receipt.observation),
          ms(receipt.observation.fetchedAt),
        ]),
      ),
    ],
  ])
  if (
    chain.some((poll) => {
      const versionedItems = importedByVersion.get(poll.receiptVersion)
      return (
        !versionedItems ||
        !Array.isArray(poll.parsedItemIdentitySha256s) ||
        poll.parsedItemIdentitySha256s.length !== poll.parsedItemCount ||
        poll.parsedItemIdentitySha256s.some(
          (identity) =>
            !versionedItems.has(identity) || versionedItems.get(identity) > ms(poll.endedAtUtc),
        )
      )
    })
  )
    return { status: 'unknown', reason: 'unjoined_feed_item' }
  let prior = start
  for (const poll of interval) {
    if (ms(poll.endedAtUtc) - prior > MAX_POLL_GAP_MS)
      return { status: 'unknown', reason: 'poll_gap' }
    prior = ms(poll.endedAtUtc)
    if (prior >= end) break
  }
  if (prior < end) return { status: 'unknown', reason: 'missing_end_poll' }
  const seen = news.filter(
    (receipt) =>
      relevantNews(receipt) &&
      ms(receipt.observation.fetchedAt) > start &&
      ms(receipt.observation.fetchedAt) <= end,
  )
  const boundary = news.filter(
    (receipt) =>
      relevantNews(receipt) &&
      ms(receipt.observation.fetchedAt) > end &&
      ms(receipt.observation.fetchedAt) <= ms(endPoll.endedAtUtc),
  )
  // The first poll that closes the horizon may discover an item after the
  // target. Its actual feed appearance could have preceded the target, so the
  // window cannot be called quiet even though local first-seen is later.
  if (!seen.length && boundary.length)
    return { status: 'unknown', reason: 'boundary_poll_item_timing' }
  return {
    status: seen.length ? 'observed_feed_incident' : 'feed_quiet',
    reason: seen.length ? 'locally_observed_relevant_item' : null,
    pollFirstSequence: first.sequence,
    pollLastSequence: endPoll.sequence,
    querySha256: query,
    urlSha256: url,
    observedRelevantItemCount: seen.length,
    scope: 'one configured Google News RSS search, not absence of real-world news',
  }
}

export function controlScoreStatus(preCoverage, postCoverage, quote) {
  if (preCoverage.status === 'unknown') return 'unscorable_preanchor_feed_coverage'
  if (preCoverage.status === 'observed_feed_incident') return 'censored_preanchor_feed_incident'
  if (postCoverage.status === 'unknown') return 'unscorable_feed_coverage'
  if (postCoverage.status === 'observed_feed_incident') return 'censored_observed_feed_incident'
  return quote.status === 'observed' ? 'observed' : quote.status
}

function scoreRows(quietIssues, enrollment, news, polls, quotes, issuedAtUtc) {
  const prior = quietIssues.filter((issue) => issue.kind === 'score')
  const already = new Set(
    prior.map(
      (issue) =>
        `${issue.result.subject.kind}:${issue.result.subject.id}:${issue.result.horizonHours}`,
    ),
  )
  const subjects = [
    ...quietIssues
      .filter(
        (issue) => issue.kind === 'issue' && issue.candidate.status === 'candidate_unconfirmed',
      )
      .map((issue) => ({
        kind: 'feed_quiet_candidate',
        id: issue.sequence,
        anchorAtUtc: issue.candidate.anchorAtUtc,
        quote: issue.candidate.source.quote,
        expectedNewsSource: issue.candidate.expectedNewsSource,
        preAnchorWashout: issue.candidate.preAnchorWashout,
        issueSha256: issue.sha256,
      })),
    ...enrollment.issues
      .filter((issue) => issue.kind === 'scan' && ms(issue.issuedAtUtc) <= ms(issuedAtUtc))
      .flatMap((issue) =>
        issue.observations
          .filter((observation) => observation.status === 'enrolled')
          .map((observation) => ({
            kind: 'news_incident',
            id: observation.eventId,
            anchorAtUtc: observation.firstFetchedAtUtc,
            quote: observation.preEventQuote,
            issueSha256: issue.sha256,
          })),
      ),
  ]
  const outputs = []
  for (const subject of subjects) {
    for (const horizonHours of HORIZONS_HOURS) {
      if (already.has(`${subject.kind}:${subject.id}:${horizonHours}`)) continue
      const targetAtUtc = new Date(ms(subject.anchorAtUtc) + horizonHours * 3_600_000).toISOString()
      // A complete endpoint search window and one further poll interval must
      // have elapsed. Never settle a score from an immature target.
      if (ms(issuedAtUtc) < ms(targetAtUtc) + ENDPOINT_TOLERANCE_SECONDS * 1000 + MAX_POLL_GAP_MS)
        continue
      const maturedQuotes = quotes.filter(
        (row) => ms(row.checkpoint.captureEndUtc) <= ms(issuedAtUtc),
      )
      if (
        (maturedQuotes.at(-1)?.checkpoint.block.timestamp ?? -Infinity) <
        ms(targetAtUtc) / 1000 + ENDPOINT_TOLERANCE_SECONDS
      )
        continue
      const outcome = quoteOutcome(subject.quote, targetAtUtc, maturedQuotes)
      const preCoverage =
        subject.kind === 'feed_quiet_candidate'
          ? feedCoverage(
              polls,
              news,
              subject.preAnchorWashout.startAtUtc,
              subject.anchorAtUtc,
              subject.expectedNewsSource,
            )
          : null
      const postCoverage =
        subject.kind === 'feed_quiet_candidate'
          ? feedCoverage(polls, news, subject.anchorAtUtc, targetAtUtc, subject.expectedNewsSource)
          : null
      outputs.push({
        subject,
        horizonHours,
        targetAtUtc,
        quoteOutcome: outcome,
        preAnchorNewsCoverage: preCoverage,
        newsCoverage: postCoverage,
        status: preCoverage
          ? controlScoreStatus(preCoverage, postCoverage, outcome)
          : outcome.status,
      })
    }
  }
  return outputs
}

export function verifyControls({
  out = OUT,
  enrollOut = ENROLL_OUT,
  newsOut = NEWS_OUT,
  quoteOut = QUOTE_OUT,
  pollOut = POLL_OUT,
  identity = sourceIdentity(),
} = {}) {
  const enrollment = verifyEnrollment({ out: enrollOut, newsOut, quoteOut, identity })
  const news = verifyNews(newsOut)
  const polls = verifyPolls(pollOut)
  const quotes = readValidatedCheckpoints({ out: quoteOut, identity })
  if (!existsSync(out)) return { count: 0, last: null, issues: [], enrollment, news, polls, quotes }
  const files = readdirSync(out)
    .filter((file) => file.endsWith('.json'))
    .sort()
  const issues = []
  for (const [index, file] of files.entries()) {
    if (file !== fileName(index + 1)) throw new Error('Quiet-control sequence gap')
    const bytes = readFileSync(join(out, file), 'utf8')
    const issue = JSON.parse(bytes)
    if (bytes !== `${JSON.stringify(issue)}\n`)
      throw new Error('Quiet-control physical bytes mismatch')
    const prior = issues.at(-1)
    if (
      issue.sha256 !== sha(JSON.stringify(unsigned(issue))) ||
      issue.study !== STUDY ||
      issue.sequence !== index + 1 ||
      issue.previousSha256 !== (prior?.sha256 ?? null) ||
      !Number.isFinite(ms(issue.issuedAtUtc)) ||
      (prior && ms(issue.issuedAtUtc) <= ms(prior.issuedAtUtc))
    )
      throw new Error('Quiet-control identity or chain mismatch')
    if (issue.kind === 'issue') {
      const arm = enrollment.issues.find(
        (row) => row.kind === 'arm' && row.sequence === issue.armSequence,
      )
      if (
        !arm ||
        JSON.stringify(issue.candidate) !==
          JSON.stringify(
            candidate(
              arm,
              issue.issuedAtUtc,
              enrollOut,
              news,
              verifyConfigSnapshot(out, issue.candidate.sourceSnapshot),
            ),
          )
      )
        throw new Error('Quiet candidate as-of replay mismatch')
      if (issues.some((row) => row.kind === 'issue' && row.armSequence === issue.armSequence))
        throw new Error('Duplicate quiet-control arm')
    } else if (issue.kind === 'score') {
      if (
        !Number.isFinite(ms(issue.evidenceCutoffUtc)) ||
        ms(issue.evidenceCutoffUtc) > ms(issue.issuedAtUtc)
      )
        throw new Error('Invalid score evidence cutoff')
      const expected = scoreRows(
        issues,
        enrollment,
        news.receipts.filter((row) => ms(row.observation.fetchedAt) <= ms(issue.evidenceCutoffUtc)),
        polls.receipts.filter((row) => ms(row.endedAtUtc) <= ms(issue.evidenceCutoffUtc)),
        quotes,
        issue.evidenceCutoffUtc,
      ).find(
        (row) =>
          row.subject.kind === issue.result.subject.kind &&
          row.subject.id === issue.result.subject.id &&
          row.horizonHours === issue.result.horizonHours,
      )
      if (!expected || JSON.stringify(issue.result) !== JSON.stringify(expected))
        throw new Error('Quiet/news score as-of replay mismatch')
    } else throw new Error('Invalid quiet-control issue kind')
    issues.push(issue)
  }
  return {
    count: issues.length,
    last: issues.at(-1) ?? null,
    issues,
    enrollment,
    news,
    polls,
    quotes,
  }
}

export function issueQuiet({
  out = OUT,
  enrollOut = ENROLL_OUT,
  newsOut = NEWS_OUT,
  quoteOut = QUOTE_OUT,
  pollOut = POLL_OUT,
  configPath = CONFIG_PATH,
  identity = sourceIdentity(),
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  const issuedAtUtc = clock(now)
  const state = verifyControls({ out, enrollOut, newsOut, quoteOut, pollOut, identity })
  if (state.last && ms(issuedAtUtc) <= ms(state.last.issuedAtUtc))
    throw new Error('Nonadvancing control clock')
  const arm = state.enrollment.issues.filter((issue) => issue.kind === 'arm').at(-1)
  if (!arm) throw new Error('Prospective news arm required')
  if (state.issues.some((issue) => issue.kind === 'issue' && issue.armSequence === arm.sequence))
    return { status: 'unchanged', count: state.count }
  if (ms(issuedAtUtc) - ms(arm.issuedAtUtc) > MAX_ARM_DELAY_MS)
    return { status: 'waiting_fresh_arm', count: state.count, armSequence: arm.sequence }
  const next = seal({
    study: STUDY,
    kind: 'issue',
    sequence: state.count + 1,
    previousSha256: state.last?.sha256 ?? null,
    issuedAtUtc,
    armSequence: arm.sequence,
    candidate: candidate(
      arm,
      issuedAtUtc,
      enrollOut,
      state.news,
      writeConfigSnapshot(out, configPath, stat),
    ),
  })
  append(out, next, stat)
  return next
}

export function scoreMatured({
  out = OUT,
  enrollOut = ENROLL_OUT,
  newsOut = NEWS_OUT,
  quoteOut = QUOTE_OUT,
  pollOut = POLL_OUT,
  identity = sourceIdentity(),
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  const issuedAtUtc = clock(now)
  const state = verifyControls({ out, enrollOut, newsOut, quoteOut, pollOut, identity })
  if (state.last && ms(issuedAtUtc) <= ms(state.last.issuedAtUtc))
    throw new Error('Nonadvancing control clock')
  const rows = scoreRows(
    state.issues,
    state.enrollment,
    state.news.receipts.filter((row) => ms(row.observation.fetchedAt) <= ms(issuedAtUtc)),
    state.polls.receipts.filter((row) => ms(row.endedAtUtc) <= ms(issuedAtUtc)),
    state.quotes,
    issuedAtUtc,
  )
  if (!rows.length) return { status: 'unchanged', count: state.count }
  const results = []
  for (const result of rows) {
    const issue = seal({
      study: STUDY,
      kind: 'score',
      sequence: (state.last?.sequence ?? 0) + results.length + 1,
      previousSha256: results.at(-1)?.sha256 ?? state.last?.sha256 ?? null,
      issuedAtUtc: new Date(ms(issuedAtUtc) + results.length).toISOString(),
      evidenceCutoffUtc: issuedAtUtc,
      result,
    })
    append(out, issue, stat)
    results.push(issue)
  }
  return { status: 'scored', count: results.length, results }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--verify'
    if (!['--verify', '--issue', '--score'].includes(mode) || process.argv.length > 3)
      throw new Error('Invalid quiet-control command')
    const result =
      mode === '--issue' ? issueQuiet() : mode === '--score' ? scoreMatured() : verifyControls()
    console.log(
      JSON.stringify(
        mode === '--verify'
          ? { count: result.count, lastSequence: result.last?.sequence ?? null }
          : mode === '--score'
            ? { status: result.status, count: result.count }
            : result,
      ),
    )
  } catch {
    console.error('News quiet-control issue or verification failed')
    process.exitCode = 1
  }
}
