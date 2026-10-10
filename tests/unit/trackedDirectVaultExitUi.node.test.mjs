import assert from 'node:assert/strict'
import test from 'node:test'

import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import directMarkets from '../../lib/carry/directSupplyMarketConstants.ts'
import { GHO_SGHO } from '../../scripts/route-rates/exact-leg-spread.mjs'

const {
  canonicalCurrentExitDecimals,
  hasUnrepresentativeIdleCash,
  isTrackedDirectVaultExitRoute,
  liveExitEndpoint,
  rawExitAmount,
  shouldShowHistoricalCashContext,
} = workbench
const { DIRECT_SUPPLY_MARKETS } = directMarkets

const routes = [
  {
    routeKey: 'USDS → StUsds [USDS]',
    vault: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    assetDecimals: 18,
    amountRaw: '1250000000000000000',
  },
  {
    routeKey: 'USDC → Fluid USD Coin [USDC]',
    vault: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    amountRaw: '1250000',
  },
  {
    routeKey: 'USDT → fToken [USDT]',
    vault: '0x5c20b550819128074fd538edf79791733ccedd18',
    asset: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    assetDecimals: 6,
    amountRaw: '1250000',
  },
  {
    routeKey: 'GHO → fToken [GHO]',
    vault: '0x6a29a46e21c730dca1d8b23d637c101cec605c5b',
    asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    assetDecimals: 18,
    amountRaw: '1250000000000000000',
  },
  {
    routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
    vault: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    amountRaw: '1250000',
  },
  {
    routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
    vault: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    amountRaw: '1250000',
  },
]

for (const route of routes) {
  test(`${route.routeKey} enables only exact verified destination and amount unit`, () => {
    const observation = {
      vault: route.vault,
      asset: route.asset,
      assetDecimals: route.assetDecimals,
      routeAssetIdentity: 'source_verified',
    }
    assert.equal(isTrackedDirectVaultExitRoute(route.routeKey, route.vault, observation), true)
    assert.equal(
      liveExitEndpoint(
        route.routeKey,
        isTrackedDirectVaultExitRoute(route.routeKey, route.vault, observation),
      ),
      '/api/carry/tracked-direct-vault-exit',
    )
    assert.equal(rawExitAmount('1.25', observation.assetDecimals), route.amountRaw)
    assert.equal(isTrackedDirectVaultExitRoute(route.routeKey, route.asset, observation), false)
    assert.equal(
      isTrackedDirectVaultExitRoute(route.routeKey, route.vault, {
        ...observation,
        vault: route.asset,
      }),
      false,
    )
    assert.equal(
      isTrackedDirectVaultExitRoute(route.routeKey, route.vault, {
        ...observation,
        asset: route.vault,
      }),
      false,
    )
    assert.equal(
      isTrackedDirectVaultExitRoute(route.routeKey, route.vault, {
        ...observation,
        assetDecimals: route.assetDecimals === 6 ? 18 : 6,
      }),
      false,
    )
    assert.equal(
      isTrackedDirectVaultExitRoute(route.routeKey, route.vault, {
        ...observation,
        routeAssetIdentity: 'unverified',
      }),
      false,
    )
  })
}

test('paired conversion uses a USDC first-leg check while similarly named routes stay excluded', () => {
  const fluid = routes[1]
  const observation = {
    vault: fluid.vault,
    asset: fluid.asset,
    assetDecimals: fluid.assetDecimals,
    routeAssetIdentity: 'source_verified',
  }
  assert.equal(
    isTrackedDirectVaultExitRoute('USDC → FluidBridge [USDC]', fluid.vault, observation),
    false,
  )
  assert.equal(
    isTrackedDirectVaultExitRoute('USDC → Fluid USD Coin [USDT]', fluid.vault, observation),
    false,
  )
  assert.equal(isTrackedDirectVaultExitRoute(fluid.routeKey, '', observation), false)
  assert.equal(isTrackedDirectVaultExitRoute(fluid.routeKey, fluid.vault, undefined), false)
  const bridge = routes[4]
  const bridgeObservation = {
    vault: bridge.vault,
    asset: bridge.asset,
    assetDecimals: bridge.assetDecimals,
    routeAssetIdentity: 'source_verified',
  }
  assert.equal(
    isTrackedDirectVaultExitRoute(
      'USDT → FluidBridgeAggregatorProxy [USDC]',
      bridge.vault,
      bridgeObservation,
    ),
    true,
  )
  assert.equal(liveExitEndpoint('USDC → FluidBridge [USDC]', false), '/api/carry/morpho-exit')
  assert.equal(liveExitEndpoint('USDC → supply on Aave V3', false), '/api/carry/direct-supply-exit')
  assert.equal(liveExitEndpoint('USDe → supply on Aave V3', false), '/api/carry/direct-supply-exit')
  assert.equal(liveExitEndpoint('GHO → sGho [GHO]', false), '/api/carry/sgho-exit')
  assert.equal(rawExitAmount('1.0000001', 6), null)
})

test('Fluid Lite idle token balance is excluded as a cash model for both labels of its vault', () => {
  const vault = routes[4].vault
  assert.equal(hasUnrepresentativeIdleCash(routes[4].routeKey, vault), true)
  assert.equal(shouldShowHistoricalCashContext(routes[4].routeKey, vault), false)
  assert.equal(hasUnrepresentativeIdleCash('USDT → FluidBridgeAggregatorProxy [USDC]', vault), true)
  assert.equal(
    shouldShowHistoricalCashContext('USDT → FluidBridgeAggregatorProxy [USDC]', vault),
    false,
  )
  assert.equal(hasUnrepresentativeIdleCash(routes[4].routeKey, routes[1].vault), false)
  assert.equal(hasUnrepresentativeIdleCash(routes[1].routeKey, vault), false)
  assert.equal(shouldShowHistoricalCashContext(routes[1].routeKey, routes[1].vault), true)
  assert.equal(
    hasUnrepresentativeIdleCash('USDC → FluidBridgeAggregatorProxy [USDT]', vault),
    false,
  )
})

test('frozen AUSD VaultV2 destinations hide idle cash models without hiding other vault routes', () => {
  const route = 'AUSD → VaultV2 [AUSD]'
  const destinations = [
    '0x32401b9fb79065bc15949de0bd43927492f02f0c',
    '0xbeeff0d672ab7f5018dfb614c93981045d4aa98a',
    '0xbeeff0deac1aba71ef0d88c4291354eb92ef4589',
  ]
  for (const destination of destinations) {
    assert.equal(hasUnrepresentativeIdleCash(route, destination), true)
    assert.equal(shouldShowHistoricalCashContext(route, destination), false)
    assert.equal(hasUnrepresentativeIdleCash('USDC → VaultV2 [USDC]', destination), false)
  }
  assert.equal(hasUnrepresentativeIdleCash(route, routes[1].vault), false)
  assert.equal(shouldShowHistoricalCashContext(route, routes[1].vault), true)
  assert.equal(hasUnrepresentativeIdleCash('AUSD → VaultV2 [USDC]', destinations[0]), false)
})

test('Aave USDe current quote uses exact canonical identity only when the snapshot is absent', () => {
  const market = DIRECT_SUPPLY_MARKETS.aaveV3Usde
  const exact = {
    vault: market.destination,
    asset: market.underlying,
    assetDecimals: market.decimals,
    routeAssetIdentity: 'market_verified',
    source: 'finalized_direct_supply',
    marketKind: 'aave_v3_atoken',
  }
  const decimals = (
    selected,
    observationPresent = false,
    route = market.routeKey,
    destination = market.destination,
  ) => canonicalCurrentExitDecimals(route, destination, selected, observationPresent, false)

  assert.equal(decimals(undefined), 18)
  assert.equal(decimals(undefined, true), null)
  assert.equal(decimals(undefined, false, 'USDC → supply on Aave V3'), null)
  assert.equal(decimals(undefined, false, market.routeKey, GHO_SGHO.destination), null)
  assert.equal(decimals(exact, true), 18)
  assert.equal(decimals({ ...exact, asset: GHO_SGHO.borrowAsset }, false), null)
  assert.equal(decimals({ ...exact, assetDecimals: 6 }, false), null)
  assert.equal(decimals({ ...exact, routeAssetIdentity: 'mismatch' }, false), null)
  assert.equal(decimals({ ...exact, marketKind: 'compound_v3_comet' }, false), null)
  assert.equal(decimals({ ...exact, source: 'finalized_erc4626' }, false), null)
})

test('sGHO current quote requires the exact registry reader and GHO identity', () => {
  const route = 'GHO → sGho [GHO]'
  const exact = {
    vault: GHO_SGHO.destination,
    asset: GHO_SGHO.borrowAsset,
    assetDecimals: 18,
    routeAssetIdentity: 'confirmed',
    source: 'finalized_erc4626',
  }
  const decimals = (
    selected,
    observationPresent = false,
    reader = true,
    destination = GHO_SGHO.destination,
  ) => canonicalCurrentExitDecimals(route, destination, selected, observationPresent, reader)

  assert.equal(decimals(undefined), 18)
  assert.equal(decimals(undefined, false, false), null)
  assert.equal(decimals(undefined, true), null)
  assert.equal(decimals(undefined, false, true, DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination), null)
  assert.equal(decimals(exact, true), 18)
  assert.equal(
    decimals({ ...exact, asset: DIRECT_SUPPLY_MARKETS.aaveV3Usde.underlying }, false),
    null,
  )
  assert.equal(decimals({ ...exact, assetDecimals: 6 }, false), null)
  assert.equal(decimals({ ...exact, routeAssetIdentity: 'mismatch' }, false), null)
  assert.equal(
    decimals({ ...exact, vault: DIRECT_SUPPLY_MARKETS.aaveV3Usde.destination }, false),
    null,
  )
})
