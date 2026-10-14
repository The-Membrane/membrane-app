// Adapter fixes the /position page depends on: Compound V3's ETH-quoted Comet converted to
// USD, and Aave/Spark e-mode thresholds read per asset (both on-chain layouts). The e-mode
// reader runs against a stub multicall client; no network.

import { describe, expect, it } from 'vitest'

import { COMET_MAINNET_MARKETS, cometPriceUsd, inBitmap, readEModeThresholds } from '@/lib/position-sim/adapters'

describe('Compound V3 quote currency', () => {
  it('declares cWETHv3 as ETH-quoted, converted at Chainlink ETH/USD; the stable Comets as USD', () => {
    const by = Object.fromEntries(COMET_MAINNET_MARKETS.map((m) => [m.name, m]))
    expect(by.cWETHv3).toMatchObject({ quote: 'ETH', quoteUsdFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' })
    expect(by.cUSDCv3).toMatchObject({ quote: 'USD', quoteUsdFeed: null })
    expect(by.cUSDTv3).toMatchObject({ quote: 'USD', quoteUsdFeed: null })
  })

  it('converts a 1e8 Comet price in its quote unit to USD', () => {
    // cWETHv3, 2026-10-14: wstETH / ETH CAPO 1.24624114 at ETH/USD 2,501.95 → $3,118.03.
    expect(cometPriceUsd(124_624_114n, 2501.95)).toBeCloseTo(3118.033, 3)
    // Its WETH base is the constant 1 ETH.
    expect(cometPriceUsd(100_000_000n, 2501.95)).toBeCloseTo(2501.95, 9)
    // A USD Comet is unchanged.
    expect(cometPriceUsd(99_981_588n, 1)).toBeCloseTo(0.99981588, 12)
    expect(() => cometPriceUsd(100_000_000n, 0)).toThrow()
  })
})

// ------------------------------------------------------------------ e-mode

type Entry = { status: 'success'; result: unknown } | { status: 'failure'; error: Error }
type Call = { functionName: string; args?: readonly unknown[] }

/** A stub viem client: every multicall leg answers from `respond`, or fails. */
const client = (respond: (c: Call) => unknown) =>
  ({
    multicall: async ({ contracts }: { contracts: Call[] }): Promise<Entry[]> =>
      contracts.map((c) => {
        const r = respond(c)
        return r === undefined ? { status: 'failure', error: new Error(`${c.functionName} reverted`) } : { status: 'success', result: r }
      }),
  }) as never

const POOL = '0x0000000000000000000000000000000000000001' as const
const DP = '0x0000000000000000000000000000000000000002' as const
const USER = '0x0000000000000000000000000000000000000003' as const
const PT = '0x00000000000000000000000000000000000000aa' as const
const USDC = '0x00000000000000000000000000000000000000bb' as const

describe('e-mode thresholds', () => {
  it('reads the bit for a reserve id', () => {
    // Category 47's bitmap on 2026-10-14: PT-srUSDe-22OCT2026 is reserve 66.
    expect(inBitmap(73_786_976_299_133_173_760n, 66)).toBe(true)
    expect(inBitmap(73_786_976_299_133_173_760n, 3)).toBe(false)
  })

  it('v3.2 layout: category config + collateral bitmap by reserve id', async () => {
    const c = client((x) => {
      if (x.functionName === 'getUserEMode') return 47n
      if (x.functionName === 'getEModeCategoryCollateralConfig') return { ltv: 9000, liquidationThreshold: 9200, liquidationBonus: 10420 }
      if (x.functionName === 'getEModeCategoryCollateralBitmap') return 73_786_976_299_133_173_760n
      if (x.functionName === 'getReserveData') return { id: x.args?.[0] === PT ? 66 : 3 }
      return undefined
    })
    const e = await readEModeThresholds(c, POOL, DP, USER, [PT, USDC], 'aave v3')
    expect(e?.category).toBe(47)
    expect(e?.layout).toBe('v3.2 bitmap')
    expect(e?.inCategory.get(PT)).toEqual({ lt: 0.92, ltv: 0.9 })
    expect(e?.inCategory.has(USDC)).toBe(false)
  })

  it('v3.0 layout (Spark): category data + each asset’s own category', async () => {
    const c = client((x) => {
      if (x.functionName === 'getUserEMode') return 1n
      if (x.functionName === 'getEModeCategoryData') {
        return { ltv: 9200, liquidationThreshold: 9300, liquidationBonus: 10100, priceSource: '0x0000000000000000000000000000000000000000', label: 'ETH' }
      }
      if (x.functionName === 'getReserveEModeCategory') return x.args?.[0] === PT ? 1n : 2n
      return undefined // the v3.2 views revert on Spark
    })
    const e = await readEModeThresholds(c, POOL, DP, USER, [PT, USDC], 'spark')
    expect(e?.layout).toBe('v3.0 category')
    expect(e?.inCategory.get(PT)).toEqual({ lt: 0.93, ltv: 0.92 })
    expect(e?.inCategory.has(USDC)).toBe(false)
    expect(e?.priceSource).toBeNull()
  })

  it('not in e-mode: null, and the reserve thresholds stand', async () => {
    const c = client((x) => (x.functionName === 'getUserEMode' ? 0n : undefined))
    expect(await readEModeThresholds(c, POOL, DP, USER, [PT], 'aave v3')).toBeNull()
  })

  it('in a category neither layout answers for: throws rather than fall back', async () => {
    const c = client((x) => (x.functionName === 'getUserEMode' ? 5n : undefined))
    await expect(readEModeThresholds(c, POOL, DP, USER, [PT], 'aave v3')).rejects.toThrow(/e-mode category 5/)
  })
})
