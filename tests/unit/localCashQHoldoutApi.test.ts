import type { NextApiRequest, NextApiResponse } from 'next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import handler, {
  carryForecastRequest,
  readLocalCarryExitV2EvidenceSafe,
  readProspectiveCashModelSafe,
  type LocalCarryExitV2EvidenceIdentity,
  type LocalCarryExitV2EvidenceReader,
  type ProspectiveCashModelReader,
  type ProspectiveCashModelResponse,
} from '@/pages/api/carry/forecast'
import * as supplementalCashStore from '@/scripts/lib/localSupplementalAaveUsdeCashStore.mjs'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'

vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(() => new Promise(() => {})),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

async function forecastResponse(
  query: Record<string, string>,
  prospectiveCashModelReader?: ProspectiveCashModelReader,
  localCarryExitV2EvidenceReader?: LocalCarryExitV2EvidenceReader,
) {
  vi.stubEnv('NODE_ENV', 'development')
  const request = {
    method: 'GET',
    query,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest
  let code = 0
  let body: Record<string, unknown> = {}
  const response = {
    status(value: number) {
      code = value
      return this
    },
    json(value: Record<string, unknown>) {
      body = value
      return this
    },
    setHeader() {
      return this
    },
  } as unknown as NextApiResponse
  if (prospectiveCashModelReader || localCarryExitV2EvidenceReader)
    await carryForecastRequest(
      request,
      response,
      prospectiveCashModelReader,
      localCarryExitV2EvidenceReader,
    )
  else await handler(request, response)
  return { code, body }
}

function collectingProspectiveCashModel(
  identity: Parameters<ProspectiveCashModelReader>[0],
): ProspectiveCashModelResponse {
  if (identity.horizonHours !== 24) throw new Error('expected_h24_identity')
  return {
    status: 'collecting',
    ...identity,
    horizonHours: 24,
    claim: 'aggregate_cash_proxy_only',
    holderExecutableExit: false,
    prospectiveValidated: false,
    schedule: { scheduled: 1, onTime: 1, missed: 0, coveragePercent: 100, current: true },
    outcome: { issued: 1, observed: 0, censored: 0, pending: 1, availabilityPercent: 0 },
    interval: { observed: 0, covered: 0, missed: 0, coveragePercent: 0 },
    source: {
      opportunities: 1,
      available: 1,
      unavailable: 0,
      ineligible: 0,
      unassessed: 0,
      availabilityPercent: 100,
    },
    latestActiveIssue: null,
  }
}

function collectingLocalCarryExitV2Evidence(identity: LocalCarryExitV2EvidenceIdentity) {
  return {
    status: 'collecting',
    ...identity,
    claim: 'local_exact_q_observation_only',
    provenance: 'local_operator_clock',
    independentTimestamp: false,
    independentWitness: false,
    externalMonotonicCheckpoint: false,
    rollbackProof: false,
    minedPayoutProven: false,
    prospectiveValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
    calibratedForecast: false,
    chainLimitation: 'Local SHA chain has no external monotonic checkpoint or rollback proof.',
    measurementValidatorId: 'carry-exit-v2-trusted-source-registry-v1',
    evidence: {
      issued: 1,
      pending: 1,
      recordedUnverified: 0,
      measured: 0,
      missing: 0,
      censored: 0,
      unavailable: 0,
      due: 0,
      localReadbacks: 1,
      latest: {
        targetAtUtc: '2026-10-08T12:00:00.000Z',
        deadlineAtUtc: '2026-10-08T14:00:00.000Z',
        status: 'pending',
        due: false,
        localReadback: true,
      },
    },
  } as const
}

describe('local Carry Q cash holdout API', () => {
  const aaveQuestion = {
    routeKey: 'USDC → supply on Aave V3',
    destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    amountUnits: '100000',
    horizonHours: '24',
  }

  it('retains postdeployment sampled history while the fitted pair history remains unavailable', async () => {
    const { code, body } = await forecastResponse({
      routeKey: 'USDC → VaultV2 [USDC]',
      destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
      amountUnits: '1',
      horizonHours: '24',
    })
    expect(code).toBe(200)
    expect(body.exitImpact).toMatchObject({
      historicalBacktestUnavailableReason: 'insufficient_long_history',
    })
    expect(body.sampledCashPaths).toMatchObject({
      historyCoverage: {
        gridAnchorCount: 120,
        observedAnchorCount: 109,
        leadingPredeploymentAnchorCount: 11,
        interiorUnavailableAnchorCount: 0,
      },
      prospectiveValidated: false,
      holderExecutableExit: false,
      forwardProbability: false,
    })
    const sampled = body.sampledCashPaths as { status: string; reason?: string }
    if (sampled.status === 'unavailable')
      expect(['current_cash_stale_or_future', 'invalid_current_source']).toContain(sampled.reason)
    else
      expect(sampled).toMatchObject({
        status: 'conditional_historical_sampled_cash_paths',
        counts: { samples: 109, eligibleEpisodes: 15, gaps: 0 },
      })
  }, 30_000)

  it.each(['0', '-1', 'not-an-amount'])(
    'rejects a truly invalid requested amount %s before historical replay',
    async (amountUnits) => {
      const { code, body } = await forecastResponse({ ...aaveQuestion, amountUnits })
      expect(code).toBe(400)
      expect(body).not.toHaveProperty('sampledCashPaths')
    },
  )

  it('rejects a prospective adapter response for another exact subject', async () => {
    const requested = {
      routeKey: DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey,
      destination: DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination.toLowerCase(),
      asset: DIRECT_SUPPLY_MARKETS.aaveV3Usde.underlying.toLowerCase(),
      horizonHours: 24,
    }
    const result = await readProspectiveCashModelSafe(requested, async () =>
      collectingProspectiveCashModel({
        routeKey: 'GHO → sGho [GHO]',
        destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
        asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
        horizonHours: 24,
      }),
    )

    expect(result).toMatchObject({
      status: 'unavailable',
      ...requested,
      claim: 'aggregate_cash_proxy_only',
      holderExecutableExit: false,
      prospectiveValidated: false,
      reason: 'local_evidence_unavailable',
    })
  })

  it('serves sealed history while the configured live RPC read never settles', async () => {
    const { code, body } = await forecastResponse(aaveQuestion)
    expect(code).toBe(200)
    expect(body).toMatchObject({
      routeKey: aaveQuestion.routeKey,
      destination: aaveQuestion.destination,
      evidenceStore: 'local_sha_replayed_finalized_rpc',
      exitImpact: {
        historicalBacktest: {
          status: 'historical_backtest',
          analysisKind: 'retrospective_backtest',
          question: { requestedRaw: '100000000000', horizonHours: 24 },
          prospectiveValidated: false,
          holderExecutableExit: false,
          forecastValidated: false,
          absoluteQBacktest: {
            status: 'historical_backtest',
            historicalBacktestOnly: true,
            counts: { total: 60, fit: 20, calibration: 20, holdout: 20 },
          },
        },
        historicalBacktestUnavailableReason: null,
      },
    })
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
    expect(body.prospectiveCashModel).toMatchObject({
      status: 'unavailable',
      routeKey: aaveQuestion.routeKey,
      destination: aaveQuestion.destination,
      asset: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.underlying.toLowerCase(),
      horizonHours: 24,
      reason: 'no_exact_model_match',
      claim: 'aggregate_cash_proxy_only',
      holderExecutableExit: false,
      prospectiveValidated: false,
    })
    const result = body.localCashQHoldout as Record<string, unknown>
    expect(['historical_backtest', 'unavailable']).toContain(result.status)
    if (result.status === 'historical_backtest') {
      expect(result).toMatchObject({
        claim: 'aggregate_cash_proxy_only',
        prospectiveValidated: false,
        holderExecutableExit: false,
      })
    }
  }, 30_000)

  it('uses the separate supplemental Aave USDe history without enrolling model ledgers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-05T10:31:00.000Z'))
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usde
    const prospectiveReader = vi.fn(async (identity: Parameters<ProspectiveCashModelReader>[0]) =>
      collectingProspectiveCashModel(identity),
    )
    const { code, body } = await forecastResponse(
      {
        routeKey: market.routeKey,
        destination: market.destination.toLowerCase(),
        amountUnits: '100000',
        horizonHours: '24',
      },
      prospectiveReader,
    )

    expect(code).toBe(200)
    expect(prospectiveReader).toHaveBeenCalledWith({
      routeKey: market.routeKey,
      destination: market.destination.toLowerCase(),
      asset: market.underlying.toLowerCase(),
      horizonHours: 24,
    })
    expect(body).toMatchObject({
      localCashStatus: 'observed',
      forecast: {
        asset: market.underlying.toLowerCase(),
        cashKind: 'market_cash',
      },
      exitImpact: {
        historicalBacktest: {
          status: 'historical_backtest',
          identity: {
            routeKey: market.routeKey,
            destination: market.destination.toLowerCase(),
            asset: market.underlying.toLowerCase(),
            assetDecimals: 18,
          },
          question: { requestedRaw: '100000000000000000000000', horizonHours: 24 },
          absoluteQBacktest: {
            counts: { total: 60, fit: 20, calibration: 20, holdout: 20 },
          },
        },
        historicalBacktestUnavailableReason: null,
        conditionalProjection: {
          status: 'unavailable',
          analysisKind: 'conditional_live_projection',
        },
      },
      localHistoricalScenario: { status: 'unavailable' },
      localCashQHoldout: {
        status: 'unavailable',
      },
      baselineEvidence: { status: 'not_enrolled', enrolledHorizonsHours: [1, 24] },
      historicalModel: { status: 'unavailable', reason: 'not_enrolled' },
      prospectiveCashModel: {
        status: 'collecting',
        claim: 'aggregate_cash_proxy_only',
        holderExecutableExit: false,
        prospectiveValidated: false,
      },
    })
    expect(body.prospectiveCashModel).not.toBe(body.historicalModel)
  })

  it('queries exact-Q local evidence with canonical payout decimals and preserves other models', async () => {
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usde
    const prospectiveReader = vi.fn(async (identity: Parameters<ProspectiveCashModelReader>[0]) =>
      collectingProspectiveCashModel(identity),
    )
    const localReader = vi.fn(async (identity: LocalCarryExitV2EvidenceIdentity) =>
      collectingLocalCarryExitV2Evidence(identity),
    )
    const { code, body } = await forecastResponse(
      {
        routeKey: market.routeKey,
        destination: market.destination.toLowerCase(),
        amountUnits: '100000',
        horizonHours: '24',
      },
      prospectiveReader,
      localReader,
    )

    const exactIdentity = {
      routeKey: market.routeKey,
      destination: market.destination.toLowerCase(),
      asset: market.underlying.toLowerCase(),
      decimals: 18,
      assetsRaw: '100000000000000000000000',
      horizonH: 24,
    }
    expect(code).toBe(200)
    expect(localReader).toHaveBeenCalledExactlyOnceWith(exactIdentity)
    expect(body.localCarryExitV2Evidence).toMatchObject({
      status: 'collecting',
      ...exactIdentity,
      claim: 'local_exact_q_observation_only',
      holderExecutableExit: false,
      prospectiveValidated: false,
      forecastValidated: false,
      calibratedForecast: false,
      evidence: { issued: 1, pending: 1, measured: 0 },
    })
    expect(body).toHaveProperty('historicalModel')
    expect(body.prospectiveCashModel).toMatchObject({ status: 'collecting' })
  })

  it('keeps the forecast available when the exact-Q evidence adapter throws', async () => {
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usde
    const prospectiveReader = vi.fn(async (identity: Parameters<ProspectiveCashModelReader>[0]) =>
      collectingProspectiveCashModel(identity),
    )
    const failingLocalReader: LocalCarryExitV2EvidenceReader = async () => {
      throw new Error('private_local_ledger_failure')
    }
    const { code, body } = await forecastResponse(
      {
        routeKey: market.routeKey,
        destination: market.destination.toLowerCase(),
        amountUnits: '100000',
        horizonHours: '24',
      },
      prospectiveReader,
      failingLocalReader,
    )

    expect(code).toBe(200)
    expect(body.localCarryExitV2Evidence).toEqual({
      status: 'unavailable',
      routeKey: market.routeKey,
      destination: market.destination.toLowerCase(),
      asset: market.underlying.toLowerCase(),
      decimals: 18,
      assetsRaw: '100000000000000000000000',
      horizonH: 24,
      claim: 'local_exact_q_observation_only',
      provenance: 'local_operator_clock',
      independentTimestamp: false,
      independentWitness: false,
      externalMonotonicCheckpoint: false,
      rollbackProof: false,
      minedPayoutProven: false,
      prospectiveValidated: false,
      forecastValidated: false,
      holderExecutableExit: false,
      calibratedForecast: false,
      chainLimitation: 'Local SHA chain has no external monotonic checkpoint or rollback proof.',
      measurementValidatorId: null,
      evidence: null,
      reason: 'local_evidence_unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('private_local_ledger_failure')
    expect(body).toHaveProperty('historicalModel')
    expect(body.prospectiveCashModel).toMatchObject({ status: 'collecting' })
  })

  it('rejects exact-Q evidence that overstates validation or holder execution', async () => {
    const identity: LocalCarryExitV2EvidenceIdentity = {
      routeKey: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey,
      destination: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.destination.toLowerCase(),
      asset: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.underlying.toLowerCase(),
      decimals: 6,
      assetsRaw: '100000000000',
      horizonH: 24,
    }
    const result = await readLocalCarryExitV2EvidenceSafe(identity, async () => ({
      ...collectingLocalCarryExitV2Evidence(identity),
      holderExecutableExit: true,
      prospectiveValidated: true,
    }))

    expect(result).toMatchObject({
      status: 'unavailable',
      ...identity,
      reason: 'local_evidence_unavailable',
      holderExecutableExit: false,
      prospectiveValidated: false,
      forecastValidated: false,
      calibratedForecast: false,
      evidence: null,
    })
  })

  it('rebuilds exact-Q evidence from the public allowlist and drops private adapter fields', async () => {
    const identity: LocalCarryExitV2EvidenceIdentity = {
      routeKey: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey,
      destination: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.destination.toLowerCase(),
      asset: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.underlying.toLowerCase(),
      decimals: 6,
      assetsRaw: '100000000000',
      horizonH: 24,
    }
    const result = await readLocalCarryExitV2EvidenceSafe(identity, async () => ({
      ...collectingLocalCarryExitV2Evidence(identity),
      issueId: 'private-issue',
      holder: `0x${'9'.repeat(40)}`,
      evidence: {
        ...collectingLocalCarryExitV2Evidence(identity).evidence,
        proofEnvelope: { secret: 'private-proof' },
        latest: {
          ...collectingLocalCarryExitV2Evidence(identity).evidence.latest,
          witnessId: 'private-witness',
        },
      },
    }))

    expect(result.status).toBe('collecting')
    const encoded = JSON.stringify(result)
    expect(encoded).not.toContain('private-issue')
    expect(encoded).not.toContain('private-witness')
    expect(encoded).not.toContain('private-proof')
    expect(encoded).not.toContain(`0x${'9'.repeat(40)}`)
  })

  it('does not expose an unrecognized unavailable reason from the local adapter', async () => {
    const identity: LocalCarryExitV2EvidenceIdentity = {
      routeKey: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey,
      destination: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.destination.toLowerCase(),
      asset: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.underlying.toLowerCase(),
      decimals: 6,
      assetsRaw: '100000000000',
      horizonH: 24,
    }
    const privateReason = 'ledger=/Users/private/holder-address'
    const result = await readLocalCarryExitV2EvidenceSafe(identity, async () => ({
      ...collectingLocalCarryExitV2Evidence(identity),
      status: 'unavailable',
      measurementValidatorId: null,
      evidence: null,
      reason: privateReason,
    }))

    expect(result).toMatchObject({ status: 'unavailable', reason: 'local_evidence_unavailable' })
    expect(JSON.stringify(result)).not.toContain(privateReason)
  })

  it('passes the exact sGHO H24 payout identity to the prospective model', async () => {
    const question = {
      routeKey: 'GHO → sGho [GHO]',
      destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
      amountUnits: '100000',
      horizonHours: '24',
    }
    const prospectiveReader = vi.fn(async (identity: Parameters<ProspectiveCashModelReader>[0]) =>
      collectingProspectiveCashModel(identity),
    )
    const { code, body } = await forecastResponse(question, prospectiveReader)

    expect(code).toBe(200)
    expect(prospectiveReader).toHaveBeenCalledWith({
      routeKey: question.routeKey,
      destination: question.destination,
      asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
      horizonHours: 24,
    })
    expect(body.prospectiveCashModel).toMatchObject({
      status: 'collecting',
      routeKey: question.routeKey,
      destination: question.destination,
      asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
      horizonHours: 24,
      claim: 'aggregate_cash_proxy_only',
      holderExecutableExit: false,
    })
    expect(body).toHaveProperty('historicalModel')
  }, 30_000)

  it('keeps the endpoint available when the prospective adapter throws', async () => {
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usde
    const failingReader: ProspectiveCashModelReader = async () => {
      throw new Error('adapter_load_failed')
    }
    const { code, body } = await forecastResponse(
      {
        routeKey: market.routeKey,
        destination: market.destination.toLowerCase(),
        amountUnits: '100000',
        horizonHours: '24',
      },
      failingReader,
    )

    expect(code).toBe(200)
    expect(body.prospectiveCashModel).toEqual({
      status: 'unavailable',
      routeKey: market.routeKey,
      destination: market.destination.toLowerCase(),
      asset: market.underlying.toLowerCase(),
      horizonHours: 24,
      claim: 'aggregate_cash_proxy_only',
      holderExecutableExit: false,
      prospectiveValidated: false,
      schedule: null,
      outcome: null,
      interval: null,
      source: null,
      latestActiveIssue: null,
      reason: 'local_evidence_unavailable',
    })
    expect(body).toHaveProperty('historicalModel')
  })

  it('fails closed when the supplemental receipt ledger is invalid', async () => {
    vi.spyOn(supplementalCashStore, 'verifyLocalSupplementalAaveUsdeCash').mockImplementation(
      () => {
        throw new Error('supplemental_aave_usde_cash_hash_mismatch')
      },
    )
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usde
    const { code, body } = await forecastResponse({
      routeKey: market.routeKey,
      destination: market.destination.toLowerCase(),
      amountUnits: '100000',
      horizonHours: '24',
    })

    expect(code).toBe(503)
    expect(body).toEqual({ error: 'local_cash_evidence_unavailable' })
  })

  it.each([
    [
      'AUSD payout from Staked USDat cash',
      'AUSD → Staked USDat [USDat]',
      '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
    ],
    [
      'PYUSD payout from wYLDS cash',
      'PYUSD → StakingVault [wYLDS]',
      '0x19ebb35279a16207ec4ba82799cc64715065f7f6',
    ],
    [
      'USDT payout from USDC cash',
      'USDT → FluidBridgeAggregatorProxy [USDC]',
      '0x273da948aca9261043fbdb2a857bc255ecc29012',
    ],
  ])(
    'abstains for %s without exact asset conversion',
    async (_label, routeKey, destination) => {
      const { code, body } = await forecastResponse({
        routeKey,
        destination,
        amountUnits: '100000',
        horizonHours: '24',
      })

      expect(code).toBe(200)
      expect(body.exitImpact).toMatchObject({
        historicalBacktest: null,
        historicalBacktestUnavailableReason: 'asset_identity_mismatch',
        conditionalProjection: null,
      })
      expect(body.localCashQHoldout).toMatchObject({ status: 'unavailable' })
      expect(body.sampledCashPaths).toMatchObject({
        status: 'unavailable',
        reason: 'subject_mismatch',
      })
    },
    30_000,
  )

  it('keeps the Twyne wrapper on its distinct unassessed cash path', async () => {
    const { code, body } = await forecastResponse({
      routeKey: 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
      destination: '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
      amountUnits: '100000',
      horizonHours: '24',
    })

    expect(code).toBe(200)
    expect(body.exitImpact).toMatchObject({
      historicalBacktest: null,
      historicalBacktestUnavailableReason: 'subject_unassessed',
      conditionalProjection: null,
    })
  }, 30_000)

  it('replays sampled paths with fresh current cash despite failed prospective readers', async () => {
    const now = Date.parse('2026-10-08T12:00:00.000Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValueOnce({
      status: 'available',
      sourceKind: 'live_read_only_two_origin_finalized',
      routeKey: aaveQuestion.routeKey,
      destination: aaveQuestion.destination,
      asset: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.underlying.toLowerCase(),
      assetDecimals: 6,
      cashRaw: '500000000000',
      block: '99999999',
      blockHash: `0x${'d'.repeat(64)}`,
      blockAt: '2026-10-08T11:50:00.000Z',
      readAtUtc: '2026-10-08T12:00:00.000Z',
    })
    const { code, body } = await forecastResponse(
      { ...aaveQuestion, includeLiveCurrent: '1' },
      async () => {
        throw new Error('failed_model')
      },
      async () => {
        throw new Error('failed_exact_q_ledger')
      },
    )
    expect(code).toBe(200)
    expect(body.prospectiveCashModel).toMatchObject({ status: 'unavailable' })
    expect(
      body.sampledCashPaths,
      JSON.stringify(body.sampledCashPaths) + JSON.stringify(body.liveCurrentRead),
    ).toMatchObject({
      status: 'conditional_historical_sampled_cash_paths',
      horizonHours: 168,
      requestedRaw: '100000000000',
      forwardProbability: false,
      holderExecutableExit: false,
      current: { cashRaw: '500000000000', block: '99999999' },
    })
  }, 30_000)

  it('rechecks the current source after live awaits while retaining sealed history', async () => {
    const now = Date.parse('2026-10-08T12:00:00.000Z')
    let clock = now
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.mocked(readConfiguredLiveCurrentCash).mockImplementationOnce(async () => {
      clock += 3 * 3600000
      return {
        status: 'available',
        sourceKind: 'live_read_only_two_origin_finalized',
        routeKey: aaveQuestion.routeKey,
        destination: aaveQuestion.destination,
        asset: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.underlying.toLowerCase(),
        assetDecimals: 6,
        cashRaw: '500000000000',
        block: '99999999',
        blockHash: `0x${'d'.repeat(64)}`,
        blockAt: '2026-10-08T11:50:00.000Z',
        readAtUtc: '2026-10-08T12:00:00.000Z',
      }
    })
    const { code, body } = await forecastResponse({ ...aaveQuestion, includeLiveCurrent: '1' })
    expect(code).toBe(200)
    expect(body.sampledCashPaths).toMatchObject({ status: 'unavailable' })
    expect(body.exitImpact).toMatchObject({ historicalBacktest: { status: 'historical_backtest' } })
  }, 30_000)

  it('bounds a requested live enrichment when the RPC read never settles', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-06T12:00:00.000Z'))
    const { code, body } = await forecastResponse({ ...aaveQuestion, includeLiveCurrent: '1' })

    expect(code).toBe(200)
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledOnce()
    expect(body.liveCurrentRead).toMatchObject({
      status: 'unavailable',
      reason: 'live_read_timeout',
    })
    expect(body.exitImpact).toMatchObject({
      historicalBacktest: { status: 'historical_backtest' },
    })
  }, 15_000)
})
