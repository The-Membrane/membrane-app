import { describe, it, expect } from 'vitest'
import {
  buildConditionalProtocolCapacityProjection as build,
  selectedConditionalProtocolCapacityProjection as select,
  type ProtocolProjectionInput,
  type ProtocolEpisode,
} from '../../lib/carry/conditionalProtocolCapacityProjection'
const at = Date.parse('2026-10-07T12:00:00.000Z'),
  identity = {
    routeKey: 'USDC → Fluid USD Coin [USDC]',
    destination: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
  }
const prongs = (C: number | string, S = 200, W = 0) => ({
  sharedCashRaw: String(C),
  fTokenSupplyRaw: String(S),
  resolverSupplyRaw: String(S),
  minimumRemainingSupplyRaw: String(W),
})
function episode(id: string, C: number[], S?: number[]): ProtocolEpisode {
  return {
    id,
    historySha256: (id === 'a' ? 'a' : 'b').repeat(64),
    knowledgeCutoffAt: '2026-10-06T00:00:00.000Z',
    identity,
    gapAfterIndices: [],
    observations: C.map((cash, i) => ({
      source: {
        chainId: 1,
        blockNumber: (id === 'a' ? 100 : 300) + i,
        blockHash: '0x' + String(i + (id === 'a' ? 1 : 301)).padStart(64, '0'),
        blockTime: new Date(at - 6 * 86400000 + i * 3600000).toISOString(),
      },
      prongs: prongs(cash, S?.[i] ?? 200),
      runtimeIdentities: { code: 'unknown' },
      limitParameters: { expandPercent: '1000', reportedDecayAmountRaw: '999' },
    })),
  }
}
function input(episodes = [episode('a', [100, 80, 110, 10, 100])]): ProtocolProjectionInput {
  return {
    identity,
    current: {
      source: {
        chainId: 1,
        blockNumber: 2000,
        blockHash: '0x' + 'f'.repeat(64),
        blockTime: new Date(at).toISOString(),
      },
      prongs: prongs(100),
      runtimeIdentities: { code: 'unknown' },
      limitParameters: { expandPercent: '1000', reportedDecayAmountRaw: '999' },
      readAtUtc: new Date(at + 1000).toISOString(),
      sourceKind: 'manifest_bound_ledger',
    },
    adapter: { rule: 'shared_cash_supply_less_remaining_limit', supplyView: 'resolver_supply' },
    scope: 'protocol',
    requestedRaw: '90',
    holderEntitlementRaw: null,
    episodes,
    asOfMs: at + 600000,
  }
}
function selector(value: ReturnType<typeof build>, i: ProtocolProjectionInput, asOfMs = i.asOfMs) {
  const expected = {
    identity: i.identity,
    current: i.current,
    adapter: i.adapter,
    scope: i.scope,
    requestedRaw: i.requestedRaw,
    holderEntitlementRaw: i.holderEntitlementRaw,
    asOfMs,
  }
  return select(value, expected, (sha, e) =>
    i.episodes.some(
      (original) =>
        original.historySha256 === sha && JSON.stringify(original) === JSON.stringify(e),
    ),
  )
}
describe('conditional joint protocol prongs', () => {
  it('retains whole jointpaths, exactQ once, physical earliesttrough, sampled runs', () => {
    const value = build(input())!
    expect(value.scenarios[0].points.map((p) => p.requestedHeadroomRaw)).toEqual([
      '10',
      '-10',
      '20',
      '-80',
      '10',
    ])
    expect(value.scenarios[0].troughIndex).toBe(3)
    expect(value.scenarios[0].sampledBelowRequestedRuns).toEqual([
      {
        firstBelowIndex: 1,
        lastBelowIndex: 1,
        onset: { lowerSeconds: 0, upperSeconds: 3600 },
        recovery: { lowerSeconds: 3600, upperSeconds: 7200 },
        leftCensored: false,
        rightCensored: false,
      },
      {
        firstBelowIndex: 3,
        lastBelowIndex: 3,
        onset: { lowerSeconds: 7200, upperSeconds: 10800 },
        recovery: { lowerSeconds: 10800, upperSeconds: 14400 },
        leftCensored: false,
        rightCensored: false,
      },
    ])
  })
  it('joint min precedes average and preserves covariance instead of min(mean)', () => {
    const i = input([episode('a', [100, 0], [100, 200]), episode('b', [100, 200], [100, 0])])
    i.current.prongs = prongs(100, 100)
    i.requestedRaw = '10'
    const value = build(i)!
    expect(value.horizons[0].reportedQuote.mean).toEqual({ numeratorRaw: '0', denominator: 2 })
    expect(value.horizons[0].requestedHeadroom.mean).toEqual({
      numeratorRaw: '-20',
      denominator: 2,
    })
  })
  it('floors each translated prong before mean rather than flooring the average', () => {
    const i = input([episode('a', [300, 0]), episode('b', [0, 200])])
    i.adapter.rule = 'shared_cash'
    expect(build(i)!.horizons[0].reportedQuote.mean).toEqual({
      numeratorRaw: '300',
      denominator: 2,
    })
  })
  it('holder clipping follows translated protocol prongs and leaves protocol scope distinct', () => {
    const i = input()
    i.scope = 'existing_holder'
    i.holderEntitlementRaw = '70'
    const value = build(i)!
    expect(value.scenarios[0].points[0].reportedProngQuoteRaw).toBe('100')
    expect(value.scenarios[0].points[0].afterHolderClipRaw).toBe('70')
    expect(value.scenarios[0].points[0].requestedHeadroomRaw).toBe('-20')
    expect(value.holderEntitlementAssumption).toBe(
      'fixed_entitlement_no_new_earnings_or_position_changes',
    )
    expect(build(input())!.holderEntitlementAssumption).toBeNull()
  })
  it('does not silently turn missing holderE into existing-holder capacity', () => {
    const i = input()
    i.scope = 'existing_holder'
    expect(build(i)).toBeNull()
    i.holderEntitlementRaw = undefined
    expect(build(i)).toBeNull()
    i.scope = 'protocol'
    expect(build(i)).not.toBeNull()
  })
  it('reports chosen S view, retains both S facts and ignores stored-space decay in cash math', () => {
    const i = input([episode('a', [100, 100])])
    i.current.prongs.fTokenSupplyRaw = '20'
    expect(build(i)!.scenarios[0].points[1].reportedProngQuoteRaw).toBe('100')
    i.adapter.supplyView = 'fToken_reported_supply'
    const value = build(i)!
    expect(value.scenarios[0].points[1].reportedProngQuoteRaw).toBe('20')
    expect(value.input.current.prongs.resolverSupplyRaw).toBe('200')
    expect(value.input.current.limitParameters).toEqual(i.current.limitParameters)
  })
  it('floors C,S,W independently and never subtracts gross flow a second time', () => {
    const i = input([episode('a', [100, 0], [200, 0])])
    expect(build(i)!.scenarios[0].points[1].prongs).toEqual(prongs(0, 0))
    expect(build(i)!.grossFlowAdded).toBe(false)
  })
  it('keeps earliest tie for physical trough and honest left/right censor', () => {
    const i = input([episode('a', [100, 80, 80])])
    i.requestedRaw = '110'
    const s = build(i)!.scenarios[0]
    expect(s.troughIndex).toBe(1)
    expect(s.sampledBelowRequestedRuns[0].leftCensored).toBe(true)
    expect(s.sampledBelowRequestedRuns[0].rightCensored).toBe(true)
    expect(s.sampledBelowRequestedRuns[0].recovery).toBeNull()
  })
  it('interior gaps censor both sides and cannot fabricate recovery across unknown observations', () => {
    const i = input([episode('a', [100, 80, 80, 100])])
    i.episodes[0].gapAfterIndices = [1]
    const runs = build(i)!.scenarios[0].sampledBelowRequestedRuns
    expect(runs).toHaveLength(2)
    expect(runs[0].rightCensored).toBe(true)
    expect(runs[0].recovery).toBeNull()
    expect(runs[1].leftCensored).toBe(true)
    expect(runs[1].onset).toBeNull()
  })
  it('actual elapsed brackets are future ranges rather than H24 labels', () => {
    const i = input([episode('a', [100, 80]), episode('b', [100, 120])])
    i.episodes[1].observations[1].source.blockTime = new Date(
      at - 6 * 86400000 + 4 * 3600000,
    ).toISOString()
    const value = build(i)!
    expect(value.horizons[0].elapsedSeconds).toEqual({ lower: 3600, upper: 14400 })
    expect(value.horizons[0].target).toEqual({
      earliestAt: new Date(at + 3600000).toISOString(),
      latestAt: new Date(at + 14400000).toISOString(),
    })
  })
  it('one sparse episode remains conditional with count1 and no probability/calibration/maximum', () => {
    const value = build(input())!
    expect(value.horizons[0].episodeCount).toBe(1)
    expect(value.forwardProbability).toBe(false)
    expect(value.calibrated).toBe(false)
    expect(value.executableMaximum).toBe(false)
    expect(value.cashBelowRequestedImpliesHolderFailure).toBe(false)
    expect(value.pause).toBe('unknown')
    expect(value.authority).toBe('unknown')
  })
  it('unknown source equivalence remains an explicit assumption rather than dropping conditional paths', () => {
    const i = input()
    i.current.runtimeIdentities = null
    i.current.limitParameters = null
    const value = build(i)!
    expect(value.scenarios[0].regime.observedParametersMatch).toBe(false)
    expect(value.scenarios[0].regime.sourceEquivalence).toBe('unverified')
    expect(value.scenarios[0].regime.proxyImplementationContinuity).toBe('unknown')
  })
  it.each(['shared_cash', 'reported_supply_less_remaining_limit'] as const)(
    'supports generic reported rule %s',
    (rule) => {
      const i = input()
      i.adapter.rule = rule
      expect(build(i)).not.toBeNull()
    },
  )
  it('inclusive30min current source allowed, nextmillisecond stale rejected', () => {
    const i = input([episode('a', [100, 80])])
    i.asOfMs = at + 1800000
    expect(build(i)).not.toBeNull()
    i.asOfMs++
    expect(build(i)).toBeNull()
  })
  it('target must be strictly future at issue/render time', () => {
    const i = input()
    i.episodes[0].observations[1].source.blockTime = new Date(
      at - 6 * 86400000 + 600000,
    ).toISOString()
    expect(build(i)).toBeNull()
  })
  it('rejects readAt/asOf causality and future training beyond C2', () => {
    for (const change of [
      (i: ProtocolProjectionInput) => (i.current.readAtUtc = new Date(at - 1).toISOString()),
      (i: ProtocolProjectionInput) => (i.current.readAtUtc = new Date(i.asOfMs + 1).toISOString()),
      (i: ProtocolProjectionInput) =>
        (i.episodes[0].observations[1].source.blockTime = new Date(at + 1).toISOString()),
      (i: ProtocolProjectionInput) =>
        (i.episodes[0].knowledgeCutoffAt = new Date(i.asOfMs + 1).toISOString()),
    ]) {
      const i = input()
      change(i)
      expect(build(i)).toBeNull()
    }
  })
  it('rejects foreign native units, malformed primitive uints, duplicate ids, gaps and clocks', () => {
    for (const change of [
      (i: ProtocolProjectionInput) => (i.episodes[0].identity = { ...identity, assetDecimals: 18 }),
      (i: ProtocolProjectionInput) => (i.current.prongs.sharedCashRaw = '1e3'),
      (i: ProtocolProjectionInput) =>
        (i.current.sourceKind =
          'manifest_bound_two_origin_ledger' as ProtocolProjectionInput['current']['sourceKind']),
      (i: ProtocolProjectionInput) => i.episodes.push(structuredClone(i.episodes[0])),
      (i: ProtocolProjectionInput) =>
        i.episodes.push({ ...structuredClone(i.episodes[0]), id: 'renamed' }),
      (i: ProtocolProjectionInput) => (i.episodes[0].gapAfterIndices = [99]),
      (i: ProtocolProjectionInput) => (i.episodes[0].observations[1].source.blockNumber = 100),
    ]) {
      const i = input()
      change(i)
      expect(build(i)).toBeNull()
    }
  })
  it('preserves bigint precision above2^53 with signed deficits and rational means', () => {
    const i = input([episode('a', [100, 100])])
    i.adapter.rule = 'shared_cash'
    i.current.prongs.sharedCashRaw = '900719925474099300000000'
    i.requestedRaw = '900719925474099300000001'
    const value = build(i)!
    expect(value.horizons[0].reportedQuote.mean).toEqual({
      numeratorRaw: '900719925474099300000000',
      denominator: 1,
    })
    expect(value.horizons[0].requestedHeadroom.p10Raw).toBe('-1')
  })
  it('browser selector rederives every fact against external current/Q/time and full pinned episode', () => {
    const i = input(),
      value = build(i)!
    expect(selector(value, i)).not.toBeNull()
    const changed = input()
    changed.requestedRaw = '91'
    expect(selector(value, changed)).toBeNull()
    changed.requestedRaw = '90'
    changed.current.source.blockHash = '0x' + 'e'.repeat(64)
    expect(selector(value, changed)).toBeNull()
    expect(selector(value, i, at + 1800001)).toBeNull()
  })
  it('browser rejects forged full values and forged donor facts retaining a valid pin hash', () => {
    const i = input(),
      value = build(i)!
    const forged = structuredClone(value)
    forged.horizons[0].reportedQuote.p90Raw = '999'
    expect(selector(forged, i)).toBeNull()
    const forgedInput = structuredClone(i)
    forgedInput.episodes[0].observations[1].prongs.sharedCashRaw = '999'
    expect(selector(build(forgedInput), i)).toBeNull()
  })
})

it('null or empty regime evidence never claims a match and leaves conditional estimates available', () => {
  for (const unknown of [null, {}, []]) {
    const i = input()
    i.current.runtimeIdentities = unknown
    i.current.limitParameters = unknown
    i.episodes[0].observations.forEach((p) => {
      p.runtimeIdentities = unknown
      p.limitParameters = unknown
    })
    const value = build(i)!
    expect(value).not.toBeNull()
    expect(value.scenarios[0].regime.observedRuntimeIdentitiesMatch).toBe(false)
    expect(value.scenarios[0].regime.observedParametersMatch).toBe(false)
  }
})
it('complete nonempty observed runtime and parameters can match independently of unknown implementation equivalence', () => {
  const i = input(),
    runtime = [{ address: identity.destination, codeHash: '0x' + 'c'.repeat(64) }]
  i.current.runtimeIdentities = runtime
  i.episodes[0].observations.forEach((p) => {
    p.runtimeIdentities = runtime
  })
  const value = build(i)!
  expect(value.scenarios[0].regime.observedRuntimeIdentitiesMatch).toBe(true)
  expect(value.scenarios[0].regime.observedParametersMatch).toBe(true)
  expect(value.scenarios[0].regime.sourceEquivalence).toBe('unverified')
})
it('translated prongs retain uint256 maximum and reject the next unit for each C/S/W view', () => {
  const max = ((1n << 256n) - 1n).toString()
  for (const key of [
    'sharedCashRaw',
    'fTokenSupplyRaw',
    'resolverSupplyRaw',
    'minimumRemainingSupplyRaw',
  ] as const) {
    const i = input([episode('a', [100, 100])])
    i.current.prongs[key] = max
    i.episodes[0].observations[0].prongs[key] = '0'
    i.episodes[0].observations[1].prongs[key] = '0'
    expect(build(i)).not.toBeNull()
    i.episodes[0].observations[1].prongs[key] = '1'
    expect(build(i)).toBeNull()
  }
})
