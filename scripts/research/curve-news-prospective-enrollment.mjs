// Offline prospective enrollment of news incidents against a previously armed
// nominal $1m Curve quote. This is neither an alert nor a causal forecast.
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
import { OUT as NEWS_OUT, verify as verifyNews } from './venue-news-event-ledger.mjs'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'

export const STUDY = 'curve-news-prospective-enrollment-v1'
export const OUT = resolve('data/research/venue-signals/curve-news-enrollment')
export const MAX_QUOTE_AGE_MS = 6 * 3600 * 1000
const RESERVE_BYTES = 1024 ** 3
const MAX_ISSUE_BYTES = 64 * 1024
const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _ignored, ...payload }) => payload
const name = (sequence) => `${String(sequence).padStart(12, '0')}.json`
const ms = (value) => Date.parse(value)

function clock(now) {
  const value = now()
  const time = value instanceof Date ? value.getTime() : NaN
  if (!Number.isFinite(time)) throw new Error('Invalid enrollment clock')
  return value.toISOString()
}

function diskGuard(out, stat, extra) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) throw new Error('No output ancestor')
    path = parent
  }
  const fs = stat(path)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Enrollment disk reserve reached')
}

function append(out, issue, stat = statfsSync) {
  const bytes = `${JSON.stringify(issue)}\n`
  if (Buffer.byteLength(bytes) > MAX_ISSUE_BYTES) throw new Error('Enrollment issue too large')
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const path = join(out, name(issue.sequence))
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function newsRef(receipt, newsOut) {
  const filename = name(receipt.sequence)
  return {
    filename,
    sequence: receipt.sequence,
    eventId: receipt.group.eventId,
    logicalSha256: receipt.sha256,
    physicalSha256: sha(readFileSync(join(newsOut, filename))),
  }
}

function quoteRef(row) {
  const p = row.checkpoint
  return {
    filename: row.filename,
    logicalSha256: p.sha256,
    physicalSha256: row.physicalSha256,
    block: p.block.number,
    blockHash: p.block.hash,
    blockTimeUtc: new Date(p.block.timestamp * 1000).toISOString(),
    captureEndUtc: p.captureEndUtc,
    nominalInputCrvUsd: 1_000_000,
    bestOutputRaw: p.routes['1000000'].bestOutputRaw,
    sourceIdentitySha256: p.source.identitySha256,
  }
}

function slope(previous, current) {
  if (!previous || !current) return null
  const gapHours = (ms(current.captureEndUtc) - ms(previous.captureEndUtc)) / 3_600_000
  if (
    gapHours <= 0 ||
    gapHours > 4 ||
    previous.sourceIdentitySha256 !== current.sourceIdentitySha256
  )
    return null
  const before = BigInt(previous.bestOutputRaw)
  if (before <= 0n) return null
  return {
    fromQuote: previous,
    // Descriptive observed slope only; no extrapolated event outcome.
    observedNominalQuoteBpsPerHour:
      ((Number(BigInt(current.bestOutputRaw) - before) / Number(before)) * 10_000) / gapHours,
    gapHours,
  }
}

function quoteMatches(ref, quoteOut, identity) {
  if (!ref) return true
  // Audit may read later quotes. Enrollment itself never calls this function.
  const row = readValidatedCheckpoints({ out: quoteOut, identity }).find(
    (item) => item.filename === ref.filename,
  )
  return Boolean(row && JSON.stringify(quoteRef(row)) === JSON.stringify(ref))
}

function relevance(receipt) {
  const venue = receipt.observation.venue.toLowerCase()
  const title = receipt.observation.title.toLowerCase()
  if (venue === 'scrvusd' || /\bscrvusd\b|\bcrvusd\b/.test(title)) return 'scrvusd'
  if (venue.includes('curve') || /\bcurve\b/.test(title)) return 'ambiguous_curve'
  return 'outside_scope'
}

function assess(receipt, first, arm, newsOut, issuedAtUtc) {
  const availableAtUtc = receipt.classification.availableAt
  const firstFetchedAtUtc = receipt.observation.fetchedAt
  const publishedAtUtc = receipt.observation.publishedAt
  const scope = relevance(receipt)
  const quote = arm?.quote ?? null
  const age = quote ? ms(firstFetchedAtUtc) - ms(quote.captureEndUtc) : null
  let reason = null
  if (first.sequence !== receipt.sequence) reason = 'preexisting_or_duplicate_incident'
  else if (scope === 'outside_scope') reason = 'outside_scope'
  else if (scope === 'ambiguous_curve') reason = 'ambiguous_curve_relevance'
  else if (!arm || ms(firstFetchedAtUtc) <= ms(arm.issuedAtUtc)) reason = 'not_prospective'
  else if (ms(availableAtUtc) > ms(issuedAtUtc)) reason = 'evidence_not_available_as_of'
  else if (!quote) reason = 'missing_pre_event_quote'
  else if (ms(quote.captureEndUtc) >= ms(firstFetchedAtUtc)) reason = 'quote_not_pre_event'
  else if (age > MAX_QUOTE_AGE_MS) reason = 'stale_pre_event_quote'
  return {
    eventId: receipt.group.eventId,
    status: reason ? 'unassessable' : 'enrolled',
    reason,
    scope,
    availableAtUtc,
    firstFetchedAtUtc,
    publishedAtUtc,
    publicationTiming: receipt.observation.publicationTiming,
    newsSource: newsRef(receipt, newsOut),
    armSequence: arm?.sequence ?? null,
    preEventQuote: reason ? null : quote,
    preEventObservedSlope: reason ? null : arm.preEventObservedSlope,
    target: reason
      ? null
      : {
          kind: 'continuous_same_size_nominal_quote_delta',
          nominalInputCrvUsd: 1_000_000,
          horizonsHours: [24, 168],
          holderExit: 'separate; only with a pre-event successful same-holder baseline',
        },
  }
}

// The source ledger is validated before use. Each scan advances only through
// the contiguous first-seen prefix available at its as-of clock.
function availablePrefix(receipts, asOfUtc) {
  let count = 0
  for (const receipt of receipts) {
    if (ms(receipt.observation.fetchedAt) > ms(asOfUtc)) break
    count++
  }
  return count
}

export function verifyIssues({
  out = OUT,
  newsOut = NEWS_OUT,
  quoteOut = QUOTE_OUT,
  identity = sourceIdentity(),
  auditQuotes = true,
} = {}) {
  const news = verifyNews(newsOut)
  if (!existsSync(out)) return { count: 0, last: null, issues: [], news }
  const files = readdirSync(out)
    .filter((file) => file.endsWith('.json'))
    .sort()
  const issues = []
  let processed = 0
  for (const [index, file] of files.entries()) {
    if (file !== name(index + 1)) throw new Error('Enrollment issue sequence gap')
    const issue = JSON.parse(readFileSync(join(out, file), 'utf8'))
    const prior = issues.at(-1)
    if (
      issue.sha256 !== sha(JSON.stringify(unsigned(issue))) ||
      issue.study !== STUDY ||
      issue.sequence !== index + 1 ||
      issue.previousSha256 !== (prior?.sha256 ?? null) ||
      !Number.isFinite(ms(issue.issuedAtUtc)) ||
      (prior && ms(issue.issuedAtUtc) <= ms(prior.issuedAtUtc))
    )
      throw new Error('Enrollment issue identity or chain mismatch')
    if (issue.kind === 'arm') {
      if (
        (index > 0 && issue.newsPrefixCount !== processed) ||
        (index === 0 &&
          (issue.newsPrefixCount < availablePrefix(news.receipts, issue.issuedAtUtc) ||
            issue.newsPrefixCount > news.count)) ||
        issue.newsPrefixLastSha256 !== (news.receipts[issue.newsPrefixCount - 1]?.sha256 ?? null)
      )
        throw new Error('Arm skipped available news')
      if (
        issue.quote &&
        ((auditQuotes
          ? !quoteMatches(issue.quote, quoteOut, identity)
          : sha(readFileSync(join(quoteOut, issue.quote.filename))) !==
            issue.quote.physicalSha256) ||
          ms(issue.quote.captureEndUtc) >= ms(issue.issuedAtUtc))
      )
        throw new Error('Arm quote source mismatch')
      if (
        issue.preEventObservedSlope &&
        (auditQuotes
          ? !quoteMatches(issue.preEventObservedSlope.fromQuote, quoteOut, identity)
          : sha(readFileSync(join(quoteOut, issue.preEventObservedSlope.fromQuote.filename))) !==
            issue.preEventObservedSlope.fromQuote.physicalSha256)
      )
        throw new Error('Arm prior quote source mismatch')
      if (
        JSON.stringify(issue.preEventObservedSlope) !==
        JSON.stringify(slope(issue.preEventObservedSlope?.fromQuote ?? null, issue.quote))
      )
        throw new Error('Arm slope mismatch')
      if (auditQuotes) {
        const eligible = readValidatedCheckpoints({ out: quoteOut, identity }).filter(
          (row) =>
            ms(row.checkpoint.captureEndUtc) < ms(issue.issuedAtUtc) &&
            row.checkpoint.block.timestamp * 1000 < ms(issue.issuedAtUtc),
        )
        const expectedQuote = eligible.length ? quoteRef(eligible.at(-1)) : null
        const expectedPrior = eligible.length > 1 ? quoteRef(eligible.at(-2)) : null
        if (
          JSON.stringify(issue.quote) !== JSON.stringify(expectedQuote) ||
          JSON.stringify(issue.preEventObservedSlope) !==
            JSON.stringify(slope(expectedPrior, expectedQuote))
        )
          throw new Error('Arm as-of quote selection mismatch')
      }
      if (index === 0) processed = issue.newsPrefixCount
    } else if (issue.kind === 'scan') {
      const end = Math.max(processed, availablePrefix(news.receipts, issue.issuedAtUtc))
      if (issue.fromNewsSequence !== processed + 1 || issue.toNewsSequence !== end)
        throw new Error('Scan prefix mismatch')
      const expected = buildObservations(
        news.receipts,
        processed,
        end,
        issues,
        newsOut,
        issue.issuedAtUtc,
      )
      if (JSON.stringify(issue.observations) !== JSON.stringify(expected))
        throw new Error('Scan as-of replay mismatch')
      processed = end
    } else throw new Error('Invalid enrollment issue kind')
    issues.push(issue)
  }
  return { count: issues.length, last: issues.at(-1) ?? null, issues, news }
}

function buildObservations(receipts, start, end, issues, newsOut, issuedAtUtc) {
  const seen = new Set(
    issues
      .filter((issue) => issue.kind === 'scan')
      .flatMap((issue) => issue.observations.map((observation) => observation.eventId)),
  )
  const observations = []
  for (let index = start; index < end; index++) {
    const receipt = receipts[index]
    if (seen.has(receipt.group.eventId)) continue
    const first = receipts.find((item) => item.group.eventId === receipt.group.eventId)
    const arm = [...issues]
      .reverse()
      .find(
        (issue) =>
          issue.kind === 'arm' && ms(issue.issuedAtUtc) < ms(receipt.observation.fetchedAt),
      )
    observations.push(assess(receipt, first, arm, newsOut, issuedAtUtc))
    seen.add(receipt.group.eventId)
  }
  return observations
}

export function arm({
  out = OUT,
  newsOut = NEWS_OUT,
  quoteOut = QUOTE_OUT,
  identity = sourceIdentity(),
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  const issuedAtUtc = clock(now)
  const state = verifyIssues({ out, newsOut, quoteOut, identity })
  if (state.last && ms(issuedAtUtc) <= ms(state.last.issuedAtUtc))
    throw new Error('Nonadvancing enrollment clock')
  const processed =
    state.issues.filter((issue) => issue.kind === 'scan').at(-1)?.toNewsSequence ??
    state.issues.find((issue) => issue.kind === 'arm')?.newsPrefixCount ??
    0
  const available = availablePrefix(state.news.receipts, issuedAtUtc)
  // First arm explicitly excludes the existing historical ledger. Later arms
  // cannot silently skip new observations before a scan has assessed them.
  if (state.count && (available !== processed || state.news.count !== processed))
    throw new Error('Scan news before rearming')
  const newsPrefixCount = state.count ? processed : state.news.count
  const rows = readValidatedCheckpoints({ out: quoteOut, identity })
  const selected = rows
    .filter(
      (row) =>
        ms(row.checkpoint.captureEndUtc) < ms(issuedAtUtc) &&
        row.checkpoint.block.timestamp * 1000 < ms(issuedAtUtc),
    )
    .at(-1)
  const quote = selected ? quoteRef(selected) : null
  const lastArm = state.issues.filter((issue) => issue.kind === 'arm').at(-1)
  if (lastArm && JSON.stringify(lastArm.quote) === JSON.stringify(quote))
    return { status: 'unchanged', count: state.count, armSequence: lastArm.sequence }
  const prior = selected
    ? rows
        .filter((row) => ms(row.checkpoint.captureEndUtc) < ms(selected.checkpoint.captureEndUtc))
        .at(-1)
    : null
  const preEventObservedSlope = slope(prior ? quoteRef(prior) : null, quote)
  const issue = seal({
    study: STUDY,
    kind: 'arm',
    sequence: state.count + 1,
    previousSha256: state.last?.sha256 ?? null,
    issuedAtUtc,
    newsPrefixCount,
    newsPrefixLastSha256: state.news.receipts[newsPrefixCount - 1]?.sha256 ?? null,
    quote,
    preEventObservedSlope,
  })
  append(out, issue, stat)
  return issue
}

export function enroll({
  out = OUT,
  newsOut = NEWS_OUT,
  quoteOut = QUOTE_OUT,
  identity = sourceIdentity(),
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  const issuedAtUtc = clock(now)
  // Only the already armed quote file is reread here. Later outcome quote
  // files are never opened during event enrollment.
  const state = verifyIssues({ out, newsOut, quoteOut, identity, auditQuotes: false })
  if (!state.issues.some((issue) => issue.kind === 'arm'))
    throw new Error('Prospective arm required')
  if (ms(issuedAtUtc) <= ms(state.last.issuedAtUtc))
    throw new Error('Nonadvancing enrollment clock')
  const processed =
    state.issues.filter((issue) => issue.kind === 'scan').at(-1)?.toNewsSequence ??
    state.issues.find((issue) => issue.kind === 'arm').newsPrefixCount
  const end = Math.max(processed, availablePrefix(state.news.receipts, issuedAtUtc))
  if (end === processed) return { status: 'unchanged', count: state.count }
  const observations = buildObservations(
    state.news.receipts,
    processed,
    end,
    state.issues,
    newsOut,
    issuedAtUtc,
  )
  const issue = seal({
    study: STUDY,
    kind: 'scan',
    sequence: state.count + 1,
    previousSha256: state.last.sha256,
    issuedAtUtc,
    fromNewsSequence: processed + 1,
    toNewsSequence: end,
    observations,
  })
  append(out, issue, stat)
  return issue
}

function args(argv) {
  const mode = argv[0] ?? '--verify'
  if (!['--verify', '--arm', '--run'].includes(mode) || (argv.length !== 1 && argv.length !== 0))
    throw new Error('Invalid enrollment command')
  return mode
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = args(process.argv.slice(2))
    const result = mode === '--arm' ? arm() : mode === '--run' ? enroll() : verifyIssues()
    console.log(
      JSON.stringify(
        mode === '--verify'
          ? { count: result.count, lastSequence: result.last?.sequence ?? null }
          : result,
      ),
    )
  } catch {
    console.error('News prospective enrollment or verification failed')
    process.exitCode = 1
  }
}
