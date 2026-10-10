import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import historicalRouteLegs from '@/components/Carry/historical-route-legs.json'
import routeCapital from '@/components/Carry/route-capital.json'

// Frozen Stage14 lending rows in unified_routes.json, in net-spread order.
// Keep the source labels here independently of the display fixture so a
// hand-picked shortlist or changed group name cannot silently pass.
const PRICED_LENDING_GROUPS: [string, number][] = [
  ['AUSD → Staked USDat [USDat]', 15],
  ['apxUSD → ApyUSD [apxUSD]', 19],
  ['USDT → FluidBridgeAggregatorProxy [USDC]', 15],
  ['USDC → FluidBridgeAggregatorProxy [USDC]', 13],
  ['USDC → VaultV2 [USDC]', 182],
  ['USDS → StUsds [USDS]', 21],
  ['PYUSD → StakingVault [wYLDS]', 26],
  ['EURCV → VaultV2 [EURCV]', 29],
  ['USDC → Fluid USD Coin [USDC]', 37],
  ['USDT → fToken [USDT]', 25],
  ['USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]', 16],
  ['USDe → Staked USDe [USDe]', 25],
  ['USDT → supply on Spark', 15],
  ['GHO → sGho [GHO]', 20],
  ['AUSD → VaultV2 [AUSD]', 28],
  ['USDT → VaultV2 [USDT]', 16],
  ['USDC → USD3 [USDC]', 78],
  ['USDS → SUsds [USDS]', 13],
  ['RLUSD → VaultV2 [RLUSD]', 37],
  ['GHO → fToken [GHO]', 28],
  ['LINK → VaultV2 [LINK]', 17],
  ['USDC → supply on Aave V3', 49],
  ['USDC → supply on Compound v3', 20],
  ['PYUSD → VaultV2 [PYUSD]', 54],
  ['GHO → UmbrellaStakeToken [GHO]', 21],
]

describe('measured carry routes', () => {
  it('includes every priced August lending group, not a shortlist', () => {
    expect(ROUTES.map((route) => [route.routeKey, route.pos])).toEqual(PRICED_LENDING_GROUPS)
    expect(new Set(ROUTES.map((route) => `${route.src} → ${route.dst}`)).size).toBe(25)
    expect(ROUTES.reduce((sum, route) => sum + route.pos, 0)).toBe(819)
    expect(ROUTES.every((route) => route.destinations && route.destinations > 0)).toBe(true)
    const capitalKeys = new Set(routeCapital.routes.map((route) => route.route))
    expect(ROUTES.every((route) => capitalKeys.has(route.routeKey!))).toBe(true)
  })

  it('keeps sGHO savings separate from Umbrella staking', () => {
    const gho = ROUTES.filter((route) => route.src === 'GHO')
    expect(gho).toEqual([
      expect.objectContaining({ dst: 'sGHO', pos: 20, net: 0.52 }),
      expect.objectContaining({ dst: 'Fluid fToken', pos: 28, net: -0.46 }),
      expect.objectContaining({ dst: 'UmbrellaStakeToken', pos: 21, net: -3.75 }),
    ])
  })

  it('reconciles every saved August borrow and yield leg to the sampled spread', () => {
    const legs = historicalRouteLegs as Record<string, [number, number]>
    expect(Object.keys(legs)).toHaveLength(25)
    for (const route of ROUTES) {
      const pair = legs[route.routeKey!]
      expect(pair, route.routeKey).toBeDefined()
      expect(pair[1] - pair[0]).toBeCloseTo(route.net, 2)
    }
    expect(legs['GHO → sGho [GHO]']).toEqual([3.75, 4.2744])
    expect(legs['USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]']).toEqual([3.3051, 3.99])
  })
})
