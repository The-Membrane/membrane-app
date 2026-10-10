import { describe, expect, it } from 'vitest'
import {
  localHistoricalSampledCashTimeline,
  sampledReadOnlyCurrentCash,
} from '@/lib/carry/localHistoricalSampledCashTimeline'
import { replaySampledHistoricalCashPaths } from '@/lib/carry/historicalSampledCashPaths'
import { localHistoricalCashPairs } from '@/lib/carry/localHistoricalCashScenario'

const subject = {
  route_key: 'USDC → VaultV2 [USDC]',
  destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
}
const now = Date.parse('2026-10-07T12:00:00.000Z')
const first = Date.parse('2026-06-06T00:00:00.000Z')
const day = 86400000
function fixture(prefix = 11) {
  const observations = Array.from({ length: 120 }, (_, i) => ({
    collectionMode: 'retrospective' as const,
    anchorAt: new Date(first + i * day).toISOString(),
    firstLocalReceiptAt: new Date(now).toISOString(),
    source: {
      blockAt: new Date(first + i * day - 1000).toISOString(),
      block: String(i + 1),
      blockHash: `0x${'a'.repeat(64)}`,
    },
    subjects: [
      {
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: i < prefix ? null : subject.asset,
        assetDecimals: i < prefix ? null : 6,
        cashRaw: i < prefix ? null : String(1000000 + i * 10000),
        state: i < prefix ? 'no_code' : 'observed',
        reason: i < prefix ? 'destination_not_deployed' : null,
      },
    ],
  }))
  return [
    ...observations,
    {
      collectionMode: 'current' as const,
      anchorAt: new Date(now).toISOString(),
      firstLocalReceiptAt: new Date(now).toISOString(),
      source: {
        blockAt: new Date(now - 1000).toISOString(),
        block: '1000',
        blockHash: `0x${'b'.repeat(64)}`,
      },
      subjects: [
        {
          routeKey: subject.route_key,
          destination: subject.destination,
          asset: subject.asset,
          assetDecimals: 6,
          cashRaw: '100000000',
          state: 'observed',
        },
      ],
    },
  ]
}
function replay(observations = fixture(), clock = now) {
  const history = localHistoricalSampledCashTimeline(observations, subject)
  expect(history.status).toBe('sampled_timeline')
  if (history.status !== 'sampled_timeline' || !history.current)
    throw new Error('fixture unavailable')
  return {
    history,
    result: replaySampledHistoricalCashPaths({
      identity: history.identity,
      requestedRaw: '1000000',
      current: history.current,
      timelineIdentity: { subjectKey: history.subjectKey, asset: subject.asset, assetDecimals: 6 },
      timeline: history.timeline,
      asOfMs: clock,
    }),
  }
}
describe('verified post-deployment sampled cash input', () => {
  it('retains 109 observed anchors and 11 leading predeployment censored anchors without the fitted pair gate', () => {
    const { history, result } = replay()
    expect(history.coverage).toMatchObject({
      gridAnchorCount: 120,
      observedAnchorCount: 109,
      leadingPredeploymentAnchorCount: 11,
      interiorUnavailableAnchorCount: 0,
    })
    expect(history.timeline[0]).toMatchObject({
      cashRaw: '1110000',
      at: '2026-06-16T23:59:59.000Z',
    })
    expect(result).toMatchObject({
      status: 'conditional_historical_sampled_cash_paths',
      counts: { samples: 109, candidateEpisodes: 15, eligibleEpisodes: 15, gaps: 0 },
      prospectiveValidated: false,
      holderExecutableExit: false,
      forwardProbability: false,
    })
    expect(localHistoricalCashPairs(fixture(), subject, now).status).toBe('unavailable')
  })
  it('keeps the first observed cash distinct from missing deployment history and censors boundary shortfalls', () => {
    const observations = fixture()
    observations.at(-1)!.subjects[0].cashRaw = '0'
    const { history, result } = replay(observations)
    expect(history.timeline[0].cashRaw).toBe('1110000')
    if (result.status !== 'conditional_historical_sampled_cash_paths')
      throw new Error('fixture unavailable')
    expect(result.examples.worstTrough).toMatchObject({
      originAt: history.timeline[0].at,
      originCashRaw: '1110000',
      sampledBelowQ: {
        leftCensored: true,
        rightCensored: true,
        onsetBracket: null,
        recoveryBracket: null,
      },
    })
    const unknown = fixture()
    unknown[0].subjects[0].reason = 'unknown_no_code_reason'
    expect(localHistoricalSampledCashTimeline(unknown, subject).status).toBe('unavailable')
  })

  it('preserves the full 120-point descriptive timeline for existing complete subjects', () => {
    expect(replay(fixture(0)).result).toMatchObject({
      counts: { samples: 120, eligibleEpisodes: 17, gaps: 0 },
    })
  })
  it('retains interior missing dates as gaps and rejects every span crossing them', () => {
    const observations = fixture()
    observations[45].subjects[0] = {
      ...observations[45].subjects[0],
      state: 'unassessed',
      cashRaw: null,
      asset: null,
      assetDecimals: null,
    }
    const { history, result } = replay(observations)
    expect(history.coverage.interiorUnavailableAnchorCount).toBe(1)
    expect(result.status).toBe('conditional_historical_sampled_cash_paths')
    if (result.status !== 'conditional_historical_sampled_cash_paths')
      throw new Error('fixture unavailable')
    expect(result.counts.gaps).toBe(1)
    expect(result.counts.gapRejectedEpisodes).toBeGreaterThan(0)
    const missingAt = Date.parse(observations[45].source.blockAt)
    for (const example of Object.values(result.examples)) {
      expect(Date.parse(example.endpointAt) - Date.parse(example.originAt)).toBe(7 * day)
      expect(
        Date.parse(example.originAt) < missingAt && Date.parse(example.endpointAt) > missingAt,
      ).toBe(false)
    }
  })
  it.each([
    'foreign_asset',
    'foreign_units',
    'malformed_cash',
    'duplicate_subject',
    'duplicate_anchor',
    'missing_anchor',
    'bad_hash',
  ])('rejects %s instead of weakening identity or cadence', (change) => {
    const observations = fixture()
    if (change === 'foreign_asset') observations[45].subjects[0].asset = `0x${'c'.repeat(40)}`
    if (change === 'foreign_units') observations[45].subjects[0].assetDecimals = 18
    if (change === 'malformed_cash') observations[45].subjects[0].cashRaw = 'bad'
    if (change === 'duplicate_subject')
      observations[45].subjects.push({ ...observations[45].subjects[0] })
    if (change === 'duplicate_anchor') observations[45].anchorAt = observations[44].anchorAt
    if (change === 'missing_anchor') observations.splice(45, 1)
    if (change === 'bad_hash') observations[45].source.blockHash = 'bad'
    expect(localHistoricalSampledCashTimeline(observations, subject).status).toBe('unavailable')
  })
  it('binds live block height and timestamp to the archived header without retiming stale cash', () => {
    const { history } = replay()
    const original = JSON.stringify(history)
    const archived = { ...history.current!, blockAt: '2026-10-07T09:00:00.000Z' }
    const staleHistory = { ...history, current: archived }
    const live = {
      status: 'available' as const,
      sourceKind: 'live_read_only_two_origin_finalized' as const,
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: 6,
      cashRaw: archived.cashRaw,
      block: archived.block,
      blockHash: archived.blockHash,
      blockAt: '2026-10-07T11:59:59.000Z',
      readAtUtc: new Date(now).toISOString(),
    }
    for (const changed of [
      { block: '999' }, // Lower height cannot refresh an older archived header.
      {}, // Same height/hash/cash cannot be retimestamped.
      { block: ['1001'] },
      { block: { toString: () => '1001' } },
      { block: 1001 },
      { block: String(1n << 256n) },
    ])
      expect(sampledReadOnlyCurrentCash(staleHistory, { ...live, ...changed } as never, now)).toBe(
        archived,
      )
    const unchanged = { ...live, blockAt: history.current!.blockAt }
    const sameHeader = sampledReadOnlyCurrentCash(history, unchanged, now)
    expect(sameHeader).not.toBe(history.current)
    expect(sameHeader).toMatchObject({
      block: '1000',
      blockAt: unchanged.blockAt,
    })
    for (const changed of [{ cashRaw: '1' }, { blockHash: `0x${'d'.repeat(64)}` }])
      expect(sampledReadOnlyCurrentCash(history, { ...unchanged, ...changed }, now)).toBe(
        history.current,
      )
    const newer = { ...live, block: '1001', cashRaw: '120000000', blockHash: `0x${'c'.repeat(64)}` }
    const selected = sampledReadOnlyCurrentCash(staleHistory, newer, now)
    expect(selected).toMatchObject({ block: '1001', blockAt: newer.blockAt })
    expect(selected).not.toBe(newer)
    for (const blockAt of [archived.blockAt, '2026-10-07T08:59:59.000Z'])
      expect(sampledReadOnlyCurrentCash(staleHistory, { ...newer, blockAt }, now)).toBe(archived)
    newer.cashRaw = '1'
    expect(selected!.cashRaw).toBe('120000000')
    expect(JSON.stringify(history)).toBe(original)
  })
  it('keeps history when C2 ages out and rejects foreign or noncorroborated live overlays', () => {
    const { history, result } = replay(fixture(), now + 2 * 3600000 + 1)
    expect(result).toMatchObject({ status: 'unavailable', reason: 'current_cash_stale_or_future' })
    expect(history.timeline).toHaveLength(109)
    expect(
      sampledReadOnlyCurrentCash(
        {
          ...history,
          current: { ...history.current!, firstLocalReceiptAt: new Date(now + 1).toISOString() },
        },
        undefined,
        now,
      ),
    ).toBeNull()
    const live = {
      status: 'available' as const,
      sourceKind: 'live_read_only_two_origin_finalized' as const,
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: 6,
      cashRaw: '120000000',
      block: '1001',
      blockHash: `0x${'c'.repeat(64)}`,
      blockAt: new Date(now).toISOString(),
      readAtUtc: new Date(now).toISOString(),
    }
    expect(sampledReadOnlyCurrentCash(history, live, now)).toMatchObject({
      cashRaw: '120000000',
      sourceKind: live.sourceKind,
    })
    for (const changed of [
      { asset: `0x${'d'.repeat(40)}` },
      { assetDecimals: 18 },
      { sourceKind: 'single_provider' },
      { readAtUtc: new Date(now + 1).toISOString() },
      { block: '1000' },
    ])
      expect(sampledReadOnlyCurrentCash(history, { ...live, ...changed } as never, now)).toBe(
        history.current,
      )
  })
})
