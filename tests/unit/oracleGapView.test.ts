import { describe, expect, it } from 'vitest'

import {
  ADDRESS_HINT,
  bothPricesLine,
  cardState,
  cardTag,
  cardTitles,
  commitTyped,
  notReadReason,
  parseStarred,
  pickCards,
  sortCards,
  stateLine,
  toggleStar,
  uncheckedNote,
  viewerOf,
  type PickMarket,
  type Tone,
  type ToneMarket,
} from '@/components/CuratorFeed/oracleGapView'
import type { I3Constants } from '@/lib/curatorFeed/oracleGap'
import type { Relation } from '@/lib/exposure'

// §07's view logic (components/CuratorFeed/oracleGapView.ts): whose address is read,
// which cards show, what tag each carries.

const A = '0x1eB1994C6de521686f5B97B017fF6AFAB81FF2bb' // wagmi gives checksummed addresses
const B = '0x000000000000000000000000000000000000dEaD'
const id = (i: number) => `0x${i.toString(16).padStart(64, '0')}`

describe('whose address is read', () => {
  it('follows the connected wallet across a switch', () => {
    expect(viewerOf(undefined, null)).toEqual({ address: null, fromWallet: false, error: null })
    expect(viewerOf(A, null)).toEqual({ address: A.toLowerCase(), fromWallet: true, error: null })
    // Switch A → B: B is read, never A's ties.
    expect(viewerOf(B, null).address).toBe(B.toLowerCase())
    // Disconnect: nothing read.
    expect(viewerOf(undefined, null).address).toBeNull()
  })

  it('a typed address wins over the wallet, through a switch; clearing goes back to the wallet', () => {
    const typed = commitTyped(` ${B.toLowerCase()} `)
    expect(typed).toEqual({ address: B.toLowerCase(), error: null })
    expect(viewerOf(A, typed)).toEqual({ address: B.toLowerCase(), fromWallet: false, error: null })
    expect(viewerOf('0x' + '1'.repeat(40), typed).address).toBe(B.toLowerCase())
    expect(commitTyped('   ')).toBeNull()
    expect(viewerOf(A, commitTyped('')).address).toBe(A.toLowerCase())
  })

  it('an invalid entry reads no address (the last highlights clear) and says why', () => {
    for (const bad of ['0x123', 'vitalik.eth', '0x1eb1994C6de521686f5B97B017fF6AFAB81FF2bb']) {
      const t = commitTyped(bad)
      expect(t).toEqual({ address: null, error: ADDRESS_HINT })
      expect(viewerOf(A, t)).toEqual({ address: null, fromWallet: false, error: ADDRESS_HINT })
    }
  })
})

const rel = (o: Partial<Relation> = {}): Relation => ({
  kind: 'via-vault',
  roles: ['vault'],
  path: ['0x' + '1'.repeat(40)],
  vaultNames: ['Alpha USDC'],
  book: false,
  ...o,
})

const mkt = (
  i: number,
  o: { usd?: number; state?: PickMarket['i3']['state']; relation?: Relation } = {},
): PickMarket => ({
  market: id(i),
  curatedUsd: o.usd ?? 5_000_000,
  ...(o.relation ? { relation: o.relation } : {}),
  i3: { state: o.state ?? 'below', hoursAboveConsecutive: o.state === 'building' ? 3 : 0 },
})

describe('a card’s tag', () => {
  it('live, snapshot (as of), dust, and ░ tie not read when the read could not say', () => {
    const none = new Set<string>()
    expect(cardTag(mkt(1), none)).toBeUndefined()
    expect(cardTag(mkt(1), new Set([id(1)]))).toEqual({
      text: '░ tie not read',
      style: 'unchecked',
    })
    expect(cardTag(mkt(1, { relation: rel() }), none)).toEqual({
      text: 'your vault Alpha USDC',
      style: 'live',
    })
    expect(cardTag(mkt(1, { relation: rel({ asOf: 1_791_500_000 }) }), none)).toEqual({
      text: `your vault Alpha USDC · as of ${new Date(1_791_500_000_000).toISOString().slice(0, 10)}`,
      style: 'snapshot',
    })
    expect(cardTag(mkt(1, { relation: rel({ vaultUsd: 0.4, dustBelow: 1 }) }), none)).toEqual({
      text: 'your vault Alpha USDC · supplies under $1',
      style: 'dust',
    })
    // A known tie outranks "unchecked" (a direct position read while a vault read failed).
    expect(cardTag(mkt(1, { relation: rel() }), new Set([id(1)]))!.style).toBe('live')
  })
})

describe('which cards show', () => {
  const base = { stale: false, all: false, minUsd: 1, unchecked: new Set<string>() }
  const markets = [
    mkt(1, { state: 'building' }), // above the line
    mkt(2, { relation: rel() }), // yours, below the line
    mkt(3, { relation: rel({ asOf: 1 }) }), // yours as of the snapshot
    mkt(4, { usd: 0.2, relation: rel({ usd: 0.3, dustBelow: 1 }) }), // a dust tie, no curated $
    mkt(5), // below, not yours
    mkt(6, { usd: 0.5, state: 'building' }), // above, under $1 curated
  ]

  it('no viewer: the markets above the line, under-$1 ones folded', () => {
    const p = pickCards({ ...base, markets, hasViewer: false, only: false })
    expect(p.held.map((m) => m.market)).toEqual([id(1)])
    expect(p.unheld.map((m) => m.market)).toEqual([id(6)])
    expect(p.mine).toBe(2)
  })

  it('highlight: yours lifted into the grid; a dust tie is not lifted', () => {
    const p = pickCards({ ...base, markets, hasViewer: true, only: false })
    expect(p.held.map((m) => m.market)).toEqual([id(1), id(2), id(3)])
    expect(p.unheld.map((m) => m.market)).toEqual([id(6)])
    expect(p.unchecked).toEqual([])
  })

  it('only mine: every tie, dust under the fold; unchecked markets kept behind their own fold', () => {
    const unchecked = new Set([id(5), id(2)])
    const p = pickCards({ ...base, unchecked, markets, hasViewer: true, only: true })
    expect(p.held.map((m) => m.market)).toEqual([id(2), id(3)])
    expect(p.unheld.map((m) => m.market)).toEqual([id(4)])
    // id(2) has a tie, so it is not "unchecked"; id(5) is.
    expect(p.unchecked.map((m) => m.market)).toEqual([id(5)])
    expect(p.uncheckedCount).toBe(1)
    expect(p.mine).toBe(2)
  })

  it('only mine: a dust tie sits under the fold even where the market’s curated supply is ≥ $1', () => {
    // The LBTC / TSLAon / FLHYon case: other vaults supply millions, yours supplies < $1.
    const withDust = [
      mkt(2, { relation: rel() }),
      mkt(7, { usd: 5_000_000, relation: rel({ vaultUsd: 0.2, dustBelow: 1 }) }),
      mkt(8, { usd: 5_000_000, state: 'building', relation: rel({ vaultUsd: 0.1, dustBelow: 1 }) }),
    ]
    const only = pickCards({ ...base, markets: withDust, hasViewer: true, only: true })
    expect(only.held.map((m) => m.market)).toEqual([id(2)])
    expect(only.unheld.map((m) => m.market)).toEqual([id(7), id(8)])
    expect(only.mine).toBe(1)
    // Highlight: the fold stays the market's, so an above-the-line market with a dust tie
    // is still a grid card (with its "supplies under $1" tag); the dust tie is not lifted.
    const hl = pickCards({ ...base, markets: withDust, hasViewer: true, only: false })
    expect(hl.held.map((m) => m.market)).toEqual([id(2), id(8)])
    expect(hl.unheld).toEqual([])
  })

  it('stale: the markets that were above the line at their last point', () => {
    const p = pickCards({
      ...base,
      stale: true,
      markets: [{ ...mkt(1), i3: { state: 'stale', hoursAboveConsecutive: 5 } }, mkt(2)],
      hasViewer: false,
      only: false,
    })
    expect(p.above.map((m) => m.market)).toEqual([id(1)])
  })
})

describe('a card’s title', () => {
  it('a unique name stays; a shared name gets the shortest id prefix that tells them apart', () => {
    const t = cardTitles([
      { market: '0x8dc0aa' + '0'.repeat(58), marketName: 'weETH/USDC (86% LLTV)' },
      { market: '0x37e7bb' + '0'.repeat(58), marketName: 'weETH/USDC (86% LLTV)' },
      { market: id(9), marketName: 'WBTC/USDC (86% LLTV)' },
    ])
    expect(t.get('0x8dc0aa' + '0'.repeat(58))).toBe('weETH/USDC (86% LLTV) · 0x8dc0…')
    expect(t.get('0x37e7bb' + '0'.repeat(58))).toBe('weETH/USDC (86% LLTV) · 0x37e7…')
    expect(t.get(id(9))).toBe('WBTC/USDC (86% LLTV)')
  })

  it('ids that share their first 4 hex digits get longer prefixes, only as long as needed', () => {
    const a = '0x8dc0a1' + '0'.repeat(58)
    const b = '0x8dc0b2' + '0'.repeat(58)
    const t = cardTitles([
      { market: a, marketName: 'X/USDC (86% LLTV)' },
      { market: b, marketName: 'X/USDC (86% LLTV)' },
    ])
    expect(t.get(a)).toBe('X/USDC (86% LLTV) · 0x8dc0a…')
    expect(t.get(b)).toBe('X/USDC (86% LLTV) · 0x8dc0b…')
  })
})

describe('unchecked: one number, one meaning', () => {
  it('a market the read could not check but that carries a tie is not counted; every place prints the same note', () => {
    // The read could not check 3 markets; one of them is tied through the snapshot.
    const unchecked = new Set([id(1), id(2), id(3)])
    const markets = [mkt(1), mkt(2), mkt(3, { relation: rel({ asOf: 1 }) }), mkt(4)]
    const base = { stale: false, all: false, minUsd: 1, unchecked, markets, hasViewer: true }
    const hl = pickCards({ ...base, only: false })
    const only = pickCards({ ...base, only: true })
    expect(hl.uncheckedCount).toBe(2)
    expect(only.uncheckedCount).toBe(2)
    // The "show N unchecked" fold holds exactly the counted markets.
    expect(only.unchecked.map((m) => m.market)).toEqual([id(1), id(2)])
    // The tied one carries its tie, not "unchecked".
    expect(cardTag(markets[2], unchecked)!.style).toBe('snapshot')
    expect(uncheckedNote(hl.uncheckedCount)).toBe('░ 2 ties not read')
    expect(uncheckedNote(1)).toBe('░ 1 tie not read')
  })
})

describe('why a tie was not read', () => {
  const res = (o: { label?: string; status?: string; failed?: string[]; error?: string }) => ({
    label: o.label ?? 'Morpho Blue positions',
    status: o.status ?? 'ok',
    failed: (o.failed ?? []).map((name) => ({ error: { name } })),
    ...(o.error ? { error: { name: o.error } } : {}),
  })
  it('counts the failed reads and names their error classes once', () => {
    const failed = Array.from({ length: 100 }, (_, i) =>
      i < 99 ? 'HttpRequestError' : 'TimeoutError',
    )
    expect(notReadReason({ results: [res({ failed }), res({ label: 'Vault shares' })] })).toBe(
      '100 reads failed: HttpRequestError, TimeoutError',
    )
    expect(notReadReason({ results: [res({ failed: ['TimeoutError'] })] })).toBe(
      '1 read failed: TimeoutError',
    )
  })
  it('a resolver that read nothing says which; a clean read has no reason', () => {
    expect(notReadReason({ results: [res({ status: 'error', error: 'RpcError' })] })).toBe(
      'Morpho Blue positions: read failed (RpcError)',
    )
    expect(notReadReason({ results: [res({})] })).toBeUndefined()
  })
})

// ── colour state, sort order, both prices, stars ─────────────────────────────

const C: I3Constants = { gap: 0.02, persistenceHours: 24, persistenceDailyPoints: 2 }
const T0 = 1_792_000_800 // on the hour
const hourly = (gaps: (number | null)[]) => gaps.map((gap, i) => ({ ts: T0 + i * 3600, gap }))
const toneMkt = (o: {
  state: ToneMarket['i3']['state']
  gap?: number
  above?: number
  series?: (number | null)[]
}): ToneMarket => ({
  i3: {
    state: o.state,
    currentGap: o.gap,
    hoursAboveConsecutive: o.above ?? 0,
    persistence: 24,
  },
  series: hourly(o.series ?? (o.gap === undefined ? [] : [o.gap])),
})

describe('a card’s colour: oracle vs market, either way', () => {
  it('within the line: neutral (paper), either side', () => {
    expect(cardState(toneMkt({ state: 'below', gap: 0.0199 }), C).tone).toBe('neutral')
    expect(cardState(toneMkt({ state: 'below', gap: -0.0199 }), C).tone).toBe('neutral')
    expect(stateLine(cardState(toneMkt({ state: 'below', gap: 0 }), C), C)).toBe(
      'within ±2% of market',
    )
  })

  it('above by ≥ 2% now: pale; fired (24 h): warning', () => {
    const pale = cardState(toneMkt({ state: 'building', gap: 0.02, above: 3 }), C)
    expect(pale).toEqual({ tone: 'pale', dir: 'above', hours: 3, persistence: 24 })
    expect(stateLine(pale, C)).toBe('▲ 3 of 24 h ≥ 2% above market')
    const fired = cardState(toneMkt({ state: 'fired', gap: 0.031, above: 30 }), C)
    expect(fired).toEqual({ tone: 'warning', dir: 'above', hours: 30, persistence: 24 })
    expect(stateLine(fired, C)).toBe('✖ fired · 30 h ≥ 2% above market')
  })

  it('below by ≥ 2% now: pale, labelled below; 24 hourly points below: warning', () => {
    const now = cardState(
      toneMkt({ state: 'below', gap: -0.11, series: [-0.001, 0.0, -0.05, -0.11] }),
      C,
    )
    expect(now).toEqual({ tone: 'pale', dir: 'below', hours: 2, persistence: 24 })
    expect(stateLine(now, C)).toBe('▼ 2 of 24 h ≥ 2% below market')
    const day = Array.from({ length: 24 }, () => -0.3)
    const fired = cardState(toneMkt({ state: 'below', gap: -0.3, series: [0, ...day] }), C)
    expect(fired).toEqual({ tone: 'warning', dir: 'below', hours: 24, persistence: 24 })
    expect(stateLine(fired, C)).toBe('✖ fired · 24 h ≥ 2% below market')
  })

  it('a missing hour breaks the below run, as it breaks the above run', () => {
    const series = [
      ...Array.from({ length: 12 }, () => -0.3),
      null,
      ...Array.from({ length: 12 }, () => -0.3),
    ]
    const s = cardState(toneMkt({ state: 'below', gap: -0.3, series }), C)
    expect(s.tone).toBe('pale')
    expect(s.hours).toBe(12)
  })

  it('stale or not measured: neutral (the card is hatched instead)', () => {
    expect(cardState(toneMkt({ state: 'stale', gap: 0.5, above: 30 }), C).tone).toBe('neutral')
    expect(cardState(toneMkt({ state: 'unobserved' }), C).tone).toBe('neutral')
  })
})

describe('the grid’s order: highlight > starred > severity', () => {
  type M = { market: string; relation?: Relation; tone: Tone }
  const m = (i: number, tone: Tone, relation?: Relation): M => ({
    market: id(i),
    tone,
    ...(relation ? { relation } : {}),
  })
  const cards: M[] = [
    m(1, 'warning'),
    m(2, 'neutral', rel()), // yours, calm
    m(3, 'pale'),
    m(4, 'neutral'), // starred
    m(5, 'pale', rel({ asOf: 1 })), // yours as of the snapshot
    m(6, 'warning'), // starred
    m(7, 'neutral', rel({ vaultUsd: 0.2, dustBelow: 1 })), // a dust tie: not highlighted
  ]
  const tone = (x: M) => x.tone
  const starred = new Set([id(4), id(6)])

  it('highlight on: ties first, then starred, then warning > pale > the rest; API order inside', () => {
    const out = sortCards(cards, { highlight: true, starred, tone }).map((x) => x.market)
    expect(out).toEqual([id(5), id(2), id(6), id(4), id(1), id(3), id(7)])
  })

  it('highlight off: a tie is not lifted; starred, then severity', () => {
    const out = sortCards(cards, { highlight: false, starred, tone }).map((x) => x.market)
    expect(out).toEqual([id(6), id(4), id(1), id(3), id(5), id(2), id(7)])
  })

  it('no stars, no viewer: severity only, stable', () => {
    const out = sortCards(cards, { highlight: false, starred: new Set(), tone }).map(
      (x) => x.market,
    )
    expect(out).toEqual([id(1), id(6), id(3), id(5), id(2), id(4), id(7)])
  })
})

describe('which cards show: starred and both sides', () => {
  const base = { stale: false, all: false, minUsd: 1, unchecked: new Set<string>() }
  const markets = [mkt(1, { state: 'building' }), mkt(2), mkt(3, { usd: 0.1 }), mkt(4)]
  const tone = (m: PickMarket): Tone =>
    m.market === id(1) ? 'pale' : m.market === id(4) ? 'pale' : 'neutral' // id(4): below market

  it('a below-market card is in the default set, with the tone', () => {
    const p = pickCards({ ...base, markets, hasViewer: false, only: false, tone })
    expect(p.held.map((m) => m.market)).toEqual([id(1), id(4)])
  })

  it('a starred market is always in the grid, even under $1 curated', () => {
    const p = pickCards({
      ...base,
      markets,
      hasViewer: false,
      only: false,
      tone,
      starred: new Set([id(3)]),
    })
    expect(p.held.map((m) => m.market)).toEqual([id(1), id(3), id(4)])
  })

  it('the Starred filter: only the starred markets', () => {
    const starred = new Set([id(2), id(3)])
    const p = pickCards({
      ...base,
      markets,
      hasViewer: false,
      only: false,
      tone,
      starred,
      starredOnly: true,
    })
    expect(p.held.map((m) => m.market)).toEqual([id(2), id(3)])
    expect(p.unheld).toEqual([])
  })
})

describe('both prices past a 100% gap', () => {
  const at = (gap: number, latest?: { oracleUsd?: number; marketUsd?: number }) => ({
    i3: { currentGap: gap, state: 'fired' as const },
    ...(latest ? { latest: { ts: T0 + 6 * 3600, ...latest } } : {}),
  })
  it('|gap| ≤ 100%: the delta alone', () => {
    expect(bothPricesLine(at(1, { oracleUsd: 2, marketUsd: 1 }))).toBeUndefined()
    expect(bothPricesLine(at(-0.5, { oracleUsd: 0.5, marketUsd: 1 }))).toBeUndefined()
  })
  it('> 100%: both prices, spot, the point’s hour, no average', () => {
    expect(bothPricesLine(at(10.943429, { oracleUsd: 0.999796, marketUsd: 0.083711 }))).toBe(
      'oracle $0.9998 · market $0.083711 · spot at 00:00 UTC, no average',
    )
    // A collapsed market price: the figure caps at >1,000%, the line gives the detail.
    expect(bothPricesLine(at(99979635.4, { oracleUsd: 0.999796, marketUsd: 1e-8 }))).toBe(
      'oracle $0.9998 · market $0.00000001 · spot at 00:00 UTC, no average',
    )
  })
  it('a missing price is named', () => {
    expect(bothPricesLine(at(2, { oracleUsd: 1 }))).toBe(
      'oracle $1 · market price missing · spot at 00:00 UTC, no average',
    )
    expect(bothPricesLine(at(2, { marketUsd: 0.03 }))).toMatch(
      /^oracle price missing · market \$0\.03 /,
    )
    expect(bothPricesLine(at(2))).toBe('oracle and market prices not stored for this point')
  })
  it('stale or not measured: no current prices are claimed', () => {
    expect(
      bothPricesLine({
        i3: { currentGap: 12, state: 'stale' },
        latest: { ts: T0, oracleUsd: 1, marketUsd: 0.01 },
      }),
    ).toBeUndefined()
  })
})

describe('stars, per viewer', () => {
  it('reads defensively and toggles by lowercase id', () => {
    expect(parseStarred(null).size).toBe(0)
    expect(parseStarred('not json').size).toBe(0)
    expect(parseStarred('{"a":1}').size).toBe(0)
    expect([...parseStarred('["0xAB", 3, "0xcd"]')]).toEqual(['0xab', '0xcd'])
    const s = toggleStar(new Set(), '0xAB')
    expect([...s]).toEqual(['0xab'])
    expect([...toggleStar(s, '0xab')]).toEqual([])
  })
})
