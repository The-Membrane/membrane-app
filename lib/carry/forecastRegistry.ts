import type { Route } from '@/components/Carry/types'

const ADDRESS = /^0x[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

export type ForecastSourceCoverage = {
  /** An enabled withdrawal-ability recorder has this exact destination address. */
  recorderVenues: string[]
  /** The separate Aave GHO → sGHO reader has this exact destination address. */
  sghoLiveRoute: boolean
}

export type ForecastContractSubject = {
  chainId: 1
  destinationAddress: string
  identitySource: {
    kind: 'august_observed' | 'repo_verified_market' | 'receipt_verified_market'
    reference: string
  }
  sourceCoverage: ForecastSourceCoverage
  currentSourceReadiness: 'reader_configured' | 'market_identity_only' | 'historical_seed_only'
  forecastValidation: 'not_validated'
}

export type CarryForecastRouteGroup = {
  routeKey: string
  borrowAsset: string
  destination: string
  dominantBorrowVenue: string
  expectedDestinationCount: number
  observedDestinationCount: number
  mappedDestinationCount: number
  contractSubjects: ForecastContractSubject[]
  addressCoverage:
    | 'august_observed'
    | 'repo_verified_market'
    | 'receipt_verified_market'
    | 'address_unresolved'
  forecastValidation: 'not_validated'
}

export type CarryForecastRegistry = {
  chainId: 1
  status: 'source_inventory_only'
  provenance: {
    board: 'components/Carry/fixtures.ts ROUTES (August 2026 A+B scan)'
    destinationSeed: 'scripts/route-cohort/aug-2026-ab-vault-seed.json'
    cohortId: string
    declaredSourceName: string
    declaredSourceSha256: string
    caution: string
  }
  totals: {
    routeGroups: number
    observedContractSubjects: number
    uniqueObservedDestinationContracts: number
    mappedContractSubjects: number
    uniqueMappedDestinationContracts: number
    addressUnresolvedGroups: number
    readerConfiguredSubjects: number
  }
  routeGroups: CarryForecastRouteGroup[]
}

export type RouteCohortSeed = {
  cohortId: string
  source: { name: string; sha256: string }
  positions: Array<{ vault: string; routeIds: string[] }>
}

export type RecorderVenue = { name: string; address: string; enabled: boolean }
export type VerifiedMarketDestination = {
  routeKey: string
  address: string
  reference: string
  identityKind?: 'repo_verified_market' | 'receipt_verified_market'
  liveReaderConfigured?: boolean
  /** A separately verified live market, outside the immutable August route board. */
  supplementalRoute?: {
    borrowAsset: string
    destination: string
    dominantBorrowVenue: string
  }
}

/**
 * Map August route groups to exact observed destinations, then include any
 * explicitly marked separate verified markets. Neither source infers a current
 * position or a validated forecast.
 */
export function buildCarryForecastRegistry(
  routes: Route[],
  seed: RouteCohortSeed,
  recorderVenues: RecorderVenue[],
  sghoDestination: string,
  verifiedMarketDestinations: VerifiedMarketDestination[] = [],
): CarryForecastRegistry {
  if (!seed.cohortId || !seed.source?.name || !SHA256.test(seed.source.sha256)) {
    throw new Error('forecast_registry_seed_provenance_invalid')
  }
  const sghoAddress = sghoDestination.toLowerCase()
  if (!ADDRESS.test(sghoAddress)) throw new Error('forecast_registry_sgho_address_invalid')

  const recorderByAddress = new Map<string, string[]>()
  for (const venue of recorderVenues) {
    if (!venue.enabled) continue
    const address = venue.address.toLowerCase()
    if (!ADDRESS.test(address) || !venue.name) {
      throw new Error('forecast_registry_recorder_address_invalid')
    }
    const names = recorderByAddress.get(address) ?? []
    if (!names.includes(venue.name)) names.push(venue.name)
    recorderByAddress.set(address, names)
  }

  const observedByRoute = new Map<string, Set<string>>()
  for (const position of seed.positions) {
    const address = position.vault.toLowerCase()
    if (!ADDRESS.test(address) || !Array.isArray(position.routeIds)) {
      throw new Error('forecast_registry_position_invalid')
    }
    for (const routeKey of position.routeIds) {
      if (typeof routeKey !== 'string' || !routeKey) {
        throw new Error('forecast_registry_route_key_invalid')
      }
      const contracts = observedByRoute.get(routeKey) ?? new Set<string>()
      contracts.add(address)
      observedByRoute.set(routeKey, contracts)
    }
  }

  const verifiedByRoute = new Map<string, VerifiedMarketDestination[]>()
  for (const market of verifiedMarketDestinations) {
    if (
      !market.routeKey ||
      !ADDRESS.test(market.address.toLowerCase()) ||
      !market.reference ||
      !market.reference.startsWith('scripts/research/') ||
      (market.supplementalRoute !== undefined &&
        (!market.supplementalRoute.borrowAsset ||
          !market.supplementalRoute.destination ||
          !market.supplementalRoute.dominantBorrowVenue)) ||
      (market.identityKind !== undefined &&
        market.identityKind !== 'repo_verified_market' &&
        market.identityKind !== 'receipt_verified_market')
    ) {
      throw new Error('forecast_registry_verified_market_invalid')
    }
    const markets = verifiedByRoute.get(market.routeKey) ?? []
    markets.push(market)
    verifiedByRoute.set(market.routeKey, markets)
  }

  const seenRouteKeys = new Set<string>()
  const routeGroups = routes.map((route): CarryForecastRouteGroup => {
    const routeKey = route.routeKey
    if (!routeKey || seenRouteKeys.has(routeKey)) {
      throw new Error('forecast_registry_board_route_key_invalid')
    }
    seenRouteKeys.add(routeKey)
    const addresses = [...(observedByRoute.get(routeKey) ?? [])].sort()
    const verifiedMarkets = verifiedByRoute.get(routeKey) ?? []
    if (addresses.length && verifiedMarkets.length) {
      throw new Error('forecast_registry_duplicate_identity_sources')
    }
    if (
      !Number.isSafeInteger(route.destinations) ||
      (route.destinations ?? 0) < addresses.length + verifiedMarkets.length
    ) {
      throw new Error('forecast_registry_destination_count_invalid')
    }
    const identities = [
      ...addresses.map((destinationAddress) => ({
        destinationAddress,
        liveReaderConfigured: false,
        identitySource: {
          kind: 'august_observed' as const,
          reference: 'scripts/route-cohort/aug-2026-ab-vault-seed.json',
        },
      })),
      ...verifiedMarkets.map(({ address, reference, identityKind, liveReaderConfigured }) => ({
        destinationAddress: address.toLowerCase(),
        liveReaderConfigured: liveReaderConfigured === true,
        identitySource: { kind: identityKind ?? ('repo_verified_market' as const), reference },
      })),
    ]
    if (
      new Set(identities.map((identity) => identity.destinationAddress)).size !== identities.length
    ) {
      throw new Error('forecast_registry_duplicate_destination')
    }
    const contractSubjects = identities.map(
      ({ destinationAddress, identitySource, liveReaderConfigured }): ForecastContractSubject => {
        const recorderVenues = [...(recorderByAddress.get(destinationAddress) ?? [])].sort()
        // Match both the known route key and destination contract. A different
        // use of this address must not inherit the GHO → sGHO route's reader.
        const sghoLiveRoute = routeKey === 'GHO → sGho [GHO]' && destinationAddress === sghoAddress
        return {
          chainId: 1,
          destinationAddress,
          identitySource,
          sourceCoverage: { recorderVenues, sghoLiveRoute },
          currentSourceReadiness:
            recorderVenues.length || sghoLiveRoute || liveReaderConfigured
              ? 'reader_configured'
              : identitySource.kind === 'repo_verified_market' ||
                  identitySource.kind === 'receipt_verified_market'
                ? 'market_identity_only'
                : 'historical_seed_only',
          forecastValidation: 'not_validated',
        }
      },
    )
    return {
      routeKey,
      borrowAsset: route.src,
      destination: route.dst,
      dominantBorrowVenue: route.proto,
      expectedDestinationCount: route.destinations ?? 0,
      observedDestinationCount: addresses.length,
      mappedDestinationCount: contractSubjects.length,
      contractSubjects,
      addressCoverage: addresses.length
        ? 'august_observed'
        : verifiedMarkets.length
          ? (verifiedMarkets[0].identityKind ?? 'repo_verified_market')
          : 'address_unresolved',
      forecastValidation: 'not_validated',
    }
  })

  // Keep the August board immutable. A verified live market outside that scan
  // can still be selected for a current quote without inventing August P&L.
  for (const [routeKey, markets] of verifiedByRoute) {
    if (seenRouteKeys.has(routeKey)) continue
    const details = markets[0]?.supplementalRoute
    if (
      !details ||
      markets.some(
        (market) =>
          !market.supplementalRoute ||
          market.supplementalRoute.borrowAsset !== details.borrowAsset ||
          market.supplementalRoute.destination !== details.destination ||
          market.supplementalRoute.dominantBorrowVenue !== details.dominantBorrowVenue,
      )
    )
      throw new Error('forecast_registry_supplemental_route_invalid')
    const addresses = markets.map((market) => market.address.toLowerCase())
    if (new Set(addresses).size !== addresses.length)
      throw new Error('forecast_registry_duplicate_destination')
    routeGroups.push({
      routeKey,
      borrowAsset: details.borrowAsset,
      destination: details.destination,
      dominantBorrowVenue: details.dominantBorrowVenue,
      expectedDestinationCount: markets.length,
      observedDestinationCount: 0,
      mappedDestinationCount: markets.length,
      contractSubjects: markets.map((market) => {
        const destinationAddress = market.address.toLowerCase()
        const recorderVenues = [...(recorderByAddress.get(destinationAddress) ?? [])].sort()
        const kind = market.identityKind ?? 'repo_verified_market'
        return {
          chainId: 1,
          destinationAddress,
          identitySource: { kind, reference: market.reference },
          sourceCoverage: { recorderVenues, sghoLiveRoute: false },
          currentSourceReadiness:
            recorderVenues.length || market.liveReaderConfigured
              ? 'reader_configured'
              : 'market_identity_only',
          forecastValidation: 'not_validated',
        }
      }),
      addressCoverage: markets[0].identityKind ?? 'repo_verified_market',
      forecastValidation: 'not_validated',
    })
  }

  return {
    chainId: 1,
    status: 'source_inventory_only',
    provenance: {
      board: 'components/Carry/fixtures.ts ROUTES (August 2026 A+B scan)',
      destinationSeed: 'scripts/route-cohort/aug-2026-ab-vault-seed.json',
      cohortId: seed.cohortId,
      declaredSourceName: seed.source.name,
      declaredSourceSha256: seed.source.sha256,
      caution:
        'The August board is historical; separately verified live markets may also appear for current checks without August position or return attribution. Reader configuration is not a successful current read or a validated forecast. Borrow venues are dominant group labels, not exact legs for every position.',
    },
    totals: {
      routeGroups: routeGroups.length,
      observedContractSubjects: routeGroups.reduce(
        (sum, group) => sum + group.observedDestinationCount,
        0,
      ),
      uniqueObservedDestinationContracts: new Set(
        routeGroups.flatMap((group) =>
          group.contractSubjects
            .filter((subject) => subject.identitySource.kind === 'august_observed')
            .map((subject) => subject.destinationAddress),
        ),
      ).size,
      mappedContractSubjects: routeGroups.reduce(
        (sum, group) => sum + group.contractSubjects.length,
        0,
      ),
      uniqueMappedDestinationContracts: new Set(
        routeGroups.flatMap((group) =>
          group.contractSubjects.map((subject) => subject.destinationAddress),
        ),
      ).size,
      addressUnresolvedGroups: routeGroups.filter(
        (group) => group.addressCoverage === 'address_unresolved',
      ).length,
      readerConfiguredSubjects: routeGroups.reduce(
        (sum, group) =>
          sum +
          group.contractSubjects.filter(
            (subject) => subject.currentSourceReadiness === 'reader_configured',
          ).length,
        0,
      ),
    },
    routeGroups,
  }
}
