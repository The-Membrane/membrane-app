// The lending coverage's pure parts: Aave / Spark reserves, Compound V3 base supply,
// MetaMorpho vaults (lib/position-sim/adapters), and the oracle-health gap (lib/position/oracleGap.ts).

import { describe, expect, it } from 'vitest'

import { aaveReserveLendMarket } from '@/lib/position-sim/adapters/aaveV3'
import { cometLendMarket } from '@/lib/position-sim/adapters/compoundV3'
import { MAX_VAULTS, allocationOf, parseVaultDiscovery, vaultLendMarket, vaultLiquidity } from '@/lib/position-sim/adapters/morphoVaults'
import { dailyBlocks, fmtGap, gapPoint, gapSummary, oraclePriceOf, parseCoinsChart, priceNear } from '@/lib/position/oracleGap'

const RAY = 10n ** 27n
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const

describe('aaveReserveLendMarket', () => {
  it('reads the reserve as a lend market: unborrowed supply, RAY rates as APRs, reserve factor, deficit', () => {
    const m = aaveReserveLendMarket({
      symbol: 'USDC',
      token: USDC,
      decimals: 6,
      priceUsd: 1,
      words: {
        totalAToken: 1_000_000_000_000n, // 1,000,000 USDC
        totalStableDebt: 0n,
        totalVariableDebt: 900_000_000_000n,
        liquidityRate: (RAY * 45n) / 1000n, // 4.5%
        variableBorrowRate: (RAY * 55n) / 1000n,
        lastUpdateTimestamp: 1_000,
      },
      reserveFactorBps: 1_000n,
      deficitRaw: 2_500_000n,
      block: 123n,
      blockTs: 1_600n,
    })
    expect(m.venue).toBe('aave-reserve')
    expect(m.totalSupply).toBe(1_000_000)
    expect(m.liquidity).toBe(100_000)
    expect(m.utilization).toBeCloseTo(0.9)
    expect(m.supplyApr).toBeCloseTo(0.045, 12)
    expect(m.borrowApr).toBeCloseTo(0.055, 12)
    expect(m.fee).toBe(0.1)
    expect(m.deficit).toBe(2.5)
    expect(m.lastUpdate).toBe(1_000)
    expect(m.blockTs).toBe(1_600)
  })
  it('never reads a negative liquidity, and an unread deficit stays null', () => {
    const m = aaveReserveLendMarket({
      symbol: 'X',
      token: USDC,
      decimals: 6,
      priceUsd: 1,
      words: { totalAToken: 5n, totalStableDebt: 3n, totalVariableDebt: 3n, liquidityRate: 0n, variableBorrowRate: 0n, lastUpdateTimestamp: 0 },
      reserveFactorBps: 0n,
      deficitRaw: null,
      block: 1n,
      blockTs: null,
    })
    expect(m.liquidity).toBe(0)
    expect(m.utilization).toBe(1)
    expect(m.deficit).toBeNull()
    expect(m.blockTs).toBeNull()
  })
})

describe('cometLendMarket', () => {
  it('annualises the per-second supply rate and reads negative reserves as uncovered bad debt', () => {
    const perSec = (apr: number) => BigInt(Math.round((apr / 31_536_000) * 1e18))
    const m = cometLendMarket({
      name: 'cUSDCv3',
      symbol: 'USDC',
      token: USDC,
      decimals: 6,
      priceUsd: 1,
      totalSupplyRaw: 2_000_000_000n,
      totalBorrowRaw: 1_500_000_000n,
      supplyRatePerSec: perSec(0.04),
      borrowApr: 0.05,
      reservesRaw: -10_000_000n,
      lastAccrualTime: 99,
      block: 7n,
      blockTs: 100n,
    })
    expect(m.venue).toBe('comet')
    expect(m.liquidity).toBe(500)
    expect(m.utilization).toBeCloseTo(0.75)
    expect(m.supplyApr).toBeCloseTo(0.04, 6)
    expect(m.borrowApr).toBe(0.05)
    expect(m.fee).toBeNull()
    expect(m.deficit).toBe(10)
    expect(m.marketName).toBe('cUSDCv3')
    const ok = cometLendMarket({ ...{ name: 'c', symbol: 'U', token: USDC, decimals: 6, priceUsd: 1, totalSupplyRaw: 1n, totalBorrowRaw: 0n, supplyRatePerSec: null, borrowApr: null, reservesRaw: 5n, lastAccrualTime: 0, block: 1n, blockTs: null } })
    expect(ok.deficit).toBe(0)
    expect(ok.supplyApr).toBeNull()
  })
})

describe('MetaMorpho vaults', () => {
  it('lists held vaults largest first, skips zero shares, caps the count, counts V2, and reads "no results" as none', () => {
    const pos = (address: string, shares: string | number, usd: number) => ({ vault: { address }, state: { shares, assetsUsd: usd } })
    const a = (i: number) => `0x${String(i).padStart(40, '0')}`
    const d = parseVaultDiscovery({
      data: {
        userByAddress: {
          vaultPositions: [pos(a(1), '10', 5), pos(a(2), 0, 100), pos(a(3), '7', 50), pos(a(1), '10', 5)],
          vaultV2Positions: [{}, {}],
        },
      },
    })
    expect(d.vaults).toEqual([a(3), a(1)])
    expect(d.v2).toBe(2)
    const many = parseVaultDiscovery({
      data: { userByAddress: { vaultPositions: Array.from({ length: MAX_VAULTS + 3 }, (_, i) => pos(a(i + 1), '1', i)), vaultV2Positions: [] } },
    })
    expect(many.vaults).toHaveLength(MAX_VAULTS)
    expect(many.cut).toBe(3)
    expect(parseVaultDiscovery({ errors: [{ message: 'No results matching given parameters' }] })).toEqual({ vaults: [], cut: 0, v2: 0 })
    expect(() => parseVaultDiscovery({ errors: [{ message: 'boom' }] })).toThrow(/boom/)
    expect(() => parseVaultDiscovery({ data: { userByAddress: {} } })).toThrow(/vaultPositions/)
  })

  it("takes from each queue market at most that market's liquidity", () => {
    const full = allocationOf({
      marketId: '0x01',
      label: 'wstETH/USDC 86%',
      decimals: 6,
      // shares 1e6 × (assets+1)/(shares+1e6): the vault holds ~half the market.
      vaultSupplyShares: 500_000_000_000n,
      totalSupplyAssets: 1_000_000_000n,
      totalSupplyShares: 1_000_000_000_000n,
      totalBorrowAssets: 900_000_000n,
    })
    expect(full.assets).toBeCloseTo(500, 3)
    expect(full.marketLiquidity).toBe(100)
    expect(full.available).toBe(100)
    expect(full.utilization).toBeCloseTo(0.9)
    const idle = allocationOf({ marketId: '0x02', label: 'USDC idle market', decimals: 6, vaultSupplyShares: 200_000_000_000n, totalSupplyAssets: 200_000_000n, totalSupplyShares: 200_000_000_000n, totalBorrowAssets: 0n })
    expect(idle.available).toBeCloseTo(idle.assets, 6)
    const none = allocationOf({ marketId: '0x03', label: 'x', decimals: 6, vaultSupplyShares: 0n, totalSupplyAssets: 1n, totalSupplyShares: 1n, totalBorrowAssets: 0n })
    expect(none.assets).toBe(0)
    expect(vaultLiquidity([full, idle, none])).toBeCloseTo(100 + idle.assets, 6)
  })

  it('reads the vault as a lend market whose liquidity is its own and never above its assets', () => {
    const vault = {
      address: '0x0000000000000000000000000000000000000009' as const,
      name: 'V',
      assets: 10,
      maxWithdraw: 10,
      fee: 0.1,
      curator: null,
      owner: null,
      allocation: [{ marketId: '0x01' as const, label: 'a', assets: 600, marketLiquidity: 300, available: 300, utilization: 0.9 }],
    }
    const m = vaultLendMarket({ symbol: 'USDC', token: USDC, priceUsd: 1, totalAssets: 1_000, vault, block: 5n, blockTs: 50n })
    expect(m.venue).toBe('morpho-vault')
    expect(m.liquidity).toBe(300)
    expect(m.totalBorrow).toBe(700)
    expect(m.utilization).toBeCloseTo(0.7)
    expect(m.supplyApr).toBeNull()
    expect(m.fee).toBe(0.1)
    expect(vaultLendMarket({ symbol: 'USDC', token: USDC, priceUsd: 1, totalAssets: 100, vault, block: 5n, blockTs: null }).liquidity).toBe(100)
  })
})

describe('oracle gap', () => {
  it('scales a Morpho oracle price to whole loan per whole collateral', () => {
    // wstETH (18) priced in USDC (6) at 4,000: price = 4000 × 10^(36 + 6 − 18).
    expect(oraclePriceOf(4000n * 10n ** 24n, 18, 6)).toBeCloseTo(4000, 9)
    // WBTC (8) in USDC (6) at 100,000: 1e5 × 10^(36 + 6 − 8).
    expect(oraclePriceOf(100_000n * 10n ** 34n, 8, 6)).toBeCloseTo(100_000, 6)
  })

  it('places one block per day between the head and the anchor, oldest first', () => {
    const days = dailyBlocks({ number: 1_000_000n, ts: 30 * 86_400 }, { number: 1_000_000n - 216_000n, ts: 0 }, 30)
    expect(days).toHaveLength(31)
    expect(days[30]).toEqual({ day: 0, ts: 30 * 86_400, block: 1_000_000n })
    expect(days[0].block).toBe(1_000_000n - 216_000n)
    expect(days[29].block).toBe(1_000_000n - 7_200n)
  })

  it('measures a gap, and leaves a point unobserved without an oracle answer, a near price, or confidence', () => {
    const series = (p: number, conf = 0.99) => ({ confidence: conf, prices: [{ timestamp: 1_000, price: p }] })
    const ok = gapPoint({ ts: 1_000, block: 1n, oraclePrice: 4040, loan: series(1), collateral: series(4000) })
    expect(ok.gap).toBeCloseTo(0.01, 12)
    expect(gapPoint({ ts: 1_000, block: 1n, oraclePrice: null, loan: series(1), collateral: series(4000) }).why).toBe('no oracle answer')
    expect(gapPoint({ ts: 1_000 + 7 * 3600, block: 1n, oraclePrice: 4000, loan: series(1), collateral: series(4000) }).why).toBe('no market price')
    expect(gapPoint({ ts: 1_000, block: 1n, oraclePrice: 4000, loan: series(1, 0.85), collateral: series(4000) }).why).toBe('low confidence')
    expect(priceNear([{ timestamp: 0, price: 1 }, { timestamp: 100, price: 2 }], 90)).toBe(2)
  })

  it('parses DefiLlama coins by lowercased address and formats signed gaps', () => {
    const c = parseCoinsChart({ coins: { 'ethereum:0xAbC': { confidence: 0.99, prices: [{ timestamp: 2, price: 3 }, { timestamp: 1, price: 2 }, { timestamp: 3 }] } } })
    expect(c['0xabc'].prices).toEqual([
      { timestamp: 1, price: 2 },
      { timestamp: 2, price: 3 },
    ])
    expect(() => parseCoinsChart({})).toThrow(/no coins/)
    expect(fmtGap(0.0012)).toBe('+0.12%')
    expect(fmtGap(-0.034)).toBe('−3.4%')
    expect(fmtGap(0.25)).toBe('+25%')
    expect(gapSummary([{ ts: 0, block: 0n, gap: -0.001, oracleUsd: 1, marketUsd: 1 }, { ts: 1, block: 1n, gap: null, oracleUsd: null, marketUsd: null }])).toBe(
      '−0.10% to −0.10% over 1 of 2 days observed',
    )
    expect(gapSummary([])).toBeNull()
  })
})

describe('unobserved oracle points', () => {
  it('counts why points went unobserved', async () => {
    const { unobservedLine } = await import('@/lib/position/oracleGap')
    const p = (gap: number | null, why?: 'no market price' | 'no oracle answer') => ({ ts: 0, block: 0n, gap, oracleUsd: null, marketUsd: null, ...(why ? { why } : {}) })
    expect(unobservedLine([p(0.01), p(null, 'no market price'), p(null, 'no market price'), p(null, 'no oracle answer')])).toBe(
      '3 of 4 days unobserved: 2 no market price, 1 no oracle answer',
    )
    expect(unobservedLine([p(0)])).toBeNull()
  })
})
