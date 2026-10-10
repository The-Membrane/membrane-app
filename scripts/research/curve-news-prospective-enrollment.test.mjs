import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendRows } from './venue-news-event-ledger.mjs'
import { PARTS, routesFromParts, sourceIdentity } from './curve-prospective-quote.mjs'
import { arm, enroll, verifyIssues } from './curve-news-prospective-enrollment.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const stat = () => ({ bavail: 1_000_000, bsize: 4096 })
const now = (value) => () => new Date(value)
const clock = {
  quote: '2026-09-27T10:00:00Z',
  arm: '2026-09-27T10:05:00Z',
  news: '2026-09-27T11:00:00Z',
  scan: '2026-09-27T11:05:00Z',
}

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'news-enroll-'))
  const paths = {
    out: join(root, 'issues'),
    newsOut: join(root, 'news'),
    quoteOut: join(root, 'quotes'),
  }
  mkdirSync(paths.newsOut)
  mkdirSync(paths.quoteOut)
  try {
    return fn(paths)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function quote(out, captureEndUtc = clock.quote, block = 100) {
  const parts = [0, 1].map(() => PARTS.map((amount) => String(amount * 1_000_000_000_000)))
  const payload = {
    study: 'curve-crvusd-secondary-prospective-quote-v1',
    source: sourceIdentity(),
    block: {
      number: block,
      hash: `0x${String(block).padStart(64, 'a')}`,
      timestamp: Math.floor(Date.parse(captureEndUtc) / 1000) - 60,
    },
    captureStartUtc: new Date(Date.parse(captureEndUtc) - 30_000).toISOString(),
    captureEndUtc,
    pinMode: 'hash',
    pinCaveat: null,
    raw: { vaultAssetsCrvUsd: '1000000000000000000000000', parts },
    routes: routesFromParts(parts),
  }
  const saved = { ...payload, sha256: hash(JSON.stringify(payload)) }
  const filename = `${String(block).padStart(12, '0')}-${saved.block.hash.slice(2)}.json`
  writeFileSync(join(out, filename), `${JSON.stringify(saved)}\n`)
  return filename
}

function news(overrides = {}) {
  return {
    venue: 'scrvUSD',
    title: 'scrvUSD vault change',
    source: 'Example',
    url: 'https://example.org/first',
    published_at: null,
    fetched_at: clock.news,
    ...overrides,
  }
}

test('arm predates local first-seen and enrolls one sealed prospective incident', () =>
  fixture((paths) => {
    quote(paths.quoteOut, '2026-09-27T09:30:00Z', 99)
    quote(paths.quoteOut)
    const prior = arm({ ...paths, now: now(clock.arm), stat })
    assert.equal(prior.newsPrefixCount, 0)
    assert.equal(prior.preEventObservedSlope.observedNominalQuoteBpsPerHour, 0)
    appendRows([news()], { out: paths.newsOut, stat })
    const issue = enroll({ ...paths, now: now(clock.scan), stat })
    assert.equal(issue.observations.length, 1)
    const event = issue.observations[0]
    assert.equal(event.status, 'enrolled')
    assert.equal(event.firstFetchedAtUtc, '2026-09-27T11:00:00.000Z')
    assert.equal(event.publishedAtUtc, null)
    assert.deepEqual(event.target.horizonsHours, [24, 168])
    assert.equal(event.preEventQuote.nominalInputCrvUsd, 1_000_000)
    assert.equal(event.preEventObservedSlope.gapHours, 0.5)
    assert.equal(verifyIssues(paths).count, 2)
    assert.deepEqual(enroll({ ...paths, now: now('2026-09-27T11:06:00Z'), stat }), {
      status: 'unchanged',
      count: 2,
    })
  }))

test('old news at first arm cannot be enrolled retroactively; a later duplicate remains unassessable', () =>
  fixture((paths) => {
    quote(paths.quoteOut)
    appendRows([news({ fetched_at: '2026-09-27T09:00:00Z' })], { out: paths.newsOut, stat })
    arm({ ...paths, now: now(clock.arm), stat })
    appendRows([news({ url: 'https://second.example/item', fetched_at: clock.news })], {
      out: paths.newsOut,
      stat,
    })
    const issue = enroll({ ...paths, now: now(clock.scan), stat })
    assert.equal(issue.observations[0].status, 'unassessable')
    assert.equal(issue.observations[0].reason, 'preexisting_or_duplicate_incident')
  }))

test('syndicated duplicate rows produce only one incident', () =>
  fixture((paths) => {
    quote(paths.quoteOut)
    arm({ ...paths, now: now(clock.arm), stat })
    appendRows(
      [news(), news({ url: 'https://second.example/item', fetched_at: '2026-09-27T11:01:00Z' })],
      { out: paths.newsOut, stat },
    )
    assert.equal(enroll({ ...paths, now: now(clock.scan), stat }).observations.length, 1)
  }))

test('scan then rearm uses the latest already sealed quote for a later incident without relabeling the first', () =>
  fixture((paths) => {
    const firstQuote = quote(paths.quoteOut)
    const firstArm = arm({ ...paths, now: now(clock.arm), stat })
    assert.equal(firstArm.quote.filename, firstQuote)
    appendRows([news()], { out: paths.newsOut, stat })
    const firstScan = enroll({ ...paths, now: now(clock.scan), stat })
    assert.equal(firstScan.observations[0].status, 'enrolled')
    const firstIssueBytes = readFileSync(join(paths.out, '000000000002.json'))

    const secondQuote = quote(paths.quoteOut, '2026-09-27T11:30:00Z', 101)
    const secondArm = arm({ ...paths, now: now('2026-09-27T11:35:00Z'), stat })
    assert.equal(secondArm.quote.filename, secondQuote)
    assert.equal(secondArm.newsPrefixCount, 1)
    appendRows(
      [
        news({
          title: 'scrvUSD second incident',
          url: 'https://example.org/second',
          fetched_at: '2026-09-27T12:00:00Z',
        }),
        news({ url: 'https://syndicated.example/first', fetched_at: '2026-09-27T12:01:00Z' }),
      ],
      { out: paths.newsOut, stat },
    )
    const secondScan = enroll({ ...paths, now: now('2026-09-27T12:05:00Z'), stat })
    assert.equal(secondScan.observations.length, 1)
    assert.equal(secondScan.observations[0].status, 'enrolled')
    assert.equal(secondScan.observations[0].armSequence, secondArm.sequence)
    assert.equal(secondScan.observations[0].preEventQuote.filename, secondQuote)
    assert.notEqual(secondScan.observations[0].eventId, firstScan.observations[0].eventId)
    assert.deepEqual(readFileSync(join(paths.out, '000000000002.json')), firstIssueBytes)
    assert.equal(verifyIssues(paths).count, 4)
  }))

test('rearm is idempotent until a new eligible sealed quote exists', () =>
  fixture((paths) => {
    quote(paths.quoteOut)
    const firstArm = arm({ ...paths, now: now(clock.arm), stat })
    assert.deepEqual(arm({ ...paths, now: now('2026-09-27T10:06:00Z'), stat }), {
      status: 'unchanged',
      count: 1,
      armSequence: firstArm.sequence,
    })
    assert.equal(readdirSync(paths.out).length, 1)
    appendRows([news()], { out: paths.newsOut, stat })
    const scan = enroll({ ...paths, now: now(clock.scan), stat })
    assert.equal(scan.observations[0].armSequence, firstArm.sequence)
    assert.deepEqual(arm({ ...paths, now: now('2026-09-27T11:06:00Z'), stat }), {
      status: 'unchanged',
      count: 2,
      armSequence: firstArm.sequence,
    })
    assert.equal(readdirSync(paths.out).length, 2)
    quote(paths.quoteOut, '2026-09-27T11:30:00Z', 101)
    const nextArm = arm({ ...paths, now: now('2026-09-27T11:35:00Z'), stat })
    assert.equal(nextArm.kind, 'arm')
    assert.equal(nextArm.sequence, 3)
    assert.equal(verifyIssues(paths).count, 3)
  }))

test('missing prior quote and ambiguous Curve scope stay unassessable', () =>
  fixture((paths) => {
    arm({ ...paths, now: now(clock.arm), stat })
    appendRows(
      [
        news(),
        news({
          venue: 'Curve',
          title: 'Curve governance update',
          url: 'https://example.org/curve',
          fetched_at: '2026-09-27T11:01:00Z',
        }),
      ],
      { out: paths.newsOut, stat },
    )
    const rows = enroll({ ...paths, now: now(clock.scan), stat }).observations
    assert.equal(rows[0].reason, 'missing_pre_event_quote')
    assert.equal(rows[1].reason, 'ambiguous_curve_relevance')
  }))

test('future news is not consumed at an earlier issue time', () =>
  fixture((paths) => {
    quote(paths.quoteOut)
    arm({ ...paths, now: now(clock.arm), stat })
    appendRows([news({ fetched_at: '2026-09-27T12:00:00Z' })], { out: paths.newsOut, stat })
    assert.deepEqual(enroll({ ...paths, now: now(clock.scan), stat }), {
      status: 'unchanged',
      count: 1,
    })
    assert.equal(
      enroll({ ...paths, now: now('2026-09-27T12:01:00Z'), stat }).observations[0].status,
      'enrolled',
    )
  }))

test('first arm excludes every already saved ledger row, including a future-dated one', () =>
  fixture((paths) => {
    quote(paths.quoteOut)
    appendRows([news({ fetched_at: '2026-09-27T12:00:00Z' })], { out: paths.newsOut, stat })
    const baseline = arm({ ...paths, now: now(clock.arm), stat })
    assert.equal(baseline.newsPrefixCount, 1)
    assert.deepEqual(enroll({ ...paths, now: now('2026-09-27T12:01:00Z'), stat }), {
      status: 'unchanged',
      count: 1,
    })
    assert.equal(verifyIssues(paths).count, 1)
  }))

test('pre-arm headline cannot enroll when supplied official evidence becomes available after arm', () =>
  fixture((paths) => {
    quote(paths.quoteOut)
    appendRows(
      [
        news({
          fetched_at: '2026-09-27T09:00:00Z',
          evidence: {
            kind: 'scheduled',
            sourceUrl: 'https://example.org/notice',
            firstSeenAt: '2026-09-27T11:00:00Z',
            eventAt: '2026-09-28T00:00:00Z',
          },
        }),
      ],
      { out: paths.newsOut, stat },
    )
    const baseline = arm({ ...paths, now: now(clock.arm), stat })
    assert.equal(baseline.newsPrefixCount, 1)
    assert.deepEqual(enroll({ ...paths, now: now(clock.scan), stat }), {
      status: 'unchanged',
      count: 1,
    })
  }))

test('post-arm headline with future supplied evidence is recorded as unassessable as of scan', () =>
  fixture((paths) => {
    quote(paths.quoteOut)
    arm({ ...paths, now: now(clock.arm), stat })
    appendRows(
      [
        news({
          evidence: {
            kind: 'scheduled',
            sourceUrl: 'https://example.org/notice',
            firstSeenAt: '2026-09-27T12:00:00Z',
            eventAt: '2026-09-28T00:00:00Z',
          },
        }),
      ],
      { out: paths.newsOut, stat },
    )
    const row = enroll({ ...paths, now: now(clock.scan), stat }).observations[0]
    assert.equal(row.reason, 'evidence_not_available_as_of')
    assert.equal(row.firstFetchedAtUtc, '2026-09-27T11:00:00.000Z')
    assert.equal(row.availableAtUtc, '2026-09-27T12:00:00.000Z')
    assert.equal(verifyIssues(paths).count, 2)
  }))

test('enrollment never opens a later quote outcome', () =>
  fixture((paths) => {
    quote(paths.quoteOut)
    arm({ ...paths, now: now(clock.arm), stat })
    appendRows([news()], { out: paths.newsOut, stat })
    const future = quote(paths.quoteOut, '2026-09-27T11:02:00Z', 101)
    writeFileSync(join(paths.quoteOut, future), 'deliberately unreadable future outcome')
    assert.equal(
      enroll({ ...paths, now: now(clock.scan), stat }).observations[0].status,
      'enrolled',
    )
    assert.throws(() => verifyIssues(paths))
  }))

test('publication time cannot substitute for local first fetch', () =>
  fixture((paths) => {
    quote(paths.quoteOut)
    arm({ ...paths, now: now(clock.arm), stat })
    appendRows([news({ published_at: '2026-09-01T00:00:00Z' })], { out: paths.newsOut, stat })
    const event = enroll({ ...paths, now: now(clock.scan), stat }).observations[0]
    assert.equal(event.status, 'enrolled')
    assert.equal(event.publishedAtUtc, '2026-09-01T00:00:00.000Z')
    assert.equal(event.availableAtUtc, '2026-09-27T11:00:00.000Z')
  }))

test('source tampering or issue tampering fails offline replay', () =>
  fixture((paths) => {
    const filename = quote(paths.quoteOut)
    arm({ ...paths, now: now(clock.arm), stat })
    appendRows([news()], { out: paths.newsOut, stat })
    enroll({ ...paths, now: now(clock.scan), stat })
    const quotePath = join(paths.quoteOut, filename)
    const original = readFileSync(quotePath)
    writeFileSync(quotePath, `${original.toString('utf8').trim()} `)
    assert.throws(() => verifyIssues(paths), /quote|SHA|Checkpoint/i)
    writeFileSync(quotePath, original)
    const newsFile = join(paths.newsOut, readdirSync(paths.newsOut)[0])
    const newsOriginal = readFileSync(newsFile)
    writeFileSync(newsFile, `${newsOriginal.toString('utf8').trim()} `)
    assert.throws(() => verifyIssues(paths), /source|replay/i)
    writeFileSync(newsFile, newsOriginal)
    const issueFile = join(paths.out, '000000000002.json')
    const issue = JSON.parse(readFileSync(issueFile))
    issue.observations[0].status = 'predicted'
    writeFileSync(issueFile, `${JSON.stringify(issue)}\n`)
    assert.throws(() => verifyIssues(paths), /identity|chain/i)
  }))
