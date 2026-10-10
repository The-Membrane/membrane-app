import assert from 'node:assert/strict'
import test from 'node:test'

import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import identity from '../../lib/carry/pyusdStakingRouteIdentity.ts'

const { hasUnrepresentativeIdleCash, isPyusdStakingSubject } = workbench
const { PYUSD_STAKING_ROUTE, HASTRA_STAKING_VAULT, HASTRA_YIELD_VAULT } = identity

test('only the frozen PYUSD StakingVault subject suppresses exit cash interpretation', () => {
  assert.equal(isPyusdStakingSubject(PYUSD_STAKING_ROUTE, HASTRA_STAKING_VAULT), true)
  assert.equal(hasUnrepresentativeIdleCash(PYUSD_STAKING_ROUTE, HASTRA_STAKING_VAULT), true)
  assert.equal(isPyusdStakingSubject(PYUSD_STAKING_ROUTE, HASTRA_YIELD_VAULT), false)
  assert.equal(isPyusdStakingSubject('PYUSD → VaultV2 [PYUSD]', HASTRA_STAKING_VAULT), false)
})
