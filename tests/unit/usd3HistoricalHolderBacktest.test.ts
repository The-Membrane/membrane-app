import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  scoreUsd3HistoricalFold,
  usd3HistoricalFoldDefinitions,
  buildUsd3HistoricalHolderBacktest,
  writeUsd3HistoricalHolderBacktest,
  main,
} from '../../scripts/research/usd3-historical-holder-backtest.mts'
import {
  USD3_HISTORICAL_ROUTE,
  USD3_HISTORICAL_VAULT,
  USD3_HISTORICAL_USDC,
  USD3_REFERENCE_SUBJECT,
  type Usd3JointHistoricalInput,
  type Usd3JointHistoricalPoint,
} from '@/lib/carry/usd3JointHistoricalProcess'

const acquired = '2026-10-09T12:00:00.000Z'
it('constructs a causal report from the independently inventoried actual native capture', () => {
  const receipt = JSON.parse(
    readFileSync(
      new URL(
        '../../data/research/venue-signals/usd3-joint-native-history-evidence-2026-10-08/native-originals/01-native-historical-capture.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const report = buildUsd3HistoricalHolderBacktest(receipt, '2026-10-08T12:30:00.000Z')
  expect(report.counts.uniqueNativePoints).toBe(4)
  expect(report.counts.retrospectiveFolds).toBe(1)
  expect(report.counts.correlatedRequestScenarios).toBe(4)
  expect(report.counts.independentRequestSamples).toBe(0)
  expect(report.owner).toBeNull()
  expect(report.execution).toBe(false)
  for (const comparison of report.folds[0].comparisons) {
    expect(comparison.scenarios[0].errors).toEqual({
      fullEaRaw: '-46',
      nativeWithdrawLimitRaw: '2141424650062',
      holderAvailableRaw: '-46',
    })
    expect(comparison.persistenceErrors.nativeWithdrawLimitRaw).toBe('-1196838831386')
    expect(comparison.scenarios[0].donor.startAtUtc).toBe('2026-09-28T23:59:59.000Z')
  }
})
/** Synthetic values only; these helpers confer no collector replay or report-write authority. */
function point(n: number, ea = '1000', limit = '2000'): Usd3JointHistoricalPoint {
  return {
    source: {
      chainId: 1,
      blockNumber: 100 + n,
      blockHash: '0x' + String(n + 1).repeat(64),
      blockTime: new Date(Date.UTC(2026, 9, 8) + n * 3600000).toISOString(),
      finalized: true,
    },
    acquiredAtUtc: acquired,
    hypotheticalSharesRaw: '1000000',
    shareDecimals: 6,
    asset: USD3_HISTORICAL_USDC,
    assetDecimals: 6,
    nativeEaRaw: ea,
    availableWithdrawLimitRaw: limit,
    nativeQuoteStatus: 'conditional_reference_address_quote',
    withdrawalLimitSubject: USD3_REFERENCE_SUBJECT,
    conditionalReferenceAddressQuote: true,
    ownerCommitmentQualification: false,
    shutdown: false,
    navRaw: '1000000',
    totalAssetsRaw: '999999',
    idleUsdcDiagnosticRaw: '1',
    idleUsdcIsTotalFundingUpperBound: false,
    sourceClass: 'captured_identical_runtimes_only',
    runtimeIdentities: [
      USD3_HISTORICAL_VAULT,
      '0x' + 'a'.repeat(40),
      '0x' + 'b'.repeat(40),
      USD3_HISTORICAL_USDC,
    ].map((address, j) => ({ address, runtimeKeccak256: '0x' + String(j + 5).repeat(64) })),
    sourceImplementationEquivalence: false,
  }
}
function input(): Usd3JointHistoricalInput {
  const baseline = point(2)
  return {
    mode: 'retrospective_replay',
    routeKey: USD3_HISTORICAL_ROUTE,
    destination: USD3_HISTORICAL_VAULT,
    owner: null,
    issueAtUtc: acquired,
    knowledgeCutoffUtc: baseline.source.blockTime,
    horizonHours: 1,
    requestedRaw: '1000',
    history: [point(0), point(1)],
    baseline,
    maxHistoricalGapSeconds: 3600,
  }
}
describe('offline USD3 historical fold scoring', () => {
  it('scores an explicit nonzero getter reference without claiming a historical holder', () => {
    const i = input(),
      outcome = point(3),
      reference = '0x0000000000000000000000000000000000000001'
    i.withdrawalLimitSubject = reference
    for (const p of [...i.history, i.baseline, outcome]) p.withdrawalLimitSubject = reference
    const score = scoreUsd3HistoricalFold(i, outcome)
    expect(score.referenceSubject).toBe(reference)
    expect(score.referenceSubjectQualification).toBe('getter_reference_only')
    expect(i.owner).toBeNull()
    expect(score.actual.holderAvailableRaw).toBe('1000')
    expect(score.status).toBe('retrospective_descriptive_comparison')
  })
  it('rejects mixed or incorrectly declared reference subjects including the outcome', () => {
    const i = input(),
      outcome = point(3),
      reference = '0x0000000000000000000000000000000000000001'
    i.withdrawalLimitSubject = reference
    for (const p of [...i.history, i.baseline]) p.withdrawalLimitSubject = reference
    expect(() => scoreUsd3HistoricalFold(i, outcome)).toThrow('outcome_shape')
    outcome.withdrawalLimitSubject = reference
    expect(() => scoreUsd3HistoricalFold(i, outcome)).not.toThrow()
    i.history[0].withdrawalLimitSubject = USD3_REFERENCE_SUBJECT
    expect(() => scoreUsd3HistoricalFold(i, outcome)).toThrow('fold_clock_or_model')
  })
  it('retains the legacy zero-reference scoring shape when the declaration is omitted', () => {
    const legacy = scoreUsd3HistoricalFold(input(), point(3)),
      explicit = input()
    explicit.withdrawalLimitSubject = USD3_REFERENCE_SUBJECT
    expect(scoreUsd3HistoricalFold(explicit, point(3))).toEqual(legacy)
    expect(Object.hasOwn(legacy, 'referenceSubject')).toBe(false)
  })
  it('scores funding-bound large S independently of Q and rejects outcome knowledge from the future', () => {
    const i = input(),
      outcome = point(3),
      reference = '0x0000000000000000000000000000000000000001'
    i.withdrawalLimitSubject = reference
    for (const p of [...i.history, i.baseline, outcome]) {
      p.withdrawalLimitSubject = reference
      p.hypotheticalSharesRaw = '3000000000000'
      p.nativeEaRaw = '3100000000000'
      p.availableWithdrawLimitRaw = '1000000000000'
    }
    i.requestedRaw = '500000000000'
    const low = scoreUsd3HistoricalFold(i, outcome)
    i.requestedRaw = '2000000000000'
    const high = scoreUsd3HistoricalFold(i, outcome)
    expect(low.actual.holderAvailableRaw).toBe('1000000000000')
    expect(high.actual).toEqual(low.actual)
    expect(high.sharesRaw).toBe(low.sharesRaw)
    expect(high.actualHeadroomRaw).toBe('-1000000000000')
    expect(high.scenarios[0].errors).toEqual(low.scenarios[0].errors)
    outcome.acquiredAtUtc = '2026-10-10T00:00:00.000Z'
    expect(() => scoreUsd3HistoricalFold(i, outcome)).toThrow('outcome_shape')
  })
  it('four points provide exactly one prior-only fold; later folds retain distinct adjacent donors', () => {
    expect(usd3HistoricalFoldDefinitions([point(0), point(1), point(2), point(3)])).toEqual([
      { training: [0, 1], baseline: 2, outcome: 3 },
    ])
    expect(
      usd3HistoricalFoldDefinitions([point(0), point(1), point(2), point(3), point(4)]),
    ).toEqual([
      { training: [0, 1], baseline: 2, outcome: 3 },
      { training: [0, 1, 2], baseline: 3, outcome: 4 },
    ])
  })
  it('keeps funding errors visible when full entitlement binds the holder minimum', () => {
    const i = input()
    i.history = [point(0, '1000', '2000'), point(1, '1100', '2400')]
    i.baseline = point(2, '1200', '2800')
    const score = scoreUsd3HistoricalFold(i, point(3, '1300', '5000'))
    expect(score.scenarios[0].predicted).toEqual({
      fullEaRaw: '1300',
      nativeWithdrawLimitRaw: '3200',
      holderAvailableRaw: '1300',
      headroomRaw: '300',
    })
    expect(score.scenarios[0].errors).toEqual({
      fullEaRaw: '0',
      nativeWithdrawLimitRaw: '-1800',
      holderAvailableRaw: '0',
    })
    expect(score.persistenceErrors).toEqual({
      fullEaRaw: '-100',
      nativeWithdrawLimitRaw: '-2200',
      holderAvailableRaw: '-100',
    })
    expect(score.knowledgeCutoffUtc).toBe(i.baseline.source.blockTime)
    expect(score.actualAcquiredAtUtc).toBe(acquired)
  })
  it('correlated Q changes headroom only; same-S C/Ea predictions/errors stay identical', () => {
    const i = input(),
      target = point(3, '1000', '4000')
    const a = scoreUsd3HistoricalFold(i, target)
    i.requestedRaw = '250'
    const b = scoreUsd3HistoricalFold(i, target)
    expect(a.sharesRaw).toBe(b.sharesRaw)
    expect(a.scenarios[0].errors).toEqual(b.scenarios[0].errors)
    expect(a.scenarios[0].predicted!.headroomRaw).toBe('0')
    expect(b.scenarios[0].predicted!.headroomRaw).toBe('750')
  })
  it('censors a changed target runtime class without silently comparing a different process', () => {
    const target = point(3)
    target.runtimeIdentities[2].runtimeKeccak256 = '0x' + 'f'.repeat(64)
    const score = scoreUsd3HistoricalFold(input(), target)
    expect(score.status).toBe('censored_target_native_class_or_S_changed')
    expect(score.targetSummary).toBeNull()
    expect(score.scenarios[0].errors).toBeNull()
    expect(score.actual.fullEaRaw).toBe('1000')
  })
  it('does not substitute zero for unknown target C and still reports measurable Ea error', () => {
    const target = point(3, '1100')
    target.availableWithdrawLimitRaw = null
    target.nativeQuoteStatus = 'censored_native_withdrawal_limit_unavailable'
    const score = scoreUsd3HistoricalFold(input(), target)
    expect(score.status).toBe('censored_target_native_limit_unavailable')
    expect(score.actual.nativeWithdrawLimitRaw).toBeNull()
    expect(score.actual.holderAvailableRaw).toBeNull()
    expect(score.scenarios[0].errors).toEqual({
      fullEaRaw: '-100',
      nativeWithdrawLimitRaw: null,
      holderAvailableRaw: null,
    })
    expect(score.targetSummary).toBeNull()
  })
  it('preserves exclusions and suppresses headline despite one surviving donor', () => {
    const i = input()
    i.baseline = point(3)
    i.knowledgeCutoffUtc = i.baseline.source.blockTime
    i.history = [point(0), point(1), point(2)]
    i.history[0].availableWithdrawLimitRaw = null
    i.history[0].nativeQuoteStatus = 'censored_native_withdrawal_limit_unavailable'
    const score = scoreUsd3HistoricalFold(i, point(4))
    expect(score.counts).toEqual({ attempted: 2, usable: 1, censored: 0, excluded: 1 })
    expect(score.excludedIntervals[0].reason).toBe('native_withdrawal_limit_unavailable')
    expect(score.targetSummary).toBeNull()
    expect(score.completeAttemptedIntervalCoverage).toBe(false)
  })
  it('rejects target mismatch and malformed raw receipts before authenticated local reads', () => {
    expect(() => scoreUsd3HistoricalFold(input(), point(4))).toThrow('fold_clock_or_model')
    expect(() => buildUsd3HistoricalHolderBacktest({}, acquired)).toThrow('capture_transport')
    expect(() =>
      buildUsd3HistoricalHolderBacktest(
        { schema: 'replayed_usd3_hypothetical_history_v1', points: [] },
        acquired,
      ),
    ).toThrow('capture_transport')
  })
  it('cannot write synthetic helper output or accept an unrecognized CLI mode', () => {
    expect(() =>
      writeUsd3HistoricalHolderBacktest('/tmp/must-not-create-usd3-report.json', {} as never),
    ).toThrow('private_report_required')
    expect(() => main(['--capture', 'a', '--live', 'b'])).toThrow('cli_arguments')
    expect(() => main(['--capture', 'a', '--additional-capture', 'a', '--output', 'b'])).toThrow(
      'duplicate_capture_path',
    )
  })
})
