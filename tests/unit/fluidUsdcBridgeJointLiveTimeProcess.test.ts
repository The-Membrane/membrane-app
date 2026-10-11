import { describe, expect, it } from 'vitest'
import {
  buildFluidUsdcBridgeJointLiveTimeProcess,
  type FluidUsdcBridgeJointLiveTimeInput,
} from '@/lib/carry/fluidUsdcBridgeJointLiveTimeProcess'
import {
  FLUID_BRIDGE_USDC,
  type FluidBridgeUsdcFrame,
} from '@/lib/carry/fluidBridgeUsdcJointHistoricalProcess'

// Controlled native-shaped math fixtures. No acquisition/authentication claim.
const owner = '0x1234567890123456789012345678901234567890'
const sourceAt = Date.parse('2026-10-08T12:00:00.000Z')
const readAt = sourceAt + 60000
const issueAt = sourceAt + 120000
function fixture(): FluidUsdcBridgeJointLiveTimeInput {
  const frame = (day: number, value: string): FluidBridgeUsdcFrame => ({
    source: {
      chainId: 1,
      blockNumber: String(100 + day),
      blockHash: `0x${String(day + 5).repeat(64)}`,
      blockTime: new Date(sourceAt + day * 86400000).toISOString(),
    },
    acquiredAtUtc: new Date(readAt).toISOString(),
    availableAtUtc: new Date(readAt).toISOString(),
    provenanceRef: `controlled:${day}`,
    holderSharesRaw: '1000000000000000000',
    shareDecimals: 18,
    asset: FLUID_BRIDGE_USDC,
    assetDecimals: 6,
    fundingUnit: 'gross_native_USDC',
    entitlementUnit: 'net_native_USDC',
    runtimeCodeHashes: Object.fromEntries(
      [1, 2, 3, 4].map((n) => [`0x${String(n).repeat(40)}`, `0x${String(n).repeat(64)}`]),
    ),
    regime: 'controlled-five-prong-fee5',
    paused: false,
    withdrawalFeeBps: 5,
    fullHolderNetUsdcRaw: '5000000',
    nativeProngs: {
      bridgeFunding: value,
      bankCash: '8000000',
      bankSupply: '8000000',
      bankWithdrawableUntilLimit: '8000000',
      bankResolverWithdrawable: '8000000',
    },
    provenanceKind: 'native_hypothetical_shares',
    owner: null,
    historicalOwnership: false,
  })
  const { provenanceKind: _kind, historicalOwnership: _ownership, ...current } = frame(0, '2000000')
  return {
    routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
    destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    asset: FLUID_BRIDGE_USDC,
    assetDecimals: 6,
    owner,
    requestedRaw: '1000000',
    issueAtUtc: new Date(issueAt).toISOString(),
    knowledgeCutoffUtc: new Date(readAt).toISOString(),
    horizonHours: 24,
    maxHistoricalGapSeconds: 91800,
    history: [frame(-3, '1000000'), frame(-2, '1100000'), frame(-1, '1200000')],
    current: { ...current, owner, readAtUtc: new Date(readAt).toISOString() },
  }
}
const build = (input = fixture()) => buildFluidUsdcBridgeJointLiveTimeProcess(input, () => true)
describe('Fluid USDC bridge live joint conditional math', () => {
  it('uses issue+H, accounts for source age and binds all prior-only same-S donors', () => {
    const result = build()!
    expect(result.targetAtUtc).toBe(new Date(issueAt + 86400000).toISOString())
    expect(result.counts).toEqual({ attempted: 2, usable: 2, censored: 0, excluded: 0 })
    expect(result.process?.intervalInputs).toHaveLength(2)
    expect(result.currentMeasurement).toEqual({
      fundingNetRaw: '1999000',
      fullEntitlementRaw: '5000000',
      capacityRaw: '1999000',
      headroomRaw: '999000',
    })
    const projectedGross = 2000000n + (100000n * BigInt(86400000 + 120000)) / 86400000n
    expect(result.process?.scenarios[0].targetHeadroomRaw).toBe(
      String((projectedGross * 9995n) / 10000n - 1000000n),
    )
    expect(result.MRaw).toBeNull()
    expect(result.historicalOwnershipProven).toBe(false)
    expect(result.executionProven).toBe(false)
  })
  it('applies Q once, independent of full shares and native full Ea', () => {
    const a = build()!,
      input = fixture()
    input.requestedRaw = '2000000'
    const b = build(input)!
    expect(b.fullEaRaw).toBe(a.fullEaRaw)
    expect(b.sharesRaw).toBe(a.sharesRaw)
    expect(
      BigInt(a.process!.scenarios[0].targetHeadroomRaw!) -
        BigInt(b.process!.scenarios[0].targetHeadroomRaw!),
    ).toBe(1000000n)
  })
  it('uses the minimum of all five gross prongs, nets funding once and does not renet net Ea', () => {
    const input = fixture()
    input.current.nativeProngs.bankResolverWithdrawable = '1000000'
    input.current.fullHolderNetUsdcRaw = '998000'
    expect(build(input)?.currentMeasurement).toEqual({
      fundingNetRaw: '999500',
      fullEntitlementRaw: '998000',
      capacityRaw: '998000',
      headroomRaw: '-2000',
    })
  })
  it.each(['shares', 'runtime', 'fee', 'cutoff'] as const)(
    'suppresses complete summary for %s mismatch',
    (kind) => {
      const input = fixture()
      if (kind === 'shares') input.history[0].holderSharesRaw = '999'
      if (kind === 'runtime')
        input.history[0].runtimeCodeHashes['0x' + '1'.repeat(40)] = '0x' + 'a'.repeat(64)
      if (kind === 'fee') input.history[0].withdrawalFeeBps = 6
      if (kind === 'cutoff') input.history[2].source = { ...input.current.source }
      expect(build(input)?.process?.targetSummary ?? null).toBeNull()
    },
  )
  it('censors negative native projections rather than repairing them to zero', () => {
    const input = fixture()
    input.history[0].nativeProngs.bridgeFunding = '8000000'
    input.history[1].nativeProngs.bridgeFunding = '0'
    const result = build(input)!
    expect(result.counts.censored).toBeGreaterThan(0)
    expect(result.process?.targetSummary).toBeNull()
  })
  it.each(['future_acquisition', 'stale', 'paused', 'current_owner'] as const)(
    'rejects %s',
    (kind) => {
      const input = fixture()
      if (kind === 'future_acquisition')
        input.history[0].acquiredAtUtc = input.history[0].availableAtUtc = new Date(
          issueAt + 1,
        ).toISOString()
      if (kind === 'stale') input.issueAtUtc = new Date(sourceAt + 1800001).toISOString()
      if (kind === 'paused') (input.current as unknown as { paused: boolean }).paused = true
      if (kind === 'current_owner') input.current.owner = '0x' + '2'.repeat(40)
      expect(build(input)).toBeNull()
    },
  )
  it('isolates modeled history from retained input mutations and requires approval', () => {
    const input = fixture(),
      result = build(input)!
    input.current.nativeProngs.bridgeFunding = '0'
    input.history[0].nativeProngs.bridgeFunding = '0'
    expect(result.input.current.nativeProngs.bridgeFunding).toBe('2000000')
    expect(result.input.history[0].nativeProngs.bridgeFunding).toBe('1000000')
    expect(buildFluidUsdcBridgeJointLiveTimeProcess(fixture(), () => false)).toBeNull()
  })
})
