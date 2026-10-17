/** Synthetic source responses exercise the real adapter and tracker; no product fixture data. */
import { describe, expect, it, vi } from 'vitest'

import { MORPHO_ADAPTIVE_CURVE_IRM } from '@/lib/netApy/venues'
import { buildCostReward } from '@/lib/position/costReward'
import { RATE_HISTORY } from '@/lib/position/rateHistory'
import { createMorphoBlueAdapter } from '@/lib/position-sim/adapters/morphoBlue'

vi.mock('@/lib/position-sim/adapters/morphoDiscovery', () => ({
  createMorphoDiscovery: () => async () => ({
    markets: [{ id: `0x${'ab'.repeat(32)}` }],
    complete: true,
    source: 'test market list',
    detail: 'test market list',
  }),
}))

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const ORACLE = '0x00000000000000000000000000000000000000a1'
const USER = '0x0000000000000000000000000000000000000001'
const BLOCK = 26_200_000n,
  NOW = 1_792_000_000n,
  WAD = 10n ** 18n
const AVG = 116_091_157_612n
const TARGET = 3_170_979_198n
const STORED = [
  1_000_000_000n,
  1_000_000_000_000n,
  1_000_000_000n,
  1_000_000_000_000n,
  NOW - 30n * 86_400n,
  WAD / 10n,
]

interface Options {
  usd?: number
  priceFailure?: boolean
  timestamp?: bigint | null
  target?: bigint | null
  average?: bigint | null
  irm?: string
  loan?: string
  lenderOnly?: boolean
}

async function read(options: Options = {}) {
  const irm = options.irm ?? MORPHO_ADAPTIVE_CURVE_IRM
  const loan = options.loan ?? USDC
  const seen: { name: string; block: bigint; args?: readonly unknown[] }[] = []
  const usdRequests: { tokens: string[]; block: bigint }[] = []
  const answer = (call: { address: string; functionName: string }) => {
    switch (call.functionName) {
      case 'position':
        return [
          500_000_000_000n,
          options.lenderOnly ? 0n : 100_000_000_000n,
          options.lenderOnly ? 0n : 10n * WAD,
        ]
      case 'market':
        return STORED
      case 'idToMarketParams':
        return [loan, WETH, ORACLE, irm, (WAD * 8n) / 10n]
      case 'getCurrentBlockTimestamp':
        return 'timestamp' in options ? options.timestamp : NOW
      case 'decimals':
        return call.address.toLowerCase() === WETH ? 18 : 6
      case 'symbol':
        return call.address.toLowerCase() === WETH ? 'WETH' : 'USDC'
      case 'price':
        return 2_000n * 10n ** 24n
      case 'borrowRateView':
        return 'average' in options ? options.average : AVG
      case 'rateAtTarget':
        return 'target' in options ? options.target : TARGET
      default:
        return undefined
    }
  }
  const client = {
    getBlockNumber: async () => BLOCK,
    multicall: async ({
      contracts,
      blockNumber,
    }: {
      contracts: { address: string; functionName: string; args?: readonly unknown[] }[]
      blockNumber: bigint
    }) =>
      contracts.map((call) => {
        seen.push({ name: call.functionName, block: blockNumber, args: call.args })
        const result = answer(call)
        return result === undefined || result === null
          ? { status: 'failure', error: new Error('test source unavailable') }
          : { status: 'success', result }
      }),
  }
  const positions = await createMorphoBlueAdapter({
    client: () => client as never,
    usdPrices: async (tokens, block) => {
      usdRequests.push({ tokens, block })
      if (options.priceFailure) throw new Error('test oracle unavailable')
      return { [WETH]: 2000, ...('usd' in options ? { [loan]: options.usd as number } : {}) }
    },
    referencePrices: async () => ({ prices: {}, error: null }),
  }).read(USER)
  return { position: positions[0], seen, usdRequests }
}

describe('Morpho current-rate source integration', () => {
  it('reads a depegged loan price at the same block and scales all dollar sides consistently', async () => {
    const measured = await read({ usd: 0.97 }),
      dollar = await read({ usd: 1 })
    const p = measured.position,
      baseline = dollar.position
    expect(measured.usdRequests[0]).toEqual({ tokens: [USDC, WETH], block: BLOCK })
    expect(measured.seen.every((call) => call.block === BLOCK)).toBe(true)
    expect(measured.seen.find((call) => call.name === 'rateAtTarget')?.args).toEqual([
      `0x${'ab'.repeat(32)}`,
    ])
    expect(p.usdValuationBasis).toBe('source-oracle')
    expect(p.debt[0].priceUsd).toBe(0.97)
    expect(p.totalDebtUsd / baseline.totalDebtUsd).toBeCloseTo(0.97)
    expect(p.totalCollateralUsd / baseline.totalCollateralUsd).toBeCloseTo(0.97)
    expect(p.supplied![0].valueUsd / baseline.supplied![0].valueUsd).toBeCloseTo(0.97)
    expect(p.healthFactor).toBeCloseTo(baseline.healthFactor)
    expect(p.ltv).toBeCloseTo(baseline.ltv)
    expect(p.provenance.detail).toContain('Loan token USDC priced at $0.97 from the Aave V3 oracle')
  })

  it('keeps average accrual/lender values while the tracker uses qualified instantaneous rates on both sides', async () => {
    const { position: p } = await read({ usd: 0.97 })
    expect(p.debt[0].borrowApr).toBeCloseTo(3.661050745, 8)
    expect(p.debt[0].borrowAprClock).toBe('market-update-average')
    expect(p.debt[0].currentBorrowApr).toBeCloseTo(8, 8)
    expect(p.supplied![0].supplyApr).toBeCloseTo(7.2, 8)
    expect(p.supplied![0].supplyAprFeeBasis).toBe('protocol-fee-net')
    expect(p.lendMarket!.supplyApr).toBeCloseTo(p.debt[0].borrowApr! * 0.9)
    const model = buildCostReward(p, RATE_HISTORY, {
      nowMs: Number(NOW) * 1000,
      observedAtMs: Number(NOW) * 1000,
      anchorState: 'ready',
    })
    expect(model.current.costUsdPerYear).toBeCloseTo(
      p.debt[0].valueUsd * p.debt[0].currentBorrowApr!,
    )
    expect(model.current.incomeUsdPerYear).toBeCloseTo(
      p.supplied![0].valueUsd * p.supplied![0].supplyApr!,
    )
    // Morpho fee shares dilute the user's accrued underlying once, independently of the current fee-net APR.
    const elapsed = NOW - STORED[4],
      first = AVG * elapsed
    const growth =
      first + (first * first) / (2n * WAD) + (((first * first) / (2n * WAD)) * first) / (3n * WAD)
    const interest = (STORED[2] * growth) / WAD,
      assets = STORED[0] + interest
    const feeAssets = interest / 10n,
      feeShares = (feeAssets * (STORED[1] + 1_000_000n)) / (assets - feeAssets + 1n)
    const userAssets = (500_000_000_000n * (assets + 1n)) / (STORED[1] + feeShares + 1_000_000n)
    expect(p.supplied![0].amount).toBe(Number(userAssets) / 1e6)
  })

  it.each([undefined, 0, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'keeps missing/invalid price %s as an explicit assumption and withholds dollars',
    async (usd) => {
      const { position: p } = await read({ usd })
      expect(p.usdValuationBasis).toBe('assumed-peg')
      expect(p.provenance.detail).toContain('loan token USDC treated as exactly $1.00')
      expect(
        buildCostReward(p, RATE_HISTORY, {
          nowMs: Number(NOW) * 1000,
          observedAtMs: Number(NOW) * 1000,
          anchorState: 'ready',
        }).current.costUsdPerYear,
      ).toBeNull()
    },
  )

  it('retains the named fallback after source failure and still reads a supply-only loan price', async () => {
    expect((await read({ priceFailure: true })).position.usdValuationBasis).toBe('assumed-peg')
    const { position: p, usdRequests } = await read({ usd: 0.97, lenderOnly: true })
    expect(usdRequests[0]).toEqual({ tokens: [USDC], block: BLOCK })
    expect(p.status).toBe('supply-only')
    expect(p.supplied![0].supplyApr).toBeCloseTo(7.2, 8)
  })

  it('does not apply a same-symbol stablecoin fallback to an unknown token address', async () => {
    await expect(read({ loan: '0x1111111111111111111111111111111111111111' })).rejects.toThrow(
      'no USD price',
    )
  })

  it.each([
    { timestamp: null },
    { target: null },
    { average: AVG + 1n },
    { irm: '0x1111111111111111111111111111111111111111' },
  ])('abstains from both instantaneous rates when qualification fails: %s', async (options) => {
    const { position: p } = await read({ ...options, usd: 0.97 })
    expect(p.debt[0].borrowApr).toBeCloseTo(3.661050745, 8)
    expect(p.debt[0].currentBorrowApr).toBeNull()
    expect(p.supplied![0].supplyApr).toBeNull()
    const model = buildCostReward(p, RATE_HISTORY, {
      nowMs: Number(NOW) * 1000,
      observedAtMs: Number(NOW) * 1000,
      anchorState: 'ready',
    })
    expect(model.current.costUsdPerYear).toBeNull()
    expect(model.current.incomeUsdPerYear).toBeNull()
  })
})
