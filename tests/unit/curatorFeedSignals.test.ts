import { describe, expect, it } from 'vitest'

import { aprOf, attribute, ratio, SECONDS_PER_YEAR } from '@/lib/curatorFeed/attribution'
import { detectSpikes, explainSpike, groupFlows, isSpike } from '@/lib/curatorFeed/spikes'
import {
  clusteredIds,
  detectExitClusters,
  isDirectExit,
  tightestSpanHours,
} from '@/lib/curatorFeed/clusters'
import { byCollateral, byCurator, toAssetsDown } from '@/lib/curatorFeed/exposure'
import {
  aggregateDaily,
  decodeFlows,
  encodeFlows,
  encodeUnitFlows,
  mergeUnitFlows,
  netPerTx,
  selectLargeWithdrawals,
  toUnits6,
  utcDay,
  type UnitFlow,
} from '@/lib/curatorFeed/flows'
import {
  actionText,
  capText,
  compact,
  durationText,
  lltvText,
  marketLabel,
} from '@/lib/curatorFeed/format'
import {
  buildAttributionResponse,
  buildExposureResponse,
  buildFeedResponse,
  broadExitVaults,
  buildSpikeResponse,
  buildVaultExposure,
  clusterText,
  collateralMatcher,
  parseFeedQuery,
  QueryError,
  zeroTimelockFns,
} from '@/lib/curatorFeed/service'
import { trimFeed, trimFlows, windowStart } from '@/lib/curatorFeed/window'
import {
  encodeFeedFile,
  encodeStateFile,
  intern,
  parseExposureFile,
  parseFeedFile,
  parseFlowsFile,
  parseStateFile,
  SCHEMA,
  unintern,
  type CollectorState,
  type ExposureFile,
  type FeedFile,
} from '@/lib/curatorFeed/store'
import type {
  AttributionCase,
  Entities,
  ExposureVault,
  FeedAction,
  Reallocation,
} from '@/lib/curatorFeed/types'

const H = 3600
const RSETH = '0xa1290d69c65a6fe4df752f95823fae25cb99e5a7'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const v = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const mid = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const T0 = 1_790_000_000

let n = 0
const act = (p: Partial<FeedAction> & Pick<FeedAction, 'vault' | 'kind' | 'ts'>): FeedAction => ({
  id: `0x${(++n).toString(16)}:0`,
  protocol: 'morpho-v1',
  scope: 'market',
  target: mid(1),
  collateral: [RSETH],
  block: 100 + n,
  tx: '0x',
  ...p,
})

// Curator A runs vaults 1 and 2; B runs 3; C runs 4.
const CURATOR: Record<string, string> = { [v(1)]: 'A', [v(2)]: 'A', [v(3)]: 'B', [v(4)]: 'C' }
const curatorOf = (x: string) => CURATOR[x] ?? x

// ── clusters ─────────────────────────────────────────────────────────────────

describe('exit clusters', () => {
  it('3 distinct curators exiting rsETH inside 24h → one red cluster with the tightest span', () => {
    const acts = [
      act({ vault: v(1), kind: 'cap_zero', ts: T0 }),
      act({ vault: v(3), kind: 'removal_submit', ts: T0 + 5 * H }),
      act({ vault: v(4), kind: 'market_removed', ts: T0 + 19 * H }),
    ]
    const cs = detectExitClusters(acts, curatorOf)
    expect(cs).toHaveLength(1)
    expect(cs[0].curators.sort()).toEqual(['A', 'B', 'C'])
    expect(cs[0].tightestHours).toBe(5)
    expect(clusteredIds(cs).size).toBe(3)
    expect(clusterText(cs[0].curators.length, 'rsETH', cs[0].tightestHours)).toBe(
      '3 curators set rsETH caps to 0 or removed rsETH markets, leaving no other rsETH market capped, within 5h',
    )
    expect(clusterText(2, 'rsETH', 0.5, 1)).toMatch(
      /within <1h \(1 exit: remaining caps not read\)$/,
    )
  })
  it('a migration (another market with the same collateral still capped) is not an exit', () => {
    const acts = [
      act({ vault: v(1), kind: 'cap_zero', ts: T0, stillCapped: true }),
      act({ vault: v(3), kind: 'cap_zero', ts: T0 + H, stillCapped: false }),
    ]
    expect(detectExitClusters(acts, curatorOf)).toHaveLength(0)
    expect(
      detectExitClusters(
        [...acts, act({ vault: v(4), kind: 'market_removed', ts: T0 + 2 * H })],
        curatorOf,
      )[0].curators.sort(),
    ).toEqual(['B', 'C'])
  })
  it('PT exits within 14 days of maturity are roll-offs, not signals', () => {
    const acts = [
      act({ vault: v(1), kind: 'cap_zero', ts: T0 }),
      act({ vault: v(3), kind: 'cap_zero', ts: T0 + H }),
    ]
    expect(
      detectExitClusters(acts, curatorOf, {
        windowHours: 72,
        minCurators: 2,
        expiryOf: () => T0 + 10 * 86_400,
      }),
    ).toHaveLength(0)
    expect(
      detectExitClusters(acts, curatorOf, {
        windowHours: 72,
        minCurators: 2,
        expiryOf: () => T0 + 30 * 86_400,
      }),
    ).toHaveLength(1)
  })
  it('one curator exiting through two vaults is not a cluster', () => {
    const cs = detectExitClusters(
      [
        act({ vault: v(1), kind: 'cap_zero', ts: T0 }),
        act({ vault: v(2), kind: 'cap_zero', ts: T0 + H }),
      ],
      curatorOf,
    )
    expect(cs).toHaveLength(0)
  })
  it('respects the window: 80h apart is outside 72h, inside 96h', () => {
    const acts = [
      act({ vault: v(1), kind: 'cap_zero', ts: T0 }),
      act({ vault: v(3), kind: 'cap_zero', ts: T0 + 80 * H }),
    ]
    expect(detectExitClusters(acts, curatorOf, { windowHours: 72, minCurators: 2 })).toHaveLength(0)
    expect(detectExitClusters(acts, curatorOf, { windowHours: 96, minCurators: 2 })).toHaveLength(1)
  })
  it('does not absorb an exit that is outside every qualifying window', () => {
    // A at t0 and A again at +50h are one curator; only (A at +50h, B at +100h) qualifies.
    const acts = [
      act({ vault: v(1), kind: 'cap_zero', ts: T0 }),
      act({ vault: v(2), kind: 'cap_zero', ts: T0 + 50 * H }),
      act({ vault: v(3), kind: 'cap_zero', ts: T0 + 100 * H }),
    ]
    const cs = detectExitClusters(acts, curatorOf)
    expect(cs).toHaveLength(1)
    expect(cs[0].actionIds).toEqual([acts[1].id, acts[2].id])
    expect(cs[0].start).toBe(T0 + 50 * H)
  })
  it('chains overlapping windows into one cluster', () => {
    const acts = [
      act({ vault: v(1), kind: 'cap_zero', ts: T0 }),
      act({ vault: v(3), kind: 'cap_zero', ts: T0 + 60 * H }),
      act({ vault: v(4), kind: 'cap_zero', ts: T0 + 120 * H }),
    ]
    const cs = detectExitClusters(acts, curatorOf)
    expect(cs).toHaveLength(1)
    expect(cs[0].end - cs[0].start).toBe(120 * H)
    expect(cs[0].tightestHours).toBe(60)
  })
  it('keeps assets apart, ignores non-exits and multi-collateral strategies, attaches Aave as context only', () => {
    const acts = [
      act({ vault: v(1), kind: 'cap_zero', ts: T0 }),
      act({ vault: v(3), kind: 'cap_zero', ts: T0 + H, collateral: [WETH] }),
      act({ vault: v(3), kind: 'cap_cut', ts: T0 + H }),
      act({
        vault: v(4),
        kind: 'cap_zero',
        ts: T0 + 2 * H,
        protocol: 'euler-earn',
        scope: 'strategy',
        collateral: [RSETH, WETH],
      }),
      act({ vault: v(9), kind: 'freeze', ts: T0 + 3 * H, protocol: 'aave-v3', scope: 'reserve' }),
    ]
    expect(detectExitClusters(acts, curatorOf)).toHaveLength(0)
    expect(isDirectExit(acts[3])).toBe(false)
    const withB = [...acts, act({ vault: v(3), kind: 'market_removed', ts: T0 + 4 * H })]
    const cs = detectExitClusters(withB, curatorOf)
    expect(cs).toHaveLength(1)
    expect(cs[0].curators.sort()).toEqual(['A', 'B'])
    expect(cs[0].protocolActionIds).toEqual([acts[4].id])
    expect(cs[0].actionIds).not.toContain(acts[4].id)
  })
  it('counts member vaults that closed caps on ≥ 3 collaterals in the window (wind-down context)', () => {
    const coll = (c: string, i: number) =>
      act({ vault: v(1), kind: 'cap_zero', ts: T0 + i * H, collateral: [c] })
    const acts = [
      coll(RSETH, 0),
      coll(WETH, 1),
      coll(USDC, 2),
      act({ vault: v(3), kind: 'cap_zero', ts: T0 }),
    ]
    expect(broadExitVaults(acts, [v(1), v(3)], T0 - H, T0 + 3 * H)).toBe(1)
    expect(broadExitVaults(acts, [v(1), v(3)], T0 - H, T0 + H)).toBe(0)
    expect(clusterText(2, 'rsETH', 3, 0, [1, 2])).toMatch(
      /; 1 of 2 vaults closed caps on 3 or more collaterals in the same window$/,
    )
  })
  it('tightestSpanHours is Infinity when fewer than k curators exist', () => {
    expect(tightestSpanHours([{ ts: 0, curator: 'A' }], 2)).toBe(Infinity)
  })
})

// ── flows ────────────────────────────────────────────────────────────────────

const leg = (p: Partial<Reallocation>): Reallocation => ({
  protocol: 'morpho-v1',
  vault: v(1),
  target: mid(1),
  dir: 'out',
  assets: 100n,
  source: 'allocator',
  actor: v(7),
  block: 10,
  ts: T0,
  tx: '0xa',
  logIndex: 0,
  ...p,
})

describe('flows', () => {
  it('nets withdraw-and-resupply of one market inside one tx', () => {
    const net = netPerTx([
      leg({ dir: 'out', assets: 100n }),
      leg({ dir: 'in', assets: 40n, logIndex: 1 }),
      leg({ target: mid(2), dir: 'in', assets: 60n, logIndex: 2 }),
      leg({ tx: '0xb', dir: 'in', assets: 5n }),
    ])
    expect(net.map((l) => [l.tx, l.target, l.dir, l.assets])).toEqual([
      ['0xa', mid(1), 'out', 60n],
      ['0xa', mid(2), 'in', 60n],
      ['0xb', mid(1), 'in', 5n],
    ])
    expect(
      netPerTx([leg({ dir: 'out', assets: 10n }), leg({ dir: 'in', assets: 10n })]),
    ).toHaveLength(0)
  })
  it('aggregates per UTC day × vault × target × source', () => {
    const rows = aggregateDaily([
      leg({}),
      leg({ ts: T0 + 60, dir: 'in', assets: 7n }),
      leg({ ts: T0 + 86_400 }),
      leg({ source: 'public-allocator' }),
    ])
    expect(rows).toHaveLength(3)
    const first = rows.find((r) => r.day === utcDay(T0) && r.source === 'allocator')!
    expect(first).toMatchObject({ out: '100', in: '7', n: 2 })
  })
  it('compact encoding round-trips at 6 significant digits', () => {
    const daily = aggregateDaily([
      leg({ assets: 123_456_789_012n }),
      leg({ vault: v(2), dir: 'in', assets: 5_000_000n, source: 'public-allocator' }),
    ])
    const file = encodeFlows(daily, 999, () => 6)
    expect(file.vaults).toHaveLength(2)
    const back = decodeFlows(parseFlowsFile(JSON.parse(JSON.stringify(file))))
    expect(back.find((r) => r.vault === v(1))!.out).toBe(123_457)
    expect(back.find((r) => r.vault === v(2))).toMatchObject({ in: 5, source: 'public-allocator' })
    expect(toUnits6(0n, 18)).toBe(0)
  })
  it('selects large net withdrawals per (market, block), keeps every leg of a hit block, Morpho markets only', () => {
    const usd = (l: Reallocation) => Number(l.assets)
    const legs = [
      leg({ assets: 2_000_000n, tx: '0x1' }),
      leg({ vault: v(2), assets: 10n, tx: '0x2' }),
      leg({ block: 11, assets: 10n, tx: '0x3' }),
      leg({ target: v(5), assets: 9_000_000n, tx: '0x4' }),
    ]
    const cases = selectLargeWithdrawals(legs, usd, (t) => t.length === 66, 1_000_000)
    expect(cases).toHaveLength(1)
    expect(cases[0].legs.map((l) => l.assets)).toEqual(['2000000', '10'])
  })
})

// ── attribution ──────────────────────────────────────────────────────────────

describe('attribution', () => {
  const rate = (apr: number) => String(BigInt(Math.round((apr / SECONDS_PER_YEAR) * 1e18)))
  const c = (p: Partial<AttributionCase>): AttributionCase => ({
    market: mid(1),
    block: 10,
    ts: T0,
    legs: [{ vault: v(1), assets: '15', source: 'allocator', tx: '0x' }],
    before: { totalSupplyAssets: '100', totalBorrowAssets: '70', borrowRate: rate(0.05) },
    after: { totalSupplyAssets: '80', totalBorrowAssets: '70', borrowRate: rate(0.2) },
    ...p,
  })
  it('measures the block: share of the supply drop, utilization, APR, spike', () => {
    const a = attribute(c({}))!
    expect(a.supplyDelta).toBe(-20n)
    expect(a.shareOfDrop).toBe(0.75)
    expect(a.utilBefore).toBe(0.7)
    expect(a.utilAfter).toBe(0.875)
    expect(a.aprBefore).toBeCloseTo(0.05, 6)
    expect(a.aprAfter).toBeCloseTo(0.2, 6)
    expect(a.spike).toBe(true)
    expect(a.drained).toBe(false)
  })
  it('no spike below the ratio or the APR-point floor; drained at ≥ 99% utilization', () => {
    expect(
      attribute(
        c({ after: { totalSupplyAssets: '80', totalBorrowAssets: '70', borrowRate: rate(0.06) } }),
      )!.spike,
    ).toBe(false)
    expect(
      attribute(
        c({
          before: { totalSupplyAssets: '100', totalBorrowAssets: '70', borrowRate: rate(0.005) },
          after: { totalSupplyAssets: '80', totalBorrowAssets: '70', borrowRate: rate(0.02) },
        }),
      )!.spike,
    ).toBe(false)
    // +3 APR points but only 1.3× — not a spike by the ratio rule.
    expect(
      attribute(
        c({
          before: { totalSupplyAssets: '100', totalBorrowAssets: '70', borrowRate: rate(0.1) },
          after: { totalSupplyAssets: '80', totalBorrowAssets: '70', borrowRate: rate(0.13) },
        }),
      )!.spike,
    ).toBe(false)
    expect(
      attribute(c({ after: { totalSupplyAssets: '70', totalBorrowAssets: '70' } }))!.drained,
    ).toBe(true)
  })
  it('never claims more than the drop; no share when supply rose; null without state', () => {
    expect(
      attribute(c({ legs: [{ vault: v(1), assets: '50', source: 'allocator', tx: '0x' }] }))!
        .shareOfDrop,
    ).toBe(1)
    expect(
      attribute(c({ after: { totalSupplyAssets: '120', totalBorrowAssets: '70' } }))!.shareOfDrop,
    ).toBeUndefined()
    expect(attribute(c({ before: undefined }))).toBeNull()
  })
  it('ratio and aprOf are exact enough for 18-decimal sizes', () => {
    expect(ratio(10n ** 30n, 4n * 10n ** 30n)).toBe(0.25)
    expect(ratio(1n, 0n)).toBe(0)
    expect(aprOf(10n ** 18n / BigInt(SECONDS_PER_YEAR))).toBeCloseTo(1, 6)
  })
})

// ── exposure ─────────────────────────────────────────────────────────────────

describe('exposure', () => {
  it('toAssetsDown matches Morpho Blue SharesMathLib (virtual 1e6 shares, 1 asset)', () => {
    expect(toAssetsDown(10n ** 6n, 0n, 0n)).toBe(1n)
    expect(toAssetsDown(500n * 10n ** 6n, 1000n, 1000n * 10n ** 6n)).toBe(500n)
    expect(toAssetsDown(0n, 1000n, 10n ** 9n)).toBe(0n)
  })
  const vaults: ExposureVault[] = [
    {
      vault: v(1),
      protocol: 'morpho-v1',
      totalAssets: '1000',
      allocations: [
        {
          target: mid(1),
          scope: 'market',
          collateral: [RSETH],
          assets: '300',
          usd: 300,
          share: 0.3,
        },
        {
          target: mid(2),
          scope: 'market',
          collateral: [RSETH],
          assets: '200',
          usd: 200,
          share: 0.2,
        },
        { target: mid(3), scope: 'market', collateral: [], assets: '500', usd: 500, share: 0.5 },
      ],
    },
    {
      vault: v(2),
      protocol: 'morpho-v2',
      totalAssets: '100',
      allocations: [
        { target: mid(1), scope: 'market', collateral: [RSETH], assets: '100', share: 1 },
      ],
    },
    {
      vault: v(3),
      protocol: 'euler-earn',
      totalAssets: '50',
      allocations: [
        {
          target: v(8),
          scope: 'strategy',
          collateral: [RSETH, WETH],
          assets: '50',
          usd: 50,
          share: 1,
        },
      ],
    },
  ]
  it('pivots to collateral → holders, merging one vault’s markets, skipping idle, counting unpriced', () => {
    const rows = byCollateral(vaults, curatorOf, () => USDC)
    const rs = rows.find((r) => r.collateral === RSETH)!
    expect(rs.holders.map((h) => [h.vault, h.assets, h.shareOfVault])).toEqual([
      [v(1), '500', 0.5],
      [v(3), '50', 1],
      [v(2), '100', 1],
    ])
    expect(rs.usd).toBe(550)
    expect(rs.unpriced).toBe(1)
    expect([...rs.curators].sort()).toEqual(['A', 'B'])
    expect(rows.some((r) => r.collateral === '')).toBe(false)
    expect(
      byCollateral(vaults, curatorOf, () => USDC, { includeIdle: true }).some(
        (r) => r.collateral === '',
      ),
    ).toBe(true)
    expect(
      byCollateral(vaults, curatorOf, () => USDC, { minShare: 0.6 }).find(
        (r) => r.collateral === RSETH,
      )!.holders,
    ).toHaveLength(2)
  })
  it('byCurator sums priced allocations per curator entity', () => {
    const rows = byCurator(vaults, curatorOf)
    expect(rows[0]).toMatchObject({ curator: 'A', vaults: 2, usd: 1000 })
    expect(rows[0].collateral[RSETH]).toBe(500)
  })
})

// ── format ───────────────────────────────────────────────────────────────────

const entities: Entities = {
  tokens: {
    [RSETH]: { symbol: 'rsETH', decimals: 18, priceUsd: 3000 },
    [WETH]: { symbol: 'WETH', decimals: 18, priceUsd: 2800 },
    [USDC]: { symbol: 'USDC', decimals: 6, priceUsd: 1 },
  },
  markets: {
    [mid(1)]: {
      loan: WETH,
      collateral: RSETH,
      oracle: v(5),
      irm: v(6),
      lltv: '945000000000000000',
    },
  },
  vaults: {
    [v(1)]: {
      protocol: 'morpho-v1',
      name: 'Alpha WETH',
      asset: WETH,
      curatorKey: 'name:alpha',
      timelock: 86_400,
    },
    [v(3)]: { protocol: 'morpho-v1', name: 'Beta WETH', asset: WETH, curatorKey: 'name:beta' },
    [v(4)]: { protocol: 'morpho-v2', name: 'Gamma WETH', asset: WETH, curatorKey: v(44) },
  },
  curators: {
    'name:alpha': { name: 'Alpha', source: 'morpho-api' },
    'name:beta': { name: 'Beta', source: 'morpho-api' },
    [v(44)]: { name: v(44), source: 'address' },
  },
  strategies: {},
  aaveMarkets: { [v(9)]: 'Aave v3 Core' },
  v2Ids: {},
}

describe('format', () => {
  it('labels markets and numbers factually', () => {
    expect(marketLabel(entities, mid(1))).toBe('rsETH/WETH (94.5% LLTV)')
    expect(lltvText('860000000000000000')).toBe('86%')
    expect(compact(1_234_567)).toBe('1.23M')
    expect(compact(0)).toBe('0')
    expect(durationText(90_000)).toBe('1d 1h')
    expect(durationText(3600)).toBe('1h')
  })
  it('cap text uses the vault asset decimals, treats huge caps as unlimited, and Aave 0 as no cap', () => {
    const a = act({ vault: v(1), kind: 'cap_raise', ts: T0 })
    expect(capText(entities, a, '5000000000000000000000')).toBe('5K WETH')
    expect(capText(entities, a, (2n ** 184n - 1n).toString())).toBe('unlimited WETH')
    expect(
      capText(entities, { ...a, protocol: 'aave-v3', target: RSETH, capType: 'supply' }, '0'),
    ).toBe('no cap')
    expect(capText(entities, { ...a, capType: 'relative' }, '500000000000000000')).toBe(
      '50.00% of vault',
    )
  })
  it('every sentence is factual — no judgement words', () => {
    const kinds: FeedAction['kind'][] = [
      'cap_submit',
      'cap_raise',
      'cap_cut',
      'cap_zero',
      'cap_revoke',
      'removal_submit',
      'removal_revoke',
      'market_removed',
      'market_added',
      'supply_queue_add',
      'supply_queue_remove',
      'timelock_submit',
      'timelock_set',
      'timelock_revoke',
      'curator_set',
      'allocator_set',
      'guardian_submit',
      'guardian_set',
      'guardian_revoke',
      'owner_set',
      'sentinel_set',
      'adapter_add',
      'adapter_remove',
      'v2_submit',
      'v2_revoke',
      'freeze',
      'unfreeze',
      'pause',
      'unpause',
      'borrow_off',
      'borrow_on',
      'ltv_zero',
      'collateral_params',
    ]
    for (const kind of kinds) {
      const s = actionText(
        entities,
        act({
          vault: v(1),
          kind,
          ts: T0,
          from: '1000000000000000000',
          to: '0',
          validAt: T0 + 86_400,
        }),
      )
      expect(s.length, kind).toBeGreaterThan(5)
      expect(s, kind).not.toMatch(/\b(safe|unsafe|risky|healthy|danger|secure|guarantee)/i)
      expect(s, kind).not.toMatch(/undefined|NaN/)
    }
    // Real-data regression (2026-10-07 run): non-numeric from/to on role rows must not reach BigInt.
    for (const [kind, to] of [
      ['allocator_set', 'true'],
      ['sentinel_set', 'false'],
      ['curator_set', v(44)],
      ['timelock_set', 'abdicated'],
    ] as const) {
      expect(
        () => actionText(entities, act({ vault: v(1), kind, ts: T0, to, target: v(5) })),
        kind,
      ).not.toThrow()
    }
    expect(
      actionText(
        entities,
        act({ vault: v(1), kind: 'cap_zero', ts: T0, from: '5000000000000000000000', to: '0' }),
      ),
    ).toBe('Set supply cap to 0 on rsETH/WETH (94.5% LLTV) (was 5K WETH)')
  })
})

// ── store + service ──────────────────────────────────────────────────────────

const now = T0 + 10 * H
const feed: FeedFile = {
  meta: {
    schema: SCHEMA,
    chainId: 1,
    fromBlock: 1,
    toBlock: 1000,
    fromTs: T0 - 180 * 86_400,
    toTs: now,
    collectedAt: '2026-10-07T00:00:00Z',
    endpoints: ['env:example.org', 'gateway.tenderly.co'],
    logs: {
      chunks: 1,
      rechecked: 1,
      disagreements: 0,
      recovered: 0,
      emptyConfirmed: 0,
      servedBy: {},
      shortBy: {},
    },
    counts: {},
    thresholds: { largeWithdrawUsd: 1e6, exposureMinUsd: 1e5, keptSupplyDrop: 0.1 },
    sources: [],
    caveats: [],
  },
  entities,
  actions: [
    act({ vault: v(1), kind: 'cap_zero', ts: T0 }),
    act({ vault: v(3), kind: 'market_removed', ts: T0 + 2 * H }),
    act({
      vault: v(4),
      kind: 'cap_submit',
      ts: T0 + 3 * H,
      validAt: now + 5 * H,
      protocol: 'morpho-v2',
    }),
    act({
      vault: v(4),
      kind: 'cap_submit',
      ts: T0 + 4 * H,
      validAt: now - H,
      protocol: 'morpho-v2',
      collateral: [WETH],
    }),
    act({
      vault: v(9),
      kind: 'freeze',
      ts: T0 + 5 * H,
      protocol: 'aave-v3',
      scope: 'reserve',
      target: RSETH,
    }),
    act({
      vault: v(1),
      kind: 'curator_set',
      ts: T0 + 6 * H,
      collateral: [],
      scope: 'vault',
      target: undefined,
      to: v(44),
    }),
  ],
  attribution: [
    {
      market: mid(1),
      block: 500,
      ts: T0,
      legs: [{ vault: v(1), assets: '2000000000000000000000', source: 'allocator', tx: '0xfeed' }],
      before: {
        totalSupplyAssets: '10000000000000000000000',
        totalBorrowAssets: '8000000000000000000000',
        borrowRate: '1000000000',
      },
      after: {
        totalSupplyAssets: '8000000000000000000000',
        totalBorrowAssets: '8000000000000000000000',
        borrowRate: '9000000000',
      },
    },
  ],
  spikes: [
    {
      market: mid(1),
      block: 700,
      ts: T0 + H,
      rateBefore: String((4n * 10n ** 16n) / 31_536_000n),
      rateAfter: String((30n * 10n ** 16n) / 31_536_000n),
      before: {
        totalSupplyAssets: '100000000000000000000',
        totalBorrowAssets: '80000000000000000000',
      },
      after: {
        totalSupplyAssets: '85000000000000000000',
        totalBorrowAssets: '85000000000000000000',
      },
      flows: [
        {
          driver: 'vault-reallocation',
          side: 'supply',
          sign: -1,
          assets: '15000000000000000000',
          vault: v(1),
          source: 'allocator',
          tx: '0xr',
          n: 1,
        },
        {
          driver: 'borrow',
          side: 'borrow',
          sign: 1,
          assets: '5000000000000000000',
          tx: '0xb',
          n: 1,
        },
      ],
    },
  ],
}

describe('store', () => {
  it('interning round-trips hex strings, action ids, object keys and `~`-prefixed text', () => {
    const value = {
      [RSETH]: {
        id: `${mid(7)}:12`,
        name: '~tilde',
        other: '~~x',
        list: [WETH, WETH, 'plain', 3, null, true],
      },
    }
    const f = intern(value)
    expect(f.table).toEqual([RSETH, mid(7), WETH])
    expect(unintern(JSON.parse(JSON.stringify(f)))).toEqual(value)
    expect(() => unintern({ table: [], body: '~5' })).toThrow(/outside the table/)
  })
  it('the interned feed file parses back to the same feed and is smaller', () => {
    const disk = JSON.parse(JSON.stringify(encodeFeedFile(feed)))
    expect(parseFeedFile(disk)).toEqual(JSON.parse(JSON.stringify(feed)))
    expect(JSON.stringify(disk).length).toBeLessThan(JSON.stringify(feed).length)
  })
  it('accepts the schema it writes and rejects others', () => {
    expect(parseFeedFile(JSON.parse(JSON.stringify(feed))).actions).toHaveLength(6)
    expect(() => parseFeedFile({ ...feed, meta: { ...feed.meta, schema: 99 } })).toThrow(/schema/)
    expect(() =>
      parseFeedFile({
        meta: feed.meta,
        entities: {},
        actions: [{ id: 1 }],
        attribution: [],
        spikes: [],
      }),
    ).toThrow(/malformed/)
    expect(() => parseFeedFile({ ...feed, spikes: undefined })).toThrow(/spikes/)
    expect(() => parseExposureFile({ schema: SCHEMA })).toThrow()
  })

  it('the collector state round-trips through its interned file', () => {
    const st: CollectorState = {
      schema: SCHEMA,
      chainId: 1,
      toBlock: 1000,
      fromBlock: 1,
      kinds: { [v(1)]: 'mm', [v(66)]: 'v2adapter' },
      adapters: { [v(66)]: v(4) },
      allocators: { [v(4)]: [v(7)] },
      classifier: {
        open: { [`${v(1)}|cap|${mid(1)}`]: `${mid(9)}:3` },
        withdrawQ: { [v(1)]: [mid(1)] },
        supplyQ: {},
        lastCap: {},
        lastAaveCollateral: {},
      },
      rates: { [mid(1)]: [999, '1234'] },
      exposureBlock: 990,
    }
    expect(parseStateFile(JSON.parse(JSON.stringify(encodeStateFile(st))))).toEqual(st)
    expect(() => parseStateFile({ schema: 1, table: [] })).toThrow()
  })
})

describe('rolling window and merges', () => {
  const daily = (day: string, out: number, n = 1): UnitFlow => ({
    day,
    vault: v(1),
    target: mid(1),
    source: 'allocator',
    out,
    in: 0,
    n,
  })
  it('merges the boundary day by summing, never doubling a row', () => {
    const m = mergeUnitFlows(
      [daily('2026-10-01', 1), daily('2026-10-02', 2)],
      [daily('2026-10-02', 3), daily('2026-10-03', 4)],
    )
    expect(m.map((r) => [r.day, r.out, r.n])).toEqual([
      ['2026-10-01', 1, 1],
      ['2026-10-02', 5, 2],
      ['2026-10-03', 4, 1],
    ])
    const back = decodeFlows(encodeUnitFlows(m, 9))
    expect(back.map((r) => r.out)).toEqual([1, 5, 4])
  })
  it('trims by block but keeps submits still open; drops flows before the first day', () => {
    const acts = [
      act({ vault: v(1), kind: 'cap_zero', ts: T0, block: 10 }),
      act({ vault: v(1), kind: 'cap_submit', ts: T0, block: 11 }),
      act({
        vault: v(1),
        kind: 'cap_submit',
        ts: T0,
        block: 12,
        resolution: { how: 'accepted', block: 20, ts: T0, tx: '0x' },
      }),
      act({ vault: v(1), kind: 'cap_zero', ts: T0, block: 50 }),
    ]
    const r = trimFeed(
      {
        entities: feed.entities,
        actions: acts,
        attribution: feed.attribution,
        spikes: feed.spikes,
      },
      40,
    )
    expect(r.feed.actions.map((a) => a.block)).toEqual([11, 50])
    expect(r.dropped).toEqual({ actions: 2, attribution: 0, spikes: 0 })
    expect(
      trimFeed(
        {
          entities: feed.entities,
          actions: [],
          attribution: feed.attribution,
          spikes: feed.spikes,
        },
        600,
      ).dropped,
    ).toEqual({ actions: 0, attribution: 1, spikes: 0 })
    expect(
      trimFlows(
        [daily('2026-10-01', 1), daily('2026-10-02', 2)],
        Date.UTC(2026, 9, 2, 5) / 1000,
      ).map((r) => r.day),
    ).toEqual(['2026-10-02'])
    expect(windowStart(1_000_000, 10)).toBe(1_000_000 - 72_000)
    expect(windowStart(1_000_000, 10, 990_000)).toBe(990_000)
  })
})

describe('service', () => {
  it('parses and validates query params', () => {
    expect(parseFeedQuery({})).toMatchObject({
      view: 'feed',
      group: 'all',
      windowHours: 72,
      limit: 100,
    })
    expect(() => parseFeedQuery({ window: '12' })).toThrow(QueryError)
    expect(() => parseFeedQuery({ limit: '0' })).toThrow(QueryError)
    expect(() => parseFeedQuery({ group: 'nope' })).toThrow(QueryError)
    expect(() => parseFeedQuery({ protocol: 'compound' })).toThrow(QueryError)
    expect(() => parseFeedQuery({ market: '0x12' })).toThrow(QueryError)
  })
  it('matches collateral by symbol or address', () => {
    expect(collateralMatcher(feed, 'RSETH')([RSETH])).toBe(true)
    expect(collateralMatcher(feed, RSETH.toUpperCase().replace('0X', '0x'))([RSETH])).toBe(true)
    expect(collateralMatcher(feed, 'weth')([RSETH])).toBe(false)
  })
  it('builds the feed: open submits split out, cluster members red, history grey, newest first', () => {
    const r = buildFeedResponse(feed, parseFeedQuery({}), now)
    expect(r.rows[0].kind).toBe('curator_set')
    expect(r.open.map((x) => x.status)).toEqual(['executable', 'pending'])
    expect(r.open.every((x) => x.tone === 'amber')).toBe(true)
    expect(r.clusters).toHaveLength(1)
    expect(r.clusters[0].curatorNames.sort()).toEqual(['Alpha', 'Beta'])
    expect(r.clusters[0].protocolActionIds).toHaveLength(1)
    // Umbrella claim classes: rows are measured changes, clusters possible leading signals.
    expect(r.rows.every((x) => x.claim === 'measured-change')).toBe(true)
    expect(r.clusters[0].claim).toBe('possible-leading-signal')
    const red = r.rows.filter((x) => x.tone === 'red').map((x) => x.kind)
    expect(red.sort()).toEqual(['cap_zero', 'market_removed'])
    expect(r.rows.find((x) => x.kind === 'freeze')!.tone).toBe('grey')
  })
  it('filters by collateral, curator, group and status, and pages with `before`', () => {
    expect(
      buildFeedResponse(feed, parseFeedQuery({ collateral: 'WETH' }), now).rows.map((x) => x.kind),
    ).toEqual(['cap_submit'])
    expect(
      buildFeedResponse(feed, parseFeedQuery({ curator: 'beta' }), now).rows.map((x) => x.kind),
    ).toEqual(['market_removed'])
    expect(buildFeedResponse(feed, parseFeedQuery({ group: 'exits' }), now).total).toBe(3)
    expect(buildFeedResponse(feed, parseFeedQuery({ status: 'pending' }), now).total).toBe(1)
    const p1 = buildFeedResponse(feed, parseFeedQuery({ limit: '2' }), now)
    expect(p1.nextBefore).toBe(p1.rows[1].id)
    const p2 = buildFeedResponse(feed, parseFeedQuery({ limit: '2', before: p1.nextBefore }), now)
    expect(p2.rows[0].id).not.toBe(p1.rows[0].id)
    expect(() => buildFeedResponse(feed, parseFeedQuery({ before: 'nope' }), now)).toThrow(
      QueryError,
    )
  })
  it('exposure view pivots and labels holders', () => {
    const exposure: ExposureFile = {
      schema: SCHEMA,
      block: 1000,
      ts: now,
      vaults: [
        {
          vault: v(1),
          protocol: 'morpho-v1',
          totalAssets: '10000000000000000000',
          allocations: [
            {
              target: mid(1),
              scope: 'market',
              collateral: [RSETH],
              assets: '4000000000000000000',
              usd: 11_200,
              share: 0.4,
            },
          ],
        },
      ],
    }
    const r = buildExposureResponse(
      feed,
      exposure,
      parseFeedQuery({ view: 'exposure', collateral: 'rsETH' }),
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].holders[0]).toMatchObject({
      vaultName: 'Alpha WETH',
      curatorName: 'Alpha',
      loanSymbol: 'WETH',
      amount: 4,
      shareOfVault: 0.4,
    })
  })
  it('exposure by vault lists vault → markets → collateral → share', () => {
    const exposure: ExposureFile = {
      schema: SCHEMA,
      block: 1000,
      ts: now,
      vaults: [
        {
          vault: v(1),
          protocol: 'morpho-v1',
          totalAssets: '10',
          totalUsd: 28_000,
          allocations: [
            {
              target: mid(1),
              scope: 'market',
              collateral: [RSETH],
              assets: '4000000000000000000',
              usd: 11_200,
              share: 0.4,
            },
          ],
        },
        {
          vault: v(3),
          protocol: 'morpho-v1',
          totalAssets: '1',
          totalUsd: 2_800,
          allocations: [
            { target: mid(9), scope: 'market', collateral: [WETH], assets: '1', share: 1 },
          ],
        },
      ],
    }
    const r = buildVaultExposure(feed, exposure, parseFeedQuery({ view: 'exposure', by: 'vault' }))
    expect(r.vaults.map((x) => x.vaultName)).toEqual(['Alpha WETH', 'Beta WETH'])
    expect(r.vaults[0].allocations[0]).toMatchObject({
      targetName: 'rsETH/WETH (94.5% LLTV)',
      collateralSymbols: ['rsETH'],
      amount: 4,
      share: 0.4,
    })
    expect(
      buildVaultExposure(
        feed,
        exposure,
        parseFeedQuery({ view: 'exposure', by: 'vault', collateral: 'rsETH' }),
      ).vaults,
    ).toHaveLength(1)
    expect(() => parseFeedQuery({ by: 'market' })).toThrow(QueryError)
  })
  it('spike view names who pushed utilization up, with ≈ shares', () => {
    const { rows: r, total } = buildSpikeResponse(feed, parseFeedQuery({ view: 'spikes' }), compact)
    expect(total).toBe(1)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      claim: 'observed-driver',
      top: 'vault-reallocation',
      utilBefore: 0.8,
      utilAfter: 1,
    })
    expect(r[0].text).toBe(
      'Borrow APR on rsETH/WETH (94.5% LLTV) went 4.00% → 30.00% after block 700; utilization 80.0% → 100.0%. Utilization rose with: Alpha WETH (Alpha) reallocated 15 WETH out (≈ 71%); new borrows of 5 WETH (≈ 29%)',
    )
    expect(
      buildSpikeResponse(feed, parseFeedQuery({ view: 'spikes', curator: 'beta' }), compact).rows,
    ).toHaveLength(0)
    expect(
      buildSpikeResponse(feed, parseFeedQuery({ view: 'spikes', only: 'reallocation' }), compact)
        .rows,
    ).toHaveLength(1)
    expect(
      buildSpikeResponse(feed, parseFeedQuery({ view: 'spikes', collateral: 'WETH' }), compact)
        .rows,
    ).toHaveLength(0)
    // minUsd filters on market supply before the block (USD at collection-time prices).
    const supplyUsd = r[0].supplyUsd ?? 0
    expect(supplyUsd).toBeGreaterThan(0)
    expect(
      buildSpikeResponse(
        feed,
        parseFeedQuery({ view: 'spikes', minUsd: String(supplyUsd + 1) }),
        compact,
      ).total,
    ).toBe(0)
    expect(
      buildSpikeResponse(
        feed,
        parseFeedQuery({ view: 'spikes', minUsd: String(supplyUsd - 1) }),
        compact,
      ).total,
    ).toBe(1)
  })
  it('zero-timelock facts come from the vault read: V1 timelock 0, V2 per function', () => {
    const f2: FeedFile = {
      ...feed,
      entities: {
        ...feed.entities,
        vaults: {
          ...feed.entities.vaults,
          [v(3)]: { ...feed.entities.vaults[v(3)], timelock: 0 },
          [v(4)]: {
            ...feed.entities.vaults[v(4)],
            timelocks: { increaseAbsoluteCap: 0, addAdapter: 259_200, 'adapter.burnShares': 0 },
          },
        },
      },
    }
    expect(zeroTimelockFns(f2, v(1))).toEqual([])
    expect(zeroTimelockFns(f2, v(3))).toEqual(['timelock'])
    expect(zeroTimelockFns(f2, v(4))).toEqual(['increaseAbsoluteCap', 'adapter.burnShares'])
    const rows = buildFeedResponse(f2, parseFeedQuery({ limit: '50' }), now).rows
    expect(rows.find((x) => x.vault === v(4))!.zeroTimelock).toEqual([
      'increaseAbsoluteCap',
      'adapter.burnShares',
    ])
  })
  it('attribution view states the block-level facts in words', () => {
    const r = buildAttributionResponse(
      feed,
      parseFeedQuery({ view: 'attribution', only: 'spike' }),
      compact,
    )
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      claim: 'observed-driver',
      withdrawn: 2000,
      utilBefore: 0.8,
      utilAfter: 1,
      shareOfDrop: 1,
      spike: true,
      drained: true,
    })
    expect(r[0].text).toMatch(
      /^Alpha WETH \(Alpha\) withdrew 2K WETH from rsETH\/WETH \(94\.5% LLTV\) in block 500/,
    )
    expect(r[0].text).not.toMatch(/safe|risky/i)
  })
})

// ── spike-first attribution ──────────────────────────────────────────────────

describe('rate spikes', () => {
  const SPY = 31_536_000n
  const r = (apr: number) => (BigInt(Math.round(apr * 1e6)) * 10n ** 12n) / SPY // per-second WAD
  const pt = (block: number, apr: number, logIndex = 0) => ({ block, logIndex, rate: r(apr) })

  it('finds a jump and blames the PREVIOUS accrual block (whose interactions set the new rate)', () => {
    const s = detectSpikes(mid(1), [pt(10, 0.04), pt(20, 0.041), pt(30, 0.2), pt(40, 0.21)])
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ market: mid(1), block: 20, seenAt: 30 })
    expect(aprOf(s[0].rateAfter)).toBeCloseTo(0.2, 5)
  })
  it('uses the carried last point across a run boundary, and sorts unsorted input', () => {
    expect(
      detectSpikes(mid(1), [pt(31, 0.3), pt(30, 0.04)], { block: 20, rate: r(0.04) }),
    ).toHaveLength(1)
    expect(detectSpikes(mid(1), [pt(30, 0.2)], { block: 20, rate: r(0.04) })[0].block).toBe(20)
    expect(detectSpikes(mid(1), [pt(30, 0.2)])).toHaveLength(0)
  })
  it('needs both the ratio and the APR-point floor', () => {
    expect(isSpike(r(0.1), r(0.13))).toBe(false) // +3 pp but 1.3×
    expect(isSpike(r(0.005), r(0.02))).toBe(false) // 4× but +1.5 pp
    expect(isSpike(r(0.05), r(0.2))).toBe(true)
  })

  const ADAPTER = v(66)
  const flowCtx = {
    vaultOf: (a: string) => (a === v(1) ? v(1) : a === ADAPTER ? v(2) : undefined),
    reallocationIn: (tx: string, vault: string) =>
      tx === '0xr' && vault === v(1)
        ? ('allocator' as const)
        : tx === '0xp'
          ? ('public-allocator' as const)
          : undefined,
  }
  it('groups a block’s flows: reallocation vs redemption, adapters mapped to their vault, liquidations split', () => {
    const rows = groupFlows(
      [
        { name: 'Withdraw', tx: '0xr', onBehalf: v(1), assets: 15n },
        { name: 'Withdraw', tx: '0xu', onBehalf: v(1), assets: 2n },
        { name: 'Withdraw', tx: '0xp', onBehalf: ADAPTER, assets: 3n },
        { name: 'Withdraw', tx: '0xd', onBehalf: v(9), assets: 1n },
        { name: 'Borrow', tx: '0xb', onBehalf: v(9), assets: 5n },
        { name: 'Liquidate', tx: '0xl', repaidAssets: 4n, badDebtAssets: 1n },
        { name: 'Supply', tx: '0xs', onBehalf: v(9), assets: 0n },
      ],
      flowCtx,
    )
    const key = (f: (typeof rows)[number]) =>
      `${f.driver}:${f.side}:${f.sign}:${f.vault ?? '-'}:${f.source ?? '-'}:${f.assets}`
    expect(rows.map(key).sort()).toEqual(
      [
        `vault-reallocation:supply:-1:${v(1)}:allocator:15`,
        `vault-redemption:supply:-1:${v(1)}:-:2`,
        `vault-reallocation:supply:-1:${v(2)}:public-allocator:3`,
        'supplier-withdrawal:supply:-1:-:-:1',
        'borrow:borrow:1:-:-:5',
        'liquidation:borrow:-1:-:-:4',
        'bad-debt:borrow:-1:-:-:1',
        'bad-debt:supply:-1:-:-:1',
      ].sort(),
    )
  })
  it('explains a spike by first-order utilization shares among the flows that pushed it up', () => {
    const e = explainSpike({
      market: mid(1),
      block: 20,
      ts: T0,
      rateBefore: r(0.04).toString(),
      rateAfter: r(0.3).toString(),
      before: { totalSupplyAssets: '100', totalBorrowAssets: '80' },
      after: { totalSupplyAssets: '85', totalBorrowAssets: '85' },
      flows: [
        {
          driver: 'vault-reallocation',
          side: 'supply',
          sign: -1,
          assets: '15',
          vault: v(1),
          source: 'allocator',
          tx: '0xr',
          n: 1,
        },
        { driver: 'borrow', side: 'borrow', sign: 1, assets: '5', tx: '0xb', n: 1 },
        { driver: 'repay', side: 'borrow', sign: -1, assets: '1', tx: '0xq', n: 1 },
      ],
    })
    // supply −15 at S=100, B=80: du = 80·15/100² = 0.12; borrow +5: du = 0.05; repay −1: −0.01
    expect(e.contributions.map((c) => [c.driver, Number(c.du.toFixed(4))])).toEqual([
      ['vault-reallocation', 0.12],
      ['borrow', 0.05],
      ['repay', -0.01],
    ])
    expect(e.top).toBe('vault-reallocation')
    expect(e.topShare).toBeCloseTo(0.12 / 0.17, 6)
    expect(e.reallocationShare).toBeCloseTo(0.12 / 0.17, 6)
    expect(e.utilBefore).toBe(0.8)
    expect(e.utilAfter).toBe(1)
  })
  it('explains without state as zero shares, never a guess', () => {
    const e = explainSpike({
      market: mid(1),
      block: 1,
      ts: T0,
      rateBefore: '1',
      rateAfter: '9',
      flows: [{ driver: 'borrow', side: 'borrow', sign: 1, assets: '5', tx: '0x', n: 1 }],
    })
    expect(e.top).toBeUndefined()
    expect(e.contributions[0].share).toBe(0)
  })
})
