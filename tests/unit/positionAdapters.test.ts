// Adapter fixes the /position page depends on: every Compound V3 Comet priced in USD whatever
// its quote unit, and Aave/Spark e-mode thresholds read per asset (both on-chain layouts). The e-mode
// reader runs against a stub multicall client; no network. Every read pins one block.

import { describe, expect, it } from 'vitest'

import {
  BASE_IN_QUOTE_RANGE,
  COMET_MAINNET_MARKETS,
  checkBaseInQuote,
  cometPriceUsd,
  inBitmap,
  readEModeThresholds,
} from '@/lib/position-sim/adapters'

describe('Compound V3 quote currency', () => {
  it('lists all six mainnet Comets with their quote unit and USD feed', () => {
    const by = Object.fromEntries(COMET_MAINNET_MARKETS.map((m) => [m.name, m]))
    expect(Object.keys(by).sort()).toEqual(['cUSDCv3', 'cUSDSv3', 'cUSDTv3', 'cWBTCv3', 'cWETHv3', 'cwstETHv3'])
    expect(by.cUSDCv3).toMatchObject({ quote: 'USD', quoteUsdFeed: null })
    expect(by.cUSDTv3).toMatchObject({ quote: 'USD', quoteUsdFeed: null })
    expect(by.cUSDSv3).toMatchObject({ address: '0x5D409e56D886231aDAf00c8775665AD0f9897b56', quote: 'USD', quoteUsdFeed: null })
    expect(by.cWETHv3).toMatchObject({ quote: 'ETH', quoteUsdFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' })
    expect(by.cwstETHv3).toMatchObject({
      address: '0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3',
      quote: 'wstETH',
      quoteUsdFeed: '0xA2699232B341881B1Ed85d91592b7c259E029aCf',
    })
    expect(by.cWBTCv3).toMatchObject({
      address: '0xe85Dc543813B8c2CFEaAc371517b925a166a9293',
      quote: 'BTC',
      quoteUsdFeed: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    })
  })

  it('converts a 1e8 Comet price in its quote unit to USD', () => {
    // cWETHv3, 2026-10-14: wstETH / ETH CAPO 1.24624114 at ETH/USD 2,501.95 → $3,118.03.
    expect(cometPriceUsd(124_624_114n, 2501.95)).toBeCloseTo(3118.033, 3)
    // Its WETH base is the constant 1 ETH.
    expect(cometPriceUsd(100_000_000n, 2501.95)).toBeCloseTo(2501.95, 9)
    // A USD Comet (cUSDCv3, cUSDSv3) is unchanged.
    expect(cometPriceUsd(99_981_588n, 1)).toBeCloseTo(0.99981588, 12)
    expect(() => cometPriceUsd(100_000_000n, 0)).toThrow()
  })

  it('cwstETHv3 (wstETH-quoted): rsETH / wstETH at wstETH/USD lands on cUSDCv3’s own rsETH/USD', () => {
    // 2026-10-14: rsETH / wstETH CAPO 0.86827105, wstETH/USD CAPO SVR 3,130.71518788;
    // cUSDCv3 prices rsETH at 2,718.30939667 from its own USD feed.
    expect(cometPriceUsd(86_827_105n, 3130.71518788)).toBeCloseTo(2718.3, 0)
    expect(Math.abs(cometPriceUsd(86_827_105n, 3130.71518788) / 2718.30939667 - 1)).toBeLessThan(1e-4)
    // The wstETH base is the constant 1 wstETH.
    expect(cometPriceUsd(100_000_000n, 3130.71518788)).toBeCloseTo(3130.71518788, 6)
  })

  it('cWBTCv3 (BTC-quoted): its WBTC base is WBTC / BTC, not 1', () => {
    // 2026-10-14: WBTC / BTC 0.9984988, LBTC / BTC 1.00237524, BTC/USD 83,594.32226006.
    expect(cometPriceUsd(99_849_880n, 83594.32226006)).toBeCloseTo(83468.83, 1)
    expect(cometPriceUsd(100_237_524n, 83594.32226006)).toBeCloseTo(83792.88, 1)
  })

  it('the base priced near 1 quote unit is the check that the quote unit is right', () => {
    expect(() => checkBaseInQuote({ name: 'cUSDCv3', quote: 'USD' }, 99_981_588n)).not.toThrow()
    expect(() => checkBaseInQuote({ name: 'cUSDSv3', quote: 'USD' }, 99_982_933n)).not.toThrow()
    expect(() => checkBaseInQuote({ name: 'cWETHv3', quote: 'ETH' }, 100_000_000n)).not.toThrow()
    expect(() => checkBaseInQuote({ name: 'cwstETHv3', quote: 'wstETH' }, 100_000_000n)).not.toThrow()
    expect(() => checkBaseInQuote({ name: 'cWBTCv3', quote: 'BTC' }, 99_849_880n)).not.toThrow()
    // A USD feed where ETH was expected: WETH at $2,512 is not ~1 ETH.
    expect(() => checkBaseInQuote({ name: 'cWETHv3', quote: 'ETH' }, 251_212_633_111n)).toThrow(/quote unit is not ETH/)
    // A BTC-quoted market read as USD: WBTC at 0.9985 "USD".
    expect(() => checkBaseInQuote({ name: 'cWBTCv3', quote: 'BTC' }, 8_352_176_861_319n)).toThrow(/quote unit is not BTC/)
    expect(BASE_IN_QUOTE_RANGE).toEqual({ min: 0.9, max: 1.1 })
  })
})

// ------------------------------------------------------------------ e-mode

type Entry = { status: 'success'; result: unknown } | { status: 'failure'; error: Error }
type Call = { functionName: string; args?: readonly unknown[] }

/** Blocks every stub multicall was asked to read. */
let blocksSeen: (bigint | undefined)[] = []

/** A stub viem client: every multicall leg answers from `respond`, or fails. */
const client = (respond: (c: Call) => unknown) =>
  ({
    multicall: async ({ contracts, blockNumber }: { contracts: Call[]; blockNumber?: bigint }): Promise<Entry[]> =>
      (blocksSeen.push(blockNumber), contracts).map((c) => {
        const r = respond(c)
        return r === undefined ? { status: 'failure', error: new Error(`${c.functionName} reverted`) } : { status: 'success', result: r }
      }),
  }) as never

const POOL = '0x0000000000000000000000000000000000000001' as const
const DP = '0x0000000000000000000000000000000000000002' as const
const USER = '0x0000000000000000000000000000000000000003' as const
const PT = '0x00000000000000000000000000000000000000aa' as const
const USDC = '0x00000000000000000000000000000000000000bb' as const
const BLOCK = 23_571_000n

/** The read's input: PT and USDC as collateral, both with a non-zero reserve threshold. */
const input = (c: ReturnType<typeof client>, tag = 'aave v3', reserveLt: Record<string, number> = {}) => ({
  client: c,
  block: BLOCK,
  pool: POOL,
  dataProvider: DP,
  user: USER,
  collateral: [PT, USDC].map((token) => ({ token, reserveLt: reserveLt[token] ?? 0.75 })),
  tag,
})

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
    blocksSeen = []
    const e = await readEModeThresholds(input(c))
    expect(e?.category).toBe(47)
    expect(e?.layout).toBe('v3.2 bitmap')
    expect(e?.inCategory.get(PT)).toEqual({ lt: 0.92, ltv: 0.9 })
    expect(e?.inCategory.has(USDC)).toBe(false)
    // Every multicall of the read asked for the read's one block.
    expect(blocksSeen.length).toBeGreaterThan(1)
    expect(new Set(blocksSeen)).toEqual(new Set([BLOCK]))
  })

  it('v3.2 layout: a zero-threshold reserve on the bitmap takes the category threshold (GenericLogic 3.2+)', async () => {
    const c = client((x) => {
      if (x.functionName === 'getUserEMode') return 47n
      if (x.functionName === 'getEModeCategoryCollateralConfig') return { ltv: 9000, liquidationThreshold: 9200, liquidationBonus: 10420 }
      if (x.functionName === 'getEModeCategoryCollateralBitmap') return 73_786_976_299_133_173_760n
      if (x.functionName === 'getReserveData') return { id: x.args?.[0] === PT ? 66 : 3 }
      return undefined
    })
    const e = await readEModeThresholds(input(c, 'aave v3', { [PT]: 0 }))
    expect(e?.inCategory.get(PT)).toEqual({ lt: 0.92, ltv: 0.9 })
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
    const e = await readEModeThresholds(input(c, 'spark'))
    expect(e?.layout).toBe('v3.0 category')
    expect(e?.inCategory.get(PT)).toEqual({ lt: 0.93, ltv: 0.92 })
    expect(e?.inCategory.has(USDC)).toBe(false)
    expect(e?.priceSource).toBeNull()
  })

  it('v3.0 layout: an in-category reserve whose own threshold is 0 is skipped, as GenericLogic 3.0/3.1 does', async () => {
    const c = client((x) => {
      if (x.functionName === 'getUserEMode') return 1n
      if (x.functionName === 'getEModeCategoryData') {
        return { ltv: 9200, liquidationThreshold: 9300, liquidationBonus: 10100, priceSource: '0x0000000000000000000000000000000000000000', label: 'ETH' }
      }
      if (x.functionName === 'getReserveEModeCategory') return 1n // both in category 1
      return undefined
    })
    const e = await readEModeThresholds(input(c, 'spark', { [PT]: 0 }))
    expect(e?.inCategory.has(PT)).toBe(false)
    expect(e?.inCategory.get(USDC)).toEqual({ lt: 0.93, ltv: 0.92 })
  })

  it('not in e-mode: null, and the reserve thresholds stand', async () => {
    const c = client((x) => (x.functionName === 'getUserEMode' ? 0n : undefined))
    expect(await readEModeThresholds(input(c))).toBeNull()
  })

  it('in a category neither layout answers for: throws rather than fall back', async () => {
    const c = client((x) => (x.functionName === 'getUserEMode' ? 5n : undefined))
    await expect(readEModeThresholds(input(c))).rejects.toThrow(/e-mode category 5/)
  })
})
