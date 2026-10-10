import assert from 'node:assert/strict'
import test from 'node:test'

import { captureBatch, selectBatch } from './carry-morpho-retrospective-grid-batch.mjs'

const hash = `0x${'a'.repeat(64)}`
const grid = {
  anchors: [{ sourceHash: hash }],
  cells: Array.from({ length: 3 }, (_, routeIndex) => ({
    routeIndex,
    anchorIndex: 0,
    sourceBlock: 100,
    fromBlock: 36,
    toBlock: 99,
  })),
}

test('batch selection is bounded and follows the frozen route order', () => {
  assert.deepEqual(
    selectBatch(grid, { anchorIndex: 0, routeStart: 1, routeCount: 2 }).map(
      (cell) => cell.routeIndex,
    ),
    [1, 2],
  )
  assert.throws(
    () => selectBatch(grid, { anchorIndex: 0, routeStart: 0, routeCount: 7 }),
    /selection_invalid/,
  )
})

test('batch persists serially and refuses a source that differs from the plan', async () => {
  const order = []
  const result = await captureBatch({
    grid,
    cells: grid.cells,
    urls: ['https://one.example', 'https://two.example'],
    exists: async () => false,
    capture: async (cell) => {
      order.push(`capture-${cell.routeIndex}`)
      return {
        source: { primary: { targetHash: hash } },
        sourceAssay: { status: cell.routeIndex === 1 ? 'censored' : 'verified' },
        futureAssay: { status: 'verified' },
      }
    },
    persist: async () => order.push('persist'),
  })
  assert.deepEqual(result, { selected: 3, captured: 3, skippedExisting: 0, censored: 1 })
  assert.deepEqual(order, ['capture-0', 'persist', 'capture-1', 'persist', 'capture-2', 'persist'])
  await assert.rejects(
    captureBatch({
      grid,
      cells: [grid.cells[0]],
      urls: ['https://one.example', 'https://two.example'],
      exists: async () => false,
      capture: async () => ({ source: { primary: { targetHash: 'wrong' } } }),
      persist: async () => assert.fail('must not save mismatched source'),
    }),
    /source_mismatch/,
  )
})
