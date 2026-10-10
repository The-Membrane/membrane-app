import assert from 'node:assert/strict'
import test from 'node:test'

import { auditGrid } from './carry-morpho-retrospective-grid-audit.mjs'

const anchor = {
  sourceBlock: 100,
  sourceHash: '0x' + 'a'.repeat(64),
  sourceAt: '2026-01-01T00:00:00.000Z',
}
const cell = {
  routeIndex: 1,
  routeKey: 'route',
  destination: 'vault',
  asset: 'asset',
  anchorIndex: 0,
  sourceBlock: 100,
  fromBlock: 36,
  toBlock: 99,
}
const grid = { sha256: 'seal', anchors: [anchor], cells: [cell] }
const record = {
  ...cell,
  source: { primary: { targetHash: anchor.sourceHash, targetBlockAt: anchor.sourceAt } },
}
const injected = { validate: () => {}, classify: () => 'q_entitlement_below_frozen_amount' }

test('grid audit keeps handpicked windows outside the predeclared denominator', () => {
  const result = auditGrid(grid, [record, { ...record, sourceBlock: 101 }], injected)
  assert.equal(result.plannedCells, 1)
  assert.equal(result.capturedGridCells, 1)
  assert.equal(result.handpickedDemonstrations, 1)
  assert.equal(result.byRoute[0].transitions.q_entitlement_below_frozen_amount, 1)
  assert.equal(result.forecastValidated, false)
})

test('grid audit refuses a source hash that differs from the frozen anchor', () => {
  assert.throws(
    () =>
      auditGrid(
        grid,
        [{ ...record, source: { primary: { ...record.source.primary, targetHash: 'wrong' } } }],
        injected,
      ),
    /pair_mismatch/,
  )
})

test('grid audit reports why a predeclared cell was censored', () => {
  const result = auditGrid(
    grid,
    [{ ...record, sourceAssay: { status: 'censored', reason: 'vault_not_deployed' } }],
    { validate: () => {}, classify: () => 'censored' },
  )
  assert.deepEqual(result.transitions, { censored: 1 })
  assert.deepEqual(result.censorReasons, { vault_not_deployed: 1 })
})
