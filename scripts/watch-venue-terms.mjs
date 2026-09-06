// watch-venue-terms.mjs — the TERMS-PAGE HASH WATCHER (owner-approved, rank-3
// roadmap ADD from the dossiers). For each enabled venue that configures a
// `termsUrl`, it fetches the EXACT official redemption/terms page the dossiers
// verified, normalizes it to visible text, hashes it (sha256), and records the
// hash in venue_terms — INSERT-ONLY, a new row ONLY when the hash differs from
// that (venue, url)'s latest stored hash.
//
//   node scripts/watch-venue-terms.mjs        (from the membrane-app root)
//
// On a real CHANGE (a prior hash existed for this venue+url and the new hash
// differs) it ALSO inserts a venue_events row of kind 'terms_page_changed'
// (prev/next = the old/new {hash,len}); the alarm gate_change rule treats that
// kind as alarm-grade. The FIRST observation of a venue+url is a BASELINE — it is
// stored but emits NO event (there is no prior hash to compare against).
//
// HONESTY / false positives: text-normalization (strip scripts/styles/tags,
// collapse whitespace, lowercase) reduces but CANNOT ELIMINATE dynamic-content
// churn (rotating banners, embedded live figures, CSRF tokens) — such a page can
// hash-flap and emit a spurious terms_page_changed. That is deliberately left
// non-silent rather than papered over: the alarm's dedupe-while-open (one open
// row per venue+kind) absorbs repeats, and a human reads the diff. Per-venue
// failures are non-fatal: a fetch/timeout on one venue never aborts the others,
// mirroring the recorder tick's swallow-and-continue discipline.
//
// Env: DATABASE_URL(_UNPOOLED) from .env.local (hand-parsed; no Next injection).

import { neon } from '@neondatabase/serverless'
import { createHash } from 'node:crypto'
import { readEnv, loadConfig } from './lib/venue-reads.mjs'

const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}
const sql = neon(dbUrl)

// Normalize HTML to visible text before hashing: drop <script>/<style>/<head>
// blocks and HTML comments outright (their contents are never visible), strip all
// remaining tags, collapse every whitespace run to a single space, trim, and
// lowercase. We hash ONLY this visible text so cosmetic markup churn (attribute
// reordering, class renames) does not flap the hash. It cannot defeat genuinely
// dynamic visible content — see the false-positive note above.
export function normalizeVisibleText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

let baselines = 0
let changes = 0
let unchanged = 0
let failed = 0

for (const venue of loadConfig().filter((v) => v.enabled && v.termsUrl)) {
  const v = venue.name
  const url = venue.termsUrl
  console.log(`\n[${v}] ${url}`)

  // Fetch is non-fatal per venue (swallow-and-continue).
  let text
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20_000)
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'membrane-venue-recorder/terms-watch (+https://membrane)' },
    }).finally(() => clearTimeout(timer))
    if (!res.ok) {
      console.log(`  fetch failed: HTTP ${res.status} — skipped (non-fatal)`)
      failed++
      continue
    }
    text = normalizeVisibleText(await res.text())
  } catch (e) {
    console.log(`  fetch error: ${e.message} — skipped (non-fatal)`)
    failed++
    continue
  }

  const hash = sha256(text)
  const len = text.length

  // Latest stored hash for this venue+url (the change-detection baseline).
  const [prev] = await sql`
    SELECT content_hash, content_len FROM venue_terms
    WHERE venue = ${v} AND url = ${url}
    ORDER BY fetched_at DESC LIMIT 1`

  if (!prev) {
    // BASELINE: first observation — store it, emit NO event.
    await sql`
      INSERT INTO venue_terms (venue, url, content_hash, content_len)
      VALUES (${v}, ${url}, ${hash}, ${len})`
    console.log(`  baseline seeded (no prior hash) — hash=${hash.slice(0, 12)}… len=${len} (NO event)`)
    baselines++
    continue
  }

  if (prev.content_hash === hash) {
    console.log(`  unchanged — hash=${hash.slice(0, 12)}… len=${len} (no new row)`)
    unchanged++
    continue
  }

  // CHANGE: insert a new hash row AND a terms_page_changed event.
  await sql`
    INSERT INTO venue_terms (venue, url, content_hash, content_len)
    VALUES (${v}, ${url}, ${hash}, ${len})`
  await sql`
    INSERT INTO venue_events (venue, kind, prev, next, note)
    VALUES (${v}, 'terms_page_changed',
            ${JSON.stringify({ content_hash: prev.content_hash, content_len: prev.content_len })}::jsonb,
            ${JSON.stringify({ content_hash: hash, content_len: len })}::jsonb,
            ${`terms page changed: ${prev.content_hash.slice(0, 12)}…(${prev.content_len}) -> ${hash.slice(0, 12)}…(${len}) @ ${url}`})`
  console.log(`  CHANGED — ${prev.content_hash.slice(0, 12)}…(${prev.content_len}) -> ${hash.slice(0, 12)}…(${len}); event terms_page_changed inserted`)
  changes++
}

console.log(`\nterms watch complete — baselines: ${baselines}, changes: ${changes}, unchanged: ${unchanged}, failed: ${failed}`)
