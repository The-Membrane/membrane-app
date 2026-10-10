import { describe, expect, it } from 'vitest'

import { resolveHolderExitSubject } from '@/lib/carry/holderExitAssessment'
import { localHistoricalCashPairs } from '@/lib/carry/localHistoricalCashScenario'
import { buildExitImpactForecast } from '@/lib/forecast/exitImpactForecast'
import { readLocalCarryCashObservations } from '@/scripts/lib/localCarryCashStore.mjs'
import { buildSubjectManifest } from '@/scripts/record-carry-cash-issues.mjs'

type AbstentionReason =
  | 'asset_identity_mismatch'
  | 'insufficient_long_history'
  | 'subject_unassessed'

type Abstention = {
  routeKey: string
  destination: string
  reason: AbstentionReason
}

const EXPECTED_ABSTENTIONS: Abstention[] = [
  {
    routeKey: 'AUSD → Staked USDat [USDat]',
    destination: '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
    reason: 'asset_identity_mismatch',
  },
  {
    routeKey: 'PYUSD → StakingVault [wYLDS]',
    destination: '0x19ebb35279a16207ec4ba82799cc64715065f7f6',
    reason: 'asset_identity_mismatch',
  },
  {
    routeKey: 'USDC → VaultV2 [USDC]',
    destination: '0xabe418cc8c06d265e4eb009c02ea4b265eca7240',
    reason: 'insufficient_long_history',
  },
  {
    routeKey: 'USDC → VaultV2 [USDC]',
    destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
    reason: 'insufficient_long_history',
  },
  {
    routeKey: 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
    destination: '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    reason: 'subject_unassessed',
  },
  {
    routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
    destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    reason: 'asset_identity_mismatch',
  },
]

const EXPECTED_WHOLE_GROUP_ABSTENTIONS = [
  'AUSD → Staked USDat [USDat]',
  'PYUSD → StakingVault [wYLDS]',
  'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
  'USDT → FluidBridgeAggregatorProxy [USDC]',
].sort()

const byIdentity = (left: Abstention, right: Abstention) =>
  left.routeKey.localeCompare(right.routeKey) || left.destination.localeCompare(right.destination)

describe('frozen exact payout-Q historical coverage', () => {
  it('builds H24 backtests for 61/67 subjects across 21/25 route groups', async () => {
    const manifest = await buildSubjectManifest()
    const observations = readLocalCarryCashObservations(manifest)
    const allGroups = new Set(manifest.subjects.map((subject) => subject.route_key))
    const coveredGroups = new Set<string>()
    const abstentions: Abstention[] = []
    let coveredSubjects = 0

    expect(manifest.subjects).toHaveLength(67)
    expect(allGroups.size).toBe(25)

    for (const subject of manifest.subjects) {
      const historical = localHistoricalCashPairs(observations, subject)
      if (historical.status === 'unavailable') {
        expect([
          'insufficient_long_history',
          'subject_unassessed',
        ] satisfies AbstentionReason[]).toContain(historical.reason)
        abstentions.push({
          routeKey: subject.route_key,
          destination: subject.destination,
          reason: historical.reason as Extract<
            AbstentionReason,
            'insufficient_long_history' | 'subject_unassessed'
          >,
        })
        continue
      }

      const payoutAsset = resolveHolderExitSubject(
        subject.route_key,
        subject.destination,
      ).payoutAsset.toLowerCase()
      if (
        payoutAsset !== subject.asset.toLowerCase() ||
        payoutAsset !== historical.asset.toLowerCase()
      ) {
        abstentions.push({
          routeKey: subject.route_key,
          destination: subject.destination,
          reason: 'asset_identity_mismatch',
        })
        continue
      }

      const requestedRaw = (10n ** BigInt(historical.assetDecimals)).toString()
      const result = buildExitImpactForecast({
        kind: 'retrospective_backtest',
        identity: {
          routeKey: subject.route_key,
          destination: subject.destination,
          asset: payoutAsset,
          assetDecimals: historical.assetDecimals,
        },
        requestedRaw,
        horizonHours: 24,
        pairs: historical.pairs,
        dailyTimeline: historical.dailyTimeline,
      })

      expect(result).toMatchObject({
        status: 'historical_backtest',
        analysisKind: 'retrospective_backtest',
        identity: {
          routeKey: subject.route_key,
          destination: subject.destination,
          asset: payoutAsset,
        },
        question: { requestedRaw, horizonHours: 24 },
        absoluteQBacktest: {
          status: 'historical_backtest',
          counts: { total: 60, fit: 20, calibration: 20, holdout: 20 },
        },
      })
      coveredSubjects += 1
      coveredGroups.add(subject.route_key)
    }

    expect(coveredSubjects).toBe(61)
    expect(coveredGroups.size).toBe(21)
    expect(abstentions.sort(byIdentity)).toEqual([...EXPECTED_ABSTENTIONS].sort(byIdentity))

    const reasons = abstentions.reduce<Record<AbstentionReason, number>>(
      (counts, row) => ({ ...counts, [row.reason]: counts[row.reason] + 1 }),
      {
        asset_identity_mismatch: 0,
        insufficient_long_history: 0,
        subject_unassessed: 0,
      },
    )
    expect(reasons).toEqual({
      asset_identity_mismatch: 3,
      insufficient_long_history: 2,
      subject_unassessed: 1,
    })
    expect([...allGroups].filter((routeKey) => !coveredGroups.has(routeKey)).sort()).toEqual(
      EXPECTED_WHOLE_GROUP_ABSTENTIONS,
    )
  })

  it('preserves the frozen Aave 50%-Q right-censored 85-day sampled tail', async () => {
    const manifest = await buildSubjectManifest()
    const observations = readLocalCarryCashObservations(manifest)
    const subject = manifest.subjects.find(
      (entry) =>
        entry.route_key === 'USDC → supply on Aave V3' &&
        entry.destination === '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    )
    expect(subject).toBeDefined()
    const historical = localHistoricalCashPairs(observations, subject!)
    expect(historical.status).toBe('historical_pairs')
    if (historical.status !== 'historical_pairs') return

    const requestedRaw = '77321184768230'
    const result = buildExitImpactForecast({
      kind: 'retrospective_backtest',
      identity: {
        routeKey: subject!.route_key,
        destination: subject!.destination,
        asset: subject!.asset,
        assetDecimals: historical.assetDecimals,
      },
      requestedRaw,
      horizonHours: 24,
      pairs: historical.pairs,
      dailyTimeline: historical.dailyTimeline,
    })

    expect(result).toMatchObject({
      status: 'historical_backtest',
      duration: {
        status: 'historical_interval_outlook',
        observations: 120,
        observedBelowQSamples: 105,
        timelineSegments: 1,
        verifiedTimelineCoverageSeconds: 10_281_600,
        sampledRuns: 6,
        completedSampledRuns: 4,
        leftCensoredRuns: 1,
        rightCensoredRuns: 1,
        bothBoundaryCensoredRuns: 0,
        completedSampledRunDurationSeconds: {
          longest: { low: 691_200, high: 864_000 },
        },
        censoredRunObservedSpanLowerBoundSeconds: {
          rightLongest: 7_344_000,
        },
      },
    })
  })
})
