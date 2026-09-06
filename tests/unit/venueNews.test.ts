import { describe, expect, it } from 'vitest'

// The parser is a dependency-free .mjs shared with the fetcher that actually
// runs (scripts/fetch-venue-news.mjs), so the code under test IS the code that
// runs in production.
import { decodeEntities, parseRssItems, toNewsRows } from '../../scripts/lib/newsParse.mjs'

// A minimal Google-News-shaped RSS 2.0 fixture: CDATA titles with the
// " - Outlet" suffix, a <source> element, entity-encoded characters, one
// DUPLICATE link (same url, later item) to exercise dedupe, and one item with a
// malformed pubDate to exercise the null-date path.
const FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Ethena sUSDe - Google News</title>
  <item>
    <title><![CDATA[Ethena&#39;s sUSDe crosses $5B - CoinDesk]]></title>
    <link>https://news.google.com/rss/articles/AAA?oc=5</link>
    <pubDate>Wed, 03 Sep 2026 12:00:00 GMT</pubDate>
    <source url="https://coindesk.com">CoinDesk</source>
  </item>
  <item>
    <title>Sky &amp; Ethena partnership deepens - The Block</title>
    <link>https://news.google.com/rss/articles/BBB?oc=5</link>
    <pubDate>Tue, 02 Sep 2026 08:30:00 GMT</pubDate>
    <source url="https://theblock.co">The Block</source>
  </item>
  <item>
    <title><![CDATA[Ethena&#39;s sUSDe crosses $5B - CoinDesk]]></title>
    <link>https://news.google.com/rss/articles/AAA?oc=5</link>
    <pubDate>Wed, 03 Sep 2026 12:00:00 GMT</pubDate>
    <source url="https://coindesk.com">CoinDesk</source>
  </item>
  <item>
    <title>Headline with no source element - DeFiLlama</title>
    <link>https://news.google.com/rss/articles/CCC?oc=5</link>
    <pubDate>not-a-real-date</pubDate>
  </item>
</channel></rss>`

describe('newsParse.decodeEntities', () => {
  it('decodes named, numeric and hex entities, amp last', () => {
    expect(decodeEntities('Ethena&#39;s')).toBe("Ethena's")
    expect(decodeEntities('AT&amp;T')).toBe('AT&T')
    expect(decodeEntities('a &lt;b&gt; c')).toBe('a <b> c')
    expect(decodeEntities('&#x2019;')).toBe('’')
    expect(decodeEntities(null)).toBe('')
  })
})

describe('newsParse.parseRssItems', () => {
  it('extracts every <item> with raw title/link/pubDate/source', () => {
    const items = parseRssItems(FIXTURE)
    expect(items).toHaveLength(4)
    expect(items[0].link).toBe('https://news.google.com/rss/articles/AAA?oc=5')
    expect(items[0].source).toBe('CoinDesk')
    expect(items[0].pubDate).toBe('Wed, 03 Sep 2026 12:00:00 GMT')
    // CDATA is unwrapped but entities are left raw at this layer.
    expect(items[0].title).toContain('&#39;')
  })

  it('returns [] for a malformed / itemless feed', () => {
    expect(parseRssItems('<html>not a feed</html>')).toEqual([])
    expect(parseRssItems('')).toEqual([])
    // Non-string input must not throw.
    expect(parseRssItems(null)).toEqual([])
    expect(parseRssItems(undefined)).toEqual([])
  })
})

describe('newsParse.toNewsRows', () => {
  it('decodes titles, dedupes by url, and prefers the <source> element', () => {
    const rows = toNewsRows(FIXTURE)
    // 4 items but one is a duplicate link → 3 unique rows.
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.url)).toEqual([
      'https://news.google.com/rss/articles/AAA?oc=5',
      'https://news.google.com/rss/articles/BBB?oc=5',
      'https://news.google.com/rss/articles/CCC?oc=5',
    ])
    // Entity decoded; " - CoinDesk" suffix NOT stripped because <source> exists.
    expect(rows[0].title).toBe("Ethena's sUSDe crosses $5B - CoinDesk")
    expect(rows[0].source).toBe('CoinDesk')
    expect(rows[0].publishedAt).toBe('2026-09-03T12:00:00.000Z')
  })

  it('falls back to the " - Outlet" title suffix when <source> is absent', () => {
    const rows = toNewsRows(FIXTURE)
    const noSource = rows.find((r) => r.url.endsWith('CCC?oc=5'))!
    expect(noSource.source).toBe('DeFiLlama')
    expect(noSource.title).toBe('Headline with no source element')
    // Unparseable pubDate → null, never NaN or a throw.
    expect(noSource.publishedAt).toBeNull()
  })

  it('caps at the requested max', () => {
    expect(toNewsRows(FIXTURE, { max: 1 })).toHaveLength(1)
  })

  it('returns [] for a malformed feed', () => {
    expect(toNewsRows('garbage')).toEqual([])
  })
})
