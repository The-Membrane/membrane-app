import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import currentReceipt from '@/data/research/venue-signals/fluid-protocol-capacity-current-usdc-2026-10-07T11-15.json'
import { FLUID_PROTOCOL_CAPACITY_HISTORY_PINS } from '@/lib/carry/fluidProtocolCapacityHistoryPins'
import {
  buildFluidProtocolCapacityProjection,
  selectedFluidProtocolCapacityProjection,
  fluidProtocolPinnedEpisode,
} from '@/lib/carry/fluidProtocolCapacityProjection'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = Date.parse('2026-10-07T11:24:00.000Z')
function fixture(pin = FLUID_PROTOCOL_CAPACITY_HISTORY_PINS[0]) {
  const raw = JSON.parse(readFileSync('data/research/venue-signals/' + pin.proofFileName, 'utf8'))
  const current =
    pin.compact.subject.assetDecimals === 6 && pin.compact.subject.routeKey.startsWith('USDC')
      ? structuredClone(currentReceipt.prongs)
      : structuredClone(raw.outcomes[1].receipt.prongs)
  // Controlled current-source fixture for routes without a real new-current capture.
  if (pin.compact.subject.routeKey !== currentReceipt.subject.routeKey) {
    current.source = {
      chainId: 1,
      blockNumber: 26140050,
      blockHash: `0x${'c'.repeat(64)}`,
      blockTime: '2026-10-07T11:00:00.000Z',
      finalized: true,
    }
    for (const o of current.origins) o.source = structuredClone(current.source)
  }
  const requestedRaw = (1000n * 10n ** BigInt(pin.compact.subject.assetDecimals)).toString(),
    readAt = '2026-10-07T11:23:00.000Z'
  const value = buildFluidProtocolCapacityProjection(
    {
      currentProngs: current,
      currentReadAtUtc: readAt,
      requestedRaw,
      horizonHours: 24,
      asOfMs: NOW,
    },
    hash,
  )!
  const expected = {
    ...pin.compact.subject,
    currentSource: current.source,
    currentProngs: current,
    currentReadAtUtc: readAt,
    requestedRaw,
    horizonHours: 24,
    asOfMs: NOW,
  }
  return { current, value, expected }
}
describe('Fluid protocol headroom join', () => {
  for (const pin of FLUID_PROTOCOL_CAPACITY_HISTORY_PINS)
    it(`native ${pin.compact.subject.routeKey} joins actual pinned donor with bounded current prongs`, () => {
      const f = fixture(pin)
      expect(f.value).not.toBeNull()
      expect(selectedFluidProtocolCapacityProjection(f.value, f.expected, hash)).toEqual(f.value)
      expect(f.value.projection.input.scope).toBe('protocol')
      expect(f.value.projection.horizons[0].elapsedSeconds).toEqual({ lower: 10884, upper: 10884 })
      expect(f.value.projection.horizons[0].episodeCount).toBe(1)
      expect(f.value.projection.holderExecutableExit).toBe(false)
      expect(f.value.projection.forwardProbability).toBe(false)
      expect(f.value.projection.executableMaximum).toBe(false)
      expect(f.value.projection.grossFlowAdded).toBe(false)
    })
  it('actual USDC joint delta subtracts Q once and preserves source-relative3h01m24s instead ofH24', () => {
    const f = fixture(),
      h = f.value.projection.horizons[0]
    expect(h.requestedHeadroom.p10Raw).toBe(
      (
        BigInt(currentReceipt.prongs.prongs.sharedLiquidityCashRaw) -
        22233936293n -
        BigInt(f.expected.requestedRaw)
      ).toString(),
    )
    expect(h.target.earliestAt).toBe('2026-10-07T13:57:47.000Z')
  })
  for (const key of [
    'requestedRaw',
    'horizonHours',
    'assetDecimals',
    'asset',
    'destination',
    'routeKey',
  ])
    it(`binds external ${key}`, () => {
      const f = fixture()
      ;(f.expected as any)[key] =
        key === 'horizonHours'
          ? 48
          : key === 'assetDecimals'
            ? 18
            : key === 'requestedRaw'
              ? '1'
              : 'foreign'
      expect(selectedFluidProtocolCapacityProjection(f.value, f.expected, hash)).toBeNull()
    })
  it('rejects coherent forged projection prongs while independent external C/S/W remains unchanged', () => {
    const f = fixture(),
      bad = structuredClone(f.value)
    for (const q of [bad.currentProngs.prongs, ...bad.currentProngs.origins])
      q.sharedLiquidityCashRaw = String(BigInt(q.sharedLiquidityCashRaw) + 1n)
    const rebuilt = buildFluidProtocolCapacityProjection(
      {
        ...f.expected,
        currentProngs: bad.currentProngs,
        currentReadAtUtc: f.expected.currentReadAtUtc,
      },
      hash,
    )
    expect(rebuilt).not.toBeNull()
    expect(selectedFluidProtocolCapacityProjection(rebuilt, f.expected, hash)).toBeNull()
  })
  it('full external history pin defeats donor alteration, arbitrary rule, invented holderE and promotion', () => {
    const f = fixture()
    for (const mutate of [
      (v: any) => (v.projection.input.episodes[0].observations[1].prongs.sharedCashRaw = '1'),
      (v: any) => (v.projection.input.adapter.rule = 'shared_cash'),
      (v: any) => {
        v.projection.input.scope = 'existing_holder'
        v.projection.input.holderEntitlementRaw = '1000000000000'
      },
      (v: any) => (v.projection.forwardProbability = true),
    ]) {
      const bad = structuredClone(f.value)
      mutate(bad)
      expect(selectedFluidProtocolCapacityProjection(bad, f.expected, hash)).toBeNull()
    }
  })
  it('strict primitives, sourcehash, inclusive30min and post-expiry or missing external prongs abstain', () => {
    const f = fixture(),
      expiry = Date.parse(f.current.source.blockTime) + 1800000
    expect(
      selectedFluidProtocolCapacityProjection(f.value, { ...f.expected, asOfMs: expiry }, hash),
    ).not.toBeNull()
    expect(
      selectedFluidProtocolCapacityProjection(f.value, { ...f.expected, asOfMs: expiry + 1 }, hash),
    ).toBeNull()
    expect(
      selectedFluidProtocolCapacityProjection(
        f.value,
        { ...f.expected, currentProngs: undefined },
        hash,
      ),
    ).toBeNull()
    expect(
      selectedFluidProtocolCapacityProjection(
        f.value,
        { ...f.expected, currentSource: { ...f.current.source, blockHash: `0x${'d'.repeat(64)}` } },
        hash,
      ),
    ).toBeNull()
    expect(
      buildFluidProtocolCapacityProjection(
        { ...f.expected, currentReadAtUtc: [f.expected.currentReadAtUtc] as any },
        hash,
      ),
    ).toBeNull()
  })
  it('episode pin is full data+knowledge cutoff and cloned across calls', () => {
    const pin = FLUID_PROTOCOL_CAPACITY_HISTORY_PINS[0],
      a = fluidProtocolPinnedEpisode(hash, pin.compact.subject)!
    a.observations[0].prongs.sharedCashRaw = '1'
    expect(
      fluidProtocolPinnedEpisode(hash, pin.compact.subject)!.observations[0].prongs.sharedCashRaw,
    ).not.toBe('1')
  })
  it('canonical pins reject nested memory mutation and donor resealing', () => {
    const pin = FLUID_PROTOCOL_CAPACITY_HISTORY_PINS[0]
    const before = fluidProtocolPinnedEpisode(hash, pin.compact.subject)!
    expect(Object.isFrozen(pin)).toBe(true)
    expect(Object.isFrozen(pin.compact)).toBe(true)
    expect(Object.isFrozen(pin.compact.subject)).toBe(true)
    expect(Object.isFrozen(pin.compact.targetProngs)).toBe(true)
    expect(Object.isFrozen(pin.compact.runtimeIdentities[0])).toBe(true)
    expect(Object.isFrozen(pin.compact.baselineLimitParameters)).toBe(true)
    const forged = structuredClone(pin.compact)
    forged.targetProngs.sharedLiquidityCashRaw = '1'
    const { sha256: _seal, ...body } = forged
    forged.sha256 = hash(JSON.stringify(body))
    expect(Reflect.set(pin, 'contentSha256', forged.sha256)).toBe(false)
    expect(Reflect.set(pin, 'compact', forged)).toBe(false)
    expect(Reflect.set(pin.compact.targetProngs, 'sharedLiquidityCashRaw', '1')).toBe(false)
    expect(fluidProtocolPinnedEpisode(hash, pin.compact.subject)).toEqual(before)
  })
  it('exported episode objects have independent identity/runtime/parameter trees across calls', () => {
    const pin = FLUID_PROTOCOL_CAPACITY_HISTORY_PINS[0]
    const a = fluidProtocolPinnedEpisode(hash, pin.compact.subject)!,
      b = fluidProtocolPinnedEpisode(hash, pin.compact.subject)!
    expect(a).toEqual(b)
    a.identity.asset = 'foreign'
    ;(a.observations[0].runtimeIdentities as any)[0].codeHash = 'foreign'
    ;(a.observations[0].limitParameters as any).baseWithdrawalLimitRaw = '1'
    expect(fluidProtocolPinnedEpisode(hash, pin.compact.subject)).toEqual(b)
    expect(a).not.toEqual(b)
  })
  it('request horizon binds identity but never rescales actual donor target', () => {
    const f = fixture()
    for (const horizonHours of [1, 48, 168]) {
      const value = buildFluidProtocolCapacityProjection({ ...f.expected, horizonHours }, hash)!
      expect(value).not.toBeNull()
      expect(value.projection.horizons).toEqual(f.value.projection.horizons)
      expect(
        selectedFluidProtocolCapacityProjection(value, { ...f.expected, horizonHours }, hash),
      ).toEqual(value)
    }
  })
})

function holderFixture() {
  const f = fixture()
  const owner = `0x${'b'.repeat(40)}` as `0x${string}`
  const assessment: HolderExitAssessment = {
    status: 'assessed',
    routeKey: f.current.routeKey,
    destinationAddress: f.current.destination as `0x${string}`,
    owner,
    request: {
      assetsRaw: f.expected.requestedRaw,
      assetAddress: f.current.asset as `0x${string}`,
      horizonHours: 24,
    },
    source: { ...f.current.source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'reverted',
        assetAddress: f.current.asset as `0x${string}`,
        amountRaw: f.expected.requestedRaw,
      },
    ],
    finalPayout: {
      status: 'unassessed',
      assetAddress: f.current.asset as `0x${string}`,
      amountRaw: null,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: '500000000',
      quotedMaxWithdrawRaw: '0',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    NOW,
  )!
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    NOW,
  )!
  const holder = {
    capacityAgreement,
    binding: {
      routeKey: f.current.routeKey,
      destination: f.current.destination,
      owner,
      requestedRaw: f.expected.requestedRaw,
      asset: f.current.asset,
      assetDecimals: f.current.assetDecimals,
      currentSource: f.current.source,
      asOfMs: NOW,
    },
  }
  const expected = { ...f.expected, holder }
  return { ...f, holder, expected, value: buildFluidProtocolCapacityProjection(expected, hash)! }
}
describe('Fluid independently bound holder entitlement', () => {
  it('retains quoted E when current Q reverts and M is zero; clips protocol capacity before Q once', () => {
    const f = holderFixture()
    expect(f.holder.capacityAgreement).not.toBeNull()
    expect(f.value).not.toBeNull()
    expect(selectedFluidProtocolCapacityProjection(f.value, f.expected, hash)).toEqual(f.value)
    expect(f.value.scope).toBe('entitlement_clipped_conditional_scenario')
    expect(f.value.projection.input.scope).toBe('existing_holder')
    expect(f.value.projection.input.holderEntitlementRaw).toBe('500000000')
    expect(f.value.projection.input.current).toEqual(fixture().value.projection.input.current)
    expect(f.value.projection.horizons[0].requestedHeadroom.p10Raw).toBe('-500000000')
    expect(f.value.projection.holderExecutableExit).toBe(false)
    expect(f.value.projection.executableMaximum).toBe(false)
    expect(f.value.projection.forwardProbability).toBe(false)
    expect(f.holder.capacityAgreement.quote.successfulRequestedRawLowerBound).toBeNull()
  })
  for (const key of [
    'owner',
    'requestedRaw',
    'asset',
    'assetDecimals',
    'routeKey',
    'destination',
    'currentSource',
  ])
    it(`rejects mismatched external holder ${key}`, () => {
      const f = holderFixture(),
        expected = structuredClone(f.expected)
      ;(expected.holder.binding as any)[key] =
        key === 'assetDecimals'
          ? 18
          : key === 'currentSource'
            ? { ...expected.currentSource, blockHash: `0x${'d'.repeat(64)}` }
            : key === 'requestedRaw'
              ? '1'
              : key === 'owner'
                ? `0x${'c'.repeat(40)}`
                : 'foreign'
      expect(buildFluidProtocolCapacityProjection(expected, hash)).toBeNull()
      expect(selectedFluidProtocolCapacityProjection(f.value, expected, hash)).toBeNull()
    })
  it('rejects payload-only E/owner, missing quote E and forged success floor without execution proof', () => {
    const f = holderFixture()
    const bad = structuredClone(f.value)
    bad.holder!.binding.owner = `0x${'c'.repeat(40)}`
    expect(selectedFluidProtocolCapacityProjection(bad, f.expected, hash)).toBeNull()
    expect(selectedFluidProtocolCapacityProjection(f.value, fixture().expected, hash)).toBeNull()
    for (const field of ['entitlementRaw', 'successfulRequestedRawLowerBound']) {
      const expected = structuredClone(f.expected)
      for (const q of [
        expected.holder.capacityAgreement.quote,
        ...expected.holder.capacityAgreement.origins.map((o) => o.quote),
      ])
        (q as any)[field] = field === 'entitlementRaw' ? null : expected.requestedRaw
      expect(buildFluidProtocolCapacityProjection(expected, hash)).toBeNull()
    }
  })
  it('holder evidence is cloned and inclusive source expiry is rechecked at render clock', () => {
    const f = holderFixture(),
      expiry = Date.parse(f.current.source.blockTime) + 1800000
    const at = (asOfMs: number) => ({
      ...f.expected,
      asOfMs,
      holder: { ...f.holder, binding: { ...f.holder.binding, asOfMs } },
    })
    expect(selectedFluidProtocolCapacityProjection(f.value, at(expiry), hash)).not.toBeNull()
    expect(selectedFluidProtocolCapacityProjection(f.value, at(expiry + 1), hash)).toBeNull()
    expect(selectedFluidProtocolCapacityProjection(f.value, at(NOW - 1), hash)).toBeNull()
    f.value.holder!.binding.owner = 'foreign'
    expect(f.holder.binding.owner).not.toBe('foreign')
  })
})
