// Pure, dependency-free RSS parser for Google News RSS *search* feeds
// (https://news.google.com/rss/search?q=...). Shared by BOTH
// scripts/fetch-venue-news.mjs (the fetcher that runs) and
// tests/unit/venueNews.test.ts (the suite that pins its behavior) so the code
// under test IS the code that runs — no drift between them.
//
// Deliberately no XML library and no DOMParser (Node has none): a Google News
// RSS document is a flat, well-formed RSS 2.0 <channel> of <item> blocks, and a
// small, tolerant regex extractor over those blocks is enough. This is
// INFORMATION extraction only — we lift title/link/source/date VERBATIM. There
// is NO summarization, NO sentiment, NO scoring, NO LLM anywhere in this file.

// Named XML/HTML entities we decode. &amp; is applied LAST (see decodeEntities)
// so decoding it can't manufacture a fresh entity we already passed.
const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'" }

// Best-effort code-point decode; a bogus code point decodes to '' rather than
// throwing (store-raw discipline: never let one malformed entity abort a feed).
function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/** Decode the common XML/HTML entities found in RSS titles/sources. */
export function decodeEntities(s) {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&(lt|gt|quot|apos);/g, (_, n) => NAMED[n])
    .replace(/&amp;/g, '&')
}

// Strip a single CDATA wrapper if present, else return the raw inner text.
function stripCdata(s) {
  const c = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  return c ? c[1] : s
}

// Pull the inner text of the first <tag ...>...</tag> in `block`, CDATA-aware.
// Returns '' when the tag is absent.
function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? stripCdata(m[1]).trim() : ''
}

/**
 * Extract raw <item> records from an RSS document. Returns
 * [{ title, link, pubDate, source }] with each field a raw (still
 * entity-encoded) string, or [] for anything that is not a feed with items.
 */
export function parseRssItems(xml) {
  if (typeof xml !== 'string' || !/<item[\s>]/i.test(xml)) return []
  const items = []
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  let m
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    items.push({
      title: pickTag(block, 'title'),
      link: pickTag(block, 'link'),
      pubDate: pickTag(block, 'pubDate'),
      source: pickTag(block, 'source'),
    })
  }
  return items
}

// Parse an RFC-822 (or any Date-parseable) pubDate to an ISO string, or null.
function toIso(pubDate) {
  if (!pubDate) return null
  const t = Date.parse(pubDate)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/**
 * Turn an RSS document into deduped, decoded, capped news rows ready to insert:
 *   [{ title, url, source, publishedAt }]
 *
 * - decodes entities in title/source
 * - Google News appends " - Outlet" to titles and also carries a <source>
 *   element; we prefer <source>, else split the title suffix.
 * - dedupes by url (first occurrence wins — the feed is already newest-first)
 * - drops rows with no url or no title
 * - caps at `max` (default 25)
 * - malformed / itemless feed → []
 */
export function toNewsRows(xml, { max = 25 } = {}) {
  const raw = parseRssItems(xml)
  const seen = new Set()
  const rows = []
  for (const it of raw) {
    const url = decodeEntities(it.link).trim()
    if (!url || seen.has(url)) continue

    let title = decodeEntities(it.title).trim()
    let source = decodeEntities(it.source).trim()
    // Google News titles read "Headline - Outlet"; if <source> was absent, lift
    // the outlet from that suffix and strip it from the headline.
    if (!source && title.includes(' - ')) {
      const idx = title.lastIndexOf(' - ')
      source = title.slice(idx + 3).trim()
      title = title.slice(0, idx).trim()
    }
    if (!title) continue

    seen.add(url)
    rows.push({ title, url, source: source || 'Google News', publishedAt: toIso(it.pubDate) })
    if (rows.length >= max) break
  }
  return rows
}
