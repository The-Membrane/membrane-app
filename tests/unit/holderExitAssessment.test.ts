import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import { APXUSD_ASSET, APYUSD_ROUTE, APYUSD_VAULT, readApyUsdExit } from '@/lib/carry/apyUsdExit'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { readDirectSupplyExitQuote } from '@/lib/carry/directSupplyExitQuote'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import morphoIdentities from '@/lib/carry/morpho-v2-asset-identities.json'
import { readMorphoExitQuote } from '@/lib/carry/morphoExitQuote'
import {
  HASTRA_STAKING_VAULT,
  HASTRA_YIELD_VAULT,
  PYUSD_STAKING_ROUTE,
  PYUSD_TOKEN,
  USDC_TOKEN,
  readPyusdStakingRouteIdentity,
} from '@/lib/carry/pyusdStakingRouteIdentity'
import { readPyusdStakingFirstLeg } from '@/lib/carry/pyusdStakingFirstLeg'
import { readPyusdStakingYieldQueue } from '@/lib/carry/pyusdStakingYieldQueue'
import { readSghoExit } from '@/lib/carry/sghoExit'
import { readSaturnTicketConversionQuote } from '@/lib/carry/saturnTicketConversionQuote'
import {
  readStakedUsdatExit,
  STAKED_USDAT_QUEUE,
  STAKED_USDAT_ROUTE,
  STAKED_USDAT_VAULT,
  USDAT_ASSET,
} from '@/lib/carry/stakedUsdatExit'
import {
  readSusdeCooldownExitQuote,
  resolveSusdeCooldownExitTarget,
} from '@/lib/carry/susdeCooldownExitQuote'
import {
  SUSDS_ROUTE_KEY,
  SUSDS_VAULT,
  USDS_ASSET,
  readSusdsExitQuote,
} from '@/lib/carry/susdsExitQuote'
import {
  FLUID_BRIDGE_VAULT,
  FLUID_USDT_ROUTE,
  SGHO_ROUTE_KEY,
  AUSD_ASSET,
  USDE_ASSET,
  USDC,
  USDT,
  readHolderExitAssessment,
  validateHolderExitAssessmentRequest,
} from '@/lib/carry/holderExitAssessment'
import {
  readTrackedDirectVaultExit,
  resolveTrackedDirectVaultExitTarget,
} from '@/lib/carry/trackedDirectVaultExit'
import { readTwyneBorrowerExit, TWYNE_PT_BORROWER_DEPLOYMENT } from '@/lib/carry/twyneBorrowerExit'
import {
  TWYNE_AAVE_POOL,
  TWYNE_PT_ASSET,
  TWYNE_PT_ROUTE,
  TWYNE_PT_WRAPPER,
} from '@/lib/carry/twynePtExit'
import {
  ORIGINAL_GHO,
  UMBRELLA_GHO_ROUTE,
  UMBRELLA_STKGHO,
  readUmbrellaGhoExit,
} from '@/lib/carry/umbrellaGhoExit'
import { USD3_ROUTE_KEY, USD3_VAULT, readUsd3ExitQuote } from '@/lib/carry/usd3ExitQuote'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

vi.mock('@/lib/carry/directSupplyExitQuote', async (original) => ({
  ...(await original<typeof import('@/lib/carry/directSupplyExitQuote')>()),
  readDirectSupplyExitQuote: vi.fn(),
}))
vi.mock('@/lib/carry/apyUsdExit', async (original) => ({
  ...(await original<typeof import('@/lib/carry/apyUsdExit')>()),
  readApyUsdExit: vi.fn(),
}))
vi.mock('@/lib/carry/trackedDirectVaultExit', async (original) => ({
  ...(await original<typeof import('@/lib/carry/trackedDirectVaultExit')>()),
  readTrackedDirectVaultExit: vi.fn(),
}))
vi.mock('@/lib/carry/twyneBorrowerExit', async (original) => ({
  ...(await original<typeof import('@/lib/carry/twyneBorrowerExit')>()),
  readTwyneBorrowerExit: vi.fn(),
}))
vi.mock('@/lib/carry/morphoExitQuote', async (original) => ({
  ...(await original<typeof import('@/lib/carry/morphoExitQuote')>()),
  readMorphoExitQuote: vi.fn(),
}))
vi.mock('@/lib/carry/pyusdStakingRouteIdentity', async (original) => ({
  ...(await original<typeof import('@/lib/carry/pyusdStakingRouteIdentity')>()),
  readPyusdStakingRouteIdentity: vi.fn(),
}))
vi.mock('@/lib/carry/pyusdStakingFirstLeg', () => ({ readPyusdStakingFirstLeg: vi.fn() }))
vi.mock('@/lib/carry/pyusdStakingYieldQueue', () => ({ readPyusdStakingYieldQueue: vi.fn() }))
vi.mock('@/lib/carry/sghoExit', async (original) => ({
  ...(await original<typeof import('@/lib/carry/sghoExit')>()),
  readSghoExit: vi.fn(),
}))
vi.mock('@/lib/carry/saturnTicketConversionQuote', () => ({
  readSaturnTicketConversionQuote: vi.fn(),
}))
vi.mock('@/lib/carry/stakedUsdatExit', async (original) => ({
  ...(await original<typeof import('@/lib/carry/stakedUsdatExit')>()),
  readStakedUsdatExit: vi.fn(),
}))
vi.mock('@/lib/carry/susdeCooldownExitQuote', async (original) => ({
  ...(await original<typeof import('@/lib/carry/susdeCooldownExitQuote')>()),
  readSusdeCooldownExitQuote: vi.fn(),
}))
vi.mock('@/lib/carry/susdsExitQuote', async (original) => ({
  ...(await original<typeof import('@/lib/carry/susdsExitQuote')>()),
  readSusdsExitQuote: vi.fn(),
}))
vi.mock('@/lib/carry/usd3ExitQuote', async (original) => ({
  ...(await original<typeof import('@/lib/carry/usd3ExitQuote')>()),
  readUsd3ExitQuote: vi.fn(),
}))
vi.mock('@/lib/carry/umbrellaGhoExit', async (original) => ({
  ...(await original<typeof import('@/lib/carry/umbrellaGhoExit')>()),
  readUmbrellaGhoExit: vi.fn(),
}))

const HASH = `0x${'a'.repeat(64)}` as const
const OWNER = '0x0000000000000000000000000000000000000001'
const TWYNE_CV = '0x259b9f78382febfb76d02d6243ee4f12af7f0c37'
const DIRECT = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const base = {
  routeKey: DIRECT.routeKey,
  destinationAddress: DIRECT.destination,
  owner: OWNER,
  assetsRaw: '1000000',
  horizonHours: 24,
}
const apyFeeCurve = {
  minFeeWad: '0',
  maxFeeWad: '34000000000000000',
  minDurationSeconds: 259200,
  maxDurationSeconds: 1728000,
  curvatureWad: '1000000000000000000',
}
const MORPHO = morphoIdentities.entries[0]
const MORPHO_ROUTE = seed.positions.find((entry) => entry.vault.toLowerCase() === MORPHO.vault)!
  .routeIds[0]
const morphoRequest = vi.fn()
const apyRequest = vi.fn()
const clients = {
  direct: {} as never,
  apy: { request: apyRequest } as never,
  tracked: {} as never,
  morpho: { request: morphoRequest } as never,
}

describe('chosen-owner holder exit assessment', () => {
  beforeEach(() => {
    vi.mocked(readUmbrellaGhoExit)
      .mockReset()
      .mockResolvedValue({
        status: 'observed',
        evidence: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTimestamp: 1790812800,
          proxy: UMBRELLA_STKGHO,
          routeAsset: ORIGINAL_GHO,
        },
        originalAsset: ORIGINAL_GHO,
        state: 'window_open',
        cooldownEnd: 1790810000,
        windowEndInclusive: 1790815000,
        currentCooldownSeconds: 86400,
        currentUnstakeWindowSeconds: 5000,
        amountCheck: {
          requested: { unit: 'assets', raw: '1000000' },
          gate: 'window_open',
          slashExposure: 'slashable_assets_present',
          simulation: { status: 'success', ghoRaw: '1200000' },
        },
      } as never)
    apyRequest.mockReset().mockResolvedValue('0x')
    vi.mocked(readSghoExit)
      .mockReset()
      .mockResolvedValue({
        source: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTime: '2026-10-01T00:00:00.000Z',
        },
        vault: { address: GHO_SGHO.destination, assetAddress: GHO_SGHO.borrowAsset },
        request: { assetsRaw: '1000000' },
        simulation: { status: 'success' },
      } as never)
    vi.mocked(readStakedUsdatExit)
      .mockReset()
      .mockResolvedValue({
        status: 'observed',
        evidence: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTimestamp: 1790812800,
          vault: STAKED_USDAT_VAULT,
          queue: STAKED_USDAT_QUEUE,
          underlying: USDAT_ASSET,
        },
        current: {
          requestedSharesRaw: '10000000000000000000',
          previewUsdatRaw: '10334658',
          request: { status: 'success', requestTokenId: '1670' },
          existingTicket: {
            tokenId: '1669',
            ownership: 'holder',
            claimSimulation: 'success',
            simulatedUsdatRaw: '10200000',
            requestedAtUnix: '1790809200',
          },
        },
      } as never)
    vi.mocked(readSaturnTicketConversionQuote).mockReset().mockResolvedValue({
      status: 'conditional_quote',
      usdatInputRaw: '10200000',
      usdcQuotedRaw: '10190000',
      ausdQuotedRaw: '10180000000000000000',
      curveCashUsdcRaw: '1000000000000',
      curveCashUsdatRaw: '1000000000000',
      uniswapActiveLiquidityRaw: '1000000000000',
      initializedTicksCrossed: 1,
      execution: 'unassessed',
    })
    vi.mocked(readTwyneBorrowerExit)
      .mockReset()
      .mockResolvedValue({
        status: 'observed',
        routeKey: TWYNE_PT_ROUTE,
        collateralVault: TWYNE_CV,
        borrower: OWNER,
        requestedPtRaw: '1000000000000000000',
        evidence: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTimestamp: 1790812800,
          asset: TWYNE_PT_WRAPPER,
          targetAsset: USDE_ASSET,
          targetVault: TWYNE_AAVE_POOL,
          returnedPtRaw: '1000000000000000000',
          receiver: 'borrower',
        },
      } as never)
    vi.mocked(readPyusdStakingRouteIdentity)
      .mockReset()
      .mockResolvedValue({
        status: 'route_asset_mismatch',
        reason: 'pyusd_leg_not_verified',
        routeKey: PYUSD_STAKING_ROUTE,
        destination: HASTRA_STAKING_VAULT,
        evidence: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTimestamp: 1790812800,
          stakingAsset: HASTRA_YIELD_VAULT,
          yieldAsset: USDC_TOKEN,
          pyusdDecimals: 6,
        },
        assetLinks: 'staking_asset_wYLDS_yield_asset_USDC',
        pyusdPayout: 'not_attested',
        holderAmountCheck: 'not_performed_route_incomplete',
      } as never)
    vi.mocked(readPyusdStakingFirstLeg).mockReset().mockResolvedValue({
      requestedPrimeSharesRaw: '1000000',
      holderPrimeSharesRaw: '3000000',
      maxRedeemRaw: '3000000',
      previewWyldsRaw: '1050000',
      simulatedWyldsRaw: '1050000',
      stakingPaused: false,
      holderFrozen: false,
      reason: 'prime_to_wylds_callable',
    })
    vi.mocked(readPyusdStakingYieldQueue).mockReset().mockResolvedValue({
      holder: OWNER,
      existingWyldsSharesRaw: '2000000',
      pendingSharesRaw: '1000000',
      pendingUsdcRaw: '990000',
      pendingSinceUnix: '1790800000',
      yieldPaused: false,
      yieldFrozen: false,
      redeemVault: OWNER,
      requestAssessed: false,
      completion: 'admin_gated_unassessed',
      usdcPayout: 'not_attested',
    })
    vi.mocked(readSusdeCooldownExitQuote)
      .mockReset()
      .mockResolvedValue({
        source: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTime: '2026-10-01T00:00:00.000Z',
        },
        routeKey: 'USDe → Staked USDe [USDe]',
        exitMode: 'cooldown',
        susdeHolderFacts: {
          owner: OWNER,
          originAgreement: 'not_compared',
          status: 'observed',
          activeSharesRaw: '5000000',
          activeEntitlementRaw: '5500000',
          method: 'preview_redeem_full_active_position',
          semanticQualification: 'UNQUALIFIED',
          sourceQualification: 'UNQUALIFIED',
          ceilingQualification: 'getter_only_not_callability',
          source: {
            chainId: 1,
            vaultAddress: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
            assetAddress: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
            blockNumber: 26090000,
            blockHash: HASH,
            blockTime: '2026-10-01T00:00:00.000Z',
          },
          pendingAssetsRaw: '2500000',
          storedCooldownEndUnix: '1790726400',
          cooldownDurationSeconds: '604800',
          maxInitiationAssetsRaw: '5000000',
        },
        vault: {
          address: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
          assetAddress: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
          siloAddress: '0x7FC7c91D556B400AFa565013E3F32055a0713425',
          cooldownDurationSeconds: 604800,
        },
        request: { assetsRaw: '1000000' },
        pending: { assetsRaw: '2500000' },
        aggregateSiloUsde: { balanceRaw: '7500000' },
        initiation: { status: 'success' },
        directWithdrawal: null,
        claim: { status: 'success' },
        currentClaimEarliestAt: '2026-09-30T00:00:00.000Z',
        newRequestWouldResetPending: true,
        ifInitiatedAtCheckedBlockEarliestAt: '2026-10-08T00:00:00.000Z',
      } as never)
    vi.mocked(readSusdsExitQuote)
      .mockReset()
      .mockResolvedValue({
        source: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTime: '2026-10-01T00:00:00.000Z',
        },
        routeKey: SUSDS_ROUTE_KEY,
        vault: { address: SUSDS_VAULT, assetAddress: USDS_ASSET },
        request: { assetsRaw: '1000000' },
        simulation: { status: 'success' },
      } as never)
    vi.mocked(readUsd3ExitQuote)
      .mockReset()
      .mockResolvedValue({
        source: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTime: '2026-10-01T00:00:00.000Z',
        },
        routeKey: USD3_ROUTE_KEY,
        vault: { address: USD3_VAULT, assetAddress: USDC },
        request: { assetsRaw: '1000000' },
        simulation: { status: 'success' },
      } as never)
    vi.mocked(readDirectSupplyExitQuote)
      .mockReset()
      .mockResolvedValue({
        source: { blockNumber: 26090000, blockHash: HASH, blockTime: '2026-10-01T00:00:00.000Z' },
        simulation: { status: 'success' },
      } as never)
    vi.mocked(readApyUsdExit)
      .mockReset()
      .mockResolvedValue({
        status: 'observed',
        evidence: { blockNumber: 26090000, blockHash: HASH, blockTimestamp: 1790812800 },
        current: {
          initiation: { status: 'success' },
          existingReceipt: null,
          currentFeeCurve: apyFeeCurve,
          currentMinimumClaimDelaySeconds: 259200,
          ifInitiatedAtCheckedBlockClaimableAt: 1791072000,
          ifInitiatedAtCheckedBlockEarliestNetRaw: '966000000000000000',
          ifInitiatedAtCheckedBlockMinimumFeeAt: 1792540800,
          ifInitiatedAtCheckedBlockMinimumFeeNetRaw: '1000000000000000000',
        },
      } as never)
    vi.mocked(readTrackedDirectVaultExit)
      .mockReset()
      .mockImplementation(
        async (_, request) =>
          ({
            source: {
              chainId: 1,
              blockNumber: 26090000,
              blockHash: HASH,
              blockTime: '2026-10-01T00:00:00.000Z',
            },
            routeKey: request.routeKey,
            vault: {
              address: request.destinationAddress,
              assetAddress: resolveTrackedDirectVaultExitTarget(
                request.routeKey,
                request.destinationAddress,
              ).asset,
            },
            request: { assetsRaw: request.assetsRaw },
            simulation: { status: 'success' },
          }) as never,
      )
    morphoRequest.mockReset().mockResolvedValue('0x')
    vi.mocked(readMorphoExitQuote)
      .mockReset()
      .mockResolvedValue({
        source: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTime: '2026-10-01T00:00:00.000Z',
        },
        routeKey: MORPHO_ROUTE,
        vault: { address: MORPHO.vault, assetAddress: MORPHO.asset },
        request: { assetsRaw: '1000000' },
        simulation: { status: 'success' },
      } as never)
  })

  it('normalizes Umbrella GHO only when the holder window and redeem Q succeed', async () => {
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: UMBRELLA_GHO_ROUTE,
      destinationAddress: UMBRELLA_STKGHO,
    })
    expect(vi.mocked(readUmbrellaGhoExit).mock.calls[0][1]).toMatchObject({
      routeKey: UMBRELLA_GHO_ROUTE,
      destinationAddress: UMBRELLA_STKGHO,
      holder: OWNER,
      assetsRaw: '1000000',
    })
    expect(apyRequest).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: HASH, requireCanonical: true }],
    })
    expect(result.status).toBe('assessed')
    expect(result.source).toMatchObject({
      blockNumber: 26090000,
      blockHash: HASH,
      originValidation: 'single_provider',
    })
    expect(result.finalPayout).toEqual({
      assetAddress: ORIGINAL_GHO,
      status: 'simulated',
      amountRaw: '1200000',
    })
    expect(result.condition).toEqual({
      gate: 'window_open',
      cooldownEnd: 1790810000,
      windowEndInclusive: 1790815000,
      currentCooldownSeconds: 86400,
      currentUnstakeWindowSeconds: 5000,
      slashExposure: 'slashable_assets_present',
    })
    expect(result.forecast.prospectiveValidated).toBe(false)
    expect(result.forecast.exitDurationHours).toBeNull()
  })

  it('keeps Umbrella payout unassessed when window is closed or redeem result is below Q', async () => {
    vi.mocked(readUmbrellaGhoExit).mockResolvedValueOnce({
      status: 'observed',
      evidence: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTimestamp: 1790812800,
        proxy: UMBRELLA_STKGHO,
        routeAsset: ORIGINAL_GHO,
      },
      originalAsset: ORIGINAL_GHO,
      state: 'waiting',
      cooldownEnd: 1790820000,
      windowEndInclusive: 1790825000,
      currentCooldownSeconds: 86400,
      currentUnstakeWindowSeconds: 5000,
      amountCheck: {
        requested: { unit: 'assets', raw: '1000000' },
        gate: 'waiting',
        slashExposure: 'slashable_assets_present',
        simulation: { status: 'success', ghoRaw: '1200000' },
      },
    } as never)
    const waiting = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: UMBRELLA_GHO_ROUTE,
      destinationAddress: UMBRELLA_STKGHO,
    })
    expect(waiting.status).toBe('partial')
    expect(waiting.finalPayout.status).toBe('unassessed')
    expect(waiting.condition?.gate).toBe('waiting')
    vi.mocked(readUmbrellaGhoExit).mockResolvedValueOnce({
      status: 'observed',
      evidence: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTimestamp: 1790812800,
        proxy: UMBRELLA_STKGHO,
        routeAsset: ORIGINAL_GHO,
      },
      originalAsset: ORIGINAL_GHO,
      state: 'window_open',
      cooldownEnd: 1790810000,
      windowEndInclusive: 1790815000,
      currentCooldownSeconds: 86400,
      currentUnstakeWindowSeconds: 5000,
      amountCheck: {
        requested: { unit: 'assets', raw: '1000000' },
        gate: 'window_open',
        slashExposure: 'no_slashable_assets',
        simulation: { status: 'success', ghoRaw: '999999' },
      },
    } as never)
    const low = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: UMBRELLA_GHO_ROUTE,
      destinationAddress: UMBRELLA_STKGHO,
    })
    expect(low.status).toBe('partial')
    expect(low.finalPayout.status).toBe('unassessed')
  })

  it('fails closed on missing Umbrella EOA proof or inconsistent amount identity', async () => {
    const input = { ...base, routeKey: UMBRELLA_GHO_ROUTE, destinationAddress: UMBRELLA_STKGHO }
    apyRequest.mockResolvedValueOnce(undefined)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_eoa_unverified',
    )
    vi.mocked(readUmbrellaGhoExit).mockResolvedValueOnce({
      status: 'observed',
      evidence: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTimestamp: 1790812800,
        proxy: UMBRELLA_STKGHO,
        routeAsset: ORIGINAL_GHO,
      },
      originalAsset: ORIGINAL_GHO,
      amountCheck: { requested: { unit: 'shares', raw: '1000000' } },
    } as never)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_umbrella_amount_mismatch',
    )
  })

  it('keeps sUSDe initiation Q separate from an older pending claim', async () => {
    const target = resolveSusdeCooldownExitTarget(
      'USDe → Staked USDe [USDe]',
      '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    )
    const input = {
      ...base,
      routeKey: target.routeKey,
      destinationAddress: target.vault,
      horizonHours: 720,
    }
    const result = await readHolderExitAssessment(clients, input)
    expect(readSusdeCooldownExitQuote).toHaveBeenCalledWith(clients.apy, {
      routeKey: target.routeKey,
      destinationAddress: target.vault,
      owner: OWNER,
      assetsRaw: '1000000',
    })
    expect(result.susdeHolderFacts).toBeUndefined()
    expect(apyRequest).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: HASH, requireCanonical: true }],
    })
    expect(result.status).toBe('partial')
    expect(result.request).toEqual({
      assetsRaw: '1000000',
      assetAddress: target.asset,
      horizonHours: 720,
    })
    expect(result.stages).toEqual([
      {
        name: 'cooldown_initiation',
        assetAddress: target.asset,
        status: 'simulated',
        amountRaw: '1000000',
        relatedToRequest: true,
      },
      {
        name: 'pending_claim',
        assetAddress: target.asset,
        status: 'simulated',
        amountRaw: '2500000',
        relatedToRequest: false,
      },
    ])
    expect(result.finalPayout).toEqual({
      assetAddress: target.asset,
      status: 'unassessed',
      amountRaw: null,
    })
    expect(result.cooldownCondition).toEqual({
      exitMode: 'cooldown',
      durationSeconds: 604800,
      pendingAssetsRaw: '2500000',
      aggregateSiloUsdeRaw: '7500000',
      pendingClaimEarliestAt: '2026-09-30T00:00:00.000Z',
      initiationStatus: 'success',
      directWithdrawalStatus: null,
      pendingClaimStatus: 'success',
      newRequestWouldResetPending: true,
      ifInitiatedAtCheckedBlockEarliestAt: '2026-10-08T00:00:00.000Z',
    })
    expect(result.cooldownCondition?.aggregateSiloUsdeRaw).not.toBe(
      result.cooldownCondition?.pendingAssetsRaw,
    )
    expect(result.forecast).toMatchObject({ futureExit: null, exitDurationHours: null })
  })

  it('forwards optional full active sUSDe facts without qualifying Q or the older queue', async () => {
    const target = resolveSusdeCooldownExitTarget(
      'USDe → Staked USDe [USDe]',
      '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    )
    const result = await readHolderExitAssessment(
      clients,
      { ...base, routeKey: target.routeKey, destinationAddress: target.vault },
      { includeCapacityFacts: true },
    )
    expect(readSusdeCooldownExitQuote).toHaveBeenCalledWith(
      clients.apy,
      expect.objectContaining({ assetsRaw: '1000000' }),
      expect.any(Function),
      { includeCapacityFacts: true },
    )
    expect(result.susdeHolderFacts).toMatchObject({
      activeEntitlementRaw: '5500000',
      pendingAssetsRaw: '2500000',
      semanticQualification: 'UNQUALIFIED',
      source: { blockHash: HASH },
    })
    expect(result.stages[1]).toMatchObject({ amountRaw: '2500000', relatedToRequest: false })
    expect(result.finalPayout).toMatchObject({ status: 'unassessed', amountRaw: null })
    expect(result.forecast).toMatchObject({ prospectiveValidated: false, futureExit: null })
    expect(result.capacityQuote).toBeUndefined()
  })

  it('maps zero-duration sUSDe to a direct Q withdrawal and keeps the old queue separate', async () => {
    const target = resolveSusdeCooldownExitTarget(
      'USDe → Staked USDe [USDe]',
      '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    )
    vi.mocked(readSusdeCooldownExitQuote).mockResolvedValueOnce({
      source: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTime: '2026-10-01T00:00:00.000Z',
      },
      exitMode: 'direct_withdrawal',
      routeKey: target.routeKey,
      vault: {
        address: target.vault,
        assetAddress: target.asset,
        siloAddress: target.silo,
        cooldownDurationSeconds: 0,
      },
      request: { assetsRaw: '1000000' },
      aggregateSiloUsde: { balanceRaw: '7500000' },
      pending: { assetsRaw: '2500000' },
      initiation: { status: 'not_applicable' },
      directWithdrawal: { status: 'success', sharesBurnedRaw: '900000' },
      claim: { status: 'success' },
      currentClaimEarliestAt: '2026-10-01T00:00:00.000Z',
      newRequestWouldResetPending: false,
      ifInitiatedAtCheckedBlockEarliestAt: null,
    } as never)
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: target.routeKey,
      destinationAddress: target.vault,
    })
    expect(result.stages).toMatchObject([
      { name: 'withdrawal', status: 'simulated', amountRaw: '1000000', relatedToRequest: true },
      { name: 'pending_claim', status: 'simulated', amountRaw: '2500000', relatedToRequest: false },
    ])
    expect(result.finalPayout?.status).toBe('unassessed')
    expect(result.cooldownCondition).toMatchObject({
      exitMode: 'direct_withdrawal',
      durationSeconds: 0,
      initiationStatus: 'not_applicable',
      directWithdrawalStatus: 'success',
      newRequestWouldResetPending: false,
    })
  })

  it('fails closed on absent sUSDe owner code, a mismatched silo, or malformed shared cash', async () => {
    const target = resolveSusdeCooldownExitTarget(
      'USDe → Staked USDe [USDe]',
      '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    )
    const input = { ...base, routeKey: target.routeKey, destinationAddress: target.vault }
    apyRequest.mockResolvedValueOnce(undefined)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_eoa_unverified',
    )
    vi.mocked(readSusdeCooldownExitQuote).mockResolvedValueOnce({
      source: { chainId: 1, blockHash: HASH },
      routeKey: target.routeKey,
      vault: { address: target.vault, assetAddress: target.asset, siloAddress: OWNER },
      request: { assetsRaw: '1000000' },
    } as never)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_susde_result_mismatch',
    )
    vi.mocked(readSusdeCooldownExitQuote).mockResolvedValueOnce({
      source: { chainId: 1, blockHash: HASH },
      routeKey: target.routeKey,
      vault: {
        address: target.vault,
        assetAddress: target.asset,
        siloAddress: target.silo,
      },
      request: { assetsRaw: '1000000' },
      aggregateSiloUsde: { balanceRaw: '-1' },
    } as never)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_susde_result_mismatch',
    )
  })

  it('requires a separate share probe and never interprets AUSD Q as sUSDat shares', () => {
    const input = {
      ...base,
      routeKey: STAKED_USDAT_ROUTE,
      destinationAddress: STAKED_USDAT_VAULT,
    }
    expect(() => validateHolderExitAssessmentRequest(input)).toThrow('holder_exit_request_invalid')
    expect(() =>
      validateHolderExitAssessmentRequest({ ...input, sharesRaw: input.assetsRaw }),
    ).not.toThrow()
    expect(() =>
      validateHolderExitAssessmentRequest({ ...base, sharesRaw: '10000000000000000000' }),
    ).toThrow('holder_exit_request_invalid')
  })

  it('keeps the exact sUSDat share ticket and older USDat claim separate from AUSD Q', async () => {
    const input = {
      ...base,
      routeKey: STAKED_USDAT_ROUTE,
      destinationAddress: STAKED_USDAT_VAULT,
      sharesRaw: '10000000000000000000',
      requestTokenId: '1669',
      horizonHours: 720,
    }
    const result = await readHolderExitAssessment(clients, input)
    expect(readStakedUsdatExit).toHaveBeenCalledWith(clients.apy, {
      routeKey: STAKED_USDAT_ROUTE,
      destinationAddress: STAKED_USDAT_VAULT,
      holder: OWNER,
      sharesRaw: input.sharesRaw,
      requestTokenId: '1669',
    })
    expect(apyRequest).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: HASH, requireCanonical: true }],
    })
    expect(result.status).toBe('partial')
    expect(result.request).toEqual({
      assetsRaw: '1000000',
      assetAddress: AUSD_ASSET,
      horizonHours: 720,
      sharesRaw: input.sharesRaw,
      requestTokenId: '1669',
    })
    expect(result.stages).toEqual([
      {
        name: 'queue_request',
        assetAddress: null,
        status: 'simulated',
        amountRaw: null,
        relatedToRequest: false,
      },
      {
        name: 'existing_ticket_claim',
        assetAddress: USDAT_ASSET,
        status: 'simulated',
        amountRaw: '10200000',
        relatedToRequest: false,
      },
    ])
    expect(result.finalPayout).toEqual({
      assetAddress: AUSD_ASSET,
      status: 'unassessed',
      amountRaw: null,
    })
    expect(readSaturnTicketConversionQuote).toHaveBeenCalledWith(clients.apy, HASH, '10200000')
    expect(result.stakedUsdatCondition).toEqual({
      requestedSharesRaw: input.sharesRaw,
      previewUsdatRaw: '10334658',
      queueRequestStatus: 'success',
      simulatedQueueTicketId: '1670',
      existingTicketId: '1669',
      existingTicketOwnership: 'holder',
      existingTicketClaimStatus: 'success',
      existingTicketRequestedAtUnix: '1790809200',
      existingTicketConversionQuote: {
        status: 'conditional_quote',
        usdatInputRaw: '10200000',
        usdcQuotedRaw: '10190000',
        ausdQuotedRaw: '10180000000000000000',
        curveCashUsdcRaw: '1000000000000',
        curveCashUsdatRaw: '1000000000000',
        uniswapActiveLiquidityRaw: '1000000000000',
        initializedTicksCrossed: 1,
        execution: 'unassessed',
      },
      existingTicketConversionBasis: 'claim_return',
      existingTicketConversionFeeStatus: 'included_in_claim_return',
      existingTicketRequestedLimit: null,
    })
    expect(result.forecast).toMatchObject({ futureExit: null, exitDurationHours: null })
  })

  it.each(['42103198', '0'])(
    'retains recorded owed=%s despiteclaimrevert andquotesonlypositivewholeamount',
    async (owed) => {
      const observed = await readStakedUsdatExit(clients.apy, {} as never)
      observed.evidence.underlyingDecimals = 6
      observed.evidence.shareDecimals = 18
      observed.current!.existingTicket!.claimSimulation = 'evm_revert'
      observed.current!.existingTicket!.simulatedUsdatRaw = null
      observed.current!.existingTicket!.recordedRequest = {
        sharesRaw18: '10000000000000000000',
        usdatOwedRaw6: owed,
        requestedAtUnix: '1790809200',
        minSharePriceRaw: '1040000',
        rawStatus: 3,
      }
      vi.mocked(readStakedUsdatExit).mockResolvedValueOnce(observed)
      if (owed !== '0')
        vi.mocked(readSaturnTicketConversionQuote).mockResolvedValueOnce({
          status: 'conditional_quote',
          usdatInputRaw: owed,
          usdcQuotedRaw: '42000000',
          ausdQuotedRaw: '41999999',
          curveCashUsdcRaw: '1000000000000',
          curveCashUsdatRaw: '1000000000000',
          uniswapActiveLiquidityRaw: '1000000000000',
          initializedTicksCrossed: 1,
          execution: 'unassessed',
        })
      const result = await readHolderExitAssessment(clients, {
        ...base,
        routeKey: STAKED_USDAT_ROUTE,
        destinationAddress: STAKED_USDAT_VAULT,
        sharesRaw: '10000000000000000000',
        requestTokenId: '1669',
        horizonHours: 720,
      })
      expect(result.stakedUsdatCondition?.existingTicketRecordedRequest?.usdatOwedRaw6).toBe(owed)
      if (owed === '0') expect(readSaturnTicketConversionQuote).not.toHaveBeenCalled()
      else {
        expect(readSaturnTicketConversionQuote).toHaveBeenCalledWith(clients.apy, HASH, owed)
        expect(result.stakedUsdatCondition?.existingTicketConversionBasis).toBe(
          'recorded_owed_if_delivered',
        )
        expect(result.stakedUsdatCondition?.existingTicketConversionFeeStatus).toBe('unknown')
      }
      expect(result.stages.find((s) => s.name === 'existing_ticket_claim')?.status).toBe('reverted')
      expect(result.finalPayout).toEqual({
        assetAddress: AUSD_ASSET,
        status: 'unassessed',
        amountRaw: null,
      })
    },
  )
  it.each(['malformed', 'foreign_units'])(
    'dropsinvalidoptionalrecordedchannel %s preservingoriginalrequest',
    async (reason) => {
      const observed = await readStakedUsdatExit(clients.apy, {} as never)
      observed.evidence.underlyingDecimals = reason === 'foreign_units' ? 18 : 6
      observed.evidence.shareDecimals = 18
      observed.current!.existingTicket!.claimSimulation = 'evm_revert'
      observed.current!.existingTicket!.simulatedUsdatRaw = null
      observed.current!.existingTicket!.recordedRequest = {
        sharesRaw18: '10000000000000000000',
        usdatOwedRaw6: reason === 'malformed' ? (['1'] as never) : '42103198',
        requestedAtUnix: '1790809200',
        minSharePriceRaw: '1040000',
        rawStatus: 3,
      }
      vi.mocked(readStakedUsdatExit).mockResolvedValueOnce(observed)
      const result = await readHolderExitAssessment(clients, {
        ...base,
        routeKey: STAKED_USDAT_ROUTE,
        destinationAddress: STAKED_USDAT_VAULT,
        sharesRaw: '10000000000000000000',
        requestTokenId: '1669',
        horizonHours: 720,
      })
      expect(result.stakedUsdatCondition?.existingTicketRecordedRequest).toBeNull()
      expect(result.stakedUsdatCondition?.queueRequestStatus).toBe('success')
      expect(readSaturnTicketConversionQuote).not.toHaveBeenCalled()
    },
  )

  it('drops wrongsizedoptionalquote without promotingorlosingverifiedclaim', async () => {
    vi.mocked(readSaturnTicketConversionQuote).mockResolvedValueOnce({
      status: 'conditional_quote',
      usdatInputRaw: '1',
      usdcQuotedRaw: '1',
      ausdQuotedRaw: '1',
      curveCashUsdcRaw: '1',
      curveCashUsdatRaw: '1',
      uniswapActiveLiquidityRaw: '1',
      initializedTicksCrossed: 0,
      execution: 'unassessed',
    })
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: STAKED_USDAT_ROUTE,
      destinationAddress: STAKED_USDAT_VAULT,
      sharesRaw: '10000000000000000000',
      requestTokenId: '1669',
      horizonHours: 720,
    })
    expect(result.stakedUsdatCondition?.existingTicketConversionQuote).toBeNull()
    expect(result.stakedUsdatCondition?.existingTicketClaimStatus).toBe('success')
    expect(result.finalPayout.status).toBe('unassessed')
  })

  it('retains the owned ticket assay when the optional public conversion quote fails', async () => {
    vi.mocked(readSaturnTicketConversionQuote).mockRejectedValueOnce(
      new Error('quoter_unavailable'),
    )
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: STAKED_USDAT_ROUTE,
      destinationAddress: STAKED_USDAT_VAULT,
      sharesRaw: '10000000000000000000',
      requestTokenId: '1669',
      horizonHours: 720,
    })
    expect(result.status).toBe('partial')
    expect(result.stages.find((stage) => stage.name === 'existing_ticket_claim')).toMatchObject({
      status: 'simulated',
      amountRaw: '10200000',
    })
    expect(result.stakedUsdatCondition?.existingTicketConversionQuote).toBeNull()
    expect(result.finalPayout.status).toBe('unassessed')
  })

  it('carries an owned ticket limit-update simulation without promoting final AUSD payout', async () => {
    vi.mocked(readStakedUsdatExit).mockResolvedValueOnce({
      status: 'observed',
      evidence: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTimestamp: 1790812800,
        vault: STAKED_USDAT_VAULT,
        queue: STAKED_USDAT_QUEUE,
        underlying: USDAT_ASSET,
      },
      current: {
        requestedSharesRaw: '10000000000000000000',
        previewUsdatRaw: '10334658',
        request: { status: 'evm_revert' },
        existingTicket: {
          tokenId: '1669',
          ownership: 'holder',
          claimSimulation: 'evm_revert',
          simulatedUsdatRaw: null,
          requestedLimit: {
            sharesRaw: '10000000000000000000',
            minSharePriceRaw: '1040000',
            currentQuoteUsdatRaw: '10334658',
            currentNetSharePriceRaw: '1033465',
            comparison: 'above_current_quote',
            limitUpdateSimulation: 'success',
          },
        },
      },
    } as never)
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: STAKED_USDAT_ROUTE,
      destinationAddress: STAKED_USDAT_VAULT,
      sharesRaw: '10000000000000000000',
      requestTokenId: '1669',
      horizonHours: 720,
    })
    expect(result.stakedUsdatCondition?.existingTicketRequestedLimit).toMatchObject({
      comparison: 'above_current_quote',
      limitUpdateSimulation: 'success',
    })
    expect(result.stakedUsdatCondition?.existingTicketConversionQuote).toBeNull()
    expect(result.finalPayout).toEqual({
      assetAddress: AUSD_ASSET,
      status: 'unassessed',
      amountRaw: null,
    })
  })

  it('fails closed on missing sUSDat EOA proof or mismatched share/ticket identity', async () => {
    const input = {
      ...base,
      routeKey: STAKED_USDAT_ROUTE,
      destinationAddress: STAKED_USDAT_VAULT,
      sharesRaw: '10000000000000000000',
      requestTokenId: '1669',
    }
    apyRequest.mockResolvedValueOnce('0x6001')
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_eoa_unverified',
    )
    vi.mocked(readStakedUsdatExit).mockResolvedValueOnce({
      status: 'observed',
      evidence: {
        chainId: 1,
        blockHash: HASH,
        vault: STAKED_USDAT_VAULT,
        queue: STAKED_USDAT_QUEUE,
        underlying: USDAT_ASSET,
      },
      current: { requestedSharesRaw: '1000000', existingTicket: { tokenId: '1669' } },
    } as never)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_staked_usdat_result_mismatch',
    )
  })

  it('requires independent Twyne collateral vault and PT inputs', () => {
    const input = { ...base, routeKey: TWYNE_PT_ROUTE, destinationAddress: TWYNE_PT_WRAPPER }
    expect(() => validateHolderExitAssessmentRequest(input)).toThrow('holder_exit_request_invalid')
    expect(() => validateHolderExitAssessmentRequest({ ...input, ptRaw: '1' })).toThrow(
      'holder_exit_request_invalid',
    )
    expect(() =>
      validateHolderExitAssessmentRequest({ ...input, collateralVault: TWYNE_CV }),
    ).toThrow('holder_exit_request_invalid')
    expect(() =>
      validateHolderExitAssessmentRequest({ ...base, collateralVault: TWYNE_CV, ptRaw: '1' }),
    ).toThrow('holder_exit_request_invalid')
  })

  it('reports only the borrower-authorized PT first leg, never USDe Q payout', async () => {
    const input = {
      ...base,
      routeKey: TWYNE_PT_ROUTE,
      destinationAddress: TWYNE_PT_WRAPPER,
      collateralVault: TWYNE_CV,
      ptRaw: '1000000000000000000',
      horizonHours: 720,
    }
    const result = await readHolderExitAssessment(clients, input)
    expect(readTwyneBorrowerExit).toHaveBeenCalledWith(
      clients.apy,
      { routeKey: TWYNE_PT_ROUTE, collateralVault: TWYNE_CV, requestedPtRaw: input.ptRaw },
      TWYNE_PT_BORROWER_DEPLOYMENT,
    )
    expect(apyRequest).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: HASH, requireCanonical: true }],
    })
    expect(result.status).toBe('partial')
    expect(result.request).toEqual({
      assetsRaw: '1000000',
      assetAddress: USDE_ASSET,
      horizonHours: 720,
      collateralVault: TWYNE_CV,
      ptRaw: input.ptRaw,
    })
    expect(result.stages).toEqual([
      {
        name: 'pt_redemption',
        assetAddress: TWYNE_PT_ASSET,
        status: 'simulated',
        amountRaw: input.ptRaw,
        relatedToRequest: false,
      },
    ])
    expect(result.finalPayout).toEqual({
      assetAddress: USDE_ASSET,
      status: 'unassessed',
      amountRaw: null,
    })
    expect(result.twyneCondition).toEqual({
      collateralVault: TWYNE_CV,
      requestedPtRaw: input.ptRaw,
      status: 'observed',
      reason: null,
      simulatedReturnedPtRaw: input.ptRaw,
    })
    expect(result.forecast).toMatchObject({ futureExit: null, exitDurationHours: null })
  })

  it('fails closed when Twyne borrower identity, EOA proof, or CV result does not bind', async () => {
    const input = {
      ...base,
      routeKey: TWYNE_PT_ROUTE,
      destinationAddress: TWYNE_PT_WRAPPER,
      collateralVault: TWYNE_CV,
      ptRaw: '1000000000000000000',
    }
    vi.mocked(readTwyneBorrowerExit).mockResolvedValueOnce({
      status: 'observed',
      routeKey: TWYNE_PT_ROUTE,
      collateralVault: TWYNE_CV,
      borrower: TWYNE_CV,
      requestedPtRaw: input.ptRaw,
      evidence: {
        chainId: 1,
        blockHash: HASH,
        receiver: 'borrower',
        asset: TWYNE_PT_WRAPPER,
        targetAsset: USDE_ASSET,
        targetVault: TWYNE_AAVE_POOL,
        returnedPtRaw: input.ptRaw,
      },
    } as never)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_twyne_borrower_unverified',
    )
    apyRequest.mockResolvedValueOnce('0x6001')
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_eoa_unverified',
    )
    vi.mocked(readTwyneBorrowerExit).mockResolvedValueOnce({
      status: 'observed',
      routeKey: TWYNE_PT_ROUTE,
      collateralVault: OWNER,
      borrower: OWNER,
      requestedPtRaw: input.ptRaw,
      evidence: { chainId: 1, blockHash: HASH, receiver: 'borrower' },
    } as never)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_twyne_result_mismatch',
    )
  })

  it('keeps a credit-reserved Twyne first leg unassessed', async () => {
    const input = {
      ...base,
      routeKey: TWYNE_PT_ROUTE,
      destinationAddress: TWYNE_PT_WRAPPER,
      collateralVault: TWYNE_CV,
      ptRaw: '1000000000000000000',
    }
    vi.mocked(readTwyneBorrowerExit).mockResolvedValueOnce({
      status: 'restricted',
      reason: 'credit_reserved',
      routeKey: TWYNE_PT_ROUTE,
      collateralVault: TWYNE_CV,
      borrower: OWNER,
      requestedPtRaw: input.ptRaw,
      evidence: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTimestamp: 1790812800,
        receiver: 'borrower',
        returnedPtRaw: null,
      },
    } as never)
    const result = await readHolderExitAssessment(clients, input)
    expect(result.status).toBe('partial')
    expect(result.stages[0].status).toBe('unassessed')
    expect(result.twyneCondition).toMatchObject({
      status: 'restricted',
      reason: 'credit_reserved',
      simulatedReturnedPtRaw: null,
    })
    expect(result.finalPayout.status).toBe('unassessed')
  })

  it('returns typed unsupported Twyne evidence before borrower() exists', async () => {
    const input = {
      ...base,
      routeKey: TWYNE_PT_ROUTE,
      destinationAddress: TWYNE_PT_WRAPPER,
      collateralVault: TWYNE_CV,
      ptRaw: '1000000000000000000',
    }
    vi.mocked(readTwyneBorrowerExit).mockResolvedValueOnce({
      status: 'unsupported',
      reason: 'deployment_unattested',
      routeKey: TWYNE_PT_ROUTE,
      collateralVault: TWYNE_CV,
      borrower: null,
      requestedPtRaw: input.ptRaw,
      evidence: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTimestamp: 1790812800,
        receiver: 'borrower',
        returnedPtRaw: null,
      },
    } as never)
    const result = await readHolderExitAssessment(clients, input)
    expect(result.status).toBe('unsupported')
    expect(result.stages).toEqual([])
    expect(result.twyneCondition).toMatchObject({
      status: 'unsupported',
      reason: 'deployment_unattested',
    })
    expect(result.finalPayout.status).toBe('unassessed')
    expect(apyRequest).not.toHaveBeenCalled()
  })

  it('reads an old holder wYLDS queue without treating it as the new PRIME or PYUSD Q', async () => {
    const input = {
      ...base,
      routeKey: PYUSD_STAKING_ROUTE,
      destinationAddress: HASTRA_STAKING_VAULT,
      assetsRaw: '7500000',
      horizonHours: 720,
    }
    const result = await readHolderExitAssessment(clients, input)
    expect(readPyusdStakingRouteIdentity).toHaveBeenCalledWith(clients.apy)
    expect(result.status).toBe('partial')
    expect(result.request).toEqual({
      assetsRaw: '7500000',
      assetAddress: PYUSD_TOKEN,
      horizonHours: 720,
    })
    expect(result.source).toMatchObject({ blockHash: HASH, originValidation: 'single_provider' })
    expect(result.stages).toEqual([])
    expect(readPyusdStakingYieldQueue).toHaveBeenCalledWith(clients.apy, input.owner, HASH)
    expect(result.pyusdYieldQueueCondition).toMatchObject({
      existingWyldsSharesRaw: '2000000',
      pendingSharesRaw: '1000000',
      pendingUsdcRaw: '990000',
      requestAssessed: false,
      completion: 'admin_gated_unassessed',
      usdcPayout: 'not_attested',
    })
    expect(result.finalPayout).toEqual({
      assetAddress: PYUSD_TOKEN,
      status: 'unassessed',
      amountRaw: null,
    })
    expect(result.forecast).toMatchObject({ futureExit: null, exitDurationHours: null })
    expect(apyRequest).not.toHaveBeenCalled()
    expect(readPyusdStakingFirstLeg).not.toHaveBeenCalled()
  })

  it('assesses independent PRIME shares but leaves PYUSD payout and duration unassessed', async () => {
    const input = {
      ...base,
      routeKey: PYUSD_STAKING_ROUTE,
      destinationAddress: HASTRA_STAKING_VAULT,
      assetsRaw: '7500000',
      primeSharesRaw: '1000000',
    }
    const result = await readHolderExitAssessment(clients, input)
    expect(readPyusdStakingFirstLeg).toHaveBeenCalledWith(clients.apy, input.owner, '1000000', HASH)
    expect(readPyusdStakingYieldQueue).toHaveBeenCalledWith(clients.apy, input.owner, HASH)
    expect(result.status).toBe('partial')
    expect(result.request).toMatchObject({ assetsRaw: '7500000', primeSharesRaw: '1000000' })
    expect(result.stages).toEqual([
      {
        name: 'prime_redemption',
        assetAddress: HASTRA_STAKING_VAULT,
        status: 'simulated',
        amountRaw: '1000000',
        relatedToRequest: false,
      },
    ])
    expect(result.pyusdStakingCondition?.simulatedWyldsRaw).toBe('1050000')
    expect(result.pyusdYieldQueueCondition?.pendingSharesRaw).toBe('1000000')
    expect(result.finalPayout).toEqual({
      assetAddress: PYUSD_TOKEN,
      status: 'unassessed',
      amountRaw: null,
    })
    expect(result.forecast).toMatchObject({ futureExit: null, exitDurationHours: null })
  })

  it('keeps an exact PRIME first leg when the supplemental wYLDS queue read fails', async () => {
    vi.mocked(readPyusdStakingYieldQueue).mockRejectedValueOnce(new Error('queue_rpc_unavailable'))
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: PYUSD_STAKING_ROUTE,
      destinationAddress: HASTRA_STAKING_VAULT,
      assetsRaw: '7500000',
      primeSharesRaw: '1000000',
    })
    expect(result.status).toBe('partial')
    expect(result.pyusdStakingCondition?.simulatedWyldsRaw).toBe('1050000')
    expect(result.pyusdYieldQueueCondition).toBeUndefined()
    expect(result.finalPayout.status).toBe('unassessed')
  })

  it('does not promote an empty old wYLDS queue to a partial exit', async () => {
    vi.mocked(readPyusdStakingYieldQueue).mockResolvedValueOnce({
      holder: OWNER,
      existingWyldsSharesRaw: '0',
      pendingSharesRaw: '0',
      pendingUsdcRaw: '0',
      pendingSinceUnix: '0',
      yieldPaused: false,
      yieldFrozen: false,
      redeemVault: OWNER,
      requestAssessed: false,
      completion: 'admin_gated_unassessed',
      usdcPayout: 'not_attested',
    })
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: PYUSD_STAKING_ROUTE,
      destinationAddress: HASTRA_STAKING_VAULT,
      assetsRaw: '7500000',
    })
    expect(result.status).toBe('unsupported')
    expect(result.pyusdYieldQueueCondition).toBeUndefined()
    expect(result.unsupportedReason).toBe('pyusd_leg_not_verified')
  })

  it('fails closed on mismatched PYUSD identity and preserves deployment failure reason', async () => {
    const input = {
      ...base,
      routeKey: PYUSD_STAKING_ROUTE,
      destinationAddress: HASTRA_STAKING_VAULT,
    }
    vi.mocked(readPyusdStakingRouteIdentity).mockResolvedValueOnce({
      status: 'route_asset_mismatch',
      reason: 'pyusd_leg_not_verified',
      routeKey: PYUSD_STAKING_ROUTE,
      destination: HASTRA_STAKING_VAULT,
      evidence: { chainId: 1, stakingAsset: PYUSD_TOKEN, yieldAsset: USDC_TOKEN },
      assetLinks: 'staking_asset_wYLDS_yield_asset_USDC',
      pyusdPayout: 'not_attested',
      holderAmountCheck: 'not_performed_route_incomplete',
    } as never)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_pyusd_identity_mismatch',
    )
    vi.mocked(readPyusdStakingRouteIdentity).mockResolvedValueOnce({
      status: 'unsupported',
      reason: 'deployment_unattested',
      routeKey: PYUSD_STAKING_ROUTE,
      destination: HASTRA_STAKING_VAULT,
      evidence: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTimestamp: 1790812800,
      },
      assetLinks: null,
      pyusdPayout: 'not_attested',
      holderAmountCheck: 'not_performed_route_incomplete',
    } as never)
    const unsupported = await readHolderExitAssessment(clients, input)
    expect(unsupported.unsupportedReason).toBe('deployment_unattested')
    expect(unsupported.stages).toEqual([])
  })

  it.each([
    [SGHO_ROUTE_KEY, GHO_SGHO.destination, GHO_SGHO.borrowAsset, readSghoExit],
    [SUSDS_ROUTE_KEY, SUSDS_VAULT, USDS_ASSET, readSusdsExitQuote],
    [USD3_ROUTE_KEY, USD3_VAULT, USDC, readUsd3ExitQuote],
  ])(
    'normalizes %s same-holder current withdrawal without a future claim',
    async (routeKey, destinationAddress, assetAddress, reader) => {
      const result = await readHolderExitAssessment(clients, {
        ...base,
        routeKey,
        destinationAddress,
        horizonHours: 720,
      })
      expect(reader).toHaveBeenCalledTimes(1)
      expect(apyRequest).toHaveBeenCalledWith({
        method: 'eth_getCode',
        params: [OWNER, { blockHash: HASH, requireCanonical: true }],
      })
      expect(result.source).toMatchObject({
        blockNumber: 26090000,
        blockHash: HASH,
        originValidation: 'single_provider',
      })
      expect(result.request).toEqual({ assetsRaw: '1000000', assetAddress, horizonHours: 720 })
      expect(result.stages[0]).toMatchObject({
        name: 'withdrawal',
        status: 'simulated',
        relatedToRequest: true,
      })
      expect(result.finalPayout).toEqual({
        assetAddress,
        status: 'simulated',
        amountRaw: '1000000',
      })
      expect(result.forecast).toEqual({
        status: 'unvalidated',
        futureExit: null,
        exitDurationHours: null,
        prospectiveValidated: false,
      })
    },
  )

  it('retains native USD3 full shares independently of requested assets only with capacity facts', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T00:00:10.000Z'))
    try {
      const native = {
        owner: OWNER,
        method: 'availableWithdrawLimit(address)',
        asset: USDC,
        assetDecimals: 6,
        unit: 'raw_usdc_6',
        capacityRaw: '1960000000000',
        resultStatus: 'quoted',
        source: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTime: '2026-10-01T00:00:00.000Z',
          finalized: true,
        },
        runtimeProfile: null,
      }
      const readerResult = {
        source: {
          chainId: 1,
          blockNumber: 26090000,
          blockHash: HASH,
          blockTime: '2026-10-01T00:00:00.000Z',
        },
        routeKey: USD3_ROUTE_KEY,
        vault: { address: USD3_VAULT, assetAddress: USDC, assetDecimals: 6, shareDecimals: 6 },
        position: {
          balanceSharesRaw: '9876543210',
          entitlementAssetsRaw: '10000000',
          maxWithdrawAssetsRaw: '9000000',
          previewSharesRaw: '990000',
        },
        usd3NativeCapacity: native,
        request: { assetsRaw: '1000000' },
        simulation: { status: 'evm_revert' },
      }
      vi.mocked(readUsd3ExitQuote).mockResolvedValue(readerResult as never)
      const input = { ...base, routeKey: USD3_ROUTE_KEY, destinationAddress: USD3_VAULT }
      const result = await readHolderExitAssessment(clients, input, { includeCapacityFacts: true })
      expect(readUsd3ExitQuote).toHaveBeenCalledWith(
        clients.apy,
        {
          routeKey: input.routeKey,
          destinationAddress: USD3_VAULT,
          owner: OWNER,
          assetsRaw: '1000000',
        },
        expect.any(Function),
        undefined,
        { includeCapacityFacts: true },
      )
      expect(result.capacityQuote).toMatchObject({
        usd3NativeCapacity: native,
        sourceHolderPosition: {
          sharesRaw: '9876543210',
          shareDecimals: 6,
          method: 'balance_of_owner_at_source',
        },
        entitlementRaw: '10000000',
        fullPositionEntitlementRaw: '10000000',
        fullPositionEntitlementMethod: 'preview_redeem_full_position',
        quotedMaxWithdrawRaw: '9000000',
      })
      expect(result.capacityQuote?.sourceHolderPosition?.sharesRaw).not.toBe(input.assetsRaw)
      expect(result.capacityQuote?.sourceHolderPosition?.sharesRaw).not.toBe('990000')
      expect(result.capacityQuote?.fullPositionEntitlementRaw).not.toBe(input.assetsRaw)
      expect(result.capacityQuote?.fullPositionEntitlementRaw).not.toBe('990000')
      expect(result.capacityQuote?.usd3NativeCapacity?.capacityRaw).not.toBe(
        result.capacityQuote?.entitlementRaw,
      )
      expect(result.capacityQuote?.usd3NativeCapacity?.capacityRaw).not.toBe(
        result.capacityQuote?.quotedMaxWithdrawRaw,
      )
      expect(result.stages[0].status).toBe('reverted')
      expect(result.finalPayout).toMatchObject({ status: 'unassessed', amountRaw: null })
      expect(result.forecast).toMatchObject({ futureExit: null, prospectiveValidated: false })
      const ordinary = await readHolderExitAssessment(clients, input)
      expect(ordinary.capacityQuote?.sourceHolderPosition).toBeUndefined()
      expect(ordinary.capacityQuote?.usd3NativeCapacity).toBeUndefined()
      expect(ordinary.capacityQuote?.fullPositionEntitlementRaw).toBeUndefined()
      expect(ordinary.capacityQuote?.fullPositionEntitlementMethod).toBeUndefined()
      vi.mocked(readUsd3ExitQuote).mockResolvedValueOnce({
        ...readerResult,
        request: { assetsRaw: '2000000' },
      } as never)
      const changedQ = await readHolderExitAssessment(
        clients,
        { ...input, assetsRaw: '2000000' },
        { includeCapacityFacts: true },
      )
      expect(changedQ.capacityQuote?.requestedRaw).toBe('2000000')
      expect(changedQ.capacityQuote?.fullPositionEntitlementRaw).toBe(
        result.capacityQuote?.fullPositionEntitlementRaw,
      )
      expect(changedQ.capacityQuote?.sourceHolderPosition).toEqual(
        result.capacityQuote?.sourceHolderPosition,
      )
      vi.mocked(readUsd3ExitQuote).mockResolvedValueOnce({
        ...readerResult,
        position: { ...readerResult.position, entitlementAssetsRaw: null },
      } as never)
      const unavailable = await readHolderExitAssessment(clients, input, {
        includeCapacityFacts: true,
      })
      expect(unavailable.capacityQuote?.fullPositionEntitlementRaw).toBeNull()
      expect(unavailable.capacityQuote?.fullPositionEntitlementMethod).toBe('unavailable')
    } finally {
      clock.mockRestore()
    }
  })
  it.each(['0', '01', '-1', '1.0', (1n << 256n).toString()])(
    'retains zero native USD3 shares and omits malformed/overflow shares %s',
    async (sharesRaw) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T00:00:10.000Z'))
      try {
        vi.mocked(readUsd3ExitQuote).mockResolvedValueOnce({
          source: {
            chainId: 1,
            blockNumber: 26090000,
            blockHash: HASH,
            blockTime: '2026-10-01T00:00:00.000Z',
          },
          routeKey: USD3_ROUTE_KEY,
          vault: { address: USD3_VAULT, assetAddress: USDC, assetDecimals: 6, shareDecimals: 6 },
          position: {
            balanceSharesRaw: sharesRaw,
            entitlementAssetsRaw: '0',
            maxWithdrawAssetsRaw: '0',
            previewSharesRaw: '990000',
          },
          request: { assetsRaw: '1000000' },
          simulation: { status: 'position_insufficient' },
        } as never)
        const result = await readHolderExitAssessment(
          clients,
          { ...base, routeKey: USD3_ROUTE_KEY, destinationAddress: USD3_VAULT },
          { includeCapacityFacts: true },
        )
        expect(result.capacityQuote).toMatchObject({
          entitlementRaw: '0',
          quotedMaxWithdrawRaw: '0',
        })
        if (sharesRaw === '0')
          expect(result.capacityQuote?.sourceHolderPosition).toEqual({
            sharesRaw: '0',
            shareDecimals: 6,
            method: 'balance_of_owner_at_source',
          })
        else expect(result.capacityQuote?.sourceHolderPosition).toBeUndefined()
        expect(result.finalPayout).toMatchObject({ status: 'unassessed', amountRaw: null })
        expect(result.stages[0].status).toBe('unassessed')
        expect(result.forecast).toMatchObject({ futureExit: null, prospectiveValidated: false })
      } finally {
        clock.mockRestore()
      }
    },
  )
  it('does not invent USD3 full shares when the native reader position is absent', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T00:00:10.000Z'))
    try {
      const result = await readHolderExitAssessment(
        clients,
        { ...base, routeKey: USD3_ROUTE_KEY, destinationAddress: USD3_VAULT },
        { includeCapacityFacts: true },
      )
      expect(result.capacityQuote).toBeUndefined()
      expect(result.finalPayout.status).toBe('simulated')
      expect(result.forecast).toMatchObject({ futureExit: null, prospectiveValidated: false })
    } finally {
      clock.mockRestore()
    }
  })
  it('forwards optional full-position sGHO capacity reads without changing execution', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T00:00:10.000Z'))
    vi.mocked(readSghoExit).mockResolvedValueOnce({
      source: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTime: '2026-10-01T00:00:00.000Z',
      },
      vault: {
        address: GHO_SGHO.destination,
        assetAddress: GHO_SGHO.borrowAsset,
        withdrawalsPaused: false,
      },
      position: {
        previewRedeemGhoRaw: '2000000',
        maxWithdrawGhoRaw: '2000000',
        effectiveExitGhoRaw: '2000000',
        fullPositionEntitlementGhoRaw: '10000000',
      },
      request: { assetsRaw: '1000000' },
      simulation: { status: 'success' },
    } as never)
    const input = { ...base, routeKey: SGHO_ROUTE_KEY, destinationAddress: GHO_SGHO.destination }
    const result = await readHolderExitAssessment(clients, input, { includeCapacityFacts: true })
    expect(readSghoExit).toHaveBeenCalledWith(
      clients.apy,
      OWNER,
      input.assetsRaw,
      expect.any(Function),
      undefined,
      { includeCapacityFacts: true },
    )
    expect(result.finalPayout.status).toBe('simulated')
    expect(result.capacityQuote).toMatchObject({
      entitlementRaw: '2000000',
      fullPositionEntitlementRaw: '10000000',
      fullPositionEntitlementMethod: 'preview_redeem_full_position',
    })
    clock.mockRestore()
  })

  it('fails closed when normalized sGHO/sUSDS/USD3 EOA proof is absent or contract code', async () => {
    const input = { ...base, routeKey: SGHO_ROUTE_KEY, destinationAddress: GHO_SGHO.destination }
    apyRequest.mockResolvedValueOnce(undefined)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_eoa_unverified',
    )
    apyRequest.mockResolvedValueOnce('0x6001')
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_eoa_unverified',
    )
  })

  it('rejects a mismatched USD3 payout asset instead of reporting a simulation', async () => {
    vi.mocked(readUsd3ExitQuote).mockResolvedValueOnce({
      source: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTime: '2026-10-01T00:00:00.000Z',
      },
      routeKey: USD3_ROUTE_KEY,
      vault: { address: USD3_VAULT, assetAddress: USDT },
      request: { assetsRaw: '1000000' },
      simulation: { status: 'success' },
    } as never)
    await expect(
      readHolderExitAssessment(clients, {
        ...base,
        routeKey: USD3_ROUTE_KEY,
        destinationAddress: USD3_VAULT,
      }),
    ).rejects.toThrow('holder_exit_result_mismatch')
  })

  it('fails closed on contract holder at ApyUSD finalized initiation block', async () => {
    apyRequest.mockResolvedValueOnce('0x6001')
    await expect(
      readHolderExitAssessment(clients, {
        ...base,
        routeKey: APYUSD_ROUTE,
        destinationAddress: APYUSD_VAULT,
      }),
    ).rejects.toThrow('holder_exit_eoa_unverified')
    expect(apyRequest).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: HASH, requireCanonical: true }],
    })
  })

  it('keeps a delegated ApyUSD holder in the simulated receipt path without claiming payout', async () => {
    apyRequest.mockResolvedValueOnce(`0xef0100${'1'.repeat(40)}`)
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: APYUSD_ROUTE,
      destinationAddress: APYUSD_VAULT,
    })
    expect(result.stages[0]).toMatchObject({ name: 'receipt_initiation', status: 'simulated' })
    expect(result.finalPayout.status).toBe('unassessed')
    expect(result.finalPayout.amountRaw).toBeNull()
  })

  it('resolves all 49 frozen Morpho VaultV2 subjects with their exact route and asset', () => {
    expect(morphoIdentities.entries).toHaveLength(49)
    const registry = buildCarryForecastRegistry(
      ROUTES,
      seed,
      recorderConfig.venues,
      GHO_SGHO.destination,
      verifiedDirectSupplyDestinations(),
    )
    for (const identity of morphoIdentities.entries) {
      const group = registry.routeGroups.find((row) =>
        row.contractSubjects.some(
          (subject) =>
            subject.destinationAddress === identity.vault &&
            subject.identitySource.kind === 'august_observed',
        ),
      )
      expect(group, identity.vault).toBeDefined()
      expect(
        validateHolderExitAssessmentRequest({
          ...base,
          routeKey: group!.routeKey,
          destinationAddress: identity.vault as `0x${string}`,
        }),
      ).toEqual({ kind: 'morpho', payoutAsset: identity.asset })
    }
  })

  it('pins raw EOA proof to the same block as the Morpho quote and does not claim a mined payout', async () => {
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: MORPHO_ROUTE,
      destinationAddress: MORPHO.vault,
    })
    expect(vi.mocked(readMorphoExitQuote).mock.calls[0][1]).toMatchObject({
      owner: OWNER,
      assetsRaw: '1000000',
      routeKey: MORPHO_ROUTE,
      destinationAddress: MORPHO.vault,
    })
    expect(morphoRequest).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [OWNER, { blockHash: HASH, requireCanonical: true }],
    })
    expect(result.source).toMatchObject({
      blockNumber: 26090000,
      blockHash: HASH,
      originValidation: 'single_provider',
    })
    expect(result.request.assetAddress).toBe(MORPHO.asset)
    expect(result.finalPayout).toEqual({
      assetAddress: MORPHO.asset,
      status: 'simulated',
      amountRaw: '1000000',
    })
    expect(result.forecast.prospectiveValidated).toBe(false)
  })

  it('rejects missing or contract code and inconsistent Morpho responses', async () => {
    const input = { ...base, routeKey: MORPHO_ROUTE, destinationAddress: MORPHO.vault }
    morphoRequest.mockResolvedValueOnce(undefined)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_morpho_eoa_unverified',
    )
    morphoRequest.mockResolvedValueOnce('0x6001')
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_morpho_eoa_unverified',
    )
    vi.mocked(readMorphoExitQuote).mockResolvedValueOnce({
      source: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTime: '2026-10-01T00:00:00.000Z',
      },
      routeKey: MORPHO_ROUTE,
      vault: { address: MORPHO.vault, assetAddress: USDT },
      request: { assetsRaw: '1000000' },
      simulation: { status: 'success' },
    } as never)
    await expect(readHolderExitAssessment(clients, input)).rejects.toThrow(
      'holder_exit_morpho_result_mismatch',
    )
  })

  it('keeps a Morpho EVM revert distinct from a simulated final payout', async () => {
    vi.mocked(readMorphoExitQuote).mockResolvedValueOnce({
      source: {
        chainId: 1,
        blockNumber: 26090000,
        blockHash: HASH,
        blockTime: '2026-10-01T00:00:00.000Z',
      },
      routeKey: MORPHO_ROUTE,
      vault: { address: MORPHO.vault, assetAddress: MORPHO.asset },
      request: { assetsRaw: '1000000' },
      simulation: { status: 'evm_revert' },
    } as never)
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: MORPHO_ROUTE,
      destinationAddress: MORPHO.vault,
    })
    expect(result.stages[0].status).toBe('reverted')
    expect(result.finalPayout).toEqual({
      assetAddress: MORPHO.asset,
      status: 'unassessed',
      amountRaw: null,
    })
  })

  it('reports direct same-holder simulation with exact pinned source, while future and duration stay unvalidated', async () => {
    const result = await readHolderExitAssessment(clients, base)
    expect(result.source).toMatchObject({ blockNumber: 26090000, blockHash: HASH })
    expect(result.request).toEqual({
      assetsRaw: '1000000',
      assetAddress: DIRECT.underlying,
      horizonHours: 24,
    })
    expect(result.stages[0]).toMatchObject({ name: 'withdrawal', status: 'simulated' })
    expect(result.finalPayout).toEqual({
      assetAddress: DIRECT.underlying,
      status: 'simulated',
      amountRaw: '1000000',
    })
    expect(result.forecast).toEqual({
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    })
    expect(vi.mocked(readDirectSupplyExitQuote).mock.calls[0][1]).toMatchObject({
      owner: OWNER,
      assetsRaw: '1000000',
    })
  })

  it('assesses the five exact tracked-direct vault exits without promoting future ability', async () => {
    const pairs = [
      ['USDS → StUsds [USDS]', '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'],
      ['USDC → Fluid USD Coin [USDC]', '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'],
      ['USDT → fToken [USDT]', '0x5c20b550819128074fd538edf79791733ccedd18'],
      ['GHO → fToken [GHO]', '0x6a29a46e21c730dca1d8b23d637c101cec605c5b'],
      ['USDC → FluidBridgeAggregatorProxy [USDC]', FLUID_BRIDGE_VAULT],
    ] as const
    for (const [routeKey, destinationAddress] of pairs) {
      const input = { ...base, routeKey, destinationAddress }
      const result = await readHolderExitAssessment(clients, input)
      const asset = resolveTrackedDirectVaultExitTarget(routeKey, destinationAddress).asset
      expect(result.request).toEqual({
        assetsRaw: '1000000',
        assetAddress: asset,
        horizonHours: 24,
      })
      expect(result.stages[0]).toMatchObject({
        name: 'withdrawal',
        status: 'simulated',
        relatedToRequest: true,
      })
      expect(result.finalPayout).toEqual({
        assetAddress: asset,
        status: 'simulated',
        amountRaw: '1000000',
      })
      expect(result.forecast.prospectiveValidated).toBe(false)
    }
    expect(readTrackedDirectVaultExit).toHaveBeenCalledTimes(5)
  })

  it('does not promote a newly initiated ApyUSD receipt, or an unrelated existing receipt claim, to Q payout', async () => {
    vi.mocked(readApyUsdExit).mockResolvedValueOnce({
      status: 'observed',
      evidence: { blockNumber: 26090000, blockHash: HASH, blockTimestamp: 1790812800 },
      current: {
        initiation: { status: 'success' },
        existingReceipt: {
          tokenId: '123',
          ownership: 'holder',
          claimSimulation: 'success',
          currentPreviewPayoutRaw: '12',
          simulatedClaimPayoutRaw: '13',
        },
        currentFeeCurve: apyFeeCurve,
        currentMinimumClaimDelaySeconds: 259200,
        ifInitiatedAtCheckedBlockClaimableAt: 1791072000,
        ifInitiatedAtCheckedBlockEarliestNetRaw: '966000000000000000',
        ifInitiatedAtCheckedBlockMinimumFeeAt: 1792540800,
        ifInitiatedAtCheckedBlockMinimumFeeNetRaw: '1000000000000000000',
      },
    } as never)
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: APYUSD_ROUTE,
      destinationAddress: APYUSD_VAULT,
      assetsRaw: '1000000000000000000',
      receiptTokenId: '123',
    })
    expect(result.stages.map((stage) => stage.status)).toEqual(['simulated', 'simulated'])
    expect(result.stages.map((stage) => stage.relatedToRequest)).toEqual([true, false])
    expect(result.stages[1].amountRaw).toBe('13')
    expect(result.request.receiptTokenId).toBe('123')
    expect(result.existingReceiptClaim).toEqual({
      tokenId: '123',
      assetAddress: APXUSD_ASSET,
      status: 'simulated',
      amountRaw: '13',
      delivery: 'not_observed',
    })
    expect(result.finalPayout.status).toBe('unassessed')
    expect(result.finalPayout.amountRaw).toBeNull()
    expect(vi.mocked(readApyUsdExit).mock.calls[0][1]).toMatchObject({
      holder: OWNER,
      receiptTokenId: '123',
    })
  })

  it('projects an ApyUSD net amount at the selected eligible horizon while leaving payout unassessed', async () => {
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: APYUSD_ROUTE,
      destinationAddress: APYUSD_VAULT,
      assetsRaw: '1000000000000000000',
      horizonHours: 168,
    })
    expect(result.apyUsdCondition).toMatchObject({
      ifInitiatedAtCheckedBlockEarliestNetRaw: '966000000000000000',
      ifInitiatedAtCheckedBlockHorizonNetRaw: '973999999999999999',
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: '1000000000000000000',
    })
    expect(result.finalPayout).toEqual({
      assetAddress: APXUSD_ASSET,
      status: 'unassessed',
      amountRaw: null,
    })
    expect(result.request.receiptTokenId).toBeUndefined()
    expect(result.existingReceiptClaim).toBeUndefined()
    expect(result.stages[1]).toMatchObject({ status: 'unassessed', amountRaw: null })
  })

  it.each([
    ['another owner', '123', 'other_owner', 'success', '13', 'unassessed'],
    ['a different receipt', '124', 'holder', 'success', '13', 'unassessed'],
    ['a reverted claim', '123', 'holder', 'evm_revert', null, 'reverted'],
    ['a zero simulated payout', '123', 'holder', 'success', '0', 'unassessed'],
  ] as const)(
    'does not expose an existing receipt claim for %s',
    async (_, tokenId, ownership, claimSimulation, simulatedClaimPayoutRaw, stageStatus) => {
      vi.mocked(readApyUsdExit).mockResolvedValueOnce({
        status: 'observed',
        evidence: { blockNumber: 26090000, blockHash: HASH, blockTimestamp: 1790812800 },
        current: {
          initiation: { status: 'success' },
          existingReceipt: {
            tokenId,
            ownership,
            claimSimulation,
            currentPreviewPayoutRaw: '13',
            simulatedClaimPayoutRaw,
          },
          currentFeeCurve: apyFeeCurve,
          currentMinimumClaimDelaySeconds: 259200,
          ifInitiatedAtCheckedBlockClaimableAt: 1791072000,
          ifInitiatedAtCheckedBlockEarliestNetRaw: '966000000000000000',
          ifInitiatedAtCheckedBlockMinimumFeeAt: 1792540800,
          ifInitiatedAtCheckedBlockMinimumFeeNetRaw: '1000000000000000000',
        },
      } as never)
      const result = await readHolderExitAssessment(clients, {
        ...base,
        routeKey: APYUSD_ROUTE,
        destinationAddress: APYUSD_VAULT,
        receiptTokenId: '123',
      })
      expect(result.existingReceiptClaim).toBeUndefined()
      expect(result.stages[1]).toMatchObject({ status: stageStatus, amountRaw: null })
      expect(result.finalPayout).toEqual({
        assetAddress: APXUSD_ASSET,
        status: 'unassessed',
        amountRaw: null,
      })
    },
  )

  it('keeps USDT Q distinct from USDC first-leg Q and never promotes USDC to final USDT', async () => {
    const result = await readHolderExitAssessment(clients, {
      ...base,
      routeKey: FLUID_USDT_ROUTE,
      destinationAddress: FLUID_BRIDGE_VAULT,
      assetsRaw: '900000',
      firstLegUsdcRaw: '1000000',
    })
    expect(result.request).toEqual({ assetsRaw: '900000', assetAddress: USDT, horizonHours: 24 })
    expect(result.stages).toMatchObject([
      {
        name: 'usdc_vault_withdrawal',
        assetAddress: USDC,
        status: 'simulated',
        amountRaw: '1000000',
        relatedToRequest: false,
      },
      { name: 'usdc_to_usdt_conversion', status: 'unassessed' },
      { name: 'usdt_delivery', status: 'unassessed' },
    ])
    expect(result.finalPayout).toEqual({
      assetAddress: USDT,
      status: 'unassessed',
      amountRaw: null,
    })
    expect(vi.mocked(readTrackedDirectVaultExit).mock.calls[0][1]).toMatchObject({
      routeKey: FLUID_USDT_ROUTE,
      assetsRaw: '1000000',
      assetUnit: 'USDC',
      owner: OWNER,
    })
  })

  it('fails closed on unsupported/mismatched subjects, malformed Q, missing first-leg units and provider failure', async () => {
    expect(() =>
      validateHolderExitAssessmentRequest({ ...base, destinationAddress: OWNER }),
    ).toThrow('holder_exit_subject_unsupported')
    expect(() => validateHolderExitAssessmentRequest({ ...base, assetsRaw: '0' })).toThrow(
      'holder_exit_request_invalid',
    )
    expect(() => validateHolderExitAssessmentRequest({ ...base, horizonHours: 0 })).toThrow(
      'holder_exit_request_invalid',
    )
    expect(() =>
      validateHolderExitAssessmentRequest({
        ...base,
        routeKey: FLUID_USDT_ROUTE,
        destinationAddress: FLUID_BRIDGE_VAULT,
      }),
    ).toThrow('holder_exit_request_invalid')
    expect(readDirectSupplyExitQuote).not.toHaveBeenCalled()
    vi.mocked(readDirectSupplyExitQuote).mockRejectedValueOnce(new Error('secret provider url'))
    await expect(readHolderExitAssessment(clients, base)).rejects.toThrow('secret provider url')
  })
})
