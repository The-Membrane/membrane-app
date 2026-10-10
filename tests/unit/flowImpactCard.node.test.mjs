import assert from 'node:assert/strict'
import test from 'node:test'

import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'

import cardModule from '../../components/Venue/FlowImpactCard.tsx'

const { FlowImpactCard } = cardModule

function render(props) {
  return renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(FlowImpactCard, props)),
  )
}

const base = {
  venue: 'Aave v3 USDe',
  venueKey: 'aave-v3-usde',
  capacityMetric: 'instantUsd',
  amountUsd: 10_000,
  horizonHours: 24,
  capacity: null,
  news: null,
  event: null,
  outlook: null,
  historicalScenario: null,
  historicalCoverage: null,
}

test('renders a measured capacity decline and the selected amount without a future claim', () => {
  const html = render({
    ...base,
    capacity: {
      status: 'observed_shrinking',
      before: { usd: 1_000_000, blockTime: '2026-10-03T10:00:00.000Z' },
      after: { usd: 800_000, blockTime: '2026-10-03T11:00:00.000Z' },
    },
    news: {
      title: 'Aave governance proposal',
      source: 'Aave',
      url: 'https://example.com/proposal',
      publishedAt: '2026-10-03T09:00:00.000Z',
      fetchedAt: '2026-10-03T09:05:00.000Z',
      storage: 'database',
    },
  })
  assert.match(html, /\$1\.00M → \$800\.0k/)
  assert.match(html, /1% → 1\.25%/)
  assert.match(html, /Published 2026-10-03 09:00 UTC/)
  assert.match(html, /First stored · 2026-10-03 09:05 UTC/)
  assert.match(html, /Future headroom · no validated capacity \+ competing-flow band/)
  assert.doesNotMatch(html, /validated route/i)
})

test('withholds missing capacity and inventory share instead of filling from a headline', () => {
  const html = render({
    ...base,
    news: {
      title: 'Aave governance proposal',
      source: 'Aave',
      url: 'https://example.com/proposal',
      publishedAt: '2026-10-03T09:00:00.000Z',
      fetchedAt: '2026-10-03T09:05:00.000Z',
      storage: 'local_mac_recorder',
    },
  })
  assert.match(html, /Observed capacity/)
  assert.match(html, /Your \$10\.0k exit · observed share/)
  assert.match(html, /Last fetched · 2026-10-03 09:05 UTC/)
  assert.doesNotMatch(html, /\$1\.00M →/)
})
