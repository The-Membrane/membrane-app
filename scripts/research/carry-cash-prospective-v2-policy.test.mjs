import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CASH_V2_POLICY,
  decimalCashToRaw,
  disjointH24Deltas,
  freezeCashV2Parameters,
  projectCashV2,
  readPinnedDevelopmentSources,
} from './carry-cash-prospective-v2-policy.mjs'

test('pins both exact subject development histories and disjoint H24 pairs', () => {
  const sources = readPinnedDevelopmentSources()
  assert.deepEqual(
    sources.map((row) => [row.subjectId, row.count, row.parameters.pairCount]),
    [
      ['aave_usde', 3137, 348],
      ['sgho', 1183, 131],
    ],
  )
  assert.deepEqual(
    sources.map((row) => row.subjectId),
    CASH_V2_POLICY.subjects.map((row) => row.id),
  )
  for (const source of sources) {
    assert.match(source.physicalSha256, /^[0-9a-f]{64}$/)
    assert.match(source.contentSha256, /^[0-9a-f]{64}$/)
    assert.ok(Date.parse(source.parameters.lastPairTargetAtUtc) <= Date.parse(source.throughUtc))
  }
})

test('converts saved numeric cash by decimal string with deterministic half-up rounding', () => {
  assert.equal(decimalCashToRaw(1), '1000000000000000000')
  assert.equal(decimalCashToRaw(1.5e-18), '2')
  assert.equal(decimalCashToRaw(1e-8), '10000000000')
  assert.throws(() => decimalCashToRaw(-1), /development_number_invalid/)
})

test('keeps pair labels disjoint, fixes parameters, and clamps uint256 projections', () => {
  const points = Array.from({ length: 120 }, (_, index) => ({
    at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 86_400_000).toISOString(),
    cashRaw: String(1000 + index * 10),
  }))
  const pairs = disjointH24Deltas(points)
  assert.equal(pairs.length, 60)
  const parameters = freezeCashV2Parameters(points)
  assert.equal(parameters.medianDeltaRaw, '10')
  assert.deepEqual(projectCashV2('100', parameters), {
    pointRaw: '110',
    lowRaw: '110',
    highRaw: '110',
    persistenceRaw: '100',
  })
  assert.throws(() => disjointH24Deltas(points.toReversed()), /development_order/)
  assert.deepEqual(
    projectCashV2('0', {
      medianDeltaRaw: '-10',
      p10DeltaRaw: '-20',
      p90DeltaRaw: '5',
    }),
    { pointRaw: '0', lowRaw: '0', highRaw: '5', persistenceRaw: '0' },
  )
})
