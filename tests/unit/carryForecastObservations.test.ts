import { describe, expect, it, vi } from 'vitest'

import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import {
  carryVaultBalanceDisclosure,
  checkedCarryRouteBatch,
  checkedLocalCarryObservation,
  checkedLocalHistoricalCarryObservation,
  default as handler,
  localDevelopmentRequest,
  sameDirectCashReading,
  selectDirectCashWitness,
} from '@/pages/api/carry/forecast-observations'
import { readLocalCarryCashObservations } from '@/scripts/lib/localCarryCashStore.mjs'
import { buildSubjectManifest } from '@/scripts/record-carry-cash-issues.mjs'
import recorderConfig from '@/tools/venue-recorder.config.json'

const vault = '0x' + '1'.repeat(40)
const asset = '0x' + '2'.repeat(40)
const hash = '0x' + 'a'.repeat(64)
const expected = {
  seedSha256: 'b'.repeat(64),
  boardSha256: 'c'.repeat(64),
  displayedRoutesSha256: 'd'.repeat(64),
  seedSourceSha256: 'e'.repeat(64),
  cohortId: 'aug',
}
const row = {
  vault,
  asset,
  vault_decimals: 18,
  asset_decimals: 18,
  total_assets_raw: '10000000000000000000',
  total_supply_raw: '9000000000000000000',
  cash_raw: '5000000000000000000',
  block: '26079573',
  block_hash: hash,
  observed_at: '2026-09-29T00:35:35.000Z',
  first_local_receipt_at: '2026-09-29T00:40:00.000Z',
  cohort_id: expected.cohortId,
  seed_sha256: expected.seedSha256,
  board_sha256: expected.boardSha256,
  displayed_routes_sha256: expected.displayedRoutesSha256,
  seed_source_sha256: expected.seedSourceSha256,
}

const directReading = {
  source: {
    chainId: 1,
    blockNumber: 26079573,
    blockHash: hash,
    blockTimestamp: '2026-09-29T00:35:35.000Z',
  },
  asset: { address: asset, decimals: 6 },
  route: {
    routeKey: 'USDC → supply on Aave V3',
    destination: vault,
    venueKind: 'aave_v3_atoken',
    cashRaw: '5000000',
    totalSupplyRaw: '9000000',
  },
} as unknown as Parameters<typeof sameDirectCashReading>[0]

describe('direct cash origin agreement', () => {
  it('validates only matching readings from distinct hosts', () => {
    expect(
      selectDirectCashWitness([
        { host: 'one.example', reading: directReading },
        { host: 'two.example', reading: { ...directReading } },
      ])?.originValidation,
    ).toBe('multi_rpc_host_match')
    expect(
      selectDirectCashWitness([
        { host: 'one.example', reading: directReading },
        { host: 'one.example', reading: { ...directReading } },
      ]),
    ).toBeNull()
  })

  it('abstains on different block or cash, while identifying a lone origin', () => {
    expect(
      sameDirectCashReading(directReading, {
        ...directReading,
        source: { ...directReading.source, blockNumber: 26079574 },
      }),
    ).toBe(false)
    expect(
      selectDirectCashWitness([
        { host: 'one.example', reading: directReading },
        {
          host: 'two.example',
          reading: {
            ...directReading,
            route: { ...directReading.route, cashRaw: '4000000' },
          },
        },
      ]),
    ).toBeNull()
    expect(
      selectDirectCashWitness([{ host: 'one.example', reading: directReading }]),
    ).toMatchObject({ originValidation: 'single_rpc_host' })
  })

  it('abstains when a third successful host contradicts two matching hosts', () => {
    expect(
      selectDirectCashWitness([
        { host: 'one.example', reading: directReading },
        { host: 'two.example', reading: { ...directReading } },
        {
          host: 'three.example',
          reading: {
            ...directReading,
            route: { ...directReading.route, cashRaw: '4000000' },
          },
        },
      ]),
    ).toBeNull()
  })
})

describe('Carry route observation batch', () => {
  it('suppresses misleading PT cash and accounting assets for the exact Twyne wrapper', () => {
    expect(
      carryVaultBalanceDisclosure(
        'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
        '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
      ),
    ).toEqual({
      cashRaw: null,
      totalAssetsRaw: null,
      cashInterpretation: 'wrapped_atoken_exit_cash_unassessed',
    })
    expect(
      carryVaultBalanceDisclosure(
        'USDC → USD3 [USDC]',
        '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
      ),
    ).toEqual({ cashInterpretation: 'direct_buffer_only' })
    expect(carryVaultBalanceDisclosure('USDC → USD3 [USDC]', vault)).toEqual({})
  })
  it('exposes only exact same-block, source-matched raw observations', () => {
    const batch = checkedCarryRouteBatch([row], [vault], expected)
    expect(batch).toMatchObject({
      block: '26079573',
      blockHash: hash,
      firstLocalReceiptAt: '2026-09-29T00:40:00.000Z',
      destinations: [{ vault, asset, cashRaw: row.cash_raw }],
    })
  })

  it('rejects missing, duplicate, or inconsistent route vault rows', () => {
    expect(checkedCarryRouteBatch([], [vault], expected)).toBeNull()
    expect(checkedCarryRouteBatch([row, row], [vault], expected)).toBeNull()
    expect(
      checkedCarryRouteBatch([{ ...row, seed_sha256: 'f'.repeat(64) }], [vault], expected),
    ).toBeNull()
    expect(
      checkedCarryRouteBatch(
        [{ ...row, displayed_routes_sha256: 'f'.repeat(64) }],
        [vault],
        expected,
      ),
    ).toBeNull()
    expect(
      checkedCarryRouteBatch(
        [{ ...row, first_local_receipt_at: row.observed_at.slice(0, 10) }],
        [vault],
        expected,
      ),
    ).toBeNull()
  })
})

const venue = (name: string) => recorderConfig.venues.find((entry) => entry.name === name)!
const localSnapshot = (name: string) => {
  const configured = venue(name)
  const direct = name === 'aave-v3-usde'
  const sgho = name === 'sGHO'
  return {
    venue: name,
    chain: 'ethereum',
    source: {
      block: '26092897',
      hash,
      timestamp: Date.parse('2026-09-30T21:10:47.000Z') / 1000,
      finalized: true,
      pinned: true,
    },
    observedAtUtc: '2026-09-30T21:26:48.000Z',
    firstLocalReceiptAtUtc: '2026-09-30T21:26:49.000Z',
    comparison: { status: 'no_previous_observation' },
    measurement: {
      totalAssetsRaw: direct ? null : '900',
      totalSupplyRaw: '800',
      underlyingBalanceRaw: direct || sgho ? '500' : null,
      params: {
        kind: direct ? 'atoken-liquidity' : sgho ? 'erc4626-vault-cash' : 'erc4626-cooldown',
        vaultDecimals: 18,
        underlyingDecimalsOnchain: 18,
        decimals: 18,
        underlying: configured.underlying,
        underlyingOnchain: configured.underlying,
        underlyingIdentity: 'match',
        decimalsIdentity: 'match',
        aToken: configured.address,
        vault: configured.address,
        withdrawalsPaused: false,
        reads: { paused: true, underlyingBalance: true },
      },
    },
  }
}

describe('local Carry market observations', () => {
  it('uses local disk only for exact development loopback sockets', () => {
    try {
      vi.stubEnv('NODE_ENV', 'development')
      const request = (remoteAddress: string) =>
        ({ socket: { remoteAddress } }) as Parameters<typeof localDevelopmentRequest>[0]
      expect(localDevelopmentRequest(request('127.0.0.1'))).toBe(true)
      expect(localDevelopmentRequest(request('::1'))).toBe(true)
      expect(localDevelopmentRequest(request('::ffff:127.0.0.1'))).toBe(true)
      expect(localDevelopmentRequest(request('192.168.1.8'))).toBe(false)
      vi.stubEnv('NODE_ENV', 'production')
      expect(localDevelopmentRequest(request('127.0.0.1'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps cooldown cash and future holder exits unavailable', () => {
    for (const [route, name] of [
      ['USDe → Staked USDe [USDe]', 'sUSDe'],
      ['USDS → SUsds [USDS]', 'sUSDS'],
    ]) {
      const result = checkedLocalCarryObservation(
        route,
        [{ destinationAddress: venue(name).address }],
        localSnapshot(name),
        Date.parse('2026-09-30T21:27:00.000Z'),
      )
      expect(result).toMatchObject({
        status: 'observed',
        freshness: 'fresh',
        observationStorage: 'local_mac_recorder',
        observationSource: 'finalized_venue_market_snapshot',
        block: '26092897',
        blockHash: hash,
        sourceBlockTime: '2026-09-30T21:10:47.000Z',
        observedAt: '2026-09-30T21:26:48.000Z',
        firstLocalReceiptAt: '2026-09-30T21:26:49.000Z',
        forecastValidation: 'not_validated',
        exitProjectionStatus: 'unavailable',
        durationProjectionStatus: 'unavailable',
        flowStatus: 'not_measured',
        continuity: 'not_established',
        destinations: [{ cashRaw: null, totalAssetsRaw: '900', routeAssetIdentity: 'unverified' }],
      })
    }
  })

  it('shows only identity checked aggregate cash and respects a paused sGHO vault', () => {
    const aave = checkedLocalCarryObservation(
      'USDe → supply on Aave V3',
      [{ destinationAddress: venue('aave-v3-usde').address }],
      localSnapshot('aave-v3-usde'),
      Date.parse('2026-10-01T00:00:00.000Z'),
    )
    expect(aave?.freshness).toBe('stale')
    expect(aave?.destinations[0]).toMatchObject({
      cashRaw: '500',
      source: 'finalized_direct_supply',
      marketKind: 'aave_v3_atoken',
      routeAssetIdentity: 'market_verified',
    })
    const paused = localSnapshot('sGHO')
    paused.measurement.params.withdrawalsPaused = true
    const sgho = checkedLocalCarryObservation(
      'GHO → sGho [GHO]',
      [{ destinationAddress: venue('sGHO').address }],
      paused,
    )
    expect(sgho?.destinations[0]).toMatchObject({ cashRaw: '0', source: 'finalized_erc4626' })
  })

  it('rejects a different contract, source chain, or failed underlying check', () => {
    const name = 'sGHO'
    const subjects = [{ destinationAddress: venue(name).address }]
    const candidate = localSnapshot(name)
    expect(
      checkedLocalCarryObservation('GHO → sGho [GHO]', [{ destinationAddress: vault }], candidate),
    ).toBeNull()
    expect(
      checkedLocalCarryObservation('GHO → sGho [GHO]', subjects, {
        ...candidate,
        chain: 'arbitrum',
      }),
    ).toBeNull()
    candidate.measurement.params.underlyingIdentity = 'mismatch'
    expect(checkedLocalCarryObservation('GHO → sGho [GHO]', subjects, candidate)).toBeNull()
    expect(
      checkedLocalCarryObservation('USDC → supply on Aave V3', subjects, localSnapshot('sGHO')),
    ).toBeNull()
  })
})

const archiveRoute = 'TEST → Vault [TEST]'
const archiveVaultA = `0x${'3'.repeat(40)}`
const archiveVaultB = `0x${'4'.repeat(40)}`
const archiveAsset = `0x${'5'.repeat(40)}`
const archiveAt = '2026-09-30T22:00:00.000Z'
const archiveReceivedAt = '2026-09-30T22:01:00.000Z'

const archiveSubject = (destination: string) => ({
  route_key: archiveRoute,
  destination,
  asset: archiveAsset,
  source_kind: 'vault' as const,
  venue_kind: null,
})

function archiveRow(
  destination: string,
  overrides: Partial<{
    asset: string | null
    shareDecimals: number | null
    assetDecimals: number | null
    cashRaw: string | null
    state: string
    reason: string | null
  }> = {},
) {
  return {
    routeKey: archiveRoute,
    destination,
    subjectKind: 'vault' as const,
    venueKind: 'erc4626',
    asset: archiveAsset,
    shareDecimals: 18,
    assetDecimals: 18,
    cashRaw: '123456789012345678901234567890',
    state: 'observed',
    reason: null,
    block: '100',
    blockHash: hash,
    blockAt: archiveAt,
    collectionMode: 'current',
    evidenceKind: 'current_finalized_observation',
    firstLocalReceiptAt: archiveReceivedAt,
    ...overrides,
  }
}

function archiveReceipt(rows: ReturnType<typeof archiveRow>[]) {
  return {
    collectionMode: 'current' as const,
    evidenceKind: 'current_finalized_observation',
    firstLocalReceiptAt: archiveReceivedAt,
    anchorAt: archiveAt,
    source: { chainId: 1, block: '100', blockHash: hash, blockAt: archiveAt },
    subjects: rows,
  }
}

describe('broad local historical observation adapter', () => {
  it('preserves exact aggregate cash while keeping forecast and holder claims unavailable', () => {
    const result = checkedLocalHistoricalCarryObservation(
      archiveRoute,
      [{ destinationAddress: archiveVaultA }],
      [archiveSubject(archiveVaultA)],
      [archiveReceipt([archiveRow(archiveVaultA)])],
      Date.parse('2026-09-30T22:30:00.000Z'),
    )
    expect(result).toMatchObject({
      status: 'observed',
      freshness: 'fresh',
      observationStorage: 'local_mac_verified_cash_archive',
      observationSource: 'finalized_aggregate_underlying_cash_proxy',
      forecastValidation: 'not_validated',
      exitProjectionStatus: 'unavailable',
      durationProjectionStatus: 'unavailable',
      historicalObservation: {
        status: 'available',
        claim: 'aggregate_underlying_cash_proxy_only',
        expectedSubjects: 1,
        observedSubjects: 1,
        historicalContextsAvailable: 0,
        holderExecutableExit: false,
        prospectiveValidated: false,
        predictiveAlertEligible: false,
      },
      destinations: [
        {
          vault: archiveVaultA,
          asset: archiveAsset,
          cashRaw: '123456789012345678901234567890',
          totalAssetsRaw: null,
          totalSupplyRaw: null,
          historicalCash: { status: 'unavailable', reason: 'insufficient_daily_anchors' },
        },
      ],
    })
  })

  it('returns exact-subject abstentions instead of converting unassessed cash to zero', () => {
    const result = checkedLocalHistoricalCarryObservation(
      archiveRoute,
      [{ destinationAddress: archiveVaultA }, { destinationAddress: archiveVaultB }],
      [archiveSubject(archiveVaultA), archiveSubject(archiveVaultB)],
      [
        archiveReceipt([
          archiveRow(archiveVaultA),
          archiveRow(archiveVaultB, {
            asset: null,
            shareDecimals: null,
            assetDecimals: null,
            cashRaw: null,
            state: 'unassessed',
            reason: 'mechanism_unassessed',
          }),
        ]),
      ],
      Date.parse('2026-09-30T22:30:00.000Z'),
    )
    expect(result).toMatchObject({
      status: 'observed',
      historicalObservation: {
        status: 'partial',
        expectedSubjects: 2,
        observedSubjects: 1,
        unavailableSubjects: [
          {
            destination: archiveVaultB,
            status: 'unavailable',
            reason: 'subject_unassessed',
          },
        ],
      },
      destinations: [{ vault: archiveVaultA }],
    })
    if (result.status === 'observed') expect(result.destinations).toHaveLength(1)
  })

  it('types destinations outside the frozen cohort instead of fabricating archive coverage', () => {
    expect(
      checkedLocalHistoricalCarryObservation(
        DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey,
        [{ destinationAddress: DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination }],
        [archiveSubject(archiveVaultA)],
        [],
      ),
    ).toMatchObject({
      status: 'not_enrolled',
      reason: 'subject_not_in_frozen_local_cohort',
      historicalObservation: {
        status: 'unavailable',
        observedSubjects: 0,
        holderExecutableExit: false,
        predictiveAlertEligible: false,
      },
    })
  })

  it('replays all frozen route groups and subjects from the checked local archive', async () => {
    const manifest = await buildSubjectManifest()
    const observations = readLocalCarryCashObservations(manifest)
    const byRoute = new Map<string, typeof manifest.subjects>()
    for (const subject of manifest.subjects) {
      const subjects = byRoute.get(subject.route_key) ?? []
      subjects.push(subject)
      byRoute.set(subject.route_key, subjects)
    }
    let expected = 0
    let observed = 0
    let unavailable = 0
    let historicalContexts = 0
    for (const [routeKey, subjects] of byRoute) {
      const result = checkedLocalHistoricalCarryObservation(
        routeKey,
        subjects.map((subject) => ({ destinationAddress: subject.destination })),
        manifest.subjects,
        observations,
      )
      expect(result.status).not.toBe('not_enrolled')
      expected += result.historicalObservation.expectedSubjects
      observed += result.historicalObservation.observedSubjects
      unavailable += result.historicalObservation.unavailableSubjects.length
      historicalContexts += result.historicalObservation.historicalContextsAvailable
      expect(result.historicalObservation).toMatchObject({
        holderExecutableExit: false,
        prospectiveValidated: false,
        predictiveAlertEligible: false,
      })
    }
    expect(byRoute.size).toBe(25)
    expect(expected).toBe(67)
    expect(observed).toBe(66)
    expect(unavailable).toBe(1)
    expect(historicalContexts).toBeGreaterThanOrEqual(64)
  })

  it('serves a frozen route outside the old point-recorder aliases without DB or RPC', async () => {
    try {
      vi.stubEnv('NODE_ENV', 'development')
      let status = 0
      let body: any
      const res = {
        setHeader: vi.fn(),
        status(code: number) {
          status = code
          return this
        },
        json(value: unknown) {
          body = value
          return this
        },
      }
      await handler(
        {
          method: 'GET',
          query: { routeKey: 'apxUSD → ApyUSD [apxUSD]' },
          socket: { remoteAddress: '127.0.0.1' },
        } as never,
        res as never,
      )
      expect(status).toBe(200)
      expect(body).toMatchObject({
        routeKey: 'apxUSD → ApyUSD [apxUSD]',
        status: 'observed',
        observationStorage: 'local_mac_verified_cash_archive',
        historicalObservation: {
          status: 'available',
          expectedSubjects: 1,
          observedSubjects: 1,
          holderExecutableExit: false,
          prospectiveValidated: false,
          predictiveAlertEligible: false,
        },
      })
      expect(body.destinations).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('serves the supplemental Aave USDe manifest-bound historical archive', async () => {
    try {
      vi.stubEnv('NODE_ENV', 'development')
      let status = 0
      let body: any
      const res = {
        setHeader: vi.fn(),
        status(code: number) {
          status = code
          return this
        },
        json(value: unknown) {
          body = value
          return this
        },
      }
      await handler(
        {
          method: 'GET',
          query: { routeKey: DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey },
          socket: { remoteAddress: '127.0.0.1' },
        } as never,
        res as never,
      )
      expect(status).toBe(200)
      expect(body).toMatchObject({
        routeKey: DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey,
        status: 'observed',
        observationStorage: 'local_mac_verified_cash_archive',
        forecastValidation: 'not_validated',
        historicalObservation: {
          status: 'available',
          sourceKind: 'local_sha_replayed_finalized_rpc',
          expectedSubjects: 1,
          observedSubjects: 1,
          historicalContextsAvailable: 1,
          holderExecutableExit: false,
          prospectiveValidated: false,
          predictiveAlertEligible: false,
        },
        destinations: [
          {
            vault: DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination.toLowerCase(),
            asset: DIRECT_SUPPLY_MARKETS.aaveV3Usde.underlying.toLowerCase(),
            marketKind: 'aave_v3_atoken',
            routeAssetIdentity: 'market_verified',
            historicalCash: {
              status: 'historical_context',
              sampleCount: 60,
              anchorCount: 120,
            },
          },
        ],
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
