import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHolderExitHistoricalOutlookHandler } from '@/pages/api/carry/holder-exit-historical-outlook'

const readSuite = vi.fn()
let handler = createHolderExitHistoricalOutlookHandler(readSuite)

const routeKey = 'USDC → VaultV2 [USDC]'
const destination = `0x${'a'.repeat(40)}`
const otherDestination = `0x${'b'.repeat(40)}`

const proxyEvidence = {
  evidenceId: 'common_holder_assay_walk_forward_backtest',
  evidenceClass: 'historical_proxy',
  endpoint: 'holder_specific_protocol_stage_assay_state_at_saved_horizon',
  proxyLabel: 'saved_stage_assay_not_full_route_holder_exit',
  samples: { scorableRows: 20, scorableIssueClusters: 4 },
  historicalWindow: { fromUtc: null, throughUtc: '2026-10-04T00:00:00.000Z' },
  design: { unit: 'correlated_holder_q_by_horizon_assay_row' },
  outcomes: { observedTransitionEvents: 0 },
  retrospectiveOnly: true,
  prospectiveValidated: false,
  historicalUse: 'available',
  limits: ['saved_stage_assay_not_full_route_holder_exit'],
}

const exactEvidence = {
  evidenceId: 'morpho_fixed_10k_holder_call_ledger',
  evidenceClass: 'historical_endpoint',
  endpoint: 'fixed_10k_exact_holder_withdrawal_call_at_sampled_horizon',
  proxyLabel: null,
  samples: {
    qAssetsRaw: '10000000000',
    baselineSuccessEpisodes: 39,
    destinationSlices: [
      {
        destination,
        fromBlock: 25_400_000,
        throughBlock: 26_000_000,
        development: {
          plannedCells: 28,
          completedCells: 28,
          baselineSuccessEpisodes: 28,
          observedFirstLossEpisodes: 1,
          observedRecoveryEpisodes: 1,
          firstLossRightCensoredEpisodes: 27,
        },
        reservedHoldout: {
          plannedCells: 11,
          completedCells: 11,
          baselineSuccessEpisodes: 11,
          observedFirstLossEpisodes: 0,
          observedRecoveryEpisodes: 0,
          firstLossRightCensoredEpisodes: 11,
        },
        all: {
          plannedCells: 39,
          completedCells: 39,
          baselineSuccessEpisodes: 39,
          observedFirstLossEpisodes: 1,
          observedRecoveryEpisodes: 1,
          firstLossRightCensoredEpisodes: 38,
        },
      },
    ],
  },
  historicalWindow: { fromBlock: 25_400_000, throughBlock: 26_000_000 },
  design: { unit: 'holder_vault_anchor_episode' },
  outcomes: {
    observedFirstLossEpisodes: 1,
    observedRecoveryEpisodes: 1,
    firstLossRightCensoredEpisodes: 38,
  },
  retrospectiveOnly: true,
  prospectiveValidated: false,
  historicalUse: 'available',
  limits: ['historical_call_is_not_mined_payment'],
}

const saturnPaymentEvidence = {
  evidenceId: 'saturn_exact_holder_usdat_payment_duration',
  evidenceClass: 'historical_proxy',
  endpoint: 'request_to_exact_holder_usdat_payment_by_horizon',
  proxyLabel: 'intermediate_usdat_payment_not_final_ausd_exit',
  samples: {
    requests: 146,
    verifiedFinalHolderPayments: 77,
    medianDurationLowerSeconds: 126_768,
    medianDurationUpperSeconds: 209_100,
  },
  historicalWindow: { fromUtc: null, throughUtc: '2026-10-02T21:23:35.000Z' },
  design: { unit: 'queue_ticket' },
  outcomes: {
    fullCohortHorizonBounds: [
      {
        horizonHours: 72,
        historicalPaymentFractionBounds: { lower: 0.301369, upper: 0.452055 },
      },
    ],
  },
  retrospectiveOnly: true,
  prospectiveValidated: false,
  historicalUse: 'available',
  limits: ['intermediate_usdat_payment_not_final_ausd_exit'],
}

const stageEvidenceBase = {
  evidenceClass: 'historical_endpoint',
  proxyLabel: null,
  historicalWindow: {
    fromUtc: '2026-10-01T04:00:00.000Z',
    throughUtc: '2026-10-02T04:00:00.000Z',
  },
  retrospectiveOnly: true,
  prospectiveValidated: false,
  historicalUse: 'available',
  limits: [
    'first_leg_is_not_full_route_exit',
    'local_evidence_availability_clock_is_not_independently_witnessed',
  ],
}

const umbrellaStageEvidence = {
  ...stageEvidenceBase,
  evidenceId: 'umbrella_gho_exact_stage_revert_states',
  endpoint: 'holder_specific_umbrella_redeem_eth_call_and_gate_state',
  samples: { issueClusters: 3, qHorizonCells: 20, measuredFollowupCells: 5 },
  design: {
    unit: 'correlated_one_stkgho_share_by_horizon_eth_call',
    stageScope: 'direct_umbrella_redeem_eth_call',
  },
  outcomes: {
    baselineRevertIssueClusters: 3,
    baselineGates: { waiting: 1, cooldown_not_started: 1, window_expired: 1 },
    measuredStillReverting: 5,
    measuredLaterCallable: 0,
    observedCallableToImpairedTransitions: 0,
    observedImpairedToCallableTransitions: 0,
    capacityProjection: null,
    durationProjection: null,
  },
}

const fluidStageEvidence = {
  ...stageEvidenceBase,
  evidenceId: 'fluid_bridge_usdc_first_leg_baseline_and_censoring',
  endpoint: 'holder_specific_usdc_bridge_first_leg_eth_call_and_followup_censoring',
  samples: { issueClusters: 1, qCases: 5, qHorizonCells: 25, measuredFollowupCells: 0 },
  design: {
    unit: 'correlated_holder_usdc_first_leg_q_by_horizon_eth_call',
    stageScope: 'fluid_bridge_usdc_first_leg_eth_call',
  },
  outcomes: {
    baselineCallableQCases: 5,
    byHorizon: [
      {
        horizonHours: 1,
        qCases: 5,
        missedWindow: 5,
        otherCensored: 0,
        missing: 0,
        pending: 0,
        measuredCallable: 0,
        inconclusive: 0,
      },
      {
        horizonHours: 4,
        qCases: 5,
        missedWindow: 5,
        otherCensored: 0,
        missing: 0,
        pending: 0,
        measuredCallable: 0,
        inconclusive: 0,
      },
      {
        horizonHours: 24,
        qCases: 5,
        missedWindow: 0,
        otherCensored: 0,
        missing: 5,
        pending: 0,
        measuredCallable: 0,
        inconclusive: 0,
      },
      {
        horizonHours: 48,
        qCases: 5,
        missedWindow: 0,
        otherCensored: 0,
        missing: 5,
        pending: 0,
        measuredCallable: 0,
        inconclusive: 0,
      },
      {
        horizonHours: 168,
        qCases: 5,
        missedWindow: 0,
        otherCensored: 0,
        missing: 0,
        pending: 5,
        measuredCallable: 0,
        inconclusive: 0,
      },
    ],
    measuredLaterCallableCells: 0,
    measuredLaterInconclusiveCells: 0,
    observedCallableToImpairedTransitions: 0,
    observedImpairedToCallableTransitions: 0,
    capacityProjection: null,
    durationProjection: null,
  },
}

function suite(
  selected: {
    promotion?: string
    evidence?: unknown[]
    exactSubjects?: number
    subjects?: Array<{ destination: string; originalAsset?: string }>
  } = {},
) {
  const selectedSubjects = (
    selected.subjects ?? [{ destination }, { destination: otherDestination }]
  ).map((subject, index) => ({
    originalAsset: `0x${String(index + 501).padStart(40, '0')}`,
    ...subject,
  }))
  const selectedExactSubjects = selected.exactSubjects ?? selectedSubjects.length
  const remainingSubjects = 68 - selectedExactSubjects
  const routes = [
    {
      routeKey,
      mechanism: 'atomic',
      exactSubjects: selectedExactSubjects,
      subjects: selectedSubjects,
      promotion: {
        historicalOutlook: selected.promotion ?? 'eligible_exact_endpoint_history',
        liveForecast: 'abstain',
      },
      evidence: selected.evidence ?? [proxyEvidence, exactEvidence],
    },
    ...Array.from({ length: 25 }, (_, index) => {
      const supplemental = index === 24
      const exactSubjects = supplemental ? 1 : index === 0 ? remainingSubjects - 24 : 1
      return {
        routeKey: supplemental ? 'USDe → supply on Aave V3' : `Route ${index}`,
        mechanism: 'atomic',
        exactSubjects,
        subjects: supplemental
          ? [
              {
                destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
                originalAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
              },
            ]
          : Array.from({ length: exactSubjects }, (_, subjectIndex) => ({
              destination: `0x${String(index * 100 + subjectIndex + 1).padStart(40, '0')}`,
              originalAsset: `0x${String(index + 801).padStart(40, '0')}`,
            })),
        promotion: { historicalOutlook: 'abstain', liveForecast: 'abstain' },
        evidence: [],
      }
    }),
  ]
  const historicalCoverage = routes.reduce(
    (counts, route) => {
      if (route.promotion.historicalOutlook === 'eligible_exact_endpoint_history')
        counts.exactEndpointHistoryRouteGroups += 1
      else if (route.promotion.historicalOutlook === 'eligible_proxy_history')
        counts.proxyOnlyHistoryRouteGroups += 1
      else counts.abstainingRouteGroups += 1
      return counts
    },
    {
      exactEndpointHistoryRouteGroups: 0,
      proxyOnlyHistoryRouteGroups: 0,
      abstainingRouteGroups: 0,
    },
  )
  return {
    schema: 'holder-exit-historical-outlook-suite-v1',
    scope: 'offline_tracked_26_route_historical_holder_exit_outlook',
    claimClass: 'retrospective_historical_outlook',
    manifestSha256: 'f'.repeat(64),
    mechanismVersion: 'holder-exit-mechanisms-v1',
    sourcePolicy: {
      networkReads: false,
      databaseReads: false,
      localVerifiedArtifactsOnly: true,
    },
    limits: {
      prospectiveValidated: false,
      liveForecast: false,
      capacityForecast: false,
      fullRouteExitClaim: false,
      routeLevelProbability: false,
      incompatibleEndpointsPooled: false,
    },
    coverage: {
      routeGroups: 26,
      exactSubjects: 68,
      frozenCohortRouteGroups: 25,
      frozenCohortExactSubjects: 67,
      supplementalRouteGroups: 1,
      supplementalExactSubjects: 1,
      ...historicalCoverage,
    },
    routes,
  }
}

function refreshHistoricalCoverage(report: ReturnType<typeof suite>) {
  report.coverage.exactEndpointHistoryRouteGroups = report.routes.filter(
    (route) => route.promotion.historicalOutlook === 'eligible_exact_endpoint_history',
  ).length
  report.coverage.proxyOnlyHistoryRouteGroups = report.routes.filter(
    (route) => route.promotion.historicalOutlook === 'eligible_proxy_history',
  ).length
  report.coverage.abstainingRouteGroups = report.routes.filter(
    (route) => route.promotion.historicalOutlook === 'abstain',
  ).length
}

async function request(
  query: Record<string, unknown> = { routeKey, destination },
  options: {
    method?: string
    remote?: string
    host?: string
    origin?: string
    endpointOnly?: boolean
  } = {},
): Promise<{
  code: number
  body: Record<string, unknown> | null
  headers: Record<string, string>
}> {
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
      query: options.endpointOnly ? query : { requestedRaw: '10000000000', ...query },
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

describe('local holder exit historical outlook API', () => {
  beforeEach(() => {
    readSuite.mockReset().mockResolvedValue(suite())
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('returns one strongest bounded route-group block for an exact tracked destination', async () => {
    const [result, concurrent] = await Promise.all([request(), request()])
    expect(result.code).toBe(200)
    expect(concurrent.code).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(result.body).toMatchObject({
      status: 'available',
      routeKey,
      destination,
      routeGroup: {
        scope: 'exact_destination_route',
        exactSubjects: 2,
        historicalOutlook: 'eligible_exact_endpoint_history',
      },
      evidence: {
        evidenceId: 'morpho_fixed_10k_holder_call_ledger',
        evidenceClass: 'historical_endpoint',
        headline: expect.stringContaining(
          'Development: episodes 28, observed losses 1, recoveries 1. Reserved holdout: episodes 11, observed losses 0, recoveries 0.',
        ),
      },
      provenance: {
        source: 'local_historical_artifacts',
        routeGroups: 26,
        exactSubjects: 68,
        frozenCohortRouteGroups: 25,
        frozenCohortExactSubjects: 67,
        supplementalRouteGroups: 1,
        supplementalExactSubjects: 1,
        exactEndpointHistoryRouteGroups: 1,
        proxyOnlyHistoryRouteGroups: 0,
        abstainingRouteGroups: 25,
      },
    })
    expect((result.body?.evidence as { samples: unknown[] }).samples).toEqual([
      { label: 'Episodes', value: '39' },
      { label: 'Observed losses', value: '1' },
      { label: 'Recoveries', value: '1' },
      { label: 'Right-censored', value: '38' },
    ])
    const json = JSON.stringify(result.body)
    expect(json).not.toContain(otherDestination)
    expect(json).not.toContain('Route 23')
    expect(json).not.toContain(proxyEvidence.evidenceId)

    await request()
    expect(readSuite).toHaveBeenCalledTimes(1)
  })

  it('presents each staged route from its own exact historical endpoint states', async () => {
    for (const entry of [
      {
        route: 'GHO → UmbrellaStakeToken [GHO]',
        destination: '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
        asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
        evidence: umbrellaStageEvidence,
        headline: '3 holder issues had reverted one-share redeem calls',
      },
      {
        route: 'USDC → FluidBridgeAggregatorProxy [USDC]',
        destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
        asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        evidence: fluidStageEvidence,
        headline: '5 tested USDC amounts had callable first-leg simulations',
      },
    ]) {
      const report = suite({
        exactSubjects: 1,
        subjects: [{ destination: entry.destination, originalAsset: entry.asset }],
        evidence: [entry.evidence],
      })
      report.routes[0].routeKey = entry.route
      report.routes[0].mechanism = 'staged'
      readSuite.mockReset().mockResolvedValue(report)
      handler = createHolderExitHistoricalOutlookHandler(readSuite)
      const result = await request(
        { routeKey: entry.route, destination: entry.destination },
        { endpointOnly: true },
      )
      expect(result.code).toBe(200)
      expect(result.body).toMatchObject({
        routeGroup: {
          scope: 'exact_destination_route',
          historicalOutlook: 'eligible_exact_endpoint_history',
        },
        evidence: {
          evidenceId: entry.evidence.evidenceId,
          headline: expect.stringContaining(entry.headline),
        },
      })
      expect(JSON.stringify(result.body)).not.toContain('probability')
    }
  })

  it('serves the four direct holder-call histories only for their exact amount and rejects tampered evidence', async () => {
    for (const entry of [
      [
        'GHO → sGho [GHO]',
        '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
        '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
        'direct_sgho_withdraw_eth_call',
      ],
      [
        'USDC → USD3 [USDC]',
        '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        'direct_usd3_withdraw_eth_call',
      ],
      [
        'USDS → StUsds [USDS]',
        '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
        '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
        'direct_stusds_withdraw_eth_call',
      ],
      [
        'USDS → SUsds [USDS]',
        '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
        '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
        'direct_susds_withdraw_eth_call',
      ],
    ] as const) {
      const [key, vault, asset, scope] = entry
      const subject = `${key}\0${vault}\0${asset}`
      const observation = {
        subject,
        stageScope: scope,
        finalPayoutAsset: asset,
        issueSha256: 'a'.repeat(64),
        scoreSha256: 'b'.repeat(64),
        holderCommitment: 'c'.repeat(64),
        qRaw: '1000000',
        baselineBlock: '26095097',
        baselineBlockHash: `0x${'d'.repeat(64)}`,
        baselineAtUtc: '2026-10-01T00:45:00.000Z',
        issueAtUtc: '2026-10-01T01:00:00.000Z',
        plannedHorizonHours: 1,
        targetAtUtc: '2026-10-01T02:00:00.000Z',
        deadlineAtUtc: '2026-10-01T04:00:00.000Z',
        observedAtUtc: '2026-10-01T02:00:04.000Z',
        localEvidenceAvailableAtUtc: '2026-10-01T02:20:00.000Z',
      }
      const evidence = {
        evidenceId: 'exact_holder_final_asset_withdraw_call_history',
        evidenceClass: 'historical_endpoint' as const,
        endpoint: 'same_holder_exact_q_final_original_asset_withdraw_eth_call',
        proxyLabel: null,
        samples: { successfulCallCells: 1, issueClusters: 1, finalPayoutAsset: asset },
        historicalWindow: {
          fromUtc: observation.observedAtUtc,
          throughUtc: observation.observedAtUtc,
        },
        design: {
          unit: 'same_holder_exact_raw_q_scored_eth_call',
          subject,
          stageScope: scope,
          evidenceAvailabilityClock: 'unwitnessed_local_operator_clock',
        },
        outcomes: {
          successfulCallCells: 1,
          observations: [observation],
          capacityProjection: null,
          durationProjection: null,
        },
        retrospectiveOnly: true as const,
        prospectiveValidated: false as const,
        historicalUse: 'available' as const,
        limits: [
          'historical_eth_call_is_not_mined_holder_payment',
          'no_transition_probability_or_restriction_duration_estimate',
        ],
      }
      const report = suite({
        exactSubjects: 1,
        subjects: [{ destination: vault, originalAsset: asset }],
        evidence: [evidence],
      })
      report.routes[0].routeKey = key
      readSuite.mockReset().mockResolvedValue(report)
      handler = createHolderExitHistoricalOutlookHandler(readSuite)
      const good = await request({ routeKey: key, destination: vault, requestedRaw: '1000000' })
      expect(good.code).toBe(200)
      expect(good.body).toMatchObject({
        routeGroup: { historicalOutlook: 'eligible_exact_endpoint_history' },
        evidence: { evidenceId: evidence.evidenceId },
      })
      expect(JSON.stringify(good.body)).not.toContain('probability')
      if (key === 'USDS → StUsds [USDS]') {
        const siblingTamper = structuredClone(report)
        const siblingBlock = siblingTamper.routes[0].evidence[0] as {
          samples: { successfulCallCells: number }
          outcomes: { successfulCallCells: number; observations: Array<typeof observation> }
        }
        siblingBlock.outcomes.observations.push({
          ...structuredClone(siblingBlock.outcomes.observations[0]),
          qRaw: '2000000',
          baselineAtUtc: '2026-10-01T00:45:01.000Z',
        })
        siblingBlock.samples.successfulCallCells = 2
        siblingBlock.outcomes.successfulCallCells = 2
        readSuite.mockReset().mockResolvedValue(siblingTamper)
        handler = createHolderExitHistoricalOutlookHandler(readSuite)
        const inconsistentIssue = await request({
          routeKey: key,
          destination: vault,
          requestedRaw: '1000000',
        })
        expect(inconsistentIssue.code).toBe(503)
        readSuite.mockReset().mockResolvedValue(report)
        handler = createHolderExitHistoricalOutlookHandler(readSuite)
      }
      const otherQ = await request({ routeKey: key, destination: vault, requestedRaw: '2000000' })
      expect(otherQ.code).toBe(200)
      expect(otherQ.body).toMatchObject({
        routeGroup: { historicalOutlook: 'abstain' },
        evidence: null,
      })
      const tampered = structuredClone(report)
      const block = tampered.routes[0].evidence[0] as {
        outcomes: { observations: Array<{ finalPayoutAsset: string }> }
      }
      block.outcomes.observations[0].finalPayoutAsset = '0x' + 'f'.repeat(40)
      readSuite.mockReset().mockResolvedValue(tampered)
      handler = createHolderExitHistoricalOutlookHandler(readSuite)
      const bad = await request({ routeKey: key, destination: vault, requestedRaw: '1000000' })
      expect(bad.code).toBe(503)
      for (const mutate of [
        (row: typeof observation) => {
          row.observedAtUtc = '2026-10-01T00:44:59.000Z'
        },
        (row: typeof observation) => {
          row.baselineAtUtc = '2026-10-01T01:00:01.000Z'
        },
        (row: typeof observation) => {
          row.targetAtUtc = '2026-10-01T01:59:59.000Z'
        },
        (row: typeof observation) => {
          row.plannedHorizonHours = 2
        },
        (row: typeof observation) => {
          row.deadlineAtUtc = '2026-10-01T02:00:03.000Z'
        },
        (row: typeof observation) => {
          row.localEvidenceAvailableAtUtc = '2026-10-01T02:00:03.000Z'
        },
        (row: typeof observation) => {
          row.issueAtUtc = '2026-10-01T01:00:00Z'
        },
      ]) {
        const changed = structuredClone(report)
        const value = changed.routes[0].evidence[0] as {
          outcomes: { observations: Array<typeof observation> }
        }
        mutate(value.outcomes.observations[0])
        readSuite.mockReset().mockResolvedValue(changed)
        handler = createHolderExitHistoricalOutlookHandler(readSuite)
        const rejected = await request({
          routeKey: key,
          destination: vault,
          requestedRaw: '1000000',
        })
        expect(rejected.code).toBe(503)
      }
      const boundary = structuredClone(report)
      const boundaryRow = (
        boundary.routes[0].evidence[0] as { outcomes: { observations: Array<typeof observation> } }
      ).outcomes.observations[0]
      boundaryRow.baselineAtUtc = boundaryRow.issueAtUtc
      boundaryRow.observedAtUtc = boundaryRow.targetAtUtc
      boundaryRow.localEvidenceAvailableAtUtc = boundaryRow.deadlineAtUtc
      readSuite.mockReset().mockResolvedValue(boundary)
      handler = createHolderExitHistoricalOutlookHandler(readSuite)
      const accepted = await request({ routeKey: key, destination: vault, requestedRaw: '1000000' })
      expect(accepted.code).toBe(200)
      const earlyAsOf = structuredClone(report) as typeof report & { asOfUtc: string }
      earlyAsOf.asOfUtc = '2026-10-01T02:19:59.000Z'
      readSuite.mockReset().mockResolvedValue(earlyAsOf)
      handler = createHolderExitHistoricalOutlookHandler(readSuite)
      const withheld = await request({ routeKey: key, destination: vault, requestedRaw: '1000000' })
      expect(withheld.code).toBe(503)
    }
  })

  it('rejects a staged endpoint block that supplies a capacity projection', async () => {
    const report = suite({
      exactSubjects: 1,
      subjects: [
        {
          destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
          originalAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        },
      ],
      evidence: [
        {
          ...fluidStageEvidence,
          outcomes: { ...fluidStageEvidence.outcomes, capacityProjection: 'tomorrow' },
        },
      ],
    })
    report.routes[0].routeKey = 'USDC → FluidBridgeAggregatorProxy [USDC]'
    report.routes[0].mechanism = 'staged'
    readSuite.mockResolvedValueOnce(report)
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
    const result = await request({
      routeKey: report.routes[0].routeKey,
      destination: report.routes[0].subjects[0].destination,
    })
    expect(result.code).toBe(503)
    expect(result.body).toMatchObject({ status: 'unavailable', reason: 'verification_unavailable' })
  })

  it('withholds the fixed-$10k sidecar for another Q or another tracked destination', async () => {
    const otherQ = await request({ routeKey, destination, requestedRaw: '9999999999' })
    expect(otherQ.body).toMatchObject({
      requestedRaw: '9999999999',
      routeGroup: { historicalOutlook: 'abstain' },
      evidence: null,
    })
    const otherVault = await request({ routeKey, destination: otherDestination })
    expect(otherVault.body).toMatchObject({
      destination: otherDestination,
      routeGroup: { historicalOutlook: 'abstain' },
      evidence: null,
    })
  })

  it('keeps route proxy history when the caller has no comparable Q', async () => {
    readSuite.mockResolvedValueOnce(
      suite({ promotion: 'eligible_proxy_history', evidence: [proxyEvidence] }),
    )
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
    const result = await request({ routeKey, destination }, { endpointOnly: true })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      requestedRaw: null,
      routeGroup: { historicalOutlook: 'eligible_proxy_history' },
      evidence: { evidenceId: proxyEvidence.evidenceId },
    })
  })

  it('does not expose the Morpho fixed-$10k sidecar without a matched Q', async () => {
    const result = await request({ routeKey, destination }, { endpointOnly: true })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      requestedRaw: null,
      routeGroup: { historicalOutlook: 'abstain' },
      evidence: null,
    })
  })

  it('keeps proxy evidence explicit and returns a bounded abstention when history is thin', async () => {
    readSuite.mockResolvedValueOnce(
      suite({ promotion: 'eligible_proxy_history', evidence: [proxyEvidence] }),
    )
    const proxy = await request()
    expect(proxy.code).toBe(200)
    expect(proxy.body).toMatchObject({
      routeGroup: { historicalOutlook: 'eligible_proxy_history' },
      evidence: {
        evidenceClass: 'historical_proxy',
        proxyLabel: 'saved_stage_assay_not_full_route_holder_exit',
      },
    })

    readSuite.mockResolvedValueOnce(suite({ promotion: 'abstain', evidence: [] }))
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
    const abstain = await request()
    expect(abstain.code).toBe(200)
    expect(abstain.body).toMatchObject({
      routeGroup: { historicalOutlook: 'abstain' },
      evidence: null,
    })
  })

  it('prefers exact-holder Saturn payment timing over the weaker processing-stage proxy', async () => {
    readSuite.mockResolvedValueOnce(
      suite({
        promotion: 'eligible_proxy_history',
        evidence: [proxyEvidence, saturnPaymentEvidence],
      }),
    )
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      evidence: {
        evidenceId: 'saturn_exact_holder_usdat_payment_duration',
        title: 'Request to holder payment history',
        proxyLabel: 'intermediate_usdat_payment_not_final_ausd_exit',
        headline:
          '77 exact-holder USDat payments from 146 requests; the historical median payment time was bounded at 35.2–58.1h.',
        samples: [
          { label: 'Requests', value: '146' },
          { label: 'Exact-holder payments', value: '77' },
          { label: 'Median payment interval', value: '35.2–58.1h' },
          { label: 'Paid by 72h · bounds', value: '30.1%–45.2%' },
        ],
      },
    })
  })

  it('selects only evidence matching the promoted outlook class and fails closed on mismatch', async () => {
    readSuite.mockResolvedValueOnce(
      suite({
        promotion: 'eligible_proxy_history',
        evidence: [{ ...exactEvidence, historicalUse: 'abstain' }, proxyEvidence],
      }),
    )
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
    const proxy = await request()
    expect(proxy.code).toBe(200)
    expect(proxy.body).toMatchObject({
      routeGroup: { historicalOutlook: 'eligible_proxy_history' },
      evidence: { evidenceId: proxyEvidence.evidenceId, evidenceClass: 'historical_proxy' },
    })

    readSuite.mockResolvedValueOnce(
      suite({ promotion: 'eligible_exact_endpoint_history', evidence: [proxyEvidence] }),
    )
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
    const mismatch = await request()
    expect(mismatch.code).toBe(503)
    expect(mismatch.body).toEqual({ status: 'unavailable', reason: 'verification_unavailable' })
  })

  it('discloses that mined payout history is positive-only', async () => {
    readSuite.mockResolvedValueOnce(
      suite({
        evidence: [
          {
            evidenceId: 'bounded_mined_holder_payout_history',
            evidenceClass: 'historical_endpoint',
            endpoint: 'mined_final_asset_transfer_to_holder',
            proxyLabel: null,
            samples: {
              reconciledTransactions: 217,
              supplierArchives: 0,
              sameHolderSupplierPayouts: 0,
            },
            historicalWindow: {},
            design: { unit: 'mined_transaction_or_classified_receipt_payout' },
            outcomes: { reconciledTransactions: 217, sameHolderSupplierPayouts: 0 },
            retrospectiveOnly: true,
            prospectiveValidated: false,
            historicalUse: 'available',
            limits: ['positive_only_no_failure_denominator'],
          },
        ],
      }),
    )
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
    const result = await request()
    expect(result.body).toMatchObject({
      evidence: {
        headline:
          '217 reconciled payout transactions in bounded history; positive-only, with no failure denominator.',
      },
    })
  })

  it('presents linked sUSDe payouts as historical holder-action-inclusive evidence', async () => {
    const report = suite()
    const susde = report.routes.find((candidate) => candidate.routeKey === 'Route 23')!
    susde.routeKey = 'USDe → Staked USDe [USDe]'
    susde.mechanism = 'staged'
    susde.exactSubjects = 1
    susde.subjects = [
      {
        destination: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
        originalAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
      },
    ]
    susde.promotion.historicalOutlook = 'eligible_exact_endpoint_history'
    susde.evidence = [
      {
        evidenceId: 'susde_exact_request_to_mined_usde_payout_history',
        evidenceClass: 'historical_endpoint',
        endpoint: 'same_holder_same_queue_request_to_mined_final_usde_payout',
        proxyLabel: null,
        samples: { linkedRequestPayoutEpisodes: 1, distinctHolderCommitments: 1 },
        historicalWindow: {
          fromUtc: '2026-10-02T00:00:00.000Z',
          throughUtc: '2026-10-03T00:00:36.000Z',
        },
        design: {
          unit: 'same_holder_same_queue_exact_raw_q_episode',
          paymentAsset: 'USDe',
          elapsedTimeIncludes: ['protocol_cooldown', 'holder_action'],
          localEvidenceAvailabilityClock: 'unwitnessed_local_wall_clock',
        },
        outcomes: {
          episodes: [
            {
              issueSequence: 1,
              issueSha256: '1'.repeat(64),
              holderCommitment: '2'.repeat(64),
              qRaw: '1000000000000000000',
              requestAtUtc: '2026-10-02T00:00:00.000Z',
              payoutAtUtc: '2026-10-03T00:00:36.000Z',
              localEvidenceAvailableAtUtc: '2026-10-03T02:00:00.000Z',
              observedRequestToPayoutSeconds: 86_436,
              sidecarSha256: '3'.repeat(64),
              payoutTransactionHash: `0x${'4'.repeat(64)}`,
            },
          ],
        },
        retrospectiveOnly: true,
        prospectiveValidated: false,
        historicalUse: 'available',
        limits: [
          'not_a_restriction_recovery_duration',
          'not_a_future_payment_probability_or_duration_forecast',
        ],
      },
    ]
    refreshHistoricalCoverage(report)
    readSuite.mockResolvedValueOnce(report)
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
    const result = await request({
      routeKey: susde.routeKey,
      destination: susde.subjects[0].destination,
    })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      routeGroup: { historicalOutlook: 'eligible_exact_endpoint_history' },
      evidence: {
        title: 'Exact sUSDe request to USDe payout history',
        headline:
          '1 linked historical request-to-mined-USDe payout episode; observed time includes holder action and is not restriction recovery or a forecast.',
        samples: [
          { label: 'Linked payouts', value: '1' },
          { label: 'Distinct holders', value: '1' },
          { label: 'Observed elapsed', value: '24.0–24.0h' },
        ],
      },
    })

    for (const mutation of ['payment_asset', 'holder_count', 'duplicate_identity'] as const) {
      const invalid = structuredClone(report)
      const invalidEvidence = invalid.routes.find(
        (candidate) => candidate.routeKey === susde.routeKey,
      )!.evidence[0] as {
        design: { paymentAsset: string }
        samples: { distinctHolderCommitments: number; linkedRequestPayoutEpisodes: number }
        outcomes: { episodes: Array<Record<string, unknown>> }
      }
      if (mutation === 'payment_asset') invalidEvidence.design.paymentAsset = 'USDT'
      if (mutation === 'holder_count') invalidEvidence.samples.distinctHolderCommitments = 2
      if (mutation === 'duplicate_identity') {
        invalidEvidence.outcomes.episodes.push({ ...invalidEvidence.outcomes.episodes[0] })
        invalidEvidence.samples.linkedRequestPayoutEpisodes = 2
      }
      readSuite.mockResolvedValueOnce(invalid)
      handler = createHolderExitHistoricalOutlookHandler(readSuite)
      const rejected = await request({
        routeKey: susde.routeKey,
        destination: susde.subjects[0].destination,
      })
      expect(rejected.code).toBe(503)
      expect(rejected.body).toMatchObject({ reason: 'verification_unavailable' })
    }
  })

  it('returns exact mined payout history for the supplemental Aave USDe destination', async () => {
    const usdeRouteKey = 'USDe → supply on Aave V3'
    const usdeDestination = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
    const report = suite()
    const route = report.routes.find((candidate) => candidate.routeKey === usdeRouteKey)!
    route.promotion.historicalOutlook = 'eligible_exact_endpoint_history'
    route.evidence = [
      {
        evidenceId: 'bounded_mined_holder_payout_history',
        evidenceClass: 'historical_endpoint',
        endpoint: 'mined_final_asset_transfer_to_holder',
        proxyLabel: null,
        samples: {
          reconciledTransactions: 0,
          supplierArchives: 1,
          sameHolderSupplierPayouts: 23,
        },
        historicalWindow: {
          fromBlock: 26_088_307,
          throughBlock: 26_105_755,
        },
        design: { unit: 'mined_transaction_or_classified_receipt_payout' },
        outcomes: { reconciledTransactions: 0, sameHolderSupplierPayouts: 23 },
        retrospectiveOnly: true,
        prospectiveValidated: false,
        historicalUse: 'available',
        limits: ['positive_only_no_failure_denominator'],
      },
    ]
    refreshHistoricalCoverage(report)
    readSuite.mockResolvedValueOnce(report)
    handler = createHolderExitHistoricalOutlookHandler(readSuite)

    const result = await request({ routeKey: usdeRouteKey, destination: usdeDestination })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      status: 'available',
      routeKey: usdeRouteKey,
      destination: usdeDestination,
      routeGroup: {
        mechanism: 'atomic',
        exactSubjects: 1,
        scope: 'exact_destination_route',
        historicalOutlook: 'eligible_exact_endpoint_history',
      },
      evidence: {
        evidenceId: 'bounded_mined_holder_payout_history',
        evidenceClass: 'historical_endpoint',
        headline:
          '23 same-holder payouts in 1 bounded sealed archive; positive-only, with no failure denominator.',
      },
      provenance: {
        routeGroups: 26,
        exactSubjects: 68,
        frozenCohortRouteGroups: 25,
        frozenCohortExactSubjects: 67,
        supplementalRouteGroups: 1,
        supplementalExactSubjects: 1,
      },
    })
  })

  it('fails closed on a relabeled supplemental destination or inconsistent recomputed totals', async () => {
    const relabeled = suite()
    const supplemental = relabeled.routes.find(
      (candidate) => candidate.routeKey === 'USDe → supply on Aave V3',
    )!
    supplemental.subjects[0].destination = '0x0000000000000000000000000000000000000001'
    readSuite.mockResolvedValueOnce(relabeled)
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
    expect(
      (
        await request({
          routeKey: supplemental.routeKey,
          destination: supplemental.subjects[0].destination,
        })
      ).code,
    ).toBe(503)

    const inconsistent = suite()
    inconsistent.routes[1].exactSubjects += 1
    readSuite.mockResolvedValueOnce(inconsistent)
    handler = createHolderExitHistoricalOutlookHandler(readSuite)
    expect((await request()).code).toBe(503)

    for (const field of [
      'exactEndpointHistoryRouteGroups',
      'proxyOnlyHistoryRouteGroups',
      'abstainingRouteGroups',
    ] as const) {
      const wrongCoverage = suite()
      wrongCoverage.coverage[field] += 1
      readSuite.mockResolvedValueOnce(wrongCoverage)
      handler = createHolderExitHistoricalOutlookHandler(readSuite)
      expect((await request()).code).toBe(503)
    }
  })

  it('is GET-only, loopback-only, and verifies destination membership', async () => {
    expect((await request({}, { method: 'POST' })).code).toBe(405)
    expect((await request({ routeKey, destination }, { remote: '192.168.1.8' })).code).toBe(503)
    expect((await request({ routeKey, destination: `0x${'c'.repeat(40)}` })).code).toBe(404)
    expect((await request({ routeKey })).code).toBe(400)
  })
})
