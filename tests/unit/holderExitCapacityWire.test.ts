import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import {
  createPublicClient,
  custom,
  parseAbi,
  decodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  toFunctionSelector,
  keccak256,
} from 'viem'
import { mainnet } from 'viem/chains'
import { ROUTES } from '@/components/Carry/fixtures'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import config from '@/tools/venue-recorder.config.json'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import { buildCanonicalAtomicHolderExitSubjects } from '@/lib/carry/holderExitMechanisms'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  agreeHolderExitCapacityQuotes,
  selectedHolderExitCapacity,
  buildHolderExitCapacityQuote,
} from '@/lib/carry/holderExitCapacity'
import { USD3_ROUTE_KEY, USD3_TOKENIZED_STRATEGY, USDC_ASSET } from '@/lib/carry/usd3ExitQuote'
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
  'function availableWithdrawLimit(address) view returns(uint256)',
  'function isShutdown() view returns(bool)',
  'function tokenizedStrategyAddress() view returns(address)',
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
    missingCapacityGetter?: boolean
    missingEntitlementGetter?: boolean
    capacityTransportFailure?: boolean
    nativeWord?: unknown
    missingNativeGetter?: boolean
    shutdownWord?: unknown
    missingShutdownGetter?: boolean
    delegate?: string
    assetCode?: string
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
          return p.params[0].toLowerCase() === owner
            ? '0x'
            : p.params[0].toLowerCase() === USDC_ASSET
              ? (options.assetCode ?? '0x60006000')
              : '0x60006000'
        if (p.method === 'eth_getStorageAt')
          return `0x${'0'.repeat(24)}d1f1c3f485063712873285bf4ef25ab068f13893`
        if (p.method === 'eth_call') {
          const tx = p.params[0]
          const decoded = decodeFunctionData({ abi: ABI, data: tx.data })
          const name = decoded.functionName
          if (name === 'isShutdown') {
            if (options.missingShutdownGetter)
              throw Object.assign(new Error('execution reverted'), { code: 3 })
            return Object.hasOwn(options, 'shutdownWord')
              ? options.shutdownWord
              : encodeAbiParameters([{ type: 'bool' }], [false])
          }
          if (name === 'availableWithdrawLimit') {
            expect(decoded.args).toEqual([owner])
            if (options.missingNativeGetter)
              throw Object.assign(new Error('execution reverted'), { code: 3 })
            return Object.hasOwn(options, 'nativeWord')
              ? options.nativeWord
              : encodeAbiParameters([{ type: 'uint256' }], [123456789n])
          }
          if (name === 'tokenizedStrategyAddress')
            return encodeAbiParameters(
              [{ type: 'address' }],
              [(options.delegate ?? USD3_TOKENIZED_STRATEGY) as `0x${string}`],
            )
          if (options.missingEntitlementGetter && name === 'previewRedeem')
            throw Object.assign(new Error('execution reverted'), { code: 3 })
          if (options.capacityTransportFailure && name === 'maxWithdraw')
            throw new Error('transport unavailable')
          if (options.missingCapacityGetter && name === 'maxWithdraw')
            throw Object.assign(new Error('execution reverted'), { code: 3 })
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
describe('capacity facts use actual SDK source-pinned getter wire', () => {
  it.each(subjects.map((s) => [s.routeKey, s.destinationAddress, s] as const))(
    'retains actual native capacity facts %s/%s',
    async (_r, _d, s) => {
      const f = fixture(s),
        a = await readHolderExitAssessment(f.clients, input(s), {
          atomicFinalizedBlock: pin,
          includeCapacityFacts: true,
        })
      expect(a.capacityQuote).toBeDefined()
      expect(a.capacityQuote!.entitlementRaw).toBe('10000000')
      expect(a.capacityQuote!.successfulRequestedRawLowerBound).toBe('1000000')
      expect(a.capacityQuote!.assetDecimals).toBe(s.canonicalFinalAsset!.decimals)
      const calls = f.wire.filter((p) => p.method === 'eth_call')
      expect(calls.every((p) => JSON.stringify(p.params[1]) === JSON.stringify(hashRef))).toBe(true)
      const redeem = calls.filter((p) =>
        p.params[0].data.startsWith(toFunctionSelector('previewRedeem(uint256)')),
      )
      if (a.capacityQuote!.entitlementMethod !== 'supplied_balance') {
        expect(redeem).toHaveLength(1)
        expect(decodeFunctionData({ abi: ABI, data: redeem[0].params[0].data }).args).toEqual([
          10000000n,
        ])
      }
    },
  )
  it('optional Morpho max getter revert does not invalidate current exact-Q execution', async () => {
    const s = subjects.find((s) => s.routeKey.includes('VaultV2'))!,
      f = fixture(s, { missingCapacityGetter: true }),
      a = await readHolderExitAssessment(f.clients, input(s), {
        atomicFinalizedBlock: pin,
        includeCapacityFacts: true,
      })
    expect(a.finalPayout.status).toBe('simulated')
    expect(a.capacityQuote!.quotedMaxWithdrawRaw).toBeNull()
    expect(a.capacityQuote!.quotedMaxWithdrawStatus).toBe('unsupported')
    expect(a.capacityQuote!.successfulRequestedRawLowerBound).toBe('1000000')
  })
  it('optional full-position preview unavailable preserves tracked M and actual Q proof', async () => {
    const s = subjects.find((s) => s.routeKey === 'USDC → Fluid USD Coin [USDC]')!,
      f = fixture(s, { missingEntitlementGetter: true }),
      a = await readHolderExitAssessment(f.clients, input(s), {
        atomicFinalizedBlock: pin,
        includeCapacityFacts: true,
      })
    expect(a.finalPayout.status).toBe('simulated')
    expect(a.capacityQuote!.entitlementRaw).toBeNull()
    expect(a.capacityQuote!.entitlementMethod).toBe('unavailable')
    expect(a.capacityQuote!.quotedMaxWithdrawRaw).toBe('10000000')
    expect(a.capacityQuote!.successfulRequestedRawLowerBound).toBe('1000000')
  })
  it('optional Morpho transport failure remains unavailable rather than unsupported or zero', async () => {
    const s = subjects.find((s) => s.routeKey.includes('VaultV2'))!,
      f = fixture(s, { capacityTransportFailure: true }),
      a = await readHolderExitAssessment(f.clients, input(s), {
        atomicFinalizedBlock: pin,
        includeCapacityFacts: true,
      })
    expect(a.finalPayout.status).toBe('simulated')
    expect(a.capacityQuote!.quotedMaxWithdrawStatus).toBe('unavailable')
    expect(a.capacityQuote!.quotedMaxWithdrawRaw).toBeNull()
  })
  it('after-read actual header stability encloses new capacity getters', async () => {
    const s = subjects.find((s) => s.routeKey === 'USDC → Fluid USD Coin [USDC]')!,
      f = fixture(s, { changedAfter: true })
    await expect(
      readHolderExitAssessment(f.clients, input(s), {
        atomicFinalizedBlock: pin,
        includeCapacityFacts: true,
      }),
    ).rejects.toThrow()
    expect(
      f.wire.some(
        (p) =>
          p.method === 'eth_call' &&
          p.params[0].data.startsWith(toFunctionSelector('previewRedeem(uint256)')),
      ),
    ).toBe(true)
  })
})

describe('USD3 native capacity strict two-origin reconstruction', () => {
  const usd3 = subjects.find((s) => s.routeKey === USD3_ROUTE_KEY)!
  async function read(options: Parameters<typeof fixture>[1] = {}) {
    const f = fixture(usd3, options)
    const a = await readHolderExitAssessment(f.clients, input(usd3), {
      atomicFinalizedBlock: pin,
      includeCapacityFacts: true,
    })
    // These tests bind capacity agreement independently of the existing execution proof gate.
    const quote = structuredClone(a.capacityQuote!)
    quote.successfulRequestedRawLowerBound = null
    return { f, a, quote }
  }
  const agree = (a: unknown, b: unknown) =>
    agreeHolderExitCapacityQuotes(
      { host: 'first.example.com', quote: a },
      { host: 'second.example.com', quote: b },
      NOW,
    )
  const binding = (q: NonNullable<Awaited<ReturnType<typeof read>>['quote']>) => ({
    routeKey: q.routeKey,
    destination: q.destination,
    owner: q.owner,
    requestedRaw: q.requestedRaw,
    asset: q.asset,
    assetDecimals: q.assetDecimals,
    currentSource: q.source,
    asOfMs: NOW,
  })
  it('forwards and agrees native full-S USD3 entitlement with its exact full-position method', async () => {
    const { a, quote, f } = await read()
    expect(quote.fullPositionEntitlementRaw).toBe(quote.entitlementRaw)
    expect(quote.fullPositionEntitlementMethod).toBe('preview_redeem_full_position')
    expect(buildHolderExitCapacityQuote(a, quote, NOW)?.fullPositionEntitlementRaw).toBe('10000000')
    const redeem = f.wire.filter(
      (p) =>
        p.method === 'eth_call' &&
        p.params[0].data.startsWith(toFunctionSelector('previewRedeem(uint256)')),
    )
    expect(redeem).not.toHaveLength(0)
    expect(
      redeem.every(
        (p) => decodeFunctionData({ abi: ABI, data: p.params[0].data }).args?.[0] === 10000000n,
      ),
    ).toBe(true)
    const agreement = agree(quote, structuredClone(quote))!
    expect(agreement.quote.fullPositionEntitlementRaw).toBe('10000000')
    expect(agreement.quote.fullPositionEntitlementMethod).toBe('preview_redeem_full_position')
    expect(selectedHolderExitCapacity(agreement, binding(quote))).not.toBeNull()
  })
  it.each(['10000001', '9999999', null, '01', '-1'])(
    'rejects mismatched or malformed USD3 full entitlement %s in builder and either origin',
    async (full) => {
      const { a, quote } = await read(),
        bad = { ...quote, fullPositionEntitlementRaw: full }
      expect(buildHolderExitCapacityQuote(a, bad, NOW)).toBeNull()
      expect(agree(quote, bad)).toBeNull()
      expect(agree(bad, quote)).toBeNull()
    },
  )
  it('preserves both-null unavailable full Ea and rejects nonnull optional Ea against null mandatory Ea', async () => {
    const { a, quote } = await read({ missingEntitlementGetter: true })
    expect(quote.entitlementRaw).toBeNull()
    expect(quote.fullPositionEntitlementRaw).toBeNull()
    expect(quote.fullPositionEntitlementMethod).toBe('unavailable')
    expect(buildHolderExitCapacityQuote(a, quote, NOW)).not.toBeNull()
    expect(agree(quote, structuredClone(quote))).not.toBeNull()
    const invented = {
      ...quote,
      fullPositionEntitlementRaw: '10000000',
      fullPositionEntitlementMethod: 'preview_redeem_full_position',
    }
    expect(buildHolderExitCapacityQuote(a, invented, NOW)).toBeNull()
    expect(agree(quote, invented)).toBeNull()
  })
  it('rejects wrong full-position methods and changed origin entitlement', async () => {
    const { quote } = await read()
    for (const method of ['preview_redeem_currently_redeemable', 'unavailable']) {
      expect(agree(quote, { ...quote, fullPositionEntitlementMethod: method })).toBeNull()
    }
    const changed = { ...quote, entitlementRaw: '11000000', fullPositionEntitlementRaw: '11000000' }
    expect(agree(quote, changed)).toBeNull()
    const agreement = agree(quote, structuredClone(quote))!
    const forged = structuredClone(agreement)
    forged.quote.fullPositionEntitlementMethod = 'unavailable'
    expect(selectedHolderExitCapacity(forged, binding(quote))).toBeNull()
  })
  it('keeps legacy USD3 pairs without optional full metadata, rejecting mixed representations', async () => {
    const { a, quote } = await read(),
      legacy = structuredClone(quote)
    delete legacy.fullPositionEntitlementRaw
    delete legacy.fullPositionEntitlementMethod
    expect(buildHolderExitCapacityQuote(a, legacy, NOW)).not.toBeNull()
    const agreement = agree(legacy, structuredClone(legacy))!
    expect(agreement.quote.entitlementRaw).toBe('10000000')
    expect(Object.hasOwn(agreement.quote, 'fullPositionEntitlementRaw')).toBe(false)
    expect(selectedHolderExitCapacity(agreement, binding(legacy))).not.toBeNull()
    expect(agree(quote, legacy)).toBeNull()
    expect(agree(legacy, quote)).toBeNull()
  })
  it('retains sGHO full >= currently redeemable and rejects full metadata for other kinds', async () => {
    const { a } = await read(),
      gho = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
    const sgho = {
      ...a,
      status: 'partial' as const,
      routeKey: 'GHO → sGho [GHO]',
      destinationAddress: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
      request: { ...a.request, assetAddress: gho },
      stages: [],
      finalPayout: { status: 'unassessed' as const, amountRaw: null, assetAddress: gho },
    }
    const facts = {
      entitlementRaw: '5000000',
      quotedMaxWithdrawRaw: '10000000',
      quotedMaxWithdrawStatus: 'quoted' as const,
      effectiveLimitRaw: '5000000',
      withdrawalsPaused: false,
      fullPositionEntitlementRaw: '10000000',
    }
    const quote = buildHolderExitCapacityQuote(sgho, facts, NOW)!
    expect(quote).not.toBeNull()
    expect(quote.entitlementMethod).toBe('preview_redeem_currently_redeemable')
    expect(quote.fullPositionEntitlementMethod).toBe('preview_redeem_full_position')
    expect(agree(quote, structuredClone(quote))).not.toBeNull()
    expect(
      buildHolderExitCapacityQuote(sgho, { ...facts, fullPositionEntitlementRaw: '4999999' }, NOW),
    ).toBeNull()
    expect(
      buildHolderExitCapacityQuote(sgho, { ...facts, fullPositionEntitlementRaw: null }, NOW),
    ).not.toBeNull()
    const { fullPositionEntitlementRaw: _full, ...legacy } = facts
    expect(buildHolderExitCapacityQuote(sgho, legacy, NOW)).not.toBeNull()
    const other = subjects.find((s) => s.routeKey !== USD3_ROUTE_KEY)!,
      offline = fixture(other)
    const assessment = await readHolderExitAssessment(offline.clients, input(other), {
      atomicFinalizedBlock: pin,
      includeCapacityFacts: true,
    })
    expect(
      buildHolderExitCapacityQuote(
        assessment,
        {
          ...assessment.capacityQuote!,
          fullPositionEntitlementRaw: assessment.capacityQuote!.entitlementRaw,
        },
        NOW,
      ),
    ).toBeNull()
  })
  it('preserves both native origins and source hashes independently of M/Ea/Q/full S', async () => {
    const { quote, f } = await read()
    expect(quote.usd3NativeCapacity).toMatchObject({
      capacityRaw: '123456789',
      resultStatus: 'quoted',
      owner,
      source: quote.source,
      runtimeProfile: { sourceClass: 'pinned_usd3_native_runtime' },
    })
    expect(quote.entitlementRaw).toBe('10000000')
    expect(quote.quotedMaxWithdrawRaw).toBe('10000000')
    expect(quote.requestedRaw).toBe('1000000')
    expect(quote.sourceHolderPosition?.sharesRaw).toBe('10000000')
    const capacityCall = f.wire.find(
      (p) =>
        p.method === 'eth_call' &&
        p.params[0].data.startsWith(toFunctionSelector('availableWithdrawLimit(address)')),
    )
    expect(capacityCall.params[1]).toEqual(hashRef)
    expect(decodeFunctionData({ abi: ABI, data: capacityCall.params[0].data }).args).toEqual([
      owner,
    ])
    const agreement = agree(quote, structuredClone(quote))!
    expect(agreement.origins.map((o) => o.quote.usd3NativeCapacity)).toEqual([
      quote.usd3NativeCapacity,
      quote.usd3NativeCapacity,
    ])
    expect(selectedHolderExitCapacity(agreement, binding(quote))).toEqual(agreement)
  })
  it('retains agreed native zero', async () => {
    const { quote } = await read({ nativeWord: `0x${'0'.repeat(64)}` })
    expect(agree(quote, structuredClone(quote))?.quote.usd3NativeCapacity).toMatchObject({
      capacityRaw: '0',
      resultStatus: 'quoted',
    })
  })
  it('keeps default reads unchanged and optional failures censored with usable Q evidence', async () => {
    const f = fixture(usd3)
    const ordinary = await readHolderExitAssessment(f.clients, input(usd3), {
      atomicFinalizedBlock: pin,
    })
    expect(ordinary.finalPayout.status).toBe('simulated')
    expect(ordinary.capacityQuote?.usd3NativeCapacity).toBeUndefined()
    expect(
      f.wire.some(
        (p) =>
          p.method === 'eth_call' &&
          [
            toFunctionSelector('availableWithdrawLimit(address)'),
            toFunctionSelector('tokenizedStrategyAddress()'),
            toFunctionSelector('isShutdown()'),
          ].some((selector) => p.params[0].data.startsWith(selector)),
      ),
    ).toBe(false)
    for (const options of [
      { missingNativeGetter: true },
      { nativeWord: '0x01' },
      { delegate: owner },
      { assetCode: '0x600' },
    ]) {
      const { a } = await read(options)
      expect(a.finalPayout.status).toBe('simulated')
      expect(a.capacityQuote?.entitlementRaw).toBe('10000000')
      expect(a.capacityQuote?.sourceHolderPosition?.sharesRaw).toBe('10000000')
      if ('delegate' in options || 'assetCode' in options)
        expect(a.capacityQuote?.usd3NativeCapacity?.runtimeProfile).toBeNull()
      else expect(a.capacityQuote?.usd3NativeCapacity?.capacityRaw).toBeNull()
    }
  })
  it.each([
    'owner',
    'source',
    'method',
    'asset',
    'decimals',
    'shareDecimals',
    'holderShareDecimals',
    'runtime',
    'fingerprint',
    'order',
    'sourceClass',
    'extra',
    'overflow',
    'leadingZero',
  ])('rejects forged native %s even in origins with a censored aggregate', async (field) => {
    const { quote } = await read()
    const bad = structuredClone(quote)
    const native = bad.usd3NativeCapacity! as any
    if (field === 'owner') native.owner = '0x0000000000000000000000000000000000000002'
    if (field === 'source') native.source.blockHash = `0x${'c'.repeat(64)}`
    if (field === 'method') native.method = 'maxWithdraw(address)'
    if (field === 'asset') native.asset = owner
    if (field === 'decimals') native.assetDecimals = 18
    if (field === 'shareDecimals') native.runtimeProfile.shareDecimals = 18
    if (field === 'holderShareDecimals') bad.sourceHolderPosition!.shareDecimals = 18
    if (field === 'runtime') native.runtimeProfile.contracts[2].address = owner
    if (field === 'fingerprint')
      native.runtimeProfile.contracts[3].keccak256 = `0x${'0'.repeat(64)}`
    if (field === 'order') native.runtimeProfile.contracts.reverse()
    if (field === 'sourceClass')
      native.runtimeProfile.sourceClass = 'verified_source_code_equivalence'
    if (field === 'extra') native.extra = true
    if (field === 'overflow') native.capacityRaw = (1n << 256n).toString()
    if (field === 'leadingZero') native.capacityRaw = '01'
    expect(agree(quote, bad)).toBeNull()
    const value = agree(quote, quote)!
    value.quote.usd3NativeCapacity = {
      ...value.quote.usd3NativeCapacity!,
      capacityRaw: null,
      resultStatus: 'unavailable',
      runtimeProfile: null,
    }
    value.origins[1].quote = bad
    expect(selectedHolderExitCapacity(value, binding(quote))).toBeNull()
  })
  it.each(['missing', 'raw', 'profile', 'runtimeDrift', 'unsupported'])(
    'censors the agreed optional native prong on %s without losing common holder facts',
    async (variation) => {
      const { quote } = await read()
      const other = structuredClone(quote)
      if (variation === 'missing') delete other.usd3NativeCapacity
      if (variation === 'raw') other.usd3NativeCapacity!.capacityRaw = '999'
      if (variation === 'profile') other.usd3NativeCapacity!.runtimeProfile = null
      if (variation === 'runtimeDrift') {
        const runtime = other.usd3NativeCapacity!.runtimeProfile!.contracts[2]
        runtime.code = '0x60006001'
        runtime.keccak256 = keccak256(runtime.code)
      }
      if (variation === 'unsupported') {
        other.usd3NativeCapacity!.capacityRaw = null
        other.usd3NativeCapacity!.resultStatus = 'unsupported'
      }
      const agreement = agree(quote, other)!
      expect(agreement).not.toBeNull()
      expect(agreement.quote.usd3NativeCapacity).toMatchObject({
        capacityRaw: null,
        resultStatus: 'unavailable',
        runtimeProfile: null,
        shutdown: null,
      })
      expect(agreement.quote.entitlementRaw).toBe(quote.entitlementRaw)
      expect(agreement.quote.sourceHolderPosition).toEqual(quote.sourceHolderPosition)
      expect(agreement.origins[1].quote).toEqual(other)
      expect(selectedHolderExitCapacity(agreement, binding(quote))).toEqual(agreement)
      const forged = structuredClone(agreement)
      forged.quote.usd3NativeCapacity = quote.usd3NativeCapacity
      expect(selectedHolderExitCapacity(forged, binding(quote))).toBeNull()
      const reversed = agree(other, quote)!
      expect(reversed.quote.usd3NativeCapacity).toEqual(agreement.quote.usd3NativeCapacity)
    },
  )
  it.each([false, true])(
    'retains two source-pinned shutdown %s facts exactly',
    async (shutdown) => {
      const { quote, f } = await read({
        shutdownWord: encodeAbiParameters([{ type: 'bool' }], [shutdown]),
      })
      expect(quote.usd3NativeCapacity?.shutdown).toBe(shutdown)
      const call = f.wire.find(
        (p) =>
          p.method === 'eth_call' &&
          p.params[0].data.startsWith(toFunctionSelector('isShutdown()')),
      )
      expect(call.params[1]).toEqual(hashRef)
      const agreement = agree(quote, structuredClone(quote))!
      expect(agreement.quote.usd3NativeCapacity?.shutdown).toBe(shutdown)
      expect(agreement.origins.map((origin) => origin.quote.usd3NativeCapacity?.shutdown)).toEqual([
        shutdown,
        shutdown,
      ])
      expect(selectedHolderExitCapacity(agreement, binding(quote))).toEqual(agreement)
      const forged = structuredClone(agreement)
      forged.quote.usd3NativeCapacity!.shutdown = !shutdown
      expect(selectedHolderExitCapacity(forged, binding(quote))).toBeNull()
    },
  )
  it('preserves legacy native schemas without adding an absent shutdown field', async () => {
    const { quote, a } = await read()
    const legacy = structuredClone(quote)
    delete legacy.usd3NativeCapacity!.shutdown
    const agreement = agree(legacy, structuredClone(legacy))!
    expect(agreement.quote.usd3NativeCapacity).toEqual(legacy.usd3NativeCapacity)
    expect(Object.hasOwn(agreement.quote.usd3NativeCapacity!, 'shutdown')).toBe(false)
    expect(selectedHolderExitCapacity(agreement, binding(legacy))).toEqual(agreement)
    expect(buildHolderExitCapacityQuote(a, legacy, NOW)?.usd3NativeCapacity).toEqual(
      legacy.usd3NativeCapacity,
    )
  })
  it('agrees equal native payloads with distinct original read clocks and derives only the maximum', async () => {
    const { quote } = await read()
    const first = structuredClone(quote),
      second = structuredClone(quote)
    const firstClock = new Date(NOW - 1500).toISOString()
    const secondClock = new Date(NOW - 500).toISOString()
    first.usd3NativeCapacity!.readAtUtc = firstClock
    second.usd3NativeCapacity!.readAtUtc = secondClock
    const agreement = agree(first, second)!
    expect(agreement.quote.usd3NativeCapacity).toEqual({
      ...first.usd3NativeCapacity,
      readAtUtc: secondClock,
    })
    expect(agreement.origins[0].quote.usd3NativeCapacity?.readAtUtc).toBe(firstClock)
    expect(agreement.origins[1].quote.usd3NativeCapacity?.readAtUtc).toBe(secondClock)
    expect(selectedHolderExitCapacity(agreement, binding(quote))).toEqual(agreement)
    expect(agree(second, first)?.quote.usd3NativeCapacity).toEqual(
      agreement.quote.usd3NativeCapacity,
    )
    const forged = structuredClone(agreement)
    forged.quote.usd3NativeCapacity!.readAtUtc = firstClock
    expect(selectedHolderExitCapacity(forged, binding(quote))).toBeNull()
    delete forged.quote.usd3NativeCapacity!.readAtUtc
    expect(selectedHolderExitCapacity(forged, binding(quote))).toBeNull()
  })
  it('keeps both legacy native clocks absent without changing their exact schema', async () => {
    const { quote, a } = await read()
    delete quote.usd3NativeCapacity!.readAtUtc
    const agreement = agree(quote, structuredClone(quote))!
    expect(agreement.quote.usd3NativeCapacity).toEqual(quote.usd3NativeCapacity)
    expect(Object.hasOwn(agreement.quote.usd3NativeCapacity!, 'readAtUtc')).toBe(false)
    expect(selectedHolderExitCapacity(agreement, binding(quote))).toEqual(agreement)
    expect(buildHolderExitCapacityQuote(a, quote, NOW)?.usd3NativeCapacity).toEqual(
      quote.usd3NativeCapacity,
    )
  })
  it.each(['missing', 'oneNull', 'bothNull'])(
    'censors native capacity for %s read clocks and retains originals/full S/Ea',
    async (variation) => {
      const { quote } = await read()
      const first = structuredClone(quote),
        second = structuredClone(quote)
      if (variation === 'missing') delete second.usd3NativeCapacity!.readAtUtc
      else second.usd3NativeCapacity!.readAtUtc = null
      if (variation === 'bothNull') first.usd3NativeCapacity!.readAtUtc = null
      const agreement = agree(first, second)!
      expect(agreement.quote.usd3NativeCapacity).toMatchObject({
        capacityRaw: null,
        resultStatus: 'unavailable',
        runtimeProfile: null,
        readAtUtc: null,
      })
      expect(agreement.quote.sourceHolderPosition).toEqual(quote.sourceHolderPosition)
      expect(agreement.quote.entitlementRaw).toBe(quote.entitlementRaw)
      expect(agreement.origins.map((origin) => origin.quote)).toEqual([first, second])
      expect(selectedHolderExitCapacity(agreement, binding(quote))).toEqual(agreement)
      expect(agree(second, first)?.quote.usd3NativeCapacity).toEqual(
        agreement.quote.usd3NativeCapacity,
      )
      const forged = structuredClone(agreement)
      forged.quote.usd3NativeCapacity = quote.usd3NativeCapacity
      expect(selectedHolderExitCapacity(forged, binding(quote))).toBeNull()
      const discardedClock = structuredClone(agreement)
      delete discardedClock.quote.usd3NativeCapacity!.readAtUtc
      expect(selectedHolderExitCapacity(discardedClock, binding(quote))).toBeNull()
    },
  )
  it.each([
    'future',
    'beforeSource',
    'noncanonical',
    'offset',
    'invalid',
    'undefined',
    'number',
    'object',
  ])(
    'rejects %s native read clocks in builder and original wire even with censored aggregate',
    async (variation) => {
      const { quote, a } = await read()
      const bad = structuredClone(quote)
      const native = bad.usd3NativeCapacity! as any
      const values: Record<string, unknown> = {
        future: new Date(NOW + 1).toISOString(),
        beforeSource: new Date(Date.parse(quote.source.blockTime) - 1).toISOString(),
        noncanonical: '2026-10-07T10:00:00Z',
        offset: '2026-10-07T10:00:00.000+00:00',
        invalid: 'invalid',
        undefined: undefined,
        number: NOW,
        object: {},
      }
      native.readAtUtc = values[variation]
      expect(buildHolderExitCapacityQuote(a, bad, NOW)).toBeNull()
      expect(agree(quote, bad)).toBeNull()
      const forged = agree(quote, quote)!
      forged.origins[1].quote = bad
      forged.quote.usd3NativeCapacity = {
        ...quote.usd3NativeCapacity!,
        capacityRaw: null,
        resultStatus: 'unavailable',
        runtimeProfile: null,
        readAtUtc: null,
      }
      expect(selectedHolderExitCapacity(forged, binding(quote))).toBeNull()
    },
  )
  it.each(['different', 'missing', 'null'])(
    'censors the full optional native prong on %s shutdown while retaining both originals',
    async (variation) => {
      const { quote } = await read()
      const other = structuredClone(quote)
      if (variation === 'different') other.usd3NativeCapacity!.shutdown = true
      if (variation === 'missing') delete other.usd3NativeCapacity!.shutdown
      if (variation === 'null') other.usd3NativeCapacity!.shutdown = null
      const agreement = agree(quote, other)!
      expect(agreement.quote.usd3NativeCapacity).toMatchObject({
        capacityRaw: null,
        resultStatus: 'unavailable',
        runtimeProfile: null,
        shutdown: null,
      })
      expect(Object.hasOwn(agreement.quote.usd3NativeCapacity!, 'shutdown')).toBe(true)
      expect(agreement.origins[0].quote).toEqual(quote)
      expect(agreement.origins[1].quote).toEqual(other)
      expect(agreement.quote.entitlementRaw).toBe(quote.entitlementRaw)
      expect(agreement.quote.sourceHolderPosition).toEqual(quote.sourceHolderPosition)
      expect(selectedHolderExitCapacity(agreement, binding(quote))).toEqual(agreement)
      const reversed = agree(other, quote)!
      expect(reversed.quote.usd3NativeCapacity).toEqual(agreement.quote.usd3NativeCapacity)
      const forged = structuredClone(agreement)
      forged.quote.usd3NativeCapacity = quote.usd3NativeCapacity
      expect(selectedHolderExitCapacity(forged, binding(quote))).toBeNull()
      const discardedBinding = structuredClone(agreement)
      delete discardedBinding.quote.usd3NativeCapacity!.shutdown
      expect(selectedHolderExitCapacity(discardedBinding, binding(quote))).toBeNull()
    },
  )
  it.each([undefined, 'false', 0, 1, {}])(
    'rejects present nonprimitive or malformed shutdown metadata %s',
    async (shutdown) => {
      const { quote } = await read()
      const malformed = structuredClone(quote)
      const native = malformed.usd3NativeCapacity! as any
      native.shutdown = shutdown
      expect(agree(quote, malformed)).toBeNull()
      const forged = agree(quote, quote)!
      forged.origins[1].quote = malformed
      forged.quote.usd3NativeCapacity = {
        ...quote.usd3NativeCapacity!,
        capacityRaw: null,
        resultStatus: 'unavailable',
        runtimeProfile: null,
        shutdown: null,
      }
      expect(selectedHolderExitCapacity(forged, binding(quote))).toBeNull()
    },
  )
  it.each([
    { missingShutdownGetter: true },
    { shutdownWord: '0x01' },
    { shutdownWord: `0x${'0'.repeat(63)}2` },
  ])(
    'censors unsupported/malformed shutdown reads with independent C, Ea and execution intact',
    async (options) => {
      const { quote, a } = await read(options)
      expect(quote.usd3NativeCapacity).toMatchObject({
        shutdown: null,
        capacityRaw: '123456789',
        resultStatus: 'quoted',
      })
      expect(a.finalPayout.status).toBe('simulated')
      expect(quote.entitlementRaw).toBe('10000000')
      const agreement = agree(quote, quote)!
      expect(agreement.quote.usd3NativeCapacity?.shutdown).toBeNull()
      expect(selectedHolderExitCapacity(agreement, binding(quote))).toEqual(agreement)
    },
  )
  it('rejects a native USD3 field on another subject in both builder and wire reconstruction', async () => {
    const { quote } = await read()
    const another = subjects.find((s) => s.routeKey !== USD3_ROUTE_KEY)!
    const f = fixture(another)
    const a = await readHolderExitAssessment(f.clients, input(another), {
      atomicFinalizedBlock: pin,
      includeCapacityFacts: true,
    })
    const other = { ...a.capacityQuote!, usd3NativeCapacity: quote.usd3NativeCapacity }
    expect(buildHolderExitCapacityQuote(a, other, NOW)).toBeNull()
    expect(agree(other, other)).toBeNull()
  })
})
