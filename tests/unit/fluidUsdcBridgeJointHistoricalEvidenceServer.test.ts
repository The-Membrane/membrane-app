import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HolderExitCapacityBinding } from '@/lib/carry/holderExitCapacity'
import { resolveFluidUsdcBridgeJointTrustedProfile } from '@/lib/carry/fluidUsdcBridgeJointTrustedProfile'
// Orchestration only: these mocks are never native-original acquisition evidence.
const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  prepare: vi.fn(),
  origins: vi.fn(),
  capture: vi.fn(),
  replay: vi.fn(),
  encode: vi.fn(),
  decode: vi.fn(),
  native: vi.fn(),
  recordBegin: vi.fn(),
  recordBatch: vi.fn(),
  recordFinish: vi.fn(),
}))
// Synthetic orchestration captures never reach the filesystem recorder.
vi.mock('@/lib/carry/holderNativeHistoryOriginals.server', () => ({
  beginHolderNativeHistoryOriginalSeries: mocks.recordBegin,
  recordHolderNativeHistoryOriginalBatch: mocks.recordBatch,
  finishHolderNativeHistoryOriginalSeries: mocks.recordFinish,
}))
vi.mock('@/lib/carry/holderExitCapacity', () => ({
  HOLDER_CAPACITY_SOURCE_MAX_AGE_MS: 1800000,
  selectedHolderExitCapacity: mocks.select,
}))
vi.mock('@/scripts/research/fluid-bridge-usdc-hypothetical-history-capture.mjs', () => ({
  prepareFluidBridgeUsdcHypotheticalHistoryPlan: mocks.prepare,
  configuredFluidBridgeUsdcHypotheticalOrigins: mocks.origins,
  captureFluidBridgeUsdcHypotheticalHistory: mocks.capture,
  replayFluidBridgeUsdcHypotheticalHistory: mocks.replay,
}))
vi.mock('@/lib/carry/fluidUsdcBridgeNativeCapacity', () => ({
  replayFluidUsdcBridgeNativeCapacityFact: mocks.native,
}))
vi.mock('@/lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec', () => ({
  encodeFluidUsdcBridgeJointNativeHistoryEvidence: mocks.encode,
  decodeFluidUsdcBridgeJointNativeHistoryEvidence: mocks.decode,
}))
const ROUTE = 'USDC → FluidBridgeAggregatorProxy [USDC]',
  VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012',
  ASSET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const profile = resolveFluidUsdcBridgeJointTrustedProfile(ROUTE, VAULT, ASSET)!
const NOW = Date.parse('2026-10-08T12:00:00.000Z'),
  S = '3000000000000000000',
  OWNER = '0x1234567890123456789012345678901234567890'
const source = {
  chainId: 1 as const,
  blockNumber: 27000000,
  blockHash: '0x' + 'a'.repeat(64),
  blockTime: new Date(NOW - 120000).toISOString(),
  finalized: true as const,
}
function binding(): HolderExitCapacityBinding {
  return {
    routeKey: ROUTE,
    destination: VAULT,
    asset: ASSET,
    assetDecimals: 6,
    owner: OWNER,
    requestedRaw: '1000000',
    currentSource: { ...source },
    asOfMs: NOW,
  }
}
function capacity() {
  const native = {
    sharesRaw: S,
    fullNetEaRaw: '7000000',
    paused: false,
    feeBps: 5,
    readAtUtc: new Date(NOW - 60000).toISOString(),
    runtimeCodeHashes: { ...profile.runtimeCodeHashes },
    nativeProngs: {
      bridgeFunding: '5000000',
      bankCash: '8000000',
      bankSupply: '8000000',
      bankWithdrawableUntilLimit: '6000000',
      bankResolverWithdrawable: '5500000',
    },
  }
  const quote = {
    source: { ...source },
    entitlementMethod: 'preview_redeem_full_position',
    entitlementRaw: '7000000',
    sourceHolderPosition: { sharesRaw: S, shareDecimals: 18, method: 'balance_of_owner_at_source' },
    fluidUsdcBridgeNativeCapacity: native,
  }
  return {
    quote,
    origins: profile.originHosts.map((host) => ({ host, quote: structuredClone(quote) })),
  }
}
function decoded() {
  return {
    profileId: profile.profileId,
    acquiredAtUtc: new Date(NOW + 1000).toISOString(),
    originalAuthority: false,
    authenticated: false,
    frames: profile.anchors.map((a) => ({
      source: { ...a.source, blockNumber: String(a.source.blockNumber) },
      holderSharesRaw: S,
      shareDecimals: 18,
      asset: ASSET,
      assetDecimals: 6,
      paused: false,
      withdrawalFeeBps: 5,
      owner: null,
      historicalOwnership: false,
      runtimeCodeHashes: { ...profile.runtimeCodeHashes },
      acquiredAtUtc: new Date(NOW + 1000).toISOString(),
    })),
  }
}
const reader = async () =>
  (await import('@/lib/carry/fluidUsdcBridgeJointHistoricalEvidence.server'))
    .readFluidUsdcBridgeJointHistoricalEvidenceAtIssue
beforeEach(() => {
  vi.resetModules()
  Object.values(mocks).forEach((m) => m.mockReset())
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 2000)
  mocks.select.mockImplementation((v) => v)
  mocks.recordBegin.mockReturnValue(Object.freeze({ syntheticRecorderHandle: true }))
  mocks.recordBatch.mockReturnValue({
    status: 'unavailable',
    reason: 'filesystem_unavailable',
    originalAuthority: false,
  })
  mocks.recordFinish.mockReturnValue({
    status: 'unavailable',
    reason: 'filesystem_unavailable',
    originalAuthority: false,
  })
  mocks.native.mockImplementation((v, _owner, s, now) =>
    v && v.paused === false && Date.parse(v.readAtUtc) <= now && s.blockHash === source.blockHash
      ? v
      : null,
  )
  mocks.prepare.mockImplementation(({ cashIndices, sharesRaw }) => ({
    anchors: profile.anchors.filter((a) => cashIndices.includes(a.cashIndex)),
    subject: { sharesRaw },
  }))
  mocks.origins.mockResolvedValue(profile.originHosts.map((host) => ({ host })))
  mocks.capture.mockResolvedValue({ accepted: true, receipt: { controlled: true } })
  mocks.replay.mockImplementation(() => ({
    authoritativeNativeCapture: true,
    points: Array.from({ length: 4 }, () => ({ hypotheticalSharesRaw: S })),
  }))
  mocks.encode.mockReturnValue({ originalAuthority: false, authenticated: false })
  mocks.decode.mockImplementation(() => decoded())
})
afterEach(() => vi.restoreAllMocks())
describe('Fluid server historical issue orchestration', () => {
  it('captures three sequential exact four-anchor plans for full S and issues only after acquisition', async () => {
    const b = binding(),
      c = capacity(),
      result = await (await reader())(c, b)
    expect(result?.issuedAtUtc).toBe(new Date(NOW + 2000).toISOString())
    expect(mocks.prepare.mock.calls.map(([o]) => o.cashIndices)).toEqual([
      [108, 109, 110, 111],
      [112, 113, 114, 115],
      [116, 117, 118, 119],
    ])
    expect(mocks.prepare.mock.calls.every(([o]) => o.sharesRaw === S)).toBe(true)
    expect(
      mocks.capture.mock.calls.every((args) => Object.keys(args[2]).join(',') === 'root'),
    ).toBe(true)
    expect(mocks.replay).toHaveBeenCalledTimes(3)
    expect(mocks.encode.mock.calls[0][0]).toHaveLength(3)
    expect(mocks.select.mock.calls.at(-1)?.[1].asOfMs).toBe(NOW + 2000)
    expect(mocks.recordBegin).toHaveBeenCalledWith({ kind: 'fluid_usdc_bridge', sharesRaw: S })
    expect(mocks.recordBegin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.origins.mock.invocationCallOrder[0],
    )
    expect(mocks.recordBatch).toHaveBeenCalledTimes(3)
    for (let n = 0; n < 3; n++) {
      expect(mocks.recordBatch.mock.invocationCallOrder[n]).toBeLessThan(
        mocks.replay.mock.invocationCallOrder[n],
      )
      expect(mocks.recordBatch.mock.calls[n][1].capturedAccepted).toBe(true)
    }
    expect(mocks.recordFinish.mock.calls[0][1]).toEqual({
      qualification: true,
      reason: 'qualified',
      batchQualifications: [true, true, true],
    })
  })
  it('rechecks current TTL after native acquisition and refuses stale current facts', async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse(source.blockTime) + 1800001)
    expect(await (await reader())(capacity(), binding())).toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(3)
  })
  it('fails closed on missing original capture authority and stops before the next batch', async () => {
    mocks.replay.mockReturnValue({
      authoritativeNativeCapture: false,
      points: Array.from({ length: 4 }, () => ({ hypotheticalSharesRaw: S })),
    })
    expect(await (await reader())(capacity(), binding())).toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    expect(mocks.encode).not.toHaveBeenCalled()
    expect(mocks.recordBatch).toHaveBeenCalledTimes(1)
    expect(mocks.recordBatch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replay.mock.invocationCallOrder[0],
    )
    expect(mocks.recordFinish.mock.calls[0][1]).toEqual({
      qualification: false,
      reason: 'replay_rejected',
      batchQualifications: [],
    })
  })
  it('retains rejected captures through the mocked sink and keeps the native rejection authoritative', async () => {
    mocks.capture.mockResolvedValue({ accepted: false, receipt: { originalRejectedControl: true } })
    expect(await (await reader())(capacity(), binding())).toBeNull()
    expect(mocks.recordBatch.mock.calls[0][1]).toMatchObject({
      capturedAccepted: false,
      receipt: { originalRejectedControl: true },
    })
    expect(mocks.recordFinish.mock.calls[0][1].qualification).toBe(false)
    expect(mocks.encode).not.toHaveBeenCalled()
  })
  it('rejects original aggregate/native-origin read, S/runtime/fee drift and future history', async () => {
    for (const variant of ['clock', 'pause', 'S', 'fee', 'runtime']) {
      const c = capacity()
      if (variant === 'clock')
        c.quote.fluidUsdcBridgeNativeCapacity.readAtUtc = new Date(NOW + 1).toISOString()
      if (variant === 'pause') c.quote.fluidUsdcBridgeNativeCapacity.paused = true
      if (variant === 'S') c.origins[1].quote.fluidUsdcBridgeNativeCapacity.sharesRaw = '1'
      if (variant === 'fee') c.origins[1].quote.fluidUsdcBridgeNativeCapacity.feeBps = 0
      if (variant === 'runtime')
        c.origins[1].quote.fluidUsdcBridgeNativeCapacity.runtimeCodeHashes[VAULT] =
          '0x' + 'b'.repeat(64)
      expect(await (await reader())(c, binding())).toBeNull()
    }
    mocks.decode.mockImplementation(() => ({
      ...decoded(),
      acquiredAtUtc: new Date(NOW + 3000).toISOString(),
    }))
    expect(await (await reader())(capacity(), binding())).toBeNull()
  })
  it('snapshots binding/current before awaiting and carries actual execution evidence to both selections', async () => {
    const b = { ...binding(), executionAgreement: { controlled: 'execution' } },
      c = capacity()
    mocks.origins.mockImplementation(async () => {
      b.owner = '0x' + '2'.repeat(40)
      b.requestedRaw = '99'
      c.quote.entitlementRaw = '1'
      return profile.originHosts.map((host) => ({ host }))
    })
    expect(await (await reader())(c, b)).not.toBeNull()
    expect(
      mocks.select.mock.calls.every(
        ([, binding]) =>
          binding.owner === OWNER &&
          binding.requestedRaw === '1000000' &&
          binding.executionAgreement.controlled === 'execution',
      ),
    ).toBe(true)
  })
  it('rejects accessors/cycles without invoking caller code or starting acquisition', async () => {
    let reads = 0
    const b = binding()
    Object.defineProperty(b, 'owner', {
      enumerable: true,
      get() {
        reads++
        return OWNER
      },
    })
    expect(await (await reader())(capacity(), b)).toBeNull()
    expect(reads).toBe(0)
    const c = capacity() as unknown as Record<string, unknown>
    c.loop = c
    expect(await (await reader())(c, binding())).toBeNull()
    expect(mocks.capture).not.toHaveBeenCalled()
  })
})
