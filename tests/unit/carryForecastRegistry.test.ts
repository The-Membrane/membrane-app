import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import forecastUniverseHandler from '@/pages/api/carry/forecast-universe'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

const build = () =>
  buildCarryForecastRegistry(
    ROUTES,
    seed,
    recorderConfig.venues,
    GHO_SGHO.destination,
    verifiedDirectSupplyDestinations(),
  )

describe('Carry forecast universe', () => {
  it('serves a read-only source inventory with no live-forecast claim', () => {
    const response = {
      headers: {} as Record<string, string>,
      statusCode: 0,
      body: null as unknown,
      setHeader(name: string, value: string) {
        this.headers[name] = value
        return this
      },
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(body: unknown) {
        this.body = body
        return this
      },
    }
    forecastUniverseHandler({ method: 'GET' } as never, response as never)
    expect(response.statusCode).toBe(200)
    expect(response.headers['Cache-Control']).toBe('no-store')
    expect((response.body as { status: string }).status).toBe('source_inventory_only')
    forecastUniverseHandler({ method: 'POST' } as never, response as never)
    expect(response.statusCode).toBe(405)
  })

  it('keeps all 25 August groups plus a separately verified Aave USDe market', () => {
    const registry = build()
    expect(registry.status).toBe('source_inventory_only')
    expect(registry.totals).toEqual({
      routeGroups: 26,
      observedContractSubjects: 64,
      uniqueObservedDestinationContracts: 63,
      mappedContractSubjects: 68,
      uniqueMappedDestinationContracts: 67,
      addressUnresolvedGroups: 0,
      readerConfiguredSubjects: 7,
    })
    expect(registry.routeGroups.map((group) => group.routeKey)).toEqual([
      ...ROUTES.map((route) => route.routeKey),
      'USDe → supply on Aave V3',
    ])
    expect(
      registry.routeGroups.every((group) => group.forecastValidation === 'not_validated'),
    ).toBe(true)
    const morpho = registry.routeGroups.find((group) => group.routeKey === 'USDC → VaultV2 [USDC]')!
    expect(morpho.contractSubjects).toHaveLength(33)
    expect(new Set(morpho.contractSubjects.map((subject) => subject.destinationAddress)).size).toBe(
      33,
    )
    expect(
      morpho.contractSubjects.every((subject) => subject.forecastValidation === 'not_validated'),
    ).toBe(true)
  })

  it('resolves four direct-supply markets and marks Spark by its receipt evidence', () => {
    const unresolved = build()
      .routeGroups.filter((group) => group.addressCoverage === 'address_unresolved')
      .map((group) => group.routeKey)
    expect(unresolved).toEqual([])
    const aave = build().routeGroups.find((group) => group.routeKey === 'USDC → supply on Aave V3')!
    expect(aave.observedDestinationCount).toBe(0)
    expect(aave.contractSubjects[0].identitySource).toEqual({
      kind: 'repo_verified_market',
      reference: 'scripts/research/aave-core-forward-panel.mjs MARKETS (reserve identity read)',
    })
    expect(aave.contractSubjects[0].destinationAddress).toBe(
      '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    )
    expect(aave.contractSubjects[0].currentSourceReadiness).toBe('reader_configured')
    const aaveUsde = build().routeGroups.find(
      (group) => group.routeKey === 'USDe → supply on Aave V3',
    )!
    expect(aaveUsde).toMatchObject({
      borrowAsset: 'USDe',
      expectedDestinationCount: 1,
      observedDestinationCount: 0,
      mappedDestinationCount: 1,
      forecastValidation: 'not_validated',
    })
    expect(aaveUsde.contractSubjects[0]).toMatchObject({
      destinationAddress: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
      sourceCoverage: { recorderVenues: ['aave-v3-usde'] },
      currentSourceReadiness: 'reader_configured',
    })
    const compound = build().routeGroups.find(
      (group) => group.routeKey === 'USDC → supply on Compound v3',
    )!
    expect(compound.contractSubjects[0].destinationAddress).toBe(
      '0xc3d688b66703497daa19211eedff47f25384cdc3',
    )
    expect(compound.contractSubjects[0].identitySource.kind).toBe('repo_verified_market')
    const spark = build().routeGroups.find((group) => group.routeKey === 'USDT → supply on Spark')!
    expect(spark.addressCoverage).toBe('receipt_verified_market')
    expect(spark.observedDestinationCount).toBe(0)
    expect(spark.contractSubjects[0]).toMatchObject({
      destinationAddress: '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',
      identitySource: { kind: 'receipt_verified_market' },
      currentSourceReadiness: 'reader_configured',
      forecastValidation: 'not_validated',
    })
  })

  it('matches configured readers only by exact observed destination contract', () => {
    const registry = build()
    const sgho = registry.routeGroups.find((group) => group.routeKey === 'GHO → sGho [GHO]')!
    expect(sgho.contractSubjects).toEqual([
      {
        chainId: 1,
        destinationAddress: GHO_SGHO.destination,
        identitySource: {
          kind: 'august_observed',
          reference: 'scripts/route-cohort/aug-2026-ab-vault-seed.json',
        },
        sourceCoverage: { recorderVenues: ['sGHO'], sghoLiveRoute: true },
        currentSourceReadiness: 'reader_configured',
        forecastValidation: 'not_validated',
      },
    ])
    const susde = registry.routeGroups.find(
      (group) => group.routeKey === 'USDe → Staked USDe [USDe]',
    )!
    expect(susde.contractSubjects[0].sourceCoverage.recorderVenues).toEqual(['sUSDe'])
    const susds = registry.routeGroups.find((group) => group.routeKey === 'USDS → SUsds [USDS]')!
    expect(susds.contractSubjects[0].sourceCoverage.recorderVenues).toEqual(['sUSDS'])
    const differentStUsds = registry.routeGroups.find(
      (group) => group.routeKey === 'USDS → StUsds [USDS]',
    )!
    expect(differentStUsds.contractSubjects[0].sourceCoverage.recorderVenues).toEqual([])
    expect(
      registry.routeGroups
        .filter((group) => group.routeKey !== 'USDe → supply on Aave V3')
        .flatMap((group) => group.contractSubjects)
        .some((subject) => subject.sourceCoverage.recorderVenues.includes('aave-v3-usde')),
    ).toBe(false)
  })

  it('rejects malformed source addresses and contradictory grouped counts', () => {
    expect(() =>
      buildCarryForecastRegistry(
        ROUTES,
        { ...seed, positions: [{ vault: 'not-an-address', routeIds: [ROUTES[0].routeKey!] }] },
        recorderConfig.venues,
        GHO_SGHO.destination,
      ),
    ).toThrow('forecast_registry_position_invalid')
    expect(() =>
      buildCarryForecastRegistry(
        [{ ...ROUTES[4], destinations: 1 }],
        seed,
        recorderConfig.venues,
        GHO_SGHO.destination,
      ),
    ).toThrow('forecast_registry_destination_count_invalid')
    expect(() =>
      buildCarryForecastRegistry(ROUTES, seed, recorderConfig.venues, GHO_SGHO.destination, [
        {
          routeKey: 'USDT → supply on Spark',
          address: '0x123',
          reference: 'scripts/research/spark.mjs',
        },
      ]),
    ).toThrow('forecast_registry_verified_market_invalid')
    expect(() =>
      buildCarryForecastRegistry(ROUTES, seed, recorderConfig.venues, GHO_SGHO.destination, [
        {
          routeKey: 'Unknown → unobserved market',
          address: DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination,
          reference: 'scripts/research/carry-public-direct-exit-issue.mjs',
        },
      ]),
    ).toThrow('forecast_registry_supplemental_route_invalid')
  })
})
