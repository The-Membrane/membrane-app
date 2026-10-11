import { describe, expect, it } from 'vitest'

import {
  FLAG_DEFAULTS,
  classifyOracle,
  detectShifts,
  hasMarketFlag,
  isReportedFeed,
  marketFlagKinds,
  revertOnset,
  topBorrowerShare,
  vaultBorrowerShare,
  type ShiftContext,
} from '@/lib/curatorFeed/flags'
import type { UnitFlow } from '@/lib/curatorFeed/flows'
import { compact } from '@/lib/curatorFeed/format'
import { buildFlagsResponse, buildVaultExposure, parseFeedQuery } from '@/lib/curatorFeed/service'
import {
  SCHEMA,
  encodeFeedFile,
  parseFeedFile,
  type ExposureFile,
  type FeedFile,
} from '@/lib/curatorFeed/store'
import type { FeedAction, MarketFlags, OraclePart } from '@/lib/curatorFeed/types'

// Fixtures modelled on the 2026 msY / AZND write-offs (docs/CURATOR_ACTION_FEED.md "Flags").

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const MSY = '0x890a5122aa1da30fec4286de7904ff808f0bd74a'
const AZND = '0x52c66b5e7f8fde20843de900c5c8b4b0f23708a0'
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'
const M_MSY = '0x23a7d0ff682b323363fb8ba58327ed87001f6306e09b7fd7413bbe4698e749c8'
const M_AZND = '0xfd0d72a4f0469598b566b1bc5fe64835f828f90b1fb7d746148c086164cd4cc2'
const M_OK = '0x' + 'ab'.repeat(32)
const DELTA = '0x0bf0164d17469241b6e086da4016dcc54feaa334'
const PRIME = '0x9f39b13bb472126d6937bf25a39338e664eefa82'
const CORE = '0xf1ca44eea3a4effcb195a970a2f1d8553f76f9a1'
const ASIA = '0x35cbe8542e70fa2f7f9cdf129f19e593f4b4f560'
const OTHER = '0x' + '11'.repeat(20)
const BORROWER = '0xe38a653bab0a52a1166b4e7b78d79aa68067dc4c'
const feed1 = (address: string, description?: string): OraclePart => ({
  role: 'baseFeed1',
  address,
  description,
})

describe('flag 1: what the oracle prices from', () => {
  it('no feed and no vault → fixed (AZND/USDC: price() a constant 1.00)', () => {
    expect(classifyOracle([], USDC)).toBe('fixed')
  })
  it('only a fundamental / NAV / exchange-rate feed → reported (msY/USDC)', () => {
    expect(
      classifyOracle([feed1(OTHER, 'RedStone Price Feed for MSY_FUNDAMENTAL/USD')], USDC),
    ).toBe('reported')
    expect(classifyOracle([feed1(OTHER, 'wstETH / stETH Exchange Rate')], USDC)).toBe('reported')
    for (const d of ['Fund NAV', 'Net Asset Value', 'Redemption price', 'Proof of Reserve'])
      expect(isReportedFeed(d)).toBe(true)
    expect(isReportedFeed('ETH / USD')).toBe(false)
  })
  it('any market feed in the path → market', () => {
    expect(classifyOracle([feed1(OTHER, 'ETH / USD')], USDC)).toBe('market')
    expect(
      classifyOracle(
        [
          feed1(OTHER, 'wstETH / stETH Exchange Rate'),
          { role: 'baseFeed2', address: OTHER, description: 'STETH / USD' },
        ],
        USDC,
      ),
    ).toBe('market')
  })
  it('a vault rate into its own asset, which is the loan token → vault-rate; another asset → reported', () => {
    const vault = (asset?: string): OraclePart => ({ role: 'baseVault', address: OTHER, asset })
    expect(classifyOracle([vault(USDC)], USDC)).toBe('vault-rate')
    expect(classifyOracle([vault(MSY)], USDC)).toBe('reported')
    expect(classifyOracle([vault(undefined)], USDC)).toBe('unknown')
  })
  it('unreadable description or another oracle type → unknown, never flagged', () => {
    expect(classifyOracle([feed1(OTHER)], USDC)).toBe('unknown')
    expect(classifyOracle(null, USDC)).toBe('unknown')
  })
})

const flags = (p: Partial<MarketFlags>): MarketFlags => ({
  oracle: OTHER,
  oracleKind: 'market',
  parts: [feed1(OTHER, 'ETH / USD')],
  ...p,
})

describe('flags 2 and 4: reverting, stale, one borrower', () => {
  it('reverting wins over stale; stale needs more than staleHours', () => {
    const t = FLAG_DEFAULTS.staleHours * 3600
    expect(marketFlagKinds(flags({ staleSeconds: t }), 0)).toEqual([])
    expect(marketFlagKinds(flags({ staleSeconds: t + 1 }), 0)).toEqual(['oracle-stale'])
    expect(
      marketFlagKinds(flags({ staleSeconds: t + 1, reverting: { since: 5, sinceTs: 6 } }), 0),
    ).toEqual(['oracle-reverting'])
  })
  it('one borrower: share of borrows ≥ 50% on a market with ≥ $1M borrowed', () => {
    const b = (top: bigint, total: bigint, supply = total) => ({
      top: BORROWER,
      topAssets: top.toString(),
      totalBorrow: total.toString(),
      totalSupply: supply.toString(),
      block: 1,
    })
    expect(topBorrowerShare(flags({ borrowers: b(7n, 10n) }))).toBe(0.7)
    expect(marketFlagKinds(flags({ borrowers: b(7n, 10n) }), 2e6)).toEqual(['one-borrower'])
    expect(marketFlagKinds(flags({ borrowers: b(7n, 10n) }), 5e5)).toEqual([])
    expect(marketFlagKinds(flags({ borrowers: b(4n, 10n) }), 2e6)).toEqual([])
    // A vault with 80% in the market, the borrower owing 75% of the market's supply → 60%.
    expect(vaultBorrowerShare(0.8, flags({ borrowers: b(75n, 75n, 100n) }))).toBeCloseTo(0.6)
    expect(hasMarketFlag(flags({}), undefined)).toBe(false)
  })
})

describe('flag 2: when the current run of reverts began', () => {
  it('finds the newest onset even when the oracle also reverted early in the window', async () => {
    // Reverts before block 1,000 (feed not yet deployed), answers 1,000–49,999, reverts from 50,000.
    const calls: number[] = []
    const reverts = async (b: number) => (calls.push(b), b < 1_000 || b >= 50_000)
    expect(await revertOnset(reverts, 60_000, 0)).toEqual({ since: 50_000 })
    expect(calls.length).toBeLessThan(40)
  })
  it('reverting at every probe back to the floor → beforeWindow', async () => {
    expect(await revertOnset(async () => true, 60_000, 10_000)).toEqual({
      since: 10_000,
      beforeWindow: true,
    })
  })
  it('an onset right below the head', async () => {
    expect(await revertOnset(async (b) => b >= 59_999, 60_000, 0)).toEqual({ since: 59_999 })
  })
})

// ── flag 3: curator shifts ──────────────────────────────────────────────────────

const CURATOR: Record<string, string> = { [DELTA]: 'alpha', [PRIME]: 'alpha', [CORE]: 'alpha' }
const ctx: ShiftContext = {
  curatorOf: (v) => CURATOR[v] ?? v,
  collateralOf: (t) => (t === M_MSY ? MSY : t === M_AZND ? AZND : undefined),
  usd: (_t, amount) => amount,
}
const day = '2026-06-12'
const T = Date.parse(`${day}T00:00:00Z`) / 1000
const flow = (vault: string, out: number, inn: number, d = day): UnitFlow => ({
  day: d,
  vault,
  target: M_MSY,
  source: 'allocator',
  out,
  in: inn,
  n: 1,
})
let k = 0
const cut = (vault: string, ts: number, kind: FeedAction['kind'] = 'cap_zero'): FeedAction => ({
  id: `0x${(++k).toString(16).padStart(64, '0')}:0`,
  vault,
  protocol: 'morpho-v2',
  kind,
  scope: 'collateral',
  target: '0x' + 'cd'.repeat(32),
  collateral: [MSY],
  block: 1,
  ts,
  tx: '0x',
})
// 2026-06-12: Prime −6.19M and Core −1.50M, Delta +6.70M net; Prime and Core cap msY to 0 at 08:55.
const JUNE12 = [
  flow(DELTA, 2_300_000, 9_000_000),
  flow(PRIME, 6_191_410, 0),
  flow(CORE, 1_502_340, 0),
]
const CUTS = [cut(PRIME, T + 8 * 3600 + 55 * 60), cut(CORE, T + 8 * 3600 + 56 * 60)]

describe('flag 3: curator shift between its own vaults, then cuts', () => {
  it('finds the 2026-06-12 move: two vaults out, one in, both out-vaults cut msY', () => {
    const [s, ...rest] = detectShifts(JUNE12, CUTS, ctx)
    expect(rest).toHaveLength(0)
    expect(s).toMatchObject({ curator: 'alpha', market: M_MSY, day })
    expect(s.from.map((x) => x.vault)).toEqual([PRIME, CORE])
    expect(s.to).toEqual([{ vault: DELTA, amount: 6_700_000 }])
    expect(s.usd).toBe(6_700_000)
    expect(s.cuts.map((c) => c.vault)).toEqual([PRIME, CORE])
  })
  it('needs a cut by an out-vault on that collateral inside the window', () => {
    expect(detectShifts(JUNE12, [], ctx)).toHaveLength(0)
    expect(detectShifts(JUNE12, [cut(DELTA, T + 3600)], ctx)).toHaveLength(0)
    expect(detectShifts(JUNE12, [cut(PRIME, T - 60)], ctx)).toHaveLength(0)
    expect(
      detectShifts(JUNE12, [cut(PRIME, T + (1 + FLAG_DEFAULTS.shiftCutDays) * 86_400)], ctx),
    ).toHaveLength(0)
    expect(
      detectShifts(JUNE12, [{ ...cut(PRIME, T + 3600), collateral: [WSTETH] }], ctx),
    ).toHaveLength(0)
    expect(detectShifts(JUNE12, [cut(PRIME, T + 3600, 'writeoff')], ctx)).toHaveLength(1)
  })
  it('different curators, a different day, or a side under $1M → no shift', () => {
    const other = { ...ctx, curatorOf: (v: string) => v }
    expect(detectShifts(JUNE12, CUTS, other)).toHaveLength(0)
    expect(
      detectShifts([flow(DELTA, 0, 9e6), flow(PRIME, 6e6, 0, '2026-06-11')], CUTS, ctx),
    ).toHaveLength(0)
    expect(detectShifts([flow(DELTA, 0, 9e5), flow(PRIME, 9e5, 0)], CUTS, ctx)).toHaveLength(0)
  })
})

// ── service: view and words ─────────────────────────────────────────────────────

const feed: FeedFile = {
  meta: {
    schema: SCHEMA,
    chainId: 1,
    fromBlock: 1,
    toBlock: 26_000_000,
    fromTs: T - 60 * 86_400,
    toTs: T + 120 * 86_400,
    collectedAt: '2026-10-11T00:00:00Z',
    endpoints: [],
    logs: {
      chunks: 0,
      rechecked: 0,
      disagreements: 0,
      recovered: 0,
      emptyConfirmed: 0,
      servedBy: {},
      shortBy: {},
    },
    counts: {},
    thresholds: { largeWithdrawUsd: 1e6, exposureMinUsd: 1e5, keptSupplyDrop: 0.2 },
    sources: [],
    caveats: [],
  },
  entities: {
    tokens: {
      [USDC]: { symbol: 'USDC', decimals: 6, priceUsd: 1 },
      [MSY]: { symbol: 'msY', decimals: 18, priceUsd: 0.6 },
      [AZND]: { symbol: 'AZND', decimals: 18 },
    },
    markets: {
      [M_MSY]: {
        loan: USDC,
        collateral: MSY,
        oracle: OTHER,
        irm: OTHER,
        lltv: '860000000000000000',
      },
      [M_AZND]: {
        loan: USDC,
        collateral: AZND,
        oracle: OTHER,
        irm: OTHER,
        lltv: '860000000000000000',
      },
      [M_OK]: {
        loan: USDC,
        collateral: WSTETH,
        oracle: OTHER,
        irm: OTHER,
        lltv: '860000000000000000',
      },
    },
    vaults: {
      [DELTA]: {
        protocol: 'morpho-v2',
        name: 'Alpha USDC Delta V2',
        asset: USDC,
        curatorKey: 'alpha',
      },
      [PRIME]: {
        protocol: 'morpho-v2',
        name: 'Alpha USDC Prime V2',
        asset: USDC,
        curatorKey: 'alpha',
      },
      [CORE]: {
        protocol: 'morpho-v2',
        name: 'Alpha USDC Core V2',
        asset: USDC,
        curatorKey: 'alpha',
      },
      [ASIA]: {
        protocol: 'morpho-v2',
        name: 'Alpha USDC Asia V2',
        asset: USDC,
        curatorKey: 'alpha',
      },
    },
    curators: { alpha: { name: 'Alpha', source: 'morpho-api' } },
    strategies: {},
    aaveMarkets: {},
    v2Ids: {},
  },
  actions: CUTS,
  attribution: [],
  spikes: [],
  flags: {
    block: 26_000_000,
    ts: T + 120 * 86_400,
    markets: {
      [M_MSY]: {
        oracle: '0xb0b6fc449ccf81ff4129a86ddc814412e3cd9aa4',
        oracleKind: 'reported',
        parts: [feed1(OTHER, 'RedStone Price Feed for MSY_FUNDAMENTAL/USD')],
        reverting: { since: 25_367_564, sinceTs: Date.parse('2026-06-21T17:49:11Z') / 1000 },
      },
      [M_AZND]: {
        oracle: '0x270b2bd4cc6d935aa08b70eac518e2907eb5588b',
        oracleKind: 'fixed',
        parts: [],
        price: (10n ** 24n).toString(),
        borrowers: {
          top: BORROWER,
          topAssets: (7_700_000n * 10n ** 6n).toString(),
          totalBorrow: (7_700_000n * 10n ** 6n).toString(),
          totalSupply: (7_710_000n * 10n ** 6n).toString(),
          block: 25_400_000,
        },
      },
    },
    shifts: detectShifts(JUNE12, CUTS, ctx),
  },
}
const exposure: ExposureFile = {
  schema: SCHEMA,
  block: 25_400_000,
  ts: T + 10 * 86_400,
  vaults: [
    {
      vault: ASIA,
      protocol: 'morpho-v2',
      totalAssets: (7_710_000n * 10n ** 6n).toString(),
      totalUsd: 7.71e6,
      allocations: [
        {
          target: M_AZND,
          scope: 'market',
          collateral: [AZND],
          assets: (7_710_000n * 10n ** 6n).toString(),
          usd: 7.71e6,
          share: 1,
        },
      ],
    },
  ],
}

describe('flags view', () => {
  const r = buildFlagsResponse(feed, exposure, parseFeedQuery({ view: 'flags' }), compact)
  it('states the msY oracle facts: reported inputs, reverting since its block', () => {
    const msy = r.markets.find((m) => m.market === M_MSY)!
    expect(msy.kinds).toEqual(['oracle-reported', 'oracle-reverting'])
    expect(msy.claim).toBe('measured-change')
    expect(msy.texts[0]).toBe(
      'The oracle prices msY from "RedStone Price Feed for MSY_FUNDAMENTAL/USD": reported values, with no market price in the path. A fall in msY\'s market price does not reach this market.',
    )
    expect(msy.texts[1]).toBe(
      'price() has reverted since block 25,367,564 (2026-06-21 17:49 UTC): liquidations, new borrows and collateral withdrawals from positions with debt revert in this market. Repaying is the only way a borrower can leave.',
    )
    // Reverting markets sort first.
    expect(r.markets[0].market).toBe(M_MSY)
  })
  it('states the AZND facts: fixed price, one borrower, the vault lent to it', () => {
    const az = r.markets.find((m) => m.market === M_AZND)!
    expect(az.kinds).toEqual(['oracle-fixed', 'one-borrower'])
    expect(az.texts[0]).toMatch(
      /^The oracle has no price feed: it prices 1 AZND at 1 USDC at every block\./,
    )
    expect(az.texts[1]).toBe(
      "One address (0xe38a…dc4c) owes 100% of the market's 7.7M USDC of borrows (block 25,400,000).",
    )
    expect(az.vaults[0]).toMatchObject({ vault: ASIA, share: 1 })
    expect(az.vaults[0].borrowerShare).toBeCloseTo(0.9987, 3)
  })
  it('states the shift in words, with the cuts that followed', () => {
    expect(r.shifts).toHaveLength(1)
    expect(r.shifts[0].claim).toBe('possible-leading-signal')
    expect(r.shifts[0].text).toBe(
      'Alpha moved ≈ $6.7M of msY/USDC (86% LLTV) between its own vaults on 2026-06-12 (net, UTC day): Alpha USDC Prime V2 −6.19M USDC, Alpha USDC Core V2 −1.5M USDC; Alpha USDC Delta V2 +6.7M USDC. Then Alpha USDC Prime V2 set its cap to 0 on msY (2026-06-12 08:55 UTC); Alpha USDC Core V2 set its cap to 0 on msY (2026-06-12 08:56 UTC).',
    )
  })
  it('names an unregistered curator by its short address', () => {
    // The collector names a curator missing from the registries by its address.
    const A = '0x6788c8ad65e85cca7224a0b46d061ef7d81f9da5'
    const vaults = Object.fromEntries(
      Object.entries(feed.entities.vaults).map(([k, v]) => [k, { ...v, curatorKey: A }]),
    )
    const anon = {
      ...feed,
      entities: {
        ...feed.entities,
        vaults,
        curators: { [A]: { name: A, source: 'address' as const } },
      },
    }
    const t = buildFlagsResponse(anon, exposure, parseFeedQuery({ view: 'flags' }), compact)
      .shifts[0].text
    expect(t.startsWith('The curator 0x6788…9da5 moved ≈ $6.7M of msY/USDC')).toBe(true)
  })
  it('filters by collateral and curator; no judgement words', () => {
    expect(
      buildFlagsResponse(
        feed,
        exposure,
        parseFeedQuery({ view: 'flags', collateral: 'AZND' }),
        compact,
      ).markets.map((m) => m.market),
    ).toEqual([M_AZND])
    expect(
      buildFlagsResponse(
        feed,
        exposure,
        parseFeedQuery({ view: 'flags', curator: 'nobody' }),
        compact,
      ),
    ).toMatchObject({ markets: [], shifts: [] })
    const texts = [...r.markets.flatMap((m) => m.texts), ...r.shifts.map((s) => s.text)]
    for (const t of texts) {
      expect(t).not.toMatch(/undefined|NaN|\[object/)
      expect(t.replace(/Alpha|msY|AZND/g, '')).not.toMatch(
        /\b(safe|unsafe|risky|healthy|secure|guarantee)/i,
      )
    }
  })
  it('tags vault exposure rows with the market flags', () => {
    const v = buildVaultExposure(feed, exposure, parseFeedQuery({ view: 'exposure', by: 'vault' }))
    expect(v.vaults[0].allocations[0].flags).toEqual([
      'fixed-price oracle',
      'one borrower ≈ 100% of vault',
    ])
  })
  it('flags survive the on-disk round trip; files without flags still parse', () => {
    const back = parseFeedFile(JSON.parse(JSON.stringify(encodeFeedFile(feed))))
    expect(back.flags).toEqual(JSON.parse(JSON.stringify(feed.flags)))
    const { flags: _drop, ...old } = feed
    expect(parseFeedFile(JSON.parse(JSON.stringify(encodeFeedFile(old)))).flags).toBeUndefined()
    expect(buildFlagsResponse(old, exposure, parseFeedQuery({ view: 'flags' }), compact)).toEqual({
      markets: [],
      shifts: [],
    })
  })
})
