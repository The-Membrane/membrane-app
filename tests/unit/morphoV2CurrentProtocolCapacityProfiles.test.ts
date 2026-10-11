import { readFileSync } from 'node:fs'
import { decodeFunctionData, decodeFunctionResult, parseAbi } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type {
  MorphoV2NativeSource,
  MorphoV2ProtocolOriginObservation,
  MorphoV2ProtocolRequestClient,
} from '@/lib/carry/morphoV2ProtocolCapacityReplay'

const legacyCapture = JSON.parse(
  readFileSync(
    'data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.json',
    'utf8',
  ),
)
async function setup() {
  vi.resetModules()
  const server = await import('@/lib/carry/morphoV2CurrentProtocolCapacityEvidence')
  const { createMorphoV2UsdtProtocolCapacityFixture } =
    await import('./fixtures/morphoV2UsdtProtocolCapacityFixture')
  const { resolveMorphoV2TrustedProfile } = await import('@/lib/carry/morphoV2TrustedProfiles')
  const { morphoV2PinnedProtocolHistory } =
    await import('@/lib/carry/morphoV2ProtocolCapacityHistoryPins')
  const subject = morphoV2PinnedProtocolHistory().subject
  const usdc = resolveMorphoV2TrustedProfile(subject.routeKey, subject.destination, subject.asset)!
  return { server, usdc, usdt: createMorphoV2UsdtProtocolCapacityFixture() }
}
function mockProvider(
  origin: MorphoV2ProtocolOriginObservation,
  mutate?: (key: string, result: unknown) => unknown,
) {
  let time = Date.parse(origin.startedAtUtc)
  const requests: Parameters<MorphoV2ProtocolRequestClient['request']>[0][] = []
  const client: MorphoV2ProtocolRequestClient = {
    request: async (request) => {
      requests.push(structuredClone(request))
      const trace = origin.traces.find(
        (row) =>
          row.method === request.method &&
          JSON.stringify(row.params) === JSON.stringify(request.params),
      )
      if (!trace) throw Error('mock_provider_unexpected_wire')
      time++
      return structuredClone(mutate ? mutate(trace.key, trace.result) : trace.result)
    },
  }
  return { client, now: () => time, requests }
}
function legacyProvider() {
  const host = legacyCapture.origins[0]
  const rows = legacyCapture.traces.filter((row: any) => row.origin === host && row.anchor === 2)
  const source: MorphoV2NativeSource = {
    chainId: 1,
    blockNumber: Number(legacyCapture.sources[2].blockNumber),
    blockHash: legacyCapture.sources[2].blockHash,
    blockTime: legacyCapture.sources[2].blockTime,
    finalized: true,
  }
  let time = Date.parse(legacyCapture.capturedAt)
  const requests: Parameters<MorphoV2ProtocolRequestClient['request']>[0][] = []
  const client: MorphoV2ProtocolRequestClient = {
    request: async (request) => {
      requests.push(structuredClone(request))
      const row = rows.find(
        (entry: any) =>
          entry.request.method === request.method &&
          JSON.stringify(entry.request.params) === JSON.stringify(request.params),
      )
      if (!row) throw Error('legacy_mock_unexpected_wire')
      time++
      return structuredClone(row.response.result)
    },
  }
  return { client, source, now: () => time, requests }
}

describe('profile-specific server producer/cache with mock providers and synthetic USDT clocks', () => {
  it('preserves default USDC and explicit private USDC with identical 31 native reads', async () => {
    const { server, usdc } = await setup()
    expect(await server.prewarmMorphoV2ProtocolHistory()).toBe(true)
    const legacy = legacyProvider()
    const explicit = legacyProvider()
    const a = await server.readMorphoV2CurrentProtocolOrigin(legacy.client, legacy.source, {
      now: legacy.now,
    })
    const b = await server.readMorphoV2CurrentProtocolOrigin(explicit.client, explicit.source, {
      now: explicit.now,
      profile: usdc,
    })
    expect(a).not.toBeNull()
    expect(b).toEqual(a)
    expect(legacy.requests).toHaveLength(31)
    expect(explicit.requests).toEqual(legacy.requests)
    expect(await server.morphoV2ProtocolReadPlan(legacy.source)).toEqual(
      await server.morphoV2ProtocolReadPlan(legacy.source, undefined, usdc),
    )
  }, 30000)

  it('requires its own prewarm and reads the USDT vault, asset, config and CURRENT market-dependent rate in 31 calls', async () => {
    const { server, usdt } = await setup()
    const profile = usdt.expected.profile!
    expect(await server.prewarmMorphoV2ProtocolHistory()).toBe(true)
    const f = mockProvider(usdt.pair.origins[0].observation)
    expect(
      await server.readMorphoV2CurrentProtocolOrigin(f.client, usdt.expected.source, {
        now: f.now,
        profile,
      }),
    ).toBeNull()
    expect(f.requests).toHaveLength(0)
    expect(await server.prewarmMorphoV2ProtocolHistory(profile)).toBe(true)
    const observation = await server.readMorphoV2CurrentProtocolOrigin(
      f.client,
      usdt.expected.source,
      { now: f.now, profile },
    )
    expect(observation).not.toBeNull()
    expect(f.requests).toHaveLength(31)
    expect(observation!.traces.map(({ method, params }) => ({ method, params }))).toEqual(
      f.requests,
    )
    expect(observation!.traces.find((trace) => trace.key === 'code_vault')!.params[0]).toBe(
      profile.subject.destination,
    )
    expect(observation!.traces.find((trace) => trace.key === 'code_asset')!.params[0]).toBe(
      profile.subject.asset,
    )
    expect(observation!.traces.find((trace) => trace.key === 'code_adapter')!.params[0]).toBe(
      profile.configured.adapter,
    )
    const rate = observation!.traces.find((trace) => trace.key === 'borrowRate')!
    const market = observation!.traces.find((trace) => trace.key === 'market')!
    expect(observation!.traces.indexOf(rate)).toBeGreaterThan(observation!.traces.indexOf(market))
    const decodedRate = decodeFunctionData({
      abi: parseAbi([
        'function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) params,(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee) market) view returns(uint256)',
      ]),
      data: (rate.params[0] as { data: `0x${string}` }).data,
    })
    const decodedMarket = decodeFunctionResult({
      abi: parseAbi([
        'function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)',
      ]),
      functionName: 'market',
      data: market.result as `0x${string}`,
    })
    expect(decodedRate.args![0].loanToken.toLowerCase()).toBe(profile.subject.asset)
    expect(decodedRate.args![0].irm.toLowerCase()).toBe(profile.configured.irm)
    expect(Object.values(decodedRate.args![1])).toEqual([...decodedMarket])
    expect(observation!.traces.at(-1)!.key).toBe('header_after')
    expect(
      await server.replayMorphoV2CurrentProtocolOrigin(
        observation,
        usdt.expected.source,
        usdt.expected.asOfMs,
        profile,
      ),
    ).not.toBeNull()
    expect(
      await server.replayMorphoV2CurrentProtocolOrigin(
        observation,
        usdt.expected.source,
        usdt.expected.asOfMs,
      ),
    ).toBeNull()
  }, 30000)

  it('rejects cloned and unknown profile authority before any read or cache lookup can enable it', async () => {
    const { server, usdt } = await setup()
    const profile = usdt.expected.profile!
    expect(await server.prewarmMorphoV2ProtocolHistory(profile)).toBe(true)
    const f = mockProvider(usdt.pair.origins[0].observation)
    for (const invalid of [
      structuredClone(profile),
      { ...profile, id: 'unknown_reviewed_profile' },
    ]) {
      expect(await server.prewarmMorphoV2ProtocolHistory(invalid)).toBe(false)
      expect(
        await server.readMorphoV2CurrentProtocolOrigin(f.client, usdt.expected.source, {
          now: f.now,
          profile: invalid,
        }),
      ).toBeNull()
      await expect(
        server.morphoV2ProtocolReadPlan(usdt.expected.source, undefined, invalid),
      ).rejects.toThrow('trusted_profile')
      expect(
        await server.replayMorphoV2CurrentProtocolCapacityEvidence(usdt.pair, {
          ...usdt.expected,
          profile: invalid,
        }),
      ).toBeNull()
    }
    expect(f.requests).toHaveLength(0)
  })

  it('replays source, origin pair and clock on every approval and refuses cross-profile receipts', async () => {
    const { server, usdc, usdt } = await setup()
    const approved = await server.approveMorphoV2CurrentProtocolCapacityEvidence(
      usdt.pair,
      usdt.expected,
    )
    expect(approved).not.toBeNull()
    expect(approved!.current.subject).toEqual(usdt.expected.profile!.subject)
    expect(approved!.acceptEvidence(approved!.current)).toBe(true)
    for (const expected of [
      { ...usdt.expected, profile: usdc },
      { ...usdt.expected, source: { ...usdt.expected.source, blockHash: `0x${'a'.repeat(64)}` } },
      { ...usdt.expected, originHosts: ['other.example', usdt.expected.originHosts[1]] },
      { ...usdt.expected, asOfMs: Date.parse(usdt.expected.source.blockTime) + 1800001 },
    ])
      expect(
        await server.approveMorphoV2CurrentProtocolCapacityEvidence(usdt.pair, expected),
      ).toBeNull()
    const copy = structuredClone(approved!.current)
    approved!.current.point.prongs.blueCashRaw = '1'
    usdt.pair.origins[0].observation.traces.find((trace) => trace.key === 'code_adapter')!.result =
      '0x00'
    expect(approved!.acceptEvidence(copy)).toBe(true)
    expect(approved!.acceptEvidence(approved!.current)).toBe(false)
    expect(
      await server.approveMorphoV2CurrentProtocolCapacityEvidence(usdt.pair, usdt.expected),
    ).toBeNull()
    const expired = mockProvider(usdt.pair.origins[1].observation)
    expect(
      await server.readMorphoV2CurrentProtocolOrigin(expired.client, usdt.expected.source, {
        profile: usdt.expected.profile,
        now: () => Date.parse(usdt.expected.source.blockTime) + 1800001,
      }),
    ).toBeNull()
    expect(expired.requests).toHaveLength(0)
  })

  it('fully rejects mismatched native runtime or asset config after bounded reads', async () => {
    const { server, usdt } = await setup()
    const profile = usdt.expected.profile!
    expect(await server.prewarmMorphoV2ProtocolHistory(profile)).toBe(true)
    for (const mutate of [
      (key: string, value: unknown) => (key === 'code_adapter' ? '0x00' : value),
      (key: string, value: unknown) =>
        key === 'asset'
          ? '0x' + '0'.repeat(24) + 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
          : value,
    ]) {
      const f = mockProvider(usdt.pair.origins[0].observation, mutate)
      expect(
        await server.readMorphoV2CurrentProtocolOrigin(f.client, usdt.expected.source, {
          now: f.now,
          profile,
        }),
      ).toBeNull()
      expect(f.requests).toHaveLength(31)
    }
  })
})
