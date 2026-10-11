import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { decodeFlows } from '@/lib/curatorFeed/flows'
import { seedDir } from '@/lib/curatorFeed/paths'
import {
  buildAttributionResponse,
  buildExposureResponse,
  buildFeedResponse,
  buildSpikeResponse,
  parseFeedQuery,
} from '@/lib/curatorFeed/service'
import { compact } from '@/lib/curatorFeed/format'
import {
  parseExposureFile,
  parseFeedFile,
  parseFlowsFile,
  parseStateFile,
  SCHEMA,
} from '@/lib/curatorFeed/store'
import handler from '@/pages/api/curator-feed'

// Integrity of the canonical dataset in the private datasets repo
// ($MEMBRANE_DATASETS_DIR or ../membrane-datasets, dir curator-feed — board rule N18),
// written by scripts/collect-curator-feed.ts --publish. Skipped when it is not checked out.

const DIR = seedDir()
const has = existsSync(join(DIR, 'feed.json'))
const load = (n: string) => JSON.parse(readFileSync(join(DIR, n), 'utf8'))

describe.skipIf(!has)('curator feed dataset', () => {
  const feed = has ? parseFeedFile(load('feed.json')) : (null as never)
  const exposure = has ? parseExposureFile(load('exposure.json')) : (null as never)
  const flows = has ? parseFlowsFile(load('flows.json')) : (null as never)

  it('covers at least 180 days and stays under the 20 MB disk budget', () => {
    expect(feed.meta.toTs - feed.meta.fromTs).toBeGreaterThanOrEqual(180 * 86_400)
    const bytes = ['feed.json', 'flows.json', 'exposure.json', 'state.json'].reduce(
      (s, n) => s + statSync(join(DIR, n)).size,
      0,
    )
    expect(bytes).toBeLessThan(20 * 1024 * 1024)
  })

  it('stores endpoint LABELS only — never a URL, path or key', () => {
    const labels = [
      ...feed.meta.endpoints,
      ...Object.keys(feed.meta.logs.servedBy),
      ...Object.keys(feed.meta.logs.shortBy),
    ]
    for (const l of labels) expect(l).toMatch(/^(env:)?[a-z0-9.-]+$/)
    expect(JSON.stringify(feed.meta)).not.toMatch(/https?:\/\//)
  })

  it('every action sits inside the window and names a known emitter', () => {
    for (const a of feed.actions) {
      expect(a.ts).toBeGreaterThanOrEqual(feed.meta.fromTs)
      expect(a.ts).toBeLessThanOrEqual(feed.meta.toTs)
      expect(
        Boolean(feed.entities.vaults[a.vault] || feed.entities.aaveMarkets[a.vault]),
        a.id,
      ).toBe(true)
    }
  })

  it('carries a resumable collector state at the same block (incremental runs)', () => {
    const state = parseStateFile(load('state.json'))
    expect(state.schema).toBe(SCHEMA)
    expect(feed.meta.schema).toBe(SCHEMA)
    expect(state.toBlock).toBe(feed.meta.toBlock)
    expect(state.fromBlock).toBe(feed.meta.fromBlock)
    // Every carried open submit still exists in the feed (resume needs it).
    const ids = new Set(feed.actions.map((a) => a.id))
    for (const id of Object.values(state.classifier.open)) expect(ids.has(id), id).toBe(true)
  })

  it('every spike sits inside the window, on a known market, with its flows', () => {
    expect(feed.spikes.length).toBeGreaterThan(0)
    for (const s of feed.spikes) {
      expect(s.block).toBeGreaterThanOrEqual(feed.meta.fromBlock)
      expect(s.block).toBeLessThanOrEqual(feed.meta.toBlock)
      expect(feed.entities.markets[s.market], s.market).toBeTruthy()
      expect(BigInt(s.rateAfter) > BigInt(s.rateBefore)).toBe(true)
      for (const f of s.flows)
        if (f.vault) expect(feed.entities.vaults[f.vault], f.vault).toBeTruthy()
    }
  })

  it('every MetaMorpho market target resolves to market params', () => {
    const missing = feed.actions.filter(
      (a) =>
        a.protocol === 'morpho-v1' &&
        a.scope === 'market' &&
        a.target &&
        !feed.entities.markets[a.target],
    )
    expect(missing.length).toBe(0)
  })

  it('renders every row, cluster and attribution case in factual words', () => {
    const now = feed.meta.toTs
    const r = buildFeedResponse(feed, parseFeedQuery({ limit: '500' }), now)
    const texts = [...r.rows, ...r.open].map((x) => x.text).concat(r.clusters.map((c) => c.text))
    texts.push(
      ...buildAttributionResponse(feed, parseFeedQuery({ view: 'attribution' }), compact).map(
        (a) => a.text,
      ),
      ...buildSpikeResponse(
        feed,
        parseFeedQuery({ view: 'spikes', limit: '500' }),
        compact,
      ).rows.map((a) => a.text),
    )
    // Names come from the chain and registries (a vault is called "… USDC Safe"); the
    // judgement-word check applies to OUR copy, so entity names are removed first.
    const e = feed.entities
    const names = [
      ...Object.values(e.vaults).map((v) => v.name),
      ...Object.values(e.curators).map((c) => c.name),
      ...Object.values(e.strategies).map((x) => x.name),
      ...Object.values(e.tokens).map((x) => x.symbol),
    ]
      .filter((n) => n && n.length > 1)
      .sort((a, b) => b.length - a.length)
    const ours = (t: string) => names.reduce((s, n) => s.split(n).join(''), t)
    for (const t of texts) {
      expect(t).not.toMatch(/undefined|NaN|\[object/)
      expect(ours(t), t).not.toMatch(/\b(safe|unsafe|risky|healthy|secure|guarantee)/i)
    }
    expect(
      buildExposureResponse(feed, exposure, parseFeedQuery({ view: 'exposure' })).rows.length,
    ).toBeGreaterThan(0)
  })

  it('flows decode and reference the window', () => {
    const rows = decodeFlows(flows)
    expect(rows.length).toBeGreaterThan(0)
    expect(flows.toBlock).toBe(feed.meta.toBlock)
    for (const f of rows.slice(0, 1000)) expect(f.out >= 0 && f.in >= 0 && f.n > 0).toBe(true)
  })
})

describe.skipIf(!has)('GET /api/curator-feed', () => {
  const call = (query: Record<string, string>, method = 'GET') => {
    const out: { status: number; body: any; headers: Record<string, string> } = {
      status: 0,
      body: null,
      headers: {},
    }
    const res = {
      status(n: number) {
        out.status = n
        return res
      },
      json(b: unknown) {
        out.body = b
      },
      setHeader(k: string, v: string) {
        out.headers[k] = v
      },
    }
    handler({ method, query } as any, res as any)
    return out
  }
  it('serves the feed, both exposure views and attribution; rejects bad input', () => {
    const feed = call({ limit: '5' })
    expect(feed.status).toBe(200)
    expect(feed.body.rows.length).toBeLessThanOrEqual(5)
    expect(feed.headers['Cache-Control']).toMatch(/s-maxage=300/)
    expect(call({ view: 'exposure' }).body.rows.length).toBeGreaterThan(0)
    expect(call({ view: 'exposure', by: 'vault' }).body.vaults.length).toBeGreaterThan(0)
    const attribution = call({ view: 'attribution', limit: '3' }).body
    expect(attribution.rows.length).toBeLessThanOrEqual(3)
    expect(attribution.total).toBeGreaterThanOrEqual(attribution.rows.length)
    const spikes = call({ view: 'spikes', limit: '3' }).body
    expect(spikes.rows.length).toBeLessThanOrEqual(3)
    expect(spikes.total).toBeGreaterThanOrEqual(spikes.rows.length)
    expect(call({ window: '5' }).status).toBe(400)
    expect(call({ before: 'nope' }).status).toBe(400)
    expect(call({}, 'POST').status).toBe(405)
  })
})
