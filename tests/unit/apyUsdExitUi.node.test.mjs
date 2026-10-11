import assert from 'node:assert/strict'
import test from 'node:test'

import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import apy from '../../lib/carry/apyUsdExit.ts'

const { isApyUsdCurrentExitRoute, liveExitEndpoint, rawExitAmount } = workbench
const { APYUSD_ROUTE, APYUSD_VAULT, APXUSD_ASSET } = apy

test('ApyUSD current check is limited to the frozen route and attested apxUSD unit', () => {
  assert.equal(isApyUsdCurrentExitRoute(APYUSD_ROUTE, APYUSD_VAULT, undefined), true)
  assert.equal(liveExitEndpoint(APYUSD_ROUTE, false), '/api/carry/apyusd-exit')
  assert.equal(rawExitAmount('1.25', 18), '1250000000000000000')
  const observed = {
    vault: APYUSD_VAULT,
    asset: APXUSD_ASSET,
    assetDecimals: 18,
    source: 'finalized_erc4626',
  }
  assert.equal(isApyUsdCurrentExitRoute(APYUSD_ROUTE, APYUSD_VAULT, observed), true)
  assert.equal(isApyUsdCurrentExitRoute('USDC → ApyUSD [apxUSD]', APYUSD_VAULT, observed), false)
  assert.equal(isApyUsdCurrentExitRoute(APYUSD_ROUTE, APXUSD_ASSET, observed), false)
  assert.equal(
    isApyUsdCurrentExitRoute(APYUSD_ROUTE, APYUSD_VAULT, {
      ...observed,
      asset: APYUSD_VAULT,
    }),
    false,
  )
  assert.equal(
    isApyUsdCurrentExitRoute(APYUSD_ROUTE, APYUSD_VAULT, {
      ...observed,
      assetDecimals: 6,
    }),
    false,
  )
  assert.equal(
    isApyUsdCurrentExitRoute(APYUSD_ROUTE, APYUSD_VAULT, {
      ...observed,
      source: 'finalized_direct_supply',
    }),
    false,
  )
})
