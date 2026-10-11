import { createHash } from 'node:crypto'
import { decodeFunctionResult, parseAbi } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  approveMorphoV2CurrentProtocolCapacityEvidence,
  morphoV2ProtocolBorrowRateReadSpec,
  morphoV2ProtocolReadPlan,
  replayMorphoV2CurrentProtocolCapacityEvidence,
  replayMorphoV2CurrentProtocolOrigin,
} from '@/lib/carry/morphoV2ProtocolCapacityReplay'
import { morphoV2PinnedProtocolHistory } from '@/lib/carry/morphoV2ProtocolCapacityHistoryPins'
import { createMorphoV2ProtocolCapacityFixture } from './fixtures/morphoV2ProtocolCapacityFixture'
import { createMorphoV2UsdtProtocolCapacityFixture } from './fixtures/morphoV2UsdtProtocolCapacityFixture'
import { resolveMorphoV2TrustedProfile } from '@/lib/carry/morphoV2TrustedProfiles'
import * as reviewedHistories from '@/lib/carry/morphoV2ReviewedProtocolHistories'

const sha256Text = (text: string) => createHash('sha256').update(text).digest('hex')
const marketAbi = parseAbi([
  'function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)',
])

describe('browser-safe current Morpho native replay', () => {
  it('replays genuine saved native bytes and clocks without loading raw history', () => {
    const { pair, expected } = createMorphoV2ProtocolCapacityFixture()
    const single = replayMorphoV2CurrentProtocolOrigin(
      pair.origins[0].observation,
      expected.source,
      expected.asOfMs,
    )
    expect(single?.status).toBe('single_origin_conditional_configured_adapter_prongs')
    expect(single?.prongs.internalSharesRaw).toBe('986418728075')
    expect(single?.prongs.blueCashRaw).toBe('117494061623744')
    const current = replayMorphoV2CurrentProtocolCapacityEvidence(pair, expected, sha256Text)
    expect(current?.point.status).toBe('two_origin_conditional_configured_adapter_prongs')
    expect(current?.captureReceiptSha256).toBe(sha256Text(JSON.stringify(pair)))
    expect(current?.knowledgeCutoff).toBe(
      pair.origins
        .map(({ observation }) => observation.readAtUtc)
        .sort()
        .at(-1),
    )
    expect(current?.sourceImplementationEquivalence).toBe(false)
    expect(current?.runtimeIdentities).toHaveLength(5)
    expect(
      current?.runtimeIdentities.every(
        (identity) =>
          identity.implementationAddress === null && identity.implementationCodeHash === null,
      ),
    ).toBe(true)
    expect(current?.configured).toEqual(morphoV2PinnedProtocolHistory().configured)
  })

  it('builds complete31specs and derives borrow calldata from the CURRENT market', () => {
    const { pair, expected } = createMorphoV2ProtocolCapacityFixture()
    const observation = pair.origins[0].observation
    const marketTrace = observation.traces.find((trace) => trace.key === 'market')!
    const market = decodeFunctionResult({
      abi: marketAbi,
      functionName: 'market',
      data: marketTrace.result as `0x${string}`,
    })
    const base = morphoV2ProtocolReadPlan(expected.source)
    const complete = morphoV2ProtocolReadPlan(expected.source, market)
    const dynamic = morphoV2ProtocolBorrowRateReadSpec(expected.source, marketTrace.result)
    expect(base).toHaveLength(30)
    expect(complete).toHaveLength(31)
    expect(complete.at(-2)).toEqual(dynamic)
    expect(complete.at(-1)?.key).toBe('header_after')
    expect(complete.map(({ key }) => key)).toEqual(observation.traces.map(({ key }) => key))
    expect(dynamic.params).toEqual(
      observation.traces.find(({ key }) => key === 'borrowRate')!.params,
    )
    const changed = structuredClone(observation)
    const changedMarket = changed.traces.find(({ key }) => key === 'market')!
    const wire = changedMarket.result as string
    changedMarket.result =
      '0x' + (BigInt('0x' + wire.slice(2, 66)) + 1n).toString(16).padStart(64, '0') + wire.slice(66)
    expect(
      morphoV2ProtocolBorrowRateReadSpec(expected.source, changedMarket.result).params,
    ).not.toEqual(dynamic.params)
    // The unchanged historical rate call must not approve this changed current state.
    expect(
      replayMorphoV2CurrentProtocolOrigin(changed, expected.source, expected.asOfMs),
    ).toBeNull()
  })

  it('keeps canonical ABI, code identity, header enclosure and source freshness gates', () => {
    const { pair, expected } = createMorphoV2ProtocolCapacityFixture()
    const original = pair.origins[0].observation
    const mutations = [
      (observation: typeof original) => {
        observation.traces.find(({ key }) => key === 'idleCash')!.result += '00'.repeat(32)
      },
      (observation: typeof original) => {
        observation.traces.find(({ key }) => key === 'code_vault')!.result = '0x00'
      },
      (observation: typeof original) => {
        ;(observation.traces.at(-1)!.result as Record<string, unknown>).hash = '0x' + 'a'.repeat(64)
      },
      (observation: typeof original) => {
        observation.traces[1].startedAtUtc = new Date(
          Date.parse(observation.traces[0].completedAtUtc) - 1,
        ).toISOString()
      },
      (observation: typeof original) => {
        observation.source.finalized = false as true
      },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(original)
      mutate(changed)
      expect(
        replayMorphoV2CurrentProtocolOrigin(changed, expected.source, expected.asOfMs),
      ).toBeNull()
    }
    const trailing = original.traces.find(({ key }) => key === 'market')!.result + '00'.repeat(32)
    expect(() => morphoV2ProtocolBorrowRateReadSpec(expected.source, trailing)).toThrow()
    expect(
      replayMorphoV2CurrentProtocolOrigin(
        original,
        expected.source,
        Date.parse(expected.source.blockTime) + 1800001,
      ),
    ).toBeNull()
  })

  it('requires both distinct approved hosts and matching native prongs', () => {
    const { pair, expected } = createMorphoV2ProtocolCapacityFixture()
    const duplicate = structuredClone(expected)
    duplicate.originHosts = [expected.originHosts[0], expected.originHosts[0]]
    expect(replayMorphoV2CurrentProtocolCapacityEvidence(pair, duplicate, sha256Text)).toBeNull()
    const otherHost = structuredClone(pair)
    otherHost.origins[1].host = 'unapproved.example'
    expect(
      replayMorphoV2CurrentProtocolCapacityEvidence(otherHost, expected, sha256Text),
    ).toBeNull()
    const mismatch = structuredClone(pair)
    const cash = mismatch.origins[1].observation.traces.find(({ key }) => key === 'blueCash')!
    cash.result = '0x' + (BigInt(cash.result as string) + 1n).toString(16).padStart(64, '0')
    expect(replayMorphoV2CurrentProtocolCapacityEvidence(mismatch, expected, sha256Text)).toBeNull()
    expect(
      replayMorphoV2CurrentProtocolCapacityEvidence(pair, expected, () => 'invalid'),
    ).toBeNull()
    const falseDigest = () => '0'.repeat(64)
    expect(replayMorphoV2CurrentProtocolCapacityEvidence(pair, expected, falseDigest)).toBeNull()
    expect(approveMorphoV2CurrentProtocolCapacityEvidence(pair, expected, falseDigest)).toBeNull()
  })

  it('snapshots pair, external authority and approved evidence independently', () => {
    const { pair, expected } = createMorphoV2ProtocolCapacityFixture()
    let hashed = ''
    const approved = approveMorphoV2CurrentProtocolCapacityEvidence(pair, expected, (text) => {
      hashed = text
      return sha256Text(text)
    })
    expect(approved).not.toBeNull()
    expect(hashed).toBe(JSON.stringify(pair))
    const original = structuredClone(approved!.current)
    pair.origins[0].observation.traces[1].result = '0x00'
    expected.source.blockHash = '0x' + 'a'.repeat(64)
    approved!.current.point.prongs.blueCashRaw = '1'
    expect(approved!.acceptEvidence(original)).toBe(true)
    expect(approved!.acceptEvidence(approved!.current)).toBe(false)
  })

  it('returns zero-launch immediately for cold, in-flight and failed server history caches', async () => {
    const { expected } = createMorphoV2ProtocolCapacityFixture()
    let loads = 0
    let rejectHistory!: (reason: Error) => void
    const pending = new Promise<never>((_, reject) => {
      rejectHistory = reject
    })
    vi.resetModules()
    vi.doMock('@/lib/carry/morphoV2PilotHistoricalEvidence', () => ({
      loadMorphoV2PilotHistoricalEvidence: () => {
        loads++
        return pending
      },
    }))
    try {
      const server = await import('@/lib/carry/morphoV2CurrentProtocolCapacityEvidence')
      let launches = 0
      const client = {
        request: async () => {
          launches++
          throw Error('request_forbidden')
        },
      }
      const options = { now: () => expected.asOfMs }
      expect(
        await server.readMorphoV2CurrentProtocolOrigin(client, expected.source, options),
      ).toBeNull()
      expect(loads).toBe(0)
      const prewarm = server.prewarmMorphoV2ProtocolHistory()
      expect(loads).toBe(1)
      expect(
        await server.readMorphoV2CurrentProtocolOrigin(client, expected.source, options),
      ).toBeNull()
      expect(launches).toBe(0)
      rejectHistory(Error('raw_history_failed'))
      expect(await prewarm).toBe(false)
      expect(
        await server.readMorphoV2CurrentProtocolOrigin(client, expected.source, options),
      ).toBeNull()
      await Promise.resolve()
      expect(loads).toBe(1)
      expect(launches).toBe(0)
    } finally {
      vi.doUnmock('@/lib/carry/morphoV2PilotHistoricalEvidence')
      vi.resetModules()
    }
  })

  it('refuses to enable the server cache when raw-derived history differs from the fixed frame', async () => {
    const { expected } = createMorphoV2ProtocolCapacityFixture()
    const changed = morphoV2PinnedProtocolHistory()
    changed.history.points[0].prongs.blueCashRaw = '1'
    vi.resetModules()
    vi.doMock('@/lib/carry/morphoV2PilotHistoricalEvidence', () => ({
      loadMorphoV2PilotHistoricalEvidence: async () => ({ evidence: changed }),
    }))
    try {
      const server = await import('@/lib/carry/morphoV2CurrentProtocolCapacityEvidence')
      expect(await server.prewarmMorphoV2ProtocolHistory()).toBe(false)
      let launches = 0
      const client = {
        request: async () => {
          launches++
          throw Error('request_forbidden')
        },
      }
      expect(
        await server.readMorphoV2CurrentProtocolOrigin(client, expected.source, {
          now: () => expected.asOfMs,
        }),
      ).toBeNull()
      expect(launches).toBe(0)
    } finally {
      vi.doUnmock('@/lib/carry/morphoV2PilotHistoricalEvidence')
      vi.resetModules()
    }
  })
})

describe('private-profile native protocol replay', () => {
  it('requires two dense actual origins and canonical native request pins for both profiles', () => {
    for (const create of [
      createMorphoV2ProtocolCapacityFixture,
      createMorphoV2UsdtProtocolCapacityFixture,
    ]) {
      for (const fault of ['empty_origins', 'one_origin_hole', 'missing_source_pin'] as const) {
        const { pair, expected } = create()
        if (fault === 'empty_origins') pair.origins = new Array(2)
        if (fault === 'one_origin_hole') Reflect.deleteProperty(pair.origins, '0')
        if (fault === 'missing_source_pin') {
          for (const origin of pair.origins) {
            const trace = origin.observation.traces.find((t) => t.method === 'eth_call')!
            Reflect.deleteProperty(trace.params, '1')
          }
        }
        expect(
          replayMorphoV2CurrentProtocolCapacityEvidence(pair, expected, sha256Text),
          fault,
        ).toBeNull()
        expect(
          approveMorphoV2CurrentProtocolCapacityEvidence(pair, expected, sha256Text),
          fault,
        ).toBeNull()
      }
    }
  })

  it('refuses incomplete approved-current arrays without changing the retained approval', () => {
    for (const create of [
      createMorphoV2ProtocolCapacityFixture,
      createMorphoV2UsdtProtocolCapacityFixture,
    ]) {
      const { pair, expected } = create()
      const approved = approveMorphoV2CurrentProtocolCapacityEvidence(pair, expected, sha256Text)!
      expect(approved).not.toBeNull()
      for (const field of ['runtime', 'market', 'allocations'] as const) {
        const candidate = structuredClone(approved.current)
        const array =
          field === 'runtime'
            ? candidate.runtimeIdentities
            : field === 'market'
              ? candidate.point.prongs.market
              : candidate.point.prongs.allocationsRaw
        Reflect.deleteProperty(array, '0')
        expect(approved.acceptEvidence(candidate), field).toBe(false)
      }
      expect(approved.acceptEvidence(approved.current)).toBe(true)
    }
  })

  it('replays USDT with independent private authority using the same ordered 31 prongs', () => {
    const { pair, expected } = createMorphoV2UsdtProtocolCapacityFixture()
    const current = replayMorphoV2CurrentProtocolCapacityEvidence(pair, expected, sha256Text)
    expect(current).not.toBeNull()
    expect(current?.subject).toEqual(expected.profile!.subject)
    expect(current?.configured).toEqual(expected.profile!.configured)
    expect(current?.runtimeIdentities).toEqual(expected.profile!.runtimeIdentities)
    expect(current?.sourceImplementationEquivalence).toBe(false)
    expect(pair.origins.every(({ observation }) => observation.traces.length === 31)).toBe(true)
    expect(pair.origins[0].observation.traces.some(({ key }) => key === 'fullEa')).toBe(false)
    const rate = pair.origins[0].observation.traces.find(({ key }) => key === 'borrowRate')!
    const market = pair.origins[0].observation.traces.find(({ key }) => key === 'market')!
    expect(
      morphoV2ProtocolBorrowRateReadSpec(expected.source, market.result, expected.profile).params,
    ).toEqual(rate.params)
    const approved = approveMorphoV2CurrentProtocolCapacityEvidence(pair, expected, sha256Text)
    expect(approved?.acceptEvidence(current)).toBe(true)
    expect(
      approved?.acceptEvidence({ ...current, subject: morphoV2PinnedProtocolHistory().subject }),
    ).toBe(false)
  })

  it('retains the legacy USDC default and rejects profile, source and native-prong substitutions in both directions', () => {
    const usdc = createMorphoV2ProtocolCapacityFixture()
    const usdt = createMorphoV2UsdtProtocolCapacityFixture()
    const legacy = morphoV2PinnedProtocolHistory().subject
    const usdcProfile = resolveMorphoV2TrustedProfile(
      legacy.routeKey,
      legacy.destination,
      legacy.asset,
    )!
    expect(
      replayMorphoV2CurrentProtocolCapacityEvidence(usdc.pair, usdc.expected, sha256Text),
    ).toEqual(
      replayMorphoV2CurrentProtocolCapacityEvidence(
        usdc.pair,
        { ...usdc.expected, profile: usdcProfile },
        sha256Text,
      ),
    )
    for (const [own, other, profile] of [
      [usdc, usdt, usdcProfile],
      [usdt, usdc, usdt.expected.profile!],
    ] as const) {
      expect(
        replayMorphoV2CurrentProtocolCapacityEvidence(
          own.pair,
          { ...own.expected, profile: structuredClone(profile) },
          sha256Text,
        ),
      ).toBeNull()
      expect(
        replayMorphoV2CurrentProtocolCapacityEvidence(
          own.pair,
          {
            ...own.expected,
            profile: profile === usdcProfile ? usdt.expected.profile : usdcProfile,
          },
          sha256Text,
        ),
      ).toBeNull()
      expect(
        replayMorphoV2CurrentProtocolCapacityEvidence(
          own.pair,
          { ...own.expected, source: other.expected.source, profile },
          sha256Text,
        ),
      ).toBeNull()
      for (const key of [
        'code_vault',
        'code_asset',
        'code_adapter',
        'asset',
        'liquidityAdapter',
        'liquidityData',
        'adapterAsset',
        'adapterParentVault',
        'marketParams',
        'allocation0',
      ]) {
        const changed = structuredClone(own.pair)
        for (const origin of changed.origins) {
          const ownTrace = origin.observation.traces.find((trace) => trace.key === key)!
          const otherTrace = other.pair.origins[0].observation.traces.find(
            (trace) => trace.key === key,
          )!
          // Allocation read results may happen to match; substitute the native dependency calldata too.
          ownTrace.params = structuredClone(otherTrace.params)
          ownTrace.result = structuredClone(otherTrace.result)
        }
        expect(
          replayMorphoV2CurrentProtocolCapacityEvidence(
            changed,
            { ...own.expected, profile },
            sha256Text,
          ),
          key,
        ).toBeNull()
      }
      // Keep the own canonical request plan: these substitutions must fail the
      // decoded native configuration/runtime checks rather than a source-pin mismatch.
      for (const key of [
        'code_asset',
        'code_adapter',
        'asset',
        'liquidityAdapter',
        'liquidityData',
        'adapterAsset',
        'adapterParentVault',
        'marketParams',
      ]) {
        const changed = structuredClone(own.pair)
        const otherResult = other.pair.origins[0].observation.traces.find(
          (trace) => trace.key === key,
        )!.result
        for (const origin of changed.origins)
          origin.observation.traces.find((trace) => trace.key === key)!.result =
            structuredClone(otherResult)
        expect(
          replayMorphoV2CurrentProtocolCapacityEvidence(
            changed,
            { ...own.expected, profile },
            sha256Text,
          ),
          key,
        ).toBeNull()
      }
      for (const key of ['shareDecimals', 'assetDecimals']) {
        const changed = structuredClone(own.pair)
        for (const origin of changed.origins)
          origin.observation.traces.find((trace) => trace.key === key)!.result =
            '0x' + '0'.repeat(63) + '7'
        expect(
          replayMorphoV2CurrentProtocolCapacityEvidence(
            changed,
            { ...own.expected, profile },
            sha256Text,
          ),
        ).toBeNull()
      }
    }
    const flagged = {
      ...usdt.pair,
      profile: usdt.expected.profile,
      authenticated: true,
      approved: true,
    }
    const { profile: _ignored, ...withoutProfile } = usdt.expected
    expect(
      replayMorphoV2CurrentProtocolCapacityEvidence(flagged, withoutProfile, sha256Text),
    ).toBeNull()
    expect(() =>
      morphoV2ProtocolReadPlan(
        usdt.expected.source,
        undefined,
        structuredClone(usdt.expected.profile!),
      ),
    ).toThrow()
    expect(() =>
      morphoV2ProtocolBorrowRateReadSpec(
        usdt.expected.source,
        usdt.pair.origins[0].observation.traces.find(({ key }) => key === 'market')!.result,
        structuredClone(usdt.expected.profile!),
      ),
    ).toThrow()
  })

  it('rejects absent or incoherent selected history and failed external history approval', () => {
    const fixture = createMorphoV2UsdtProtocolCapacityFixture()
    const selector = vi
      .spyOn(reviewedHistories, 'reviewedMorphoV2ProtocolHistory')
      .mockReturnValue(null)
    try {
      expect(
        replayMorphoV2CurrentProtocolCapacityEvidence(fixture.pair, fixture.expected, sha256Text),
      ).toBeNull()
      expect(() =>
        morphoV2ProtocolReadPlan(fixture.expected.source, undefined, fixture.expected.profile),
      ).toThrow()
      selector.mockReturnValue(morphoV2PinnedProtocolHistory())
      expect(
        replayMorphoV2CurrentProtocolCapacityEvidence(fixture.pair, fixture.expected, sha256Text),
      ).toBeNull()
    } finally {
      selector.mockRestore()
    }
    const approval = vi
      .spyOn(reviewedHistories, 'approveReviewedMorphoV2ProtocolHistory')
      .mockReturnValue(false)
    try {
      expect(
        replayMorphoV2CurrentProtocolCapacityEvidence(fixture.pair, fixture.expected, sha256Text),
      ).toBeNull()
    } finally {
      approval.mockRestore()
    }
  })
})
