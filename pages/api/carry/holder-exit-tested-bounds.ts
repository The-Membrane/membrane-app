import type { NextApiRequest, NextApiResponse } from 'next'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const ADDRESS = /^0x[0-9a-f]{40}$/
const ADDRESS_QUERY = /^0x[0-9a-fA-F]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const RAW_AMOUNT = /^(0|[1-9]\d*)$/
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
const MAX_REPORT_BYTES = 8 * 1024 * 1024
const MAX_ROWS = 20_000
const MAX_HORIZONS = 32
const MAX_TIERS = 128
const MAX_UINT256 = (1n << 256n) - 1n
const CANONICAL_ROUTE_STAGES: Readonly<Record<string, string>> = {
  'apxUSD → ApyUSD [apxUSD]': 'apyusd_withdraw_initiation_eth_call',
  'AUSD → Staked USDat [USDat]': 'staked_usdat_redeem_eth_call',
  'AUSD → VaultV2 [AUSD]': 'direct_morpho_vaultv2_withdraw_eth_call',
  'EURCV → VaultV2 [EURCV]': 'direct_morpho_vaultv2_withdraw_eth_call',
  'GHO → fToken [GHO]': 'direct_fluid_ftoken_withdraw_eth_call',
  'GHO → sGho [GHO]': 'direct_sgho_withdraw_eth_call',
  'GHO → UmbrellaStakeToken [GHO]': 'direct_umbrella_redeem_eth_call',
  'LINK → VaultV2 [LINK]': 'direct_morpho_vaultv2_withdraw_eth_call',
  'PYUSD → StakingVault [wYLDS]': 'pyusd_staking_first_stage_eth_call',
  'PYUSD → VaultV2 [PYUSD]': 'direct_morpho_vaultv2_withdraw_eth_call',
  'RLUSD → VaultV2 [RLUSD]': 'direct_morpho_vaultv2_withdraw_eth_call',
  'USDC → Fluid USD Coin [USDC]': 'direct_fluid_ftoken_withdraw_eth_call',
  'USDC → FluidBridgeAggregatorProxy [USDC]': 'fluid_bridge_usdc_first_leg_eth_call',
  'USDC → supply on Aave V3': 'direct_aave_withdraw_eth_call',
  'USDC → supply on Compound v3': 'direct_compound_v3_withdraw_eth_call',
  'USDC → USD3 [USDC]': 'direct_usd3_withdraw_eth_call',
  'USDC → VaultV2 [USDC]': 'direct_morpho_vaultv2_withdraw_eth_call',
  'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]': 'twyne_pt_borrower_first_leg_eth_call',
  'USDe → Staked USDe [USDe]': 'susde_pending_unstake_eth_call',
  'USDS → StUsds [USDS]': 'direct_stusds_withdraw_eth_call',
  'USDS → SUsds [USDS]': 'direct_susds_withdraw_eth_call',
  'USDT → FluidBridgeAggregatorProxy [USDC]': 'fluid_bridge_usdt_first_leg_eth_call',
  'USDT → fToken [USDT]': 'direct_fluid_ftoken_withdraw_eth_call',
  'USDT → supply on Spark': 'direct_spark_withdraw_eth_call',
  'USDT → VaultV2 [USDT]': 'direct_morpho_vaultv2_withdraw_eth_call',
}
const FLUID_BRIDGE_VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const USDC_ASSET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const FLUID_FIRST_LEG_UNIT = 'USDC_first_leg_assets'
const APYUSD_ROUTE = 'apxUSD → ApyUSD [apxUSD]'
const APYUSD_STAGE = 'apyusd_withdraw_initiation_eth_call'
const APYUSD_VAULT = '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'
const APXUSD_ASSET = '0x98a878b1cd98131b271883b390f68d2c90674665'
const APXUSD_ASSET_UNIT = 'apxUSD_assets'

function isComparableAssayedAssetUnit(subject: TestedSubject, qUnit: string | null): boolean {
  const apyUsdStage =
    subject.routeKey === APYUSD_ROUTE &&
    subject.stageScope === APYUSD_STAGE &&
    subject.destination === APYUSD_VAULT &&
    subject.asset === APXUSD_ASSET
  if (apyUsdStage) return qUnit === APXUSD_ASSET_UNIT
  const fluidStage =
    (subject.routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]' &&
      subject.stageScope === 'fluid_bridge_usdc_first_leg_eth_call') ||
    (subject.routeKey === 'USDT → FluidBridgeAggregatorProxy [USDC]' &&
      subject.stageScope === 'fluid_bridge_usdt_first_leg_eth_call')
  if (!fluidStage) return qUnit === 'asset_raw'
  return (
    qUnit === FLUID_FIRST_LEG_UNIT &&
    subject.destination === FLUID_BRIDGE_VAULT &&
    subject.asset === USDC_ASSET &&
    fluidStage
  )
}
const execFileAsync = promisify(execFile)

type RecordValue = Record<string, unknown>
type ReportReader = () => Promise<unknown>

type TestedEnvelope = {
  horizonHours: number
  boundEligibleCohorts: number
  uniqueIssueClusters: number
  measuredCells: number
  qUnit: string | null
  unitStatus: 'missing' | 'recorded'
  displayComparableAssetAmount: boolean
  testedCallableLowerBoundMinRaw: string
  testedCallableLowerBoundMedianRaw: string
  testedCallableLowerBoundMaxRaw: string
  orderStatistic: 'min_lower_median_max'
  orderStatisticBasis: 'descriptive_sample'
  populationQuantile: false
  zeroSentinelMeansNoCallableTestedTier: true
  noCallableTestedTierCohorts: number
  aboveTestCeilingUnknownCohorts: number
  cohorts: unknown[]
}

type PrimaryAssay = {
  issueClusterSha256: string
  holderCommitment: string | null
  qRaw: string
  qUnit: string | null
  horizonHours: number
  baselineState: string | null
  outcomeState: string
  censorReason: string | null
}

type SampledStateEvidence = {
  attemptedTrajectories: number
  measuredTrajectories: number
  observedDifferentStateWindows: number
  sameStateAtLastSampleTrajectories: number
  abstentions: Record<string, number>
  durationProjection: null
  observations: Array<{
    issueClusterSha256: string
    holderCommitment: string
    qRaw: string
    qUnit: string | null
    baselineState: 'simulated_callable' | 'simulated_impaired'
    lastSameStateSampleHours: number | null
    lastSameStateObservedAtUtc: string | null
    differentStateObservedAtUtc: string | null
    observedDifferentStateWindow: {
      afterObservedAtUtc: string
      byObservedAtUtc: string
      lastSameStatePlannedHorizonHours: number | null
      differentStatePlannedHorizonHours: number
    } | null
  }>
}

type DerivedCohort = {
  issueClusterSha256: string
  measuredCells: number
  lowerBoundRaw: string
  noCallable: boolean
  aboveTestCeilingUnknown: boolean
}

type TestedSubject = {
  routeKey: string
  destination: string
  asset: string
  subject: string
  stageScope: string
  status:
    | 'no_episodes'
    | 'historical_tested_bounds'
    | 'no_eligible_tested_bounds'
    | 'no_fully_measured_present_cohorts'
  rawRows: number
  primaryRows: number
  historicalTestedAmountBoundsByHorizon: TestedEnvelope[] | null
  primaryAssays: PrimaryAssay[]
  sampledStateEvidence: SampledStateEvidence
  amountProjection: null
  durationProjection: null
}

type TestedBoundsReport = {
  version: 3
  scope: 'historical_tested_amount_bounds'
  claimClass: 'historical_tested_callable_lower_bounds'
  sourceVerification: 'offline_sealed_replay'
  manifestSha256: string
  historicalDataThroughUtc: string
  historicalDataThroughClockBasis: 'saved_local_panel_clocks'
  historicalDataThroughIndependentlyWitnessed: false
  prospectiveValidated: false
  forecastValidated: false
  statisticalIndependenceValidated: false
  populationQuantile: false
  holderExecutableCapacity: false
  routeLevelProbability: null
  amountProjection: null
  durationProjection: null
  expectedIssuedQLadderVerified: false
  summary: {
    routeGroups: 25
    exactSubjects: 67
    rawRows: number
  }
  subjects: TestedSubject[]
}

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : null
}

function boundedCount(value: unknown, maximum = MAX_ROWS): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
}

function boundedText(value: unknown, maximum = 200): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/[\x00-\x1f\x7f]/.test(value)
  )
}

function validRawAmount(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 78 &&
    RAW_AMOUNT.test(value) &&
    BigInt(value) <= MAX_UINT256
  )
}

function validUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value
}

function validUnit(value: unknown): value is string | null {
  return value === null || (boundedText(value, 80) && !value.includes('\0'))
}

function validAbstentions(value: unknown): boolean {
  const record = asRecord(value)
  return Boolean(
    record &&
    Object.keys(record).length <= 32 &&
    Object.entries(record).every(([key, count]) => boundedText(key, 80) && boundedCount(count)),
  )
}

function deriveCohort(value: unknown, envelope: TestedEnvelope): DerivedCohort | null {
  const cohort = asRecord(value)
  if (!cohort) return null
  const tiers = cohort.testedTiers
  if (
    !SHA256.test(String(cohort.issueClusterSha256 ?? '')) ||
    !SHA256.test(String(cohort.holderCommitment ?? '')) ||
    cohort.horizonHours !== envelope.horizonHours ||
    cohort.qUnit !== envelope.qUnit ||
    !boundedCount(cohort.measuredCells) ||
    !validRawAmount(cohort.testedCallableLowerBoundRaw) ||
    typeof cohort.noCallableTestedTier !== 'boolean' ||
    typeof cohort.aboveTestCeilingUnknown !== 'boolean' ||
    !Array.isArray(tiers) ||
    tiers.length === 0 ||
    tiers.length > MAX_TIERS ||
    cohort.measuredCells !== tiers.length
  )
    return null

  let previousRaw: bigint | null = null
  let impairedSeen = false
  let highestCallable: {
    qRaw: string
    tierRank: number
    qCaseLabel: string | null
  } | null = null
  for (const [index, value] of tiers.entries()) {
    const tier = asRecord(value)
    if (
      !tier ||
      !validRawAmount(tier.qRaw) ||
      tier.qRaw === '0' ||
      !boundedCount(tier.tierRank, MAX_TIERS) ||
      tier.tierRank !== index + 1 ||
      typeof tier.callable !== 'boolean' ||
      !['simulated_callable', 'simulated_impaired'].includes(String(tier.baselineState)) ||
      tier.outcomeState !== (tier.callable ? 'simulated_callable' : 'simulated_impaired') ||
      (tier.qCaseLabel !== null && !boundedText(tier.qCaseLabel, 80))
    )
      return null
    const raw = BigInt(tier.qRaw)
    if (previousRaw !== null && raw <= previousRaw) return null
    previousRaw = raw
    if (!tier.callable) {
      impairedSeen = true
    } else {
      if (impairedSeen) return null
      highestCallable = {
        qRaw: tier.qRaw,
        tierRank: tier.tierRank,
        qCaseLabel: tier.qCaseLabel === null ? null : String(tier.qCaseLabel),
      }
    }
  }

  const lowerBoundRaw = highestCallable?.qRaw ?? '0'
  const noCallable = highestCallable === null
  const aboveTestCeilingUnknown = Boolean(asRecord(tiers.at(-1))?.callable)
  if (
    cohort.testedCallableLowerBoundRaw !== lowerBoundRaw ||
    cohort.testedCallableTierRank !== (highestCallable?.tierRank ?? null) ||
    cohort.testedCallableTierLabel !== (highestCallable?.qCaseLabel ?? null) ||
    cohort.noCallableTestedTier !== noCallable ||
    cohort.aboveTestCeilingUnknown !== aboveTestCeilingUnknown
  )
    return null
  return {
    issueClusterSha256: String(cohort.issueClusterSha256),
    measuredCells: Number(cohort.measuredCells),
    lowerBoundRaw,
    noCallable,
    aboveTestCeilingUnknown,
  }
}

function validEnvelope(value: unknown): value is TestedEnvelope {
  const envelope = asRecord(value)
  if (!envelope) return false
  const min = envelope.testedCallableLowerBoundMinRaw
  const median = envelope.testedCallableLowerBoundMedianRaw
  const max = envelope.testedCallableLowerBoundMaxRaw
  if (
    !Number.isSafeInteger(envelope.horizonHours) ||
    Number(envelope.horizonHours) < 1 ||
    Number(envelope.horizonHours) > 720 ||
    !boundedCount(envelope.boundEligibleCohorts) ||
    envelope.boundEligibleCohorts === 0 ||
    !boundedCount(envelope.uniqueIssueClusters) ||
    !boundedCount(envelope.measuredCells) ||
    !validUnit(envelope.qUnit) ||
    !['missing', 'recorded'].includes(String(envelope.unitStatus)) ||
    (envelope.unitStatus === 'missing') !== (envelope.qUnit === null) ||
    typeof envelope.displayComparableAssetAmount !== 'boolean' ||
    envelope.displayComparableAssetAmount !== (envelope.qUnit === 'asset_raw') ||
    !validRawAmount(min) ||
    !validRawAmount(median) ||
    !validRawAmount(max) ||
    BigInt(min) > BigInt(median) ||
    BigInt(median) > BigInt(max) ||
    envelope.orderStatistic !== 'min_lower_median_max' ||
    envelope.orderStatisticBasis !== 'descriptive_sample' ||
    envelope.populationQuantile !== false ||
    envelope.zeroSentinelMeansNoCallableTestedTier !== true ||
    !boundedCount(envelope.noCallableTestedTierCohorts) ||
    !boundedCount(envelope.aboveTestCeilingUnknownCohorts) ||
    Number(envelope.noCallableTestedTierCohorts) > Number(envelope.boundEligibleCohorts) ||
    Number(envelope.aboveTestCeilingUnknownCohorts) > Number(envelope.boundEligibleCohorts) ||
    !Array.isArray(envelope.cohorts) ||
    envelope.cohorts.length !== envelope.boundEligibleCohorts
  )
    return false
  const derived = envelope.cohorts.map((cohort) => deriveCohort(cohort, envelope as TestedEnvelope))
  if (derived.some((cohort) => cohort === null)) return false
  const cohorts = derived as DerivedCohort[]
  const identities = new Set(
    envelope.cohorts.map((value) => {
      const cohort = asRecord(value)!
      const tierRaws = (cohort.testedTiers as unknown[])
        .map((tier) => String(asRecord(tier)?.qRaw))
        .join(',')
      return `${cohort.issueClusterSha256}\0${cohort.holderCommitment}\0${tierRaws}`
    }),
  )
  if (identities.size !== cohorts.length) return false
  const amounts = cohorts
    .map((cohort) => cohort.lowerBoundRaw)
    .sort((left, right) => {
      const a = BigInt(left)
      const b = BigInt(right)
      return a < b ? -1 : a > b ? 1 : 0
    })
  return (
    min === amounts[0] &&
    median === amounts[Math.floor((amounts.length - 1) / 2)] &&
    max === amounts.at(-1) &&
    envelope.measuredCells === cohorts.reduce((sum, cohort) => sum + cohort.measuredCells, 0) &&
    envelope.uniqueIssueClusters ===
      new Set(cohorts.map((cohort) => cohort.issueClusterSha256)).size &&
    envelope.noCallableTestedTierCohorts === cohorts.filter((cohort) => cohort.noCallable).length &&
    envelope.aboveTestCeilingUnknownCohorts ===
      cohorts.filter((cohort) => cohort.aboveTestCeilingUnknown).length
  )
}

function validSampledState(value: unknown): value is SampledStateEvidence {
  const state = asRecord(value)
  if (!state) return false
  if (
    !boundedCount(state.attemptedTrajectories) ||
    !boundedCount(state.measuredTrajectories) ||
    !boundedCount(state.observedDifferentStateWindows) ||
    !boundedCount(state.sameStateAtLastSampleTrajectories) ||
    Number(state.measuredTrajectories) > Number(state.attemptedTrajectories) ||
    !validAbstentions(state.abstentions) ||
    state.durationProjection !== null ||
    !Array.isArray(state.observations) ||
    state.observations.length !== state.measuredTrajectories
  )
    return false

  const abstentionCount = Object.values(state.abstentions as Record<string, number>).reduce(
    (sum, count) => sum + count,
    0,
  )
  if (state.attemptedTrajectories !== state.observations.length + abstentionCount) return false
  let differentStateWindows = 0
  let sameStateAtLastSample = 0
  const valid = state.observations.every((value) => {
    const observation = asRecord(value)
    if (
      !observation ||
      !SHA256.test(String(observation.issueClusterSha256 ?? '')) ||
      !SHA256.test(String(observation.holderCommitment ?? '')) ||
      !validRawAmount(observation.qRaw) ||
      !validUnit(observation.qUnit) ||
      !['simulated_callable', 'simulated_impaired'].includes(String(observation.baselineState)) ||
      !boundedCount(observation.measuredHorizons, MAX_HORIZONS) ||
      Number(observation.measuredHorizons) === 0 ||
      (observation.lastSameStateSampleHours !== null &&
        (!Number.isSafeInteger(observation.lastSameStateSampleHours) ||
          Number(observation.lastSameStateSampleHours) < 1 ||
          Number(observation.lastSameStateSampleHours) > 720)) ||
      (observation.lastSameStateObservedAtUtc !== null &&
        !validUtc(observation.lastSameStateObservedAtUtc)) ||
      (observation.differentStateObservedAtUtc !== null &&
        !validUtc(observation.differentStateObservedAtUtc))
    )
      return false

    const window = asRecord(observation.observedDifferentStateWindow)
    if (observation.differentStateObservedAtUtc === null) {
      if (observation.observedDifferentStateWindow !== null) return false
      if (
        observation.lastSameStateSampleHours === null ||
        !validUtc(observation.lastSameStateObservedAtUtc)
      )
        return false
      sameStateAtLastSample += 1
      return true
    }
    if (!window) {
      return (
        observation.observedDifferentStateWindow === null &&
        observation.lastSameStateSampleHours === null &&
        observation.lastSameStateObservedAtUtc === null
      )
    }
    if (
      !validUtc(window.afterObservedAtUtc) ||
      !validUtc(window.byObservedAtUtc) ||
      Date.parse(window.afterObservedAtUtc) >= Date.parse(window.byObservedAtUtc) ||
      window.byObservedAtUtc !== observation.differentStateObservedAtUtc ||
      !Number.isSafeInteger(window.differentStatePlannedHorizonHours) ||
      Number(window.differentStatePlannedHorizonHours) < 1 ||
      Number(window.differentStatePlannedHorizonHours) > 720
    )
      return false
    if (observation.lastSameStateSampleHours === null) {
      if (
        observation.lastSameStateObservedAtUtc !== null ||
        window.lastSameStatePlannedHorizonHours !== null
      )
        return false
    } else if (
      window.afterObservedAtUtc !== observation.lastSameStateObservedAtUtc ||
      window.lastSameStatePlannedHorizonHours !== observation.lastSameStateSampleHours ||
      !Number.isSafeInteger(window.lastSameStatePlannedHorizonHours) ||
      Number(window.lastSameStatePlannedHorizonHours) < 1 ||
      Number(window.lastSameStatePlannedHorizonHours) > 720 ||
      Number(window.lastSameStatePlannedHorizonHours) >=
        Number(window.differentStatePlannedHorizonHours)
    )
      return false
    differentStateWindows += 1
    return true
  })
  const differentStateWithoutWindow =
    state.observations.length - differentStateWindows - sameStateAtLastSample
  return (
    valid &&
    differentStateWithoutWindow >= 0 &&
    state.measuredTrajectories ===
      differentStateWindows + differentStateWithoutWindow + sameStateAtLastSample &&
    state.observedDifferentStateWindows === differentStateWindows &&
    state.sameStateAtLastSampleTrajectories === sameStateAtLastSample
  )
}

function validPrimaryAssay(value: unknown): value is PrimaryAssay {
  const row = asRecord(value)
  if (!row) return false
  const measured = ['simulated_callable', 'simulated_impaired'].includes(String(row.outcomeState))
  return Boolean(
    SHA256.test(String(row.issueClusterSha256 ?? '')) &&
    (row.holderCommitment === null || SHA256.test(String(row.holderCommitment ?? ''))) &&
    validRawAmount(row.qRaw) &&
    row.qRaw !== '0' &&
    validUnit(row.qUnit) &&
    Number.isSafeInteger(row.horizonHours) &&
    Number(row.horizonHours) >= 1 &&
    Number(row.horizonHours) <= 720 &&
    (row.baselineState === null || boundedText(row.baselineState, 80)) &&
    boundedText(row.outcomeState, 80) &&
    (measured
      ? row.censorReason === null && row.baselineState !== null
      : boundedText(row.censorReason, 80)),
  )
}

function validSubject(value: unknown): value is TestedSubject {
  const subject = asRecord(value)
  if (!subject) return false
  if (
    !boundedText(subject.routeKey) ||
    !ADDRESS.test(String(subject.destination ?? '')) ||
    !ADDRESS.test(String(subject.asset ?? '')) ||
    subject.subject !== `${subject.routeKey}\0${subject.destination}\0${subject.asset}` ||
    CANONICAL_ROUTE_STAGES[String(subject.routeKey)] !== subject.stageScope ||
    ![
      'no_episodes',
      'historical_tested_bounds',
      'no_eligible_tested_bounds',
      'no_fully_measured_present_cohorts',
    ].includes(String(subject.status)) ||
    !boundedCount(subject.rawRows) ||
    !boundedCount(subject.primaryRows) ||
    Number(subject.primaryRows) > Number(subject.rawRows) ||
    !Array.isArray(subject.primaryAssays) ||
    subject.primaryAssays.length !== subject.primaryRows ||
    !subject.primaryAssays.every(validPrimaryAssay) ||
    subject.amountProjection !== null ||
    subject.durationProjection !== null ||
    !validSampledState(subject.sampledStateEvidence)
  )
    return false
  const envelopes = subject.historicalTestedAmountBoundsByHorizon
  if (envelopes !== null) {
    if (!Array.isArray(envelopes) || envelopes.length === 0 || envelopes.length > MAX_HORIZONS)
      return false
    const identities = new Set<string>()
    for (const envelope of envelopes) {
      if (!validEnvelope(envelope)) return false
      const identity = `${envelope.horizonHours}\0${envelope.qUnit ?? 'missing'}`
      if (identities.has(identity)) return false
      identities.add(identity)
      for (const rawCohort of envelope.cohorts) {
        const cohort = asRecord(rawCohort)!
        for (const rawTier of cohort.testedTiers as unknown[]) {
          const tier = asRecord(rawTier)!
          if (
            !subject.primaryAssays.some(
              (row: PrimaryAssay) =>
                row.issueClusterSha256 === cohort.issueClusterSha256 &&
                row.holderCommitment === cohort.holderCommitment &&
                row.horizonHours === envelope.horizonHours &&
                row.qUnit === envelope.qUnit &&
                row.qRaw === tier.qRaw &&
                row.baselineState === tier.baselineState &&
                row.outcomeState === tier.outcomeState,
            )
          )
            return false
        }
      }
    }
  }
  if (subject.status === 'no_episodes')
    return (
      subject.rawRows === 0 &&
      subject.primaryRows === 0 &&
      envelopes === null &&
      subject.sampledStateEvidence.attemptedTrajectories === 0 &&
      subject.sampledStateEvidence.measuredTrajectories === 0 &&
      subject.sampledStateEvidence.observations.length === 0 &&
      Object.keys(subject.sampledStateEvidence.abstentions).length === 0
    )
  if (subject.rawRows === 0) return false
  return subject.status === 'historical_tested_bounds' ? envelopes !== null : envelopes === null
}

function validReport(value: unknown): value is TestedBoundsReport {
  const report = asRecord(value)
  const summary = asRecord(report?.summary)
  if (
    !report ||
    report.version !== 3 ||
    report.scope !== 'historical_tested_amount_bounds' ||
    report.claimClass !== 'historical_tested_callable_lower_bounds' ||
    report.sourceVerification !== 'offline_sealed_replay' ||
    !SHA256.test(String(report.manifestSha256 ?? '')) ||
    !validUtc(report.historicalDataThroughUtc) ||
    report.historicalDataThroughClockBasis !== 'saved_local_panel_clocks' ||
    report.historicalDataThroughIndependentlyWitnessed !== false ||
    report.prospectiveValidated !== false ||
    report.forecastValidated !== false ||
    report.statisticalIndependenceValidated !== false ||
    report.populationQuantile !== false ||
    report.holderExecutableCapacity !== false ||
    report.routeLevelProbability !== null ||
    report.amountProjection !== null ||
    report.durationProjection !== null ||
    report.expectedIssuedQLadderVerified !== false ||
    !summary ||
    summary.routeGroups !== 25 ||
    summary.exactSubjects !== 67 ||
    !boundedCount(summary.rawRows) ||
    !Array.isArray(report.subjects) ||
    report.subjects.length !== 67 ||
    !report.subjects.every(validSubject)
  )
    return false

  const subjects = report.subjects as TestedSubject[]
  const identities = new Set<string>()
  const selections = new Set<string>()
  let totalRows = 0
  for (const subject of subjects) {
    const identity = `${subject.routeKey}\0${subject.destination}\0${subject.asset}`
    const selection = `${subject.routeKey}\0${subject.destination}`
    if (identities.has(identity) || selections.has(selection)) return false
    identities.add(identity)
    selections.add(selection)
    totalRows += subject.rawRows
    if (totalRows > MAX_ROWS) return false
  }
  return (
    totalRows === summary.rawRows &&
    new Set(subjects.map((subject) => subject.routeKey)).size === 25
  )
}

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

function parseSelection(query: NextApiRequest['query']) {
  if (
    Object.keys(query).length !== 4 ||
    !('routeKey' in query) ||
    !('destination' in query) ||
    !('horizonHours' in query) ||
    !('requestedRaw' in query)
  )
    return null
  const { routeKey, destination, horizonHours, requestedRaw } = query
  if (
    !boundedText(routeKey) ||
    typeof destination !== 'string' ||
    !ADDRESS_QUERY.test(destination) ||
    !validRawAmount(requestedRaw) ||
    requestedRaw === '0' ||
    typeof horizonHours !== 'string' ||
    !/^[1-9]\d{0,2}$/.test(horizonHours)
  )
    return null
  const hours = Number(horizonHours)
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) return null
  return { routeKey, destination: destination.toLowerCase(), horizonHours: hours, requestedRaw }
}

async function readLocalTestedBounds(): Promise<unknown> {
  const relativePath = 'scripts/research/holder-exit-historical-projection.mjs'
  const starts = [process.cwd(), process.env.INIT_CWD, process.env.PWD, __dirname].filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  )
  let scriptPath: string | null = null
  for (const start of starts) {
    let directory = resolve(start)
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = resolve(directory, relativePath)
      if (existsSync(candidate)) {
        scriptPath = candidate
        break
      }
      const parent = resolve(directory, '..')
      if (parent === directory) break
      directory = parent
    }
    if (scriptPath) break
  }
  if (!scriptPath) throw new Error('holder_exit_tested_bounds_reader_missing')
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', scriptPath], {
    cwd: resolve(dirname(scriptPath), '../..'),
    encoding: 'utf8',
    maxBuffer: MAX_REPORT_BYTES,
    timeout: 90_000,
  })
  return JSON.parse(stdout.trim()) as unknown
}

function amountAtHorizon(subject: TestedSubject, horizonHours: number) {
  const matching = (subject.historicalTestedAmountBoundsByHorizon ?? []).filter(
    (entry) => entry.horizonHours === horizonHours,
  )
  if (!matching.length)
    return { testedAmountAtHorizon: null, amountReason: 'no_exact_horizon' as const }
  if (matching.length !== 1)
    return { testedAmountAtHorizon: null, amountReason: 'ambiguous_unit' as const }
  const envelope = matching[0]
  if (
    !isComparableAssayedAssetUnit(subject, envelope.qUnit) ||
    envelope.unitStatus !== 'recorded' ||
    (envelope.qUnit === 'asset_raw' && !envelope.displayComparableAssetAmount)
  )
    return { testedAmountAtHorizon: null, amountReason: 'unit_not_comparable' as const }
  return {
    testedAmountAtHorizon: {
      assertion: 'historical_tested_callable_lower_bounds',
      horizonHours,
      unit: 'asset_raw',
      orderStatistic: 'min_lower_median_max',
      descriptiveSample: true,
      populationQuantile: false,
      minRawLowerBound: envelope.testedCallableLowerBoundMinRaw,
      medianRawLowerBound: envelope.testedCallableLowerBoundMedianRaw,
      maxRawLowerBound: envelope.testedCallableLowerBoundMaxRaw,
      eligibleCohortCount: envelope.boundEligibleCohorts,
      measuredCellCount: envelope.measuredCells,
      noCallableCohortCount: envelope.noCallableTestedTierCohorts,
      aboveTestCeilingUnknownCohortCount: envelope.aboveTestCeilingUnknownCohorts,
    },
    amountReason: null,
  }
}

function exactQAtHorizon(subject: TestedSubject, horizonHours: number, requestedRaw: string) {
  const rows = subject.primaryAssays.filter(
    (row) =>
      row.horizonHours === horizonHours &&
      isComparableAssayedAssetUnit(subject, row.qUnit) &&
      row.qRaw === requestedRaw &&
      ['simulated_callable', 'simulated_impaired', 'censored', 'missing', 'inconclusive'].includes(
        row.outcomeState,
      ),
  )
  if (!rows.length) return null
  const transitions = {
    callableToCallable: 0,
    callableToImpaired: 0,
    impairedToImpaired: 0,
    impairedToCallable: 0,
  }
  const censorReasons: Record<string, number> = {}
  for (const row of rows) {
    if (row.baselineState === 'simulated_callable' && row.outcomeState === 'simulated_callable')
      transitions.callableToCallable += 1
    else if (
      row.baselineState === 'simulated_callable' &&
      row.outcomeState === 'simulated_impaired'
    )
      transitions.callableToImpaired += 1
    else if (
      row.baselineState === 'simulated_impaired' &&
      row.outcomeState === 'simulated_impaired'
    )
      transitions.impairedToImpaired += 1
    else if (
      row.baselineState === 'simulated_impaired' &&
      row.outcomeState === 'simulated_callable'
    )
      transitions.impairedToCallable += 1
    else {
      const reason = row.censorReason ?? `baseline_${row.baselineState ?? 'unavailable'}`
      censorReasons[reason] = (censorReasons[reason] ?? 0) + 1
    }
  }
  return {
    assertion: 'historical_exact_q_primary_assays' as const,
    recordedPrimaryCells: rows.length,
    uniqueIssueClustersUpperBound: new Set(rows.map((row) => row.issueClusterSha256)).size,
    correlatedRowsNonIndependent: true as const,
    transitions,
    censorReasons,
  }
}

function qLadderRelation(subject: TestedSubject, horizonHours: number, requestedRaw: string) {
  const envelope = subject.historicalTestedAmountBoundsByHorizon?.find(
    (entry) =>
      entry.horizonHours === horizonHours && isComparableAssayedAssetUnit(subject, entry.qUnit),
  )
  if (!envelope) return null
  const counts = {
    withinCallableLowerBound: 0,
    atOrAboveImpairedTier: 0,
    betweenTestedTiers: 0,
    aboveTestedCeiling: 0,
    belowImpairedFloor: 0,
  }
  const requested = BigInt(requestedRaw)
  for (const rawCohort of envelope.cohorts) {
    const cohort = asRecord(rawCohort)!
    const tiers = cohort.testedTiers as RecordValue[]
    const callable = tiers.filter((tier) => tier.callable)
    const impaired = tiers.filter((tier) => !tier.callable)
    const highestCallable = callable.at(-1)
    const firstImpaired = impaired[0]
    if (highestCallable && requested <= BigInt(String(highestCallable.qRaw)))
      counts.withinCallableLowerBound += 1
    else if (firstImpaired && requested >= BigInt(String(firstImpaired.qRaw)))
      counts.atOrAboveImpairedTier += 1
    else if (!highestCallable) counts.belowImpairedFloor += 1
    else if (!firstImpaired) counts.aboveTestedCeiling += 1
    else counts.betweenTestedTiers += 1
  }
  return {
    assertion: 'historical_monotone_tested_ladder_relation' as const,
    eligibleCohorts: envelope.boundEligibleCohorts,
    uniqueIssueClustersUpperBound: envelope.uniqueIssueClusters,
    correlatedRowsNonIndependent: true as const,
    counts,
  }
}

function sampledState(subject: TestedSubject, requestedRaw: string) {
  const source = subject.sampledStateEvidence
  const observations = source.observations.filter(
    (row) => isComparableAssayedAssetUnit(subject, row.qUnit) && row.qRaw === requestedRaw,
  )
  if (!observations.length)
    return { sampledState: null, stateReason: 'no_measured_samples' as const }
  const checkpoints = new Map<number, number>()
  let differentStateWindowCount = 0
  let sameStateAtLastSampleCount = 0
  for (const row of observations) {
    if (row.observedDifferentStateWindow !== null) differentStateWindowCount += 1
    if (row.differentStateObservedAtUtc === null) sameStateAtLastSampleCount += 1
    if (row.lastSameStateSampleHours === null) continue
    checkpoints.set(
      row.lastSameStateSampleHours,
      (checkpoints.get(row.lastSameStateSampleHours) ?? 0) + 1,
    )
  }
  const checkpointCounts = [...checkpoints]
    .sort(([left], [right]) => left - right)
    .map(([hours, count]) => ({ hours, count }))
  const differentStateWithoutWindowCount =
    observations.length - differentStateWindowCount - sameStateAtLastSampleCount
  return {
    sampledState: {
      assertion: 'historical_sampled_state_only',
      attemptedTrajectoryCount: observations.length,
      measuredTrajectoryCount: observations.length,
      differentStateWindowCount,
      differentStateWithoutWindowCount,
      sameStateAtLastSampleCount,
      lastSameStateSampleCheckpointCounts: checkpointCounts,
      maxLastSameStateSampleHours: checkpointCounts.at(-1)?.hours ?? null,
      observations: observations.map((row) => ({
        baselineState: row.baselineState,
        lastSameStateSampleHours: row.lastSameStateSampleHours,
        lastSameStateObservedAtUtc: row.lastSameStateObservedAtUtc,
        differentStateObservedAtUtc: row.differentStateObservedAtUtc,
        firstObservedDifferentStateWindow: row.observedDifferentStateWindow,
        sameStateAtLastSample: row.differentStateObservedAtUtc === null,
      })),
      durationProjection: null,
    },
    stateReason: null,
  }
}

export function createHolderExitTestedBoundsHandler(
  readReport: ReportReader = readLocalTestedBounds,
) {
  let cache: { report: TestedBoundsReport; until: number } | null = null
  let loading: Promise<TestedBoundsReport> | null = null

  async function verifiedReport(): Promise<TestedBoundsReport> {
    if (cache && Date.now() < cache.until) return cache.report
    if (loading) return loading
    loading = Promise.resolve(readReport()).then((value) => {
      if (!validReport(value)) throw new Error('holder_exit_tested_bounds_invalid')
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
    const selected = parseSelection(req.query)
    if (!selected)
      return res.status(400).json({ status: 'unavailable', reason: 'invalid_selection' })

    try {
      const report = await verifiedReport()
      const subjects = report.subjects.filter(
        (subject) =>
          subject.routeKey === selected.routeKey && subject.destination === selected.destination,
      )
      if (!subjects.length)
        return res.status(404).json({ status: 'unavailable', reason: 'subject_not_tracked' })
      if (subjects.length !== 1)
        return res.status(503).json({ status: 'unavailable', reason: 'verification_unavailable' })
      const subject = subjects[0]
      return res.status(200).json({
        status: 'available',
        routeKey: subject.routeKey,
        destination: subject.destination,
        asset: subject.asset,
        stageScope: subject.stageScope,
        subjectStatus: subject.status,
        requestedHorizonHours: selected.horizonHours,
        ...amountAtHorizon(subject, selected.horizonHours),
        requestedRaw: selected.requestedRaw,
        exactQAtHorizon: exactQAtHorizon(subject, selected.horizonHours, selected.requestedRaw),
        qLadderRelation: qLadderRelation(subject, selected.horizonHours, selected.requestedRaw),
        ...sampledState(subject, selected.requestedRaw),
        durationProjection: null,
        provenance: {
          source: 'local_sealed_panel_reader',
          sourceVerification: report.sourceVerification,
          sourceVerificationBasis: 'forwarded_producer_assertion',
          scope: report.scope,
          claimClass: report.claimClass,
          manifestSha256: report.manifestSha256,
          historicalDataThroughUtc: report.historicalDataThroughUtc,
          historicalDataThroughClockBasis: report.historicalDataThroughClockBasis,
          historicalDataThroughIndependentlyWitnessed:
            report.historicalDataThroughIndependentlyWitnessed,
          routeGroups: report.summary.routeGroups,
          exactSubjects: report.summary.exactSubjects,
          rawRows: report.summary.rawRows,
        },
      })
    } catch {
      return res.status(503).json({ status: 'unavailable', reason: 'verification_unavailable' })
    }
  }
}

export default createHolderExitTestedBoundsHandler()
