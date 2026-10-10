import assert from 'node:assert/strict'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'

import CuratorScenario from '../components/Carry/CuratorScenario'

const nowMs = Date.parse('2026-09-27T18:00:00Z')
const render = (
  rates: { borrowApy: number; yieldApy: number; observedAt: string } | null,
  inventory: {
    vaultCashGho: number
    totalAssetsGho: number
    withdrawalsPaused: boolean
    observedAt: string
  } | null,
) =>
  renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      {},
      React.createElement(CuratorScenario, {
        rateReading: rates,
        inventoryReading: inventory,
        nowMs,
      }),
    ),
  )

const measured = render(
  { borrowApy: 0.04, yieldApy: 0.05, observedAt: '2026-09-27T17:00:00Z' },
  {
    vaultCashGho: 12_000,
    totalAssetsGho: 20_000,
    withdrawalsPaused: false,
    observedAt: '2026-09-27T17:10:00Z',
  },
)
assert.match(measured, /Stress the carry before it moves/)
assert.match(measured, /Curator what-if for Aave GHO into sGHO/)
assert.match(measured, /−1\.00 pp/)
assert.match(measured, /9,000 GHO/)
assert.match(measured, /1,000 GHO below the entered size/)
assert.match(measured, /Measured Sep 27/)
assert.match(measured, /not a wallet maxRedeem, executable quote, or warning/)
assert.match(measured, /Plan a Disco lower-LTV move/)
assert.match(measured, /not a live countdown/)
assert.doesNotMatch(measured, /14-day/)

const stale = render({ borrowApy: 0.04, yieldApy: 0.05, observedAt: '2026-09-20T12:00:00Z' }, null)
assert.match(stale, /Stale Sep 20/)
assert.match(stale, /No measured cash reading\. Cash scenario is unavailable\./)
assert.match(stale, /−1\.00 pp/)

const missing = render(null, null)
assert.match(missing, /No measured rate legs yet\./)
assert.doesNotMatch(missing, /With your rate changes/)

process.stdout.write('Curator scenario SSR checks passed\n')
