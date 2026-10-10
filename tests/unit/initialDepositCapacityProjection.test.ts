import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { localHistoricalSampledCashTimeline } from '@/lib/carry/localHistoricalSampledCashTimeline'
import {
  buildConditionalSampledCashPathProjection,
  conditionalSampledCashHistoryFromVerifiedTimeline,
  type ConditionalSampledCashCurrentSource,
} from '@/lib/carry/conditionalSampledCashPathProjection'
import {
  buildInitialDepositCapacityProjection,
  selectedInitialDepositCapacityProjection,
  selectedInitialDepositNativeAgreement,
  sourceIndexedInitialReceipt,
  INITIAL_DEPOSIT_MARKETS,
  type InitialDepositNativeAgreement,
} from '@/lib/carry/initialDepositCapacityProjection'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const now = Date.parse('2026-10-08T12:00:00.000Z'),
  RAY = 10n ** 27n
const root = 'data/research/venue-signals/local-carry-cash-v1'
const observations = readdirSync(root)
  .filter((n) => /^\d{12}\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(`${root}/${n}`, 'utf8')))
  .map((r) => ({
    collectionMode: r.collectionMode,
    anchorAt: r.anchorAt,
    firstLocalReceiptAt: r.firstLocalReceiptAt,
    receiptSha256: r.sha256,
    manifestSha256: r.manifestSha256,
    source: { block: r.block, blockAt: r.blockAt, blockHash: r.blockHash },
    subjects: r.rows,
  }))
function input(m = INITIAL_DEPOSIT_MARKETS[0], D = '10', Q = '9') {
  const t = localHistoricalSampledCashTimeline(observations, {
    route_key: m.routeKey,
    destination: m.destination.toLowerCase(),
    asset: m.underlying.toLowerCase(),
  })
  if (t.status !== 'sampled_timeline') throw Error(t.reason)
  const h = conditionalSampledCashHistoryFromVerifiedTimeline(observations, t)!
  const s: ConditionalSampledCashCurrentSource = {
    ...h.identity,
    chainId: 1,
    cashRaw: '100',
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(now - 1000).toISOString(),
    readAt: new Date(now).toISOString(),
    sourceKind: 'live_read_only_two_origin_finalized',
  }
  const p = buildConditionalSampledCashPathProjection(
    {
      history: h,
      currentSource: s,
      request: { requestedRaw: Q, asOf: new Date(now).toISOString() },
    },
    sha,
  )
  const f = {
    pool: m.pool,
    aToken: s.destination,
    asset: s.asset,
    assetDecimals: 6 as const,
    configurationRaw: String((6n << 48n) | (1n << 56n) | (1000n << 116n)),
    normalizedIncomeRaw: String(RAY),
    scaledTotalSupplyRaw: '1000',
    accruedToTreasuryScaledRaw: '20',
  }
  const a: InitialDepositNativeAgreement = {
    status: 'agreed_initial_deposit_native_facts',
    currentSource: structuredClone(s),
    readAt: new Date(now).toISOString(),
    origins: [
      { originHostSha256: sha('one.example'), facts: structuredClone(f) },
      { originHostSha256: sha('two.example'), facts: structuredClone(f) },
    ],
  }
  return {
    currentSource: s,
    dailyProjection: p,
    depositAssetsRaw: D,
    plannedExitAssetsRaw: Q,
    horizonHours: 24,
    asOfMs: now,
    nativeAgreement: a,
  }
}
function estimated(i = input()) {
  const p = buildInitialDepositCapacityProjection(i, sha)
  if (p.status !== 'conditional_initial_deposit_projection') throw Error(p.reason)
  return p
}
describe('conditional native initial-deposit projection', () => {
  it.each(INITIAL_DEPOSIT_MARKETS)(
    'uses real verified history for $routeKey and preserves actual source C',
    (m) => {
      const i = input(m),
        p = estimated(i)
      expect(p.currentSource).toEqual(i.currentSource)
      expect(p.currentSource.cashRaw).toBe('100')
      expect(p.hypotheticalState).toMatchObject({
        cashRaw: '110',
        observed: false,
        depositAtUtc: i.currentSource.blockTime,
      })
      expect(p.hypotheticalDepositAtUtc).toBe(i.currentSource.blockTime)
      expect(p.process?.targetAtUtc).toBe(new Date(now + 86400000).toISOString())
      expect(p.process?.input.current.provenanceRef).toMatch(/^hypothetical_deposit_at_source:/)
      expect(p.actualHolderWitnessUsed).toBe(false)
      expect(p.depositAdmitted).toBe(false)
      expect(p.admission.status).toBe('unknown')
    },
  )
  it('adds D to original C and joint net delta before flooring, clips E, and subtracts Q once', () => {
    const p = estimated(),
      process = p.process!
    let foundFloorCounterexample = false
    for (const scenario of process.scenarios) {
      const donor = scenario.donor,
        delta = BigInt(donor.jointDeltaRaw.cash)
      for (const point of scenario.points) {
        const numerator = delta * BigInt(Math.round(point.elapsedFromSourceSeconds * 1000))
        const denominator = BigInt(Math.round(donor.durationSeconds * 1000))
        const shift =
          numerator / denominator - (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n)
        const unFloored = 110n + shift,
          expectedCash = unFloored < 0n ? 0n : unFloored
        expect(point.availableRaw).toBe(String(expectedCash))
        expect(point.capacityRaw).toBe(String(expectedCash < 10n ? expectedCash : 10n))
        expect(point.headroomRaw).toBe(String(BigInt(point.capacityRaw) - 9n))
        if (100n + shift < 0n && expectedCash === 0n) foundFloorCounterexample = true
      }
    }
    expect(foundFloorCounterexample).toBe(true)
    expect(p.assumptions.historicalCompetitionIncludedInNetPaths).toBe(true)
    expect(p.assumptions.grossFlowAdded).toBe(false)
  })
  it('retains sampled duration brackets and both censoring flags when Q exceeds hypothetical receipt', () => {
    const p = estimated(input(INITIAL_DEPOSIT_MARKETS[0], '10', '20'))
    for (const s of p.process!.scenarios) {
      expect(s.sampledShortfalls).toHaveLength(1)
      expect(s.sampledShortfalls[0]).toMatchObject({
        leftCensored: true,
        rightCensored: true,
        recovery: null,
      })
      expect(s.continuousPathKnown).toBe(false)
    }
  })
  it('keeps useful cash-only paths when optional native facts are absent or disagree', () => {
    const i = input(),
      absent = estimated({ ...i, nativeAgreement: undefined } as any)
    expect(absent.process).toBeNull()
    expect(absent.hypotheticalReceipt.status).toBe('unavailable')
    expect(absent.cashOnlyProcess.targetSummary).not.toBeNull()
    i.nativeAgreement.origins[1].facts.normalizedIncomeRaw = String(RAY + 1n)
    const bad = estimated(i)
    expect(bad.nativeAgreement).toBeNull()
    expect(bad.process).toBeNull()
    expect(bad.hypotheticalReceipt).toMatchObject({ reason: 'native_facts_invalid_or_disagreeing' })
    expect(bad.cashOnlyClaim).toContain('not_holder_exit_capacity')
  })
  it('uses exact half-up ray arithmetic and rejects zero scaled mint and uint256 intermediates', () => {
    expect(sourceIndexedInitialReceipt('1', String((RAY * 3n) / 2n))).toEqual({
      scaledMintRaw: '1',
      entitlementRaw: '2',
    })
    expect(sourceIndexedInitialReceipt('1', String(RAY * 3n))).toBeNull()
    expect(sourceIndexedInitialReceipt(String((1n << 256n) - 1n), String(RAY))).toBeNull()
    expect(sourceIndexedInitialReceipt('0', String(RAY))).toBeNull()
    expect(sourceIndexedInitialReceipt('1', '0')).toBeNull()
  })
  it('does not claim admission from flags or cap and preserves a conditional scenario when frozen', () => {
    const i = input()
    for (const o of i.nativeAgreement.origins)
      o.facts.configurationRaw = String(BigInt(o.facts.configurationRaw) | (1n << 57n))
    const p = estimated(i)
    expect(p.admission).toMatchObject({
      status: 'blocked_under_reference_rules',
      frozen: true,
      supplyCapAssetsRaw: '1000000000',
      capAssessment: 'display_only_treasury_update_before_validation_unassessed',
    })
    expect(p.process).not.toBeNull()
    expect(p.assumptions.successfulAdmittedDepositAtSource).toBe(true)
  })
  it.each(['source', 'clock', 'host', 'asset', 'index'])(
    'rejects tampered native %s facts',
    (kind) => {
      const i = input(),
        a = i.nativeAgreement
      if (kind === 'source') a.currentSource.cashRaw = '101'
      if (kind === 'clock') a.readAt = new Date(now + 1).toISOString()
      if (kind === 'host') a.origins[1].originHostSha256 = a.origins[0].originHostSha256
      if (kind === 'asset') a.origins[0].facts.asset = '0x' + '0'.repeat(40)
      if (kind === 'index') a.origins[0].facts.normalizedIncomeRaw = '0'
      expect(selectedInitialDepositNativeAgreement(a, i.currentSource, now)).toBeNull()
    },
  )
  it('rebuilds independent D/Q/source/target and does not slide the issue on refresh', () => {
    const i = input(),
      p = estimated(i)
    expect(selectedInitialDepositCapacityProjection(p, i, now + 1000, sha)).toEqual(p)
    expect(
      selectedInitialDepositCapacityProjection(p, { ...i, depositAssetsRaw: '11' }, now, sha),
    ).toBeNull()
    expect(
      selectedInitialDepositCapacityProjection(
        { ...p, target: { ...p.target, at: new Date(now).toISOString() } },
        i,
        now,
        sha,
      ),
    ).toBeNull()
    expect(selectedInitialDepositCapacityProjection(p, i, now + 1800000, sha)).toBeNull()
  })
  it('never fabricates an unsupported model or accepts changed verified history', () => {
    const i = input()
    expect(
      buildInitialDepositCapacityProjection(
        { ...i, currentSource: { ...i.currentSource, routeKey: 'unknown' } },
        sha,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'unsupported_subject' })
    if (i.dailyProjection.status !== 'estimated') throw Error('expected history')
    i.dailyProjection.history.points[0][4] = '1'
    expect(buildInitialDepositCapacityProjection(i, sha)).toMatchObject({
      reason: 'verified_cash_paths_unavailable',
    })
  })
  it('keeps source-age interpolation explicit for a selected horizon finer than daily history', () => {
    const p = estimated({ ...input(), horizonHours: 1 })
    expect(p.process!.horizonFinerThanHistory).toBe(true)
    expect(p.process!.assumptions.totalElapsedIncludesSourceAge).toBe(true)
    expect(p.process!.targetAtUtc).toBe(new Date(now + 3600000).toISOString())
  })
})
