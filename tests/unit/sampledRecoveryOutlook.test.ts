import { describe, expect, it } from 'vitest'
import { sampledRecoveryOutlook, normalizeNativeRecoveryHistory, type RecoveryInput } from '@/lib/venueForecast/sampledRecoveryOutlook'
import { forecastSampledCapacity } from '@/lib/venueForecast/sampledCapacity'
import { forecastRouteCash } from '@/lib/carry/routeCashForecast'
const START = Date.parse('2026-01-01T00:00:00Z'), H = 3_600_000
const at = (h: number) => new Date(START + h * H).toISOString()
function question(values: (number | null)[], extra: Partial<RecoveryInput> = {}): RecoveryInput {
  return { routeKey: 'same-route', metric: 'cash_units', amount: 100, horizonHours: 1,
    asOf: at(values.length - 1), maxGapHours: 2, maxObservationAgeHours: 2,
    snapshots: values.map((capacityUsd, i) => ({ observedAt: at(i), firstAvailableAt: at(i),
      capacityUsd, coverage: capacityUsd === null ? 'partial' : 'complete', sourceId: `receipt-${i}` })), ...extra }
}
const four = [110,80,80,110,80,80,110,80,80,110,80,80,110,80]
describe('conditional sampled recovery outlook', () => {
  it('uses four distinct episodes and interval crossings without promoting execution', () => {
    const r = sampledRecoveryOutlook(question(four))
    expect(r.status).toBe('conditional_history'); expect(r.counts.matchedDonors).toBe(4)
    expect(r.centralHours).toBe(1.5); expect(r.orderStatisticsHours.p50).toEqual({lower:1,upper:2})
    expect(r.regimeBasis).toBe('assumed_unchanged')
    expect(r).toMatchObject({forecastValidated:false,holderExecutable:false,continuousPathKnown:false})
    expect(r.donors[0].onset).toEqual({after:at(0),by:at(1)})
    expect(r.donors[0].recovery).toEqual({after:at(2),by:at(3)})
    expect(r.counts.straddlingHorizon).toBe(0); expect(r.counts.sampledEpisodeBelowThroughHorizon).toBe(4)
  })
  it('does not invent a central value from sparse complete donors', () => {
    const r = sampledRecoveryOutlook(question([110,80,110,80]))
    expect(r.status).toBe('sparse_history'); expect(r.centralHours).toBeNull()
    expect(r.donors).toHaveLength(1); expect(r.donors[0].remainingHours).toEqual({lower:0,upper:1})
    expect(r.counts.sampledRecoveryBracketByHorizon).toBe(1)
  })
  it('selects one deterministic past landmark per episode despite repeated matching samples', () => {
    const r = sampledRecoveryOutlook(question([110,80,80,80,110,80]))
    expect(r.donors).toHaveLength(1); expect(r.donors[0].landmarkAt).toBe(at(1))
  })
  it('chooses the first deficit-band match from landmark-past rather than the episode onset', () => {
    const r = sampledRecoveryOutlook(question([110,95,80,110,80]))
    expect(r.donors).toHaveLength(1); expect(r.donors[0].landmarkAt).toBe(at(2))
    expect(r.matching.deficitBand).toEqual([0.1,0.25])
  })
  it('ignores future observations and delayed availability including otherwise invalid future values', () => {
    const q = question(four), original = sampledRecoveryOutlook(q)
    const future = {...q.snapshots[0],observedAt:at(14),firstAvailableAt:at(14),capacityUsd:-1}
    const delayed = {...q.snapshots[0],observedAt:at(12.5),firstAvailableAt:at(15),capacityUsd:900}
    expect(sampledRecoveryOutlook({...q,snapshots:[...q.snapshots,future,delayed]})).toEqual(original)
  })
  it('keeps null/gap censored donors with infinite upper bounds rather than complete-only estimates', () => {
    const r = sampledRecoveryOutlook(question([110,80,null,110,80,null,110,80,null,110,80,null,110,80]))
    expect(r.counts.matchedDonors).toBe(4); expect(r.counts.censoredBeforeHorizon).toBe(4)
    expect(r.orderStatisticsHours.p50).toEqual({lower:0,upper:null}); expect(r.centralHours).toBeNull()
    expect(r.donors.every((d) => d.censored === 'gap' && d.remainingHours.upper === null)).toBe(true)
  })
  it('includes a censored donor alongside complete donors in all order statistics', () => {
    const r = sampledRecoveryOutlook(question([110,80,110,80,null,110,80]))
    expect(r.counts.matchedDonors).toBe(2); expect(r.counts.censoredBeforeHorizon).toBe(1)
    expect(r.orderStatisticsHours.p90!.upper).toBeNull(); expect(r.centralHours).toBeNull()
  })
  it('exposes left-censored age separately; right-censored current episode never donates to itself', () => {
    const left = sampledRecoveryOutlook(question([80,80])); expect(left.currentRightCensored).toBe(true); expect(left.matching.ageStratum).toBe('unknown_left_censored'); expect(left.status).toBe('sparse_history')
    expect(left.currentOnset).toEqual({after:null,by:at(0)})
    const historicalLeft = sampledRecoveryOutlook(question([80,110,80]))
    expect(historicalLeft.counts.leftCensoredHistorical).toBe(1)
    expect(historicalLeft.episodeBrackets[0].onset.after).toBeNull()
    const right = sampledRecoveryOutlook(question([110,80,80])); expect(right.counts.matchedDonors).toBe(0)
  })
  it('starts a left-censored episode after a long gap and rejects stale current samples', () => {
    const q = question([110,80,80]); const shifted=q.snapshots.map((s,i)=>i===2?{...s,observedAt:at(8),firstAvailableAt:at(8)}:s)
    expect(sampledRecoveryOutlook({...q,asOf:at(8),snapshots:shifted}).matching.ageStratum).toBe('unknown_left_censored')
    expect(sampledRecoveryOutlook({...q,asOf:at(9)}).reason).toBe('current_stale')
  })
  it('retains daily mixed-age analogues but suppresses their central estimate', () => {
    const q = question(four, {maxGapHours:25,maxObservationAgeHours:25})
    q.snapshots=q.snapshots.map((s,i)=>({...s,observedAt:at(i*24),firstAvailableAt:at(i*24)})); q.asOf=at(13*24)
    const r=sampledRecoveryOutlook(q)
    expect(r.matching.ageStratum).toBe('straddling'); expect(r.matching.assumedAgeBandsHours).toEqual([[0,6],[6,24]])
    expect(r.counts.matchedDonors).toBe(4); expect(r.supportGate.passed).toBe(true); expect(r.centralHours).toBeNull()
    expect(r.assumptions).toContain('assumed_no_hidden_recrossings_between_samples')
    expect(r.supportGate).toMatchObject({minimumDistinctEpisodes:4,episodeDefinition:'non_overlapping_sampled_episodes'})
  })
  it('matches unknown-age episodes separately, includes all donors and retains unbounded censoring', () => {
    const r=sampledRecoveryOutlook(question([80,110,null,80,110,null,80,110,null,80,110,null,80]))
    expect(r.matching.ageStratum).toBe('unknown_left_censored'); expect(r.donors).toHaveLength(4)
    expect(r.donors.every(d=>d.onset.after===null)).toBe(true); expect(r.centralHours).toBeNull()
    const censored=sampledRecoveryOutlook(question([80,null,80,null,80]))
    expect(censored.donors).toHaveLength(2); expect(censored.orderStatisticsHours.p50!.upper).toBeNull()
  })
  it('treats Q equality as not below and never substitutes a future donor', () => {
    expect(sampledRecoveryOutlook(question([80,100])).status).toBe('not_below')
    expect(sampledRecoveryOutlook(question([110,80,110,80],{asOf:at(1)})).counts.matchedDonors).toBe(0)
  })
  it('does not cross verified regime changes or combine donors from another regime', () => {
    const q=question([110,80,110,80,110,80]); q.snapshots=q.snapshots.map((s,i)=>({...s,recoveryRegimeId:i<3?'old':'current'}))
    const r=sampledRecoveryOutlook(q); expect(r.regimeBasis).toBe('verified_tag')
    expect(r.counts.otherRegimeEpisodes).toBe(1); expect(r.counts.matchedDonors).toBe(0)
  })
  it('counts horizon-straddling recovery brackets explicitly', () => {
    const r=sampledRecoveryOutlook(question([110,80,80,110,80],{horizonHours:1.5}))
    expect(r.counts.straddlingHorizon).toBe(1); expect(r.counts.atRiskSupport).toBe(1)
  })
  it('keeps integrated recovery unchanged when future/delayed rows are appended', () => {
    const q=question(four), input={routeKey:q.routeKey,metric:q.metric,amountUsd:q.amount,horizonHours:2,asOf:q.asOf,snapshots:q.snapshots}
    const original=forecastSampledCapacity(input)
    const future={...q.snapshots[0],observedAt:at(14),firstAvailableAt:at(14),capacityUsd:900}
    const delayed={...q.snapshots[0],observedAt:at(12.5),firstAvailableAt:at(15),capacityUsd:900}
    expect(forecastSampledCapacity({...input,snapshots:[...q.snapshots,future,delayed]})).toEqual(original)
  })
  it('keeps bulk receipt availability while labeling a retrospective source-clock scenario', () => {
    const q=question(four), bulk=q.snapshots.map((s)=>({...s,firstAvailableAt:at(20)}))
    const retrospective=sampledRecoveryOutlook({...q,asOf:at(20),scenarioAt:at(13),snapshots:bulk})
    expect(retrospective.centralHours).toBe(1.5)
    expect(retrospective).toMatchObject({realIssueAt:at(20),scenarioAt:at(13),issueClockBasis:'source_clock_retrospective',
      analogueLandmarkClock:'source_clock_retrospective',historicalAppIssuanceKnown:false})
    expect(bulk.every((s)=>s.firstAvailableAt===at(20))).toBe(true)
    expect(sampledRecoveryOutlook({...q,asOf:at(19),scenarioAt:at(13),snapshots:bulk}).reason).toBe('current_censored')
    expect(sampledRecoveryOutlook({...q,asOf:at(13),scenarioAt:at(14)}).reason).toBe('invalid_question')
  })
  it('default real issue can use past source-time analogues without claiming past app issuance', () => {
    const q=question(four), bulk=q.snapshots.map((s)=>({...s,firstAvailableAt:at(13)}))
    const r=sampledRecoveryOutlook({...q,snapshots:bulk})
    expect(r.centralHours).toBe(1.5); expect(r.issueClockBasis).toBe('availability_clock')
    expect(r.historicalAppIssuanceKnown).toBe(false)
  })
  it('forwards Q and recovery duration through the unit adapter without changing legacy fields', () => {
    const q=question(four), engine=forecastSampledCapacity({routeKey:'same-route:0xabc',metric:'cash_units',amountUsd:100,
      horizonHours:2,asOf:q.asOf,snapshots:q.snapshots,maxObservationAgeHours:2})
    const adapter=forecastRouteCash({routeKey:'same-route',destination:'0xabc',asset:'0xdef',assetSymbol:'LINK',cashKind:'vault_cash',
      amountUnits:100,horizonHours:2,asOf:q.asOf,snapshots:q.snapshots.map(({capacityUsd,...s})=>({...s,cashUnits:capacityUsd}))})
    expect(adapter.amountUnits).toBe(100); expect(adapter.duration.historicalRecovery).toEqual(engine.duration.historicalRecovery)
    expect(adapter.duration.historicalRecovery?.amount).toBe(100)
    const untagged=forecastSampledCapacity({routeKey:'same-route',metric:'cash_units',amountUsd:100,horizonHours:2,asOf:q.asOf,snapshots:q.snapshots})
    const tagged=forecastSampledCapacity({routeKey:'same-route',metric:'cash_units',amountUsd:100,horizonHours:2,asOf:q.asOf,
      snapshots:q.snapshots.map((s)=>({...s,recoveryRegimeId:'same'}))})
    const legacy=(r:typeof tagged)=>({...r,duration:{...r.duration,historicalRecovery:undefined}})
    expect(legacy(tagged)).toEqual(legacy(untagged)); expect(untagged.duration.durationForecast.status).toBe('unavailable')
  })
})

describe('native history normalization after external artifact authentication', () => {
  const history=(decimals:number,cash:string)=>({identity:{routeKey:'same-route',destination:`0x${'a'.repeat(40)}`,
    asset:`0x${'b'.repeat(40)}`,assetDecimals:decimals},coverage:{} as never,
    witness:{manifestSha256:'authenticated-externally',lastDailyReceiptSha256:'authenticated-externally',availableAt:at(20)},
    points:[[0,'1',`0x${'c'.repeat(64)}`,at(0),cash]] as [number,string,string,string,string][]})
  it('normalizes six and eighteen decimal native units without backdating bulk availability', () => {
    for(const decimals of [6,18]) {
      const h=history(decimals,(80n*10n**BigInt(decimals)).toString()), rows=normalizeNativeRecoveryHistory(h,100)!
      expect(rows[0].capacityUsd).toBe(80); expect(rows[0].firstAvailableAt).toBe(at(20))
      expect(rows[0].recoveryRegimeId).toBeUndefined()
    }
  })
  it('rejects floating point conversion that erases an exact native Q threshold or deficit boundary', () => {
    expect(normalizeNativeRecoveryHistory(history(18,(10000n*10n**18n-1n).toString()),10000)).toBeNull()
    expect(normalizeNativeRecoveryHistory(history(18,(75n*10n**18n+1n).toString()),100)).toBeNull()
  })
  it('rejects duplicate or unavailable source points rather than filling or merging them', () => {
    const h=history(6,'80000000'); h.points.push([...h.points[0]])
    expect(normalizeNativeRecoveryHistory(h,100)).toBeNull()
    const future=history(6,'80000000');future.points[0][3]=at(21)
    expect(normalizeNativeRecoveryHistory(future,100)).toBeNull()
  })
})
