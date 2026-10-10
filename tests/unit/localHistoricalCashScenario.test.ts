import { describe, expect, it } from 'vitest'

import {
  localHistoricalCashQHoldout,
  localHistoricalCashPairs,
  localHistoricalCashScenario,
} from '@/lib/carry/localHistoricalCashScenario'
import { buildExitImpactForecast } from '@/lib/forecast/exitImpactForecast'
import { exactForecastAssetsRaw, localCashIssueEvidence } from '@/pages/api/carry/forecast'

const subject = {
  route_key: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
}
const START = Date.parse('2026-06-01T00:00:00.000Z')
const DAY = 86_400_000

function history(delta: bigint = 10n, pairTarget?: (pair: number) => bigint) {
  const rows = Array.from({ length: 120 }, (_, index) => {
    const anchorAt = new Date(START + index * DAY).toISOString()
    return {
      collectionMode: 'retrospective' as const,
      anchorAt,
      firstLocalReceiptAt: '2026-09-30T10:00:00.000Z',
      source: { blockAt: anchorAt, block: String(index), blockHash: `0x${'a'.repeat(64)}` },
      subjects: [
        {
          routeKey: subject.route_key,
          destination: subject.destination,
          asset: subject.asset,
          assetDecimals: 6,
          cashRaw: (index % 2 === 0
            ? 1_000n
            : (pairTarget?.(Math.floor(index / 2)) ?? 1_000n + delta)
          ).toString(),
          state: 'observed',
        },
      ],
    }
  })
  const current = {
    ...rows[0],
    collectionMode: 'current' as const,
    anchorAt: '2026-09-30T09:30:00.000Z',
    source: { ...rows[0].source, blockAt: '2026-09-30T09:30:00.000Z' },
    subjects: [{ ...rows[0].subjects[0], cashRaw: '5000' }],
  }
  return [current, ...rows]
}

describe('local historical conditional cash scenario', () => {
  it('uses 60 disjoint pairs and a separate fresh current cash reading', () => {
    const result = localHistoricalCashScenario(
      history(),
      subject,
      Date.parse('2026-09-30T10:00:00.000Z'),
    )
    expect(result).toMatchObject({
      status: 'historical_conditional_cash_scenario',
      method: 'learned_delta',
      pointRaw: '5010',
      bandLowRaw: '5010',
      bandHighRaw: '5010',
      pairs: 60,
      fit: 20,
      calibration: 20,
      selection: 10,
      selectionCovered: 10,
      holdout: 10,
      holdoutCovered: 10,
      prospectiveValidated: false,
      holderExecutableExit: false,
    })
    if (result.status === 'historical_conditional_cash_scenario') {
      expect(result.targetAt).toBe('2026-10-01T09:30:00.000Z')
      expect('issuedAt' in result).toBe(false)
    }
  })

  it('uses a fresh independent current read while retaining sealed retrospective training', () => {
    const now = Date.parse('2026-09-30T13:00:00.000Z')
    const live = {
      status: 'available' as const,
      sourceKind: 'live_read_only_two_origin_finalized' as const,
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: 6,
      cashRaw: '6000',
      block: '999',
      blockHash: `0x${'b'.repeat(64)}`,
      blockAt: '2026-09-30T12:45:00.000Z',
      readAtUtc: '2026-09-30T12:59:00.000Z',
    }
    expect(localHistoricalCashScenario(history(), subject, now)).toMatchObject({
      status: 'unavailable',
      reason: 'no_fresh_current_cash',
    })
    expect(localHistoricalCashScenario(history(), subject, now, live)).toMatchObject({
      status: 'historical_conditional_cash_scenario',
      currentSourceKind: 'live_read_only_two_origin_finalized',
      currentCashRaw: '6000',
      pointRaw: '6010',
      prospectiveValidated: false,
      holderExecutableExit: false,
    })
    const thresholdHistory = history(0n, (pair) => (pair % 20 < 12 ? 800n : 1_000n))
    expect(localHistoricalCashQHoldout(thresholdHistory, subject, '5400', now, live)).toMatchObject(
      {
        status: 'historical_backtest',
        currentSourceKind: 'live_read_only_two_origin_finalized',
        currentBlockAt: live.blockAt,
        prospectiveValidated: false,
        holderExecutableExit: false,
      },
    )
    expect(
      localHistoricalCashScenario(history(), subject, now, { ...live, assetDecimals: 18 }),
    ).toMatchObject({ status: 'unavailable', reason: 'no_fresh_current_cash' })
  })

  it('uses the qualified persistence band when a learned point does not beat persistence', () => {
    expect(
      localHistoricalCashScenario(history(0n), subject, Date.parse('2026-09-30T10:00:00.000Z')),
    ).toMatchObject({
      status: 'historical_conditional_cash_scenario',
      method: 'persistence_band',
      pointRaw: '5000',
    })
  })

  it('names selection failure when neither model passes the selection stage', () => {
    const divergentSelection = history(10n, (pair) => (pair >= 40 && pair < 50 ? 1_000n : 1_010n))
    expect(
      localHistoricalCashScenario(
        divergentSelection,
        subject,
        Date.parse('2026-09-30T10:00:00.000Z'),
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'model_selection_failed' })
  })

  it('abstains when the selected learned interval fails its untouched holdout', () => {
    const adverseTest = history(10n, (pair) => (pair >= 50 ? 1_000n : 1_010n))
    const scenario = localHistoricalCashScenario(
      adverseTest,
      subject,
      Date.parse('2026-09-30T10:00:00.000Z'),
    )
    expect(scenario).toEqual({ status: 'unavailable', reason: 'untouched_holdout_failed' })
    const forecast = buildExitImpactForecast({
      kind: 'conditional_projection',
      identity: {
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: subject.asset,
        assetDecimals: 6,
      },
      requestedRaw: '5000',
      horizonHours: 24,
      scenario,
    })
    expect(forecast).toMatchObject({
      status: 'unavailable',
      reason: 'source_unavailable',
      sourceReason: 'untouched_holdout_failed',
    })
  })

  it('abstains when a covered learned interval fails untouched point skill', () => {
    const noUntouchedPointSkill = history(10n, (pair) => {
      if (pair === 20 || pair >= 50) return 1_000n
      return 1_010n
    })
    expect(
      localHistoricalCashScenario(
        noUntouchedPointSkill,
        subject,
        Date.parse('2026-09-30T10:00:00.000Z'),
      ),
    ).toEqual({ status: 'unavailable', reason: 'untouched_holdout_failed' })
  })

  it('abstains when persistence passes selection but fails its untouched holdout', () => {
    const persistenceHoldoutFailure = history(10n, (pair) => {
      if (pair === 20 || (pair >= 40 && pair < 50)) return 1_000n
      if (pair >= 50) return 1_020n
      return 1_010n
    })
    expect(
      localHistoricalCashScenario(
        persistenceHoldoutFailure,
        subject,
        Date.parse('2026-09-30T10:00:00.000Z'),
      ),
    ).toEqual({ status: 'unavailable', reason: 'untouched_holdout_failed' })
  })

  it('abstains on a short grid, stale current, and historical identity mismatch', () => {
    const full = history()
    expect(
      localHistoricalCashScenario(
        [full[0], ...full.slice(61)],
        subject,
        Date.parse('2026-09-30T10:00:00.000Z'),
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'insufficient_long_history' })
    expect(
      localHistoricalCashScenario(full, subject, Date.parse('2026-09-30T12:00:01.000Z')),
    ).toMatchObject({ status: 'unavailable', reason: 'no_fresh_current_cash' })
    const broken = history()
    broken[2].subjects[0].asset = `0x${'b'.repeat(40)}`
    expect(
      localHistoricalCashScenario(broken, subject, Date.parse('2026-09-30T10:00:00.000Z')),
    ).toMatchObject({ status: 'unavailable', reason: 'insufficient_long_history' })
  })
})

describe('verified local historical cash pairs', () => {
  it('returns all 60 exact pairs when the current read is stale or absent', () => {
    const stale = localHistoricalCashPairs(
      history(),
      subject,
      Date.parse('2026-10-05T10:00:00.000Z'),
    )
    expect(stale).toMatchObject({
      status: 'historical_pairs',
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: 6,
      horizonHours: 24,
      subjectKey: `${subject.route_key}\0${subject.destination}\0${subject.asset}`,
    })
    if (stale.status === 'historical_pairs') {
      expect(stale.pairs).toHaveLength(60)
      expect(stale.pairs[0]).toMatchObject({ sourceCashRaw: '1000', targetCashRaw: '1010' })
      expect(stale.dailyTimeline).toHaveLength(120)
      expect(stale.dailyTimeline[0]).toEqual({
        subjectKey: stale.subjectKey,
        at: stale.pairs[0].sourceAt,
        cashRaw: stale.pairs[0].sourceCashRaw,
      })
      expect(stale.dailyTimeline[2]).toEqual({
        subjectKey: stale.subjectKey,
        at: stale.pairs[1].sourceAt,
        cashRaw: stale.pairs[1].sourceCashRaw,
      })
      expect(Date.parse(stale.dailyTimeline[2].at) - Date.parse(stale.dailyTimeline[1].at)).toBe(
        DAY,
      )
    }

    const withoutCurrent = localHistoricalCashPairs(
      history().filter((row) => row.collectionMode !== 'current'),
      subject,
      Date.parse('2026-10-05T10:00:00.000Z'),
    )
    expect(withoutCurrent).toMatchObject({ status: 'historical_pairs', assetDecimals: 6 })
    if (withoutCurrent.status === 'historical_pairs') expect(withoutCurrent.pairs).toHaveLength(60)
  })

  it('fails closed for short history and an exact-subject identity mismatch', () => {
    const full = history()
    expect(localHistoricalCashPairs([full[0], ...full.slice(61)], subject)).toEqual({
      status: 'unavailable',
      reason: 'insufficient_long_history',
    })

    const broken = history()
    broken[20].subjects[0].asset = `0x${'b'.repeat(40)}`
    expect(localHistoricalCashPairs(broken, subject)).toEqual({
      status: 'unavailable',
      reason: 'identity_mismatch',
    })
  })
})

describe('exact forecast question amount', () => {
  it('keeps raw units exact and rejects rounded or exponent inputs', () => {
    expect(exactForecastAssetsRaw('0.000001', 6)).toBe('1')
    expect(exactForecastAssetsRaw('12345678901234567890.123456', 6)).toBe(
      '12345678901234567890123456',
    )
    expect(exactForecastAssetsRaw('0.0000001', 6)).toBeNull()
    expect(exactForecastAssetsRaw('1e3', 6)).toBeNull()
    expect(exactForecastAssetsRaw('0', 6)).toBeNull()
  })
})

describe('local exact-Q historical cash holdout', () => {
  const now = Date.parse('2026-09-30T10:00:00.000Z')
  const supported = () => history(0n, (pair) => (pair % 20 < 12 ? 800n : 1_000n))

  it('uses the same verified long-grid pairs and fresh cash identity as the scenario', () => {
    const result = localHistoricalCashQHoldout(supported(), subject, '4500', now)
    expect(result).toMatchObject({
      status: 'historical_backtest',
      claim: 'aggregate_cash_proxy_only',
      sourceKind: 'local_sha_replayed_finalized_rpc',
      prospectiveValidated: false,
      holderExecutableExit: false,
      currentBlockAt: '2026-09-30T09:30:00.000Z',
      backtest: {
        status: 'historical_backtest',
        counts: { total: 60, fit: 20, calibration: 20, holdout: 20 },
        evidence: {
          requestedFraction: { numeratorRaw: '4500', denominatorRaw: '5000' },
          holdoutBreaches: { numerator: 12, denominator: 20 },
        },
      },
    })
  })

  it('abstains on a short grid, stale cash, invalid Q, and an unsupported holdout', () => {
    const full = supported()
    expect(
      localHistoricalCashQHoldout([full[0], ...full.slice(4)], subject, '4500', now),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient_long_history',
      backtest: null,
    })
    expect(localHistoricalCashQHoldout(full, subject, '4500', now + 2 * 3_600_000)).toMatchObject({
      status: 'unavailable',
      reason: 'no_fresh_current_cash',
      backtest: null,
    })
    expect(localHistoricalCashQHoldout(full, subject, '5001', now)).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_question',
      backtest: { status: 'unavailable', reason: 'invalid_question' },
    })
    const weak = history(0n, (pair) =>
      pair < 40 ? (pair % 20 < 12 ? 800n : 1_000n) : pair < 45 ? 800n : 1_000n,
    )
    expect(localHistoricalCashQHoldout(weak, subject, '4500', now)).toMatchObject({
      status: 'unavailable',
      reason: 'no_skill_over_persistence',
      backtest: { counts: { holdout: 20 }, evidence: { holdoutBeatsPersistence: false } },
    })
  })
})

describe('local prospective persistence issue evidence', () => {
  it('does not require a frozen-cohort issue for a supplemental market', () => {
    expect(
      localCashIssueEvidence([], 'USDe → supply on Aave V3', subject.destination, 24, false),
    ).toEqual({ status: 'not_enrolled', enrolledHorizonsHours: [1, 24] })
  })

  it('counts only exact-subject prospective attempts and scores', () => {
    const attempt = {
      routeKey: subject.route_key,
      destination: subject.destination,
      horizonHours: 24,
      status: 'issued',
    }
    const records = [
      {
        kind: 'issue',
        slotAt: '2026-09-30T10:00:00.000Z',
        issueSlotAt: '',
        issuedAt: '2026-09-30T10:00:01.000Z',
        attempts: [attempt],
      },
      {
        kind: 'score',
        slotAt: '',
        issueSlotAt: '2026-09-30T10:00:00.000Z',
        issuedAt: '',
        attempts: [{ ...attempt, status: 'scored' }, null],
      },
    ]
    expect(
      localCashIssueEvidence(records, subject.route_key, subject.destination, 24),
    ).toMatchObject({
      status: 'available',
      kind: 'prospective_aggregate_cash_persistence_baseline',
      attempts: { total: 1, issued: 1 },
      outcomes: { observed: 1, censoredMissing: 0, pending: 0 },
    })
  })

  it('counts an H1 partial score while the same issue H24 remains pending', () => {
    const issue = {
      kind: 'issue',
      slotAt: '2026-09-30T10:00:00.000Z',
      issueSlotAt: '',
      issuedAt: '2026-09-30T10:00:01.000Z',
      attempts: [1, 24].map((horizonHours) => ({
        routeKey: subject.route_key,
        destination: subject.destination,
        horizonHours,
        status: 'issued',
      })),
    }
    const h1 = {
      kind: 'score',
      slotAt: '',
      issueSlotAt: issue.slotAt,
      issuedAt: '',
      horizonHours: 1,
      attempts: [{ ...issue.attempts[0], status: 'scored' }],
    }
    const records = [issue, h1]
    expect(
      localCashIssueEvidence(records, subject.route_key, subject.destination, 1),
    ).toMatchObject({ outcomes: { observed: 1, censoredMissing: 0, pending: 0 } })
    expect(
      localCashIssueEvidence(records, subject.route_key, subject.destination, 24),
    ).toMatchObject({ outcomes: { observed: 0, censoredMissing: 0, pending: 1 } })
  })
})
