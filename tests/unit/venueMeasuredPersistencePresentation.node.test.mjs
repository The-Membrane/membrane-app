import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import venuePage from '../../components/Venue/VenuePage.tsx'
import sampledCapacity from '../../lib/venueForecast/sampledCapacity.ts'

const { MeasuredPersistenceMetrics } = venuePage
const { measureSampledCapacityPersistence } = sampledCapacity

const start = Date.parse('2026-10-07T00:00:00.000Z')
const HOUR = 3_600_000
const measurement = (values) => ({
  ...measureSampledCapacityPersistence({
    venue: 'scrvUSD',
    routeKey: '1:scrvUSD:recorded_cost_curve:exact-config',
    costCapPct: 1,
    amountUsd: 100,
    cadenceHours: 1,
    asOf: new Date(start + (values.length - 1) * HOUR + 60_000).toISOString(),
    snapshots: values.map((capacityUsd, index) => ({
      observedAt: new Date(start + index * HOUR).toISOString(),
      firstAvailableAt: new Date(start + index * HOUR + 1000).toISOString(),
      sourceId: `curve-${index}`,
      capacityUsd,
      coverage: capacityUsd === null ? 'partial' : 'complete',
    })),
  }),
  source: 'recorded_cost_curve',
  costCapSelection: 'default_recorded_level',
  evidenceCoverage: { returnedSamples: values.length, truncated: false, maxCurvePasses: 20 },
  unavailableReason: null,
})
const render = (value) =>
  renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      {},
      React.createElement(MeasuredPersistenceMetrics, { value }),
    ),
  )

describe('measured persistence metrics in the venue question card', () => {
  it('renders the three historical sampled metrics and identifies the default recorded cost', () => {
    const html = render(measurement([90, 100, 110, 90, 120, 130]))
    assert.ok(html.includes('Historical samples · 1% cost cap (default)'))
    assert.ok(html.includes('Measured historical persistence'))
    assert.ok(html.includes('Current ≥ Q · sampled'))
    assert.ok(html.includes('Longest completed · sampled'))
    assert.ok(html.includes('≥ Q / complete samples'))
    assert.equal(html.match(/>1\.00h</g).length, 2)
    assert.ok(html.includes('4 / 6 · 66.7%'))
    assert.ok(html.includes('capacity between samples is unknown'))
    assert.ok(html.includes('6 complete / 6 expected cadence slots; 0 missing'))
  })

  it('withholds the current span for stale or incomplete current evidence', () => {
    const stale = measurement([100, 110])
    stale.currentStatus = 'censored'
    stale.currentCensorReason = 'latest_sample_stale'
    // A retained historical run must not become a current duration.
    const html = render(stale)
    assert.ok(html.includes('>—<'))
    assert.ok(!html.includes('>1.00h<'))
    const incomplete = render(measurement([100, null]))
    assert.ok(incomplete.includes('>—<'))
    assert.ok(incomplete.includes('1 / 1 · 100.0%'))
    assert.ok(incomplete.includes('1 complete / 2 expected cadence slots'))
  })

  it('distinguishes known current below-Q capacity from stale or unknown measurements', () => {
    const known = render(measurement([90, 100, 90]))
    assert.ok(known.includes('>Below Q<'))
    const stale = measurement([90, 100, 90])
    stale.currentStatus = 'censored'
    stale.currentCensorReason = 'latest_sample_stale'
    const staleHtml = render(stale)
    assert.ok(!staleHtml.includes('>Below Q<'))
    assert.ok(staleHtml.includes('>—<'))
  })

  it('does not label cash measurements with a cost cap or render missing evidence', () => {
    const cash = measurement([100])
    cash.source = 'recorded_cash'
    cash.costCapPct = null
    cash.costCapSelection = 'not_applicable'
    assert.ok(!render(cash).includes('1% cost'))
    assert.ok(!render(undefined).includes('Measured historical persistence'))
  })
})
