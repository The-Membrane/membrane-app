import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAaveV3Adapter } from '@/lib/position-sim/adapters/aaveV3'
import { COMET_MAINNET_MARKETS, compoundV3Adapter } from '@/lib/position-sim/adapters/compoundV3'
import {
  MORPHO_BLUE_MAINNET,
  createMorphoBlueAdapter,
} from '@/lib/position-sim/adapters/morphoBlue'
import * as rpc from '@/lib/position-sim/rpc'

// Discovery chooses the market only. All financial values below still pass
// through each real adapter's pinned-block on-chain read.
vi.mock('@/lib/position-sim/adapters/morphoDiscovery', () => ({
  createMorphoDiscovery: () => async () => ({
    markets: [{ id: `0x${'ab'.repeat(32)}` }],
    complete: true,
    source: 'test market list',
    detail: 'test market list',
  }),
}))

type Hex = `0x${string}`
type Call = { address: string; functionName: string; args?: readonly unknown[] }
const USER = '0x0000000000000000000000000000000000000001' as Hex
const POOL = '0x0000000000000000000000000000000000000002' as Hex
const PROVIDER = '0x0000000000000000000000000000000000000003' as Hex
const DATA_PROVIDER = '0x0000000000000000000000000000000000000004' as Hex
const ORACLE = '0x0000000000000000000000000000000000000005' as Hex
const FEED = '0x0000000000000000000000000000000000000006' as Hex
const IRM = '0x0000000000000000000000000000000000000007' as Hex
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Hex
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Hex
const BLOCK = 26_200_000n
const TS = 1_792_000_000n
const RAY = 10n ** 27n
const WAD = 10n ** 18n

function chain(answer: (call: Call) => unknown) {
  const seen: { call: Call; block: bigint | undefined }[] = []
  const client = {
    getBlockNumber: vi.fn(async () => BLOCK),
    multicall: vi.fn(
      async ({ contracts, blockNumber }: { contracts: Call[]; blockNumber?: bigint }) =>
        contracts.map((call) => {
          seen.push({ call, block: blockNumber })
          const result = answer(call)
          return result === undefined
            ? { status: 'failure', error: new Error(`${call.functionName} reverted`) }
            : { status: 'success', result }
        }),
    ),
  }
  return { client: client as never, seen }
}

afterEach(() => vi.restoreAllMocks())

interface AaveRates {
  stable?: bigint
  variable?: bigint
  stableRate?: unknown
  reserve?: unknown
}

async function aaveRead(options: AaveRates = {}, id: 'aave-v3' | 'spark' = 'aave-v3') {
  const { stable = 100_000_000n, variable = 300_000_000n, stableRate = RAY / 25n } = options
  const reserve =
    'reserve' in options ? options.reserve : [0n, 0n, 0n, 0n, 0n, RAY / 50n, (RAY * 8n) / 100n]
  const stub = chain((call) => {
    switch (call.functionName) {
      case 'getPool':
        return POOL
      case 'getPoolDataProvider':
        return DATA_PROVIDER
      case 'getPriceOracle':
        return ORACLE
      case 'getUserAccountData':
        return [100_000_000_000n, (stable + variable) * 100n, 0n, 8000n, 7500n, 2n * WAD]
      case 'getAllReservesTokens':
        return [{ symbol: 'USDC', tokenAddress: USDC }]
      case 'BASE_CURRENCY_UNIT':
        return 100_000_000n
      // Deliberately different user liquidityRate: the new source is reserve index 5.
      case 'getUserReserveData':
        return [1_000_000_000n, stable, variable, stable, variable, stableRate, RAY / 2n, 0n, true]
      case 'getReserveConfigurationData':
        return [6n, 7500n, 8000n, 10500n, 1000n]
      case 'getReserveData':
        return reserve
      case 'getAssetsPrices':
        return [100_000_000n]
      case 'getUserEMode':
        return 0n
      default:
        throw new Error(`unexpected call: ${call.functionName}`)
    }
  })
  vi.spyOn(rpc, 'getMainnetClient').mockReturnValue(stub.client)
  const [position] = await createAaveV3Adapter({
    id,
    label: id === 'spark' ? 'Spark' : 'Aave V3',
    addressesProvider: PROVIDER,
  }).read(USER)
  return { position, seen: stub.seen }
}

describe('Aave/Spark current rate metadata', () => {
  it.each(['aave-v3', 'spark'] as const)(
    'reads %s reserve supply APR fee-net without a new call or changing blended debt APR',
    async (id) => {
      const { position, seen } = await aaveRead({}, id)
      expect(position).toMatchObject({
        chainId: 1,
        venueAddress: POOL,
        usdValuationBasis: 'source-oracle',
      })
      expect(position.collateral[0]).toMatchObject({
        supplyApr: 0.02,
        supplyAprFeeBasis: 'protocol-fee-net',
      })
      expect(position.collateral[0].supplyAprSource).toContain(
        'PoolDataProvider.getReserveData.liquidityRate',
      )
      // $300 variable at 8%, $100 user-stable at 4% = 7%, not the market stable rate.
      expect(position.debt[0]).toMatchObject({ borrowRateBasis: 'mixed' })
      expect(position.debt[0].borrowApr).toBeCloseTo(0.07, 14)
      expect(seen.filter(({ call }) => call.functionName === 'getReserveData')).toHaveLength(1)
      expect(new Set(seen.map(({ block }) => block))).toEqual(new Set([BLOCK]))
    },
  )

  it.each([
    { stable: 0n, variable: 400_000_000n, basis: 'variable', apr: 0.08 },
    { stable: 400_000_000n, variable: 0n, basis: 'fixed', apr: 0.04 },
  ])('classifies $basis from actual debt amounts', async ({ stable, variable, basis, apr }) => {
    const { position } = await aaveRead({ stable, variable })
    expect(position.debt[0].borrowRateBasis).toBe(basis)
    expect(position.debt[0].borrowApr).toBeCloseTo(apr, 14)
  })

  it('preserves zero and negative supply rates without a reserve-factor deduction', async () => {
    for (const supply of [0n, -RAY / 100n]) {
      const { position } = await aaveRead({ reserve: [0n, 0n, 0n, 0n, 0n, supply, RAY / 10n] })
      expect(position.collateral[0].supplyApr).toBe(supply === 0n ? 0 : -0.01)
    }
  })

  it.each([{ reserve: undefined }, { reserve: [] }, { reserve: [0n, 0n, 0n, 0n, 0n, 2, 'bad'] }])(
    'keeps unread or malformed optional rate data missing (case %#)',
    async ({ reserve }) => {
      const { position } = await aaveRead({ reserve })
      expect(position.collateral[0].supplyApr).toBeNull()
      expect(position.debt[0]).toMatchObject({ borrowApr: null, borrowRateBasis: 'mixed' })
    },
  )

  it('does not substitute the variable rate when the user stable rate is unreadable', async () => {
    const { position } = await aaveRead({ stableRate: 'bad' })
    expect(position.debt[0]).toMatchObject({ borrowApr: null, borrowRateBasis: 'mixed' })
  })

  it('keeps the user stable APR when the market rate call fails', async () => {
    const { position } = await aaveRead({ variable: 0n, reserve: undefined })
    expect(position.debt[0]).toMatchObject({ borrowApr: 0.04, borrowRateBasis: 'fixed' })
  })
})

describe('collateral protocol interest and variable debt', () => {
  it.each([1_000_000_000n, 'bad'])(
    'keeps Compound base borrowing separate from posted-collateral income (%s)',
    async (rate) => {
      const active = COMET_MAINNET_MARKETS[0].address.toLowerCase()
      const stub = chain((call) => {
        switch (call.functionName) {
          case 'borrowBalanceOf':
            return call.address.toLowerCase() === active ? 400_000_000n : 0n
          case 'baseToken':
            return USDC
          case 'baseTokenPriceFeed':
            return FEED
          case 'numAssets':
            return call.address.toLowerCase() === active ? 1 : 0
          case 'getAssetInfo':
            return {
              asset: WETH,
              priceFeed: ORACLE,
              scale: WAD,
              borrowCollateralFactor: (WAD * 3n) / 4n,
              liquidateCollateralFactor: (WAD * 4n) / 5n,
              liquidationFactor: (WAD * 95n) / 100n,
            }
          case 'userCollateral':
            return [WAD, 0n]
          case 'getPrice':
            return call.args?.[0] === FEED ? 100_000_000n : 200_000_000_000n
          case 'decimals':
            return 6
          case 'symbol':
            return call.address === USDC ? 'USDC' : 'WETH'
          case 'getUtilization':
            return WAD / 2n
          case 'getBorrowRate':
            return rate
          default:
            throw new Error(`unexpected call: ${call.functionName}`)
        }
      })
      vi.spyOn(rpc, 'getMainnetClient').mockReturnValue(stub.client)
      const [position] = await compoundV3Adapter.read(USER)
      expect(position).toMatchObject({
        chainId: 1,
        venueAddress: COMET_MAINNET_MARKETS[0].address,
        usdValuationBasis: 'source-oracle',
      })
      expect(position.debt[0].borrowRateBasis).toBe('variable')
      expect(position.debt[0].borrowApr).toBe(rate === 'bad' ? null : 0.031536)
      expect(position.collateral[0]).toMatchObject({
        supplyApr: 0,
        supplyAprFeeBasis: 'protocol-fee-net',
      })
      expect(position.collateral[0].supplyAprSource).toContain(
        'posted collateral earns no protocol supply interest',
      )
    },
  )

  it.each([1_000_000_000n, 'bad'])(
    'keeps Morpho collateral distinct from its loan-token supply (%s)',
    async (rate) => {
      const stub = chain((call) => {
        switch (call.functionName) {
          case 'position':
            return [1_000_000_000n, 1_000_000_000n, WAD]
          case 'market':
            return [1_000_000_000n, 1_000_000_000n, 500_000_000n, 1_000_000_000n, TS, 0n]
          case 'idToMarketParams':
            return [USDC, WETH, ORACLE, IRM, (WAD * 4n) / 5n]
          case 'getCurrentBlockTimestamp':
            return TS
          case 'decimals':
            return call.address === USDC ? 6 : 18
          case 'symbol':
            return call.address === USDC ? 'USDC' : 'WETH'
          case 'price':
            return 2_000n * 10n ** 24n
          case 'borrowRateView':
            return rate
          default:
            throw new Error(`unexpected call: ${call.functionName}`)
        }
      })
      const [position] = await createMorphoBlueAdapter({
        client: () => stub.client,
        usdPrices: async () => ({ [WETH]: 2000 }),
        referencePrices: async () => ({ prices: {}, error: null }),
      }).read(USER)
      expect(position).toMatchObject({
        chainId: 1,
        venueAddress: MORPHO_BLUE_MAINNET,
        usdValuationBasis: 'assumed-peg',
      })
      expect(position.debt[0].borrowRateBasis).toBe('variable')
      expect(position.debt[0].borrowApr).toBe(rate === 'bad' ? null : 0.031536)
      expect(position.collateral[0]).toMatchObject({
        supplyApr: 0,
        supplyAprFeeBasis: 'protocol-fee-net',
      })
      expect(position.collateral[0].supplyAprSource).toContain(
        'posted collateral earns no protocol supply interest',
      )
      // Its separate lender balance is not enriched using borrow APR × utilization.
      expect(position.supplied?.[0]).not.toHaveProperty('supplyApr')
    },
  )
})
