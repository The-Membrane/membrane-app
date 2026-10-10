import { describe, expect, it, vi } from 'vitest'
import catalog from '@/tools/carry-news-sources.config.json'
import { runNewsPass, upsertVenueNews } from '../../scripts/fetch-venue-news.mjs'

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

describe('Carry protocol news polling', () => {
  it('updates every identity-bound field and the sealed fetch clock in one database upsert', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = []
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values })
      return [{ id: 7 }]
    }
    const row = {
      title: 'Updated headline',
      source: 'Bound Wire',
      url: 'https://news.google.com/rss/articles/BOUND',
      publishedAt: '2026-10-05T00:15:00.000Z',
    }
    const fetchedAt = '2026-10-05T00:20:00.000Z'

    await expect(upsertVenueNews(sql, 'aave-v3-usdc', row, fetchedAt)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain(
      'ON CONFLICT (venue, url) DO UPDATE SET title = EXCLUDED.title, source = EXCLUDED.source, published_at = EXCLUDED.published_at, fetched_at = EXCLUDED.fetched_at',
    )
    expect(calls[0].values).toEqual([
      'aave-v3-usdc',
      row.title,
      row.source,
      row.url,
      row.publishedAt,
      fetchedAt,
    ])
  })

  it('passes the receipt start clock to the database mirror for every parsed item', async () => {
    const insertRow = vi.fn(async () => true)
    const times = ['2026-10-05T00:20:00.000Z', '2026-10-05T00:20:01.000Z']
    await runNewsPass([{ name: 'aave-v3-usdc', newsQuery: 'Aave V3 USDC' }], {
      fetchImpl: async () => new Response(FIXTURE, { status: 200 }),
      insertRow,
      saveLocal: () => ({
        saved: 3,
        total: 3,
        updatedAt: '2026-10-05T00:20:00.000Z',
      }),
      now: () => times.shift()!,
      append: (receipt: Record<string, unknown>) => ({
        ...receipt,
        sha256: 'a'.repeat(64),
        study: 'venue-news-rss-polls-v1',
        receiptVersion: 3,
        sequence: 1,
        previousSha256: null,
      }),
    })

    expect(insertRow).toHaveBeenCalledTimes(3)
    expect(insertRow).toHaveBeenNthCalledWith(
      1,
      'aave-v3-usdc',
      expect.objectContaining({ source: 'CoinDesk' }),
      { fetchedAt: '2026-10-05T00:20:00.000Z' },
    )
  })

  it('polls each shared destination protocol once, including the scrvUSD recorder source', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => '<rss><channel></channel></rss>',
    }))
    const saveReceipt = vi.fn(async () => undefined)
    const sources = catalog.sources.map((source) => ({ name: source.id, newsQuery: source.query }))
    const result = await runNewsPass(
      [...sources, sources.find((source) => source.name === 'fluid')!],
      {
        fetchImpl,
        insertRow: async () => true,
        saveLocal: () => undefined,
        now: () => '2026-10-05T00:00:00.000Z',
        append: (receipt: Record<string, unknown>) => ({ ...receipt, sequence: 1 }),
        saveReceipt,
      },
    )
    expect(result.failures).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(16)
    expect(saveReceipt).toHaveBeenCalledTimes(16)
    expect(sources).toHaveLength(16)
    expect(sources.some((source) => source.name === 'scrvUSD')).toBe(true)
  })

  it('keeps local success when the optional receipt mirror fails', async () => {
    const result = await runNewsPass([{ name: 'aave-v3-usdc', newsQuery: 'Aave V3 USDC' }], {
      fetchImpl: async () => ({ ok: true, text: async () => '<rss><channel></channel></rss>' }),
      saveLocal: () => undefined,
      now: () => '2026-10-05T00:00:00.000Z',
      append: (receipt: Record<string, unknown>) => ({ ...receipt, sequence: 1 }),
      saveReceipt: async () => {
        throw new Error('private mirror outage')
      },
    })
    expect(result).toEqual({ inserted: 0, locallyCaptured: 0, failures: 0, mirrorFailures: 1 })
  })

  it('does not count a rejected local save as captured data', async () => {
    const result = await runNewsPass([{ name: 'aave-v3-usdc', newsQuery: 'Aave V3 USDC' }], {
      fetchImpl: async () => ({ ok: true, text: async () => '<rss><channel></channel></rss>' }),
      saveLocal: async () => {
        throw new Error('private local path')
      },
      now: () => '2026-10-05T00:00:00.000Z',
      append: (receipt: Record<string, unknown>) => ({ ...receipt, sequence: 1 }),
    })
    expect(result).toEqual({ inserted: 0, locallyCaptured: 0, failures: 1, mirrorFailures: 0 })
  })
})
