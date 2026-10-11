import type { ConditionalSampledCashHistory } from '../carry/conditionalSampledCashPathProjection'

/** Conditional sampled-episode scenario assuming no hidden recrossings; no continuous occupancy proof. */
export type RecoverySample = {
  observedAt: string; firstAvailableAt?: string | null; capacityUsd: number | null
  coverage?: 'complete' | 'partial' | 'unverified'; sourceId?: string | null
  /** Only a verified, same-unit regime identifier belongs here; missing means assumed unchanged. */
  recoveryRegimeId?: string | null
}
export type RecoveryInput = {
  routeKey: string; metric: 'instant_usd' | 'depth_usd' | 'cash_units'
  amount: number; horizonHours: number; asOf: string; maxGapHours: number
  maxObservationAgeHours: number; snapshots: readonly RecoverySample[]
  /** Optional source-clock scenario; real issue availability remains mandatory. */
  scenarioAt?: string | null
}
type Row = RecoverySample & { t: number; a: number; value: number | null; regime: string | null }
type Episode = { before: Row | null; below: Row[]; recovery: Row | null; censor: 'gap' | 'right' | null }
type Bounds = { lower: number; upper: number | null }
type Donor = {
  onset: { after: string | null; by: string }; landmarkAt: string
  recovery: { after: string; by: string } | null; censored: 'gap' | 'right' | null
  remainingHours: Bounds
}
const HOUR = 3_600_000
const AGE = [0, 6, 24, 72, 168, Infinity]
const DEFICIT = [0, 0.1, 0.25, 0.5, 1.0000000001]
const MAX_ROWS = 20_000, MAX_EPISODES = 512
const time = (v: unknown) => typeof v === 'string' ? Date.parse(v) : NaN
const iso = (t: number) => new Date(t).toISOString()
function band(x: number, edges: number[]) {
  return edges.findIndex((low, i) => i + 1 < edges.length && x >= low && x < edges[i + 1])
}
function ageBounds(ep: Episode, at: number): Bounds | null {
  return ep.before ? { lower: (at - ep.below[0].t) / HOUR,
    upper: (at - ep.before.t) / HOUR } : null
}
function ageBand(bounds: Bounds | null) {
  return bounds?.upper === null || !bounds ? -1 : AGE.findIndex((low, i) =>
    i + 1 < AGE.length && bounds.lower >= low && bounds.upper! <= AGE[i + 1])
}
function ageStratum(bounds: Bounds | null) {
  if (!bounds) return { key: 'unknown_left_censored', kind: 'unknown_left_censored' as const, indices: [] as number[] }
  const exact = ageBand(bounds)
  const indices = exact >= 0 ? [exact] : AGE.slice(0, -1).flatMap((low, i) =>
    bounds.lower < AGE[i + 1] && bounds.upper! > low ? [i] : [])
  return { key: `${exact >= 0 ? 'resolved' : 'straddling'}:${indices.join(',')}`,
    kind: exact >= 0 ? 'resolved' as const : 'straddling' as const, indices }
}
function orderBounds(donors: Donor[], fraction: number): Bounds | null {
  if (!donors.length) return null
  const rank = Math.max(0, Math.ceil(donors.length * fraction) - 1)
  const lower = donors.map((d) => d.remainingHours.lower).sort((a, b) => a - b)[rank]
  const upper = donors.map((d) => d.remainingHours.upper ?? Infinity).sort((a, b) => a - b)[rank]
  return { lower, upper: Number.isFinite(upper) ? upper : null }
}
export function sampledRecoveryOutlook(input: RecoveryInput) {
  const issue = time(input.asOf), scenario = input.scenarioAt == null ? issue : time(input.scenarioAt),
    gap = input.maxGapHours * HOUR
  const result = {
    status: 'unavailable' as 'unavailable' | 'not_below' | 'sparse_history' | 'conditional_history',
    reason: null as string | null, claim: 'conditional_sampled_recovery_scenario' as const,
    forecastValidated: false as const, holderExecutable: false as const, continuousPathKnown: false as const,
    issueClockBasis: input.scenarioAt == null ? 'availability_clock' as const : 'source_clock_retrospective' as const,
    scenarioAt: input.scenarioAt ?? null, realIssueAt: input.asOf,
    analogueLandmarkClock: 'source_clock_retrospective' as const, historicalAppIssuanceKnown: false as const,
    regimeBasis: 'assumed_unchanged' as 'assumed_unchanged' | 'verified_tag',
    assumptions: ['same_route_metric_normalized_units', 'sampled_crossings_only', 'assumed_no_hidden_recrossings_between_samples', 'no_additional_competitor_subtraction'],
    amount: input.amount, metric: input.metric, routeKey: input.routeKey, asOf: input.asOf,
    horizonHours: input.horizonHours, currentRightCensored: false, currentAgeHours: null as Bounds | null,
    currentOnset: null as { after: string | null; by: string } | null,
    matching: { deficitRatio: null as number | null, deficitBand: null as [number, number] | null,
      ageStratum: 'unselected' as 'unselected' | 'resolved' | 'straddling' | 'unknown_left_censored',
      assumedAgeBandsHours: [] as [number, number | null][], ageBandHours: null as [number, number | null] | null, landmarkRule: 'first_past_matching_sample_per_episode' as const },
    counts: { visibleSamples: 0, episodes: 0, historicalEpisodes: 0, leftCensoredHistorical: 0,
      otherRegimeEpisodes: 0, matchedDonors: 0, sampledRecoveryBracketByHorizon: 0, straddlingHorizon: 0,
      sampledEpisodeBelowThroughHorizon: 0, censoredBeforeHorizon: 0, atRiskSupport: 0 },
    episodeBrackets: [] as { onset: { after: string | null; by: string }; recovery: { after: string; by: string } | null; leftCensored: boolean; censored: Episode['censor']; sameRegime: boolean }[],
    donors: [] as Donor[], orderStatisticsHours: { p10: null as Bounds | null,
      p50: null as Bounds | null, p90: null as Bounds | null }, centralHours: null as number | null,
    supportGate: { minimumDistinctEpisodes: 4, episodeDefinition: 'non_overlapping_sampled_episodes', passed: false },
  }
  const unavailable = (reason: string) => ({ ...result, status: 'unavailable' as const, reason })
  if (!input.routeKey || !['instant_usd', 'depth_usd', 'cash_units'].includes(input.metric) ||
      !Number.isFinite(issue) || !Number.isFinite(scenario) || scenario > issue || !Number.isFinite(input.amount) || input.amount <= 0 ||
      !Number.isFinite(input.horizonHours) || input.horizonHours <= 0 || input.horizonHours > 720 ||
      !Number.isFinite(gap) || gap <= 0 || !Number.isFinite(input.maxObservationAgeHours) ||
      input.maxObservationAgeHours < 0) return unavailable('invalid_question')
  const rows: Row[] = []
  for (const s of input.snapshots) {
    const t = time(s.observedAt), a = time(s.firstAvailableAt)
    // Future or delayed rows cannot alter selection, onset, follow-up or validation.
    if (t > scenario || a > issue) continue
    if (!Number.isFinite(t) || !Number.isFinite(a) || a < t || !s.sourceId ||
        !['complete', 'partial', 'unverified'].includes(s.coverage ?? 'unverified') ||
        (s.capacityUsd !== null && (!Number.isFinite(s.capacityUsd) || s.capacityUsd < 0)) ||
        (s.recoveryRegimeId != null && (typeof s.recoveryRegimeId !== 'string' || !s.recoveryRegimeId)))
      return unavailable('invalid_visible_sample')
    rows.push({ ...s, t, a, value: s.capacityUsd, regime: s.recoveryRegimeId ?? null })
    if (rows.length > MAX_ROWS) return unavailable('visible_sample_limit')
  }
  rows.sort((a, b) => a.t - b.t)
  if (rows.some((r, i) => i > 0 && r.t === rows[i - 1].t)) return unavailable('duplicate_observation')
  result.counts.visibleSamples = rows.length
  const current = rows.at(-1)
  if (!current || current.coverage !== 'complete' || current.value === null) return unavailable('current_censored')
  if (scenario - current.t > input.maxObservationAgeHours * HOUR) return unavailable('current_stale')
  result.regimeBasis = current.regime ? 'verified_tag' : 'assumed_unchanged'
  if (!current.regime) result.assumptions.push('unchanged_regime_assumed')
  if (current.value >= input.amount) return { ...result, status: 'not_below' as const }
  result.currentRightCensored = true
  const episodes: Episode[] = []
  let open: Episode | null = null, previous: Row | null = null
  const close = (censor: Episode['censor'], recovery: Row | null = null) => {
    if (open) { open.censor = censor; open.recovery = recovery; episodes.push(open); open = null }
  }
  for (const row of rows) {
    if (row.coverage !== 'complete' || row.value === null ||
        (previous && (row.t - previous.t > gap || row.regime !== previous.regime))) {
      close('gap'); previous = null
      if (row.coverage !== 'complete' || row.value === null) continue
    }
    if (row.value! < input.amount) {
      open ??= { before: previous, below: [], recovery: null, censor: null }
      open.below.push(row)
    } else close(null, row)
    previous = row
  }
  close('right')
  if (episodes.length > MAX_EPISODES) return unavailable('episode_limit')
  result.counts.episodes = episodes.length
  const active = episodes.at(-1)!
  result.currentOnset = { after: active.before ? iso(active.before.t) : null, by: iso(active.below[0].t) }
  result.currentAgeHours = ageBounds(active, scenario)
  const deficit = (input.amount - current.value) / input.amount, deficitIndex = band(deficit, DEFICIT)
  const ageIndex = ageBand(result.currentAgeHours), stratum = ageStratum(result.currentAgeHours)
  result.matching.deficitRatio = deficit
  result.matching.deficitBand = [DEFICIT[deficitIndex], Math.min(1, DEFICIT[deficitIndex + 1])]
  const history = episodes.slice(0, -1)
  result.counts.historicalEpisodes = history.length
  result.episodeBrackets = history.map((ep) => ({
    onset: { after: ep.before ? iso(ep.before.t) : null, by: iso(ep.below[0].t) },
    recovery: ep.recovery ? { after: iso(ep.below.at(-1)!.t), by: iso(ep.recovery.t) } : null,
    leftCensored: ep.before === null, censored: ep.censor, sameRegime: ep.below[0].regime === current.regime,
  }))
  result.counts.leftCensoredHistorical = history.filter((ep) => !ep.before).length
  result.counts.otherRegimeEpisodes = history.filter((ep) => ep.below[0].regime !== current.regime).length
  result.matching.ageStratum = stratum.kind
  result.matching.assumedAgeBandsHours = stratum.indices.map((i) => [AGE[i], Number.isFinite(AGE[i + 1]) ? AGE[i + 1] : null])
  if (ageIndex >= 0) result.matching.ageBandHours = result.matching.assumedAgeBandsHours[0]
  else result.assumptions.push(stratum.kind === 'straddling' ? 'matched_age_bracket_stratum_no_central_estimate' : 'matched_unknown_left_censored_age_no_central_estimate')
  for (const ep of history) {
    if (ep.below[0].regime !== current.regime) continue
    // Outcome completion is never a selection criterion. Every matching episode contributes.
    // Retrospective analogue, not an assertion that these samples were available to a past app.
    // Selection uses the source-time prefix; all receipts were checked against the real issue above.
    const landmark = ep.below.find((row) => ageStratum(ageBounds(ep, row.t)).key === stratum.key &&
      band((input.amount - row.value!) / input.amount, DEFICIT) === deficitIndex)
    if (!landmark) continue
    const last = ep.below.at(-1)!
    result.donors.push({ onset: { after: ep.before ? iso(ep.before.t) : null, by: iso(ep.below[0].t) },
      landmarkAt: iso(landmark.t), recovery: ep.recovery ? { after: iso(last.t), by: iso(ep.recovery.t) } : null,
      censored: ep.censor, remainingHours: { lower: Math.max(0, (last.t - landmark.t) / HOUR),
        upper: ep.recovery ? Math.max(0, (ep.recovery.t - landmark.t) / HOUR) : null } })
  }
  const c = result.counts, horizon = input.horizonHours
  c.matchedDonors = result.donors.length
  for (const d of result.donors) {
    const { lower, upper } = d.remainingHours
    if (upper !== null && upper <= horizon) c.sampledRecoveryBracketByHorizon++
    else if (lower >= horizon) c.sampledEpisodeBelowThroughHorizon++
    else if (upper !== null) c.straddlingHorizon++
    else c.censoredBeforeHorizon++
  }
  c.atRiskSupport = c.sampledRecoveryBracketByHorizon + c.straddlingHorizon + c.sampledEpisodeBelowThroughHorizon
  result.orderStatisticsHours = { p10: orderBounds(result.donors, 0.1), p50: orderBounds(result.donors, 0.5), p90: orderBounds(result.donors, 0.9) }
  result.supportGate.passed = result.donors.length >= 4
  const middle = result.orderStatisticsHours.p50
  if (stratum.kind === 'resolved' && result.supportGate.passed && middle?.upper != null) result.centralHours = (middle.lower + middle.upper) / 2
  return { ...result, status: result.supportGate.passed ? 'conditional_history' as const : 'sparse_history' as const }
}

/** Caller must first authenticate the bounded audit/pins and exact registered native identity.
 * Preserves genuine bulk availability. Conversion must preserve exact raw Q and deficit-band categories.
 */
export function normalizeNativeRecoveryHistory(history: ConditionalSampledCashHistory, amountUnits: number): RecoverySample[] | null {
  if (!history?.identity || !history.witness || !Array.isArray(history.points) ||
      !Number.isSafeInteger(amountUnits) || amountUnits <= 0 ||
      !Number.isInteger(history.identity.assetDecimals) || history.identity.assetDecimals < 0 || history.identity.assetDecimals > 36 ||
      !/^0x[0-9a-f]{40}$/.test(history.identity.destination) || !/^0x[0-9a-f]{40}$/.test(history.identity.asset) ||
      !Number.isFinite(time(history.witness.availableAt))) return null
  const scale = 10n ** BigInt(history.identity.assetDecimals), q = BigInt(amountUnits) * scale
  const snapshots: RecoverySample[] = []
  let prior = -Infinity, priorBlock = 0n, priorIndex = -1
  for (const p of history.points) {
    if (!Array.isArray(p) || p.length !== 5 || !Number.isSafeInteger(p[0]) || p[0] <= priorIndex ||
        !/^[1-9][0-9]{0,77}$/.test(p[1]) || !/^0x[0-9a-f]{64}$/.test(p[2]) ||
        !/^(0|[1-9][0-9]{0,77})$/.test(p[4])) return null
    const observed = time(p[3]), block = BigInt(p[1]), raw = BigInt(p[4]), units = Number(raw) / Number(scale)
    if (!Number.isFinite(observed) || observed <= prior || observed > time(history.witness.availableAt) ||
        block <= priorBlock || block > BigInt(Number.MAX_SAFE_INTEGER) || raw >= 2n ** 256n ||
        !Number.isFinite(units) || units > Number.MAX_SAFE_INTEGER || (raw < q) !== (units < amountUnits)) return null
    if (raw < q) {
      const deficit = q - raw, exact = deficit * 10n < q ? 0 : deficit * 4n < q ? 1 : deficit * 2n < q ? 2 : 3
      if (band((amountUnits - units) / amountUnits, DEFICIT) !== exact) return null
    }
    snapshots.push({ observedAt: p[3], firstAvailableAt: history.witness.availableAt, capacityUsd: units,
      coverage: 'complete', sourceId: `${p[1]}:${p[2]}:${history.identity.destination}:${history.identity.asset}` })
    prior = observed; priorBlock = block; priorIndex = p[0]
  }
  return snapshots
}
