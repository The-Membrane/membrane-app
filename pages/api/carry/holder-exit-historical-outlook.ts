import type { NextApiRequest, NextApiResponse } from 'next'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW_AMOUNT = /^(0|[1-9]\d*)$/
const MAX_UINT256 = (1n << 256n) - 1n
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i
const CLOUD_MARKERS = [
  'VERCEL',
  'VERCEL_ENV',
  'AWS_LAMBDA_FUNCTION_NAME',
  'K_SERVICE',
  'FLY_APP_NAME',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
] as const
const CACHE_MS = 30_000
const MAX_SAMPLE_ROWS = 4
const MAX_SUITE_BYTES = 8 * 1024 * 1024
const SUITE_MARKER = '__HOLDER_EXIT_HISTORICAL_SUITE__'
const execFileAsync = promisify(execFile)

type Evidence = {
  evidenceId: string
  evidenceClass: 'historical_endpoint' | 'historical_proxy'
  endpoint: string
  proxyLabel: string | null
  samples: Record<string, unknown>
  historicalWindow: Record<string, unknown>
  design: Record<string, unknown>
  outcomes: Record<string, unknown>
  retrospectiveOnly: true
  prospectiveValidated: false
  historicalUse: 'available' | 'abstain'
  limits: string[]
}

type HistoricalSuite = {
  schema: string
  scope: string
  claimClass: string
  asOfUtc?: string | null
  manifestSha256: string | null
  mechanismVersion: string | null
  sourcePolicy: {
    networkReads: false
    databaseReads: false
    localVerifiedArtifactsOnly: true
  }
  limits: {
    prospectiveValidated: false
    liveForecast: false
    capacityForecast: false
    fullRouteExitClaim: false
    routeLevelProbability: false
    incompatibleEndpointsPooled: false
  }
  coverage: {
    routeGroups: number
    exactSubjects: number
    frozenCohortRouteGroups: number
    frozenCohortExactSubjects: number
    supplementalRouteGroups: number
    supplementalExactSubjects: number
    exactEndpointHistoryRouteGroups: number
    proxyOnlyHistoryRouteGroups: number
    abstainingRouteGroups: number
  }
  routes: Array<{
    routeKey: string
    mechanism: 'atomic' | 'staged'
    exactSubjects: number
    subjects: Array<{ destination: string; originalAsset: string }>
    promotion: {
      historicalOutlook: 'eligible_exact_endpoint_history' | 'eligible_proxy_history' | 'abstain'
      liveForecast: 'abstain'
    }
    evidence: Evidence[]
  }>
}

type SampleRow = { label: string; value: string }
type SuiteReader = () => Promise<unknown>

function isLocalRequest(req: NextApiRequest): boolean {
  if (CLOUD_MARKERS.some((name) => process.env[name])) return false
  if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) return false
  const host = req.headers.host
  if (typeof host !== 'string' || !LOCAL_HOST.test(host)) return false
  const port = host.match(/:(\d+)$/)?.[1]
  if (port && Number(port) > 65_535) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const url = new URL(origin)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.host.toLowerCase() === host.toLowerCase()
    )
  } catch {
    return false
  }
}

function parseSubject(query: NextApiRequest['query']) {
  if (
    ![2, 3].includes(Object.keys(query).length) ||
    !('routeKey' in query) ||
    !('destination' in query) ||
    (Object.keys(query).length === 3 && !('requestedRaw' in query))
  )
    return null
  const { routeKey, destination, requestedRaw } = query
  if (
    typeof routeKey !== 'string' ||
    !routeKey ||
    routeKey.length > 200 ||
    routeKey !== routeKey.trim() ||
    /[\x00-\x1f\x7f]/.test(routeKey) ||
    typeof destination !== 'string' ||
    !ADDRESS.test(destination) ||
    (requestedRaw !== undefined &&
      (typeof requestedRaw !== 'string' ||
        requestedRaw.length > 78 ||
        !RAW_AMOUNT.test(requestedRaw) ||
        BigInt(requestedRaw) === 0n ||
        BigInt(requestedRaw) > MAX_UINT256))
  )
    return null
  return { routeKey, destination: destination.toLowerCase(), requestedRaw: requestedRaw ?? null }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function count(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 200 ? value : null
}

function row(label: string, value: string | number): SampleRow {
  return { label, value: String(value) }
}

const EVIDENCE_STRENGTH: Record<string, number> = {
  exact_holder_final_asset_withdraw_call_history: 90,
  susde_exact_request_to_mined_usde_payout_history: 125,
  historical_receipt_to_holder_payment: 120,
  morpho_fixed_10k_holder_call_ledger: 115,
  apyusd_request_to_payment_asof_split: 110,
  historical_fixed_10k_stable_revert_history: 105,
  bounded_mined_holder_payout_history: 100,
  umbrella_gho_exact_stage_revert_states: 85,
  fluid_bridge_usdc_first_leg_baseline_and_censoring: 85,
  saturn_exact_holder_usdat_payment_duration: 90,
  saturn_queue_processing_regime_check: 70,
  aggregate_cash_q_holdout: 65,
  aave_usdc_gross_flow_history: 60,
  common_holder_assay_walk_forward_backtest: 55,
  sampled_vault_condition_history: 50,
  historical_intermediate_conversion_quote: 45,
}

function evidenceStrength(evidence: Evidence): number {
  const classFloor = evidence.evidenceClass === 'historical_endpoint' ? 80 : 20
  return EVIDENCE_STRENGTH[evidence.evidenceId] ?? classFloor
}

function strongestEvidence(
  evidence: Evidence[],
  evidenceClass: Evidence['evidenceClass'] | null,
): Evidence | null {
  if (!evidenceClass) return null
  return (
    evidence
      .filter(
        (entry) => entry.historicalUse === 'available' && entry.evidenceClass === evidenceClass,
      )
      .sort((left, right) => evidenceStrength(right) - evidenceStrength(left))[0] ?? null
  )
}

function subjectBoundEvidence(
  evidence: Evidence,
  destination: string,
  requestedRaw: string | null,
): Evidence | null {
  if (evidence.evidenceId === 'historical_fixed_10k_stable_revert_history') return null
  if (evidence.evidenceId === 'exact_holder_final_asset_withdraw_call_history') {
    if (requestedRaw === null) return null
    const observations = asRecord(evidence.outcomes).observations
    if (!Array.isArray(observations)) return null
    const selected = observations.filter((entry) => asRecord(entry).qRaw === requestedRaw)
    if (!selected.length) return null
    const times = selected.map((entry) => String(asRecord(entry).observedAtUtc)).sort()
    return {
      ...evidence,
      samples: {
        ...evidence.samples,
        successfulCallCells: selected.length,
        issueClusters: new Set(selected.map((entry) => asRecord(entry).issueSha256)).size,
      },
      historicalWindow: {
        ...evidence.historicalWindow,
        fromUtc: times[0],
        throughUtc: times.at(-1),
      },
      outcomes: {
        ...evidence.outcomes,
        successfulCallCells: selected.length,
        observations: selected,
      },
    }
  }
  if (evidence.evidenceId !== 'morpho_fixed_10k_holder_call_ledger') return evidence
  if (requestedRaw === null) return null
  const samples = asRecord(evidence.samples)
  if (samples.qAssetsRaw !== requestedRaw || !Array.isArray(samples.destinationSlices)) return null
  const slices = samples.destinationSlices.filter(
    (row) => asRecord(row).destination === destination,
  )
  if (slices.length !== 1) return null
  const slice = asRecord(slices[0])
  const all = asRecord(slice.all)
  const development = asRecord(slice.development)
  const reservedHoldout = asRecord(slice.reservedHoldout)
  if (
    !count(all.plannedCells) ||
    !count(all.baselineSuccessEpisodes) ||
    count(all.plannedCells) !==
      count(development.plannedCells) + count(reservedHoldout.plannedCells)
  )
    return null
  for (const key of [
    'completedCells',
    'baselineSuccessEpisodes',
    'observedFirstLossEpisodes',
    'observedRecoveryEpisodes',
    'firstLossRightCensoredEpisodes',
  ])
    if (count(all[key]) !== count(development[key]) + count(reservedHoldout[key])) return null
  return {
    ...evidence,
    samples: { ...samples, ...all, development, reservedHoldout, exactDestination: destination },
    outcomes: { ...evidence.outcomes, ...all },
    historicalWindow: {
      ...evidence.historicalWindow,
      fromBlock: slice.fromBlock,
      throughBlock: slice.throughBlock,
    },
  }
}

function normalizeEvidence(evidence: Evidence) {
  const samples = asRecord(evidence.samples)
  const outcomes = asRecord(evidence.outcomes)
  const design = asRecord(evidence.design)
  let title = 'Historical route evidence'
  let headline = 'Verified historical evidence is available for this route.'
  let sampleRows: SampleRow[] = []

  switch (evidence.evidenceId) {
    case 'exact_holder_final_asset_withdraw_call_history': {
      const calls = count(samples.successfulCallCells)
      const clusters = count(samples.issueClusters)
      title = 'Same-holder withdrawal call history'
      headline = `${calls} historical exact-amount withdrawal calls succeeded across ${clusters} holder issue${clusters === 1 ? '' : 's'}. Simulated calls do not prove mined payout or a future exit window.`
      sampleRows = [row('Successful calls', calls), row('Holder issues', clusters)]
      break
    }
    case 'susde_exact_request_to_mined_usde_payout_history': {
      const linked = count(samples.linkedRequestPayoutEpisodes)
      const holders = count(samples.distinctHolderCommitments)
      const episodes = Array.isArray(outcomes.episodes) ? outcomes.episodes : []
      const seconds = episodes.map((episode) =>
        count(asRecord(episode).observedRequestToPayoutSeconds),
      )
      title = 'Exact sUSDe request to USDe payout history'
      headline = `${linked} linked historical request-to-mined-USDe payout episode${linked === 1 ? '' : 's'}; observed time includes holder action and is not restriction recovery or a forecast.`
      sampleRows = [
        row('Linked payouts', linked),
        row('Distinct holders', holders),
        row(
          'Observed elapsed',
          `${(Math.min(...seconds) / 3_600).toFixed(1)}–${(Math.max(...seconds) / 3_600).toFixed(1)}h`,
        ),
      ]
      break
    }
    case 'historical_receipt_to_holder_payment': {
      const minted = count(samples.mintedReceipts)
      const paid = count(samples.paidReceipts)
      const open = count(samples.openRightCensored)
      title = 'Request to paid history'
      headline = `${paid} mined payments from ${minted} historical receipts; ${open} remained open at the cutoff.`
      sampleRows = [
        row('Historical receipts', minted),
        row('Mined payments', paid),
        row('Open at cutoff', open),
      ]
      break
    }
    case 'morpho_fixed_10k_holder_call_ledger': {
      const episodes = count(samples.baselineSuccessEpisodes)
      const lost = count(outcomes.observedFirstLossEpisodes)
      const recovered = count(outcomes.observedRecoveryEpisodes)
      const censored = count(outcomes.firstLossRightCensoredEpisodes)
      const development = asRecord(samples.development)
      const reservedHoldout = asRecord(samples.reservedHoldout)
      title = 'Fixed $10k holder call history'
      headline = `${episodes} baseline-success episodes at this destination and Q. Development: episodes ${count(development.baselineSuccessEpisodes)}, observed losses ${count(development.observedFirstLossEpisodes)}, recoveries ${count(development.observedRecoveryEpisodes)}. Reserved holdout: episodes ${count(reservedHoldout.baselineSuccessEpisodes)}, observed losses ${count(reservedHoldout.observedFirstLossEpisodes)}, recoveries ${count(reservedHoldout.observedRecoveryEpisodes)}. First-loss right-censored overall: ${censored}.`
      sampleRows = [
        row('Episodes', episodes),
        row('Observed losses', lost),
        row('Recoveries', recovered),
        row('Right-censored', censored),
      ]
      break
    }
    case 'apyusd_request_to_payment_asof_split': {
      const cohort = count(samples.cohort)
      const holdout = Array.isArray(outcomes.holdoutAtFinalCutoff)
        ? outcomes.holdoutAtFinalCutoff
        : []
      const day28 = asRecord(holdout.find((entry) => asRecord(entry).days === 28))
      title = 'Chronological payment history'
      headline = `${count(day28.paid)} of ${count(day28.evaluable)} later receipts reached mined payment within 28 days.`
      sampleRows = [
        row('Receipt cohort', cohort),
        row('Later evaluable', count(day28.evaluable)),
        row('Paid by day 28', count(day28.paid)),
        row('Not paid by day 28', count(day28.notPaid)),
      ]
      break
    }
    case 'historical_fixed_10k_stable_revert_history': {
      const episodes = count(samples.fixed10kStableRevertEpisodes)
      const cells = count(samples.sampledHorizonCells)
      title = 'Fixed $10k revert history'
      headline = `${episodes} holder episodes stayed reverted across ${cells} sampled horizon cells.`
      sampleRows = [row('Episodes', episodes), row('Horizon cells', cells)]
      break
    }
    case 'umbrella_gho_exact_stage_revert_states': {
      const gates = asRecord(outcomes.baselineGates)
      const issues = count(samples.issueClusters)
      const reverting = count(outcomes.measuredStillReverting)
      const laterCallable = count(outcomes.measuredLaterCallable)
      title = 'Umbrella GHO call history'
      headline = `${issues} holder issues had reverted one-share redeem calls at baseline; ${reverting} measured followups still reverted${laterCallable ? ` and ${laterCallable} later simulated successfully` : ''}. These calls do not establish a future exit window.`
      sampleRows = [
        row('Holder issues', issues),
        row('Waiting gate', count(gates.waiting)),
        row('Cooldown not started', count(gates.cooldown_not_started)),
        row('Window expired', count(gates.window_expired)),
      ]
      break
    }
    case 'fluid_bridge_usdc_first_leg_baseline_and_censoring': {
      const qCases = count(samples.qCases)
      const horizons = Array.isArray(outcomes.byHorizon) ? outcomes.byHorizon : []
      const missed = horizons.reduce(
        (total, value) => total + count(asRecord(value).missedWindow),
        0,
      )
      const missing = horizons.reduce((total, value) => total + count(asRecord(value).missing), 0)
      const pending = horizons.reduce((total, value) => total + count(asRecord(value).pending), 0)
      const measured = count(samples.measuredFollowupCells)
      title = 'FluidBridge USDC first-leg history'
      headline = `${qCases} tested USDC amounts had callable first-leg simulations at baseline. Followups: ${measured} measured, ${missed} missed windows, ${missing} without a verified score, ${pending} pending. Full-route payout remains unassessed.`
      sampleRows = [
        row('Baseline amounts', qCases),
        row('Missed windows', missed),
        row('Missing scores', missing),
        row('Pending scores', pending),
      ]
      break
    }
    case 'bounded_mined_holder_payout_history': {
      const reconciled = count(samples.reconciledTransactions)
      const archives = count(samples.supplierArchives)
      const sameHolder = count(samples.sameHolderSupplierPayouts)
      title = 'Mined holder payout history'
      headline = sameHolder
        ? `${sameHolder} same-holder payouts in ${archives} bounded sealed archive${archives === 1 ? '' : 's'}; positive-only, with no failure denominator.`
        : `${reconciled} reconciled payout transactions in bounded history; positive-only, with no failure denominator.`
      sampleRows = [
        row('Reconciled tx', reconciled),
        row('Supplier archives', archives),
        row('Same-holder payouts', sameHolder),
      ]
      break
    }
    case 'saturn_queue_processing_regime_check': {
      const train = asRecord(outcomes.train)
      const later = asRecord(outcomes.later)
      title = 'Queue processing regime'
      headline = `${count(later.processedWithinHorizon)} of ${count(later.evaluable)} later tickets processed within 24h, versus ${count(train.processedWithinHorizon)} of ${count(train.evaluable)} earlier tickets.`
      sampleRows = [
        row('Earlier evaluable', count(train.evaluable)),
        row('Earlier processed', count(train.processedWithinHorizon)),
        row('Later evaluable', count(later.evaluable)),
        row('Later processed', count(later.processedWithinHorizon)),
      ]
      break
    }
    case 'saturn_exact_holder_usdat_payment_duration': {
      const requests = count(samples.requests)
      const payments = count(samples.verifiedFinalHolderPayments)
      const lowerSeconds = count(samples.medianDurationLowerSeconds)
      const upperSeconds = count(samples.medianDurationUpperSeconds)
      const horizons = Array.isArray(outcomes.fullCohortHorizonBounds)
        ? outcomes.fullCohortHorizonBounds
        : []
      const hour72 = asRecord(horizons.find((entry) => asRecord(entry).horizonHours === 72))
      const bounds = asRecord(hour72.historicalPaymentFractionBounds)
      const lowerPaid =
        typeof bounds.lower === 'number' && Number.isFinite(bounds.lower)
          ? `${(bounds.lower * 100).toFixed(1)}%`
          : 'unknown'
      const upperPaid =
        typeof bounds.upper === 'number' && Number.isFinite(bounds.upper)
          ? `${(bounds.upper * 100).toFixed(1)}%`
          : 'unknown'
      const lowerHours = (lowerSeconds / 3_600).toFixed(1)
      const upperHours = (upperSeconds / 3_600).toFixed(1)
      title = 'Request to holder payment history'
      headline = `${payments} exact-holder USDat payments from ${requests} requests; the historical median payment time was bounded at ${lowerHours}–${upperHours}h.`
      sampleRows = [
        row('Requests', requests),
        row('Exact-holder payments', payments),
        row('Median payment interval', `${lowerHours}–${upperHours}h`),
        row('Paid by 72h · bounds', `${lowerPaid}–${upperPaid}`),
      ]
      break
    }
    case 'aggregate_cash_q_holdout': {
      const holdout = count(samples.holdoutPairs)
      const fractions = Array.isArray(outcomes.qualifiedFractions)
        ? outcomes.qualifiedFractions
        : []
      const first = asRecord(fractions[0])
      const breaches = asRecord(first.holdoutBreaches)
      title = 'Aggregate cash holdout'
      headline = `${count(breaches.numerator)} historical cash breaches across ${count(breaches.denominator) || holdout} disjoint holdout windows at the tested size.`
      sampleRows = [
        row('Fit windows', count(samples.fitPairs)),
        row('Calibration windows', count(samples.calibrationPairs)),
        row('Holdout windows', holdout),
        row('Holdout breaches', count(breaches.numerator)),
      ]
      break
    }
    case 'aave_usdc_gross_flow_history': {
      const exact = count(samples.exactHorizonWindows)
      const disjoint = count(samples.nonoverlappingWindows)
      title = 'Aggregate gross flow history'
      headline = `${disjoint} disjoint flow windows and ${exact} exact windows were replayed.`
      sampleRows = [
        row('Disjoint windows', disjoint),
        row('Exact windows', exact),
        row('Blocks per window', count(samples.horizonBlocks)),
      ]
      break
    }
    case 'common_holder_assay_walk_forward_backtest': {
      const scorable = count(samples.scorableRows)
      const clusters = count(samples.scorableIssueClusters)
      const transitions = count(outcomes.observedTransitionEvents)
      title = 'Saved holder assay history'
      headline = `${scorable} saved horizon assays across ${clusters} issue clusters; ${transitions} state changes observed.`
      sampleRows = [
        row('Scorable rows', scorable),
        row('Issue clusters', clusters),
        row('State changes', transitions),
      ]
      break
    }
    case 'sampled_vault_condition_history': {
      const observations = count(samples.observations)
      const impaired = count(samples.zeroAssetsPositiveSharesSubjects)
      title = 'Vault condition samples'
      headline = `${observations} verified condition samples; ${impaired} subjects showed zero assets with positive shares.`
      sampleRows = [row('Samples', observations), row('Flagged subjects', impaired)]
      break
    }
    case 'historical_intermediate_conversion_quote': {
      const quoteSizes = count(samples.quoteSizes)
      title = 'Intermediate conversion quotes'
      headline = `${quoteSizes} fixed-size public quotes were verified for the intermediate conversion stage.`
      sampleRows = [row('Quote sizes', quoteSizes), row('Quote sets', count(outcomes.quoteSets))]
      break
    }
  }

  return {
    evidenceId: evidence.evidenceId,
    evidenceClass: evidence.evidenceClass,
    title,
    headline,
    endpoint: evidence.endpoint,
    proxyLabel: evidence.proxyLabel,
    samples: sampleRows.slice(0, MAX_SAMPLE_ROWS),
    method: textValue(design.unit) ?? 'verified_historical_artifact',
    window: {
      fromUtc: textValue(evidence.historicalWindow.fromUtc),
      throughUtc: textValue(evidence.historicalWindow.throughUtc),
      fromBlock:
        textValue(evidence.historicalWindow.fromBlock) ??
        (Number.isSafeInteger(evidence.historicalWindow.fromBlock)
          ? String(evidence.historicalWindow.fromBlock)
          : null),
      throughBlock:
        textValue(evidence.historicalWindow.throughBlock) ??
        (Number.isSafeInteger(evidence.historicalWindow.throughBlock)
          ? String(evidence.historicalWindow.throughBlock)
          : null),
    },
  }
}

function validStageEndpointEvidence(
  route: HistoricalSuite['routes'][number],
  evidence: Evidence,
): boolean {
  if (
    ![
      'umbrella_gho_exact_stage_revert_states',
      'fluid_bridge_usdc_first_leg_baseline_and_censoring',
    ].includes(evidence.evidenceId)
  )
    return true
  const umbrella = evidence.evidenceId === 'umbrella_gho_exact_stage_revert_states'
  const samples = asRecord(evidence.samples)
  const outcomes = asRecord(evidence.outcomes)
  const design = asRecord(evidence.design)
  const issues = count(samples.issueClusters)
  const cells = count(samples.qHorizonCells)
  const measured = count(samples.measuredFollowupCells)
  if (
    route.exactSubjects !== 1 ||
    route.routeKey !==
      (umbrella ? 'GHO → UmbrellaStakeToken [GHO]' : 'USDC → FluidBridgeAggregatorProxy [USDC]') ||
    route.subjects[0]?.destination.toLowerCase() !==
      (umbrella
        ? '0x4f827a63755855cdf3e8f3bcd20265c833f15033'
        : '0x273da948aca9261043fbdb2a857bc255ecc29012') ||
    route.subjects[0]?.originalAsset.toLowerCase() !==
      (umbrella
        ? '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
        : '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') ||
    evidence.evidenceClass !== 'historical_endpoint' ||
    evidence.endpoint !==
      (umbrella
        ? 'holder_specific_umbrella_redeem_eth_call_and_gate_state'
        : 'holder_specific_usdc_bridge_first_leg_eth_call_and_followup_censoring') ||
    design.stageScope !==
      (umbrella ? 'direct_umbrella_redeem_eth_call' : 'fluid_bridge_usdc_first_leg_eth_call') ||
    !issues ||
    !cells ||
    measured > cells ||
    outcomes.capacityProjection !== null ||
    outcomes.durationProjection !== null ||
    outcomes.observedCallableToImpairedTransitions !== 0 ||
    outcomes.observedImpairedToCallableTransitions !== 0 ||
    !evidence.limits.includes('first_leg_is_not_full_route_exit') ||
    !evidence.limits.includes('local_evidence_availability_clock_is_not_independently_witnessed')
  )
    return false
  if (umbrella) {
    const gates = asRecord(outcomes.baselineGates)
    return (
      count(outcomes.baselineRevertIssueClusters) === issues &&
      count(gates.waiting) + count(gates.cooldown_not_started) + count(gates.window_expired) ===
        issues &&
      count(outcomes.measuredStillReverting) + count(outcomes.measuredLaterCallable) === measured
    )
  }
  const horizons = outcomes.byHorizon
  if (!Array.isArray(horizons) || horizons.length !== 5 || !count(samples.qCases)) return false
  const expectedHours = [1, 4, 24, 48, 168]
  let totalCells = 0
  let totalMeasured = 0
  for (const [index, value] of horizons.entries()) {
    const horizon = asRecord(value)
    if (horizon.horizonHours !== expectedHours[index] || !count(horizon.qCases)) return false
    const statuses =
      count(horizon.missedWindow) +
      count(horizon.otherCensored) +
      count(horizon.missing) +
      count(horizon.pending) +
      count(horizon.measuredCallable) +
      count(horizon.inconclusive)
    if (statuses !== count(horizon.qCases)) return false
    totalCells += statuses
    totalMeasured +=
      count(horizon.otherCensored) + count(horizon.measuredCallable) + count(horizon.inconclusive)
  }
  return (
    totalCells === cells &&
    totalMeasured === measured &&
    count(outcomes.baselineCallableQCases) === count(samples.qCases)
  )
}

const DIRECT_HISTORY_IDENTITIES: Record<
  string,
  { destination: string; asset: string; scope: string }
> = {
  'GHO → sGho [GHO]': {
    destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    scope: 'direct_sgho_withdraw_eth_call',
  },
  'USDC → USD3 [USDC]': {
    destination: '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    scope: 'direct_usd3_withdraw_eth_call',
  },
  'USDS → StUsds [USDS]': {
    destination: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    scope: 'direct_stusds_withdraw_eth_call',
  },
  'USDS → SUsds [USDS]': {
    destination: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
    asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    scope: 'direct_susds_withdraw_eth_call',
  },
}

function validExactDirectEvidence(
  route: HistoricalSuite['routes'][number],
  evidence: Evidence,
  asOfUtc: string | null | undefined,
): boolean {
  if (evidence.evidenceId !== 'exact_holder_final_asset_withdraw_call_history') return true
  const canonicalMs = (value: unknown): number | null => {
    if (typeof value !== 'string') return null
    const ms = Date.parse(value)
    return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value ? ms : null
  }
  const expected = DIRECT_HISTORY_IDENTITIES[route.routeKey]
  const samples = asRecord(evidence.samples)
  const design = asRecord(evidence.design)
  const outcomes = asRecord(evidence.outcomes)
  const observations = outcomes.observations
  const asOfMs = asOfUtc == null ? Infinity : canonicalMs(asOfUtc)
  const subject = expected && `${route.routeKey}\0${expected.destination}\0${expected.asset}`
  if (
    !expected ||
    asOfMs === null ||
    route.exactSubjects !== 1 ||
    route.subjects[0]?.destination.toLowerCase() !== expected.destination ||
    route.subjects[0]?.originalAsset.toLowerCase() !== expected.asset ||
    evidence.evidenceClass !== 'historical_endpoint' ||
    evidence.endpoint !== 'same_holder_exact_q_final_original_asset_withdraw_eth_call' ||
    design.unit !== 'same_holder_exact_raw_q_scored_eth_call' ||
    design.subject !== subject ||
    design.stageScope !== expected.scope ||
    design.evidenceAvailabilityClock !== 'unwitnessed_local_operator_clock' ||
    samples.finalPayoutAsset !== expected.asset ||
    !Array.isArray(observations) ||
    !observations.length ||
    observations.length > 1_000 ||
    count(samples.successfulCallCells) !== observations.length ||
    outcomes.successfulCallCells !== observations.length ||
    outcomes.capacityProjection !== null ||
    outcomes.durationProjection !== null ||
    Object.hasOwn(outcomes, 'probability') ||
    Object.hasOwn(outcomes, 'forecastValidated') ||
    !evidence.limits.includes('historical_eth_call_is_not_mined_holder_payment') ||
    !evidence.limits.includes('no_transition_probability_or_restriction_duration_estimate')
  )
    return false
  const cells = new Set<string>()
  const issues = new Set<string>()
  const holders = new Map<string, string>()
  const baselines = new Map<string, string>()
  const scores = new Map<string, string>()
  const scoreOwners = new Map<string, string>()
  for (const value of observations) {
    const item = asRecord(value)
    const issue = String(item.issueSha256 ?? '')
    const score = String(item.scoreSha256 ?? '')
    const holder = String(item.holderCommitment ?? '')
    const q = String(item.qRaw ?? '')
    const horizon = Number(item.plannedHorizonHours)
    const cell = `${issue}:${q}:${horizon}`
    const scoreCell = `${issue}:${horizon}`
    const baselineIdentity = `${item.baselineBlock}:${item.baselineBlockHash}:${item.baselineAtUtc}:${item.issueAtUtc}`
    const scoreIdentity = `${score}:${item.targetAtUtc}:${item.deadlineAtUtc}:${item.observedAtUtc}:${item.localEvidenceAvailableAtUtc}`
    const baseline = canonicalMs(item.baselineAtUtc)
    const issued = canonicalMs(item.issueAtUtc)
    const target = canonicalMs(item.targetAtUtc)
    const deadline = canonicalMs(item.deadlineAtUtc)
    const observed = canonicalMs(item.observedAtUtc)
    const available = canonicalMs(item.localEvidenceAvailableAtUtc)
    if (
      item.subject !== subject ||
      item.stageScope !== expected.scope ||
      item.finalPayoutAsset !== expected.asset ||
      !/^[0-9a-f]{64}$/.test(issue) ||
      !/^[0-9a-f]{64}$/.test(score) ||
      issue === score ||
      !/^[0-9a-f]{64}$/.test(holder) ||
      !/^[1-9][0-9]*$/.test(q) ||
      !/^[1-9][0-9]*$/.test(String(item.baselineBlock ?? '')) ||
      !/^0x[0-9a-f]{64}$/.test(String(item.baselineBlockHash ?? '')) ||
      !Number.isSafeInteger(horizon) ||
      horizon < 1 ||
      baseline === null ||
      issued === null ||
      target === null ||
      deadline === null ||
      observed === null ||
      available === null ||
      baseline > issued ||
      target - issued !== horizon * 3_600_000 ||
      deadline - target !== 2 * 3_600_000 ||
      target > observed ||
      observed > deadline ||
      observed > available ||
      available > asOfMs ||
      cells.has(cell) ||
      (holders.has(issue) && holders.get(issue) !== holder) ||
      (baselines.has(issue) && baselines.get(issue) !== baselineIdentity) ||
      (scores.has(scoreCell) && scores.get(scoreCell) !== scoreIdentity) ||
      (scoreOwners.has(score) && scoreOwners.get(score) !== scoreCell)
    )
      return false
    cells.add(cell)
    issues.add(issue)
    holders.set(issue, holder)
    baselines.set(issue, baselineIdentity)
    scores.set(scoreCell, scoreIdentity)
    scoreOwners.set(score, scoreCell)
  }
  return count(samples.issueClusters) === issues.size
}

function validSuite(value: unknown): value is HistoricalSuite {
  if (!value || typeof value !== 'object') return false
  const report = value as Partial<HistoricalSuite>
  if (
    report.schema !== 'holder-exit-historical-outlook-suite-v1' ||
    report.scope !== 'offline_tracked_26_route_historical_holder_exit_outlook' ||
    report.claimClass !== 'retrospective_historical_outlook' ||
    !/^[0-9a-f]{64}$/.test(report.manifestSha256 ?? '') ||
    typeof report.mechanismVersion !== 'string' ||
    !report.mechanismVersion ||
    report.sourcePolicy?.networkReads !== false ||
    report.sourcePolicy.databaseReads !== false ||
    report.sourcePolicy.localVerifiedArtifactsOnly !== true ||
    report.limits?.prospectiveValidated !== false ||
    report.limits.liveForecast !== false ||
    report.limits.capacityForecast !== false ||
    report.limits.fullRouteExitClaim !== false ||
    report.limits.routeLevelProbability !== false ||
    report.limits.incompatibleEndpointsPooled !== false ||
    report.coverage?.routeGroups !== 26 ||
    report.coverage.exactSubjects !== 68 ||
    report.coverage.frozenCohortRouteGroups !== 25 ||
    report.coverage.frozenCohortExactSubjects !== 67 ||
    report.coverage.supplementalRouteGroups !== 1 ||
    report.coverage.supplementalExactSubjects !== 1 ||
    !Array.isArray(report.routes) ||
    report.routes.length !== 26
  )
    return false

  const routeKeys = new Set<string>()
  const subjectKeys = new Set<string>()
  let exactSubjects = 0
  let exactEndpointHistoryRouteGroups = 0
  let proxyOnlyHistoryRouteGroups = 0
  let abstainingRouteGroups = 0
  for (const route of report.routes) {
    if (
      typeof route?.routeKey !== 'string' ||
      !route.routeKey ||
      routeKeys.has(route.routeKey) ||
      !['atomic', 'staged'].includes(route.mechanism) ||
      !Number.isSafeInteger(route.exactSubjects) ||
      route.exactSubjects < 1 ||
      !Array.isArray(route.subjects) ||
      route.subjects.length !== route.exactSubjects ||
      !Array.isArray(route.evidence) ||
      !['eligible_exact_endpoint_history', 'eligible_proxy_history', 'abstain'].includes(
        route.promotion?.historicalOutlook,
      ) ||
      route.promotion.liveForecast !== 'abstain'
    )
      return false
    routeKeys.add(route.routeKey)
    exactSubjects += route.exactSubjects
    for (const subject of route.subjects) {
      if (!ADDRESS.test(subject?.destination ?? '') || !ADDRESS.test(subject?.originalAsset ?? ''))
        return false
      const key = `${route.routeKey}\0${subject.destination.toLowerCase()}`
      if (subjectKeys.has(key)) return false
      subjectKeys.add(key)
    }
    const evidenceIds = new Set<string>()
    for (const evidence of route.evidence) {
      if (
        typeof evidence?.evidenceId !== 'string' ||
        !evidence.evidenceId ||
        evidenceIds.has(evidence.evidenceId) ||
        !['historical_endpoint', 'historical_proxy'].includes(evidence.evidenceClass) ||
        typeof evidence.endpoint !== 'string' ||
        !evidence.endpoint ||
        (evidence.evidenceClass === 'historical_endpoint' && evidence.proxyLabel !== null) ||
        (evidence.evidenceClass === 'historical_proxy' &&
          (typeof evidence.proxyLabel !== 'string' || !evidence.proxyLabel)) ||
        !['available', 'abstain'].includes(evidence.historicalUse) ||
        evidence.retrospectiveOnly !== true ||
        evidence.prospectiveValidated !== false ||
        !Array.isArray(evidence.limits) ||
        evidence.limits.some((limit) => typeof limit !== 'string' || !limit)
      )
        return false
      if (!validStageEndpointEvidence(route, evidence)) return false
      if (!validExactDirectEvidence(route, evidence, report.asOfUtc)) return false
      if (evidence.evidenceId === 'susde_exact_request_to_mined_usde_payout_history') {
        const samples = asRecord(evidence.samples)
        const outcomes = asRecord(evidence.outcomes)
        const design = asRecord(evidence.design)
        const episodes = outcomes.episodes
        const issueSequences = new Set<number>()
        const payoutTransactions = new Set<string>()
        const holderCommitments = new Set<string>()
        if (
          route.routeKey !== 'USDe → Staked USDe [USDe]' ||
          route.subjects.length !== 1 ||
          route.subjects[0].destination.toLowerCase() !==
            '0x9d39a5de30e57443bff2a8307a4256c8797a3497' ||
          route.subjects[0].originalAsset.toLowerCase() !==
            '0x4c9edd5852cd905f086c759e8383e09bff1e68b3' ||
          evidence.evidenceClass !== 'historical_endpoint' ||
          evidence.endpoint !== 'same_holder_same_queue_request_to_mined_final_usde_payout' ||
          design.unit !== 'same_holder_same_queue_exact_raw_q_episode' ||
          design.paymentAsset !== 'USDe' ||
          design.localEvidenceAvailabilityClock !== 'unwitnessed_local_wall_clock' ||
          !Array.isArray(design.elapsedTimeIncludes) ||
          !design.elapsedTimeIncludes.includes('holder_action') ||
          !Array.isArray(episodes) ||
          episodes.length < 1 ||
          episodes.length > 5 ||
          count(samples.linkedRequestPayoutEpisodes) !== episodes.length ||
          episodes.some((entry) => {
            const episode = asRecord(entry)
            const issueSequence = Number(episode.issueSequence)
            const issueSha256 = String(episode.issueSha256 ?? '')
            const holderCommitment = String(episode.holderCommitment ?? '')
            const qRaw = String(episode.qRaw ?? '')
            const sidecarSha256 = String(episode.sidecarSha256 ?? '')
            const payoutTransactionHash = String(episode.payoutTransactionHash ?? '')
            const requestMs = Date.parse(String(episode.requestAtUtc))
            const payoutMs = Date.parse(String(episode.payoutAtUtc))
            const availableMs = Date.parse(String(episode.localEvidenceAvailableAtUtc))
            const asOfMs = report.asOfUtc == null ? Infinity : Date.parse(report.asOfUtc)
            const invalid =
              !Number.isSafeInteger(issueSequence) ||
              issueSequence < 1 ||
              !/^[0-9a-f]{64}$/.test(issueSha256) ||
              !/^[0-9a-f]{64}$/.test(holderCommitment) ||
              !/^[1-9][0-9]*$/.test(qRaw) ||
              !/^[0-9a-f]{64}$/.test(sidecarSha256) ||
              !/^0x[0-9a-f]{64}$/.test(payoutTransactionHash) ||
              !Number.isSafeInteger(requestMs) ||
              !Number.isSafeInteger(payoutMs) ||
              !Number.isSafeInteger(availableMs) ||
              !(requestMs < payoutMs && payoutMs <= availableMs && availableMs <= asOfMs) ||
              !Number.isSafeInteger(episode.observedRequestToPayoutSeconds) ||
              episode.observedRequestToPayoutSeconds !== Math.floor((payoutMs - requestMs) / 1_000)
            if (invalid) return true
            if (issueSequences.has(issueSequence) || payoutTransactions.has(payoutTransactionHash))
              return true
            issueSequences.add(issueSequence)
            payoutTransactions.add(payoutTransactionHash)
            holderCommitments.add(holderCommitment)
            return false
          }) ||
          count(samples.distinctHolderCommitments) !== holderCommitments.size ||
          !evidence.limits.includes('not_a_restriction_recovery_duration') ||
          !evidence.limits.includes('not_a_future_payment_probability_or_duration_forecast')
        )
          return false
      }
      evidenceIds.add(evidence.evidenceId)
    }
    const available = route.evidence.filter((evidence) => evidence.historicalUse === 'available')
    const exact = available.filter((evidence) => evidence.evidenceClass === 'historical_endpoint')
    const proxy = available.filter((evidence) => evidence.evidenceClass === 'historical_proxy')
    if (
      (route.promotion.historicalOutlook === 'eligible_exact_endpoint_history' && !exact.length) ||
      (route.promotion.historicalOutlook === 'eligible_proxy_history' &&
        (exact.length > 0 || !proxy.length)) ||
      (route.promotion.historicalOutlook === 'abstain' && available.length > 0)
    )
      return false
    if (route.promotion.historicalOutlook === 'eligible_exact_endpoint_history')
      exactEndpointHistoryRouteGroups += 1
    else if (route.promotion.historicalOutlook === 'eligible_proxy_history')
      proxyOnlyHistoryRouteGroups += 1
    else abstainingRouteGroups += 1
  }
  if (
    exactSubjects !== 68 ||
    subjectKeys.size !== 68 ||
    report.coverage.exactEndpointHistoryRouteGroups !== exactEndpointHistoryRouteGroups ||
    report.coverage.proxyOnlyHistoryRouteGroups !== proxyOnlyHistoryRouteGroups ||
    report.coverage.abstainingRouteGroups !== abstainingRouteGroups ||
    exactEndpointHistoryRouteGroups + proxyOnlyHistoryRouteGroups + abstainingRouteGroups !==
      report.coverage.routeGroups
  )
    return false

  const aaveUsde = report.routes.find(
    (route) => route.routeKey === DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey,
  )
  return (
    aaveUsde?.mechanism === 'atomic' &&
    aaveUsde.exactSubjects === 1 &&
    aaveUsde.subjects[0]?.destination.toLowerCase() ===
      DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination.toLowerCase() &&
    aaveUsde.subjects[0]?.originalAsset.toLowerCase() ===
      DIRECT_SUPPLY_MARKETS.aaveV3Usde.underlying.toLowerCase() &&
    aaveUsde.evidence.every(
      (evidence) =>
        evidence.evidenceId === 'bounded_mined_holder_payout_history' &&
        evidence.evidenceClass === 'historical_endpoint' &&
        evidence.endpoint === 'mined_final_asset_transfer_to_holder',
    )
  )
}

async function readLocalHistoricalSuite(): Promise<unknown> {
  const relativePath = 'scripts/research/holder-exit-historical-outlook-suite.mjs'
  const starts = [process.cwd(), process.env.INIT_CWD, process.env.PWD, __dirname].filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  )
  let modulePath: string | null = null
  for (const start of starts) {
    let directory = resolve(start)
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = resolve(directory, relativePath)
      if (existsSync(candidate)) {
        modulePath = candidate
        break
      }
      const parent = resolve(directory, '..')
      if (parent === directory) break
      directory = parent
    }
    if (modulePath) break
  }
  if (!modulePath) throw new Error('historical_outlook_reader_missing')
  const moduleUrl = pathToFileURL(modulePath).href
  const runner = [
    `const suiteModule = await import(${JSON.stringify(moduleUrl)})`,
    "if (typeof suiteModule.readOfflineHistoricalOutlook !== 'function') throw new Error('historical_outlook_reader_invalid')",
    'const report = await suiteModule.readOfflineHistoricalOutlook()',
    `process.stdout.write(${JSON.stringify(SUITE_MARKER)} + JSON.stringify(report))`,
  ].join(';')
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', runner],
    {
      cwd: resolve(dirname(modulePath), '../..'),
      encoding: 'utf8',
      maxBuffer: MAX_SUITE_BYTES,
      timeout: 90_000,
    },
  )
  const marker = stdout.lastIndexOf(SUITE_MARKER)
  if (marker < 0) throw new Error('historical_outlook_reader_invalid')
  return JSON.parse(stdout.slice(marker + SUITE_MARKER.length)) as unknown
}

export function createHolderExitHistoricalOutlookHandler(
  readSuite: SuiteReader = readLocalHistoricalSuite,
) {
  let cache: { report: HistoricalSuite; until: number } | null = null
  let loading: Promise<HistoricalSuite> | null = null

  async function verifiedReport(): Promise<HistoricalSuite> {
    if (cache && Date.now() < cache.until) return cache.report
    if (loading) return loading
    loading = Promise.resolve(readSuite()).then((value) => {
      if (!validSuite(value)) throw new Error('historical_outlook_suite_invalid')
      return value
    })
    try {
      const report = await loading
      cache = { report, until: Date.now() + CACHE_MS }
      return report
    } finally {
      loading = null
    }
  }

  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    res.setHeader('Cache-Control', 'no-store')
    if (!isLocalRequest(req))
      return res.status(503).json({ status: 'unavailable', reason: 'local_only' })
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return res.status(405).json({ status: 'unavailable', reason: 'get_only' })
    }
    const selected = parseSubject(req.query)
    if (!selected) return res.status(400).json({ status: 'unavailable', reason: 'invalid_subject' })

    try {
      const report = await verifiedReport()
      const routes = report.routes.filter((route) => route.routeKey === selected.routeKey)
      if (routes.length > 1)
        return res.status(503).json({ status: 'unavailable', reason: 'verification_unavailable' })
      if (routes.length === 0)
        return res.status(404).json({ status: 'unavailable', reason: 'subject_not_tracked' })
      const route = routes[0]
      const destinations = route.subjects.filter(
        (subject) => subject.destination.toLowerCase() === selected.destination,
      )
      if (destinations.length > 1 || route.subjects.length !== route.exactSubjects)
        return res.status(503).json({ status: 'unavailable', reason: 'verification_unavailable' })
      if (destinations.length === 0)
        return res.status(404).json({ status: 'unavailable', reason: 'subject_not_tracked' })

      const promotedEvidenceClass =
        route.promotion.historicalOutlook === 'eligible_exact_endpoint_history'
          ? 'historical_endpoint'
          : route.promotion.historicalOutlook === 'eligible_proxy_history'
            ? 'historical_proxy'
            : null
      const eligibleEvidence = route.evidence.flatMap((entry) => {
        const scoped = subjectBoundEvidence(entry, selected.destination, selected.requestedRaw)
        return scoped ? [scoped] : []
      })
      const directExactHistory = route.evidence.some(
        (entry) => entry.evidenceId === 'exact_holder_final_asset_withdraw_call_history',
      )
      const evidence =
        strongestEvidence(eligibleEvidence, promotedEvidenceClass) ??
        (directExactHistory ? strongestEvidence(eligibleEvidence, 'historical_proxy') : null)
      if (
        promotedEvidenceClass &&
        !evidence &&
        !strongestEvidence(route.evidence, promotedEvidenceClass)
      )
        return res.status(503).json({ status: 'unavailable', reason: 'verification_unavailable' })
      const historicalOutlook = evidence
        ? evidence.evidenceClass === 'historical_endpoint'
          ? 'eligible_exact_endpoint_history'
          : 'eligible_proxy_history'
        : 'abstain'
      return res.status(200).json({
        status: 'available',
        routeKey: route.routeKey,
        destination: selected.destination,
        requestedRaw: selected.requestedRaw,
        routeGroup: {
          mechanism: route.mechanism,
          exactSubjects: route.exactSubjects,
          scope:
            evidence?.evidenceId === 'morpho_fixed_10k_holder_call_ledger' ||
            route.exactSubjects === 1
              ? 'exact_destination_route'
              : 'route_group',
          historicalOutlook,
        },
        evidence: evidence ? normalizeEvidence(evidence) : null,
        provenance: {
          source: 'local_historical_artifacts',
          claimClass: report.claimClass,
          manifestSha256: report.manifestSha256,
          mechanismVersion: report.mechanismVersion,
          routeGroups: report.coverage.routeGroups,
          exactSubjects: report.coverage.exactSubjects,
          frozenCohortRouteGroups: report.coverage.frozenCohortRouteGroups,
          frozenCohortExactSubjects: report.coverage.frozenCohortExactSubjects,
          supplementalRouteGroups: report.coverage.supplementalRouteGroups,
          supplementalExactSubjects: report.coverage.supplementalExactSubjects,
          exactEndpointHistoryRouteGroups: report.coverage.exactEndpointHistoryRouteGroups,
          proxyOnlyHistoryRouteGroups: report.coverage.proxyOnlyHistoryRouteGroups,
          abstainingRouteGroups: report.coverage.abstainingRouteGroups,
        },
      })
    } catch {
      return res.status(503).json({ status: 'unavailable', reason: 'verification_unavailable' })
    }
  }
}

export default createHolderExitHistoricalOutlookHandler()
