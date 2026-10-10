import assert from 'node:assert/strict'
import test from 'node:test'
import {
  blockGrid,
  COLLECTION,
  collectionStatus,
  coverageFor,
  selectWindows,
} from './aave-freeze-window-collector-logic.mjs'

const incident = (at, block, eligible = true) => ({
  at,
  block,
  response: { [COLLECTION.targetCashUsd]: { eligible } },
  control: { at: at - 7 * 86400, block: block - 50_400 },
})

test('selection takes exactly the three non-April eligible incidents and original controls', () => {
  const study = {
    status: 'complete',
    incidents: [
      incident(100, 300_000),
      incident(200, 400_000),
      incident(300, 500_000),
      incident(400, 600_000),
      incident(500, 700_000, false),
    ],
  }
  const windows = selectWindows(study, { excludeAt: 300 })
  assert.equal(windows.length, 6)
  assert.deepEqual(
    windows.map((w) => w.kind),
    ['incident', 'control', 'incident', 'control', 'incident', 'control'],
  )
  assert.deepEqual(
    windows.filter((w) => w.kind === 'incident').map((w) => w.incidentAt),
    [100, 200, 400],
  )
  assert.throws(() => selectWindows(study, { excludeAt: 999 }), /three non-April/)
})

test('grid is fixed 14d pre and 6h post at 900 blocks', () => {
  const grid = blockGrid(300_000)
  assert.equal(grid.length, 115)
  assert.equal(grid[0], 199_200)
  assert.equal(grid[112], 300_000)
  assert.equal(grid.at(-1), 301_800)
})

test('coverage rejects a failed read, large gap, and insufficient endpoint reach', () => {
  const window = { anchorAt: 2_000_000, anchorBlock: 300_000 }
  const grid = blockGrid(window.anchorBlock)
  const rows = grid.map((block, i) => ({
    block,
    at: window.anchorAt + (i - 112) * 3 * 3600,
    cash: 1,
    status: 'ok',
  }))
  assert.equal(coverageFor(window, rows).complete, true)
  rows[10] = { block: grid[10], status: 'failed', error: 'RPC' }
  assert.equal(coverageFor(window, rows).complete, false)
  assert.equal(coverageFor(window, rows).failed, 1)
  rows[10] = { block: grid[10], at: window.anchorAt + (10 - 112) * 3 * 3600, status: 'ok', cash: 1 }
  rows[0].at += 7200
  assert.equal(coverageFor(window, rows).complete, false)
})

test('collection cannot publish complete when any window has a read failure or coverage miss', () => {
  const good = Array.from({ length: 6 }, () => ({ coverage: { complete: true } }))
  assert.equal(collectionStatus(good), 'complete')
  assert.equal(collectionStatus(good.slice(1)), 'partial')
  good[3].coverage.complete = false
  assert.equal(collectionStatus(good), 'partial')
})
