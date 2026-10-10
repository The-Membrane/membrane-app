import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveRouteCapital } from './carry-route-capital.mjs'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const GHO = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
const owner = '0xabc'
const vault = '0xdef'
const entry = (route, tx, amt, asset = USDC) => ({
  proto: 'Aave V3',
  borrower: owner,
  dest: vault,
  block: 1,
  tx,
  asset,
  market: null,
  amt: String(amt),
  route,
})
const display = (route, pos = 1) => ({ venue: 'Aave V3', route, pos })

test('caps held capital once and allocates mixed exact routes pro rata, without double count', () => {
  const a = entry('USDC → Vault A', '0x01', 1_000_000_000)
  const b = entry('USDC → Vault B', '0x02', 3_000_000_000)
  const rows = deriveRouteCapital({
    routesAb: [a, b],
    carriesWide: [a, a, b],
    carryTvl: [{ proto: 'Aave V3', owner, vault, usd: 2000, open: true }],
    unifiedRoutes: [display(a.route), display(b.route)],
    morphoMarkets: {},
  })
  assert.equal(rows[0].cohortHeldCapitalUsdApprox, 500)
  assert.equal(rows[1].cohortHeldCapitalUsdApprox, 1500)
  assert.equal(
    rows.reduce((sum, row) => sum + row.cohortHeldCapitalUsdApprox, 0),
    2000,
  )
})

test('requires exact protocol, owner and destination; missing priced holdings are unknown', () => {
  const a = entry('USDC → Vault A', '0x01', 1_000_000_000)
  const row = deriveRouteCapital({
    routesAb: [a],
    carriesWide: [a],
    carryTvl: [{ proto: 'Morpho Blue', owner, vault, usd: 9000, open: true }],
    unifiedRoutes: [display(a.route)],
    morphoMarkets: {},
  })[0]
  assert.equal(row.cohortHeldCapitalUsdApprox, null)
  assert.equal(row.missingPricedHoldingGroups, 1)
  assert.equal(row.status, 'unpriced')
})

test('GHO 18 decimals and Morpho market metadata are respected without symbol guesses', () => {
  const market = '0xfeed'
  const a = {
    ...entry('GHO → sGho [GHO]', '0x01', '100000000000000000000', null),
    proto: 'Morpho Blue',
    market,
  }
  const row = deriveRouteCapital({
    routesAb: [a],
    carriesWide: [a],
    carryTvl: [{ proto: 'Morpho Blue', owner, vault, usd: 200, open: true }],
    unifiedRoutes: [display(a.route)],
    morphoMarkets: { [market]: { loan: GHO } },
  })[0]
  assert.equal(row.cohortHeldCapitalUsdApprox, 100)
  assert.equal(row.pricedOpenGroups, 1)
})

test('unknown asset in any inflow makes the whole owner+destination group unpriced', () => {
  const a = entry('USDC → Vault A', '0x01', 1_000_000_000)
  const unknown = entry('OTHER → Vault A', '0x02', 2_000_000_000, '0xunknown')
  const row = deriveRouteCapital({
    routesAb: [a],
    carriesWide: [a, unknown],
    carryTvl: [{ proto: 'Aave V3', owner, vault, usd: 1000, open: true }],
    unifiedRoutes: [display(a.route)],
    morphoMarkets: {},
  })[0]
  assert.equal(row.cohortHeldCapitalUsdApprox, null)
  assert.equal(row.unsupportedAssetGroups, 1)
})

test('display label can aggregate multiple destination contracts and lending protocols', () => {
  const a = entry('USDC → VaultV2 [USDC]', '0x01', 1_000_000_000)
  const b = { ...entry(a.route, '0x02', 2_000_000_000), proto: 'Spark', dest: '0x123' }
  const row = deriveRouteCapital({
    routesAb: [a, b],
    carriesWide: [a, b],
    carryTvl: [
      { proto: 'Aave V3', owner, vault, usd: 500, open: true },
      { proto: 'Spark', owner, vault: '0x123', usd: 1500, open: true },
    ],
    unifiedRoutes: [display(a.route, 2)],
    morphoMarkets: {},
  })[0]
  assert.equal(row.cohortHeldCapitalUsdApprox, 2000)
  assert.equal(row.destinationContracts, 2)
  assert.deepEqual(row.borrowProtocols, ['Aave V3', 'Spark'])
})
