/**
 * LIQUIDITY-CAPPED SALES (owner ruling 2026-10-18): the capacity model of lib/wavefront/
 * liquidity.ts and the kernel's pending orders (lib/wavefront/kernel.ts PENDING ORDERS).
 *
 *   - the capacity table: the most tokens that left borrowers in any rolling 10 minutes,
 *     exact on raw amounts, the protocol fee in, the liquidators' part beside it;
 *   - the window accounting: a fill at minute m counts against minutes m .. m+9;
 *   - the shared queue: two positions on one token, the earlier pid first, the second gets
 *     what is left and its remainder fills when the window frees;
 *   - leftover carry: the remainder sells at the LATER minute's price (more tokens when the
 *     price fell), never past the borrow cap, and is cancelled when the price recovers;
 *   - a multi-leg sale splits pro rata by value and each leg fills against its own window;
 *   - a token with no capacity: never invented — the census leaves the position out;
 *   - the 1.1x multiplier, and unlimited (every offer fills, the uncapped walk bit for bit);
 *   - the whale (284k AAVE): Membrane at Aave's line, capped at 1.1x vs unlimited.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { MembraneKernel, type KernelLeg, type KernelSpec } from '@/lib/wavefront/kernel'
import {
  CAPACITY_MULTIPLIER,
  CAPACITY_WINDOW_MINUTES,
  LiquidityBook,
  RESEARCH_FLOW_READING_MULTIPLIER,
  computeCapacity,
  researchClassMultiplier,
  liqKeyOf,
  type CapacityEvent,
} from '@/lib/wavefront/liquidity'
import { buildCensus, type CensusInputs } from '@/scripts/oct10-coverage/census'
import { unrle } from '@/scripts/oct10-coverage/make-census-fixture'

const KEY = liqKeyOf('mainnet', '0xToken')
const KEY2 = liqKeyOf('mainnet', '0xOther')

describe('capacity table', () => {
  const ev = (minute: number, borrower: bigint, fee = 0n, token = '0xToken'): CapacityEvent => ({
    chain: 'mainnet',
    token,
    symbol: 'TKN',
    decimals: 18,
    minute,
    liquidatorRaw: borrower - fee,
    borrowerRaw: borrower,
    usd: Number(borrower / 10n ** 18n) * 2,
  })
  const E18 = 10n ** 18n

  it('is the most tokens that left borrowers in any rolling 10 minutes, fee included', () => {
    const t = computeCapacity(
      [
        ev(0, 5n * E18, 1n * E18),
        ev(9, 4n * E18),
        ev(10, 3n * E18), // minutes 1..10 = 7; minutes 0..9 = 9 (the peak)
        ev(30, 8n * E18), // alone, 8 < 9
      ],
      60,
    )
    expect(t).toHaveLength(1)
    const c = t[0]
    expect(c.key).toBe(KEY.toLowerCase())
    expect(c.capacityTokens).toBe(9)
    expect(c.peakEndMinute).toBe(9)
    expect(c.liquidatorTokensAtPeak).toBe(8) // the 1-token fee is not the liquidators'
    expect(c.liquidatorCapacityTokens).toBe(8)
    expect(c.totalTokens).toBe(20)
    expect(c.events).toBe(4)
    expect(c.peakUsd).toBe(18)
  })

  it('keys by chain and token, sorted, and refuses an event off the grid', () => {
    const t = computeCapacity([ev(1, E18, 0n, '0xB'), ev(1, E18, 0n, '0xA')], 10)
    expect(t.map((c) => c.key)).toEqual(['mainnet:0xa', 'mainnet:0xb'])
    expect(() => computeCapacity([ev(10, E18)], 10)).toThrow(/outside the grid/)
  })
})

describe('the shared book', () => {
  it('counts a fill against the trailing 10-minute window, minute by minute', () => {
    const b = new LiquidityBook(new Map([[KEY, 100]]), 1, 60)
    expect(b.take(0, [{ liqKey: KEY, tokens: 60 }])).toEqual([60])
    expect(b.take(5, [{ liqKey: KEY, tokens: 60 }])).toEqual([40]) // 60 + 40 = the cap
    expect(b.available(KEY, 9)).toBe(0)
    expect(b.take(9, [{ liqKey: KEY, tokens: 1 }])).toEqual([0])
    // minute 0 leaves the window at minute 10: what it filled is available again
    expect(b.available(KEY, 10)).toBe(60)
    expect(b.available(KEY, 15)).toBe(100) // minute 5 leaves it at 15
    expect(CAPACITY_WINDOW_MINUTES).toBe(10)
    expect(b.shortOffers.get(KEY)).toBe(2)
  })

  it('applies the multiplier: 1.1x capacity, and unlimited fills everything', () => {
    expect(CAPACITY_MULTIPLIER).toBe(1.1)
    const b = new LiquidityBook(new Map([[KEY, 100]]), CAPACITY_MULTIPLIER, 60)
    expect(b.limitOf(KEY)).toBeCloseTo(110, 12)
    expect(b.take(0, [{ liqKey: KEY, tokens: 120 }])[0]).toBeCloseTo(110, 12)
    const u = new LiquidityBook(new Map([[KEY, 100]]), Infinity, 60)
    expect(u.take(0, [{ liqKey: KEY, tokens: 1e12 }])).toEqual([1e12])
    expect(u.take(0, [{ liqKey: KEY, tokens: 1e12 }])).toEqual([1e12])
  })

  it('takes a multiplier per key: the research per-class table', () => {
    expect(researchClassMultiplier('WETH')).toBe(0.7)
    expect(researchClassMultiplier('wstETH')).toBe(0.7)
    expect(researchClassMultiplier('cbBTC')).toBe(0.55)
    expect(researchClassMultiplier('LBTC')).toBe(0.55)
    expect(researchClassMultiplier('AAVE')).toBe(0.75)
    expect(researchClassMultiplier('USDC')).toBe(0.75)
    expect(RESEARCH_FLOW_READING_MULTIPLIER).toBe(0.2)
    const b = new LiquidityBook(
      new Map([
        [KEY, 100],
        [KEY2, 100],
      ]),
      (k) => (k === KEY ? 0.7 : 0.55),
      60,
    )
    expect(b.take(0, [{ liqKey: KEY, tokens: 1000 }])[0]).toBeCloseTo(70, 12)
    expect(b.take(0, [{ liqKey: KEY2, tokens: 1000 }])[0]).toBeCloseTo(55, 12)
  })

  it('has no capacity for a token nobody liquidated, and invents none', () => {
    const b = new LiquidityBook(new Map([[KEY, 100]]), Infinity, 60)
    expect(b.hasCapacity(KEY2)).toBe(false)
    expect(b.limitOf(KEY2)).toBe(0)
    expect(b.take(0, [{ liqKey: KEY2, tokens: 1 }])).toEqual([0])
  })
})

// ---- kernel harness: a USD position on one or two collateral legs, no-delay (sold at the line)
const leg = (key: string, value0: number, tokens0: number, liqKey: string): KernelLeg => ({
  key,
  symbol: key,
  value0,
  tokens0,
  liqKey,
})
const spec = (pid: string, over: Partial<KernelSpec>): KernelSpec => ({
  pid,
  collateral: [leg('c', 1000, 10, KEY)],
  debt: [{ key: '', symbol: 'USDC', value0: 900 }],
  line: 0.8,
  noDelay: true,
  band: 0.04,
  delaySteps: 480,
  gap: 0.03,
  debtMinimum: 0,
  maxSales: 20,
  t0Minute: 0,
  t0Ts: 1000,
  startTs: 1000,
  stepSeconds: 60,
  lastMinute: 59,
  ...over,
})
/** Walk kernels minute-major, in the order given (the census's pid order). */
function walk(ks: MembraneKernel[], ratio: (leg: KernelLeg, m: number) => number, to = 59) {
  const recs = ks.map((k) => [...k.start()])
  for (let m = 1; m <= to; m++) {
    ks.forEach((k, i) => {
      // the debt leg (USDC, key '') never moves; collateral legs follow `ratio`
      if (!k.isDone) recs[i].push(...k.step(m, (l) => (l.key ? ratio(l, m) : 1)))
    })
  }
  ks.forEach((k, i) => recs[i].push(...k.finish()))
  return recs
}
const sold = (rs: { event: string; repaidUsd: number | null }[]) =>
  rs.filter((r) => r.event.startsWith('sell')).reduce((a, r) => a + (r.repaidUsd ?? 0), 0)
// The repay to cap at t0 for 900 debt on 1000 collateral, cap 0.77 (membraneRepayValue).
const REPAY0 = (((0.9 - 0.77) / 0.9) * 900) / (1 - 0.77)

describe('pending orders', () => {
  it('unlimited is the uncapped walk, record for record', () => {
    const path = (_l: KernelLeg, m: number) => (m < 20 ? 1 - m * 0.005 : 0.9)
    const a = walk([new MembraneKernel(spec('a', {}))], path)[0]
    const book = new LiquidityBook(new Map([[KEY, 1]]), Infinity, 60)
    const b = walk([new MembraneKernel(spec('a', { liquidity: book }))], path)[0]
    expect(b).toEqual(a)
  })

  it('shares one window across two positions: the earlier pid first, the other waits', () => {
    // capacity 8 tokens / 10 min. Each position wants REPAY0 / $100 = 5.65 tokens at t0.
    const book = new LiquidityBook(new Map([[KEY, 8]]), 1, 60)
    const A = new MembraneKernel(spec('a', { liquidity: book }))
    const B = new MembraneKernel(spec('b', { liquidity: book }))
    const [ra, rb] = walk([A, B], () => 1, 12)
    expect(ra[0].repaidUsd).toBeCloseTo(REPAY0, 2) // A fills whole
    expect(ra[0].unfilledUsd).toBeUndefined()
    expect(rb[0].repaidUsd).toBeCloseTo((8 - REPAY0 / 100) * 100, 2) // B gets what is left
    expect(rb[0].unfilledUsd).toBeCloseTo(REPAY0 - (8 - REPAY0 / 100) * 100, 2)
    // nothing frees until minute 10, when minute 0's fills leave the window
    const carry = rb.filter((r) => r.carry)
    expect(carry).toHaveLength(1)
    expect(carry[0].minute).toBe(10)
    expect(carry[0].event).toBe(rb[0].event) // the sale's own event and why
    expect(carry[0].why).toBe(rb[0].why)
    expect(sold(rb)).toBeCloseTo(REPAY0, 2) // the order completes, nothing lost
    expect(B.result().sales).toBe(1) // a carried fill is not a new sale
    expect(B.result().carryFills).toBe(1)
    expect(B.result().shortSales).toBe(1)
  })

  it('carries the remainder at the LATER price, more tokens when it fell', () => {
    const book = new LiquidityBook(new Map([[KEY, 3]]), 1, 60)
    const K = new MembraneKernel(spec('a', { liquidity: book }))
    const [r] = walk([K], (_l, m) => (m >= 10 ? 0.9 : 1), 10)
    expect(r[0].repaidUsd).toBeCloseTo(300, 9) // 3 tokens at $100
    const pending = REPAY0 - 300
    const carry = r.find((x) => x.carry)!
    expect(carry.minute).toBe(10)
    // the remainder in DEBT is unchanged; at $90 it takes pending / 90 tokens (< the 3 free)
    expect(carry.repaidUsd).toBeCloseTo(pending, 2)
    expect(book.filled.get(KEY)).toBeCloseTo(3 + pending / 90, 9)
    expect(K.result().unfilledAtGridEnd).toBe(0)
  })

  it('cancels the remainder when the price recovers above the borrow cap', () => {
    const book = new LiquidityBook(new Map([[KEY, 3]]), 1, 60)
    const K = new MembraneKernel(spec('a', { liquidity: book }))
    // after the 300 repay: debt 600 on 7 tokens; at $120 the LTV is 0.714 < the 0.77 cap
    const [r] = walk([K], (_l, m) => (m >= 10 ? 1.2 : 1), 20)
    expect(r.filter((x) => x.carry)).toHaveLength(0)
    expect(sold(r)).toBeCloseTo(300, 9)
    expect(K.result().pendingCancelled).toBe(1)
    expect(K.result().closedT0).toBeCloseTo(300, 9)
  })

  it('reports a remainder still pending at the grid end as unfilled, never sold', () => {
    const book = new LiquidityBook(new Map([[KEY, 3]]), 1, 60)
    const K = new MembraneKernel(spec('a', { liquidity: book, lastMinute: 5 }))
    const [r] = walk([K], () => 1, 5)
    expect(sold(r)).toBeCloseTo(300, 9)
    expect(K.result().unfilledAtGridEnd).toBeCloseTo(REPAY0 - 300, 9)
    expect(K.result().unfilledAtGridEndUsd).toBeCloseTo(REPAY0 - 300, 2)
  })

  it('splits a multi-leg sale pro rata by value; each leg fills on its own window', () => {
    // two legs of $500 each (5 tokens at $100 each); the second leg's token has 1 token / 10 min
    const book = new LiquidityBook(
      new Map([
        [KEY, 100],
        [KEY2, 1],
      ]),
      1,
      60,
    )
    const K = new MembraneKernel(
      spec('a', {
        collateral: [leg('c1', 500, 5, KEY), leg('c2', 500, 5, KEY2)],
        liquidity: book,
      }),
    )
    const [r] = walk([K], () => 1, 0)
    const q = REPAY0 / 1000 // the same fraction of every leg
    // leg 1 fills 5q tokens, leg 2 only 1: the value filled is (5q + 1) x $100
    expect(r[0].repaidUsd).toBeCloseTo((5 * q + 1) * 100, 6)
    expect(book.filled.get(KEY)).toBeCloseTo(5 * q, 12)
    expect(book.filled.get(KEY2)).toBeCloseTo(1, 12)
  })
})

// ---- the census on the committed fixture: no capacity, and the whale ----------------------
const fx = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'wavefront-census-fixture.json'), 'utf8'),
)
const expandPrices = (p: Record<string, [string | null, number][]>) =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, unrle(v)]))
const inputs: CensusInputs = {
  window: fx.window,
  aaveCsv: fx.aaveCsv,
  aaveEvents: fx.aaveEvents,
  aaveFees: fx.aaveFees,
  aaveOracle: Object.fromEntries(
    Object.entries(fx.aaveOracle).map(([c, f]: [string, any]) => [
      c,
      { ...f, prices: expandPrices(f.prices) },
    ]),
  ),
  morphoCsv: fx.morphoCsv,
  morphoEvents: fx.morphoEvents,
  morphoOracle: Object.fromEntries(
    Object.entries(fx.morphoOracle).map(([c, f]: [string, any]) => [
      c,
      { ...f, prices: expandPrices(f.prices) },
    ]),
  ),
}
const WHALE =
  'aave-v3:mainnet:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:0x372cae7fa19b81a9786a9081704ea1e2dad576b7'
const AAVE_KEY = 'mainnet:0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9'

describe('the census, liquidity-capped (fixture)', () => {
  it('leaves out, on both sides, a position that would sell a token with no capacity', () => {
    const r0 = buildCensus(inputs, { capacity: fx.capacity, capacityMultiplier: Infinity })
    const victim = r0.rows.find((r) => r.mem && r.mem.sales > 0 && r.protocol === 'morpho-blue')!
    const ev = fx.morphoEvents.find(
      (e: any) => `morpho-blue:${e.chain}:${e.market_id}:${e.borrower}` === victim.pid,
    )
    const key = liqKeyOf(ev.chain, ev.collateralToken)
    const dry = fx.capacity.filter((c: any) => c.key !== key)
    const r1 = buildCensus(inputs, { capacity: dry, capacityMultiplier: Infinity })
    const row = r1.rows.find((r) => r.pid === victim.pid)!
    expect(row.excluded).toBe('no-capacity')
    expect(row.mem).toBeNull()
    expect(row.real.repaidUsd).toBe(victim.real.repaidUsd) // the real side stays in the row
    const open = r1.records.find((x) => x.kind === 'open' && x.pid === victim.pid) as any
    expect(open.walked).toBe(false) // out of the stream's totals, both sides
    expect(r1.records.some((x) => x.kind === 'mem' && x.pid === victim.pid)).toBe(false)
    // nobody else moves
    for (const r of r1.rows) {
      if (r.pid === victim.pid || r.excluded) continue
      expect(r.mem?.repaidUsd, r.pid).toBe(r0.rows.find((x) => x.pid === r.pid)!.mem?.repaidUsd)
    }
  })

  it('the whale: no Membrane line, so out of the headline; at Aave’s line, 1.1x vs unlimited', () => {
    const head = buildCensus(inputs, { capacity: fx.capacity })
    expect(head.rows.find((r) => r.pid === WHALE)!.excluded).toBe('no-membrane-line')
    const capped = buildCensus(inputs, { capacity: fx.capacity, lineMode: 'protocol' })
    const unl = buildCensus(inputs, {
      capacity: fx.capacity,
      lineMode: 'protocol',
      capacityMultiplier: Infinity,
    })
    const row = capped.rows.find((r) => r.pid === WHALE)!
    const c = row.mem!
    const u = unl.rows.find((r) => r.pid === WHALE)!.mem!
    // Unlimited: one repay to cap at t0, past the band — the full census's own figure.
    expect(u.repaidUsd).toBeCloseTo(29_863_534.37, 2)
    // Capped: AAVE on Ethereum allows 1.1 x the 97.6k tokens that left borrowers in the
    // busiest 10 minutes. Alone in this fixture the whale fills that whole window at its t0
    // price; then AAVE recovers above its borrow cap before the window frees and the rest is
    // cancelled. (In the full census other AAVE sales share the window: $13,097,271.37,
    // scripts/tests/wavefront-census.test.ts.)
    const aave = fx.capacity.find((x: any) => x.key === AAVE_KEY)
    expect(aave.capacityTokens).toBeCloseTo(97_556.85, 1)
    const t0Price = row.collateral[0].usd! / row.collateral[0].amount
    const window = aave.capacityTokens * CAPACITY_MULTIPLIER
    // the whale's own share is the window less what another fixture position's AAVE leg took
    // from it (that leg sells AAVE at other minutes too, so the run's total is above one window)
    expect(capped.liquidity!.byKey[AAVE_KEY].filledTokens).toBeGreaterThan(window)
    const whaleTokens = c.repaidUsd / t0Price
    expect(whaleTokens).toBeLessThanOrEqual(window + 1e-6)
    expect(whaleTokens).toBeGreaterThan(0.99 * window)
    expect(c.liquidity!.shortSales).toBe(1)
    expect(c.liquidity!.carryFills).toBe(0)
    expect(c.liquidity!.pendingCancelled).toBe(1)
    expect(c.repaidUsd).toBeLessThan(u.repaidUsd / 2)
  })
})
