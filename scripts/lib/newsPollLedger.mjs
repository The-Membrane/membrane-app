// Local, append-only evidence of attempted Google News RSS venue polls.
// A success describes the returned feed at one instant. It never proves that
// Google News saw every venue event or that no later headline appeared.
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

export const OUT = resolve('data/research/venue-signals/news-polls')
export const STUDY = 'venue-news-rss-polls-v1'
export const MAX_PER_RUN = 25
export const CURRENT_RECEIPT_VERSION = 3
const MIN_FREE_BYTES = 100 * 1024 * 1024
const STATUS = new Set([
  'success',
  'http_error',
  'fetch_error',
  'parse_error',
  'db_error', // Existing sealed receipts remain readable.
  'local_store_error',
])
const sha = (value) => createHash('sha256').update(value).digest('hex')
export const digestFeed = (xml) => sha(xml)
export const parsedItemIdentityV2 = ({ url, title, publishedAt }) =>
  sha(JSON.stringify([url, title, publishedAt]))
export const parsedItemIdentity = ({ url, title, source, publishedAt }) =>
  sha(JSON.stringify(['news-item-v3', url, title, source, publishedAt]))
export const digestParsedItems = (identities) => sha(JSON.stringify(identities))
const receiptName = (sequence) => `${String(sequence).padStart(12, '0')}.json`

export function sourceIdentity(query, url) {
  if (typeof query !== 'string' || !query.trim() || typeof url !== 'string')
    throw new Error('Invalid RSS source identity')
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'news.google.com')
    throw new Error('Unexpected RSS source host')
  return {
    kind: 'google-news-rss-search',
    querySha256: sha(query),
    urlSha256: sha(url),
  }
}

function iso(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new Error(`Invalid ${name}`)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new Error(`Invalid ${name}`)
  return value
}

function validate(input, { allowLegacy = false } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Invalid poll receipt')
  const legacy = allowLegacy && input.receiptVersion === undefined
  if (!legacy && ![2, CURRENT_RECEIPT_VERSION].includes(input.receiptVersion))
    throw new Error('Unsupported poll receipt version')
  const {
    venue,
    source,
    startedAtUtc,
    endedAtUtc,
    status,
    feedSha256,
    parsedIdentitySha256,
    parsedItemIdentitySha256s,
    feedItemCount,
    parsedItemCount,
    insertedCount,
    coverageStatus,
    failure,
  } = input
  if (typeof venue !== 'string' || !venue.trim() || venue.length > 128)
    throw new Error('Invalid poll venue')
  if (
    !source ||
    source.kind !== 'google-news-rss-search' ||
    !/^[0-9a-f]{64}$/.test(source.querySha256) ||
    !/^[0-9a-f]{64}$/.test(source.urlSha256)
  )
    throw new Error('Invalid poll source')
  iso(startedAtUtc, 'start time')
  iso(endedAtUtc, 'end time')
  if (endedAtUtc < startedAtUtc) throw new Error('Poll ended before it started')
  if (!STATUS.has(status)) throw new Error('Invalid poll status')
  if (
    ![feedSha256, parsedIdentitySha256].every(
      (value) => value === null || /^[0-9a-f]{64}$/.test(value),
    )
  )
    throw new Error('Invalid feed or parsed identity digest')
  if (
    !legacy &&
    parsedItemIdentitySha256s !== null &&
    (!Array.isArray(parsedItemIdentitySha256s) ||
      parsedItemIdentitySha256s.length > MAX_PER_RUN ||
      !parsedItemIdentitySha256s.every((item) => /^[0-9a-f]{64}$/.test(item)))
  )
    throw new Error('Invalid parsed item identities')
  if (
    !legacy &&
    parsedIdentitySha256 !== null &&
    (!parsedItemIdentitySha256s ||
      digestParsedItems(parsedItemIdentitySha256s) !== parsedIdentitySha256)
  )
    throw new Error('Parsed identity digest mismatch')
  const nonnegativeOrNull = (n) => n === null || (Number.isSafeInteger(n) && n >= 0)
  if (![feedItemCount, parsedItemCount, insertedCount].every(nonnegativeOrNull))
    throw new Error('Invalid poll count')
  if (status === 'success') {
    if (![feedItemCount, parsedItemCount, insertedCount].every(Number.isSafeInteger))
      throw new Error('Successful poll needs all counts')
    if (!feedSha256 || !parsedIdentitySha256)
      throw new Error('Successful poll needs feed and parsed identity digests')
    if (
      !legacy &&
      (!parsedItemIdentitySha256s || parsedItemIdentitySha256s.length !== parsedItemCount)
    )
      throw new Error('Successful poll identity count mismatch')
    if (
      feedItemCount < parsedItemCount ||
      parsedItemCount < insertedCount ||
      parsedItemCount > MAX_PER_RUN
    )
      throw new Error('Inconsistent successful poll counts')
    const expectedCoverage =
      input.receiptVersion === CURRENT_RECEIPT_VERSION
        ? feedItemCount >= MAX_PER_RUN
          ? parsedItemCount === MAX_PER_RUN
            ? 'at_or_over_cap'
            : 'incomplete_items'
          : feedItemCount !== parsedItemCount
            ? 'incomplete_items'
            : 'observed_below_cap'
        : feedItemCount >= MAX_PER_RUN || parsedItemCount >= MAX_PER_RUN
          ? 'at_or_over_cap'
          : feedItemCount !== parsedItemCount
            ? 'incomplete_items'
            : 'observed_below_cap'
    if (coverageStatus !== expectedCoverage || failure !== null)
      throw new Error('Invalid successful poll coverage or failure')
  } else {
    if (coverageStatus !== 'unavailable') throw new Error('Failed poll cannot certify coverage')
    if (!failure || failure.stage !== status || !/^[A-Z0-9_]{2,40}$/.test(failure.code))
      throw new Error('Invalid poll failure')
    if (
      status === 'http_error' &&
      (!Number.isInteger(failure.httpStatus) ||
        failure.httpStatus < 100 ||
        failure.httpStatus > 599)
    )
      throw new Error('Invalid HTTP status')
    if (insertedCount !== null && status !== 'db_error')
      throw new Error('Only DB failures may carry partial inserts')
    if (
      (status === 'http_error' || status === 'fetch_error') &&
      (feedSha256 !== null ||
        parsedIdentitySha256 !== null ||
        (!legacy && parsedItemIdentitySha256s !== null) ||
        feedItemCount !== null ||
        parsedItemCount !== null)
    )
      throw new Error('Fetch failure cannot claim a parsed feed')
  }
  return input
}

function unsigned(receipt) {
  const { sha256: _sha256, ...payload } = receipt
  return payload
}

/** Verify one DB-mirrored receipt's sealed bytes and internal coverage shape. */
export function verifyPollReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    throw new Error('Invalid poll receipt')
  if (receipt.sha256 !== sha(JSON.stringify(unsigned(receipt))))
    throw new Error('Poll receipt SHA mismatch')
  if (receipt.study !== STUDY || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1)
    throw new Error('Poll receipt identity mismatch')
  return validate(receipt, { allowLegacy: false })
}

export function verifyPolls(out = OUT) {
  if (!existsSync(out)) return { count: 0, last: null, receipts: [] }
  const names = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const receipts = []
  const lastByVenue = new Map()
  for (const [index, name] of names.entries()) {
    if (name !== receiptName(index + 1)) throw new Error('Poll receipt sequence gap')
    const bytes = readFileSync(join(out, name), 'utf8')
    const receipt = JSON.parse(bytes)
    if (bytes !== `${JSON.stringify(receipt)}\n`)
      throw new Error('Poll receipt physical bytes mismatch')
    if (receipt.sha256 !== sha(JSON.stringify(unsigned(receipt))))
      throw new Error('Poll receipt SHA mismatch')
    if (
      receipt.study !== STUDY ||
      receipt.sequence !== index + 1 ||
      receipt.previousSha256 !== (receipts.at(-1)?.sha256 ?? null)
    )
      throw new Error('Poll receipt chain mismatch')
    validate(receipt, { allowLegacy: true })
    if (receipts.length && receipt.startedAtUtc < receipts.at(-1).startedAtUtc)
      throw new Error('Poll receipt start chronology regression')
    const priorVenue = lastByVenue.get(receipt.venue)
    if (priorVenue && receipt.startedAtUtc < priorVenue.endedAtUtc)
      throw new Error('Overlapping venue poll receipts')
    if (priorVenue && receipt.endedAtUtc < priorVenue.endedAtUtc)
      throw new Error('Venue poll end chronology regression')
    receipts.push(receipt)
    lastByVenue.set(receipt.venue, receipt)
  }
  return { count: receipts.length, last: receipts.at(-1) ?? null, receipts }
}

function diskGuard(out, extraBytes) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (path === parent) throw new Error('No poll output ancestor')
    path = parent
  }
  const fs = statfsSync(path)
  if (Number(fs.bavail) * Number(fs.bsize) - extraBytes < MIN_FREE_BYTES)
    throw new Error('News poll receipt disk reserve reached')
}

export function appendPoll(input, { out = OUT } = {}) {
  const { last, count, receipts } = verifyPolls(out)
  if (last && input.startedAtUtc < last.startedAtUtc)
    throw new Error('Historical poll predates append frontier')
  const priorVenue = receipts.findLast((receipt) => receipt.venue === input.venue)
  if (priorVenue && input.startedAtUtc < priorVenue.endedAtUtc)
    throw new Error('Overlapping venue poll receipts')
  const payload = {
    study: STUDY,
    receiptVersion: CURRENT_RECEIPT_VERSION,
    sequence: count + 1,
    previousSha256: last?.sha256 ?? null,
    venue: input.venue,
    source: input.source,
    startedAtUtc: input.startedAtUtc,
    endedAtUtc: input.endedAtUtc,
    status: input.status,
    feedSha256: input.feedSha256,
    parsedIdentitySha256: input.parsedIdentitySha256,
    parsedItemIdentitySha256s: input.parsedItemIdentitySha256s,
    feedItemCount: input.feedItemCount,
    parsedItemCount: input.parsedItemCount,
    insertedCount: input.insertedCount,
    coverageStatus: input.coverageStatus,
    failure: input.failure,
  }
  validate(payload)
  const receipt = { ...payload, sha256: sha(JSON.stringify(payload)) }
  const bytes = `${JSON.stringify(receipt)}\n`
  diskGuard(out, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const target = join(out, receiptName(receipt.sequence))
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return receipt
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--verify' || process.argv.length !== 3)
    throw new Error('Usage: node scripts/lib/newsPollLedger.mjs --verify')
  const { count, last } = verifyPolls()
  console.log(JSON.stringify({ study: STUDY, count, lastSha256: last?.sha256 ?? null }))
}
