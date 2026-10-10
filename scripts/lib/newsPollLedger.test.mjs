import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { pollVenue, rssUrl } from '../fetch-venue-news.mjs'
import {
  appendPoll,
  CURRENT_RECEIPT_VERSION,
  parsedItemIdentity,
  parsedItemIdentityV2,
  sourceIdentity,
  verifyPollReceipt,
  verifyPolls,
} from './newsPollLedger.mjs'

const venue = { name: 'scrvUSD', newsQuery: 'Curve scrvUSD' }
const sha = (text) => createHash('sha256').update(text).digest('hex')
const feed = (items = '') =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`
const item = (number) =>
  `<item><title>Headline ${number}</title><link>https://example.com/${number}</link><source>Publisher</source><pubDate>Sun, 27 Sep 2026 00:00:00 GMT</pubDate></item>`
const fakeResponse = (xml, status = 200) => ({ ok: status === 200, status, text: async () => xml })

function withOut(fn) {
  const out = mkdtempSync(join(tmpdir(), 'news-polls-'))
  return Promise.resolve()
    .then(() => fn(out))
    .finally(() => rmSync(out, { recursive: true, force: true }))
}

function options(
  out,
  response,
  insertRow = async () => true,
  times = ['2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z'],
) {
  const queue = [...times]
  return {
    fetchImpl: async () => response,
    insertRow,
    saveLocal: () => {},
    now: () => queue.shift(),
    append: (input) => appendPoll(input, { out }),
  }
}

test('successfully sealed empty RSS poll is explicit, source-pinned and has no parsed identities', () =>
  withOut(async (out) => {
    const receipt = await pollVenue(venue, options(out, fakeResponse(feed())))
    assert.equal(receipt.status, 'success')
    assert.equal(receipt.receiptVersion, CURRENT_RECEIPT_VERSION)
    assert.equal(receipt.feedItemCount, 0)
    assert.equal(receipt.parsedItemCount, 0)
    assert.equal(receipt.insertedCount, 0)
    assert.equal(receipt.coverageStatus, 'observed_below_cap')
    assert.deepEqual(receipt.parsedItemIdentitySha256s, [])
    assert.equal(receipt.source.querySha256, sha(venue.newsQuery))
    assert.equal(receipt.source.urlSha256, sha(rssUrl(venue.newsQuery)))
    assert.deepEqual(verifyPollReceipt(receipt), receipt)
    assert.deepEqual(verifyPollReceipt(JSON.parse(JSON.stringify(receipt))), receipt)
    assert.throws(() => verifyPollReceipt({ ...receipt, status: 'fetch_error' }), /SHA mismatch/)
    assert.equal(verifyPolls(out).count, 1)
  }))

test('parsed item hashes permit later news-ledger identity cross-check and success saves locally before DB inserts', () =>
  withOut(async (out) => {
    let inserted = false
    let saved = false
    const receipt = await pollVenue(venue, {
      ...options(out, fakeResponse(feed(item(1))), async () => {
        assert.equal(saved, true)
        inserted = true
        return true
      }),
      saveLocal: () => {
        saved = true
      },
    })
    assert.equal(inserted, true)
    assert.equal(saved, true)
    assert.equal(receipt.status, 'success')
    assert.equal(receipt.insertedCount, 1)
    assert.equal(
      receipt.parsedItemIdentitySha256s[0],
      parsedItemIdentity({
        url: 'https://example.com/1',
        title: 'Headline 1',
        source: 'Publisher',
        publishedAt: '2026-09-27T00:00:00.000Z',
      }),
    )
    assert.notEqual(
      receipt.parsedItemIdentitySha256s[0],
      parsedItemIdentity({
        url: 'https://example.com/1',
        title: 'Headline 1',
        source: 'Different publisher',
        publishedAt: '2026-09-27T00:00:00.000Z',
      }),
    )
    assert.notEqual(
      receipt.parsedItemIdentitySha256s[0],
      parsedItemIdentityV2({
        url: 'https://example.com/1',
        title: 'Headline 1',
        publishedAt: '2026-09-27T00:00:00.000Z',
      }),
    )
  }))

test('25-item cap makes coverage explicitly incomplete even when DB inserts succeed', () =>
  withOut(async (out) => {
    const xml = feed(Array.from({ length: 26 }, (_, index) => item(index)).join(''))
    const receipt = await pollVenue(venue, options(out, fakeResponse(xml)))
    assert.equal(receipt.status, 'success')
    assert.equal(receipt.feedItemCount, 26)
    assert.equal(receipt.parsedItemCount, 25)
    assert.equal(receipt.coverageStatus, 'at_or_over_cap')
  }))

test('discarded or malformed RSS items cannot certify an empty feed', () =>
  withOut(async (out) => {
    const discarded = await pollVenue(
      venue,
      options(out, fakeResponse(feed('<item><title>No link</title></item>'))),
    )
    assert.equal(discarded.status, 'success')
    assert.equal(discarded.feedItemCount, 1)
    assert.equal(discarded.parsedItemCount, 0)
    assert.equal(discarded.coverageStatus, 'incomplete_items')

    const malformed = await pollVenue(
      venue,
      options(out, fakeResponse(feed('<item><title>Broken item</title>')), async () => true, [
        '2026-09-27T00:01:00.000Z',
        '2026-09-27T00:01:01.000Z',
      ]),
    )
    assert.equal(malformed.status, 'parse_error')
    assert.equal(malformed.coverageStatus, 'unavailable')
  }))

test('a capped feed with fewer than 25 parsed rows is explicitly incomplete', () =>
  withOut(async (out) => {
    const xml = feed(
      `${Array.from({ length: 24 }, (_, index) => item(index)).join('')}<item><title>No link A</title></item><item><title>No link B</title></item>`,
    )
    const receipt = await pollVenue(venue, options(out, fakeResponse(xml)))
    assert.equal(receipt.receiptVersion, CURRENT_RECEIPT_VERSION)
    assert.equal(receipt.feedItemCount, 26)
    assert.equal(receipt.parsedItemCount, 24)
    assert.equal(receipt.coverageStatus, 'incomplete_items')
  }))

test('HTTP and invalid RSS failures are sealed as unavailable; DB failure preserves local success', () =>
  withOut(async (out) => {
    const http = await pollVenue(venue, options(out, fakeResponse('', 503)))
    assert.equal(http.status, 'http_error')
    assert.equal(http.failure.httpStatus, 503)
    assert.equal(http.parsedItemCount, null)

    const invalid = await pollVenue(
      venue,
      options(out, fakeResponse('<html>not RSS</html>'), async () => true, [
        '2026-09-27T00:01:00.000Z',
        '2026-09-27T00:01:01.000Z',
      ]),
    )
    assert.equal(invalid.status, 'parse_error')
    assert.equal(invalid.coverageStatus, 'unavailable')

    let calls = 0
    const failed = await pollVenue(
      venue,
      options(
        out,
        fakeResponse(feed(item(1) + item(2))),
        async () => {
          calls++
          if (calls === 2) throw new Error('postgres://user:secret@host')
          return true
        },
        ['2026-09-27T00:02:00.000Z', '2026-09-27T00:02:01.000Z'],
      ),
    )
    assert.equal(failed.status, 'success')
    assert.equal(failed.insertedCount, 1)
    assert.equal(failed.failure, null)
    assert.equal(failed.coverageStatus, 'observed_below_cap')
    assert.equal(verifyPolls(out).count, 3)
    assert.doesNotMatch(readFileSync(join(out, '000000000003.json'), 'utf8'), /secret/)
  }))

test('physical tamper and sequence deletion fail verification', () =>
  withOut(async (out) => {
    await pollVenue(venue, options(out, fakeResponse(feed())))
    await pollVenue(
      venue,
      options(out, fakeResponse(feed()), async () => true, [
        '2026-09-27T00:01:00.000Z',
        '2026-09-27T00:01:01.000Z',
      ]),
    )
    const names = readdirSync(out)
      .filter((name) => name.endsWith('.json'))
      .sort()
    const first = join(out, names[0])
    const original = readFileSync(first, 'utf8')
    writeFileSync(first, ` ${original}`)
    assert.throws(() => verifyPolls(out), /physical bytes mismatch/)
    writeFileSync(first, original)
    writeFileSync(first, original.replace('scrvUSD', 'bad-name'))
    assert.throws(() => verifyPolls(out), /SHA mismatch/)
    writeFileSync(first, original)
    rmSync(first)
    assert.throws(() => verifyPolls(out), /sequence gap/)
  }))

test('immutable pre-v2 receipts remain verifiable but lack parsed identity evidence', () =>
  withOut(async (out) => {
    await pollVenue(venue, options(out, fakeResponse(feed())))
    const path = join(out, '000000000001.json')
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    delete receipt.receiptVersion
    delete receipt.parsedItemIdentitySha256s
    delete receipt.sha256
    receipt.sha256 = sha(JSON.stringify(receipt))
    writeFileSync(path, `${JSON.stringify(receipt)}\n`)
    const verified = verifyPolls(out)
    assert.equal(verified.count, 1)
    assert.equal(verified.last.receiptVersion, undefined)
    assert.equal(verified.last.parsedItemIdentitySha256s, undefined)
  }))

test('same-venue overlapping poll receipts are rejected', () =>
  withOut(async (out) => {
    await pollVenue(venue, options(out, fakeResponse(feed())))
    await assert.rejects(
      () =>
        pollVenue(
          venue,
          options(out, fakeResponse(feed()), async () => true, [
            '2026-09-27T00:00:00.500Z',
            '2026-09-27T00:00:02.000Z',
          ]),
        ),
      /Overlapping venue poll receipts/,
    )
  }))

test('configured source identity changes when the query changes', () => {
  assert.notDeepEqual(
    sourceIdentity('Curve scrvUSD', rssUrl('Curve scrvUSD')),
    sourceIdentity('Curve crvUSD', rssUrl('Curve crvUSD')),
  )
})

test('no database still saves parsed rows and seals a certifiable local success', () =>
  withOut(async (out) => {
    const saved = []
    const receipt = await pollVenue(venue, {
      ...options(out, fakeResponse(feed(item(1)))),
      insertRow: undefined,
      saveLocal: (name, rows, options) => saved.push({ name, rows, options }),
    })
    assert.equal(receipt.status, 'success')
    assert.equal(receipt.coverageStatus, 'observed_below_cap')
    assert.equal(receipt.insertedCount, 0)
    assert.deepEqual(verifyPollReceipt(receipt), receipt)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].name, venue.name)
    assert.equal(saved[0].rows[0].title, 'Headline 1')
    assert.equal(saved[0].options.fetchedAt, '2026-09-27T00:00:00.000Z')
  }))

test('local save failure fails closed before any DB insert and hides disk details', () =>
  withOut(async (out) => {
    let inserted = false
    const receipt = await pollVenue(venue, {
      ...options(out, fakeResponse(feed(item(1))), async () => {
        inserted = true
        return true
      }),
      saveLocal: () => {
        throw new Error('private disk path')
      },
    })
    assert.equal(receipt.status, 'local_store_error')
    assert.equal(receipt.failure.code, 'LOCAL_STORE_FAILED')
    assert.equal(inserted, false)
    assert.equal(receipt.insertedCount, null)
    assert.equal(receipt.coverageStatus, 'unavailable')
    assert.doesNotMatch(JSON.stringify(receipt), /private/)
  }))

test('malformed feed never saves local rows; partial parsed feed cannot claim complete coverage', () =>
  withOut(async (out) => {
    const saved = []
    const malformed = await pollVenue(venue, {
      ...options(out, fakeResponse(feed('<item><title>broken</title>'))),
      saveLocal: (_name, rows) => saved.push(rows),
    })
    assert.equal(malformed.status, 'parse_error')
    assert.equal(saved.length, 0)

    const partial = await pollVenue(venue, {
      ...options(
        out,
        fakeResponse(feed(item(1) + '<item><title>No link</title></item>')),
        async () => {
          throw new Error('DB outage')
        },
        ['2026-09-27T00:01:00.000Z', '2026-09-27T00:01:01.000Z'],
      ),
      saveLocal: (_name, rows) => saved.push(rows),
    })
    assert.equal(partial.status, 'success')
    assert.equal(partial.feedItemCount, 2)
    assert.equal(partial.parsedItemCount, 1)
    assert.equal(partial.coverageStatus, 'incomplete_items')
    assert.equal(saved.length, 1)
    assert.equal(saved[0].length, 1)
  }))
