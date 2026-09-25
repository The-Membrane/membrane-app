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
// HONESTY / false positives: the page is reduced to visible text and the venue's
// LIVE MARKET FIGURES are masked before hashing (APY/APR rates, k/m/b amounts, the
// copyright year — scripts/lib/termsNormalize.mjs documents exactly what counts as
// a terms change). Fees, durations, caps and wording still count. Hashes are
// versioned; a hash from an older normalizer is RE-BASELINED (new row, no event)
// so upgrading the normalizer never fires a spurious alarm. Per-venue failures are
// non-fatal: a fetch/timeout on one venue never aborts the others, mirroring the
// recorder tick's swallow-and-continue discipline.
//
// Env: DATABASE_URL(_UNPOOLED) from .env.local (hand-parsed; no Next injection).

import { neon } from '@neondatabase/serverless'
import { termsText, termsHash, termsDecision, normalizeVisibleText } from './lib/termsNormalize.mjs'
import { readEnv, loadConfig } from './lib/venue-reads.mjs'

const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}
const sql = neon(dbUrl)

// Re-exported for existing importers; the implementation lives in lib/termsNormalize.mjs.
export { normalizeVisibleText }

let baselines = 0
let rebaselines = 0
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
    text = termsText(await res.text())
  } catch (e) {
    console.log(`  fetch error: ${e.message} — skipped (non-fatal)`)
    failed++
    continue
  }

  const hash = termsHash(text)
  const len = text.length

  // Latest stored hash for this venue+url (the change-detection baseline).
  const [prev] = await sql`
    SELECT content_hash, content_len FROM venue_terms
    WHERE venue = ${v} AND url = ${url}
    ORDER BY fetched_at DESC LIMIT 1`

  const decision = termsDecision(prev?.content_hash ?? null, hash)

  if (decision === 'baseline' || decision === 'rebaseline') {
    // BASELINE: first observation. REBASELINE: the stored hash came from an older
    // normalizer, so a difference says nothing about the page. Store, NO event.
    await sql`
      INSERT INTO venue_terms (venue, url, content_hash, content_len)
      VALUES (${v}, ${url}, ${hash}, ${len})`
    if (decision === 'baseline') {
      console.log(`  baseline seeded (no prior hash) — hash=${hash.slice(0, 15)}… len=${len} (NO event)`)
      baselines++
    } else {
      console.log(`  re-baselined (normalizer upgraded from ${String(prev.content_hash).slice(0, 12)}…) — hash=${hash.slice(0, 15)}… len=${len} (NO event)`)
      rebaselines++
    }
    continue
  }

  if (decision === 'unchanged') {
    console.log(`  unchanged — hash=${hash.slice(0, 15)}… len=${len} (no new row)`)
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

console.log(`\nterms watch complete — baselines: ${baselines}, re-baselines: ${rebaselines}, changes: ${changes}, unchanged: ${unchanged}, failed: ${failed}`)
