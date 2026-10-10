import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import CapacityCurve from '../components/Venue/CapacityCurve'
import type { CapacityCurveResponse } from '../lib/venueCapacity/capacityCurve'

const warnings: string[] = []
const priorError = console.error
console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '))

const points = [0.1, 0.25, 0.5, 1, 2, 5, 10].map((costPct, i) => ({
  costPct,
  capacityUsd: (i + 1) * 1_000_000,
}))

const render = (data: CapacityCurveResponse) => {
  const client = new QueryClient()
  client.setQueryData(['capacity_curve', 'scrvUSD'], data)
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        ChakraProvider,
        {},
        React.createElement(CapacityCurve, { venue: 'scrvUSD', sizeUsd: 10_000 }),
      ),
    ),
  )
}

try {
  const reading: CapacityCurveResponse = {
    venue: 'scrvUSD',
    latestPassIncomplete: true,
    curve: {
      block: 26_069_830,
      observedAt: '2026-09-27T16:17:00.000Z',
      sourceBlockTime: '2026-09-27T16:00:00.000Z',
      points,
      reserveUsd: 10_000_000,
      markets: [
        {
          market: 'crvUSD/USDT',
          points,
          route: 'redeem scrvUSD and sell crvUSD',
          source: 'curve get_dy',
          navUsd: 1,
          feeBps: 4,
          reserveUsd: 10_000_000,
          error: null,
        },
      ],
    },
  }
  const measured = render(reading)
  assert.match(measured, /modeled route cost for/)
  assert.match(measured, /Modeled scrvUSD redemption/)
  assert.match(measured, /Output tokens are valued at \$1 each/)
  assert.match(measured, /chain 2026-09-27 16:00 UTC/)
  assert.match(measured, /saved 2026-09-27 16:17 UTC/)
  assert.match(measured, /latest pass incomplete; showing last complete quote/)
  assert.doesNotMatch(measured, /exit your .* in one swap/)

  const missing = render({ venue: 'scrvUSD', curve: null, unavailableReason: 'incomplete-latest' })
  assert.match(missing, /No quote for the current route can be verified/)
  assert.doesNotMatch(missing, /modeled route cost for/)
  assert.deepEqual(warnings, [])
  process.stdout.write('Venue capacity SSR checks passed\n')
} finally {
  console.error = priorError
}
