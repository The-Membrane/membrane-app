import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  fetchOfficialTermsPage,
  publicReviewUrl,
  publicTermsUrl,
  recordTermsObservation,
} from './watch-venue-terms.mjs'

const observation = {
  venue: 'sUSDS',
  url: 'https://official.example/terms',
  hash: `v2:${'a'.repeat(64)}`,
  len: 214,
}

function fakeSql(result) {
  const calls = []
  const sql = (parts, ...values) => ({ text: parts.join('?'), values })
  sql.transaction = async (queries, options) => {
    calls.push({ queries, options })
    return [[{ pg_advisory_xact_lock: null }], [result]]
  }
  return { sql, calls }
}

test('latest-hash comparison and both conditional inserts share a serialized transaction', async () => {
  const row = {
    status: 'changed',
    prev_hash: `v2:${'b'.repeat(64)}`,
    prev_len: 197,
    terms_rows: 1,
    event_rows: 1,
  }
  const { sql, calls } = fakeSql(row)
  assert.deepEqual(await recordTermsObservation(sql, observation), row)
  assert.equal(calls.length, 1)
  const [{ queries, options }] = calls
  assert.equal(options.isolationLevel, 'ReadCommitted')
  assert.equal(queries.length, 2)
  assert.match(queries[0].text, /pg_advisory_xact_lock\(hashtextextended/)
  assert.match(queries[0].text, /jsonb_build_array\(\?::text, \?::text\)/)
  assert.deepEqual(queries[0].values, [observation.venue, observation.url])
  assert.match(queries[1].text, /SELECT content_hash, content_len, fetched_at FROM venue_terms/)
  assert.match(queries[1].text, /ORDER BY fetched_at DESC, id DESC LIMIT 1/)
  assert.match(queries[1].text, /WHEN p\.content_hash IS NULL THEN 'baseline'/)
  assert.match(queries[1].text, /THEN 'rebaseline'/)
  assert.match(queries[1].text, /THEN 'unchanged'/)
  assert.match(queries[1].text, /ELSE 'changed'/)
  assert.match(
    queries[1].text,
    /greatest\(clock_timestamp\(\),\s*coalesce\(d\.prev_fetched_at \+ interval '1 microsecond'/,
  )
  assert.match(
    queries[1].text,
    /INSERT INTO venue_terms \(venue, url, content_hash, content_len, fetched_at\)/,
  )
  assert.match(queries[1].text, /FROM observation WHERE status <> 'unchanged'/)
  assert.match(
    queries[1].text,
    /INSERT INTO venue_events \(venue, kind, prev, next, note, observed_at, created_at\)/,
  )
  assert.match(
    queries[1].text,
    /FROM observation d JOIN inserted_terms t ON true WHERE d\.status = 'changed'/,
  )
  assert.match(
    queries[1].text,
    /jsonb_build_object\('content_hash', d\.prev_hash, 'content_len', d\.prev_len\)/,
  )
  assert.match(
    queries[1].text,
    /jsonb_build_object\('content_hash', \?::text, 'content_len', \?::integer,\s*'source_url', \?::text, 'final_url', \?::text\)/,
  )
  assert.match(queries[1].text, /'terms_page_changed'/)
  assert.ok(queries[1].values.includes(observation.url))
  assert.ok(queries[1].values.includes(observation.hash))
  assert.ok(queries[1].values.includes(observation.len))
})

test('database failures propagate without independent fallback writes', async () => {
  const sql = (parts, ...values) => ({ text: parts.join('?'), values })
  let calls = 0
  sql.transaction = async () => {
    calls++
    throw new Error('event_insert_failed')
  }
  await assert.rejects(recordTermsObservation(sql, observation), /event_insert_failed/)
  assert.equal(calls, 1)
})

test('watcher output excludes credentials and raw failure details', () => {
  assert.equal(
    publicTermsUrl('https://name:secret@official.example/terms?token=secret#part'),
    'https://official.example/terms',
  )
  assert.equal(publicReviewUrl('https://official.example/terms'), 'https://official.example/terms')
  assert.equal(publicReviewUrl('https://official.example/terms?version=2'), null)
  assert.equal(publicReviewUrl('https://name:secret@official.example/terms'), null)
  assert.equal(publicReviewUrl('https://official.example/terms#section'), null)
  assert.equal(publicTermsUrl('not-a-url'), null)
  assert.equal(publicTermsUrl('javascript:alert(1)'), null)
  for (const privateUrl of [
    'http://localhost/terms',
    'http://localhost./terms',
    'http://foo.local/terms',
    'http://foo.internal/terms',
    'http://foo.localdomain/terms',
    'http://foo.lan/terms',
    'http://127.0.0.1/terms',
    'http://10.0.0.1/terms',
    'http://172.16.0.1/terms',
    'http://192.168.1.1/terms',
    'http://169.254.1.1/terms',
    'http://[::1]/terms',
  ]) {
    assert.equal(publicTermsUrl(privateUrl), null, privateUrl)
  }
  const source = readFileSync(
    fileURLToPath(new URL('./watch-venue-terms.mjs', import.meta.url)),
    'utf8',
  )
  assert.match(source, /publicTermsUrl\(url\) \?\? '\[invalid terms URL\]'/)
  assert.doesNotMatch(source, /console\.(?:error|log)\(error\)/)
  assert.doesNotMatch(source, /\$\{e\.message\}/)
  assert.match(source, /main\(\)\.catch\(\(error\) => \{/)
})

test('public event evidence excludes configured and redirect URL secrets', async () => {
  const secretObservation = {
    ...observation,
    url: 'https://name:entry-pass@official.example/terms?entry_token=entry-secret#entry',
    finalUrl: 'https://redirect:final-pass@final.example/page?final_token=final-secret#done',
  }
  const { sql, calls } = fakeSql({ status: 'changed', terms_rows: 1, event_rows: 1 })
  await recordTermsObservation(sql, secretObservation)
  const [lock, persistence] = calls[0].queries
  assert.deepEqual(lock.values, [secretObservation.venue, secretObservation.url])
  const eventStart = persistence.text.indexOf('INSERT INTO venue_events')
  assert.ok(eventStart > 0)
  const privatePlaceholderCount = (persistence.text.slice(0, eventStart).match(/\?/g) ?? []).length
  const publicEventValues = persistence.values.slice(privatePlaceholderCount)
  const publicEventJson = JSON.stringify(publicEventValues)
  assert.equal(publicEventValues.filter((value) => value === null).length, 2)
  assert.doesNotMatch(publicEventJson, /official\.example\/terms|final\.example\/page/)
  assert.doesNotMatch(
    publicEventJson,
    /entry-pass|entry-secret|final-pass|final-secret|entry_token|final_token/,
  )
  assert.doesNotMatch(publicEventJson, /name:|redirect:/)
})

test('clean configured and final URLs remain exact public review links', async () => {
  const { sql, calls } = fakeSql({ status: 'changed', terms_rows: 1, event_rows: 1 })
  await recordTermsObservation(sql, {
    ...observation,
    finalUrl: 'https://final.example/terms',
  })
  const persistence = calls[0].queries[1]
  const eventStart = persistence.text.indexOf('INSERT INTO venue_events')
  const privatePlaceholderCount = (persistence.text.slice(0, eventStart).match(/\?/g) ?? []).length
  const publicEventValues = persistence.values.slice(privatePlaceholderCount)
  assert.ok(publicEventValues.includes('https://official.example/terms'))
  assert.ok(publicEventValues.includes('https://final.example/terms'))
})

test('private redirect does not enter public event evidence', async () => {
  const { sql, calls } = fakeSql({ status: 'changed', terms_rows: 1, event_rows: 1 })
  await recordTermsObservation(sql, { ...observation, finalUrl: 'http://192.168.1.8/private' })
  const persistence = calls[0].queries[1]
  const eventStart = persistence.text.indexOf('INSERT INTO venue_events')
  const privatePlaceholderCount = (persistence.text.slice(0, eventStart).match(/\?/g) ?? []).length
  const publicEventValues = persistence.values.slice(privatePlaceholderCount)
  assert.ok(publicEventValues.includes(null))
  assert.doesNotMatch(JSON.stringify(publicEventValues), /192\.168\.1\.8/)
})

test('private initial URL is rejected before fetch', async () => {
  const fetched = []
  const fetchImpl = async (url) => {
    fetched.push(url)
    throw new Error('should not fetch')
  }
  await assert.rejects(
    fetchOfficialTermsPage('http://127.0.0.1/admin', { fetchImpl }),
    /terms_source_url_rejected/,
  )
  assert.deepEqual(fetched, [])
})

test('private redirect target is rejected before second fetch', async () => {
  const fetched = []
  const fetchImpl = async (url, options) => {
    fetched.push(url)
    assert.equal(options.redirect, 'manual')
    return {
      status: 302,
      headers: { get: () => 'http://192.168.1.3/admin?secret=1' },
    }
  }
  await assert.rejects(
    fetchOfficialTermsPage('https://official.example/terms', { fetchImpl }),
    /terms_redirect_url_rejected/,
  )
  assert.deepEqual(fetched, ['https://official.example/terms'])
})

test('bounded public redirects preserve final-page attribution', async () => {
  const fetched = []
  const fetchImpl = async (url, options) => {
    fetched.push(url)
    assert.equal(options.redirect, 'manual')
    if (fetched.length === 1) {
      return { status: 302, headers: { get: () => 'https://final.example/page?ref=private' } }
    }
    return {
      status: 200,
      ok: true,
      url,
      text: async () => '<html><body>Withdrawals settle after 7 days.</body></html>',
    }
  }
  const result = await fetchOfficialTermsPage('https://official.example/terms', { fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.finalUrl, 'https://final.example/page?ref=private')
  assert.equal(result.text, 'withdrawals settle after 7 days.')
  assert.deepEqual(fetched, [
    'https://official.example/terms',
    'https://final.example/page?ref=private',
  ])
})

test('redirect limit prevents an unbounded fetch chain', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { status: 302, headers: { get: () => '/again' } }
  }
  await assert.rejects(
    fetchOfficialTermsPage('https://official.example/terms', { fetchImpl, maxRedirects: 2 }),
    /terms_redirect_limit/,
  )
  assert.equal(calls, 3)
})
