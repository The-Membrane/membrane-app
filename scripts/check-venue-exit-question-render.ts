import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime'

import { VenuePage, parseExitQuestionInputs } from '../components/Venue/VenuePage'

const router = {
  route: '/[chain]/venue/[name]',
  pathname: '/[chain]/venue/[name]',
  query: { chain: 'ethereum', name: 'scrvUSD' },
  asPath: '/ethereum/venue/scrvUSD',
  basePath: '',
  isLocaleDomain: false,
  isReady: true,
  isPreview: false,
  push: async () => true,
  replace: async () => true,
  reload: () => undefined,
  back: () => undefined,
  prefetch: async () => undefined,
  beforePopState: () => undefined,
  events: { on: () => undefined, off: () => undefined, emit: () => undefined },
} as unknown as React.ComponentProps<typeof RouterContext.Provider>['value']

function renderVenue(curve: unknown, summary?: unknown) {
  const client = new QueryClient()
  client.setQueryData(['capacity_curve', 'scrvUSD'], curve)
  if (summary) client.setQueryData(['venue_summary', 'scrvUSD'], summary)
  return renderToStaticMarkup(
    React.createElement(
      RouterContext.Provider,
      { value: router },
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          ChakraProvider,
          {},
          React.createElement(VenuePage, { venue: 'scrvUSD' }),
        ),
      ),
    ),
  )
}

const unavailable = renderVenue({
  venue: 'scrvUSD',
  curve: null,
  unavailableReason: 'incomplete-latest',
})
assert.match(unavailable, /id="exit-size-scrvUSD"/)
assert.match(unavailable, /value="10000"/)
assert.match(unavailable, /id="exit-horizon-scrvUSD"/)
assert.match(unavailable, /value="24"/)
assert.match(unavailable, /Future horizon \(hours · 1h–30d\)/)
assert.match(unavailable, /future exit ability and duration unavailable/)
assert.match(unavailable, /Current route quote/)
assert.match(unavailable, /No quote for the current route can be verified/)
assert.match(unavailable, /Historical maximum gross \/ net flow/)
assert.doesNotMatch(unavailable, /likely (?:exit|duration)|\d+% probability/i)

const points = [
  { costPct: 0.5, capacityUsd: 50_000 },
  { costPct: 1, capacityUsd: 100_000 },
]
const quoted = renderVenue(
  {
    venue: 'scrvUSD',
    curve: {
      block: 1,
      observedAt: '2026-09-28T12:00:00.000Z',
      sourceBlockTime: '2026-09-28T11:59:00.000Z',
      points,
      reserveUsd: 100_000,
      markets: [{ market: 'test', source: 'curve get_dy', points, reserveUsd: 100_000 }],
    },
  },
  {
    venue: 'scrvUSD',
    label: 'scrvUSD',
    kind: 'atoken-liquidity',
    observed: {
      block: 2,
      observedAt: '2026-09-28T10:00:00.000Z',
      instantUsd: 25_000,
      params: {
        totalAssets: null,
        cooldownDuration: null,
        utilizationPct: null,
        depthUsd: null,
        depthSkewPct: null,
        depthMarkets: null,
      },
    },
    suppliedTvl: null,
    corpus: {
      snapshots: 1,
      snapshotsObserved: 1,
      snapshotSpan: { start: null, end: null },
      flows: 0,
      flowSpan: { start: null, end: null },
      news: 0,
    },
    worstOutflows: { d1: null, d7: null },
    alarms: { open: [], uncovered: [] },
  },
)
assert.match(quoted, /For \$10k over 24 hours/)
assert.match(quoted, /modeled route cost for \$10k/)
assert.match(quoted, /chain 2026-09-28 11:59 UTC/)
assert.match(quoted, /Aggregate reserve cash proxy[^<]*source block 2[^<]*2026-09-28 10:00 UTC/)
assert.match(quoted, /Current route quote[^<]*source block 1[^<]*2026-09-28 11:59 UTC/)

assert.deepEqual(parseExitQuestionInputs('250000', '8'), {
  amountUsd: 250_000,
  horizonHours: 8,
})
assert.deepEqual(parseExitQuestionInputs('250000', '2'), {
  amountUsd: 250_000,
  horizonHours: 2,
})
assert.deepEqual(parseExitQuestionInputs('3750.5', '720'), {
  amountUsd: 3750.5,
  horizonHours: 720,
})
assert.equal(parseExitQuestionInputs('', '24').amountUsd, null)
assert.equal(parseExitQuestionInputs('0', '24').amountUsd, null)
assert.equal(parseExitQuestionInputs('10000', '0').horizonHours, null)
assert.equal(parseExitQuestionInputs('10000', '24.5').horizonHours, null)

process.stdout.write('Venue exit question SSR checks passed\n')
