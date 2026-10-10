import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendRows, classify, normalizeRow, verify } from './venue-news-event-ledger.mjs'

const stat = () => ({ bavail: 10_000_000, bsize: 4096 })
const row = (overrides = {}) => ({
  venue: 'scrvUSD',
  title: 'Vault exit queue grows',
  source: 'Example outlet',
  url: 'https://news.google.com/articles/a?utm_source=rss',
  published_at: '2026-09-25T10:00:00Z',
  fetched_at: '2026-09-27T10:00:00Z',
  ...overrides,
})
const withOut = async (fn) => {
  const out = mkdtempSync(join(tmpdir(), 'venue-news-ledger-'))
  try {
    await fn(out)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

test('headline availability uses first fetch, never historical publication date or title language', () => {
  const result = classify(row({ title: 'Official: vault withdrawal starts tomorrow' }))
  assert.equal(result.kind, 'headline')
  assert.equal(result.availableAt, '2026-09-27T10:00:00.000Z')
  assert.equal(normalizeRow(row()).publishedAt, '2026-09-25T10:00:00.000Z')
})

test('explicit primary evidence has its own first-seen time and requires temporal consistency', () => {
  const scheduled = classify(row(), {
    kind: 'scheduled',
    sourceUrl: 'https://example.org/governance/proposal',
    firstSeenAt: '2026-09-27T12:00:00Z',
    eventAt: '2026-09-28T10:00:00Z',
  })
  assert.equal(scheduled.availableAt, '2026-09-27T12:00:00.000Z')
  assert.equal(scheduled.evidence.authorityStatus, 'supplied_unverified')
  assert.throws(
    () =>
      classify(row(), {
        kind: 'scheduled',
        sourceUrl: 'https://example.org',
        firstSeenAt: '2026-09-28T00:00:00Z',
        eventAt: '2026-09-27T00:00:00Z',
      }),
    /must follow/,
  )
  assert.throws(
    () =>
      classify(row(), {
        kind: 'official_observed',
        sourceUrl: 'https://example.org',
        firstSeenAt: '2026-09-27T00:00:00Z',
        eventAt: '2026-09-28T00:00:00Z',
      }),
    /cannot follow/,
  )
  assert.throws(
    () =>
      classify(row(), {
        kind: 'scheduled',
        sourceUrl: 'http://example.org',
        firstSeenAt: '2026-09-27T00:00:00Z',
        eventAt: '2026-09-28T00:00:00Z',
      }),
    /HTTPS/,
  )
})

test('missing publication is explicit; invalid fetched and publication dates are rejected', () => {
  assert.equal(normalizeRow(row({ published_at: null })).publishedAt, null)
  assert.throws(() => normalizeRow(row({ fetched_at: 'nonsense' })), /Invalid fetched_at/)
  assert.throws(() => normalizeRow(row({ published_at: 'nonsense' })), /Invalid published_at/)
  assert.throws(
    () => normalizeRow(row({ published_at: '2026-02-30T00:00:00Z' })),
    /Invalid published_at/,
  )
  assert.equal(
    normalizeRow(row({ published_at: '2026-09-28T10:00:00Z' })).publicationTiming,
    'published_after_first_seen',
  )
})

test('same canonical URL is idempotent; similar titles remain separate raw observations in one possible syndication group', async () =>
  withOut(async (out) => {
    const first = row()
    const syndicated = row({
      title: 'Vault exit queue grows!',
      source: 'Second outlet',
      url: 'https://second.example/story?fbclid=tracking',
      fetched_at: '2026-09-27T11:00:00Z',
    })
    assert.deepEqual(appendRows([syndicated, first], { out, stat }), {
      appended: 2,
      existing: 0,
      count: 2,
    })
    assert.deepEqual(appendRows([first, syndicated], { out, stat }), {
      appended: 0,
      existing: 2,
      count: 2,
    })
    const receipts = verify(out).receipts
    assert.equal(receipts[0].group.relation, 'new')
    assert.equal(receipts[1].group.relation, 'possible_syndication')
    assert.equal(receipts[0].group.eventId, receipts[1].group.eventId)
    assert.equal(receipts[1].observation.source, 'Second outlet')
    assert.equal(receipts[0].observation.canonicalUrl, 'https://news.google.com/articles/a')
  }))

test('tracking-parameter variants keep distinct raw DB observations and share a possible event group', async () =>
  withOut(async (out) => {
    const first = row()
    const second = row({
      title: 'Exit queue worsens',
      url: 'https://news.google.com/articles/a?utm_source=other',
      fetched_at: '2026-09-27T11:00:00Z',
    })
    assert.equal(normalizeRow(first).canonicalUrl, normalizeRow(second).canonicalUrl)
    assert.notEqual(normalizeRow(first).observationKey, normalizeRow(second).observationKey)
    assert.deepEqual(appendRows([first, second], { out, stat }), {
      appended: 2,
      existing: 0,
      count: 2,
    })
    const receipts = verify(out).receipts
    assert.equal(receipts[0].receiptVersion, 2)
    assert.equal(receipts[1].receiptVersion, 2)
    assert.equal(receipts[0].group.eventId, receipts[1].group.eventId)
    assert.notEqual(receipts[0].observation.title, receipts[1].observation.title)
    assert.equal(appendRows([first, second], { out, stat }).existing, 2)
  }))

test('existing v1 receipts verify unchanged and accept a colliding raw URL as v2 continuation', async () =>
  withOut(async (out) => {
    const first = row()
    const observation = normalizeRow(first, 1)
    const legacy = {
      study: 'venue-news-event-ledger-v1',
      sequence: 1,
      previousSha256: null,
      raw: first,
      suppliedEvidence: null,
      observation,
      classification: classify(first),
      group: {
        eventId: createHash('sha256')
          .update(
            JSON.stringify([observation.venue, observation.observationKey, observation.fetchedAt]),
          )
          .digest('hex'),
        relation: 'new',
      },
    }
    const sealed = {
      ...legacy,
      sha256: createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    }
    writeFileSync(join(out, '000000000001.json'), `${JSON.stringify(sealed)}\n`)
    assert.equal(verify(out).count, 1)
    const next = row({
      title: 'Different headline on same canonical URL',
      url: 'https://news.google.com/articles/a?utm_source=different',
      fetched_at: '2026-09-27T11:00:00Z',
    })
    assert.deepEqual(appendRows([first, next], { out, stat }), {
      appended: 1,
      existing: 1,
      count: 2,
    })
    const receipts = verify(out).receipts
    assert.equal(receipts[0].receiptVersion, undefined)
    assert.equal(receipts[1].receiptVersion, 2)
    assert.equal(receipts[0].group.eventId, receipts[1].group.eventId)
  }))

test('older backfill cannot be silently appended after later first-seen observations', async () =>
  withOut(async (out) => {
    appendRows([row()], { out, stat })
    assert.throws(
      () =>
        appendRows(
          [row({ url: 'https://example.org/older', fetched_at: '2026-09-26T10:00:00Z' })],
          { out, stat },
        ),
      /predates append frontier/,
    )
  }))

test('an existing headline cannot be silently relabeled with newly supplied evidence', async () =>
  withOut(async (out) => {
    appendRows([row()], { out, stat })
    assert.throws(
      () =>
        appendRows(
          [
            row({
              evidence: {
                kind: 'scheduled',
                sourceUrl: 'https://example.org/notice',
                firstSeenAt: '2026-09-27T12:00:00Z',
                eventAt: '2026-09-28T12:00:00Z',
              },
            }),
          ],
          { out, stat },
        ),
      /Conflicting evidence/,
    )
  }))

test('sealed append receipts detect tampering and missing sequence', async () =>
  withOut(async (out) => {
    appendRows([row(), row({ url: 'https://example.org/b', fetched_at: '2026-09-27T11:00:00Z' })], {
      out,
      stat,
    })
    const files = readdirSync(out).sort()
    const first = JSON.parse(readFileSync(join(out, files[0]), 'utf8'))
    first.raw.title = 'tampered'
    writeFileSync(join(out, files[0]), `${JSON.stringify(first)}\n`)
    assert.throws(() => verify(out), /SHA mismatch/)
    rmSync(join(out, files[0]))
    assert.throws(() => verify(out), /sequence gap/)
  }))
