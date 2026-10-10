import assert from 'node:assert/strict'
import test from 'node:test'
import {
  empiricalQuantile,
  independentIncidents,
  response,
  rollingSixHourDrops,
  summarize,
} from './aave-freeze-event-logic.mjs'

const targetAsset = '0x0000000000000000000000000000000000000001'
const event = (at, asset = '0x0000000000000000000000000000000000000002', enabled = true) => ({
  at,
  block: at,
  logIndex: 0,
  asset,
  enabled,
  targetAsset,
})

test('positive cross-reserve events within 24h are one independent incident', () => {
  const incidents = independentIncidents([
    event(100000),
    event(100000 + 3600),
    event(100000 + 86400),
    event(100000 + 86400 + 20, targetAsset),
    event(100000 + 86400 + 40, undefined, false),
  ])
  assert.equal(incidents.length, 2)
  assert.equal(incidents[0].events.length, 2)
  assert.equal(incidents[1].events.length, 1)
})

test('cash response requires pre-event headroom and complete 6–24h grid', () => {
  assert.deepEqual(response(120, [110, 100, 90, 80, 70, 60, 50], 100), {
    eligible: true,
    crossed: true,
    firstHour: 12,
  })
  assert.equal(response(99, [90, 80, 70, 60, 50, 40, 30], 100).eligible, false)
  assert.equal(response(120, [90, 80], 100).eligible, false)
})

test('summary counts false positives at incident level and does not promote tiny samples', () => {
  const studied = [
    {
      response: { 10000000: { eligible: true, crossed: true } },
      control: { response: { 10000000: { eligible: true, crossed: false } } },
    },
    {
      response: { 10000000: { eligible: true, crossed: false } },
      control: { response: { 10000000: { eligible: true, crossed: false } } },
    },
  ]
  const result = summarize(studied)[10000000]
  assert.equal(result.eligibleEvents, 2)
  assert.equal(result.falsePositiveEvents, 1)
  assert.equal(result.riskDifference, 0.5)
  assert.equal(result.gatePassed, false)
})

test('rolling six-hour baseline is past-only and excludes uncovered gaps', () => {
  const anchor = 20 * 86400
  const rows = [
    { at: anchor - 18 * 3600, cash: 100 },
    { at: anchor - 15 * 3600, cash: 95 },
    { at: anchor - 12 * 3600, cash: 80 },
    { at: anchor - 9 * 3600, cash: 85 },
    { at: anchor - 6 * 3600, cash: 70 },
    { at: anchor - 3 * 3600, cash: 60 },
    { at: anchor + 3 * 3600, cash: 0 },
  ]
  const drops = rollingSixHourDrops(rows, anchor, 1)
  assert.deepEqual(
    drops.map((row) => row.drop),
    [20, 10, 10, 25],
  )
  assert.equal(
    empiricalQuantile(
      drops.map((row) => row.drop),
      0.95,
    ),
    25,
  )
  assert.equal(rollingSixHourDrops([rows[0], rows[2], rows[4]], anchor, 1).length, 0)
})
