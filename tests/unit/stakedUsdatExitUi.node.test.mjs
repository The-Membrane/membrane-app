import assert from 'node:assert/strict'
import test from 'node:test'

import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import staked from '../../lib/carry/stakedUsdatExit.ts'

const { isStakedUsdatCurrentExitRoute, liveExitEndpoint, rawExitAmount } = workbench
const { STAKED_USDAT_ROUTE, STAKED_USDAT_VAULT, USDAT_ASSET } = staked

test('Staked USDat exact-share check stays on the frozen AUSD route and destination', () => {
  assert.equal(
    isStakedUsdatCurrentExitRoute(STAKED_USDAT_ROUTE, STAKED_USDAT_VAULT, undefined),
    true,
  )
  assert.equal(liveExitEndpoint(STAKED_USDAT_ROUTE, false), '/api/carry/staked-usdat-exit')
  assert.equal(rawExitAmount('10', 18), '10000000000000000000')
  const observed = {
    vault: STAKED_USDAT_VAULT,
    asset: USDAT_ASSET,
    assetDecimals: 6,
  }
  assert.equal(
    isStakedUsdatCurrentExitRoute(STAKED_USDAT_ROUTE, STAKED_USDAT_VAULT, observed),
    true,
  )
  assert.equal(
    isStakedUsdatCurrentExitRoute('USDC → Staked USDat [USDat]', STAKED_USDAT_VAULT, observed),
    false,
  )
  assert.equal(isStakedUsdatCurrentExitRoute(STAKED_USDAT_ROUTE, USDAT_ASSET, observed), false)
  assert.equal(
    isStakedUsdatCurrentExitRoute(STAKED_USDAT_ROUTE, STAKED_USDAT_VAULT, {
      ...observed,
      asset: STAKED_USDAT_VAULT,
    }),
    false,
  )
})
