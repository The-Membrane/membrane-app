import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SKY_RUNWAY_PROTOCOL,
  evaluateRunway,
  makeRunwayRows,
  wilsonLower95,
} from './sky-litepsm-runway-logic.mjs'

const HOUR = 3600
const fixtureProtocol = { ...SKY_RUNWAY_PROTOCOL, positionUsdc: 100_000_000 }
const sample = (hour, pocketUsdc = 300_000_000) => ({
  block: 1000 + hour * 300,
  at: 1_700_000_000 + hour * HOUR,
  pocketUsdc,
  toutRaw: '0',
})

test('features exclude future transfers and preserve gross consumption despite replenishment', () => {
  const samples = [sample(0), sample(3), sample(6)]
  const transfers = [
    { block: sample(3).block - 1, at: sample(3).at - 1, usdc: 60_000_000, direction: 'out' },
    { block: sample(3).block - 1, at: sample(3).at - 1, usdc: 40_000_000, direction: 'in' },
    { block: sample(6).block, at: sample(6).at, usdc: 20_000_000, direction: 'out' },
  ]
  const rows = makeRunwayRows(samples, transfers, fixtureProtocol)
  assert.equal(rows[1].grossOut6h, 60_000_000)
  assert.equal(rows[1].netOut24h, 20_000_000)
  assert.equal(rows[1].runway6h, 20)
  assert.equal(rows[1].signal6h, true)
  assert.equal(rows[1].grossOut24h, 60_000_000)
  assert.equal(rows[2].grossOut6h, 80_000_000)
})

test('crossing windows are one independent event, not many adjacent positive samples', () => {
  const samples = Array.from({ length: 13 }, (_, index) =>
    sample(index * 3, index < 8 ? 300_000_000 : 90_000_000),
  )
  const rows = makeRunwayRows(samples, [], fixtureProtocol)
  const result = evaluateRunway(rows, { ...fixtureProtocol, trainFraction: 0.2 })
  assert.equal(result.independentEvents, 1)
  assert.ok(result.eligibleWindows > result.independentEvents)
  assert.equal(result.gate.passed, false)
})

test('gaps larger than four hours censor windows rather than inventing a target', () => {
  const samples = [0, 3, 6, 15, 18, 21, 24, 27, 30].map((hour) =>
    sample(hour, hour < 24 ? 300_000_000 : 90_000_000),
  )
  const result = evaluateRunway(makeRunwayRows(samples, [], fixtureProtocol), fixtureProtocol)
  assert.equal(result.eligibleWindows, 0)
  assert.equal(result.independentEvents, 0)
})

test('Wilson bound is zero for insufficient evidence, below observed rate otherwise', () => {
  assert.equal(wilsonLower95(0, 0), 0)
  assert.ok(wilsonLower95(7, 10) < 0.7)
  assert.ok(wilsonLower95(7, 10) > 0)
})

test('no cash crossing cannot pass promotion gate even with historical outflow flags', () => {
  const samples = Array.from({ length: 40 }, (_, index) => sample(index * 3, 300_000_000))
  const transfers = samples.flatMap((row, index) =>
    index === 0
      ? []
      : [
          {
            block: row.block,
            at: row.at,
            usdc: 70_000_000,
            direction: 'out',
          },
        ],
  )
  const rows = makeRunwayRows(samples, transfers, fixtureProtocol)
  const result = evaluateRunway(rows, fixtureProtocol)
  assert.equal(result.independentEvents, 0)
  assert.equal(result.gate.passed, false)
  assert.equal(result.gate.enoughEvents, false)
  assert.ok(result.holdoutAlerts > 0)
})
