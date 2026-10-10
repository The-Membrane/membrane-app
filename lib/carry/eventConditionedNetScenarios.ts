/** Pure, unsigned EVENT-ASSOCIATED NET donors. Review/retention adapters supply
 * identities, regimes and occurrence evidence. This module authenticates none.
 * The selected rate REPLACES a NET assumption. It is never an extra withdrawal,
 * news shock, competing-flow deduction or user-sized exit forecast. */
export type EventNetSubject = {
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
}
export type EventNetObservation = {
  index: number
  block: string
  blockHash: string
  sourceAtUtc: string
  availableAtUtc: string
  regime: string
  cashRaw: string
  provenanceRef: string
}
export type EventNetOccurrenceProof = {
  kind: 'native_block' | 'official_effective' | 'verified_announcement'
  occurredAtUtc: string
  availableAtUtc: string
  sourceRef: string
  reviewRef: string
  block: string | null
  blockHash: string | null
}
export type ReviewedNetEvent = {
  subject: EventNetSubject
  regime: string
  taxonomy: { namespace: string; eventType: string; reviewRef: string }
  eventId: string
  storyId: string
  duplicateGroupId: string
  knowledgeBasis: 'publication_backed' | 'reviewed_occurrence_without_publication'
  kind: 'official_observed' | 'scheduled'
  occurredAtUtc: string
  firstKnownAtUtc: string
  fetchedAtUtc: string
  availableAtUtc: string
  publishedAtUtc: string | null
  occurrenceProof: EventNetOccurrenceProof | null
}
export type EventConditionedNetInput = {
  informationMode: 'as_of_replay' | 'retrospective_training'
  target: {
    subject: EventNetSubject
    regime: string
    source: {
      block: string
      blockHash: string
      sourceAtUtc: string
      availableAtUtc: string
    }
  }
  knowledgeCutoffUtc: string
  taxonomy: { namespace: string; eventType: string; reviewRef: string }
  scope:
    | { kind: 'exact_subject' }
    | {
        kind: 'reviewed_analog'
        reviewRef: string
        subjects: { subject: EventNetSubject; regime: string }[]
      }
  parameters: {
    lookbackSeconds: number
    eventResponseWindowSeconds: number
    minimumIntervalSeconds: number
    maximumGapSeconds: number
    horizonSeconds: number
    minimumMatchedIntervals: number
    minimumEventClusters: number
    maximumScenariosPerSubject: number
  }
  histories: { subject: EventNetSubject; points: EventNetObservation[] }[]
  events: ReviewedNetEvent[]
}
export type EventAssociatedNetRate = {
  subject: EventNetSubject
  regime: string
  fromIndex: number
  toIndex: number
  fromBlock: string
  toBlock: string
  fromBlockHash: string
  toBlockHash: string
  fromAtUtc: string
  toAtUtc: string
  availableAtUtc: string
  provenanceRefs: [string, string]
  startCashRaw: string
  endCashRaw: string
  netDeltaRaw: string
  rate: { numeratorRaw: string; denominatorMs: number }
  eventIds: string[]
  storyIds: string[]
  /** Current-analysis correlation membership may expand with later eligible donors.
   * Event identities and knowledge clocks remain local to each donor-start catalogue. */
  eventClusterIds: string[]
  eventKnowledgeAtUtc: string | null
  eventKnownByHistoricalStart: boolean | null
  application: 'replace_target_native_NET' | 'donor_native_units_only_no_target_amount_transfer'
}
export type EventNetSubjectScenarios = {
  subject: EventNetSubject
  regime: string
  status: 'event_associated_net_scenarios' | 'insufficient_event_matches'
  reason:
    | null
    | 'no_eligible_native_intervals'
    | 'insufficient_matched_intervals'
    | 'insufficient_distinct_event_clusters'
  matched: EventAssociatedNetRate[]
  comparableUnmatched: EventAssociatedNetRate[]
  baselineNativeNet: EventAssociatedNetRate[]
  persistence: { netDeltaRaw: '0'; denominatorMs: 1000 }
  counts: {
    candidateIntervals: number
    baselineEligibleIntervals: number
    matchedIntervals: number
    comparableUnmatchedIntervals: number
    matchedEventClusters: number
    baselineRejectedIntervals: number
    eventOverlapExcludedFromUnmatched: number
    selectedMatched: number
    selectedUnmatched: number
    selectedBaseline: number
  }
  selectionTruncated: boolean
}
export type EventConditionedNetSelection = {
  schema: 'event_conditioned_net_scenarios_v1'
  status: 'event_associated_net_scenarios' | 'insufficient_event_matches'
  reason: null | 'no_subject_has_sufficient_event_matches'
  informationMode: EventConditionedNetInput['informationMode']
  retrospectiveInformation: boolean
  target: EventConditionedNetInput['target']
  knowledgeCutoffUtc: string
  requestedTargetAtUtc: string
  taxonomy: EventConditionedNetInput['taxonomy']
  scope: EventConditionedNetInput['scope']
  parameters: EventConditionedNetInput['parameters']
  subjects: EventNetSubjectScenarios[]
  counts: {
    eventRows: number
    availableEventRows: number
    unavailableEventRows: number
    deduplicatedSubjectEventGroups: number
    duplicateEventSubjectRows: number
    excludedSubjectEventGroups: number
    candidateIntervals: number
    baselineEligibleIntervals: number
    matchedIntervals: number
    comparableUnmatchedIntervals: number
    matchedSubjectEventClusters: number
    excludedIntervals: number
  }
  unavailableEvents: {
    subject: EventNetSubject
    eventId: string
    storyId: string
    duplicateGroupId: string
    effectiveAvailableAtUtc: string
    reason: 'event_not_available_at_knowledge_cutoff'
  }[]
  excludedEvents: { eventIds: string[]; subject: EventNetSubject; reason: string }[]
  excludedIntervals: {
    subject: EventNetSubject
    fromIndex: number
    toIndex: number
    reason: string
    retainedInNativeBaseline: boolean
  }[]
  excludedHistories: { subject: EventNetSubject; reason: 'subject_outside_declared_scope' }[]
  comparison: {
    method: 'same_subject_regime_declared_duration_bounds'
    unmatchedMeans: 'no_overlapping_requested_taxonomy_event_in_information_mode_catalogue'
    unrelatedEventsControlled: false
    independentSampleCount: null
    supportCountsAreCorrelatedSubjectIntervals: true
    catalogueDiagnosticsUsePresentCutoff: true
    supportClusterMembershipUsesCurrentAnalysisCohort: true
  }
  coverage: {
    endpointNetArithmeticComplete: true
    fullPeriodFlowCoverage: false
    continuousCapacityKnown: false
    completeEventCatalogue: false
    completeLookbackHistory: false
  }
  assumptions: {
    selection: 'lowest_signed_native_NET_rates_per_subject'
    netDerivedOnlyFromEndpointDifference: true
    replacesNETScenario: true
    grossWithdrawalsDeductedAgain: false
    sourceAgeAppliedHere: false
    horizonExtrapolatedHere: false
    exposureOrQAppliedHere: false
    rawAmountsPooledAcrossAssets: false
    overlappingSupportTreatedAsIndependent: false
    retrospectiveTrainingIsHistoricalForecastReplay: false
    olderNativeOccurrenceRequiresExternalAdapter: true
    asOfCatalogueFilteredAtDonorStartBeforeGrouping: true
    supportClustersUseOnlyActuallyMatchedEligibleWindows: true
  }
  protocolMaximumGrossOutflowRaw: null
  competingMRaw: null
  causal: false
  probabilityUncalibrated: true
  calibrated: false
  authenticated: false
  originalAuthority: false
  forecastValidated: false
  prospectiveValidated: false
  holderExitForecast: false
  holderExecutableExit: false
  minedPayout: false
}

const MAX = (1n << 256n) - 1n
const LIMITS = {
  subjects: 68,
  pointsPerSubject: 512,
  totalPoints: 8192,
  events: 2048,
  selectedPerSubject: 128,
  depth: 16,
  nodes: 200000,
  stringBytes: 8 * 1024 * 1024,
} as const
const check = (v: unknown): void => {
  if (!v) throw Error('event_conditioned_net_input_invalid')
}
const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, maximum = 256): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= maximum
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 24 &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[a-f0-9]{64}$/.test(v)
const integer = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi
function keys(v: unknown, expected: string[]): void {
  check(plain(v) && Object.keys(v).sort().join(',') === [...expected].sort().join(','))
}
function subject(v: unknown): v is EventNetSubject {
  keys(v, ['routeKey', 'destination', 'asset', 'assetDecimals'])
  const s = v as EventNetSubject
  return (
    text(s.routeKey) &&
    /^0x[a-f0-9]{40}$/.test(s.destination) &&
    /^0x[a-f0-9]{40}$/.test(s.asset) &&
    integer(s.assetDecimals, 0, 36)
  )
}
const subjectKey = (s: EventNetSubject) =>
  JSON.stringify([s.routeKey, s.destination, s.asset, s.assetDecimals])
const sameTaxonomy = (
  a: EventConditionedNetInput['taxonomy'],
  b: EventConditionedNetInput['taxonomy'],
) => a.namespace === b.namespace && a.eventType === b.eventType
function taxonomy(v: EventConditionedNetInput['taxonomy']): void {
  keys(v, ['namespace', 'eventType', 'reviewRef'])
  check(text(v.namespace, 128) && text(v.eventType, 128) && text(v.reviewRef))
}
/** Descriptor copy precedes every field read. No getters, prototypes, cycles,
 * sparse arrays or unknown properties acquire authority. Shared plain aliases
 * are copied normally rather than mistaken for cycles. */
function snapshot(value: unknown): unknown {
  let nodes = 0,
    bytes = 0
  const ancestry = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= LIMITS.nodes && depth <= LIMITS.depth)
    if (typeof v === 'string') {
      bytes += v.length * 2
      check(bytes <= LIMITS.stringBytes)
      return v
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v)))
      return v
    check(v !== null && typeof v === 'object')
    const obj = v as object
    const array = Array.isArray(obj)
    check(
      !ancestry.has(obj) &&
        (array
          ? Object.getPrototypeOf(obj) === Array.prototype
          : Object.getPrototypeOf(obj) === Object.prototype || Object.getPrototypeOf(obj) === null),
    )
    ancestry.add(obj)
    const descriptors = Object.getOwnPropertyDescriptors(obj)
    const ownKeys = Reflect.ownKeys(descriptors)
    check(ownKeys.every((k) => typeof k === 'string' && k.length <= 128))
    const length = array ? descriptors.length?.value : 0
    check(
      array
        ? integer(length, 0, LIMITS.totalPoints) && ownKeys.length === length + 1
        : ownKeys.length <= 128,
    )
    const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null)
    for (const k of ownKeys as string[]) {
      if (array && k === 'length') continue
      const d = descriptors[k]
      check(
        d.enumerable &&
          Object.hasOwn(d, 'value') &&
          k !== '__proto__' &&
          k !== 'constructor' &&
          k !== 'prototype' &&
          (!array || (/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < length)),
      )
      bytes += k.length * 2
      check(bytes <= LIMITS.stringBytes)
      ;(out as Record<string, unknown>)[k] = copy(d.value, depth + 1)
    }
    if (array) {
      const a = out as unknown[]
      check(
        a.length === length && Array.from({ length }, (_, i) => Object.hasOwn(a, i)).every(Boolean),
      )
    }
    ancestry.delete(obj)
    return out
  }
  return copy(value, 0)
}
function freeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function validate(input: EventConditionedNetInput): void {
  keys(input, [
    'informationMode',
    'target',
    'knowledgeCutoffUtc',
    'taxonomy',
    'scope',
    'parameters',
    'histories',
    'events',
  ])
  check(['as_of_replay', 'retrospective_training'].includes(input.informationMode))
  keys(input.target, ['subject', 'regime', 'source'])
  check(subject(input.target.subject) && text(input.target.regime))
  keys(input.target.source, ['block', 'blockHash', 'sourceAtUtc', 'availableAtUtc'])
  const current = input.target.source
  check(raw(current.block) && BigInt(current.block) > 0n && hash(current.blockHash))
  check(utc(current.sourceAtUtc) && utc(current.availableAtUtc) && utc(input.knowledgeCutoffUtc))
  check(
    Date.parse(current.sourceAtUtc) <= Date.parse(current.availableAtUtc) &&
      Date.parse(current.availableAtUtc) <= Date.parse(input.knowledgeCutoffUtc),
  )
  taxonomy(input.taxonomy)
  if (input.scope.kind === 'exact_subject') keys(input.scope, ['kind'])
  else {
    keys(input.scope, ['kind', 'reviewRef', 'subjects'])
    check(input.scope.kind === 'reviewed_analog' && text(input.scope.reviewRef))
    check(
      Array.isArray(input.scope.subjects) &&
        integer(input.scope.subjects.length, 1, LIMITS.subjects),
    )
    const seen = new Set<string>()
    for (const entry of input.scope.subjects) {
      keys(entry, ['subject', 'regime'])
      check(subject(entry.subject) && text(entry.regime) && !seen.has(subjectKey(entry.subject)))
      seen.add(subjectKey(entry.subject))
    }
  }
  const p = input.parameters
  keys(p, [
    'lookbackSeconds',
    'eventResponseWindowSeconds',
    'minimumIntervalSeconds',
    'maximumGapSeconds',
    'horizonSeconds',
    'minimumMatchedIntervals',
    'minimumEventClusters',
    'maximumScenariosPerSubject',
  ])
  check(
    integer(p.lookbackSeconds, 1, 315576000) &&
      integer(p.eventResponseWindowSeconds, 1, Math.min(p.lookbackSeconds, 31536000)) &&
      integer(p.minimumIntervalSeconds, 1, 31536000) &&
      integer(p.maximumGapSeconds, p.minimumIntervalSeconds, 31536000) &&
      integer(p.horizonSeconds, 1, 31536000) &&
      integer(p.minimumMatchedIntervals, 1, LIMITS.selectedPerSubject) &&
      integer(p.minimumEventClusters, 1, LIMITS.selectedPerSubject) &&
      integer(p.maximumScenariosPerSubject, 1, LIMITS.selectedPerSubject),
  )
  check(utc(new Date(Date.parse(input.knowledgeCutoffUtc) + p.horizonSeconds * 1000).toISOString()))
  check(Array.isArray(input.histories) && input.histories.length <= LIMITS.subjects)
  check(Array.isArray(input.events) && input.events.length <= LIMITS.events)
  const histories = new Set<string>()
  let totalPoints = 0
  for (const h of input.histories) {
    keys(h, ['subject', 'points'])
    check(subject(h.subject) && !histories.has(subjectKey(h.subject)))
    histories.add(subjectKey(h.subject))
    check(Array.isArray(h.points) && h.points.length <= LIMITS.pointsPerSubject)
    totalPoints += h.points.length
    check(totalPoints <= LIMITS.totalPoints)
    let previous: EventNetObservation | null = null
    for (const o of h.points) {
      keys(o, [
        'index',
        'block',
        'blockHash',
        'sourceAtUtc',
        'availableAtUtc',
        'regime',
        'cashRaw',
        'provenanceRef',
      ])
      check(
        integer(o.index, 0, 1000000000) &&
          raw(o.block) &&
          hash(o.blockHash) &&
          utc(o.sourceAtUtc) &&
          utc(o.availableAtUtc) &&
          text(o.regime) &&
          raw(o.cashRaw) &&
          text(o.provenanceRef) &&
          Date.parse(o.availableAtUtc) >= Date.parse(o.sourceAtUtc),
      )
      if (previous)
        check(
          o.index > previous.index &&
            BigInt(o.block) > BigInt(previous.block) &&
            Date.parse(o.sourceAtUtc) > Date.parse(previous.sourceAtUtc),
        )
      previous = o
    }
  }
  for (const e of input.events) {
    keys(e, [
      'subject',
      'regime',
      'taxonomy',
      'eventId',
      'storyId',
      'duplicateGroupId',
      'knowledgeBasis',
      'kind',
      'occurredAtUtc',
      'firstKnownAtUtc',
      'fetchedAtUtc',
      'availableAtUtc',
      'publishedAtUtc',
      'occurrenceProof',
    ])
    check(subject(e.subject) && text(e.regime))
    taxonomy(e.taxonomy)
    check(text(e.eventId, 128) && text(e.storyId, 128) && text(e.duplicateGroupId, 128))
    check(['official_observed', 'scheduled'].includes(e.kind))
    check(
      utc(e.occurredAtUtc) &&
        utc(e.firstKnownAtUtc) &&
        utc(e.fetchedAtUtc) &&
        utc(e.availableAtUtc) &&
        (e.publishedAtUtc === null || utc(e.publishedAtUtc)),
    )
    check(
      Date.parse(e.availableAtUtc) >=
        Math.max(Date.parse(e.firstKnownAtUtc), Date.parse(e.fetchedAtUtc)) &&
        (e.kind === 'scheduled'
          ? Date.parse(e.firstKnownAtUtc) < Date.parse(e.occurredAtUtc)
          : Date.parse(e.firstKnownAtUtc) >= Date.parse(e.occurredAtUtc)),
    )
    // A publication-backed first-known clock cannot precede publication.
    // Null publication needs explicit reviewed non-publication occurrence
    // provenance, not an inferred date or an authenticity claim from this JSON.
    check(
      e.knowledgeBasis === 'publication_backed'
        ? e.publishedAtUtc !== null &&
            Date.parse(e.publishedAtUtc) <= Date.parse(e.firstKnownAtUtc) &&
            Date.parse(e.publishedAtUtc) <= Date.parse(e.availableAtUtc)
        : e.knowledgeBasis === 'reviewed_occurrence_without_publication' &&
            e.publishedAtUtc === null &&
            e.occurrenceProof !== null &&
            ['native_block', 'official_effective'].includes(e.occurrenceProof.kind),
    )
    if (e.occurrenceProof !== null) {
      const proof = e.occurrenceProof
      keys(proof, [
        'kind',
        'occurredAtUtc',
        'availableAtUtc',
        'sourceRef',
        'reviewRef',
        'block',
        'blockHash',
      ])
      check(
        ['native_block', 'official_effective', 'verified_announcement'].includes(proof.kind) &&
          proof.occurredAtUtc === e.occurredAtUtc &&
          utc(proof.availableAtUtc) &&
          Date.parse(proof.availableAtUtc) >= Date.parse(proof.occurredAtUtc) &&
          text(proof.sourceRef) &&
          text(proof.reviewRef),
      )
      check(
        proof.kind === 'native_block'
          ? raw(proof.block) && hash(proof.blockHash)
          : proof.block === null && proof.blockHash === null,
      )
    }
  }
}
type Group = {
  subject: EventNetSubject
  regime: string
  rows: ReviewedNetEvent[]
  eventIds: string[]
  storyIds: string[]
  start: number
  end: number
  knownAt: number | null
  reason: string | null
}
const unique = (xs: string[]) => [...new Set(xs)].sort()
function effectiveEventAvailability(e: ReviewedNetEvent): number {
  return Math.max(
    Date.parse(e.firstKnownAtUtc),
    Date.parse(e.fetchedAtUtc),
    Date.parse(e.availableAtUtc),
    e.publishedAtUtc === null ? -Infinity : Date.parse(e.publishedAtUtc),
    e.occurrenceProof === null ? -Infinity : Date.parse(e.occurrenceProof.availableAtUtc),
  )
}
function eventGroups(input: EventConditionedNetInput, rows: ReviewedNetEvent[]): Group[] {
  const parent = rows.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const aliases = new Map<string, number>()
  rows.forEach((e, i) => {
    for (const [kind, id] of [
      ['event', e.eventId],
      ['story', e.storyId],
      ['group', e.duplicateGroupId],
    ]) {
      const key = JSON.stringify([subjectKey(e.subject), kind, id])
      const prior = aliases.get(key)
      if (prior !== undefined) parent[find(i)] = find(prior)
      else aliases.set(key, i)
    }
  })
  const grouped = new Map<number, ReviewedNetEvent[]>()
  rows.forEach((e, i) => {
    const key = find(i)
    grouped.set(key, [...(grouped.get(key) ?? []), e])
  })
  const cutoff = Date.parse(input.knowledgeCutoffUtc)
  const currentAt = Date.parse(input.target.source.sourceAtUtc)
  return [...grouped.values()].map((events) => {
    const first = events[0]
    const signature = (e: ReviewedNetEvent) =>
      JSON.stringify([
        e.regime,
        e.taxonomy.namespace,
        e.taxonomy.eventType,
        e.kind,
        e.occurredAtUtc,
      ])
    const conflict = events.some((e) => signature(e) !== signature(first))
    // Every row was gated by effective availability before any alias union,
    // conflict comparison or window construction. Future rows cannot alter
    // a past grouping even when they bridge two earlier event/story identities.
    const visible = events
    const proven = visible.filter(
      (e) => e.occurrenceProof !== null && Date.parse(e.occurrenceProof.availableAtUtc) <= cutoff,
    )
    const times = proven.map(effectiveEventAvailability)
    const start = Math.min(...events.map((e) => Date.parse(e.occurredAtUtc)))
    const end =
      Math.max(...events.map((e) => Date.parse(e.occurredAtUtc))) +
      input.parameters.eventResponseWindowSeconds * 1000
    const reason = conflict
      ? 'conflicting_event_identity'
      : start >= currentAt
        ? first.kind === 'scheduled'
          ? 'unrealized_scheduled_event'
          : 'occurrence_not_before_current_source'
        : !visible.length
          ? 'event_not_available_at_knowledge_cutoff'
          : !proven.length
            ? 'reviewed_occurrence_proof_unavailable'
            : null
    return {
      subject: first.subject,
      regime: first.regime,
      rows: events,
      eventIds: unique(events.map((e) => e.eventId)),
      storyIds: unique(events.map((e) => e.storyId)),
      start,
      end,
      knownAt: times.length ? Math.min(...times) : null,
      reason,
    }
  })
}
const rateOrder = (a: EventAssociatedNetRate, b: EventAssociatedNetRate): number => {
  const left = BigInt(a.netDeltaRaw) * BigInt(b.rate.denominatorMs)
  const right = BigInt(b.netDeltaRaw) * BigInt(a.rate.denominatorMs)
  return left < right ? -1 : left > right ? 1 : a.fromIndex - b.fromIndex
}

/** Same-source native adapters must qualify these raw observations separately.
 * In retrospective_training, later-reviewed occurrence evidence can fit present
 * scenarios, but never establishes what a past forecaster knew. */
export function selectEventConditionedNetScenarios(
  supplied: unknown,
): EventConditionedNetSelection | null {
  try {
    const input = snapshot(supplied) as EventConditionedNetInput
    validate(input)
    const allowed =
      input.scope.kind === 'exact_subject'
        ? [{ subject: input.target.subject, regime: input.target.regime }]
        : input.scope.subjects
    const scope = new Map(allowed.map((s) => [subjectKey(s.subject), s]))
    const cutoff = Date.parse(input.knowledgeCutoffUtc)
    const availableEvents = input.events.filter((e) => effectiveEventAvailability(e) <= cutoff)
    const unavailableEvents: EventConditionedNetSelection['unavailableEvents'] = input.events
      .filter((e) => effectiveEventAvailability(e) > cutoff)
      .map((e) => ({
        subject: e.subject,
        eventId: e.eventId,
        storyId: e.storyId,
        duplicateGroupId: e.duplicateGroupId,
        effectiveAvailableAtUtc: new Date(effectiveEventAvailability(e)).toISOString(),
        reason: 'event_not_available_at_knowledge_cutoff',
      }))
    const groups = eventGroups(input, availableEvents)
    const excludedEvents: EventConditionedNetSelection['excludedEvents'] = []
    const excludedIntervals: EventConditionedNetSelection['excludedIntervals'] = []
    const excludedHistories: EventConditionedNetSelection['excludedHistories'] = []
    const currentAt = Date.parse(input.target.source.sourceAtUtc)
    const lookbackAt = currentAt - input.parameters.lookbackSeconds * 1000
    for (const g of groups) {
      const entry = scope.get(subjectKey(g.subject))
      if (!entry) g.reason = 'subject_outside_declared_scope'
      else if (!g.rows.every((e) => sameTaxonomy(e.taxonomy, input.taxonomy)))
        g.reason = 'taxonomy_mismatch'
      else if (g.regime !== entry.regime) g.reason = 'event_regime_mismatch'
      if (g.reason)
        excludedEvents.push({ eventIds: g.eventIds, subject: g.subject, reason: g.reason })
    }
    const results: EventNetSubjectScenarios[] = []
    for (const entry of allowed) {
      const h = input.histories.find((v) => subjectKey(v.subject) === subjectKey(entry.subject))
      const subjectRows = availableEvents.filter(
        (e) => subjectKey(e.subject) === subjectKey(entry.subject),
      )
      const catalogueFor = (catalogue: Group[]) =>
        catalogue
          .filter(
            (g) =>
              subjectKey(g.subject) === subjectKey(entry.subject) &&
              g.rows.some((e) => sameTaxonomy(e.taxonomy, input.taxonomy)) &&
              g.start < currentAt,
          )
          .map((g) => ({
            ...g,
            reason: !g.rows.every((e) => sameTaxonomy(e.taxonomy, input.taxonomy))
              ? 'taxonomy_mismatch'
              : g.regime !== entry.regime
                ? 'event_regime_mismatch'
                : g.reason,
          }))
      const retrospectiveCatalogue =
        input.informationMode === 'retrospective_training' ? catalogueFor(groups) : []
      // Stable identities are based on the eligible event's actual immutable
      // window/signature, never on numeric positions in changing catalogues.
      const support = new Map<
        string,
        {
          start: number
          end: number
          rates: Set<EventAssociatedNetRate>
        }
      >()
      const baseline: EventAssociatedNetRate[] = []
      const matched: EventAssociatedNetRate[] = []
      const unmatched: EventAssociatedNetRate[] = []
      let candidate = 0,
        rejected = 0,
        overlapExcluded = 0
      for (let i = 1; h && i < h.points.length; i++) {
        candidate++
        const a = h.points[i - 1],
          z = h.points[i]
        const start = Date.parse(a.sourceAtUtc),
          end = Date.parse(z.sourceAtUtc),
          dt = end - start
        const reason =
          end >= currentAt || BigInt(z.block) >= BigInt(input.target.source.block)
            ? 'historical_outcome_not_before_current_source'
            : Date.parse(a.availableAtUtc) > cutoff || Date.parse(z.availableAtUtc) > cutoff
              ? 'history_not_available_at_knowledge_cutoff'
              : start < lookbackAt
                ? 'outside_declared_lookback'
                : a.regime !== entry.regime || z.regime !== entry.regime
                  ? 'native_regime_mismatch'
                  : z.index !== a.index + 1
                    ? 'nonconsecutive_observations'
                    : dt < input.parameters.minimumIntervalSeconds * 1000 ||
                        dt > input.parameters.maximumGapSeconds * 1000
                      ? 'outside_declared_duration_bounds'
                      : null
        if (reason) {
          rejected++
          excludedIntervals.push({
            subject: entry.subject,
            fromIndex: a.index,
            toIndex: z.index,
            reason,
            retainedInNativeBaseline: false,
          })
          continue
        }
        const delta = String(BigInt(z.cashRaw) - BigInt(a.cashRaw))
        const rate: EventAssociatedNetRate = {
          subject: entry.subject,
          regime: entry.regime,
          fromIndex: a.index,
          toIndex: z.index,
          fromBlock: a.block,
          toBlock: z.block,
          fromBlockHash: a.blockHash,
          toBlockHash: z.blockHash,
          fromAtUtc: a.sourceAtUtc,
          toAtUtc: z.sourceAtUtc,
          availableAtUtc: new Date(
            Math.max(Date.parse(a.availableAtUtc), Date.parse(z.availableAtUtc)),
          ).toISOString(),
          provenanceRefs: [a.provenanceRef, z.provenanceRef],
          startCashRaw: a.cashRaw,
          endCashRaw: z.cashRaw,
          netDeltaRaw: delta,
          rate: { numeratorRaw: delta, denominatorMs: dt },
          eventIds: [],
          storyIds: [],
          eventClusterIds: [],
          eventKnowledgeAtUtc: null,
          eventKnownByHistoricalStart: null,
          application:
            subjectKey(entry.subject) === subjectKey(input.target.subject) &&
            entry.regime === input.target.regime
              ? 'replace_target_native_NET'
              : 'donor_native_units_only_no_target_amount_transfer',
        }
        baseline.push(rate)
        // Replay reconstructs the entire catalogue BEFORE aliases, conflicts,
        // windows and unmatched classification at this donor's historical start.
        // A row visible today but first available later cannot alter this donor.
        const donorCatalogue =
          input.informationMode === 'as_of_replay'
            ? catalogueFor(
                eventGroups(
                  input,
                  subjectRows.filter((e) => effectiveEventAvailability(e) <= start),
                ),
              )
            : retrospectiveCatalogue
        const overlap = donorCatalogue.filter((g) => start < g.end && end > g.start)
        const matches = overlap.flatMap((g) => {
          if (g.reason !== null || start < g.start || end > g.end) return []
          const proven = g.rows.filter((e) => {
            const proof = e.occurrenceProof
            if (
              !proof ||
              Date.parse(e.availableAtUtc) > cutoff ||
              Date.parse(proof.availableAtUtc) > cutoff
            )
              return false
            // A reviewed native occurrence cannot follow the cash-start block.
            // At the same height, its canonical hash must join that endpoint.
            return (
              proof.kind !== 'native_block' ||
              (BigInt(proof.block!) <= BigInt(a.block) &&
                (proof.block !== a.block ||
                  (proof.blockHash === a.blockHash && proof.occurredAtUtc === a.sourceAtUtc)))
            )
          })
          if (!proven.length) return []
          const knownAt = Math.min(...proven.map(effectiveEventAvailability))
          if (input.informationMode === 'as_of_replay' && knownAt > start) return []
          return [{ ...g, knownAt }]
        })
        if (matches.length) {
          const selected: EventAssociatedNetRate = {
            ...rate,
            eventIds: unique(matches.flatMap((g) => g.eventIds)),
            storyIds: unique(matches.flatMap((g) => g.storyIds)),
            eventClusterIds: [],
            eventKnowledgeAtUtc: new Date(
              Math.min(...matches.map((g) => g.knownAt!)),
            ).toISOString(),
            eventKnownByHistoricalStart: matches.every((g) => g.knownAt! <= start),
          }
          matched.push(selected)
          for (const g of matches) {
            const signature = JSON.stringify([
              g.regime,
              g.rows[0].taxonomy.namespace,
              g.rows[0].taxonomy.eventType,
              g.rows[0].kind,
              g.start,
              g.end,
            ])
            const existing = support.get(signature)
            if (existing) existing.rates.add(selected)
            else support.set(signature, { start: g.start, end: g.end, rates: new Set([selected]) })
          }
        } else if (!overlap.length) unmatched.push(rate)
        else {
          overlapExcluded++
          const lateKnown = overlap.some(
            (g) =>
              g.reason === null &&
              start >= g.start &&
              end <= g.end &&
              g.knownAt !== null &&
              g.knownAt > start,
          )
          excludedIntervals.push({
            subject: entry.subject,
            fromIndex: a.index,
            toIndex: z.index,
            reason: lateKnown
              ? 'event_known_after_historical_start'
              : 'overlapping_event_window_without_eligible_match',
            retainedInNativeBaseline: true,
          })
        }
      }
      // Only evidence that actually matched a native, clock-eligible interval
      // contributes support. Wrong-regime/conflicting/unproven catalogue windows
      // may contaminate unmatched controls, but never bridge counted support.
      const supportClusters: {
        start: number
        end: number
        members: { start: number; end: number; rates: Set<EventAssociatedNetRate> }[]
      }[] = []
      for (const window of [...support.values()].sort(
        (a, b) => a.start - b.start || a.end - b.end,
      )) {
        const previous = supportClusters.at(-1)
        if (previous && window.start < previous.end) {
          previous.end = Math.max(previous.end, window.end)
          previous.members.push(window)
        } else supportClusters.push({ start: window.start, end: window.end, members: [window] })
      }
      for (const cluster of supportClusters) {
        const stableId = JSON.stringify([
          'eligible_event_response_window',
          new Date(cluster.start).toISOString(),
          new Date(cluster.end).toISOString(),
        ])
        for (const member of cluster.members)
          for (const rate of member.rates) rate.eventClusterIds.push(stableId)
      }
      for (const rate of matched) rate.eventClusterIds = unique(rate.eventClusterIds)
      const matchedClusters = supportClusters.length
      const reason: EventNetSubjectScenarios['reason'] = !baseline.length
        ? 'no_eligible_native_intervals'
        : matched.length < input.parameters.minimumMatchedIntervals
          ? 'insufficient_matched_intervals'
          : matchedClusters < input.parameters.minimumEventClusters
            ? 'insufficient_distinct_event_clusters'
            : null
      const choose = (xs: EventAssociatedNetRate[]) =>
        [...xs].sort(rateOrder).slice(0, input.parameters.maximumScenariosPerSubject)
      const selectedMatched = choose(matched),
        selectedUnmatched = choose(unmatched),
        selectedBaseline = choose(baseline)
      results.push({
        subject: entry.subject,
        regime: entry.regime,
        status: reason ? 'insufficient_event_matches' : 'event_associated_net_scenarios',
        reason,
        matched: selectedMatched,
        comparableUnmatched: selectedUnmatched,
        baselineNativeNet: selectedBaseline,
        persistence: { netDeltaRaw: '0', denominatorMs: 1000 },
        counts: {
          candidateIntervals: candidate,
          baselineEligibleIntervals: baseline.length,
          matchedIntervals: matched.length,
          comparableUnmatchedIntervals: unmatched.length,
          matchedEventClusters: matchedClusters,
          baselineRejectedIntervals: rejected,
          eventOverlapExcludedFromUnmatched: overlapExcluded,
          selectedMatched: selectedMatched.length,
          selectedUnmatched: selectedUnmatched.length,
          selectedBaseline: selectedBaseline.length,
        },
        selectionTruncated: [matched, unmatched, baseline].some(
          (xs) => xs.length > input.parameters.maximumScenariosPerSubject,
        ),
      })
    }
    for (const h of input.histories)
      if (!scope.has(subjectKey(h.subject)))
        excludedHistories.push({ subject: h.subject, reason: 'subject_outside_declared_scope' })
    const qualified = results.some((s) => s.status === 'event_associated_net_scenarios')
    const sum = (key: keyof EventNetSubjectScenarios['counts']) =>
      results.reduce((n, s) => n + s.counts[key], 0)
    return freeze({
      schema: 'event_conditioned_net_scenarios_v1',
      status: qualified ? 'event_associated_net_scenarios' : 'insufficient_event_matches',
      reason: qualified ? null : 'no_subject_has_sufficient_event_matches',
      informationMode: input.informationMode,
      retrospectiveInformation: input.informationMode === 'retrospective_training',
      target: input.target,
      knowledgeCutoffUtc: input.knowledgeCutoffUtc,
      requestedTargetAtUtc: new Date(cutoff + input.parameters.horizonSeconds * 1000).toISOString(),
      taxonomy: input.taxonomy,
      scope: input.scope,
      parameters: input.parameters,
      subjects: results,
      counts: {
        eventRows: input.events.length,
        availableEventRows: availableEvents.length,
        unavailableEventRows: unavailableEvents.length,
        deduplicatedSubjectEventGroups: groups.length,
        duplicateEventSubjectRows: availableEvents.length - groups.length,
        excludedSubjectEventGroups: excludedEvents.length,
        candidateIntervals: sum('candidateIntervals'),
        baselineEligibleIntervals: sum('baselineEligibleIntervals'),
        matchedIntervals: sum('matchedIntervals'),
        comparableUnmatchedIntervals: sum('comparableUnmatchedIntervals'),
        matchedSubjectEventClusters: sum('matchedEventClusters'),
        excludedIntervals: excludedIntervals.length,
      },
      unavailableEvents,
      excludedEvents,
      excludedIntervals,
      excludedHistories,
      comparison: {
        method: 'same_subject_regime_declared_duration_bounds',
        unmatchedMeans: 'no_overlapping_requested_taxonomy_event_in_information_mode_catalogue',
        unrelatedEventsControlled: false,
        independentSampleCount: null,
        supportCountsAreCorrelatedSubjectIntervals: true,
        catalogueDiagnosticsUsePresentCutoff: true,
        supportClusterMembershipUsesCurrentAnalysisCohort: true,
      },
      coverage: {
        endpointNetArithmeticComplete: true,
        fullPeriodFlowCoverage: false,
        continuousCapacityKnown: false,
        completeEventCatalogue: false,
        completeLookbackHistory: false,
      },
      assumptions: {
        selection: 'lowest_signed_native_NET_rates_per_subject',
        netDerivedOnlyFromEndpointDifference: true,
        replacesNETScenario: true,
        grossWithdrawalsDeductedAgain: false,
        sourceAgeAppliedHere: false,
        horizonExtrapolatedHere: false,
        exposureOrQAppliedHere: false,
        rawAmountsPooledAcrossAssets: false,
        overlappingSupportTreatedAsIndependent: false,
        retrospectiveTrainingIsHistoricalForecastReplay: false,
        olderNativeOccurrenceRequiresExternalAdapter: true,
        asOfCatalogueFilteredAtDonorStartBeforeGrouping: true,
        supportClustersUseOnlyActuallyMatchedEligibleWindows: true,
      },
      protocolMaximumGrossOutflowRaw: null,
      competingMRaw: null,
      causal: false,
      probabilityUncalibrated: true,
      calibrated: false,
      authenticated: false,
      originalAuthority: false,
      forecastValidated: false,
      prospectiveValidated: false,
      holderExitForecast: false,
      holderExecutableExit: false,
      minedPayout: false,
    } as EventConditionedNetSelection)
  } catch {
    return null
  }
}
