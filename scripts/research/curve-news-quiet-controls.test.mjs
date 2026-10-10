import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PARTS, routesFromParts, sourceIdentity } from './curve-prospective-quote.mjs'
import { arm, enroll } from './curve-news-prospective-enrollment.mjs'
import { appendRows } from './venue-news-event-ledger.mjs'
import { parsedItemIdentity, parsedItemIdentityV2 } from '../lib/newsPollLedger.mjs'
import {
  controlScoreStatus,
  feedCoverage,
  CONFIG_PATH,
  issueQuiet,
  scoreMatured,
  verifyControls,
} from './curve-news-quiet-controls.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const stat = () => ({ bavail: 1_000_000, bsize: 4096 })
const at = (value) => () => new Date(value)
const SOURCE = {
  kind: 'google-news-rss-search',
  querySha256: 'a'.repeat(64),
  urlSha256: 'b'.repeat(64),
}

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'news-quiet-'))
  const paths = {
    out: join(root, 'controls'),
    enrollOut: join(root, 'enrollment'),
    newsOut: join(root, 'news'),
    quoteOut: join(root, 'quotes'),
    pollOut: join(root, 'polls'),
    configPath: join(root, 'venue-recorder.config.json'),
  }
  mkdirSync(paths.newsOut)
  mkdirSync(paths.quoteOut)
  copyFileSync(CONFIG_PATH, paths.configPath)
  try {
    return fn(paths)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function quote(out, captureEndUtc, block) {
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
  const saved = { ...payload, sha256: sha(JSON.stringify(payload)) }
  const name = `${String(block).padStart(12, '0')}-${saved.block.hash.slice(2)}.json`
  writeFileSync(join(out, name), `${JSON.stringify(saved)}\n`)
  return name
}

function poll(sequence, end, overrides = {}) {
  return {
    sequence,
    receiptVersion: 2,
    venue: 'scrvUSD',
    source: SOURCE,
    endedAtUtc: end,
    status: 'success',
    coverageStatus: 'observed_below_cap',
    feedItemCount: 0,
    parsedItemCount: 0,
    parsedItemIdentitySha256s: [],
    ...overrides,
  }
}

test('prospective candidate pins arm and stays unscorable without poll receipts', () =>
  fixture((paths) => {
    quote(paths.quoteOut, '2026-09-27T10:00:00Z', 100)
    const firstArm = arm({ ...paths, out: paths.enrollOut, now: at('2026-09-27T10:05:00Z'), stat })
    const issued = issueQuiet({ ...paths, now: at('2026-09-27T10:06:00Z'), stat })
    assert.equal(issued.candidate.status, 'candidate_unconfirmed')
    assert.equal(issued.candidate.source.arm.sequence, firstArm.sequence)
    assert.equal(issued.candidate.newsCoverage, 'unknown_until_verified_poll_interval')
    assert.equal(issued.candidate.preAnchorWashout.hours, 168)
    assert.equal(issued.candidate.preAnchorWashout.status, 'pending_verified_feed_coverage')
    assert.ok(existsSync(join(paths.out, issued.candidate.sourceSnapshot.filename)))
    assert.equal(verifyControls(paths).count, 1)
    assert.deepEqual(issueQuiet({ ...paths, now: at('2026-09-27T10:07:00Z'), stat }), {
      status: 'unchanged',
      count: 1,
    })

    for (let hour = 3; hour <= 27; hour += 3)
      quote(
        paths.quoteOut,
        new Date(Date.parse('2026-09-27T10:00:00Z') + hour * 3_600_000).toISOString(),
        100 + hour,
      )
    const outcome = scoreMatured({ ...paths, now: at('2026-09-28T15:00:00Z'), stat })
    assert.equal(outcome.count, 1)
    assert.equal(outcome.results[0].result.horizonHours, 24)
    assert.equal(outcome.results[0].result.quoteOutcome.status, 'observed')
    assert.equal(outcome.results[0].result.preAnchorNewsCoverage.reason, 'missing_start_poll')
    assert.equal(outcome.results[0].result.status, 'unscorable_preanchor_feed_coverage')
    assert.equal(verifyControls(paths).count, 2)
  }))

test('an old arm is never retroactively promoted into a quiet candidate', () =>
  fixture((paths) => {
    quote(paths.quoteOut, '2026-09-27T10:00:00Z', 100)
    arm({ ...paths, out: paths.enrollOut, now: at('2026-09-27T10:05:00Z'), stat })
    assert.deepEqual(issueQuiet({ ...paths, now: at('2026-09-27T11:00:00Z'), stat }), {
      status: 'waiting_fresh_arm',
      count: 0,
      armSequence: 1,
    })
    assert.equal(verifyControls(paths).count, 0)
  }))

test('a recently first-seen relevant item excludes the post-incident arm at issue time', () =>
  fixture((paths) => {
    quote(paths.quoteOut, '2026-09-27T10:00:00Z', 100)
    appendRows(
      [
        {
          venue: 'scrvUSD',
          title: 'scrvUSD vault change',
          source: 'Example',
          url: 'https://example.org/recent',
          published_at: null,
          fetched_at: '2026-09-27T09:00:00Z',
        },
      ],
      { out: paths.newsOut, stat },
    )
    arm({ ...paths, out: paths.enrollOut, now: at('2026-09-27T10:05:00Z'), stat })
    const issued = issueQuiet({ ...paths, now: at('2026-09-27T10:06:00Z'), stat })
    assert.equal(issued.candidate.status, 'recent_incident_excluded')
    assert.equal(issued.candidate.reason, 'recent_incident_in_washout')
    assert.equal(issued.candidate.preAnchorWashout.knownRelevantFirstSeenCount, 1)
    assert.equal(verifyControls(paths).count, 1)
  }))

test('incident gets the same prespecified nominal horizon when future quote grid qualifies', () =>
  fixture((paths) => {
    quote(paths.quoteOut, '2026-09-27T10:00:00Z', 100)
    arm({ ...paths, out: paths.enrollOut, now: at('2026-09-27T10:05:00Z'), stat })
    issueQuiet({ ...paths, now: at('2026-09-27T10:06:00Z'), stat })
    appendRows(
      [
        {
          venue: 'scrvUSD',
          title: 'scrvUSD vault change',
          source: 'Example',
          url: 'https://example.org/first',
          published_at: null,
          fetched_at: '2026-09-27T11:00:00Z',
        },
      ],
      { out: paths.newsOut, stat },
    )
    const scan = enroll({ ...paths, out: paths.enrollOut, now: at('2026-09-27T11:05:00Z'), stat })
    assert.equal(scan.observations[0].status, 'enrolled')
    for (let hour = 3; hour <= 27; hour += 3)
      quote(
        paths.quoteOut,
        new Date(Date.parse('2026-09-27T10:00:00Z') + hour * 3_600_000).toISOString(),
        100 + hour,
      )
    const outcome = scoreMatured({ ...paths, now: at('2026-09-28T15:00:00Z'), stat })
    assert.equal(outcome.count, 2)
    assert.deepEqual(
      outcome.results.map((row) => row.evidenceCutoffUtc),
      ['2026-09-28T15:00:00.000Z', '2026-09-28T15:00:00.000Z'],
    )
    assert.notEqual(outcome.results[0].issuedAtUtc, outcome.results[1].issuedAtUtc)
    const incident = outcome.results.find((row) => row.result.subject.kind === 'news_incident')
    assert.equal(incident.result.status, 'observed')
    assert.equal(incident.result.targetAtUtc, '2026-09-28T11:00:00.000Z')
    assert.equal(incident.result.quoteOutcome.nominalOutputDeltaUsd, 0)
    assert.equal(verifyControls(paths).count, 3)
  }))

test('quiet coverage needs full uncapped poll grid and imported item identities', () => {
  const start = '2026-09-27T10:06:00Z'
  const end = '2026-09-27T14:06:00Z'
  const polls = [
    poll(1, '2026-09-27T10:00:00Z'),
    poll(2, '2026-09-27T11:00:00Z'),
    poll(3, '2026-09-27T12:00:00Z'),
    poll(4, '2026-09-27T13:00:00Z'),
    poll(5, '2026-09-27T14:30:00Z'),
  ]
  assert.equal(feedCoverage(polls, [], start, end, SOURCE).status, 'feed_quiet')
  assert.equal(
    feedCoverage(
      [{ ...polls[0], receiptVersion: undefined }, ...polls.slice(1)],
      [],
      start,
      end,
      SOURCE,
    ).reason,
    'failed_capped_or_changed_poll',
  )
  assert.equal(
    feedCoverage(
      [{ ...polls[0], endedAtUtc: '2026-09-27T07:00:00Z' }, ...polls.slice(1)],
      [],
      start,
      end,
      SOURCE,
    ).reason,
    'stale_start_poll',
  )
  assert.equal(
    feedCoverage(
      polls.map((row) => (row.sequence === 3 ? { ...row, status: 'fetch_error' } : row)),
      [],
      start,
      end,
      SOURCE,
    ).reason,
    'failed_capped_or_changed_poll',
  )
  assert.equal(
    feedCoverage(
      polls.map((row) => (row.sequence === 3 ? { ...row, coverageStatus: 'at_or_over_cap' } : row)),
      [],
      start,
      end,
      SOURCE,
    ).reason,
    'failed_capped_or_changed_poll',
  )
  const item = { url: 'https://example.org/item', title: 'scrvUSD news', publishedAt: null }
  const identity = parsedItemIdentityV2(item)
  const withItem = polls.map((row) =>
    row.sequence === 3
      ? { ...row, feedItemCount: 1, parsedItemCount: 1, parsedItemIdentitySha256s: [identity] }
      : row,
  )
  assert.equal(feedCoverage(withItem, [], start, end, SOURCE).reason, 'unjoined_feed_item')
  const receipt = { observation: { venue: 'scrvUSD', ...item, fetchedAt: '2026-09-27T12:00:00Z' } }
  assert.equal(
    feedCoverage(withItem, [receipt], start, end, SOURCE).status,
    'observed_feed_incident',
  )
  const boundaryPolls = polls.map((row) =>
    row.sequence === 5
      ? { ...row, feedItemCount: 1, parsedItemCount: 1, parsedItemIdentitySha256s: [identity] }
      : row,
  )
  const boundaryReceipt = {
    observation: { venue: 'scrvUSD', ...item, fetchedAt: '2026-09-27T14:20:00Z' },
  }
  assert.equal(
    feedCoverage(boundaryPolls, [boundaryReceipt], start, end, SOURCE).reason,
    'boundary_poll_item_timing',
  )
})

test('quiet coverage joins each receipt with its versioned identity across a v2/v3 chain', () => {
  const start = '2026-09-27T10:06:00Z'
  const end = '2026-09-27T14:06:00Z'
  const v2Item = {
    url: 'https://example.org/v2-item',
    title: 'scrvUSD legacy item',
    source: 'Legacy Wire',
    publishedAt: null,
  }
  const v3Item = {
    url: 'https://example.org/v3-item',
    title: 'scrvUSD source-bound item',
    source: 'Bound Wire',
    publishedAt: '2026-09-27T11:55:00.000Z',
  }
  const polls = [
    poll(1, '2026-09-27T10:00:00Z'),
    poll(2, '2026-09-27T11:00:00Z', {
      feedItemCount: 1,
      parsedItemCount: 1,
      parsedItemIdentitySha256s: [parsedItemIdentityV2(v2Item)],
    }),
    poll(3, '2026-09-27T12:00:00Z', {
      receiptVersion: 3,
      feedItemCount: 1,
      parsedItemCount: 1,
      parsedItemIdentitySha256s: [parsedItemIdentity(v3Item)],
    }),
    poll(4, '2026-09-27T13:00:00Z', { receiptVersion: 3 }),
    poll(5, '2026-09-27T14:30:00Z', { receiptVersion: 3 }),
  ]
  const news = [
    { observation: { venue: 'scrvUSD', ...v2Item, fetchedAt: '2026-09-27T11:00:00Z' } },
    { observation: { venue: 'scrvUSD', ...v3Item, fetchedAt: '2026-09-27T12:00:00Z' } },
  ]

  assert.equal(feedCoverage(polls, news, start, end, SOURCE).status, 'observed_feed_incident')
  const sourceChanged = news.map((receipt, index) =>
    index === 1 ? { observation: { ...receipt.observation, source: 'Different Wire' } } : receipt,
  )
  assert.equal(feedCoverage(polls, sourceChanged, start, end, SOURCE).reason, 'unjoined_feed_item')
})

test('fixed seven-day pre-anchor washout distinguishes clean, recent-incident, and missing coverage', () => {
  const start = '2026-09-20T10:06:00Z'
  const anchor = '2026-09-27T10:06:00Z'
  const polls = Array.from({ length: 170 }, (_, index) =>
    poll(index + 1, new Date(Date.parse('2026-09-20T10:00:00Z') + index * 3_600_000).toISOString()),
  )
  const clean = feedCoverage(polls, [], start, anchor, SOURCE)
  assert.equal(clean.status, 'feed_quiet')
  const missing = feedCoverage(polls.slice(2), [], start, anchor, SOURCE)
  assert.equal(missing.status, 'unknown')
  assert.equal(missing.reason, 'missing_start_poll')
  const item = { url: 'https://example.org/recent', title: 'scrvUSD change', publishedAt: null }
  const identity = parsedItemIdentityV2(item)
  const withIncident = polls.map((row) =>
    row.endedAtUtc === '2026-09-27T09:00:00.000Z'
      ? { ...row, feedItemCount: 1, parsedItemCount: 1, parsedItemIdentitySha256s: [identity] }
      : row,
  )
  const receipt = { observation: { venue: 'scrvUSD', ...item, fetchedAt: '2026-09-27T09:00:00Z' } }
  const recent = feedCoverage(withIncident, [receipt], start, anchor, SOURCE)
  assert.equal(recent.status, 'observed_feed_incident')
  const post = { status: 'feed_quiet' }
  const quote = { status: 'observed' }
  assert.equal(controlScoreStatus(clean, post, quote), 'observed')
  assert.equal(controlScoreStatus(recent, post, quote), 'censored_preanchor_feed_incident')
  assert.equal(controlScoreStatus(missing, post, quote), 'unscorable_preanchor_feed_coverage')
})

test('current saved research corpus replays without issuing or scoring', () => {
  const state = verifyControls()
  assert.ok(Number.isSafeInteger(state.count))
  assert.equal(state.count, state.issues.length)
})

test('sealed candidate cannot be changed to claim feed-quiet coverage', () =>
  fixture((paths) => {
    quote(paths.quoteOut, '2026-09-27T10:00:00Z', 100)
    arm({ ...paths, out: paths.enrollOut, now: at('2026-09-27T10:05:00Z'), stat })
    issueQuiet({ ...paths, now: at('2026-09-27T10:06:00Z'), stat })
    const path = join(paths.out, '000000000001.json')
    const issue = JSON.parse(readFileSync(path, 'utf8'))
    issue.candidate.newsCoverage = 'feed_quiet'
    const { sha256: _ignored, ...payload } = issue
    issue.sha256 = sha(JSON.stringify(payload))
    writeFileSync(path, `${JSON.stringify(issue)}\n`)
    assert.throws(() => verifyControls(paths), /as-of replay mismatch/)
  }))

test('a resealed source swap and noncanonical bytes fail independent replay checks', () =>
  fixture((paths) => {
    quote(paths.quoteOut, '2026-09-27T10:00:00Z', 100)
    arm({ ...paths, out: paths.enrollOut, now: at('2026-09-27T10:05:00Z'), stat })
    issueQuiet({ ...paths, now: at('2026-09-27T10:06:00Z'), stat })
    const path = join(paths.out, '000000000001.json')
    const original = readFileSync(path, 'utf8')
    const issue = JSON.parse(original)
    issue.candidate.expectedNewsSource.querySha256 = 'e'.repeat(64)
    const { sha256: _ignored, ...payload } = issue
    issue.sha256 = sha(JSON.stringify(payload))
    writeFileSync(path, `${JSON.stringify(issue)}\n`)
    assert.throws(() => verifyControls(paths), /as-of replay mismatch/)
    writeFileSync(path, ` ${original}`)
    assert.throws(() => verifyControls(paths), /physical bytes mismatch/)
  }))

test('a later configured query edit does not invalidate the pinned historical source snapshot', () =>
  fixture((paths) => {
    quote(paths.quoteOut, '2026-09-27T10:00:00Z', 100)
    arm({ ...paths, out: paths.enrollOut, now: at('2026-09-27T10:05:00Z'), stat })
    const issue = issueQuiet({ ...paths, now: at('2026-09-27T10:06:00Z'), stat })
    const config = JSON.parse(readFileSync(paths.configPath, 'utf8'))
    config.venues.find((venue) => venue.name === 'scrvUSD').newsQuery = 'changed search query'
    writeFileSync(paths.configPath, `${JSON.stringify(config)}\n`)
    assert.equal(verifyControls(paths).count, 1)
    assert.notEqual(issue.candidate.sourceSnapshot.newsQuery, 'changed search query')
  }))

test('a changed source snapshot cannot silently redefine a prior control issue', () =>
  fixture((paths) => {
    quote(paths.quoteOut, '2026-09-27T10:00:00Z', 100)
    arm({ ...paths, out: paths.enrollOut, now: at('2026-09-27T10:05:00Z'), stat })
    const issue = issueQuiet({ ...paths, now: at('2026-09-27T10:06:00Z'), stat })
    const snapshotPath = join(paths.out, issue.candidate.sourceSnapshot.filename)
    const config = JSON.parse(readFileSync(snapshotPath, 'utf8'))
    config.venues.find((venue) => venue.name === 'scrvUSD').newsQuery = 'forged search query'
    writeFileSync(snapshotPath, `${JSON.stringify(config)}\n`)
    assert.throws(() => verifyControls(paths), /Source snapshot mismatch/)
  }))
