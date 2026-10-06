// Oracle registry page view-model (components/OracleRegistry/viewModel.ts): number and time
// formatting, the card's secondary lines, grouping and filtering, the tab marks, and the
// pure geometry behind the sparkline, the 30-day verdict strip and the basis bar.

import { describe, expect, it } from 'vitest'

import {
  ageAt,
  basisBar,
  basisSide,
  basisTallyLine,
  basisTallyOf,
  bandLabel,
  bandsLine,
  changesForCard,
  CLASS_LABEL,
  COLOUR_META,
  COLOUR_ORDER,
  colourCountsOf,
  colourLabel,
  describeCard,
  displayLabel,
  filterCards,
  fmtBps,
  fmtCompactUsd,
  fmtDuration,
  fmtRatio,
  fmtShortUtc,
  fmtUsd,
  fmtUtc,
  freshnessLine,
  groupCards,
  historyStat,
  honestGapLine,
  indexAt,
  lastFeedUpdate,
  linePath,
  nativeLine,
  priceDecimals,
  seriesDomain,
  shortAddr,
  sparkGeometry,
  stripCells,
  tabLabel,
  tabMarks,
  usedByLine,
  voteNote,
} from '@/components/OracleRegistry/viewModel'
import {
  decodeColours,
  encodeColours,
  type AssetSummary,
  type CardView,
  type ChangeItem,
} from '@/lib/oracleRegistry/apiTypes'
import type { Colour } from '@/lib/oracleRegistry/types'

const MINUS = '−'

function card(p: Partial<CardView> & { id: string }): CardView {
  return {
    asset: 'ETH',
    provider: 'chainlink',
    class: 'market',
    role: 'member',
    colour: 'green',
    reason: 'within_band',
    tone: 'outlier',
    price: 2716,
    quoteUnit: 'USD',
    usd: 2716,
    derived: false,
    deviationBps: 1.2,
    bandBps: 50,
    freshness: { state: 'fresh', ageSeconds: 600, limitSeconds: 4200, basis: 'heartbeat' },
    countedInConsensus: true,
    warnings: [],
    label: p.id,
    address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    readMethod: 'latestRoundData()',
    decimals: 8,
    consensusNote: '',
    mechanism: {
      source: 'DON',
      aggregation: 'median of nodes',
      updateModel: 'push_deviation_heartbeat',
      heartbeatSeconds: 3600,
      deviationThresholdBps: 50,
      governance: [],
      components: [],
    },
    usedBy: [],
    docsUrl: 'https://data.chain.link',
    historyPlanned: 'chainlink_rounds',
    history: null,
    onchain: {},
    extras: {},
    changeIds: [],
    ...p,
  }
}

// ---- formatting --------------------------------------------------------------------------

describe('number formatting', () => {
  it('resolves about one bp of the price at every magnitude', () => {
    expect(fmtUsd(86084.4)).toBe('$86,084')
    expect(fmtUsd(2716.123)).toBe('$2,716.12')
    expect(fmtUsd(1.25084)).toBe('$1.2508')
    expect(fmtUsd(0.999731)).toBe('$0.99973')
    expect(fmtUsd(null)).toBe('—')
    expect(fmtUsd(Number.NaN)).toBe('—')
    expect(priceDecimals(1e4)).toBe(0)
    expect(priceDecimals(9.99)).toBe(4)
    expect(priceDecimals(0.001)).toBe(8)
  })

  it('signs bps with a true minus, one decimal under 10, grouped above 1,000', () => {
    expect(fmtBps(4.24)).toBe('+4.2 bps')
    expect(fmtBps(-66.4)).toBe(`${MINUS}66 bps`)
    expect(fmtBps(-2678.9)).toBe(`${MINUS}2,679 bps`)
    expect(fmtBps(0.04)).toBe('0 bps')
    expect(fmtBps(-0.04)).toBe('0 bps')
    expect(fmtBps(null)).toBe('— bps')
  })

  it('formats ratios, compact sizes and durations', () => {
    expect(fmtRatio(1.10461234)).toBe('1.10461')
    expect(fmtRatio(31.68449)).toBe('31.6845')
    expect(fmtRatio(-0.5)).toBe(`${MINUS}0.5`)
    expect(fmtCompactUsd(119_400_000)).toBe('$119M')
    expect(fmtCompactUsd(940_000)).toBe('$940k')
    expect(fmtCompactUsd(1_250_000_000)).toBe('$1.25B')
    expect(fmtDuration(45)).toBe('45s')
    expect(fmtDuration(21 * 60 + 5)).toBe('21m')
    expect(fmtDuration(3 * 3600 + 12 * 60)).toBe('3h 12m')
    expect(fmtDuration(3600)).toBe('1h')
    expect(fmtDuration(19 * 86400 + 4 * 3600)).toBe('19d 4h')
    expect(fmtDuration(244 * 86400 + 4 * 3600)).toBe('244d')
    expect(fmtDuration(-1)).toBe('—')
  })

  it('prints times in UTC and shortens addresses', () => {
    expect(fmtUtc(1791206231)).toBe('2026-10-05 13:17 UTC')
    expect(fmtShortUtc(1791206231)).toBe('Oct 05 13:17')
    expect(shortAddr('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419')).toBe('0x5f4e…8419')
    expect(shortAddr('pyth')).toBe('pyth')
    expect(ageAt(100, 90)).toBe(0)
    expect(ageAt(100, 160)).toBe(60)
  })
})

// ---- colour vocabulary -------------------------------------------------------------------

describe('colour vocabulary', () => {
  it('gives every state its own glyph, so state never rests on colour alone', () => {
    const glyphs = COLOUR_ORDER.map((c) => COLOUR_META[c].glyph)
    expect(glyphs).toEqual(['●', '▼', '▲', '░', '×'])
    expect(new Set(glyphs).size).toBe(COLOUR_ORDER.length)
  })

  it('words basis cards against the market, outlier cards against consensus', () => {
    expect(colourLabel('gold', 'outlier')).toBe('above consensus')
    expect(colourLabel('gold', 'basis')).toBe('above market')
    expect(colourLabel('red', 'basis')).toBe('below market')
    expect(colourLabel('green', 'basis')).toBe('at market')
    expect(colourLabel('stale', 'basis')).toBe('stale')
  })

  it('round-trips the history colour codec', () => {
    const cs: Colour[] = ['green', 'red', 'gold', 'stale', 'unavailable', 'green']
    expect(encodeColours(cs)).toBe('grosxg')
    expect(decodeColours(encodeColours(cs))).toEqual(cs)
    expect(decodeColours('?')).toEqual(['unavailable'])
  })
})

// ---- card lines --------------------------------------------------------------------------

describe('card lines', () => {
  it('shows the native quote and its conversion for derived feeds', () => {
    const c = card({
      id: 'weeth',
      quoteUnit: 'ETH',
      price: 1.10461,
      conversion: { asset: 'ETH', rate: 2716.12 },
    })
    expect(nativeLine(c)).toBe('1.10461 ETH × $2,716.12')
    expect(
      nativeLine(card({ id: 'twap', quoteUnit: 'underlying', quoteAsset: 'USDe', price: 0.99746 })),
    ).toBe('0.99746 USDe')
    expect(nativeLine(card({ id: 'usdt', pegAssumed: 'USDT' }))).toBe('quoted in USDT · USDT = $1')
    expect(nativeLine(card({ id: 'plain' }))).toBeNull()
    expect(nativeLine(card({ id: 'none', price: null }))).toBeNull()
  })

  it('states age and the limit that applies to it', () => {
    expect(freshnessLine(card({ id: 'a' }))).toEqual({ age: '10m', limit: 'HB 1h' })
    const twap = card({
      id: 't',
      freshness: { state: 'live', ageSeconds: null, limitSeconds: null, basis: 'live' },
      mechanism: { ...card({ id: 'x' }).mechanism, updateModel: 'twap', twapWindowSeconds: 1800 },
    })
    expect(freshnessLine(twap)).toEqual({ age: 'live', limit: 'TWAP 30m' })
    const pyth = card({
      id: 'p',
      freshness: { state: 'stale', ageSeconds: 244 * 86400, limitSeconds: 3600, basis: 'pull' },
    })
    expect(freshnessLine(pyth)).toEqual({ age: '244d', limit: 'pull ≤1h' })
    const view = card({
      id: 'v',
      freshness: { state: 'fresh', ageSeconds: 120, limitSeconds: 4200, basis: 'components' },
    })
    expect(freshnessLine(view).age).toBe('2m (inputs)')
    const chronicle = card({
      id: 'c',
      freshness: { state: 'fresh', ageSeconds: 7200, limitSeconds: 90000, basis: 'age_only' },
      mechanism: { ...card({ id: 'x' }).mechanism, heartbeatSeconds: null },
    })
    expect(freshnessLine(chronicle).limit).toBe('no HB · ≤1d 1h')
  })

  it('reports out-of-band time in hours from the full-resolution replay', () => {
    expect(
      historyStat({
        total: 720,
        evaluable: 700,
        outOfBand: 270,
        stale: 0,
        worst: { bps: 181.9, ts: 0 },
        stepSeconds: 3600,
      }),
    ).toEqual({ out: '270/700h', max: '+182 bps', measured: true })
    expect(
      historyStat({
        total: 1,
        evaluable: 0,
        outOfBand: 0,
        stale: 1,
        worst: null,
        stepSeconds: 3600,
      }).max,
    ).toBe('— bps')
  })

  it('never reads "0/720h" for a card that was never measured (all stale / no consensus)', () => {
    const never = historyStat({
      total: 720,
      evaluable: 0,
      outOfBand: 0,
      stale: 720,
      worst: null,
      stepSeconds: 3600,
    })
    expect(never).toEqual({ out: 'not measured', max: '— bps', measured: false })
    // Three measurable hours out of 720: the denominator is the three.
    expect(
      historyStat({
        total: 720,
        evaluable: 3,
        outOfBand: 0,
        stale: 717,
        worst: { bps: 37, ts: 0 },
        stepSeconds: 3600,
      }),
    ).toEqual({ out: '0/3h', max: '+37 bps', measured: true })
  })

  it('drops the provider from a label that the eyebrow already names', () => {
    expect(displayLabel({ provider: 'chainlink', label: 'Chainlink cbBTC / USD' })).toBe(
      'cbBTC / USD',
    )
    expect(
      displayLabel({ provider: 'uniswap_v3', label: 'Uniswap v3 WETH/USDC 5 bp — 30 min TWAP' }),
    ).toBe('WETH/USDC 5 bp — 30 min TWAP')
    expect(displayLabel({ provider: 'redstone', label: 'REDSTONE · weETH/ETH' })).toBe('weETH/ETH')
    expect(displayLabel({ provider: 'aave', label: 'Spark-style label' })).toBe('Spark-style label')
    expect(displayLabel({ provider: 'pyth', label: 'Pyth' })).toBe('Pyth')
    expect(describeCard(card({ id: 'x', label: 'Chainlink ETH / USD' }))).toMatch(
      /^Chainlink, ETH \/ USD, /,
    )
  })

  it('describes a card in one spoken sentence', () => {
    const s = describeCard(
      card({ id: 'cb', label: 'cbBTC / USD', colour: 'red', deviationBps: -66.4, usd: 85316 }),
    )
    expect(s).toBe(
      'Chainlink, cbBTC / USD, $85,316, minus 66 bps versus consensus, below consensus, market',
    )
    const basis = describeCard(
      card({ id: 'b', tone: 'basis', class: 'capped_exchange_rate', deviationBps: 12 }),
    )
    expect(basis).toContain('versus market')
    expect(basis).toContain(CLASS_LABEL.capped_exchange_rate)
  })

  it('summarises a market that reads the feed', () => {
    expect(
      usedByLine({ protocol: 'Morpho', market: 'wstETH/USDT', kind: 'direct', borrowUsd: 119e6 }),
    ).toBe('Morpho · wstETH/USDT · $119M borrowed')
    expect(usedByLine({ protocol: 'Aave', market: 'Core', kind: 'component' })).toBe(
      'Aave · Core · via component',
    )
  })
})

// ---- vote + last update ------------------------------------------------------------------

describe('consensus facts', () => {
  const consensus = {
    status: 'ok' as const,
    excluded: [
      { id: 'pyth', reason: 'stale' as const },
      { id: 'nots', reason: 'unknown_freshness' as const },
    ],
  }

  it('explains a non-voting member from the consensus exclusion list, not its colour', () => {
    // The reason comes from the exclusion list, whatever the card's colour says.
    const nots = card({ id: 'nots', countedInConsensus: false, colour: 'unavailable' })
    expect(voteNote(nots, consensus)).toBe('no timestamp')
    expect(voteNote(card({ id: 'pyth', countedInConsensus: false }), consensus)).toBe('stale')
    expect(voteNote(card({ id: 'ok' }), consensus)).toBeNull()
    expect(
      voteNote(card({ id: 'alt', role: 'alternate', countedInConsensus: false }), consensus),
    ).toBeNull()
    expect(
      voteNote(card({ id: 'pt', countedInConsensus: false }), {
        status: 'insufficient',
        excluded: [],
      }),
    ).toBe('no consensus formed')
    expect(
      voteNote(card({ id: 'cl', countedInConsensus: false }), {
        status: 'insufficient',
        reason: 'members_disagree',
        excluded: [],
      }),
    ).toBe('two feeds disagree, no majority')
  })

  it('takes the last update from the youngest counted member', () => {
    const cards = [
      card({
        id: 'a',
        freshness: { state: 'fresh', ageSeconds: 900, limitSeconds: 1, basis: 'heartbeat' },
      }),
      card({
        id: 'b',
        freshness: { state: 'fresh', ageSeconds: 120, limitSeconds: 1, basis: 'heartbeat' },
      }),
      // Not counted: ignored even though younger.
      card({
        id: 'c',
        countedInConsensus: false,
        freshness: { state: 'fresh', ageSeconds: 5, limitSeconds: 1, basis: 'heartbeat' },
      }),
      // Live TWAP: no update clock.
      card({
        id: 'd',
        freshness: { state: 'live', ageSeconds: null, limitSeconds: null, basis: 'live' },
      }),
    ]
    expect(lastFeedUpdate(cards, 10_000)).toBe(10_000 - 120)
    expect(lastFeedUpdate([cards[3]], 10_000)).toBeNull()
    expect(lastFeedUpdate(cards, null)).toBeNull()
  })
})

// ---- grouping, filters, tabs -------------------------------------------------------------

describe('grouping and tabs', () => {
  const cards = [
    card({ id: 'm1' }),
    card({ id: 'b1', role: 'basis', tone: 'basis', colour: 'gold' }),
    card({ id: 'd1', role: 'derived', colour: 'red' }),
    card({ id: 'a1', role: 'alternate', colour: 'stale' }),
    card({ id: 'm2', colour: 'red' }),
  ]

  it('splits voters, compared feeds and basis feeds, keeping order and dropping empty groups', () => {
    const g = groupCards(cards)
    expect(g.map((x) => x.key)).toEqual(['member', 'compared', 'basis'])
    expect(g[0].cards.map((c) => c.id)).toEqual(['m1', 'm2'])
    expect(g[1].cards.map((c) => c.id)).toEqual(['d1', 'a1'])
    expect(groupCards([cards[1]]).map((x) => x.key)).toEqual(['basis'])
    expect(groupCards([])).toEqual([])
  })

  it('counts and filters by state', () => {
    // b1 is a basis card whose gold is a structural gap, not "above consensus".
    expect(colourCountsOf(cards)).toEqual({ green: 1, red: 2, gold: 0, stale: 1, unavailable: 0 })
    expect(filterCards(cards, 'red').map((c) => c.id)).toEqual(['d1', 'm2'])
    expect(filterCards(cards, 'gold')).toEqual([])
    expect(filterCards(cards, null)).toHaveLength(5)
  })

  it('tallies basis cards above / below market apart from the outlier counts, and filters them', () => {
    const mixed = [
      ...cards,
      card({ id: 'b2', role: 'basis', tone: 'basis', colour: 'gold' }),
      card({ id: 'b3', role: 'basis', tone: 'basis', colour: 'red' }),
      card({ id: 'b4', role: 'basis', tone: 'basis', colour: 'green' }),
      card({ id: 'b5', role: 'basis', tone: 'basis', colour: 'stale' }),
    ]
    // The header that read "▲ 0 above consensus" over visible gold basis cards now says so.
    const counts = colourCountsOf(mixed)
    expect(counts.gold).toBe(0)
    expect(basisTallyOf(mixed)).toEqual({ basis_above: 2, basis_below: 1 })
    expect(basisTallyLine(basisTallyOf(mixed))).toBe('basis: 2 above market / 1 below market')
    // Every card is in exactly one bucket: a counted colour, a basis side, or neither
    // (never both) — green / stale basis cards stay under their colour, not in the tally.
    const tallied = Object.values(basisTallyOf(mixed)).reduce((a, b) => a + b, 0)
    const counted = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(counted + tallied).toBe(mixed.length)
    expect(filterCards(mixed, 'basis_above').map((c) => c.id)).toEqual(['b1', 'b2'])
    expect(filterCards(mixed, 'basis_below').map((c) => c.id)).toEqual(['b3'])
    expect(filterCards(mixed, 'green').map((c) => c.id)).toEqual(['m1', 'b4'])
    expect(filterCards(mixed, 'stale').map((c) => c.id)).toEqual(['a1', 'b5'])
    // An outlier-tone red card is never a basis card.
    expect(basisSide({ colour: 'red', tone: 'outlier' })).toBeNull()
    expect(basisTallyOf([])).toEqual({ basis_above: 0, basis_below: 0 })
  })

  it('marks a tab with outlier counts, a calm dot, or × without consensus', () => {
    const base: Pick<AssetSummary, 'symbol' | 'kind' | 'counts' | 'consensus'> = {
      symbol: 'cbBTC',
      kind: 'mvp',
      counts: { green: 7, red: 2, gold: 0, stale: 1, unavailable: 0 },
      consensus: { status: 'ok', price: 1, members: 4, spreadBps: 10, referenceUsd: null },
    }
    expect(tabMarks(base)).toEqual([{ glyph: '▼', count: 2, colour: 'red' }])
    expect(tabLabel(base)).toBe('cbBTC: 2 below consensus, 1 stale')
    const calm = { ...base, counts: { green: 5, red: 0, gold: 0, stale: 0, unavailable: 0 } }
    expect(tabMarks(calm)).toEqual([{ glyph: '●', count: null, colour: 'green' }])
    expect(tabLabel({ ...calm, kind: 'reference', symbol: 'BTC' })).toBe(
      'BTC (reference): all within band',
    )
    const none = { ...base, consensus: { ...base.consensus, status: 'insufficient' as const } }
    expect(tabMarks(none)).toEqual([{ glyph: '×', count: null, colour: 'unavailable' }])
    expect(tabLabel(none)).toBe('cbBTC: no consensus, 1 stale')
  })

  it('lists the bands and the changes that name a card', () => {
    const bands = bandsLine({ stable: 25, major: 50, lst_lrt: 75, fixed_income: 50 })
    expect(bands).toContain(
      'Class bands: ±25 bps stables, ±50 bps majors, ±75 bps LST/LRT, ±50 bps PTs.',
    )
    // The rule (owner ruling 2026-10-05): stables only, max(class band, d1 + d2).
    expect(bands).toContain('Majors, LST/LRT and PTs use their class band only')
    expect(bands).toContain(
      "A stablecoin's band is the wider of its class band and d1 + d2, the two largest deviation thresholds its consensus members declare",
    )
    expect(bands).toContain('TWAPs, Chronicle, pull oracles — add nothing')
    // Honest feeds can sit the SUM of their triggers apart (50 + 20 = 70 bps > 2 × 25).
    const gap = honestGapLine({ stable: 25 })
    expect(gap).toContain('up to the sum of their deviation thresholds apart')
    expect(gap).toContain('Chainlink 0.5% + RedStone 0.2% ⇒ up to 70 bps')
    expect(gap).toContain('±25 bps stable class band')
    expect(gap).toContain('The band widens to that sum')
    expect(gap).toContain('"feeds disagree"')
    // The header: where the band came from.
    expect(bandLabel({ bandBps: 70, classBandBps: 25, thresholdsBps: [50, 20] })).toBe(
      '±70 bps (feed thresholds 50+20; class 25)',
    )
    expect(bandLabel({ bandBps: 250, classBandBps: 50, thresholdsBps: [200, 50] })).toBe(
      '±250 bps (feed thresholds 200+50; class 50)',
    )
    expect(bandLabel({ bandBps: 50, classBandBps: 25, thresholdsBps: [50] })).toBe(
      '±50 bps (feed threshold 50; class 25)',
    )
    expect(bandLabel({ bandBps: 75, classBandBps: 75, thresholdsBps: [20, 20] })).toBe(
      '±75 bps (class band; feed thresholds 20+20)',
    )
    expect(bandLabel({ bandBps: 25, classBandBps: 25, thresholdsBps: [] })).toBe(
      '±25 bps (class band)',
    )
    const ch = (id: string) => ({ id }) as ChangeItem
    expect(
      changesForCard([ch('x'), ch('y'), ch('z')], card({ id: 'k', changeIds: ['z', 'x'] })).map(
        (c) => c.id,
      ),
    ).toEqual(['x', 'z'])
  })
})

// ---- geometry ----------------------------------------------------------------------------

describe('sparkline geometry', () => {
  it('spans every finite value and pads a flat series so it draws mid-height', () => {
    expect(
      seriesDomain([
        [1, null, 3],
        [2, Number.NaN],
      ]),
    ).toEqual([1, 3])
    expect(seriesDomain([[null], []])).toBeNull()
    const [lo, hi] = seriesDomain([[100, 100]])!
    expect(lo).toBeLessThan(100)
    expect(hi).toBeGreaterThan(100)
    expect((lo + hi) / 2).toBeCloseTo(100, 9)
  })

  it('breaks the line at a gap instead of interpolating across it', () => {
    const d = linePath([1, 2, null, 4], [1, 4], 30, 10, 0)
    expect(d).toBe('M0.0 10.0L10.0 6.7M30.0 0.0')
    expect(linePath([], [0, 1], 10, 10)).toBe('')
    expect(linePath([5], [4, 6], 10, 10, 0)).toBe('M5.0 5.0')
  })

  it('draws the feed and the consensus on one shared scale', () => {
    const g = sparkGeometry([100, 110], [90, 100], 10, 10)
    expect(g.min).toBe(90)
    expect(g.max).toBe(110)
    expect(g.entryPath.startsWith('M')).toBe(true)
    expect(g.consensusPath.startsWith('M')).toBe(true)
    expect(sparkGeometry([null], [], 10, 10)).toEqual({
      entryPath: '',
      consensusPath: '',
      min: null,
      max: null,
    })
    expect(sparkGeometry([1, 2], [], 10, 10).consensusPath).toBe('')
  })

  it('puts direction in the strip shape: gold up, red down, green centre, stale full', () => {
    const cells = stripCells('ogrsx', 50, 8)
    expect(cells).toEqual([
      { x: 0, w: 10, y: 0, h: 4, colour: 'gold' },
      { x: 10, w: 10, y: 3.2, h: 1.6, colour: 'green' },
      { x: 20, w: 10, y: 4, h: 4, colour: 'red' },
      { x: 30, w: 10, y: 0, h: 8, colour: 'stale' },
    ])
    expect(stripCells('', 50, 8)).toEqual([])
  })

  it('merges runs of one state into one rectangle', () => {
    expect(stripCells('ggggrrgg', 80, 8)).toEqual([
      { x: 0, w: 40, y: 3.2, h: 1.6, colour: 'green' },
      { x: 40, w: 20, y: 4, h: 4, colour: 'red' },
      { x: 60, w: 20, y: 3.2, h: 1.6, colour: 'green' },
    ])
    expect(stripCells('g'.repeat(240), 240, 8)).toHaveLength(1)
    expect(stripCells('xxsx', 40, 8)).toEqual([{ x: 20, w: 10, y: 0, h: 8, colour: 'stale' }])
  })

  it('maps a pointer to the nearest sample and clamps at the edges', () => {
    expect(indexAt(0, 240, 240)).toBe(0)
    expect(indexAt(240, 240, 240)).toBe(239)
    expect(indexAt(120, 240, 241)).toBe(120)
    expect(indexAt(-5, 240, 10)).toBe(0)
    expect(indexAt(999, 240, 10)).toBe(9)
    expect(indexAt(50, 240, 1)).toBe(0)
  })
})

describe('basis bar', () => {
  it('centres the market, shades the band, and always keeps the marker on the bar', () => {
    const small = basisBar(10, 50)
    expect(small.scale).toBe(150)
    expect(small.bandLeftPct).toBeCloseTo(50 - (50 / 150) * 50, 9)
    expect(small.bandWidthPct).toBeCloseTo((50 / 150) * 100, 9)
    expect(small.markerPct).toBeCloseTo(50 + (10 / 150) * 50, 9)
    for (const bps of [-5000, -400, 0, 75, 2600]) {
      const b = basisBar(bps, 75)
      expect(b.markerPct).toBeGreaterThanOrEqual(0)
      expect(b.markerPct).toBeLessThanOrEqual(100)
      expect(b.scale).toBeGreaterThanOrEqual(Math.abs(bps))
    }
    expect(basisBar(0, 0).scale).toBe(1)
  })
})
