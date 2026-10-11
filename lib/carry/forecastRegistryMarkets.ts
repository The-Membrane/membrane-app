import type { VerifiedMarketDestination } from './forecastRegistry'
import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'

/**
 * These addresses identify markets independently of the August position seed.
 * The Aave USDe route is separately verified and was not a displayed August
 * route group. No August holder is attributed or live forecast established.
 */
export function verifiedDirectSupplyDestinations(): VerifiedMarketDestination[] {
  return [
    {
      routeKey: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey,
      address: DIRECT_SUPPLY_MARKETS.aaveV3Usdc.destination,
      liveReaderConfigured: true,
      reference: 'scripts/research/aave-core-forward-panel.mjs MARKETS (reserve identity read)',
    },
    {
      routeKey: DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey,
      address: DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination,
      liveReaderConfigured: true,
      reference:
        'scripts/research/carry-public-direct-exit-issue.mjs (frozen Aave USDe reserve proof)',
      supplementalRoute: {
        borrowAsset: 'USDe',
        destination: 'Aave V3 supply',
        dominantBorrowVenue: 'Aave V3',
      },
    },
    {
      routeKey: DIRECT_SUPPLY_MARKETS.compoundV3Usdc.routeKey,
      address: DIRECT_SUPPLY_MARKETS.compoundV3Usdc.destination,
      liveReaderConfigured: true,
      reference:
        'scripts/research/compound-comet-weekly-screen.mjs MARKETS (baseToken identity read)',
    },
    {
      routeKey: DIRECT_SUPPLY_MARKETS.sparkLendUsdt.routeKey,
      address: DIRECT_SUPPLY_MARKETS.sparkLendUsdt.destination,
      identityKind: 'receipt_verified_market',
      liveReaderConfigured: true,
      reference: 'scripts/research/verify-spark-usdt-august-receipts.mjs (13/15 supply receipts)',
    },
  ]
}
