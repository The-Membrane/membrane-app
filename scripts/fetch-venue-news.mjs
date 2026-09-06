// fetch-venue-news.mjs — the VENUE NEWS fetcher (owner-approved). One pass over
// every venue in tools/venue-recorder.config.json that has a `newsQuery`:
//
//   1. Fetch that venue's Google News RSS SEARCH feed (keyless, cacheable):
//        https://news.google.com/rss/search?q=<newsQuery>&hl=en-US&gl=US&ceid=US:en
//   2. Parse it with the shared, dependency-free parser (scripts/lib/newsParse),
//      capping to the newest 25 items per venue per run.
//   3. Upsert INSERT ... ON CONFLICT (venue, url) DO NOTHING — insert-only,
//      idempotent across runs.
//
//   node scripts/fetch-venue-news.mjs        (from the membrane-app root)
//
// CONSTRAINT REALITY (owner directive): X/Twitter search has NO keyless API, so
// X is DEFERRED to a later paid/API decision — this fetcher is NEWS-only for v1.
// And this feed is INFORMATION, not endorsement: headlines are stored VERBATIM
// (title/source/url/date), with NO summarization, NO sentiment, NO LLM.
//
// Non-fatal per venue: a failed fetch/parse for one venue logs and moves on so a
// single outlet outage never aborts the pass (Badass store-raw discipline).
// Env: DATABASE_URL(_UNPOOLED) from .env.local (tsx/node get no Next injection).

import { neon } from '@neondatabase/serverless'

import { readEnv, loadConfig } from './lib/venue-reads.mjs'
import { toNewsRows } from './lib/newsParse.mjs'

const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const sql = neon(dbUrl)

const MAX_PER_RUN = 25
const rssUrl = (query) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`

const venues = loadConfig().filter((v) => v.newsQuery)
if (venues.length === 0) {
  console.log('No venues have a newsQuery — nothing to fetch.')
  process.exit(0)
}

let grandTotal = 0
for (const venue of venues) {
  console.log(`\n[${venue.name}] q="${venue.newsQuery}"`)
  try {
    const res = await fetch(rssUrl(venue.newsQuery), {
      // Google News serves RSS to a plain UA; identify ourselves honestly.
      headers: { 'user-agent': 'membrane-venue-news/1.0 (+https://membrane)' },
    })
    if (!res.ok) {
      console.log(`  skip — RSS fetch ${res.status} ${res.statusText}`)
      continue
    }
    const xml = await res.text()
    const rows = toNewsRows(xml, { max: MAX_PER_RUN })
    console.log(`  parsed ${rows.length} item(s)`)

    let inserted = 0
    for (const r of rows) {
      const out = await sql`
        INSERT INTO venue_news (venue, title, source, url, published_at)
        VALUES (${venue.name}, ${r.title}, ${r.source}, ${r.url}, ${r.publishedAt})
        ON CONFLICT (venue, url) DO NOTHING
        RETURNING id`
      if (out.length > 0) inserted++
    }
    grandTotal += inserted
    console.log(`  inserted ${inserted} new (${rows.length - inserted} already stored)`)
  } catch (err) {
    // Non-fatal: log and continue to the next venue.
    console.log(`  error (non-fatal) — ${err?.message ?? err}`)
  }
}

console.log(`\nvenue news pass complete — ${grandTotal} new headline(s) across ${venues.length} venue(s)`)
