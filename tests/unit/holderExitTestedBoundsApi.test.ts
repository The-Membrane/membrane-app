import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHolderExitTestedBoundsHandler } from '@/pages/api/carry/holder-exit-tested-bounds'

const readReport = vi.fn()
let handler = createHolderExitTestedBoundsHandler(readReport)

const routeKey = 'USDC → VaultV2 [USDC]'
const address = (value: number) => `0x${value.toString(16).padStart(40, '0')}`
const destination = address(1)
const otherDestination = address(2)
const emptyDestination = address(3)
// Shape-valid producer fixture only; this test does not independently certify the digest.
const TEST_MANIFEST_SHA = '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3'
const FLUID_BRIDGE_VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const USDC_ASSET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const FLUID_USDT_ROUTE = 'USDT → FluidBridgeAggregatorProxy [USDC]'
const FLUID_FIRST_LEG_UNIT = 'USDC_first_leg_assets'
const APYUSD_ROUTE = 'apxUSD → ApyUSD [apxUSD]'
const APYUSD_STAGE = 'apyusd_withdraw_initiation_eth_call'
const APYUSD_VAULT = '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'
const APXUSD_ASSET = '0x98a878b1cd98131b271883b390f68d2c90674665'
const APXUSD_ASSET_UNIT = 'apxUSD_assets'
const TEST_ROUTES = [
  [routeKey, 'direct_morpho_vaultv2_withdraw_eth_call', 33],
  ['apxUSD → ApyUSD [apxUSD]', 'apyusd_withdraw_initiation_eth_call', 1],
  ['AUSD → Staked USDat [USDat]', 'staked_usdat_redeem_eth_call', 1],
  ['AUSD → VaultV2 [AUSD]', 'direct_morpho_vaultv2_withdraw_eth_call', 3],
  ['EURCV → VaultV2 [EURCV]', 'direct_morpho_vaultv2_withdraw_eth_call', 1],
  ['GHO → fToken [GHO]', 'direct_fluid_ftoken_withdraw_eth_call', 1],
  ['GHO → sGho [GHO]', 'direct_sgho_withdraw_eth_call', 1],
  ['GHO → UmbrellaStakeToken [GHO]', 'direct_umbrella_redeem_eth_call', 1],
  ['LINK → VaultV2 [LINK]', 'direct_morpho_vaultv2_withdraw_eth_call', 1],
  ['PYUSD → StakingVault [wYLDS]', 'pyusd_staking_first_stage_eth_call', 1],
  ['PYUSD → VaultV2 [PYUSD]', 'direct_morpho_vaultv2_withdraw_eth_call', 3],
  ['RLUSD → VaultV2 [RLUSD]', 'direct_morpho_vaultv2_withdraw_eth_call', 1],
  ['USDC → Fluid USD Coin [USDC]', 'direct_fluid_ftoken_withdraw_eth_call', 1],
  ['USDC → FluidBridgeAggregatorProxy [USDC]', 'fluid_bridge_usdc_first_leg_eth_call', 1],
  ['USDC → supply on Aave V3', 'direct_aave_withdraw_eth_call', 1],
  ['USDC → supply on Compound v3', 'direct_compound_v3_withdraw_eth_call', 1],
  ['USDC → USD3 [USDC]', 'direct_usd3_withdraw_eth_call', 1],
  ['USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]', 'twyne_pt_borrower_first_leg_eth_call', 1],
  ['USDe → Staked USDe [USDe]', 'susde_pending_unstake_eth_call', 1],
  ['USDS → StUsds [USDS]', 'direct_stusds_withdraw_eth_call', 1],
  ['USDS → SUsds [USDS]', 'direct_susds_withdraw_eth_call', 1],
  ['USDT → FluidBridgeAggregatorProxy [USDC]', 'fluid_bridge_usdt_first_leg_eth_call', 1],
  ['USDT → fToken [USDT]', 'direct_fluid_ftoken_withdraw_eth_call', 1],
  ['USDT → supply on Spark', 'direct_spark_withdraw_eth_call', 1],
  ['USDT → VaultV2 [USDT]', 'direct_morpho_vaultv2_withdraw_eth_call', 7],
] as const

function envelope(
  horizonHours: number,
  unit: string | null = 'asset_raw',
  values: [string, string, string] = ['100', '200', '300'],
) {
  const comparable = unit === 'asset_raw'
  const issueHashes = ['a', 'c', 'd']
  const holderHashes = ['b', 'e', 'f']
  return {
    horizonHours,
    boundEligibleCohorts: 3,
    uniqueIssueClusters: 3,
    measuredCells: 6,
    qUnit: unit,
    unitStatus: unit === null ? 'missing' : 'recorded',
    displayComparableAssetAmount: comparable,
    testedCallableLowerBoundMinRaw: values[0],
    testedCallableLowerBoundMedianRaw: values[1],
    testedCallableLowerBoundMaxRaw: values[2],
    orderStatistic: 'min_lower_median_max',
    orderStatisticBasis: 'descriptive_sample',
    populationQuantile: false,
    zeroSentinelMeansNoCallableTestedTier: true,
    noCallableTestedTierCohorts: 0,
    aboveTestCeilingUnknownCohorts: 3,
    cohorts: values.map((value, index) => {
      const firstTier = (BigInt(value) / 2n).toString()
      return {
        issueClusterSha256: issueHashes[index].repeat(64),
        holderCommitment: holderHashes[index].repeat(64),
        horizonHours,
        qUnit: unit,
        measuredCells: 2,
        testedTiers: [
          {
            qRaw: firstTier,
            qCaseLabel: 'small',
            tierRank: 1,
            baselineState: 'simulated_callable',
            outcomeState: 'simulated_callable',
            callable: true,
          },
          {
            qRaw: value,
            qCaseLabel: 'large',
            tierRank: 2,
            baselineState: 'simulated_callable',
            outcomeState: 'simulated_callable',
            callable: true,
          },
        ],
        testedCallableLowerBoundRaw: value,
        testedCallableTierRank: 2,
        testedCallableTierLabel: 'large',
        noCallableTestedTier: false,
        aboveTestCeilingUnknown: true,
      }
    }),
  }
}

type StateFixture = {
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
    qUnit: string
    baselineState: string
    measuredHorizons: number
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

function sampledState(measured = true): StateFixture {
  return measured
    ? {
        attemptedTrajectories: 1,
        measuredTrajectories: 1,
        observedDifferentStateWindows: 0,
        sameStateAtLastSampleTrajectories: 1,
        abstentions: {},
        durationProjection: null,
        observations: [
          {
            issueClusterSha256: 'a'.repeat(64),
            holderCommitment: 'b'.repeat(64),
            qRaw: '500',
            qUnit: 'asset_raw',
            baselineState: 'simulated_callable',
            measuredHorizons: 2,
            lastSameStateSampleHours: 24,
            lastSameStateObservedAtUtc: '2026-10-04T00:00:00.000Z',
            differentStateObservedAtUtc: null,
            observedDifferentStateWindow: null,
          },
        ],
      }
    : {
        attemptedTrajectories: 0,
        measuredTrajectories: 0,
        observedDifferentStateWindows: 0,
        sameStateAtLastSampleTrajectories: 0,
        abstentions: {},
        durationProjection: null,
        observations: [],
      }
}

function firstMeasuredDifferenceState(): StateFixture {
  return {
    attemptedTrajectories: 1,
    measuredTrajectories: 1,
    observedDifferentStateWindows: 1,
    sameStateAtLastSampleTrajectories: 0,
    abstentions: {},
    durationProjection: null,
    observations: [
      {
        issueClusterSha256: 'a'.repeat(64),
        holderCommitment: 'b'.repeat(64),
        qRaw: '300',
        qUnit: 'asset_raw',
        baselineState: 'simulated_callable',
        measuredHorizons: 1,
        lastSameStateSampleHours: null,
        lastSameStateObservedAtUtc: null,
        differentStateObservedAtUtc: '2026-10-04T01:00:00.000Z',
        observedDifferentStateWindow: {
          afterObservedAtUtc: '2026-10-04T00:00:00.000Z',
          byObservedAtUtc: '2026-10-04T01:00:00.000Z',
          lastSameStatePlannedHorizonHours: null,
          differentStatePlannedHorizonHours: 1,
        },
      },
    ],
  }
}

function windowlessMeasuredDifferenceState(): StateFixture {
  const state = firstMeasuredDifferenceState()
  state.observedDifferentStateWindows = 0
  state.observations[0].observedDifferentStateWindow = null
  return state
}

function subject(
  selectedRouteKey: string,
  selectedDestination: string,
  asset: string,
  stageScope: string,
  options: {
    status?: string
    envelopes?: unknown[] | null
    measuredState?: boolean
  } = {},
) {
  const status = options.status ?? 'no_episodes'
  const envelopeAssays = ((options.envelopes ?? []) as ReturnType<typeof envelope>[]).flatMap(
    (entry) =>
      entry.cohorts.flatMap((cohort) =>
        cohort.testedTiers.map((tier) => ({
          issueClusterSha256: cohort.issueClusterSha256,
          holderCommitment: cohort.holderCommitment,
          qRaw: tier.qRaw,
          qUnit: entry.qUnit,
          horizonHours: entry.horizonHours,
          baselineState: tier.baselineState,
          outcomeState: tier.outcomeState,
          censorReason: null,
        })),
      ),
  )
  const primaryAssays =
    status === 'no_episodes'
      ? []
      : [
          ...envelopeAssays,
          {
            issueClusterSha256: 'a'.repeat(64),
            holderCommitment: 'b'.repeat(64),
            qRaw: '500',
            qUnit: 'asset_raw',
            horizonHours: 24,
            baselineState: 'simulated_callable',
            outcomeState: 'simulated_callable',
            censorReason: null,
          },
          {
            issueClusterSha256: 'a'.repeat(64),
            holderCommitment: 'b'.repeat(64),
            qRaw: '500',
            qUnit: 'asset_raw',
            horizonHours: 24,
            baselineState: 'simulated_callable',
            outcomeState: 'censored',
            censorReason: 'capture_window_missed',
          },
        ]
  const rawRows = primaryAssays.length
  return {
    routeKey: selectedRouteKey,
    destination: selectedDestination,
    asset,
    subject: `${selectedRouteKey}\0${selectedDestination}\0${asset}`,
    stageScope,
    status,
    rawRows,
    primaryRows: rawRows,
    primaryAssays,
    uniqueIssueClusters: rawRows ? 1 : 0,
    attemptedCohorts: rawRows ? 1 : 0,
    fullyMeasuredPresentCohorts: rawRows ? 1 : 0,
    boundEligibleCohorts: rawRows ? 1 : 0,
    cohortAbstentions: {},
    measuredPresentCells: rawRows,
    boundEligibleMeasuredCells: rawRows,
    historicalTestedAmountBoundsByHorizon: options.envelopes ?? null,
    sampledStateEvidence: sampledState(options.measuredState ?? rawRows > 0),
    amountProjection: null,
    durationProjection: null,
  }
}

function verifiedReport(options: { envelopes?: unknown[]; selectedStatus?: string } = {}) {
  const subjects = []
  let identity = 1
  for (const [routeIndex, [selectedRouteKey, stageScope, subjectCount]] of TEST_ROUTES.entries()) {
    for (let subjectIndex = 0; subjectIndex < subjectCount; subjectIndex += 1) {
      const selectedDestination = address(identity)
      const asset = address(10_000 + identity)
      if (routeIndex === 0 && subjectIndex === 0) {
        subjects.push(
          subject(selectedRouteKey, selectedDestination, asset, stageScope, {
            status: options.selectedStatus ?? 'historical_tested_bounds',
            envelopes: options.envelopes ?? [
              envelope(1),
              envelope(24, 'asset_raw', ['400', '500', '600']),
            ],
          }),
        )
      } else {
        subjects.push(subject(selectedRouteKey, selectedDestination, asset, stageScope))
      }
      identity += 1
    }
  }
  const rawRows = subjects.reduce((sum, entry) => sum + entry.rawRows, 0)
  return {
    version: 3,
    scope: 'historical_tested_amount_bounds',
    claimClass: 'historical_tested_callable_lower_bounds',
    sourceVerification: 'offline_sealed_replay',
    manifestSha256: TEST_MANIFEST_SHA,
    historicalDataThroughUtc: '2026-10-04T00:00:00.000Z',
    historicalDataThroughClockBasis: 'saved_local_panel_clocks',
    historicalDataThroughIndependentlyWitnessed: false,
    prospectiveValidated: false,
    forecastValidated: false,
    statisticalIndependenceValidated: false,
    populationQuantile: false,
    holderExecutableCapacity: false,
    routeLevelProbability: null,
    amountProjection: null,
    durationProjection: null,
    expectedIssuedQLadderVerified: false,
    summary: { routeGroups: 25, exactSubjects: 67, rawRows },
    subjects,
  }
}

function fluidFirstLegReport(
  options: {
    destination?: string
    asset?: string
    qUnit?: string
  } = {},
) {
  const report = verifiedReport()
  const destination = options.destination ?? FLUID_BRIDGE_VAULT
  const asset = options.asset ?? USDC_ASSET
  const qUnit = options.qUnit ?? FLUID_FIRST_LEG_UNIT
  const index = report.subjects.findIndex((entry) => entry.routeKey === FLUID_USDT_ROUTE)
  report.subjects[index] = subject(
    FLUID_USDT_ROUTE,
    destination,
    asset,
    'fluid_bridge_usdt_first_leg_eth_call',
    {
      status: 'historical_tested_bounds',
      envelopes: [envelope(24, qUnit, ['400', '500', '600'])],
    },
  )
  report.subjects[index].sampledStateEvidence.observations[0].qUnit = qUnit
  report.summary.rawRows = report.subjects.reduce((sum, entry) => sum + entry.rawRows, 0)
  return report
}

function apyUsdReport(
  options: {
    destination?: string
    asset?: string
    qUnit?: string
    stageScope?: string
  } = {},
) {
  const report = verifiedReport()
  const destination = options.destination ?? APYUSD_VAULT
  const asset = options.asset ?? APXUSD_ASSET
  const qUnit = options.qUnit ?? APXUSD_ASSET_UNIT
  const stageScope = options.stageScope ?? APYUSD_STAGE
  const index = report.subjects.findIndex((entry) => entry.routeKey === APYUSD_ROUTE)
  report.subjects[index] = subject(APYUSD_ROUTE, destination, asset, stageScope, {
    status: 'historical_tested_bounds',
    envelopes: [envelope(24, qUnit, ['400', '500', '600'])],
  })
  for (const row of report.subjects[index].primaryAssays) row.qUnit = qUnit
  report.subjects[index].sampledStateEvidence.observations[0].qUnit = qUnit
  report.summary.rawRows = report.subjects.reduce((sum, entry) => sum + entry.rawRows, 0)
  return report
}

type ReportFixture = ReturnType<typeof verifiedReport>
type EnvelopeFixture = ReturnType<typeof envelope>

function selectedEnvelope(report: ReportFixture, horizonHours = 24): EnvelopeFixture {
  const envelopes = report.subjects[0].historicalTestedAmountBoundsByHorizon as EnvelopeFixture[]
  const selected = envelopes.find((entry) => entry.horizonHours === horizonHours)
  if (!selected) throw new Error('fixture_envelope_missing')
  return selected
}

async function expectVerificationFailure(report: ReportFixture) {
  readReport.mockReset().mockResolvedValue(report)
  handler = createHolderExitTestedBoundsHandler(readReport)
  expect(await request()).toMatchObject({
    code: 503,
    body: { status: 'unavailable', reason: 'verification_unavailable' },
  })
}

async function request(
  query: Record<string, unknown> = {
    routeKey,
    destination,
    horizonHours: '24',
    requestedRaw: '500',
  },
  options: {
    method?: string
    remote?: string
    host?: string
    origin?: string
  } = {},
) {
  let code = 0
  let body: Record<string, unknown> | null = null
  const headers: Record<string, string> = {}
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value
    }),
    status: vi.fn((value: number) => {
      code = value
      return res
    }),
    json: vi.fn((value: Record<string, unknown>) => {
      body = value
      return res
    }),
  }
  await handler(
    {
      method: options.method ?? 'GET',
      query,
      headers: {
        host: options.host ?? 'localhost:3005',
        ...(options.origin ? { origin: options.origin } : {}),
      },
      socket: { remoteAddress: options.remote ?? '127.0.0.1' },
    } as never,
    res as never,
  )
  return { code, body, headers }
}

describe('local holder exit tested bounds API', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL', '')
    readReport.mockReset().mockResolvedValue(verifiedReport())
    handler = createHolderExitTestedBoundsHandler(readReport)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('returns only the exact destination and the exact requested horizon', async () => {
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(result.body).toMatchObject({
      status: 'available',
      routeKey,
      destination,
      asset: address(10_001),
      stageScope: 'direct_morpho_vaultv2_withdraw_eth_call',
      subjectStatus: 'historical_tested_bounds',
      requestedHorizonHours: 24,
      requestedRaw: '500',
      exactQAtHorizon: {
        recordedPrimaryCells: 3,
        uniqueIssueClustersUpperBound: 2,
        transitions: {
          callableToCallable: 2,
          callableToImpaired: 0,
          impairedToImpaired: 0,
          impairedToCallable: 0,
        },
        censorReasons: { capture_window_missed: 1 },
      },
      qLadderRelation: {
        counts: {
          withinCallableLowerBound: 2,
          atOrAboveImpairedTier: 0,
          betweenTestedTiers: 0,
          aboveTestedCeiling: 1,
          belowImpairedFloor: 0,
        },
      },
      amountReason: null,
      testedAmountAtHorizon: {
        assertion: 'historical_tested_callable_lower_bounds',
        horizonHours: 24,
        unit: 'asset_raw',
        minRawLowerBound: '400',
        medianRawLowerBound: '500',
        maxRawLowerBound: '600',
        eligibleCohortCount: 3,
        measuredCellCount: 6,
        noCallableCohortCount: 0,
        aboveTestCeilingUnknownCohortCount: 3,
      },
      sampledState: {
        assertion: 'historical_sampled_state_only',
        measuredTrajectoryCount: 1,
        differentStateWindowCount: 0,
        differentStateWithoutWindowCount: 0,
        sameStateAtLastSampleCount: 1,
        lastSameStateSampleCheckpointCounts: [{ hours: 24, count: 1 }],
        maxLastSameStateSampleHours: 24,
        observations: [{ firstObservedDifferentStateWindow: null, sameStateAtLastSample: true }],
        durationProjection: null,
      },
      provenance: {
        source: 'local_sealed_panel_reader',
        sourceVerification: 'offline_sealed_replay',
        sourceVerificationBasis: 'forwarded_producer_assertion',
        historicalDataThroughClockBasis: 'saved_local_panel_clocks',
        historicalDataThroughIndependentlyWitnessed: false,
        routeGroups: 25,
        exactSubjects: 67,
        rawRows: 14,
      },
    })
    const json = JSON.stringify(result.body)
    expect(json).not.toContain(otherDestination)
    expect(json).not.toContain('"cohorts"')
    expect(json).toContain('"observations"')
    expect(json).not.toContain('holderCommitment')
    expect(json).not.toContain('issueClusterSha256')
  })

  it('normalizes only the pinned Fluid USDC first-leg raw unit for the USDT route', async () => {
    readReport.mockReset().mockResolvedValue(fluidFirstLegReport())
    handler = createHolderExitTestedBoundsHandler(readReport)
    const result = await request({
      routeKey: FLUID_USDT_ROUTE,
      destination: FLUID_BRIDGE_VAULT,
      horizonHours: '24',
      requestedRaw: '500',
    })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      asset: USDC_ASSET,
      stageScope: 'fluid_bridge_usdt_first_leg_eth_call',
      testedAmountAtHorizon: { unit: 'asset_raw', medianRawLowerBound: '500' },
      exactQAtHorizon: { recordedPrimaryCells: 1 },
      qLadderRelation: { eligibleCohorts: 3 },
      sampledState: { measuredTrajectoryCount: 1 },
    })
  })

  it.each([
    { destination: otherDestination },
    { asset: address(77) },
    { qUnit: 'asset_raw' },
    { qUnit: 'USDT_first_leg_assets' },
  ])('abstains when Fluid unit identity drifts: %o', async (change) => {
    const report = fluidFirstLegReport(change)
    readReport.mockReset().mockResolvedValue(report)
    handler = createHolderExitTestedBoundsHandler(readReport)
    const fluid = report.subjects.find((entry) => entry.routeKey === FLUID_USDT_ROUTE)!
    const result = await request({
      routeKey: FLUID_USDT_ROUTE,
      destination: fluid.destination,
      horizonHours: '24',
      requestedRaw: '500',
    })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      testedAmountAtHorizon: null,
      amountReason: 'unit_not_comparable',
      exactQAtHorizon: null,
      qLadderRelation: null,
      sampledState: null,
    })
  })

  it('normalizes apxUSD assay units only for the pinned ApyUSD initiation subject', async () => {
    readReport.mockReset().mockResolvedValue(apyUsdReport())
    handler = createHolderExitTestedBoundsHandler(readReport)
    const result = await request({
      routeKey: APYUSD_ROUTE,
      destination: APYUSD_VAULT,
      horizonHours: '24',
      requestedRaw: '500',
    })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      asset: APXUSD_ASSET,
      stageScope: APYUSD_STAGE,
      testedAmountAtHorizon: { unit: 'asset_raw', medianRawLowerBound: '500' },
      exactQAtHorizon: { recordedPrimaryCells: 3 },
      qLadderRelation: { eligibleCohorts: 3 },
      sampledState: { measuredTrajectoryCount: 1 },
    })
  })

  it.each([
    { destination: otherDestination },
    { asset: address(77) },
    { qUnit: 'asset_raw' },
    { qUnit: 'ApyUSD_shares' },
  ])('abstains when the ApyUSD unit identity drifts: %o', async (change) => {
    const report = apyUsdReport(change)
    readReport.mockReset().mockResolvedValue(report)
    handler = createHolderExitTestedBoundsHandler(readReport)
    const apyUsd = report.subjects.find((entry) => entry.routeKey === APYUSD_ROUTE)!
    const result = await request({
      routeKey: APYUSD_ROUTE,
      destination: apyUsd.destination,
      horizonHours: '24',
      requestedRaw: '500',
    })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      testedAmountAtHorizon: null,
      amountReason: 'unit_not_comparable',
      exactQAtHorizon: null,
      qLadderRelation: null,
      sampledState: null,
    })
  })

  it('rejects a noncanonical ApyUSD assay stage before exposing any unit alias', async () => {
    await expectVerificationFailure(apyUsdReport({ stageScope: 'direct_erc4626_withdraw' }))
  })

  it('does not treat apxUSD_assets as a global asset-raw alias', async () => {
    const report = verifiedReport({
      envelopes: [envelope(24, APXUSD_ASSET_UNIT, ['400', '500', '600'])],
    })
    for (const row of report.subjects[0].primaryAssays) row.qUnit = APXUSD_ASSET_UNIT
    report.subjects[0].sampledStateEvidence.observations[0].qUnit = APXUSD_ASSET_UNIT
    readReport.mockReset().mockResolvedValue(report)
    handler = createHolderExitTestedBoundsHandler(readReport)
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      testedAmountAtHorizon: null,
      amountReason: 'unit_not_comparable',
      exactQAtHorizon: null,
      qLadderRelation: null,
      sampledState: null,
    })
  })

  it('does not interpolate between sampled horizons', async () => {
    const result = await request({ routeKey, destination, horizonHours: '12', requestedRaw: '500' })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      requestedHorizonHours: 12,
      testedAmountAtHorizon: null,
      amountReason: 'no_exact_horizon',
    })
  })

  it('keeps exact-Q assays separate from unassayed Q ladder relations', async () => {
    const beyond = await request({ routeKey, destination, horizonHours: '24', requestedRaw: '700' })
    expect(beyond.body).toMatchObject({
      requestedRaw: '700',
      exactQAtHorizon: null,
      qLadderRelation: {
        eligibleCohorts: 3,
        counts: { aboveTestedCeiling: 3 },
      },
      sampledState: null,
      stateReason: 'no_measured_samples',
    })
    const atExactQ = await request()
    expect(atExactQ.body).toMatchObject({ exactQAtHorizon: { recordedPrimaryCells: 3 } })
  })

  it('does not count pending or expressly unassayed Q cells as exact-Q assay outcomes', async () => {
    const report = verifiedReport()
    const unmeasured = report.subjects[0].primaryAssays.slice(-2)
    unmeasured[0].qRaw = '700'
    unmeasured[0].outcomeState = 'pending'
    unmeasured[0].censorReason = 'pending'
    unmeasured[1].qRaw = '700'
    unmeasured[1].outcomeState = 'not_assayed'
    unmeasured[1].censorReason = 'baseline_unscored_by_design'
    readReport.mockResolvedValueOnce(report)
    handler = createHolderExitTestedBoundsHandler(readReport)
    expect(
      (await request({ routeKey, destination, horizonHours: '24', requestedRaw: '700' })).body,
    ).toMatchObject({
      exactQAtHorizon: null,
      qLadderRelation: { counts: { aboveTestedCeiling: 3 } },
    })
  })

  it('classifies between tiers, impaired tiers, and below the impaired floor without inventing outcomes', async () => {
    const base = envelope(24)
    const callable = (qRaw: string, tierRank: number) => ({
      qRaw,
      qCaseLabel: null,
      tierRank,
      baselineState: 'simulated_callable',
      outcomeState: 'simulated_callable',
      callable: true,
    })
    const impaired = (qRaw: string, tierRank: number) => ({
      qRaw,
      qCaseLabel: null,
      tierRank,
      baselineState: 'simulated_callable',
      outcomeState: 'simulated_impaired',
      callable: false,
    })
    const mixed = {
      ...base,
      testedCallableLowerBoundMinRaw: '0',
      testedCallableLowerBoundMedianRaw: '50',
      testedCallableLowerBoundMaxRaw: '300',
      noCallableTestedTierCohorts: 1,
      aboveTestCeilingUnknownCohorts: 1,
      cohorts: [
        {
          ...base.cohorts[0],
          testedTiers: [callable('50', 1), impaired('100', 2)],
          testedCallableLowerBoundRaw: '50',
          testedCallableTierRank: 1,
          testedCallableTierLabel: null,
          aboveTestCeilingUnknown: false,
        },
        {
          ...base.cohorts[1],
          testedTiers: [impaired('100', 1), impaired('200', 2)],
          testedCallableLowerBoundRaw: '0',
          testedCallableTierRank: null,
          testedCallableTierLabel: null,
          noCallableTestedTier: true,
          aboveTestCeilingUnknown: false,
        },
        {
          ...base.cohorts[2],
          testedTiers: [callable('150', 1), callable('300', 2)],
          testedCallableLowerBoundRaw: '300',
          testedCallableTierRank: 2,
          testedCallableTierLabel: null,
        },
      ],
    }
    readReport.mockResolvedValueOnce(verifiedReport({ envelopes: [mixed] }))
    handler = createHolderExitTestedBoundsHandler(readReport)
    expect(
      (await request({ routeKey, destination, horizonHours: '24', requestedRaw: '75' })).body,
    ).toMatchObject({
      exactQAtHorizon: null,
      qLadderRelation: {
        counts: { withinCallableLowerBound: 1, betweenTestedTiers: 1, belowImpairedFloor: 1 },
      },
    })
    expect(
      (await request({ routeKey, destination, horizonHours: '24', requestedRaw: '100' })).body,
    ).toMatchObject({
      qLadderRelation: { counts: { atOrAboveImpairedTier: 2, withinCallableLowerBound: 1 } },
    })
    expect(
      (await request({ routeKey, destination, horizonHours: '24', requestedRaw: '400' })).body,
    ).toMatchObject({
      qLadderRelation: { counts: { atOrAboveImpairedTier: 2, aboveTestedCeiling: 1 } },
    })
  })

  it('counts impaired baseline transitions without relabeling them as censoring', async () => {
    const report = verifiedReport()
    const exactRows = report.subjects[0].primaryAssays.filter(
      (row) => row.qRaw === '500' && row.horizonHours === 24,
    )
    exactRows[1].baselineState = 'simulated_impaired'
    exactRows[2].baselineState = 'simulated_impaired'
    exactRows[2].outcomeState = 'simulated_impaired'
    exactRows[2].censorReason = null
    readReport.mockResolvedValueOnce(report)
    handler = createHolderExitTestedBoundsHandler(readReport)
    expect((await request()).body).toMatchObject({
      exactQAtHorizon: {
        transitions: { callableToCallable: 1, impairedToCallable: 1, impairedToImpaired: 1 },
        censorReasons: {},
      },
    })
  })

  it('exposes the first observed different-state sample window without claiming a first change', async () => {
    const report = verifiedReport()
    report.subjects[0].sampledStateEvidence = firstMeasuredDifferenceState()
    readReport.mockResolvedValueOnce(report)
    handler = createHolderExitTestedBoundsHandler(readReport)

    const result = await request({ routeKey, destination, horizonHours: '24', requestedRaw: '300' })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      sampledState: {
        assertion: 'historical_sampled_state_only',
        attemptedTrajectoryCount: 1,
        measuredTrajectoryCount: 1,
        differentStateWindowCount: 1,
        differentStateWithoutWindowCount: 0,
        sameStateAtLastSampleCount: 0,
        lastSameStateSampleCheckpointCounts: [],
        maxLastSameStateSampleHours: null,
        observations: [
          {
            firstObservedDifferentStateWindow: {
              afterObservedAtUtc: '2026-10-04T00:00:00.000Z',
              byObservedAtUtc: '2026-10-04T01:00:00.000Z',
            },
            sameStateAtLastSample: false,
          },
        ],
        durationProjection: null,
      },
    })
    expect(JSON.stringify(result.body)).not.toMatch(/firstChangeWindow|rightCensoredAtLastSample/)
  })

  it('counts a measured difference without a baseline window separately', async () => {
    const report = verifiedReport()
    report.subjects[0].sampledStateEvidence = windowlessMeasuredDifferenceState()
    readReport.mockResolvedValueOnce(report)
    handler = createHolderExitTestedBoundsHandler(readReport)

    const result = await request({ routeKey, destination, horizonHours: '24', requestedRaw: '300' })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      sampledState: {
        assertion: 'historical_sampled_state_only',
        measuredTrajectoryCount: 1,
        differentStateWindowCount: 0,
        differentStateWithoutWindowCount: 1,
        sameStateAtLastSampleCount: 0,
        lastSameStateSampleCheckpointCounts: [],
        maxLastSameStateSampleHours: null,
        durationProjection: null,
      },
    })
  })

  it('withholds non-asset and ambiguous tested units', async () => {
    readReport.mockResolvedValueOnce(verifiedReport({ envelopes: [envelope(24, 'share_raw')] }))
    handler = createHolderExitTestedBoundsHandler(readReport)
    const nonAsset = await request()
    expect(nonAsset.code).toBe(200)
    expect(nonAsset.body).toMatchObject({
      testedAmountAtHorizon: null,
      amountReason: 'unit_not_comparable',
    })

    readReport.mockResolvedValueOnce(
      verifiedReport({ envelopes: [envelope(24), envelope(24, 'share_raw')] }),
    )
    handler = createHolderExitTestedBoundsHandler(readReport)
    const ambiguous = await request()
    expect(ambiguous.code).toBe(200)
    expect(ambiguous.body).toMatchObject({
      testedAmountAtHorizon: null,
      amountReason: 'ambiguous_unit',
    })
  })

  it('returns 200 with null evidence for a canonical subject without episodes', async () => {
    const result = await request({
      routeKey,
      destination: emptyDestination,
      horizonHours: '24',
      requestedRaw: '500',
    })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      status: 'available',
      destination: emptyDestination,
      subjectStatus: 'no_episodes',
      testedAmountAtHorizon: null,
      amountReason: 'no_exact_horizon',
      sampledState: null,
      stateReason: 'no_measured_samples',
      durationProjection: null,
    })
  })

  it('returns 404 for an untracked exact route and destination pair', async () => {
    const result = await request({
      routeKey,
      destination: address(999),
      horizonHours: '24',
      requestedRaw: '500',
    })
    expect(result.code).toBe(404)
    expect(result.body).toEqual({ status: 'unavailable', reason: 'subject_not_tracked' })
  })

  it('rejects bad methods, selections, and non-local requests', async () => {
    expect((await request({}, { method: 'POST' })).code).toBe(405)
    expect((await request({ routeKey, destination })).code).toBe(400)
    expect(
      (await request({ routeKey, destination, horizonHours: '0', requestedRaw: '500' })).code,
    ).toBe(400)
    expect(
      (await request({ routeKey, destination, horizonHours: '721', requestedRaw: '500' })).code,
    ).toBe(400)
    expect(
      (await request({ routeKey, destination, horizonHours: '24', requestedRaw: '0' })).code,
    ).toBe(400)
    expect((await request(undefined, { remote: '192.168.1.8' })).body).toEqual({
      status: 'unavailable',
      reason: 'local_only',
    })

    vi.stubEnv('VERCEL', '1')
    expect((await request()).code).toBe(503)
  })

  it('fails closed when any load-bearing report guarantee is malformed', async () => {
    const malformed = verifiedReport()
    malformed.forecastValidated = true
    readReport.mockResolvedValueOnce(malformed)
    handler = createHolderExitTestedBoundsHandler(readReport)
    expect(await request()).toMatchObject({
      code: 503,
      body: { status: 'unavailable', reason: 'verification_unavailable' },
    })

    const wrongIdentity = verifiedReport()
    wrongIdentity.subjects[0].subject = 'wrong'
    readReport.mockResolvedValueOnce(wrongIdentity)
    handler = createHolderExitTestedBoundsHandler(readReport)
    expect((await request()).code).toBe(503)

    const unknownStage = verifiedReport()
    unknownStage.subjects[0].stageScope = 'arbitrary_holder_call'
    await expectVerificationFailure(unknownStage)

    const allowedButWrongStage = verifiedReport()
    allowedButWrongStage.subjects[0].stageScope = 'direct_aave_withdraw_eth_call'
    await expectVerificationFailure(allowedButWrongStage)
  })

  it('rejects envelope and cohort summaries that do not derive from tested tiers', async () => {
    const mutations: Array<(report: ReportFixture) => void> = [
      (report) => {
        selectedEnvelope(report).testedCallableLowerBoundMedianRaw = '501'
      },
      (report) => {
        selectedEnvelope(report).measuredCells = 5
      },
      (report) => {
        selectedEnvelope(report).cohorts[0].testedCallableLowerBoundRaw = '399'
      },
      (report) => {
        selectedEnvelope(report).cohorts[0].testedTiers[0].callable = false
      },
      (report) => {
        const selected = selectedEnvelope(report)
        selected.cohorts[2] = structuredClone(selected.cohorts[1])
        selected.uniqueIssueClusters = 2
        selected.testedCallableLowerBoundMaxRaw = '500'
      },
    ]
    for (const mutate of mutations) {
      const report = verifiedReport()
      mutate(report)
      await expectVerificationFailure(report)
    }
  })

  it('rejects sampled-state counts and windows that do not derive from observations', async () => {
    const countMismatch = verifiedReport()
    countMismatch.subjects[0].sampledStateEvidence.sameStateAtLastSampleTrajectories = 0
    await expectVerificationFailure(countMismatch)

    const windowMismatch = verifiedReport()
    windowMismatch.subjects[0].sampledStateEvidence.observations[0].differentStateObservedAtUtc =
      '2026-10-04T01:00:00.000Z'
    await expectVerificationFailure(windowMismatch)
  })

  it('rejects subject statuses that contradict the presence of tested bounds', async () => {
    const abstainingWithBounds = verifiedReport()
    abstainingWithBounds.subjects[0].status = 'no_fully_measured_present_cohorts'
    await expectVerificationFailure(abstainingWithBounds)

    const boundedWithoutBounds = verifiedReport()
    boundedWithoutBounds.subjects[0].historicalTestedAmountBoundsByHorizon = null
    await expectVerificationFailure(boundedWithoutBounds)

    const emptyWithSampledState = verifiedReport()
    const emptySubject = emptyWithSampledState.subjects.find(
      (subject) => subject.destination === emptyDestination,
    )
    if (!emptySubject) throw new Error('fixture_empty_subject_missing')
    emptySubject.sampledStateEvidence = sampledState(true)
    await expectVerificationFailure(emptyWithSampledState)
  })

  it('deduplicates concurrent loads and caches the verified whole report', async () => {
    const [first, second] = await Promise.all([request(), request()])
    expect(first.code).toBe(200)
    expect(second.code).toBe(200)
    await request()
    expect(readReport).toHaveBeenCalledTimes(1)
  })
})
