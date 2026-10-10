// Offline, append-only news observations for prospective venue-signal research.
// Input is a JSON array or JSONL export of venue_news rows. No alerts are sent.
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

export const STUDY = 'venue-news-event-ledger-v1'
export const OUT = resolve('data/research/venue-signals/news-events')
const RESERVE_BYTES = 1024 ** 3
const DUPLICATE_WINDOW_MS = 48 * 3600 * 1000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _ignored, ...value }) => value

function iso(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) return null
  if (typeof value === 'string') {
    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/,
    )
    if (!match) throw new Error(`Invalid ${field}`)
    const [, year, month, day, hour, minute, second] = match.map(Number)
    const calendar = new Date(Date.UTC(year, month - 1, day))
    if (
      calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() + 1 !== month ||
      calendar.getUTCDate() !== day ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    )
      throw new Error(`Invalid ${field}`)
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`Invalid ${field}`)
  return new Date(ms).toISOString()
}

function canonicalUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid news URL')
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname)
    throw new Error('Invalid news URL')
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(key))
      url.searchParams.delete(key)
  }
  url.searchParams.sort()
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString()
}

function normalizedTitle(title) {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function normalizeRow(row, receiptVersion = 2) {
  if (!row || typeof row !== 'object') throw new Error('Invalid news row')
  if (![1, 2].includes(receiptVersion)) throw new Error('Unsupported news receipt version')
  const rawVenue = String(row.venue ?? '')
  const rawUrl = String(row.url ?? '')
  const venue = rawVenue.trim()
  const title = String(row.title ?? '').trim()
  const source = String(row.source ?? '').trim()
  const url = rawUrl.trim()
  if (!venue || !title || !source || !url) throw new Error('Incomplete news row')
  const fetchedAt = iso(row.fetched_at ?? row.fetchedAt, 'fetched_at')
  const publishedAt = iso(row.published_at ?? row.publishedAt, 'published_at', true)
  const canonical = canonicalUrl(url)
  return {
    venue,
    title,
    source,
    url,
    canonicalUrl: canonical,
    publishedAt,
    fetchedAt,
    // v1 used a tracking-stripped URL as identity. Keep that exact calculation
    // for immutable existing receipts; v2 follows DB UNIQUE(venue, raw url).
    observationKey:
      receiptVersion === 1
        ? sha(JSON.stringify([venue, canonical]))
        : sha(JSON.stringify([rawVenue, rawUrl])),
    titleKey: sha(JSON.stringify([venue, normalizedTitle(title)])),
    publicationTiming:
      publishedAt && Date.parse(publishedAt) > Date.parse(fetchedAt)
        ? 'published_after_first_seen'
        : 'ordinary_or_missing',
  }
}

// An official or scheduled label requires a separately supplied primary-source
// record. Headline text and publisher names never promote a row by themselves.
export function classify(row, evidence = null) {
  const observed = normalizeRow(row)
  if (evidence === null || evidence === undefined)
    return { kind: 'headline', availableAt: observed.fetchedAt, evidence: null }
  if (!['official_observed', 'scheduled'].includes(evidence.kind))
    throw new Error('Unsupported evidence kind')
  const sourceUrl = canonicalUrl(evidence.sourceUrl)
  if (!sourceUrl.startsWith('https://')) throw new Error('Official evidence requires HTTPS')
  const firstSeenAt = iso(evidence.firstSeenAt, 'evidence firstSeenAt')
  const eventAt = iso(evidence.eventAt, 'evidence eventAt')
  if (evidence.kind === 'scheduled' && Date.parse(eventAt) <= Date.parse(firstSeenAt))
    throw new Error('Scheduled event must follow evidence first-seen time')
  if (evidence.kind === 'official_observed' && Date.parse(eventAt) > Date.parse(firstSeenAt))
    throw new Error('Observed event cannot follow evidence first-seen time')
  return {
    kind: evidence.kind,
    availableAt: new Date(
      Math.max(Date.parse(observed.fetchedAt), Date.parse(firstSeenAt)),
    ).toISOString(),
    evidence: {
      sourceUrl,
      firstSeenAt,
      eventAt,
      // The ledger records supplied evidence, not independent authenticity.
      authorityStatus: 'supplied_unverified',
    },
  }
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
    throw new Error('News ledger disk reserve reached')
}

function receiptName(sequence) {
  return `${String(sequence).padStart(12, '0')}.json`
}

function readReceipt(path) {
  const receipt = JSON.parse(readFileSync(path, 'utf8'))
  if (receipt.sha256 !== sha(JSON.stringify(unsigned(receipt))))
    throw new Error('News receipt SHA mismatch')
  return receipt
}

export function verify(out = OUT) {
  if (!existsSync(out)) return { count: 0, last: null, receipts: [] }
  const filenames = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const receipts = []
  const seen = new Set()
  let previous = null
  for (const [index, filename] of filenames.entries()) {
    if (filename !== receiptName(index + 1)) throw new Error('News receipt sequence gap')
    const receipt = readReceipt(join(out, filename))
    if (receipt.study !== STUDY || receipt.sequence !== index + 1)
      throw new Error('News receipt identity mismatch')
    const receiptVersion = receipt.receiptVersion ?? 1
    if (![1, 2].includes(receiptVersion)) throw new Error('Unsupported news receipt version')
    if (
      receipt.previousSha256 !== previous?.sha256 &&
      !(index === 0 && receipt.previousSha256 === null)
    )
      throw new Error('News receipt chain mismatch')
    const normalized = normalizeRow(receipt.raw, receiptVersion)
    const classified = classify(receipt.raw, receipt.suppliedEvidence)
    if (JSON.stringify(normalized) !== JSON.stringify(receipt.observation))
      throw new Error('News observation recomputation mismatch')
    if (JSON.stringify(classified) !== JSON.stringify(receipt.classification))
      throw new Error('News classification recomputation mismatch')
    // Compare every version by the raw DB key so v1 and v2 can coexist.
    const rawKey = normalizeRow(receipt.raw, 2).observationKey
    if (seen.has(rawKey)) throw new Error('Duplicate news observation')
    if (previous && normalized.fetchedAt < previous.observation.fetchedAt)
      throw new Error('News first-seen chronology regression')
    seen.add(rawKey)
    const expected = duplicateGroup(normalized, receipts)
    if (JSON.stringify(receipt.group) !== JSON.stringify(expected))
      throw new Error('News duplicate group mismatch')
    receipts.push(receipt)
    previous = receipt
  }
  return { count: receipts.length, last: previous, receipts }
}

function duplicateGroup(row, receipts) {
  const existing = receipts.findLast(
    (r) =>
      r.observation.venue === row.venue &&
      (r.observation.canonicalUrl === row.canonicalUrl ||
        (r.observation.titleKey === row.titleKey &&
          Date.parse(row.fetchedAt) - Date.parse(r.observation.fetchedAt) <= DUPLICATE_WINDOW_MS)),
  )
  return existing
    ? { eventId: existing.group.eventId, relation: 'possible_syndication' }
    : {
        eventId: sha(JSON.stringify([row.venue, row.observationKey, row.fetchedAt])),
        relation: 'new',
      }
}

function immutableWrite(path, receipt, stat = statfsSync) {
  const bytes = `${JSON.stringify(receipt)}\n`
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

export function appendRows(rows, { out = OUT, stat = statfsSync } = {}) {
  if (!Array.isArray(rows)) throw new Error('News input must be an array')
  const state = verify(out)
  const receipts = [...state.receipts]
  const seen = new Map(receipts.map((r) => [normalizeRow(r.raw, 2).observationKey, r]))
  const ordered = rows
    .map((raw) => ({ raw, observation: normalizeRow(raw) }))
    .sort(
      (a, b) =>
        a.observation.fetchedAt.localeCompare(b.observation.fetchedAt) ||
        a.observation.observationKey.localeCompare(b.observation.observationKey),
    )
  let appended = 0,
    existing = 0
  for (const item of ordered) {
    const prior = seen.get(item.observation.observationKey)
    if (prior) {
      if (JSON.stringify(item.observation) !== JSON.stringify(normalizeRow(prior.raw, 2)))
        throw new Error('Conflicting news observation for existing URL')
      if (JSON.stringify(item.raw.evidence ?? null) !== JSON.stringify(prior.suppliedEvidence))
        throw new Error('Conflicting evidence for existing news observation')
      existing++
      continue
    }
    if (receipts.length && item.observation.fetchedAt < receipts.at(-1).observation.fetchedAt)
      throw new Error('Historical news row predates append frontier')
    const suppliedEvidence = item.raw.evidence ?? null
    const receipt = seal({
      study: STUDY,
      receiptVersion: 2,
      sequence: receipts.length + 1,
      previousSha256: receipts.at(-1)?.sha256 ?? null,
      raw: {
        venue: item.raw.venue,
        title: item.raw.title,
        source: item.raw.source,
        url: item.raw.url,
        published_at: item.raw.published_at ?? item.raw.publishedAt ?? null,
        fetched_at: item.raw.fetched_at ?? item.raw.fetchedAt,
      },
      suppliedEvidence,
      observation: item.observation,
      classification: classify(item.raw, suppliedEvidence),
      group: duplicateGroup(item.observation, receipts),
    })
    immutableWrite(join(out, receiptName(receipt.sequence)), receipt, stat)
    receipts.push(receipt)
    seen.set(item.observation.observationKey, receipt)
    appended++
  }
  return { appended, existing, count: receipts.length }
}

function parseInput(path) {
  const content = readFileSync(path, 'utf8')
  if (content.trimStart().startsWith('[')) return JSON.parse(content)
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

async function readExistingVenueNews() {
  const [{ neon }, { readEnv }] = await Promise.all([
    import('@neondatabase/serverless'),
    import('../lib/venue-reads.mjs'),
  ])
  const { get } = readEnv()
  const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
  if (!dbUrl) throw new Error('No venue news database configured')
  const sql = neon(dbUrl)
  return sql`
    SELECT venue, title, source, url, published_at, fetched_at
    FROM venue_news
    ORDER BY fetched_at ASC, venue ASC, url ASC
  `
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2)
  const at = (flag) => argv.indexOf(flag)
  const out = at('--out') >= 0 ? resolve(argv[at('--out') + 1]) : OUT
  if (argv.includes('--verify')) {
    const result = verify(out)
    console.log(
      JSON.stringify({
        count: result.count,
        lastSeenAt: result.last?.observation.fetchedAt ?? null,
      }),
    )
  } else if (at('--input') >= 0) {
    const input = argv[at('--input') + 1]
    if (!input) throw new Error('Missing --input path')
    console.log(JSON.stringify(appendRows(parseInput(resolve(input)), { out })))
  } else if (argv.includes('--from-db')) {
    console.log(JSON.stringify(appendRows(await readExistingVenueNews(), { out })))
  } else {
    throw new Error(
      'Usage: node venue-news-event-ledger.mjs --input export.json | --from-db | --verify [--out path]',
    )
  }
}
