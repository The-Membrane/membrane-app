import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, type AbiParameter } from 'viem'
import { FLUID_USDC_BRIDGE_NATIVE_ABI } from '@/lib/carry/fluidUsdcBridgeNativeAbi'
import {
  readFluidUsdcBridgeNativeCapacityFact,
  replayFluidUsdcBridgeNativeCapacityFact,
  FLUID_USDC_BRIDGE_NATIVE_VAULT,
  FLUID_USDC_BRIDGE_NATIVE_ASSET,
  FLUID_USDC_BRIDGE_IMPLEMENTATION,
  FLUID_USDC_BRIDGE_FUSDC,
  FLUID_USDC_BRIDGE_BANK,
  FLUID_USDC_BRIDGE_NATIVE_ROUTE,
} from '@/lib/carry/fluidUsdcBridgeNativeCapacity'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
  resolveHolderExitCapacitySubject,
} from '@/lib/carry/holderExitCapacity'
import { resolveIssuedHolderExitSubject } from '@/lib/carry/holderExitMechanisms'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'

const NOW = Date.parse('2026-10-08T12:00:00.000Z'),
  owner = '0x1234567890123456789012345678901234567890'
const source = {
  chainId: 1 as const,
  blockNumber: 26000000,
  blockHash: `0x${'a'.repeat(64)}`,
  blockTime: new Date(NOW - 60000).toISOString(),
  finalized: true as const,
}
function zero(parameter: AbiParameter): unknown {
  if (parameter.type === 'tuple')
    return (parameter as AbiParameter & { components: AbiParameter[] }).components.map(zero)
  if (parameter.type === 'address') return '0x' + '0'.repeat(40)
  if (parameter.type === 'bool') return false
  return 0n
}
function wire() {
  const requests: { method: string; params: unknown[] }[] = []
  const request = async (input: { method: string; params: unknown[] }) => {
    requests.push(structuredClone(input))
    if (input.method === 'eth_getCode') return '0x6000'
    if (input.method === 'eth_getStorageAt')
      return '0x' + '0'.repeat(24) + FLUID_USDC_BRIDGE_IMPLEMENTATION.slice(2)
    const call = input.params[0] as { to: string; data: `0x${string}` }
    const decoded = decodeFunctionData({ abi: FLUID_USDC_BRIDGE_NATIVE_ABI, data: call.data })
    let result: unknown
    switch (decoded.functionName) {
      case 'asset':
        result = FLUID_USDC_BRIDGE_NATIVE_ASSET
        break
      case 'decimals':
        result = call.to === FLUID_USDC_BRIDGE_NATIVE_VAULT ? 18 : 6
        break
      case 'getFUSDC':
        result = FLUID_USDC_BRIDGE_FUSDC
        break
      case 'getWithdrawalFeeBPS':
        result = 5n
        break
      case 'isWithdrawalsPaused':
        result = false
        break
      case 'balanceOf':
        result = call.to === FLUID_USDC_BRIDGE_NATIVE_VAULT ? 3000000000000000000n : 9000000n
        break
      case 'previewRedeem':
        expect(decoded.args).toEqual([3000000000000000000n])
        result = 7000000n
        break
      case 'maxWithdraw':
        expect(decoded.args?.map((v) => String(v).toLowerCase())).toEqual([
          FLUID_USDC_BRIDGE_NATIVE_VAULT,
        ])
        result = 5000000n
        break
      case 'LIQUIDITY':
        result = FLUID_USDC_BRIDGE_BANK
        break
      case 'getData':
        result = [
          FLUID_USDC_BRIDGE_BANK,
          ...Array(4).fill('0x' + '0'.repeat(40)),
          false,
          8000000n,
          1n,
          1n,
        ]
        break
      case 'getUserSupplyData': {
        expect(decoded.args?.map((v) => String(v).toLowerCase())).toEqual([
          FLUID_USDC_BRIDGE_FUSDC,
          FLUID_USDC_BRIDGE_NATIVE_ASSET,
        ])
        const abi = FLUID_USDC_BRIDGE_NATIVE_ABI.find(
          (a) => a.type === 'function' && a.name === 'getUserSupplyData',
        )!
        const outputs = (abi as unknown as { outputs: AbiParameter[] }).outputs
        const supply = zero(outputs[0]) as unknown[]
        supply[7] = 6000000n
        supply[8] = 5500000n
        result = [supply, zero(outputs[1])]
        break
      }
      default:
        throw Error('unexpected fixture native call')
    }
    return encodeFunctionResult({
      abi: FLUID_USDC_BRIDGE_NATIVE_ABI,
      functionName: decoded.functionName,
      result,
    } as never)
  }
  return { request, requests }
}
async function capture() {
  const fixture = wire(),
    fact = await readFluidUsdcBridgeNativeCapacityFact(fixture.request, owner, source, () => NOW)
  return { ...fixture, fact: fact! }
}
function quote(
  fact: Awaited<ReturnType<typeof capture>>['fact'],
  overrides: Partial<HolderExitAssessment> = {},
) {
  const assessment: HolderExitAssessment = {
    status: 'assessed',
    routeKey: FLUID_USDC_BRIDGE_NATIVE_ROUTE,
    destinationAddress: FLUID_USDC_BRIDGE_NATIVE_VAULT,
    owner,
    request: {
      assetsRaw: '1000000',
      assetAddress: FLUID_USDC_BRIDGE_NATIVE_ASSET,
      horizonHours: 24,
    },
    source: {
      ...source,
      blockHash: source.blockHash as `0x${string}`,
      originValidation: 'single_provider',
    },
    stages: [
      {
        name: 'withdrawal',
        assetAddress: FLUID_USDC_BRIDGE_NATIVE_ASSET,
        amountRaw: '1000000',
        relatedToRequest: true,
        status: 'reverted',
      },
    ],
    finalPayout: {
      assetAddress: FLUID_USDC_BRIDGE_NATIVE_ASSET,
      amountRaw: null,
      status: 'unassessed',
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    ...overrides,
  }
  return buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: fact.fullNetEaRaw,
      quotedMaxWithdrawRaw: '5000000',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
      sourceHolderPosition: {
        sharesRaw: fact.sharesRaw,
        shareDecimals: 18,
        method: 'balance_of_owner_at_source',
      },
      fluidUsdcBridgeNativeCapacity: fact,
    },
    NOW,
  )
}
describe('Fluid USDC bridge optional native capacity facts', () => {
  it('replays exact five-prong reads and actual full-S net entitlement at the source hash', async () => {
    const { fact, requests } = await capture()
    expect(fact).not.toBeNull()
    expect(fact.fullNetEaRaw).toBe('7000000')
    expect(fact.sharesRaw).toBe('3000000000000000000')
    expect(fact.nativeProngs).toEqual({
      bridgeFunding: '5000000',
      bankCash: '9000000',
      bankSupply: '8000000',
      bankWithdrawableUntilLimit: '6000000',
      bankResolverWithdrawable: '5500000',
    })
    expect(Object.keys(fact.runtimeCodeHashes)).toHaveLength(6)
    expect(
      requests.every(
        (r) => (r.params.at(-1) as { blockHash: string }).blockHash === source.blockHash,
      ),
    ).toBe(true)
    expect(replayFluidUsdcBridgeNativeCapacityFact(fact, owner, source, NOW)).toEqual(fact)
  })
  it.each(['fullEa', 'prong', 'shares', 'owner', 'source', 'fee', 'code', 'plan'] as const)(
    'rejects changed %s',
    async (kind) => {
      const { fact } = await capture(),
        changed = structuredClone(fact)
      if (kind === 'fullEa') changed.fullNetEaRaw = '1'
      if (kind === 'prong') changed.nativeProngs.bankCash = '1'
      if (kind === 'shares') changed.sharesRaw = '1'
      if (kind === 'owner') changed.owner = '0x' + '2'.repeat(40)
      if (kind === 'source') changed.source.blockHash = '0x' + 'b'.repeat(64)
      if (kind === 'fee') changed.feeBps = 0
      if (kind === 'code')
        changed.runtimeCodeHashes[FLUID_USDC_BRIDGE_NATIVE_VAULT] = '0x' + 'c'.repeat(64)
      if (kind === 'plan')
        changed.traces.at(-1)!.request.params[1] = { blockNumber: source.blockNumber }
      expect(replayFluidUsdcBridgeNativeCapacityFact(changed, owner, source, NOW)).toBeNull()
    },
  )
  it('rejects future completion, stale source and accessors without invoking them', async () => {
    const { fact } = await capture()
    expect(
      replayFluidUsdcBridgeNativeCapacityFact(
        { ...fact, readAtUtc: new Date(NOW + 1).toISOString() },
        owner,
        source,
        NOW,
      ),
    ).toBeNull()
    expect(replayFluidUsdcBridgeNativeCapacityFact(fact, owner, source, NOW + 1800000)).toBeNull()
    let calls = 0
    Object.defineProperty(fact, 'traces', {
      get: () => {
        calls++
        return []
      },
    })
    expect(replayFluidUsdcBridgeNativeCapacityFact(fact, owner, source, NOW)).toBeNull()
    expect(calls).toBe(0)
  })
  it('binds native full Ea and S into actual capacity reconstruction and semantic two-origin agreement', async () => {
    const { fact } = await capture(),
      first = quote(fact)!
    expect(first).not.toBeNull()
    const second = quote({ ...fact, readAtUtc: new Date(NOW - 1).toISOString() })!
    expect(
      agreeHolderExitCapacityQuotes(
        { host: 'eth-mainnet.g.alchemy.com', quote: first },
        { host: 'rpc.ankr.com', quote: second },
        NOW,
      )?.quote.sourceHolderPosition?.sharesRaw,
    ).toBe(fact.sharesRaw)
    expect(
      agreeHolderExitCapacityQuotes(
        { host: 'eth-mainnet.g.alchemy.com', quote: first },
        { host: 'rpc.ankr.com', quote: { ...second, fluidUsdcBridgeNativeCapacity: undefined } },
        NOW,
      ),
    ).toBeNull()
    expect(quote({ ...fact, fullNetEaRaw: '1' })).toBeNull()
  })
  it('uses the later genuine origin completion in either order and rejects knowledge after cutoff', async () => {
    const { fact } = await capture()
    const earlier = quote({ ...fact, readAtUtc: new Date(NOW - 1).toISOString() })!,
      later = quote(fact)!
    for (const [a, b] of [
      [earlier, later],
      [later, earlier],
    ]) {
      const joined = agreeHolderExitCapacityQuotes(
        { host: 'eth-mainnet.g.alchemy.com', quote: a },
        { host: 'rpc.ankr.com', quote: b },
        NOW,
      )!
      expect(joined.quote.fluidUsdcBridgeNativeCapacity?.readAtUtc).toBe(
        new Date(NOW).toISOString(),
      )
      expect(
        agreeHolderExitCapacityQuotes(
          { host: 'eth-mainnet.g.alchemy.com', quote: a },
          { host: 'rpc.ankr.com', quote: b },
          NOW - 1,
        ),
      ).toBeNull()
    }
  })
  it('admits only exact staged USDC bridge capacity units without granting atomic execution', async () => {
    const { fact } = await capture()
    expect(
      resolveIssuedHolderExitSubject(
        FLUID_USDC_BRIDGE_NATIVE_ROUTE,
        FLUID_USDC_BRIDGE_NATIVE_VAULT,
      ),
    ).toBeNull()
    expect(
      resolveHolderExitCapacitySubject(
        FLUID_USDC_BRIDGE_NATIVE_ROUTE,
        FLUID_USDC_BRIDGE_NATIVE_VAULT,
      )?.canonicalFinalAsset?.decimals,
    ).toBe(6)
    expect(
      resolveHolderExitCapacitySubject(
        'USDT → FluidBridgeAggregatorProxy [USDC]',
        FLUID_USDC_BRIDGE_NATIVE_VAULT,
      ),
    ).toBeNull()
    expect(quote(fact, { destinationAddress: ('0x' + 'b'.repeat(40)) as `0x${string}` })).toBeNull()
    expect(
      quote(fact, {
        request: {
          assetsRaw: '1000000',
          assetAddress: ('0x' + 'b'.repeat(40)) as `0x${string}`,
          horizonHours: 24,
        },
      }),
    ).toBeNull()
    expect(quote({ ...fact, assetDecimals: 18 as never })).toBeNull()
    expect(quote({ ...fact, shareDecimals: 6 as never })).toBeNull()
    const simulated = quote(fact, {
      stages: [
        {
          name: 'withdrawal',
          assetAddress: FLUID_USDC_BRIDGE_NATIVE_ASSET,
          amountRaw: '1000000',
          relatedToRequest: true,
          status: 'simulated',
        },
      ],
      finalPayout: {
        assetAddress: FLUID_USDC_BRIDGE_NATIVE_ASSET,
        amountRaw: '1000000',
        status: 'simulated',
      },
    })!
    expect(simulated.successfulRequestedRawLowerBound).toBeNull()
    expect(simulated.holderExecutableExit).toBe(false)
  })
})
