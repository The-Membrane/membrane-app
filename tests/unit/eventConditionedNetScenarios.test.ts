import { describe, expect, it } from 'vitest'
import {
  selectEventConditionedNetScenarios,
  type EventConditionedNetInput,
  type EventNetSubject,
  type ReviewedNetEvent,
} from '../../lib/carry/eventConditionedNetScenarios'

// Controlled unsigned endpoint/event descriptors. They are not native originals,
// independently verified occurrence proofs or historically issued forecasts.
const USDC: EventNetSubject = {
  routeKey: 'USDC → VaultV2 [USDC]',
  destination: '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  assetDecimals: 6,
}
const stamp = (day: number, hour = 0) =>
  '2026-10-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'
const taxonomy = {
  namespace: 'reviewed-fixture',
  eventType: 'policy_change',
  reviewRef: 'fixture:taxonomy',
}
function event(day: number, id: string): ReviewedNetEvent {
  return {
    subject: { ...USDC },
    regime: 'fixture:policy-v1',
    taxonomy: { ...taxonomy },
    eventId: id,
    storyId: 'story:' + id,
    duplicateGroupId: 'group:' + id,
    knowledgeBasis: 'publication_backed',
    kind: 'official_observed',
    occurredAtUtc: stamp(day),
    firstKnownAtUtc: stamp(day),
    fetchedAtUtc: stamp(day),
    availableAtUtc: stamp(day),
    publishedAtUtc: new Date(Date.parse(stamp(day)) - 86400000).toISOString(),
    occurrenceProof: {
      kind: 'official_effective',
      occurredAtUtc: stamp(day),
      availableAtUtc: stamp(day),
      sourceRef: 'fixture:official:' + id,
      reviewRef: 'fixture:review:' + id,
      block: null,
      blockHash: null,
    },
  }
}
function fixture(): EventConditionedNetInput {
  const cash = ['1000', '900', '950', '800', '700', '750', '750']
  return {
    informationMode: 'as_of_replay',
    target: {
      subject: { ...USDC },
      regime: 'fixture:policy-v1',
      source: {
        block: '1000',
        blockHash: '0x' + 'a'.repeat(64),
        sourceAtUtc: stamp(10),
        availableAtUtc: '2026-10-10T00:05:00.000Z',
      },
    },
    knowledgeCutoffUtc: '2026-10-10T00:10:00.000Z',
    taxonomy: { ...taxonomy },
    scope: { kind: 'exact_subject' },
    parameters: {
      lookbackSeconds: 30 * 86400,
      eventResponseWindowSeconds: 86400,
      minimumIntervalSeconds: 20 * 3600,
      maximumGapSeconds: 26 * 3600,
      horizonSeconds: 86400,
      minimumMatchedIntervals: 2,
      minimumEventClusters: 2,
      maximumScenariosPerSubject: 128,
    },
    histories: [
      {
        subject: { ...USDC },
        points: cash.map((cashRaw, index) => ({
          index,
          block: String((index + 1) * 100),
          blockHash: '0x' + String(index + 1).repeat(64),
          sourceAtUtc: stamp(index + 1),
          // An offline capture may arrive later. Never backdate this to source time.
          availableAtUtc: stamp(8),
          regime: 'fixture:policy-v1',
          cashRaw,
          provenanceRef: 'fixture:retained-point:' + String(index),
        })),
      },
    ],
    events: [event(1, 'event:one'), event(4, 'event:two')],
  }
}
function build(input = fixture()) {
  const r = selectEventConditionedNetScenarios(input)
  expect(r).not.toBeNull()
  return r!
}
function delayFirstEvent(f: EventConditionedNetInput) {
  const e = f.events[0]
  e.firstKnownAtUtc = stamp(1, 1)
  e.fetchedAtUtc = stamp(8)
  e.availableAtUtc = stamp(8)
  e.occurrenceProof!.availableAtUtc = stamp(8)
}
describe('availability-aware event-associated native NET selection', () => {
  it('joins two reviewed event windows and returns comparable unmatched/persistence baselines', () => {
    const r = build()
    expect(r.status).toBe('event_associated_net_scenarios')
    expect(r.subjects[0].counts).toEqual({
      candidateIntervals: 6,
      baselineEligibleIntervals: 6,
      matchedIntervals: 2,
      comparableUnmatchedIntervals: 4,
      matchedEventClusters: 2,
      baselineRejectedIntervals: 0,
      eventOverlapExcludedFromUnmatched: 0,
      selectedMatched: 2,
      selectedUnmatched: 4,
      selectedBaseline: 6,
    })
    expect(r.subjects[0].matched.map((s) => s.netDeltaRaw)).toEqual(['-100', '-100'])
    expect(r.subjects[0].comparableUnmatched.map((s) => s.netDeltaRaw)).toEqual([
      '-150',
      '0',
      '50',
      '50',
    ])
    expect(r.subjects[0].persistence).toEqual({ netDeltaRaw: '0', denominatorMs: 1000 })
    expect(r.subjects[0].matched.every((s) => s.eventKnownByHistoricalStart)).toBe(true)
  })
  it('requires the information mode explicitly', () => {
    const f = fixture()
    delete (f as Partial<EventConditionedNetInput>).informationMode
    expect(selectEventConditionedNetScenarios(f)).toBeNull()
  })
  it('never uses earlier publication time as first-known event availability', () => {
    const f = fixture()
    delayFirstEvent(f)
    const r = build(f)
    expect(r.status).toBe('insufficient_event_matches')
    expect(r.subjects[0].matched).toHaveLength(1)
    expect(r.subjects[0].baselineNativeNet).toHaveLength(6)
    // The late event was not in the donor-start catalogue, including its
    // unmatched classification. No future-known event contaminates that donor.
    expect(r.subjects[0].comparableUnmatched).toHaveLength(5)
    expect(r.excludedIntervals).toHaveLength(0)
    f.events[0].publishedAtUtc = '2000-01-01T00:00:00.000Z'
    expect(build(f).subjects).toEqual(r.subjects)
  })
  it.each(['duplicate', 'conflicting_occurrence', 'alias_bridge'] as const)(
    'past replay selection is invariant when appending an unavailable future %s row',
    (kind) => {
      const f = fixture()
      const before = build(f)
      const future = structuredClone(f.events[0])
      future.fetchedAtUtc = '2026-10-10T00:10:00.001Z'
      future.availableAtUtc = future.fetchedAtUtc
      if (kind === 'conflicting_occurrence') {
        future.occurredAtUtc = stamp(1, 1)
        future.firstKnownAtUtc = stamp(1, 1)
        future.occurrenceProof!.occurredAtUtc = stamp(1, 1)
        future.occurrenceProof!.availableAtUtc = stamp(1, 1)
      } else if (kind === 'alias_bridge') {
        future.storyId = f.events[1].storyId
        future.duplicateGroupId = f.events[1].duplicateGroupId
      }
      f.events.push(future)
      const after = build(f)
      expect(after.subjects).toEqual(before.subjects)
      expect(after.counts.availableEventRows).toBe(before.counts.availableEventRows)
      expect(after.counts.deduplicatedSubjectEventGroups).toBe(
        before.counts.deduplicatedSubjectEventGroups,
      )
      expect(after.counts.matchedSubjectEventClusters).toBe(
        before.counts.matchedSubjectEventClusters,
      )
      expect(after.excludedEvents).toEqual(before.excludedEvents)
      expect(after.unavailableEvents).toHaveLength(1)
      expect(after.counts.unavailableEventRows).toBe(1)
    },
  )
  it('filters a future occurrence-proof availability before duplicate/conflict grouping', () => {
    const f = fixture()
    const before = build(f)
    const future = structuredClone(f.events[0])
    future.storyId = f.events[1].storyId
    future.occurrenceProof!.availableAtUtc = '2026-10-10T00:10:00.001Z'
    f.events.push(future)
    const after = build(f)
    expect(after.subjects).toEqual(before.subjects)
    expect(after.counts.deduplicatedSubjectEventGroups).toBe(2)
    expect(after.unavailableEvents[0].effectiveAvailableAtUtc).toBe(
      future.occurrenceProof!.availableAtUtc,
    )
  })
  it('rejects publication-backed knowledge claimed before its publication clock', () => {
    const f = fixture()
    f.events[0].publishedAtUtc = stamp(1, 1)
    f.events[0].fetchedAtUtc = stamp(8)
    f.events[0].availableAtUtc = stamp(8)
    expect(selectEventConditionedNetScenarios(f)).toBeNull()
  })
  it('gates future publication-backed knowledge using its complete effective availability', () => {
    const f = fixture()
    const future = structuredClone(f.events[0])
    future.publishedAtUtc = '2026-10-10T00:10:00.001Z'
    future.firstKnownAtUtc = future.publishedAtUtc
    future.availableAtUtc = future.publishedAtUtc
    const before = build(f)
    f.events.push(future)
    const after = build(f)
    expect(after.subjects).toEqual(before.subjects)
    expect(after.unavailableEvents[0].effectiveAvailableAtUtc).toBe(future.publishedAtUtc)
  })
  it('requires an explicit reviewed alternative when publication is absent', () => {
    const f = fixture()
    f.events[0].publishedAtUtc = null
    expect(selectEventConditionedNetScenarios(f)).toBeNull()
    f.events[0].knowledgeBasis = 'reviewed_occurrence_without_publication'
    const reviewed = build(f)
    expect(reviewed.subjects[0].matched).toHaveLength(2)
    expect(reviewed.authenticated).toBe(false)
    expect(reviewed.originalAuthority).toBe(false)
    f.events[0].occurrenceProof = null
    expect(selectEventConditionedNetScenarios(f)).toBeNull()
  })
  it('does not use an announcement without publication as independent native occurrence provenance', () => {
    const f = fixture()
    f.events[0].publishedAtUtc = null
    f.events[0].knowledgeBasis = 'reviewed_occurrence_without_publication'
    f.events[0].occurrenceProof!.kind = 'verified_announcement'
    expect(selectEventConditionedNetScenarios(f)).toBeNull()
  })
  it.each(['duplicate_new_ids', 'alias_bridge', 'standalone_late_event'] as const)(
    'donor-start replay metadata and unmatched controls ignore present-visible day8 %s information',
    (kind) => {
      const f = fixture()
      const before = build(f)
      const late =
        kind === 'standalone_late_event'
          ? event(2, 'event:late:standalone')
          : structuredClone(f.events[0])
      late.firstKnownAtUtc = stamp(8)
      late.fetchedAtUtc = stamp(8)
      late.availableAtUtc = stamp(8)
      late.occurrenceProof!.availableAtUtc = stamp(8)
      if (kind === 'duplicate_new_ids') {
        late.eventId = 'event:new:alias'
        late.storyId = 'story:new:alias'
        // Existing duplicateGroupId connects it to day1 only after ingestion.
      } else if (kind === 'alias_bridge') {
        late.storyId = f.events[1].storyId
        late.duplicateGroupId = f.events[1].duplicateGroupId
      }
      f.events.push(late)
      const after = build(f)
      expect(after.subjects).toEqual(before.subjects)
      expect(after.status).toBe(before.status)
      expect(after.reason).toBe(before.reason)
      expect(after.excludedIntervals).toEqual(before.excludedIntervals)
      expect(after.counts.matchedSubjectEventClusters).toBe(
        before.counts.matchedSubjectEventClusters,
      )
      expect(after.subjects[0].comparableUnmatched).toHaveLength(4)
      expect(after.subjects[0].matched[0].eventIds).toEqual(['event:one'])
      expect(after.subjects[0].matched[0].storyIds).toEqual(['story:event:one'])
      expect(after.subjects[0].matched[0].eventKnowledgeAtUtc).toBe(stamp(1))
      expect(after.comparison.catalogueDiagnosticsUsePresentCutoff).toBe(true)
    },
  )
  it.each(['as_of_replay', 'retrospective_training'] as const)(
    'wrong-regime catalogue bridges cannot combine eligible support windows in %s',
    (informationMode) => {
      const f = fixture()
      f.informationMode = informationMode
      const before = build(f)
      for (const day of [1, 2, 3]) {
        const bridge = event(day, 'wrong-regime:bridge:' + String(day))
        bridge.regime = 'fixture:unqualified-regime'
        bridge.occurredAtUtc = stamp(day, 12)
        bridge.firstKnownAtUtc = stamp(day, 12)
        bridge.fetchedAtUtc = stamp(day, 12)
        bridge.availableAtUtc = stamp(day, 12)
        bridge.occurrenceProof!.occurredAtUtc = stamp(day, 12)
        bridge.occurrenceProof!.availableAtUtc = stamp(day, 12)
        f.events.push(bridge)
      }
      const after = build(f)
      expect(after.status).toBe(before.status)
      expect(after.subjects[0].matched).toEqual(before.subjects[0].matched)
      expect(after.subjects[0].counts.matchedEventClusters).toBe(2)
      expect(after.subjects[0].baselineNativeNet).toEqual(before.subjects[0].baselineNativeNet)
      expect(after.assumptions.supportClustersUseOnlyActuallyMatchedEligibleWindows).toBe(true)
    },
  )
  it('catalogue growth cannot shift donor-local numbering or relabel stable matched support', () => {
    const f = fixture()
    const before = build(f)
    const earlier = event(1, 'unsupported:earlier')
    earlier.occurredAtUtc = '2026-09-29T00:00:00.000Z'
    earlier.firstKnownAtUtc = earlier.occurredAtUtc
    earlier.fetchedAtUtc = earlier.occurredAtUtc
    earlier.availableAtUtc = earlier.occurredAtUtc
    earlier.publishedAtUtc = '2026-09-28T00:00:00.000Z'
    earlier.occurrenceProof!.occurredAtUtc = earlier.occurredAtUtc
    earlier.occurrenceProof!.availableAtUtc = earlier.occurredAtUtc
    f.events.push(earlier)
    const after = build(f)
    expect(after.subjects).toEqual(before.subjects)
    expect(after.subjects[0].matched[0].eventClusterIds).toEqual([
      JSON.stringify(['eligible_event_response_window', stamp(1), stamp(2)]),
    ])
    expect(after.subjects[0].matched[1].eventClusterIds).toEqual([
      JSON.stringify(['eligible_event_response_window', stamp(4), stamp(5)]),
    ])
  })
  it('lets later eligible donors bridge current-analysis support without changing early as-of event identity', () => {
    const f = fixture()
    f.parameters.eventResponseWindowSeconds = 3 * 86400
    const before = build(f)
    const lateBridge = event(2, 'event:late:eligible:bridge')
    lateBridge.firstKnownAtUtc = stamp(3)
    lateBridge.fetchedAtUtc = stamp(3)
    lateBridge.availableAtUtc = stamp(3)
    lateBridge.occurrenceProof!.availableAtUtc = stamp(3)
    f.events.push(lateBridge)
    const after = build(f)
    const earliestBefore = before.subjects[0].matched.find((rate) => rate.fromIndex === 0)!
    const earliestAfter = after.subjects[0].matched.find((rate) => rate.fromIndex === 0)!
    const expandedCluster = JSON.stringify(['eligible_event_response_window', stamp(1), stamp(7)])
    expect(before.subjects[0].counts.matchedEventClusters).toBe(2)
    expect(earliestBefore.eventClusterIds).toEqual([
      JSON.stringify(['eligible_event_response_window', stamp(1), stamp(4)]),
    ])
    // Current cohort correlation changes. The donor's as-of identity, clocks,
    // endpoint arithmetic and matched membership remain the same.
    expect(earliestAfter).toEqual({ ...earliestBefore, eventClusterIds: [expandedCluster] })
    expect(after.subjects[0].counts.matchedIntervals).toBe(
      before.subjects[0].counts.matchedIntervals,
    )
    expect(
      after.subjects[0].matched.every(
        (rate) => rate.eventClusterIds.length === 1 && rate.eventClusterIds[0] === expandedCluster,
      ),
    ).toBe(true)
    expect(after.subjects[0].counts.matchedEventClusters).toBe(1)
    expect(after.subjects[0].reason).toBe('insufficient_distinct_event_clusters')
    expect(after.comparison.supportClusterMembershipUsesCurrentAnalysisCohort).toBe(true)
    expect(after.comparison.independentSampleCount).toBeNull()
  })
  it('permits late reviewed past occurrence only in retrospective training', () => {
    const f = fixture()
    delayFirstEvent(f)
    expect(build(f).subjects[0].matched).toHaveLength(1)
    f.informationMode = 'retrospective_training'
    const r = build(f)
    expect(r.status).toBe('event_associated_net_scenarios')
    expect(r.retrospectiveInformation).toBe(true)
    expect(r.subjects[0].matched[0].eventKnownByHistoricalStart).toBe(false)
    expect(r.subjects[0].matched[0].eventKnowledgeAtUtc).toBe(stamp(8))
    expect(r.assumptions.retrospectiveTrainingIsHistoricalForecastReplay).toBe(false)
    expect(r.prospectiveValidated).toBe(false)
  })
  it('keeps baselines when late occurrence has no independent review descriptor', () => {
    const f = fixture()
    delayFirstEvent(f)
    f.informationMode = 'retrospective_training'
    f.events[0].occurrenceProof = null
    const r = build(f)
    expect(r.status).toBe('insufficient_event_matches')
    expect(r.subjects[0].reason).toBe('insufficient_matched_intervals')
    expect(r.subjects[0].baselineNativeNet).toHaveLength(6)
    expect(r.excludedEvents).toContainEqual(
      expect.objectContaining({
        eventIds: ['event:one'],
        reason: 'reviewed_occurrence_proof_unavailable',
      }),
    )
  })
  it.each(['as_of_replay', 'retrospective_training'] as const)(
    'excludes event evidence available after present cutoff in %s',
    (informationMode) => {
      const f = fixture()
      f.informationMode = informationMode
      f.events[0].fetchedAtUtc = '2026-10-10T00:10:00.001Z'
      f.events[0].availableAtUtc = f.events[0].fetchedAtUtc
      const r = build(f)
      expect(r.subjects[0].matched).toHaveLength(1)
      expect(r.unavailableEvents).toContainEqual(
        expect.objectContaining({
          eventId: 'event:one',
          reason: 'event_not_available_at_knowledge_cutoff',
        }),
      )
      expect(r.subjects[0].baselineNativeNet).toHaveLength(6)
    },
  )
  it('does not substitute fetched time for the later supplied first-known clock', () => {
    const f = fixture()
    f.events[0].firstKnownAtUtc = stamp(1, 1)
    // availableAt cannot contradict the later evidence clock.
    expect(selectEventConditionedNetScenarios(f)).toBeNull()
  })
  it('rejects a scheduled future occurrence as a realized-effect donor', () => {
    const f = fixture()
    const future = event(11, 'future')
    future.kind = 'scheduled'
    future.firstKnownAtUtc = stamp(1)
    future.publishedAtUtc = '2026-09-30T00:00:00.000Z'
    future.fetchedAtUtc = stamp(8)
    future.availableAtUtc = stamp(8)
    future.occurrenceProof = null
    f.events = [future]
    const r = build(f)
    expect(r.subjects[0].matched).toHaveLength(0)
    expect(r.excludedEvents[0].reason).toBe('unrealized_scheduled_event')
    expect(r.subjects[0].baselineNativeNet).toHaveLength(6)
  })
  it('allows an occurred scheduled event with a reviewed realization proof', () => {
    const f = fixture()
    f.events[0].kind = 'scheduled'
    f.events[0].firstKnownAtUtc = '2026-09-30T23:00:00.000Z'
    f.events[0].fetchedAtUtc = f.events[0].firstKnownAtUtc
    f.events[0].availableAtUtc = f.events[0].firstKnownAtUtc
    expect(build(f).status).toBe('event_associated_net_scenarios')
  })
  it.each(['as_of_replay', 'retrospective_training'] as const)(
    'does not train on history ingested after present cutoff in %s',
    (informationMode) => {
      const f = fixture()
      f.informationMode = informationMode
      for (const p of f.histories[0].points) p.availableAtUtc = '2026-10-10T00:10:00.001Z'
      const r = build(f)
      expect(r.subjects[0].baselineNativeNet).toHaveLength(0)
      expect(r.subjects[0].reason).toBe('no_eligible_native_intervals')
      expect(r.excludedIntervals).toHaveLength(6)
      expect(
        r.excludedIntervals.every((p) => p.reason === 'history_not_available_at_knowledge_cutoff'),
      ).toBe(true)
    },
  )
  it('preserves original availability instead of retiming offline observations to source', () => {
    const r = build()
    expect(r.subjects[0].matched[0].fromAtUtc).toBe(stamp(1))
    expect(r.subjects[0].matched[0].availableAtUtc).toBe(stamp(8))
    expect(r.authenticated).toBe(false)
    expect(r.originalAuthority).toBe(false)
  })
  it('requires outcome source time and block strictly before current source', () => {
    const f = fixture()
    f.target.source.sourceAtUtc = stamp(7)
    f.target.source.block = '700'
    f.target.source.availableAtUtc = stamp(8)
    const r = build(f)
    expect(r.subjects[0].counts.baselineEligibleIntervals).toBe(5)
    expect(r.excludedIntervals).toContainEqual(
      expect.objectContaining({
        fromIndex: 5,
        toIndex: 6,
        reason: 'historical_outcome_not_before_current_source',
      }),
    )
  })
  it('cannot treat a skipped grid point as a full comparable interval', () => {
    const f = fixture()
    f.histories[0].points.slice(2).forEach((p) => p.index++)
    const r = build(f)
    expect(r.subjects[0].baselineNativeNet).toHaveLength(5)
    expect(r.excludedIntervals[0].reason).toBe('nonconsecutive_observations')
  })
  it('excludes cash endpoints from a different regime without transplanting target policy', () => {
    const f = fixture()
    f.histories[0].points[1].regime = 'fixture:old-policy'
    const r = build(f)
    expect(r.subjects[0].baselineNativeNet).toHaveLength(4)
    expect(r.subjects[0].matched).toHaveLength(1)
    expect(r.excludedIntervals.every((p) => p.reason === 'native_regime_mismatch')).toBe(true)
  })
  it.each(['destination', 'asset', 'assetDecimals', 'routeKey'] as const)(
    'excludes a history with different %s from exact scope',
    (field) => {
      const f = fixture()
      if (field === 'assetDecimals') f.histories[0].subject[field] = 18
      else if (field === 'routeKey') f.histories[0].subject[field] = 'Other reviewed route'
      else f.histories[0].subject[field] = '0x' + 'b'.repeat(40)
      const r = build(f)
      expect(r.subjects[0].reason).toBe('no_eligible_native_intervals')
      expect(r.subjects[0].baselineNativeNet).toHaveLength(0)
      expect(r.excludedHistories[0].reason).toBe('subject_outside_declared_scope')
    },
  )
  it('rejects foreign event subject/asset/regime associations but preserves exact native baseline', () => {
    const f = fixture()
    f.events[0].subject.asset = '0x' + 'b'.repeat(40)
    f.events[1].regime = 'fixture:wrong-policy'
    const r = build(f)
    expect(r.subjects[0].matched).toHaveLength(0)
    expect(r.subjects[0].baselineNativeNet).toHaveLength(6)
    expect(r.excludedEvents.map((e) => e.reason).sort()).toEqual([
      'event_regime_mismatch',
      'subject_outside_declared_scope',
    ])
  })
  it('requires explicitly reviewed taxonomy rather than guessing from a story', () => {
    const f = fixture()
    f.events[0].taxonomy.eventType = 'different_reviewed_event'
    const r = build(f)
    expect(r.subjects[0].matched).toHaveLength(1)
    expect(r.excludedEvents[0].reason).toBe('taxonomy_mismatch')
  })
  it('deduplicates repeated event IDs, news IDs and review-supplied syndication groups', () => {
    const f = fixture()
    const repeated = structuredClone(f.events[0])
    repeated.eventId = 'syndicated:event:one'
    repeated.storyId = 'syndicated:story:one'
    // The retained duplicate group explicitly links this story to the first.
    f.events.push(repeated)
    const r = build(f)
    expect(r.counts.eventRows).toBe(3)
    expect(r.counts.deduplicatedSubjectEventGroups).toBe(2)
    expect(r.counts.duplicateEventSubjectRows).toBe(1)
    expect(r.subjects[0].counts.matchedIntervals).toBe(2)
    expect(r.subjects[0].counts.matchedEventClusters).toBe(2)
    expect(r.subjects[0].matched[0].eventIds).toEqual(['event:one', 'syndicated:event:one'])
    const repeatedStory = structuredClone(f.events[0])
    repeatedStory.eventId = 'different:id:same:story'
    repeatedStory.duplicateGroupId = 'different:group'
    f.events.push(repeatedStory)
    expect(build(f).counts.deduplicatedSubjectEventGroups).toBe(2)
  })
  it('does not turn overlapping distinct events into independent support or duplicate intervals', () => {
    const f = fixture()
    const overlapping = event(1, 'event:overlapping')
    f.events = [f.events[0], overlapping]
    f.parameters.minimumMatchedIntervals = 1
    const r = build(f)
    expect(r.subjects[0].matched).toHaveLength(1)
    expect(r.subjects[0].matched[0].eventIds).toEqual(['event:one', 'event:overlapping'])
    expect(r.subjects[0].counts.matchedEventClusters).toBe(1)
    expect(r.subjects[0].reason).toBe('insufficient_distinct_event_clusters')
    expect(r.comparison.independentSampleCount).toBeNull()
  })
  it('does not join contradictory occurrence times under one repeated story/event identity when both are known', () => {
    const f = fixture()
    f.informationMode = 'retrospective_training'
    const conflicting = structuredClone(f.events[0])
    conflicting.occurredAtUtc = stamp(1, 1)
    conflicting.firstKnownAtUtc = stamp(1, 1)
    conflicting.fetchedAtUtc = stamp(1, 1)
    conflicting.availableAtUtc = stamp(1, 1)
    conflicting.occurrenceProof!.occurredAtUtc = stamp(1, 1)
    conflicting.occurrenceProof!.availableAtUtc = stamp(1, 1)
    f.events.push(conflicting)
    const r = build(f)
    expect(r.subjects[0].matched).toHaveLength(1)
    expect(r.excludedEvents[0].reason).toBe('conflicting_event_identity')
    expect(r.subjects[0].baselineNativeNet).toHaveLength(6)
  })
  it('joins a native occurrence to the historical start block and rejects a future block or different same-height hash', () => {
    const f = fixture()
    f.events[0].occurrenceProof = {
      ...f.events[0].occurrenceProof!,
      kind: 'native_block',
      block: '100',
      blockHash: f.histories[0].points[0].blockHash,
    }
    expect(build(f).subjects[0].matched).toHaveLength(2)
    f.informationMode = 'retrospective_training'
    f.events[0].occurrenceProof.block = '101'
    expect(build(f).subjects[0].matched).toHaveLength(1)
    f.events[0].occurrenceProof.block = '100'
    f.events[0].occurrenceProof.blockHash = '0x' + 'f'.repeat(64)
    const rejected = build(f)
    expect(rejected.subjects[0].matched).toHaveLength(1)
    expect(rejected.subjects[0].baselineNativeNet).toHaveLength(6)
  })
  it.each([
    ['2026-09-30T23:00:00.000Z', 2 * 86400],
    ['2025-10-02T00:00:00.000Z', 365 * 86400],
  ] as const)(
    'rejects same-height/hash native occurrence with contradictory timestamp %s',
    (occurredAtUtc, window) => {
      const f = fixture()
      const e = f.events[0]
      e.occurredAtUtc = occurredAtUtc
      e.firstKnownAtUtc = occurredAtUtc
      e.fetchedAtUtc = occurredAtUtc
      e.availableAtUtc = occurredAtUtc
      e.publishedAtUtc = null
      e.knowledgeBasis = 'reviewed_occurrence_without_publication'
      e.occurrenceProof = {
        ...e.occurrenceProof!,
        kind: 'native_block',
        occurredAtUtc,
        availableAtUtc: occurredAtUtc,
        block: f.histories[0].points[0].block,
        blockHash: f.histories[0].points[0].blockHash,
      }
      f.events = [e]
      f.parameters.lookbackSeconds = 400 * 86400
      f.parameters.eventResponseWindowSeconds = window
      f.parameters.minimumMatchedIntervals = 1
      f.parameters.minimumEventClusters = 1
      const r = build(f)
      expect(r.subjects[0].matched).toHaveLength(0)
      expect(r.subjects[0].baselineNativeNet).toHaveLength(6)
      expect(r.authenticated).toBe(false)
      expect(r.assumptions.olderNativeOccurrenceRequiresExternalAdapter).toBe(true)
    },
  )
  it('keeps older native blocks unsigned and explicitly requires an external native adapter before qualification', () => {
    const f = fixture()
    f.events[0].publishedAtUtc = null
    f.events[0].knowledgeBasis = 'reviewed_occurrence_without_publication'
    f.events[0].occurrenceProof = {
      ...f.events[0].occurrenceProof!,
      kind: 'native_block',
      block: '99',
      blockHash: '0x' + 'c'.repeat(64),
    }
    const r = build(f)
    expect(r.subjects[0].matched).toHaveLength(2)
    expect(r.assumptions.olderNativeOccurrenceRequiresExternalAdapter).toBe(true)
    expect(r.authenticated).toBe(false)
    expect(r.originalAuthority).toBe(false)
  })
  it('does not manufacture a partial-window NET effect from an interval straddling occurrence', () => {
    const f = fixture()
    const e = f.events[0]
    for (const k of ['occurredAtUtc', 'firstKnownAtUtc', 'fetchedAtUtc', 'availableAtUtc'] as const)
      e[k] = stamp(1, 1)
    e.occurrenceProof!.occurredAtUtc = e.occurredAtUtc
    e.occurrenceProof!.availableAtUtc = e.occurredAtUtc
    const r = build(f)
    expect(r.subjects[0].matched).toHaveLength(1)
    expect(r.subjects[0].baselineNativeNet).toHaveLength(6)
    expect(
      r.excludedIntervals.some(
        (p) => p.reason === 'overlapping_event_window_without_eligible_match',
      ),
    ).toBe(true)
  })
  it('derives signed NET once with exact BigInt raw native amounts', () => {
    const f = fixture()
    const amounts = [
      '9007199254741993',
      '9007199254741892',
      '9007199254741994',
      '9007199254741990',
      '9007199254741889',
      '9007199254741991',
      '9007199254741991',
    ]
    f.histories[0].points.forEach((p, i) => {
      p.cashRaw = amounts[i]
    })
    const r = build(f)
    expect(r.subjects[0].matched.map((s) => s.netDeltaRaw)).toEqual(['-101', '-101'])
    expect(r.subjects[0].matched[0].rate).toEqual({ numeratorRaw: '-101', denominatorMs: 86400000 })
    expect(r.assumptions.netDerivedOnlyFromEndpointDifference).toBe(true)
    expect(r.assumptions.grossWithdrawalsDeductedAgain).toBe(false)
    expect(r.competingMRaw).toBeNull()
    expect(r.protocolMaximumGrossOutflowRaw).toBeNull()
  })
  it('ranks exact signed rates by actual donor duration rather than raw amount or floating point', () => {
    const f = fixture()
    f.events = []
    f.parameters.minimumIntervalSeconds = 12 * 3600
    f.histories[0].points = [
      { ...f.histories[0].points[0], cashRaw: '10' },
      { ...f.histories[0].points[1], cashRaw: '9' },
      { ...f.histories[0].points[2], sourceAtUtc: stamp(2, 12), cashRaw: '8' },
    ]
    const rates = build(f).subjects[0].baselineNativeNet
    expect(rates.map((s) => s.fromIndex)).toEqual([1, 0])
    expect(rates.map((s) => s.rate.denominatorMs)).toEqual([43200000, 86400000])
  })
  it('keeps each explicit analog donor in its own asset units without transferring raw values', () => {
    const f = fixture()
    const link: EventNetSubject = {
      ...USDC,
      routeKey: 'LINK reviewed analogy',
      destination: '0x' + 'b'.repeat(40),
      asset: '0x514910771af9ca656af840dff83e8264ecf986ca',
      assetDecimals: 18,
    }
    f.scope = {
      kind: 'reviewed_analog',
      reviewRef: 'fixture:explicit-cohort',
      subjects: [{ subject: link, regime: 'fixture:link-policy' }],
    }
    f.histories[0].subject = link
    f.histories[0].points.forEach((p) => {
      p.regime = 'fixture:link-policy'
    })
    f.events.forEach((e) => {
      e.subject = link
      e.regime = 'fixture:link-policy'
    })
    const r = build(f)
    expect(r.scope.kind).toBe('reviewed_analog')
    expect(r.subjects[0].matched[0].subject.assetDecimals).toBe(18)
    expect(r.subjects[0].matched[0].netDeltaRaw).toBe('-100')
    expect(r.subjects[0].matched[0].application).toBe(
      'donor_native_units_only_no_target_amount_transfer',
    )
    expect(r.target.subject.asset).toBe(USDC.asset)
    expect(r.assumptions.rawAmountsPooledAcrossAssets).toBe(false)
  })
  it('labels cross-subject event support as correlated instead of pooling raw units or independent samples', () => {
    const f = fixture()
    const other: EventNetSubject = {
      ...USDC,
      routeKey: 'LINK reviewed analogy',
      destination: '0x' + 'b'.repeat(40),
      asset: '0x514910771af9ca656af840dff83e8264ecf986ca',
      assetDecimals: 18,
    }
    f.scope = {
      kind: 'reviewed_analog',
      reviewRef: 'fixture:explicit-cohort',
      subjects: [
        { subject: { ...USDC }, regime: f.target.regime },
        { subject: other, regime: f.target.regime },
      ],
    }
    f.histories.push({ subject: other, points: structuredClone(f.histories[0].points) })
    const samePhysicalEvents = f.events.map((e) => ({ ...structuredClone(e), subject: other }))
    f.events.push(...samePhysicalEvents)
    const r = build(f)
    expect(r.subjects.map((s) => s.counts.matchedEventClusters)).toEqual([2, 2])
    expect(r.counts.matchedSubjectEventClusters).toBe(4)
    expect(r.comparison.supportCountsAreCorrelatedSubjectIntervals).toBe(true)
    expect(r.comparison.independentSampleCount).toBeNull()
    expect(r.subjects[0].matched[0].application).toBe('replace_target_native_NET')
    expect(r.subjects[1].matched[0].application).toBe(
      'donor_native_units_only_no_target_amount_transfer',
    )
  })
  it('declares rate-selection truncation without calling the support an empirical confidence interval', () => {
    const f = fixture()
    f.parameters.maximumScenariosPerSubject = 1
    const r = build(f)
    expect(r.subjects[0].selectionTruncated).toBe(true)
    expect(r.subjects[0].counts.matchedIntervals).toBe(2)
    expect(r.subjects[0].counts.selectedMatched).toBe(1)
    expect(r.probabilityUncalibrated).toBe(true)
    expect(r.calibrated).toBe(false)
  })
  it('does not apply horizon/source age/Q/exposure or grant native holder authority', () => {
    const a = build()
    const f = fixture()
    f.parameters.horizonSeconds = 3 * 3600
    const b = build(f)
    expect(b.subjects).toEqual(a.subjects)
    expect(b.requestedTargetAtUtc).toBe('2026-10-10T03:10:00.000Z')
    expect(b.assumptions.sourceAgeAppliedHere).toBe(false)
    expect(b.assumptions.exposureOrQAppliedHere).toBe(false)
    expect(b.assumptions.horizonExtrapolatedHere).toBe(false)
    expect(b.causal).toBe(false)
    expect(b.holderExitForecast).toBe(false)
    expect(b.holderExecutableExit).toBe(false)
    expect(b.minedPayout).toBe(false)
    expect(b.coverage.fullPeriodFlowCoverage).toBe(false)
    expect(b.coverage.completeEventCatalogue).toBe(false)
  })
  it('rejects duplicate history series/points instead of counting their intervals twice', () => {
    const f = fixture()
    f.histories.push(structuredClone(f.histories[0]))
    expect(selectEventConditionedNetScenarios(f)).toBeNull()
    const g = fixture()
    g.histories[0].points.splice(1, 0, structuredClone(g.histories[0].points[0]))
    expect(selectEventConditionedNetScenarios(g)).toBeNull()
  })
  it('rejects getters at envelope, event and endpoint levels without invoking them', () => {
    for (const level of ['envelope', 'event', 'point'] as const) {
      const f = fixture()
      let calls = 0
      const obj =
        level === 'envelope' ? f : level === 'event' ? f.events[0] : f.histories[0].points[0]
      const key =
        level === 'envelope'
          ? 'knowledgeCutoffUtc'
          : level === 'event'
            ? 'firstKnownAtUtc'
            : 'cashRaw'
      Object.defineProperty(obj, key, {
        enumerable: true,
        get() {
          calls++
          throw Error('must not execute')
        },
      })
      expect(selectEventConditionedNetScenarios(f)).toBeNull()
      expect(calls).toBe(0)
    }
  })
  it('rejects cycles, nonplain prototypes and sparse arrays but accepts shared plain aliases', () => {
    const cycle = fixture()
    ;(cycle.target as unknown as Record<string, unknown>).cycle = cycle
    expect(selectEventConditionedNetScenarios(cycle)).toBeNull()
    const proto = fixture()
    Object.setPrototypeOf(proto.events[0], { inherited: 'not plain' })
    expect(selectEventConditionedNetScenarios(proto)).toBeNull()
    const sparse = fixture()
    delete sparse.events[0]
    expect(selectEventConditionedNetScenarios(sparse)).toBeNull()
    const alias = fixture()
    alias.histories[0].subject = alias.target.subject
    alias.events.forEach((e) => {
      e.subject = alias.target.subject
    })
    expect(build(alias).status).toBe('event_associated_net_scenarios')
  })
  it('makes frozen detached output whose JSON copy remains unsigned', () => {
    const f = fixture()
    const r = build(f)
    f.histories[0].points[0].cashRaw = '99999'
    f.events[0].eventId = 'mutated'
    expect(r.subjects[0].matched[0].startCashRaw).toBe('1000')
    expect(r.subjects[0].matched[0].eventIds).toEqual(['event:one'])
    expect(Object.isFrozen(r.subjects[0].matched[0].rate)).toBe(true)
    const cloned = JSON.parse(JSON.stringify(r))
    expect(cloned.authenticated).toBe(false)
    expect(cloned.originalAuthority).toBe(false)
  })
  it('bounds time settings, event/point counts and rejects unreviewed extra input fields', () => {
    const time = fixture()
    time.parameters.maximumGapSeconds = time.parameters.minimumIntervalSeconds - 1
    expect(selectEventConditionedNetScenarios(time)).toBeNull()
    const count = fixture()
    count.events = Array.from({ length: 2049 }, () => count.events[0])
    expect(selectEventConditionedNetScenarios(count)).toBeNull()
    const exposure = fixture()
    ;(exposure as unknown as Record<string, unknown>).requestedRaw = '100'
    expect(selectEventConditionedNetScenarios(exposure)).toBeNull()
    const negative = fixture()
    negative.histories[0].points[0].cashRaw = '-1'
    expect(selectEventConditionedNetScenarios(negative)).toBeNull()
  })
})
