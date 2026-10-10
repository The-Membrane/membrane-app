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
// (prev/next = the old/new {hash,len}); the alarm terms_page_notice rule reports
// this as a factual page change. The FIRST observation of a venue+url is a BASELINE — it is
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
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TERMS_HASH_VERSION,
  termsText,
  termsHash,
  normalizeVisibleText,
} from './lib/termsNormalize.mjs'
import { readEnv, loadConfig } from './lib/venue-reads.mjs'

// Re-exported for existing importers; the implementation lives in lib/termsNormalize.mjs.
export { normalizeVisibleText }

export function publicTermsUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    const hostname = parsed.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '')
    if (
      isIP(hostname) ||
      !hostname.includes('.') ||
      /(?:^|\.)(?:localhost|local|internal|localdomain|lan|home|onion|arpa)$/i.test(hostname) ||
      !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
    )
      return null
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

/** A stripped query or credential can point reviewers at a different page. */
export function publicReviewUrl(raw) {
  try {
    const url = new URL(raw)
    if (url.username || url.password || url.search || url.hash) return null
    return publicTermsUrl(raw)
  } catch {
    return null
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** A redirect target must pass the same host policy before another request. */
export async function fetchOfficialTermsPage(
  entryUrl,
  { fetchImpl = fetch, timeoutMs = 20_000, maxRedirects = 5 } = {},
) {
  if (!publicTermsUrl(entryUrl)) throw new Error('terms_source_url_rejected')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let currentUrl = new URL(entryUrl).toString()
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'membrane-venue-recorder/terms-watch (+https://membrane)' },
      })
      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects === maxRedirects) throw new Error('terms_redirect_limit')
        const location = response.headers?.get('location')
        if (!location) throw new Error('terms_redirect_missing_location')
        let nextUrl
        try {
          nextUrl = new URL(location, currentUrl).toString()
        } catch {
          throw new Error('terms_redirect_invalid_location')
        }
        if (!publicTermsUrl(nextUrl)) throw new Error('terms_redirect_url_rejected')
        currentUrl = nextUrl
        continue
      }
      const responseUrl = response.url || currentUrl
      if (!publicTermsUrl(responseUrl) || new URL(responseUrl).toString() !== currentUrl) {
        throw new Error('terms_response_url_mismatch')
      }
      if (!response.ok) return { ok: false, status: response.status }
      return { ok: true, text: termsText(await response.text()), finalUrl: responseUrl }
    }
    throw new Error('terms_redirect_limit')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * HTTP sql.transaction is non-interactive. Its first statement takes a
 * transaction-scoped lock, and its second gets a fresh READ COMMITTED snapshot
 * after that lock, then performs both inserts in one statement. A single SQL
 * statement with a lock CTE would keep its pre-lock snapshot and race.
 */
export async function recordTermsObservation(sql, { venue, url, finalUrl = null, hash, len }) {
  const prefix = `${TERMS_HASH_VERSION}:`
  const sourceUrl = publicReviewUrl(url)
  const publicFinalUrl = publicReviewUrl(finalUrl)
  const [, [result]] = await sql.transaction(
    [
      sql`SELECT pg_advisory_xact_lock(hashtextextended(
        'terms-page-watch-v1:' || jsonb_build_array(${venue}::text, ${url}::text)::text, 0))`,
      sql`
        WITH previous AS MATERIALIZED (
          SELECT content_hash, content_len, fetched_at FROM venue_terms
          WHERE venue = ${venue}::text AND url = ${url}::text
          ORDER BY fetched_at DESC, id DESC LIMIT 1
        ), decision AS MATERIALIZED (
          SELECT CASE
            WHEN p.content_hash IS NULL THEN 'baseline'
            WHEN left(p.content_hash, length(${prefix}::text)) <> ${prefix}::text THEN 'rebaseline'
            WHEN p.content_hash = ${hash}::text THEN 'unchanged'
            ELSE 'changed'
          END AS status, p.content_hash AS prev_hash, p.content_len AS prev_len,
            p.fetched_at AS prev_fetched_at
          FROM (SELECT 1) seed LEFT JOIN previous p ON true
        ), observation AS MATERIALIZED (
          SELECT d.*, greatest(clock_timestamp(),
            coalesce(d.prev_fetched_at + interval '1 microsecond', '-infinity'::timestamptz)
          ) AS observed_at FROM decision d
        ), inserted_terms AS (
          INSERT INTO venue_terms (venue, url, content_hash, content_len, fetched_at)
          SELECT ${venue}::text, ${url}::text, ${hash}::text, ${len}::integer, observed_at
          FROM observation WHERE status <> 'unchanged'
          RETURNING id
        ), inserted_event AS (
          INSERT INTO venue_events (venue, kind, prev, next, note, observed_at, created_at)
          SELECT ${venue}::text, 'terms_page_changed',
            jsonb_build_object('content_hash', d.prev_hash, 'content_len', d.prev_len),
            jsonb_build_object('content_hash', ${hash}::text, 'content_len', ${len}::integer,
              'source_url', ${sourceUrl}::text, 'final_url', ${publicFinalUrl}::text),
            format('terms page changed: %s…(%s) -> %s…(%s) @ %s',
              left(d.prev_hash, 12), d.prev_len, left(${hash}::text, 12), ${len}::integer,
              ${sourceUrl ?? '[unavailable source URL]'}::text), d.observed_at, d.observed_at
          FROM observation d JOIN inserted_terms t ON true WHERE d.status = 'changed'
          RETURNING id
        )
        SELECT d.status, d.prev_hash, d.prev_len,
          (SELECT count(*)::int FROM inserted_terms) AS terms_rows,
          (SELECT count(*)::int FROM inserted_event) AS event_rows
        FROM observation d`,
    ],
    { isolationLevel: 'ReadCommitted' },
  )
  return result
}

async function main() {
  const { get } = readEnv()
  const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
  if (!dbUrl) throw new Error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  const sql = neon(dbUrl)
  let baselines = 0
  let rebaselines = 0
  let changes = 0
  let unchanged = 0
  let failed = 0

  for (const venue of loadConfig().filter((v) => v.enabled && v.termsUrl)) {
    const v = venue.name
    const url = venue.termsUrl
    console.log(`\n[${v}] ${publicTermsUrl(url) ?? '[invalid terms URL]'}`)

    // Fetch is non-fatal per venue (swallow-and-continue).
    let text
    let finalUrl = null
    try {
      const page = await fetchOfficialTermsPage(url)
      if (!page.ok) {
        console.log(`  fetch failed: HTTP ${page.status} — skipped (non-fatal)`)
        failed++
        continue
      }
      finalUrl = page.finalUrl
      text = page.text
    } catch {
      console.log('  fetch error — skipped (non-fatal)')
      failed++
      continue
    }

    const hash = termsHash(text)
    const len = text.length

    const {
      status: decision,
      prev_hash: prevHash,
      prev_len: prevLen,
    } = await recordTermsObservation(sql, { venue: v, url, finalUrl, hash, len })

    if (decision === 'baseline' || decision === 'rebaseline') {
      if (decision === 'baseline') {
        console.log(
          `  baseline seeded (no prior hash) — hash=${hash.slice(0, 15)}… len=${len} (NO event)`,
        )
        baselines++
      } else {
        console.log(
          `  re-baselined (normalizer upgraded from ${String(prevHash).slice(0, 12)}…) — hash=${hash.slice(0, 15)}… len=${len} (NO event)`,
        )
        rebaselines++
      }
      continue
    }

    if (decision === 'unchanged') {
      console.log(`  unchanged — hash=${hash.slice(0, 15)}… len=${len} (no new row)`)
      unchanged++
      continue
    }

    console.log(
      `  CHANGED — ${prevHash.slice(0, 12)}…(${prevLen}) -> ${hash.slice(0, 12)}…(${len}); event terms_page_changed inserted`,
    )
    changes++
  }

  console.log(
    `\nterms watch complete — baselines: ${baselines}, re-baselines: ${rebaselines}, changes: ${changes}, unchanged: ${unchanged}, failed: ${failed}`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code =
      typeof error?.code === 'string' && /^[A-Z0-9]{2,10}$/.test(error.code) ? error.code : null
    const parameter =
      typeof error?.message === 'string'
        ? (error.message.match(/parameter \$\d+/)?.[0] ?? null)
        : null
    console.error(
      JSON.stringify({
        status: 'terms_watch_failed',
        kind: error?.name ?? 'unknown',
        code,
        parameter,
      }),
    )
    process.exitCode = 1
  })
}
