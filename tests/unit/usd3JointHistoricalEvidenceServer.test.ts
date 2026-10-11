import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HolderExitCapacityBinding } from '@/lib/carry/holderExitCapacity'
import { resolveUsd3JointTrustedProfile } from '@/lib/carry/usd3JointTrustedProfile'

// These tests exercise orchestration and rejection only. Mock receipts and
// mocked current selection do NOT demonstrate production native authority.
const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  prepare: vi.fn(),
  origins: vi.fn(),
  capture: vi.fn(),
  replay: vi.fn(),
  encode: vi.fn(),
  decode: vi.fn(),
  beginRetention: vi.fn(),
  recordRetention: vi.fn(),
  finishRetention: vi.fn(),
}))
vi.mock('@/lib/carry/holderNativeHistoryOriginals.server', () => ({
  beginHolderNativeHistoryOriginalSeries: mocks.beginRetention,
  recordHolderNativeHistoryOriginalBatch: mocks.recordRetention,
  finishHolderNativeHistoryOriginalSeries: mocks.finishRetention,
}))
vi.mock('@/lib/carry/holderExitCapacity', () => ({
  HOLDER_CAPACITY_SOURCE_MAX_AGE_MS: 30 * 60 * 1000,
  selectedHolderExitCapacity: mocks.select,
}))
vi.mock('@/scripts/research/usd3-hypothetical-history-capture.mjs', () => ({
  prepareUsd3HypotheticalHistoryPlan: mocks.prepare,
  configuredUsd3HypotheticalOrigins: mocks.origins,
  captureUsd3HypotheticalHistory: mocks.capture,
  replayUsd3HypotheticalHistory: mocks.replay,
}))
vi.mock('@/lib/carry/usd3JointNativeEvidenceCodec', () => ({
  encodeUsd3JointNativeHistoryEvidence: mocks.encode,
  decodeUsd3JointNativeHistoryEvidence: mocks.decode,
}))
const profile = resolveUsd3JointTrustedProfile(
  'USDC → USD3 [USDC]',
  '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
)!
const OWNER = '0x0000000000000000000000000000000000000001'
const SOURCE = {
  chainId: 1 as const,
  blockNumber: 27_000_000,
  blockHash: '0x' + 'a'.repeat(64),
  blockTime: '2026-10-08T12:00:00.000Z',
  finalized: true as const,
}
const AS_OF = Date.parse(SOURCE.blockTime) + 10_000
function binding(owner = OWNER): HolderExitCapacityBinding {
  return {
    routeKey: profile.subject.routeKey,
    destination: profile.subject.destination,
    owner,
    requestedRaw: '1000000',
    asset: profile.subject.asset,
    assetDecimals: 6,
    currentSource: { ...SOURCE },
    asOfMs: AS_OF,
  }
}
function selected(owner = OWNER, sharesRaw = '9000000') {
  const quote = {
    source: SOURCE,
    sourceHolderPosition: { sharesRaw, shareDecimals: 6, method: 'balance_of_owner_at_source' },
    fullPositionEntitlementMethod: 'preview_redeem_full_position',
    fullPositionEntitlementRaw: '9500000',
    usd3NativeCapacity: {
      owner,
      resultStatus: 'quoted',
      capacityRaw: '7000000',
      shutdown: false,
      readAtUtc: new Date(AS_OF - 1000).toISOString(),
      runtimeProfile: {
        contracts: profile.runtimePins.map((p) => ({
          address: p.address,
          keccak256: p.runtimeKeccak256,
        })),
      },
    },
  }
  return {
    quote,
    origins: profile.originHosts.map((host) => ({ host, quote: structuredClone(quote) })),
  }
}
function decoded(owner = OWNER, sharesRaw = '9000000', acquired = AS_OF - 500) {
  return {
    profileId: profile.id,
    subject: { ...profile.subject, sharesRaw, withdrawalLimitSubject: owner },
    acquiredAtUtc: new Date(acquired).toISOString(),
    points: profile.anchors.map((a) => ({
      source: a.source,
      shutdown: false,
      hypotheticalSharesRaw: sharesRaw,
      withdrawalLimitSubject: owner,
      asset: profile.subject.asset,
      assetDecimals: 6,
      shareDecimals: 6,
      availableWithdrawLimitRaw: '7000000',
      nativeQuoteStatus: 'conditional_reference_address_quote',
      runtimeIdentities: profile.runtimePins.map((p) => ({
        address: p.address,
        runtimeKeccak256: p.runtimeKeccak256,
      })),
    })),
  }
}
async function reader() {
  return (await import('@/lib/carry/usd3JointHistoricalEvidence.server'))
    .readUsd3JointHistoricalEvidence
}
async function issueReader() {
  return (await import('@/lib/carry/usd3JointHistoricalEvidence.server'))
    .readUsd3JointHistoricalEvidenceAtIssue
}
afterEach(() => {
  vi.restoreAllMocks()
})
beforeEach(() => {
  vi.resetModules()
  Object.values(mocks).forEach((mock) => mock.mockReset())
  const facts = decoded()
  mocks.beginRetention.mockReturnValue(Object.freeze({ testOnlyHandle: true }))
  mocks.recordRetention.mockReturnValue({ status: 'partial', originalAuthority: false })
  mocks.finishRetention.mockReturnValue({ status: 'retained', originalAuthority: false })
  mocks.select.mockImplementation(() => selected())
  mocks.prepare.mockImplementation(() => ({ anchors: profile.anchors }))
  mocks.origins.mockResolvedValue(profile.originHosts.map((host) => ({ host })))
  mocks.capture.mockResolvedValue({ receipt: { mockedReceipt: true }, accepted: true })
  mocks.replay.mockReturnValue({ authoritativeNativeCapture: true, points: facts.points })
  mocks.encode.mockReturnValue({
    authenticated: false,
    originalAuthority: false,
    testOnly: 'normalized_transport',
  })
  mocks.decode.mockReturnValue(facts)
})
describe('USD3 server orchestration with simulated dependencies', () => {
  it('presnapshots before provider await and retains exact rejected raw input before replay', async () => {
    const receipt = { mockedReceipt: true, failedRawRead: 'original_rejected_payload' }
    mocks.capture.mockResolvedValue({ receipt, accepted: false })
    mocks.replay.mockImplementation(() => {
      throw Error('strict_original_replay_rejected')
    })
    expect(await (await reader())({}, binding())).toBeNull()
    expect(mocks.beginRetention).toHaveBeenCalledWith({ kind: 'usd3', sharesRaw: '9000000' })
    expect(mocks.beginRetention.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.origins.mock.invocationCallOrder[0],
    )
    expect(mocks.recordRetention).toHaveBeenCalledWith(mocks.beginRetention.mock.results[0].value, {
      batchIndex: 0,
      plan: mocks.prepare.mock.results[0].value,
      receipt,
      capturedAccepted: false,
    })
    expect(mocks.recordRetention.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replay.mock.invocationCallOrder[0],
    )
    expect(mocks.finishRetention).toHaveBeenCalledWith(mocks.beginRetention.mock.results[0].value, {
      qualification: false,
      reason: 'replay_rejected',
      batchQualifications: [false],
    })
    expect(mocks.encode).not.toHaveBeenCalled()
  })
  it('takes the actual issue clock after final retention and never exposes retention paths', async () => {
    let now = AS_OF
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    mocks.finishRetention.mockImplementation(() => {
      now = AS_OF + 1200
      return {
        status: 'retained',
        artifactDirectory: '/private/server-only',
        originalAuthority: false,
      }
    })
    const read = await issueReader(),
      result = await read({}, binding())
    expect(result?.issuedAtUtc).toBe(new Date(AS_OF + 1200).toISOString())
    expect(result).toEqual({
      evidence: mocks.encode.mock.results[0].value,
      issuedAtUtc: new Date(now).toISOString(),
    })
    expect(mocks.finishRetention).toHaveBeenCalledWith(mocks.beginRetention.mock.results[0].value, {
      qualification: true,
      reason: 'qualified',
      batchQualifications: [true],
    })
    expect(await read({}, { ...binding(), requestedRaw: '2000000' })).not.toBeNull()
    expect(mocks.beginRetention).toHaveBeenCalledTimes(1)
    expect(mocks.recordRetention).toHaveBeenCalledTimes(1)
    expect(mocks.finishRetention).toHaveBeenCalledTimes(1)
  })
  it('keeps native replay decisions independent of an unavailable retention sink', async () => {
    mocks.recordRetention.mockReturnValue({ status: 'unavailable', reason: 'disk_reserve' })
    mocks.finishRetention.mockReturnValue({
      status: 'unavailable',
      reason: 'disk_reserve',
      producerReplayQualification: false,
    })
    expect(await (await reader())({}, binding())).not.toBeNull()
    expect(mocks.replay).toHaveBeenCalledTimes(1)
    mocks.replay.mockReturnValue({ authoritativeNativeCapture: false, points: decoded().points })
    vi.resetModules()
    expect(await (await reader())({}, binding())).toBeNull()
  })
  it.each(['provider_unavailable', 'plan_rejected', 'capture_unavailable', 'codec_rejected'])(
    'finalizes %s once without inventing capture or replay qualification',
    async (reason) => {
      if (reason === 'provider_unavailable') mocks.origins.mockRejectedValue(Error('provider'))
      if (reason === 'plan_rejected')
        mocks.prepare.mockImplementation(() => {
          throw Error('plan')
        })
      if (reason === 'capture_unavailable') mocks.capture.mockRejectedValue(Error('capture'))
      if (reason === 'codec_rejected')
        mocks.encode.mockImplementation(() => {
          throw Error('codec')
        })
      expect(await (await reader())({}, binding())).toBeNull()
      expect(mocks.finishRetention).toHaveBeenCalledTimes(1)
      expect(mocks.finishRetention).toHaveBeenCalledWith(
        mocks.beginRetention.mock.results[0].value,
        {
          qualification: false,
          reason,
          batchQualifications: reason === 'codec_rejected' ? [true] : [],
        },
      )
      expect(mocks.recordRetention).toHaveBeenCalledTimes(reason === 'codec_rejected' ? 1 : 0)
    },
  )

  it('finalizes genuine late acquisition under the actual issue clock with one capture', async () => {
    const facts = decoded(OWNER, '9000000', AS_OF + 500)
    mocks.replay.mockReturnValue({ authoritativeNativeCapture: true, points: facts.points })
    mocks.decode.mockReturnValue(facts)
    vi.spyOn(Date, 'now').mockReturnValue(AS_OF + 1000)
    const read = await issueReader(),
      result = await read({}, binding())
    expect(result?.issuedAtUtc).toBe(new Date(AS_OF + 1000).toISOString())
    expect(result?.evidence).toEqual(mocks.encode.mock.results[0].value)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
  })
  it('rejects a backward actual issue clock without fabrication or recapture', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(AS_OF - 1)
    expect(await (await issueReader())({}, binding())).toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(1)
  })
  it('rejects source expiry during acquisition and cleans up the capture slot', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(AS_OF + 30 * 60 * 1000)
    const read = await issueReader()
    expect(await read({}, binding())).toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    vi.mocked(Date.now).mockReturnValue(AS_OF + 1000)
    expect(await read({}, binding())).not.toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(1)
  })
  it('makes one acquisition attempt on issue failure and permits a later request retry', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(AS_OF + 1000)
    mocks.capture.mockRejectedValueOnce(Error('simulated_failure'))
    const read = await issueReader()
    expect(await read({}, binding())).toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    expect(await read({}, binding())).not.toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(2)
  })
  it('uses the prepared exact owner/full S, factory origins, native defaults and strict replay', async () => {
    const read = await reader()
    expect(await read({}, binding())).toEqual(mocks.encode.mock.results[0].value)
    expect(mocks.prepare).toHaveBeenCalledWith({
      root: process.cwd(),
      sharesRaw: '9000000',
      withdrawalLimitSubject: OWNER,
    })
    expect(mocks.capture).toHaveBeenCalledWith(
      mocks.prepare.mock.results[0].value,
      await mocks.origins.mock.results[0].value,
      { root: process.cwd() },
    )
    expect(mocks.replay).toHaveBeenCalledWith(
      { mockedReceipt: true },
      mocks.prepare.mock.results[0].value,
    )
  })
  it('rejects invalid and accessor bindings before selecting or acquiring', async () => {
    const read = await reader(),
      getter = vi.fn(() => OWNER)
    const accessor = { ...binding() }
    Object.defineProperty(accessor, 'owner', { enumerable: true, get: getter })
    expect(await read({}, accessor)).toBeNull()
    expect(await read({}, { ...binding(), requestedRaw: '01' })).toBeNull()
    expect(await read({}, { ...binding(), owner: '0x' + '0'.repeat(40) })).toBeNull()
    expect(await read({}, { ...binding(), assetDecimals: 18 })).toBeNull()
    expect(getter).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
    expect(mocks.capture).not.toHaveBeenCalled()
  })
  it.each([
    'legacy_clock',
    'null_clock',
    'future_clock',
    'shutdown',
    'legacy_shutdown',
    'zero_s',
    'zero_ea',
    'runtime',
    'host',
  ])('rejects %s current facts before any acquisition', async (kind) => {
    const current = selected()
    if (kind === 'legacy_clock')
      Reflect.deleteProperty(current.quote.usd3NativeCapacity, 'readAtUtc')
    if (kind === 'null_clock') Object.assign(current.quote.usd3NativeCapacity, { readAtUtc: null })
    if (kind === 'future_clock')
      current.quote.usd3NativeCapacity.readAtUtc = new Date(AS_OF + 1).toISOString()
    if (kind === 'shutdown') current.quote.usd3NativeCapacity.shutdown = true
    if (kind === 'legacy_shutdown')
      Reflect.deleteProperty(current.quote.usd3NativeCapacity, 'shutdown')
    if (kind === 'zero_s') current.quote.sourceHolderPosition.sharesRaw = '0'
    if (kind === 'zero_ea') current.quote.fullPositionEntitlementRaw = '0'
    if (kind === 'runtime')
      current.quote.usd3NativeCapacity.runtimeProfile.contracts[0].keccak256 = '0x' + '0'.repeat(64)
    if (kind === 'host') current.origins[0].host = 'unapproved.example'
    mocks.select.mockReturnValue(current)
    expect(await (await reader())({}, binding())).toBeNull()
    expect(mocks.capture).not.toHaveBeenCalled()
  })
  it('rejects stale source and source newer than its original read clock', async () => {
    const current = selected()
    current.quote.usd3NativeCapacity.readAtUtc = new Date(
      Date.parse(SOURCE.blockTime) - 1,
    ).toISOString()
    mocks.select.mockReturnValue(current)
    const read = await reader()
    expect(await read({}, binding())).toBeNull()
    mocks.select.mockReturnValue(selected())
    expect(await read({}, { ...binding(), asOfMs: AS_OF + 30 * 60 * 1000 })).toBeNull()
    expect(mocks.capture).not.toHaveBeenCalled()
  })
  it('never substitutes structural success when strict original replay rejects', async () => {
    mocks.capture.mockResolvedValue({
      receipt: { mockedReceipt: true },
      accepted: true,
      structuralReplay: { authoritativeNativeCapture: true },
    })
    mocks.replay.mockImplementation(() => {
      throw Error('original_capture_authority_required')
    })
    expect(await (await reader())({}, binding())).toBeNull()
    expect(mocks.encode).not.toHaveBeenCalled()
  })
  it('rejects a false native authority flag and censored history', async () => {
    const read = await reader()
    mocks.replay.mockReturnValue({ authoritativeNativeCapture: false, points: decoded().points })
    expect(await read({}, binding())).toBeNull()
    const facts = decoded()
    Object.assign(facts.points[0], {
      availableWithdrawLimitRaw: null,
      nativeQuoteStatus: 'censored_native_withdrawal_limit_unavailable',
    })
    mocks.replay.mockReturnValue({ authoritativeNativeCapture: true, points: facts.points })
    mocks.decode.mockReturnValue(facts)
    expect(await read({}, binding())).toBeNull()
  })
  it('reuses historical anchors independently of Q and rechecks source expiry', async () => {
    const read = await reader()
    const first = await read({}, binding())
    expect(first).not.toBeNull()
    expect(await read({}, { ...binding(), requestedRaw: '2000000' })).toEqual(first)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    expect(await read({}, { ...binding(), asOfMs: AS_OF + 30 * 60 * 1000 })).toBeNull()
  })
  it('retains the true acquisition clock and rejects future knowledge until a later request', async () => {
    const facts = decoded(OWNER, '9000000', AS_OF + 1000)
    mocks.replay.mockReturnValue({ authoritativeNativeCapture: true, points: facts.points })
    mocks.decode.mockReturnValue(facts)
    const read = await reader()
    expect(await read({}, binding())).toBeNull()
    expect(await read({}, { ...binding(), asOfMs: AS_OF + 2000 })).not.toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(1)
  })
  it('coalesces the same owner/S and refuses a second key while capture is active', async () => {
    let finish!: (v: unknown) => void
    mocks.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const read = await reader(),
      a = read({}, binding()),
      b = read({}, binding())
    await Promise.resolve()
    await Promise.resolve()
    const other = '0x0000000000000000000000000000000000000002'
    mocks.select.mockReturnValue(selected(other))
    expect(await read({}, binding(other))).toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    finish({ receipt: { mockedReceipt: true } })
    expect(await a).not.toBeNull()
    expect(await b).not.toBeNull()
  })
  it('cleans up failed acquisition so the next request can retry', async () => {
    mocks.capture.mockRejectedValueOnce(Error('simulated_network_failure'))
    const read = await reader()
    expect(await read({}, binding())).toBeNull()
    expect(await read({}, binding())).not.toBeNull()
    expect(mocks.capture).toHaveBeenCalledTimes(2)
  })
})
