import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import summary from '@/data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json'
import { DIRECT_SUPPLY_MARKETS as markets } from '@/lib/carry/directSupplyMarketConstants'
import { buildHistoricalCompetingFlowEstimate } from '@/lib/carry/historicalCompetingFlowEstimate'
import { buildConditionalGrossFlowHeadroom } from '@/lib/carry/conditionalGrossFlowHeadroom'
import { localHistoricalSampledCashTimeline } from '@/lib/carry/localHistoricalSampledCashTimeline'
import {
  buildConditionalSampledCashPathProjection,
  conditionalSampledCashHistoryFromVerifiedTimeline,
} from '@/lib/carry/conditionalSampledCashPathProjection'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
} from '@/lib/carry/holderExitCapacity'
import {
  buildAaveSparkCapacityProjection,
  selectedAaveSparkCapacityProjection,
  type AaveSparkCapacityInput,
} from '@/lib/carry/aaveSparkCapacityProjection'
const hash = (s: string) => createHash('sha256').update(s).digest('hex'),
  now = Date.parse('2026-10-08T12:00:00.000Z')
function input(market = markets.aaveV3Usdc, daily = false): AaveSparkCapacityInput {
  const source = {
    chainId: 1 as const,
    routeKey: market.routeKey,
    destination: market.destination.toLowerCase(),
    asset: market.underlying.toLowerCase(),
    assetDecimals: market.decimals,
    cashRaw: '10000000000000',
    blockNumber: 26190000,
    blockHash: '0x' + 'a'.repeat(64),
    blockTime: new Date(now - 60000).toISOString(),
    readAt: new Date(now).toISOString(),
    finalized: true as const,
    sourceKind: 'live_read_only_two_origin_finalized' as const,
  }
  let value: unknown
  if (daily) {
    const root =
      market === markets.aaveV3Usde
        ? 'data/research/venue-signals/local-carry-supplemental-aave-usde-cash-v1'
        : 'data/research/venue-signals/local-carry-cash-v1'
    const observations = readdirSync(root)
      .filter((n) => /^\d{12}\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(root + '/' + n, 'utf8')))
      .map((r) => ({
        collectionMode: r.collectionMode,
        anchorAt: r.anchorAt,
        firstLocalReceiptAt: r.firstLocalReceiptAt,
        receiptSha256: r.sha256,
        manifestSha256: r.manifestSha256,
        source: { block: r.block, blockAt: r.blockAt, blockHash: r.blockHash },
        subjects: r.rows,
      }))
    const t = localHistoricalSampledCashTimeline(observations, {
      route_key: source.routeKey,
      destination: source.destination,
      asset: source.asset,
    })
    if (t.status !== 'sampled_timeline') throw Error(t.reason)
    const history = conditionalSampledCashHistoryFromVerifiedTimeline(observations, t)
    value = buildConditionalSampledCashPathProjection(
      {
        history,
        currentSource: {
          chainId: 1,
          routeKey: source.routeKey,
          destination: source.destination,
          asset: source.asset,
          assetDecimals: source.assetDecimals,
          cashRaw: source.cashRaw,
          blockHash: source.blockHash,
          sourceKind: source.sourceKind,
          block: String(source.blockNumber),
          blockTime: source.blockTime,
          readAt: source.readAt,
        },
        request: { requestedRaw: '100', asOf: new Date(now).toISOString() },
      },
      hash,
    )
  } else {
    const { sourceKind: _k, ...currentSource } = source
    value = buildConditionalGrossFlowHeadroom(
      {
        currentSource,
        request: { requestedRaw: '100', asOf: new Date(now).toISOString() },
        historicalFlow: buildHistoricalCompetingFlowEstimate(summary, hash),
      },
      hash,
    )
  }
  return {
    currentSource: source,
    requestedRaw: '100',
    horizonHours: 24,
    asOfMs: now,
    reserveAgreement: null,
    pathEvidence: { kind: daily ? 'sampled_daily_paths' : 'aave_joint_windows', value },
  }
}
function holder(i: AaveSparkCapacityInput) {
  const owner = '0x' + 'b'.repeat(40),
    s = i.currentSource,
    source = {
      chainId: 1 as const,
      blockNumber: s.blockNumber,
      blockHash: s.blockHash,
      blockTime: s.blockTime,
      finalized: true as const,
    }
  const quote = buildHolderExitCapacityQuote(
    {
      status: 'assessed',
      routeKey: s.routeKey,
      destinationAddress: s.destination,
      owner,
      request: { assetsRaw: i.requestedRaw, assetAddress: s.asset, horizonHours: i.horizonHours },
      source: { ...source, originValidation: 'two_provider' },
      stages: [
        {
          name: 'withdrawal',
          assetAddress: s.asset,
          amountRaw: i.requestedRaw,
          relatedToRequest: true,
          status: 'evm_revert',
        },
      ],
      finalPayout: { status: 'unassessed', assetAddress: s.asset, amountRaw: null },
    } as any,
    {
      entitlementRaw: '150',
      quotedMaxWithdrawRaw: null,
      quotedMaxWithdrawStatus: 'not_read',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    now,
  )!
  expect(quote).not.toBeNull()
  return {
    capacityAgreement: agreeHolderExitCapacityQuotes(
      { host: 'one.example', quote },
      { host: 'two.example', quote },
      now,
    ),
    binding: {
      routeKey: s.routeKey,
      destination: s.destination,
      owner,
      requestedRaw: i.requestedRaw,
      asset: s.asset,
      assetDecimals: s.assetDecimals,
      currentSource: source,
      asOfMs: now,
    },
  }
}
describe('Aave/Spark native conditional reserve path adapter', () => {
  it('retains all78 individual joint paths, real time brackets and Q once', () => {
    const i = input(),
      before = structuredClone(i),
      p = buildAaveSparkCapacityProjection(i, hash)!
    expect(p).not.toBeNull()
    expect(p.scenarios).toHaveLength(78)
    const upstream = (i.pathEvidence.value as any).scenarios
    p.scenarios.forEach((s, n) => {
      expect(s.capacityRaw[0]).toBe(upstream[n].capacityRaw)
      expect(s.headroomRaw[0]).toBe((BigInt(s.capacityRaw[0]) - 100n).toString())
    })
    expect(p.horizons[0].target.lowerSeconds).toBe(2532)
    expect(p.horizons[0].target.upperSeconds).toBe(3588)
    expect(p.restrictions).toBe('reserve_restrictions_unmeasured')
    expect(p.forwardProbability).toBe(false)
    expect(p.holderExecutableExit).toBe(false)
    expect(i).toEqual(before)
    expect(selectedAaveSparkCapacityProjection(p, i, hash)).toEqual(p)
  })
  for (const [market, name] of [
    [markets.sparkLendUsdt, 'SparkUSDT6'],
    [markets.aaveV3Usde, 'supplementalAaveUSDe18'],
  ] as const)
    it(`${name} uses its own pinned whole daily paths`, () => {
      const i = input(market as any, true),
        p = buildAaveSparkCapacityProjection(i, hash)!
      expect(p).not.toBeNull()
      expect(p.scenarios).toHaveLength(17)
      expect(p.horizons).toHaveLength(7)
      expect(p.input.currentSource.assetDecimals).toBe(market.decimals)
      expect(p.scenarios[0].capacityRaw).toEqual(
        (i.pathEvidence.value as any).scenarios[0].capacityRaw.slice(1),
      )
      expect(selectedAaveSparkCapacityProjection(p, i, hash)).toEqual(p)
    })
  it('reverted current Q still permits independently quotedE clipping per individual scenario', () => {
    const i = input()
    i.holder = holder(i)
    const p = buildAaveSparkCapacityProjection(i, hash)!
    expect(p.scope).toBe('entitlement_clipped_conditional_scenario')
    for (const path of p.scenarios) {
      expect(BigInt(path.capacityRaw[0]) <= 150n).toBe(true)
      expect(path.headroomRaw[0]).toBe((BigInt(path.capacityRaw[0]) - 100n).toString())
    }
    expect(p.horizons[0].requestedHeadroom.maximumRaw).toBe('50')
    const bad = structuredClone(i)
    bad.holder!.binding.owner = '0x' + 'c'.repeat(40)
    expect(buildAaveSparkCapacityProjection(bad, hash)).toBeNull()
  })
  it('rejects owner/Q/source/native-unit and unauthenticatedpath changes', () => {
    const i = input(),
      p = buildAaveSparkCapacityProjection(i, hash)!
    for (const mutate of [
      (b: any) => (b.currentSource.assetDecimals = 18),
      (b: any) => (b.currentSource.blockHash = '0x' + 'c'.repeat(64)),
      (b: any) => (b.requestedRaw = ['100']),
      (b: any) => (b.currentSource.readAt = [b.currentSource.readAt]),
      (b: any) => (b.pathEvidence.value.scenarios[0].capacityRaw = '1'),
    ]) {
      const b = structuredClone(i)
      mutate(b)
      expect(buildAaveSparkCapacityProjection(b, hash)).toBeNull()
    }
    const b = structuredClone(p)
    b.forwardProbability = true as any
    expect(selectedAaveSparkCapacityProjection(b, i, hash)).toBeNull()
  })
  it('keeps selectedH independent of actual donor window and rejects expired proof', () => {
    const i = input()
    i.horizonHours = 1
    expect(buildAaveSparkCapacityProjection(i, hash)!.horizons[0].target.lowerSeconds).toBe(2532)
    i.asOfMs = Date.parse(i.currentSource.blockTime) + 1800001
    expect(buildAaveSparkCapacityProjection(i, hash)).toBeNull()
  })
  it('reserve disagreement or unsupportedrestriction interpretation cannot selfdeclareauthority', () => {
    const i = input(),
      s = i.currentSource,
      f = {
        status: 'reserve_getter_observed' as const,
        pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
        aToken: s.destination,
        asset: s.asset,
        assetDecimals: s.assetDecimals,
        source: {
          chainId: 1 as const,
          blockNumber: s.blockNumber,
          blockHash: s.blockHash,
          blockTime: s.blockTime,
          finalized: true as const,
        },
        configurationRaw: '1',
        liquidityIndexRaw: null,
        variableBorrowIndexRaw: null,
        reserveLastUpdateTimestampRaw: null,
        unbackedRaw: null,
        restrictionInterpretation: 'unverified' as const,
        active: null,
        withdrawalsPaused: null,
      }
    i.reserveAgreement = {
      origins: [
        { host: 'one.example', facts: f },
        { host: 'two.example', facts: structuredClone(f) },
      ],
    }
    expect(buildAaveSparkCapacityProjection(i, hash)).not.toBeNull()
    i.reserveAgreement.origins[1].facts.configurationRaw = '2'
    expect(buildAaveSparkCapacityProjection(i, hash)).toBeNull()
  })
})
