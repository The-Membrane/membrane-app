import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import {
  createPublicClient,
  custom,
  parseAbi,
  decodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  toFunctionSelector,
} from 'viem'
import { mainnet } from 'viem/chains'
import { ROUTES } from '@/components/Carry/fixtures'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import config from '@/tools/venue-recorder.config.json'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import { buildCanonicalAtomicHolderExitSubjects } from '@/lib/carry/holderExitMechanisms'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
const subjects = buildCanonicalAtomicHolderExitSubjects(
  buildCarryForecastRegistry(
    ROUTES,
    seed,
    config.venues,
    '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    verifiedDirectSupplyDestinations(),
  ),
)
const NOW = Date.parse('2026-10-07T10:00:00.000Z')
const owner = '0x0000000000000000000000000000000000000001'
const pin = {
  mode: 'internal_historical_finalized_block',
  blockNumber: 100n,
  blockHash: `0x${'a'.repeat(64)}`,
} as const
const hashRef = { blockHash: pin.blockHash, requireCanonical: true }
const ABI = parseAbi([
  'function asset() view returns(address)',
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function maxRedeem(address) view returns(uint256)',
  'function maxWithdraw(address) view returns(uint256)',
  'function totalAssets() view returns(uint256)',
  'function paused() view returns(bool)',
  'function previewRedeem(uint256) view returns(uint256)',
  'function previewWithdraw(uint256) view returns(uint256)',
  'function withdraw(uint256,address,address) returns(uint256)',
  'function withdraw(address,uint256,address) returns(uint256)',
  'function withdraw(address,uint256)',
  'function UNDERLYING_ASSET_ADDRESS() view returns(address)',
  'function baseToken() view returns(address)',
  'function getReserveData(address) view returns((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
])
function fixture(
  s = subjects[0],
  options: {
    hash?: string
    timestamp?: number
    wrongAsset?: boolean
    wrongDecimals?: boolean
    changedAfter?: boolean
  } = {},
) {
  const wire: any[] = []
  let targetHeaders = 0
  const asset = s.canonicalFinalAsset!
  const decimals = asset.decimals
  const transport = custom(
    {
      request: async (p: any) => {
        wire.push(p)
        if (p.method === 'eth_chainId') return '0x1'
        if (p.method === 'eth_getBlockByNumber') {
          const finalized = p.params[0] === 'finalized'
          if (!finalized) targetHeaders++
          return {
            number: finalized ? '0x6e' : '0x64',
            hash: finalized
              ? `0x${'b'.repeat(64)}`
              : options.changedAfter && targetHeaders === 3
                ? `0x${'c'.repeat(64)}`
                : (options.hash ?? pin.blockHash),
            timestamp: `0x${Math.floor((options.timestamp ?? NOW - (finalized ? 12000 : 60000)) / 1000).toString(16)}`,
          }
        }
        if (p.method === 'eth_getCode')
          return p.params[0].toLowerCase() === owner ? '0x' : '0x60006000'
        if (p.method === 'eth_getStorageAt')
          return `0x${'0'.repeat(24)}d1f1c3f485063712873285bf4ef25ab068f13893`
        if (p.method === 'eth_call') {
          const tx = p.params[0]
          const decoded = decodeFunctionData({ abi: ABI, data: tx.data })
          const name = decoded.functionName
          if (['asset', 'UNDERLYING_ASSET_ADDRESS', 'baseToken'].includes(name))
            return encodeAbiParameters(
              [{ type: 'address' }],
              [options.wrongAsset ? owner : (asset.address as `0x${string}`)],
            )
          if (name === 'decimals')
            return encodeAbiParameters(
              [{ type: 'uint8' }],
              [options.wrongDecimals ? decimals + 1 : decimals],
            )
          if (name === 'paused') return encodeAbiParameters([{ type: 'bool' }], [false])
          if (name === 'getReserveData')
            return encodeFunctionResult({
              abi: ABI,
              functionName: 'getReserveData',
              result: {
                configuration: 0n,
                liquidityIndex: 0n,
                currentLiquidityRate: 0n,
                variableBorrowIndex: 0n,
                currentVariableBorrowRate: 0n,
                currentStableBorrowRate: 0n,
                lastUpdateTimestamp: 0,
                id: 0,
                aTokenAddress: s.destinationAddress as `0x${string}`,
                stableDebtTokenAddress: owner,
                variableDebtTokenAddress: owner,
                interestRateStrategyAddress: owner,
                accruedToTreasury: 0n,
                unbacked: 0n,
                isolationModeTotalDebt: 0n,
              },
            })
          if (name === 'withdraw') {
            expect(tx.from.toLowerCase()).toBe(owner)
            const args: any = decoded.args
            if (tx.data.startsWith(toFunctionSelector('withdraw(uint256,address,address)'))) {
              expect(args).toEqual([1000000n, owner, owner])
            } else {
              expect(args[0].toLowerCase()).toBe(asset.address)
              expect(args[1]).toBe(1000000n)
              if (args.length === 3) expect(args[2].toLowerCase()).toBe(owner)
            }
            return args.length === 2 ? '0x' : encodeAbiParameters([{ type: 'uint256' }], [1000000n])
          }
          return encodeAbiParameters(
            [{ type: 'uint256' }],
            [name === 'previewWithdraw' ? 1000000n : 10000000n],
          )
        }
        throw new Error('unexpected offline RPC method')
      },
    },
    { retryCount: 0 },
  )
  const client = createPublicClient({ chain: mainnet, transport, batch: { multicall: true } })
  return { wire, clients: { direct: client, apy: client, morpho: client, tracked: client } }
}
const input = (s = subjects[0]) => ({
  routeKey: s.routeKey,
  destinationAddress: s.destinationAddress as `0x${string}`,
  owner: owner as `0x${string}`,
  assetsRaw: '1000000',
  horizonHours: 24,
})
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW))
afterEach(() => vi.restoreAllMocks())
describe('actual SDK wire pin for every registered native atomic adapter', () => {
  it.each(subjects.map((s) => [s.routeKey, s.destinationAddress, s] as const))(
    'pins full exactQ execution and every getter/code for %s/%s',
    async (_r, _d, s) => {
      const f = fixture(s)
      const r = await readHolderExitAssessment(f.clients, input(s), { atomicFinalizedBlock: pin })
      expect({ ...r.finalPayout, assetAddress: r.finalPayout.assetAddress.toLowerCase() }).toEqual({
        assetAddress: s.canonicalFinalAsset!.address,
        status: 'simulated',
        amountRaw: '1000000',
      })
      expect(r.source).toMatchObject({
        blockNumber: 100,
        blockHash: pin.blockHash,
        blockTime: new Date(NOW - 60000).toISOString(),
      })
      const reads = f.wire.filter((p) =>
        ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(p.method),
      )
      expect(reads.length).toBeGreaterThan(2)
      for (const p of reads)
        expect(p.params[p.method === 'eth_getStorageAt' ? 2 : 1]).toEqual(hashRef)
      expect(f.wire.some((p) => p.method === 'eth_call' && p.params[1] === 'latest')).toBe(false)
    },
  )
  it.each(['tracked', 'sgho', 'morpho', 'susds', 'usd3', 'direct'] as const)(
    'rejects independently wrong header before getter for %s',
    async (kind) => {
      const routes: any = {
        tracked: 'USDS → StUsds [USDS]',
        sgho: 'GHO → sGho [GHO]',
        morpho: 'USDC → VaultV2 [USDC]',
        susds: 'USDS → SUsds [USDS]',
        usd3: 'USDC → USD3 [USDC]',
        direct: 'USDe → supply on Aave V3',
      }
      const s = subjects.find((s) => s.routeKey === routes[kind])!
      const f = fixture(s, { hash: `0x${'c'.repeat(64)}` })
      await expect(
        readHolderExitAssessment(f.clients, input(s), { atomicFinalizedBlock: pin }),
      ).rejects.toThrow()
      expect(f.wire.some((p) => p.method === 'eth_call')).toBe(false)
    },
  )
  it('rejects a Morpho live decimal getter that disagrees with canonical native payout units', async () => {
    const s = subjects.find((s) => s.routeKey === 'USDC → VaultV2 [USDC]')!
    const f = fixture(s, { wrongDecimals: true })
    await expect(
      readHolderExitAssessment(f.clients, input(s), { atomicFinalizedBlock: pin }),
    ).rejects.toThrow('holder_exit_atomic_units_mismatch')
  })
  it.each(['tracked', 'sgho'] as const)(
    'verifies actual finalized ceiling and header stability for newly pinnable %s',
    async (kind) => {
      const s = subjects.find(
        (s) => s.routeKey === (kind === 'tracked' ? 'USDS → StUsds [USDS]' : 'GHO → sGho [GHO]'),
      )!
      let f = fixture(s)
      await expect(
        readHolderExitAssessment(f.clients, input(s), {
          atomicFinalizedBlock: { ...pin, blockNumber: 111n },
        }),
      ).rejects.toThrow()
      expect(f.wire.some((p) => p.method === 'eth_call')).toBe(false)
      f = fixture(s, { changedAfter: true })
      await expect(
        readHolderExitAssessment(f.clients, input(s), { atomicFinalizedBlock: pin }),
      ).rejects.toThrow('block_hash_changed')
    },
  )
})
