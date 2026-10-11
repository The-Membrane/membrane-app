import { describe, it, expect } from 'vitest'
import {
  agreeFluidExitCapacity,
  selectedFluidExitCapacity,
  FLUID_LIQUIDITY,
  FLUID_LIQUIDITY_RESOLVER,
  type FluidCapacityOrigin,
} from '@/lib/carry/fluidExitCapacity'
function origin(host = 'eth-mainnet.g.alchemy.com'): FluidCapacityOrigin {
  return {
    host,
    routeKey: 'USDC → Fluid USD Coin [USDC]',
    destination: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    source: {
      chainId: 1,
      blockNumber: 26000000,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: '2026-10-01T00:00:00.000Z',
      finalized: true,
    },
    identities: [
      '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      FLUID_LIQUIDITY,
      FLUID_LIQUIDITY_RESOLVER,
    ].map((address) => ({
      address,
      codeHash: `0x${'b'.repeat(64)}`,
      proxyInspection: 'not_read',
      implementationAddress: null,
      implementationCodeHash: null,
      beaconAddress: null,
    })),
    fTokenReportedSupplyRaw: '1000',
    resolverSupplyRaw: '1000',
    expandedWithdrawalLimitRaw: '800',
    withdrawableUntilLimitRaw: '200',
    resolverReportedWithdrawableRaw: '150',
    sharedLiquidityCashRaw: '100',
    limitParameters: {
      lastUpdateTimestamp: '1',
      expandPercent: '1000',
      expandDuration: '86400',
      baseWithdrawalLimitRaw: '800',
      decayEndTimestamp: '2',
      reportedDecayAmountRaw: '0',
    },
  }
}
describe('Fluid protocol prongs before owner clipping', () => {
  it('not_read proxy inspection cannot attest implementation or beacon identities', () => {
    for (const key of [
      'implementationAddress',
      'implementationCodeHash',
      'beaconAddress',
    ] as const) {
      const a = origin()
      a.identities[0][key] =
        key === 'implementationCodeHash' ? `0x${'c'.repeat(64)}` : `0x${'c'.repeat(40)}`
      expect(agreeFluidExitCapacity(a, { ...structuredClone(a), host: 'rpc.ankr.com' })).toBeNull()
    }
  })
  it('keeps supply, expanded limit and direct cash separate, including reported external cash difference', () => {
    const q = agreeFluidExitCapacity(origin(), origin('rpc.ankr.com'))!
    expect(q.prongs.resolverExceedsDirectCash).toBe(true)
    expect(q.prongs.sharedLiquidityCashRaw).toBe('100')
    expect(q.executableMaximumRaw).toBeNull()
    expect(q.sourceEquivalence).toBe('unverified_at_captured_runtime')
    expect(q.pause).toBe('unknown')
    expect(q.authority).toBe('unknown')
    expect(q.holderExecutableExit).toBe(false)
    expect(selectedFluidExitCapacity(q, { ...q, source: q.source })).toEqual(q)
  })
  it('clamps S−W at zero without claiming a withdrawal', () => {
    const a = origin()
    a.expandedWithdrawalLimitRaw = '1001'
    a.withdrawableUntilLimitRaw = '0'
    a.resolverReportedWithdrawableRaw = '0'
    const q = agreeFluidExitCapacity(a, { ...a, host: 'rpc.ankr.com' })!
    expect(q.prongs.withdrawableUntilLimitRaw).toBe('0')
  })
  for (const key of [
    'resolverSupplyRaw',
    'expandedWithdrawalLimitRaw',
    'sharedLiquidityCashRaw',
  ] as const)
    it(`rejects coerced ${key}`, () => {
      const a = origin()
      ;(a as any)[key] = [a[key]]
      expect(agreeFluidExitCapacity(a, { ...a, host: 'rpc.ankr.com' })).toBeNull()
    })
  it('rejects invalid arithmetic and independently mismatched code/prongs/parameters', () => {
    const a = origin()
    for (const change of [
      () => {
        a.withdrawableUntilLimitRaw = '201'
      },
      () => {
        a.identities[0].codeHash = `0x${'c'.repeat(64)}`
      },
      () => {
        a.limitParameters.expandDuration = '1'
      },
    ]) {
      change()
      expect(agreeFluidExitCapacity(a, origin('rpc.ankr.com'))).toBeNull()
    }
  })
  it('rejects duplicate origins, wrong native decimals, sources and promoted future claims', () => {
    const a = origin()
    expect(agreeFluidExitCapacity(a, a)).toBeNull()
    const b = origin('rpc.ankr.com')
    b.assetDecimals = 18
    expect(agreeFluidExitCapacity(a, b)).toBeNull()
    const q = agreeFluidExitCapacity(a, origin('rpc.ankr.com'))!
    expect(
      selectedFluidExitCapacity({ ...q, holderExecutableExit: true }, { ...q, source: q.source }),
    ).toBeNull()
    expect(
      selectedFluidExitCapacity(q, { ...q, source: { ...q.source, blockNumber: 1 } }),
    ).toBeNull()
  })
  it('clones prongs and runtime identities', () => {
    const a = origin(),
      b = origin('rpc.ankr.com'),
      q = agreeFluidExitCapacity(a, b)!
    q.origins[0].identities[0].codeHash = 'changed'
    expect(a.identities[0].codeHash).not.toBe('changed')
  })
})
