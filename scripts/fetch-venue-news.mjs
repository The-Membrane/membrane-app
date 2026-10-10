// Scheduled Google News RSS observations for configured venues. Headlines are
// stored verbatim; every attempted venue poll gets a separate sealed receipt.
// A successful empty feed is observable, but never proves venue-wide quiet.
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { readEnv } from './lib/venue-reads.mjs'
import { parseRssItems, toNewsRows } from './lib/newsParse.mjs'
import { saveLocalNews } from './lib/venueNewsLocalStore.mjs'
import {
  appendPoll,
  digestFeed,
  digestParsedItems,
  MAX_PER_RUN,
  parsedItemIdentity,
  sourceIdentity,
} from './lib/newsPollLedger.mjs'

export const rssUrl = (query) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`

function recognizableFeed(xml) {
  // The parser deliberately tolerates malformed items. A missing RSS/channel
  // envelope cannot be interpreted as a successful empty poll.
  return (
    typeof xml === 'string' &&
    /<rss\b[^>]*>/i.test(xml) &&
    /<channel\b[^>]*>/i.test(xml) &&
    /<\/channel\s*>/i.test(xml) &&
    /<\/rss\s*>/i.test(xml) &&
    (xml.match(/<item\b[^>]*>/gi)?.length ?? 0) === (xml.match(/<\/item\s*>/gi)?.length ?? 0)
  )
}

/** One independently sealed attempt. Injected dependencies keep tests offline. */
export async function pollVenue(
  venue,
  {
    fetchImpl = fetch,
    insertRow,
    saveLocal = saveLocalNews,
    now = () => new Date().toISOString(),
    append = appendPoll,
  } = {},
) {
  const startedAtUtc = now()
  const source = sourceIdentity(venue.newsQuery, rssUrl(venue.newsQuery))
  let status = 'fetch_error'
  let feedSha256 = null
  let parsedIdentitySha256 = null
  let parsedItemIdentitySha256s = null
  let feedItemCount = null
  let parsedItemCount = null
  let insertedCount = null
  let coverageStatus = 'unavailable'
  let failure = null
  let rows = null

  try {
    const res = await fetchImpl(rssUrl(venue.newsQuery), {
      headers: { 'user-agent': 'membrane-venue-news/1.0 (+https://membrane)' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      status = 'http_error'
      failure = { stage: status, code: `HTTP_${res.status}`, httpStatus: res.status }
    } else {
      status = 'parse_error'
      const xml = await res.text()
      feedSha256 = digestFeed(xml)
      if (!recognizableFeed(xml)) throw new Error('RSS_INVALID')
      feedItemCount = parseRssItems(xml).length
      rows = toNewsRows(xml, { max: MAX_PER_RUN })
      parsedItemCount = rows.length
      parsedItemIdentitySha256s = rows.map(parsedItemIdentity)
      parsedIdentitySha256 = digestParsedItems(parsedItemIdentitySha256s)
      // The local snapshot is the native recorder's durable display copy.
      // A receipt may certify this feed only after that copy is saved.
      status = 'local_store_error'
      await saveLocal(venue.name, rows, { fetchedAt: startedAtUtc })
      insertedCount = 0
      if (typeof insertRow === 'function') {
        for (const row of rows) {
          try {
            if (await insertRow(venue.name, row, { fetchedAt: startedAtUtc })) insertedCount++
          } catch {
            // Database rows replicate the locally sealed observation. A
            // mirror outage does not erase the saved feed or its identities.
            break
          }
        }
      }
      status = 'success'
      coverageStatus =
        feedItemCount >= MAX_PER_RUN
          ? parsedItemCount === MAX_PER_RUN
            ? 'at_or_over_cap'
            : 'incomplete_items'
          : feedItemCount !== parsedItemCount
            ? 'incomplete_items'
            : 'observed_below_cap'
    }
  } catch (error) {
    // The record contains controlled codes, never driver errors or DB URLs.
    const code =
      status === 'parse_error'
        ? 'RSS_INVALID'
        : status === 'local_store_error'
          ? 'LOCAL_STORE_FAILED'
          : 'FETCH_FAILED'
    failure = { stage: status, code }
  }

  const receipt = append({
    venue: venue.name,
    source,
    startedAtUtc,
    endedAtUtc: now(),
    status,
    feedSha256,
    parsedIdentitySha256,
    parsedItemIdentitySha256s,
    feedItemCount,
    parsedItemCount,
    insertedCount,
    coverageStatus,
    failure,
  })
  return receipt
}

export async function runNewsPass(venues, options = {}) {
  let inserted = 0
  let locallyCaptured = 0
  let failures = 0
  let mirrorFailures = 0
  const unique = new Map()
  for (const venue of venues.filter((v) => v.newsQuery)) {
    const prior = unique.get(venue.name)
    if (prior && prior.newsQuery !== venue.newsQuery)
      throw new Error(`Conflicting news query for ${venue.name}`)
    unique.set(venue.name, venue)
  }
  for (const venue of unique.values()) {
    try {
      let venueLocalCount = 0
      const receipt = await pollVenue(venue, {
        ...options,
        saveLocal: async (name, rows, saveOptions) => {
          const result = await (options.saveLocal ?? saveLocalNews)(name, rows, saveOptions)
          venueLocalCount = rows.length
          return result
        },
      })
      // Mirror every attempt, including fetch failures. A mirror outage does
      // not invalidate the native receipt; production will age out its last
      // mirrored receipt on the native cadence.
      if (options.saveReceipt) {
        try {
          await options.saveReceipt(receipt)
        } catch {
          mirrorFailures++
        }
      }
      if (receipt.status !== 'success') failures++
      inserted += receipt.insertedCount ?? 0
      locallyCaptured += venueLocalCount
      console.log(
        `[${venue.name}] ${receipt.status}: ${receipt.parsedItemCount ?? 'unknown'} parsed, ${receipt.insertedCount ?? 'unknown'} inserted, ${venueLocalCount} captured locally; poll receipt ${receipt.sequence}`,
      )
    } catch (error) {
      // A missing receipt is a data-quality failure, not a silent empty feed.
      failures++
      console.error(`[${venue.name}] poll receipt write failed: ${error?.message ?? 'unknown'}`)
    }
  }
  return { inserted, locallyCaptured, failures, mirrorFailures }
}

export async function upsertVenueNews(sql, venue, row, fetchedAt) {
  const out = await sql`
    INSERT INTO venue_news (venue, title, source, url, published_at, fetched_at)
    VALUES (${venue}, ${row.title}, ${row.source}, ${row.url}, ${row.publishedAt}, ${fetchedAt})
    ON CONFLICT (venue, url) DO UPDATE SET
      title = EXCLUDED.title,
      source = EXCLUDED.source,
      published_at = EXCLUDED.published_at,
      fetched_at = EXCLUDED.fetched_at
    RETURNING id`
  return out.length > 0
}

async function main({ localOnly = false } = {}) {
  const catalog = JSON.parse(
    readFileSync(new URL('../tools/carry-news-sources.config.json', import.meta.url), 'utf8'),
  )
  const venues = catalog.sources.map((source) => ({ name: source.id, newsQuery: source.query }))
  if (venues.length === 0) {
    console.log('No venues have a newsQuery — nothing to fetch.')
    return
  }
  const dbUrl = localOnly
    ? null
    : (() => {
        try {
          const { get } = readEnv()
          return get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
        } catch {
          // The native local collector does not require a database env file.
          return null
        }
      })()
  const sql = dbUrl ? neon(dbUrl) : null
  const result = await runNewsPass(venues, {
    ...(sql && {
      insertRow: (venue, row, { fetchedAt }) => upsertVenueNews(sql, venue, row, fetchedAt),
      saveReceipt: async (receipt) => {
        await sql`
        INSERT INTO venue_news_poll_receipts (source_id, sequence, receipt_text)
        VALUES (${receipt.venue}, ${receipt.sequence}, ${JSON.stringify(receipt)})
        ON CONFLICT (source_id) DO UPDATE
          SET sequence = EXCLUDED.sequence, receipt_text = EXCLUDED.receipt_text
          WHERE venue_news_poll_receipts.sequence < EXCLUDED.sequence`
      },
    }),
  })
  console.log(
    `venue news pass complete — ${result.inserted} DB insert(s), ${result.locallyCaptured} locally captured row(s) across ${venues.length} venue(s); ${result.failures} source/local failure(s), ${result.mirrorFailures} receipt mirror failure(s)`,
  )
  if (result.failures || (sql && result.mirrorFailures)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--local-only'))
    throw new Error('Usage: node scripts/fetch-venue-news.mjs [--local-only]')
  await main({ localOnly: args[0] === '--local-only' })
}
