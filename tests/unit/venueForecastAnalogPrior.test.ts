import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildVenueForecastAnalogPrior,
  selectedVenueForecastAnalogPrior,
  type AnalogCashProfile,
  type AnalogPriorQualifiers,
  type VenueForecastAnalogPriorInput,
} from '@/lib/carry/venueForecastAnalogPrior'
import type { ConditionalSampledCashHistory } from '@/lib/carry/conditionalSampledCashPathProjection'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const audit = JSON.parse(
  readFileSync(
    'data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json',
    'utf8',
  ),
)
const histories = Object.values(audit.histories) as ConditionalSampledCashHistory[]
const reserve = histories.find((h) => h.identity.routeKey === 'USDC → supply on Aave V3')!
const idle = histories.find((h) => h.identity.routeKey === 'AUSD → VaultV2 [AUSD]')!
const link = histories.find((h) => h.identity.routeKey === 'LINK → VaultV2 [LINK]')!
const now = Date.parse('2026-10-08T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
function input(h = reserve, cashRaw = '1000000'): VenueForecastAnalogPriorInput {
  const allocated = h.identity.routeKey.includes('VaultV2')
  const profile: AnalogCashProfile = {
    identity: structuredClone(h.identity),
    mechanismFamily: allocated ? 'allocated_vault' : 'reserve_lending',
    cashMeaning: allocated ? 'unallocated_vault_cash' : 'underlying_reserve',
    assetRiskClass: h === link ? 'volatile' : 'stable',
    mechanismVersion: 'test-externally-reviewed-donor-version',
    reviewedProfileRef: 'test-independent-profile-fixture',
  }
  const currentIdentity = {
    routeKey: 'externally-reviewed-new-market',
    destination: `0x${'1'.repeat(40)}`,
    asset: `0x${'2'.repeat(40)}`,
    assetDecimals: 18,
  }
  const source = {
    ...h.identity,
    chainId: 1 as const,
    cashRaw: '1000',
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: iso(now - 1000),
    readAt: iso(now),
    sourceKind: 'live_read_only_two_origin_finalized' as const,
  }
  return {
    currentProfile: {
      ...profile,
      identity: currentIdentity,
      mechanismVersion: 'test-externally-reviewed-current-version',
    },
    currentSource: { ...source, ...currentIdentity, cashRaw },
    requestedRaw: '900000',
    issueAtUtc: iso(now),
    horizonHours: 1,
    maxHistoricalGapSeconds: 91800,
    donors: [
      {
        profile,
        history: structuredClone(h),
        verificationSource: source,
        verificationAtUtc: iso(now),
        nativeUnitMap: {
          donorAsset: h.identity.asset,
          donorDecimals: h.identity.assetDecimals,
          currentAsset: currentIdentity.asset,
          currentDecimals: currentIdentity.assetDecimals,
          normalization: 'dimensionless_net_delta_over_donor_cash_before',
        },
      },
    ],
  }
}
function qualifiers(i: VenueForecastAnalogPriorInput): AnalogPriorQualifiers {
  // Tests model an independently approved external pair/profile, not a production seal.
  const approved = structuredClone(i)
  return {
    current: (candidate) => JSON.stringify(candidate) === JSON.stringify(approved),
    donor: (candidate) =>
      approved.donors.some((d) => JSON.stringify(d) === JSON.stringify(candidate)),
  }
}
function build(i = input()) {
  return buildVenueForecastAnalogPrior(i, hash, qualifiers(i))
}
function result(i = input()) {
  const r = build(i)
  if (!r) throw Error('no_prior')
  return r
}
const floored = (n: bigint, d: bigint) => n / d - (n < 0n && n % d ? 1n : 0n)

describe('cash-only native peer pressure analogy', () => {
  it('reconstructs real reserve donor endpoints and exact current-native scaling including source age', () => {
    const i = input(),
      r = result(i)
    expect(r.scenarios.length).toBeLessThanOrEqual(64)
    expect(r.proofs[0].compactHistorySha256).toBe(hash(JSON.stringify(reserve)))
    expect(r.sourceAgeSecondsAtIssue).toBe(1)
    for (const scenario of r.scenarios) {
      const [a, b] = scenario.originalEndpoints
      expect(a).toEqual(reserve.points[scenario.donorFromObservation])
      expect(b).toEqual(reserve.points[scenario.donorFromObservation + 1])
      const delta = BigInt(b[4]) - BigInt(a[4]),
        durationMs = Date.parse(b[3]) - Date.parse(a[3])
      for (const point of scenario.process.scenarios[0].points) {
        const dt = BigInt(Date.parse(point.atUtc) - Date.parse(i.currentSource.blockTime))
        const translated =
          BigInt(i.currentSource.cashRaw) +
          floored(delta * BigInt(i.currentSource.cashRaw) * dt, BigInt(a[4]) * BigInt(durationMs))
        expect(point.availableRaw).toBe(String(translated < 0n ? 0n : translated))
        expect(point.headroomRaw).toBe(String(BigInt(point.availableRaw) - BigInt(i.requestedRaw)))
        expect(point.entitlementRaw).toBeNull()
      }
    }
    expect(r.assumptions).toMatchObject({
      netFlowAlreadyIncludesCompetition: true,
      grossFlowSubtractedAgain: false,
      noDollarOrTokenPriceConversion: true,
    })
    expect(r.unknownOtherProngs).toContain('initial_deposit_effect')
    expect(r.holderExecutableExit).toBe(false)
  })
  it('abstains at zero current cash even when verified donor intervals show positive replenishment', () => {
    const positiveBase = input(),
      control = result(positiveBase)
    const inflow = control.scenarios.find(
      (s) => BigInt(s.normalizedNetRate.numeratorNativeDelta) > 0n,
    )!
    expect(inflow).toBeDefined()
    expect(BigInt(inflow.process.scenarios[0].points.at(-1)!.availableRaw)).toBeGreaterThan(
      BigInt(positiveBase.currentSource.cashRaw),
    )
    const zeroBase = structuredClone(positiveBase)
    zeroBase.currentSource.cashRaw = '0'
    // History, units, mechanism and source clocks remain valid; only the normalization base is zero.
    expect(build(zeroBase)).toBeNull()
    expect(
      selectedVenueForecastAnalogPrior(
        control,
        { input: zeroBase, asOfMs: now },
        hash,
        qualifiers(zeroBase),
      ),
    ).toBeNull()
  })
  it('floors tiny negative native shifts before max(0) and reports sampled censored restrictions', () => {
    const i = input(reserve, '1')
    i.requestedRaw = '1'
    const r = result(i),
      negative = r.scenarios.find((s) => BigInt(s.normalizedNetRate.numeratorNativeDelta) < 0n)!
    const path = negative.process.scenarios[0]
    expect(path.points[0].availableRaw).toBe('1')
    expect(path.points.at(-1)!.availableRaw).toBe('0')
    expect(path.sampledShortfalls[0]).toMatchObject({
      leftCensored: false,
      rightCensored: true,
      recovery: null,
    })
    expect(negative.process.horizonFinerThanHistory).toBe(true)
    expect(negative.process.continuousPathKnown).toBe(false)
  })
  it('preserves both true normalized historical net-rate extremes while bounding the grid', () => {
    const r = result(),
      valid = reserve.points
        .slice(0, -1)
        .map((a, j) => {
          const b = reserve.points[j + 1]
          return {
            a,
            b,
            delta: BigInt(b[4]) - BigInt(a[4]),
            den: BigInt(a[4]) * BigInt(Date.parse(b[3]) - Date.parse(a[3])),
          }
        })
        .filter((x) => x.a[4] !== '0')
        .sort((a, b) =>
          a.delta * b.den < b.delta * a.den ? -1 : a.delta * b.den > b.delta * a.den ? 1 : 0,
        )
    expect(r.scenarios[0].originalEndpoints).toEqual([valid[0].a, valid[0].b])
    expect(r.scenarios.at(-1)!.originalEndpoints).toEqual([valid.at(-1)!.a, valid.at(-1)!.b])
    expect(r.historicalNormalizedNetRateRange.protocolMaximumGrossOutflow).toBeNull()
    expect(r.scenarios.every((s) => s.process.scenarios[0].points.length <= 128)).toBe(true)
  })
  it('uses real allocated idle but rejects zero-denominator LINK histories without stable-dollar relabeling', () => {
    const r = result(input(idle))
    expect(r.cashOnlyClaim).toContain('not_holder_capacity')
    expect(r.unknownOtherProngs).toContain('allocated_pullability')
    const volatile = input(link)
    expect(volatile.donors[0].profile.assetRiskClass).toBe('volatile')
    expect(build(volatile)).toBeNull()
  })
  it('permits one actual eligible interval as a disclosed thin analogy, excluding zero denominators', () => {
    const thin = histories.find(
      (h) => h.identity.destination === '0xbeeff0deac1aba71ef0d88c4291354eb92ef4589',
    )!
    const r = result(input(thin))
    expect(r.selection.eligibleIntervals).toBe(1)
    expect(r.scenarios).toHaveLength(1)
    expect(r.calibratedProbability).toBe(false)
    expect(r.scenarios[0].originalEndpoints[0][0]).toBe(67)
  })
  it('rejects incompatible cash meanings, mechanism families, risk labels and explicit unit maps', () => {
    const mutations: ((i: VenueForecastAnalogPriorInput) => void)[] = [
      (i) => {
        i.currentProfile.mechanismFamily = 'shared_bank_lending'
        i.currentProfile.cashMeaning = 'shared_bank_cash'
      },
      (i) => {
        i.donors[0].profile.cashMeaning = 'unallocated_vault_cash'
      },
      (i) => {
        i.donors[0].profile.assetRiskClass = 'volatile'
      },
      (i) => {
        i.donors[0].nativeUnitMap.currentDecimals = 6
      },
      (i) => {
        i.donors[0].nativeUnitMap.normalization = 'dollar_conversion' as never
      },
      (i) => {
        i.currentProfile.assetRiskClass = 'unknown' as never
      },
    ]
    for (const mutate of mutations) {
      const i = input()
      mutate(i)
      expect(build(i)).toBeNull()
    }
  })
  it('does not relabel retained Fluid vault underlying balances as shared-bank cash without external qualification', () => {
    const i = input()
    i.donors[0].profile.mechanismFamily = i.currentProfile.mechanismFamily = 'shared_bank_lending'
    i.donors[0].profile.cashMeaning = i.currentProfile.cashMeaning = 'shared_bank_cash'
    const independent: AnalogPriorQualifiers = {
      current: () => true,
      donor: (d) => d.profile.identity.routeKey !== reserve.identity.routeKey,
    }
    expect(buildVenueForecastAnalogPrior(i, hash, independent)).toBeNull()
  })
  it('rejects changed history, hole-only interval eligibility, future cutoffs, invalid money and overflow', () => {
    const mutations: ((i: VenueForecastAnalogPriorInput) => void)[] = [
      (i) => {
        i.donors[0].history.points[0][4] = '0'
      },
      (i) => {
        i.maxHistoricalGapSeconds = 1
      },
      (i) => {
        i.donors[0].history.points[1][0] += 1
      },
      (i) => {
        i.donors[0].verificationAtUtc = iso(now + 1)
      },
      (i) => {
        i.currentSource.blockTime = reserve.points.at(-1)![3]
        i.currentSource.readAt = i.currentSource.blockTime
        i.issueAtUtc = i.currentSource.blockTime
        i.donors[0].verificationAtUtc = i.issueAtUtc
      },
      (i) => {
        i.requestedRaw = '-1'
      },
      (i) => {
        i.currentSource.cashRaw = String(1n << 256n)
      },
      (i) => {
        i.currentSource.cashRaw = String((1n << 256n) - 1n)
      },
    ]
    for (const mutate of mutations) {
      const i = input()
      mutate(i)
      expect(build(i)).toBeNull()
    }
  })
  it('requires both independent qualifiers, freezes callback inputs, and reconstructs against an external unchanged plan', () => {
    const i = input(),
      q = qualifiers(i),
      r = result(i)
    expect(buildVenueForecastAnalogPrior(i, hash, { ...q, current: () => false })).toBeNull()
    expect(buildVenueForecastAnalogPrior(i, hash, { ...q, donor: () => false })).toBeNull()
    const mutated = buildVenueForecastAnalogPrior(i, hash, {
      current: (privateInput) => {
        privateInput.currentSource.cashRaw = '0'
        return true
      },
      donor: (privateDonor) => {
        privateDonor.history.points[0][4] = '0'
        return true
      },
    })
    expect(mutated).toEqual(r)
    expect(selectedVenueForecastAnalogPrior(r, { input: i, asOfMs: now }, hash, q)).toEqual(r)
    expect(
      selectedVenueForecastAnalogPrior(r, { input: i, asOfMs: now + 1800000 }, hash, q),
    ).toBeNull()
    const short = input()
    short.horizonHours = 1 / 3600
    const tiny = result(short)
    expect(
      selectedVenueForecastAnalogPrior(
        tiny,
        { input: short, asOfMs: now + 1000 },
        hash,
        qualifiers(short),
      ),
    ).toBeNull()
    const tampered = structuredClone(r)
    tampered.scenarios[0].process.scenarios[0].points[0].headroomRaw = '7'
    expect(
      selectedVenueForecastAnalogPrior(tampered, { input: i, asOfMs: now }, hash, q),
    ).toBeNull()
    const retimed = input()
    retimed.issueAtUtc = iso(now + 1)
    expect(
      selectedVenueForecastAnalogPrior(
        r,
        { input: retimed, asOfMs: now + 1 },
        hash,
        qualifiers(retimed),
      ),
    ).toBeNull()
  })
})
