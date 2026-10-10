import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blocks,
  coverage,
  EXPECTED,
  GRID,
  MAX_GAP_SECONDS,
  mergeCached,
  validRow,
} from './aave-cash-full-grid-collector.mjs'

function row(block, at = block * 12) {
  return {
    block,
    at,
    cash: 1,
    debt: 2,
    liquidityRatePct: 3,
    borrowRatePct: 4,
    active: true,
    frozen: false,
    paused: false,
  }
}

test('fixed grid has 3,137 aligned blocks and both endpoints', () => {
  const grid = blocks()
  assert.equal(EXPECTED, 3137)
  assert.equal(grid[0], GRID.first)
  assert.equal(grid.at(-1), GRID.last)
  assert.equal(grid[1] - grid[0], 900)
})

test('coverage fails closed on any hole, bad row or long timestamp gap', () => {
  const full = blocks().map((block, i) => row(block, 1_700_000_000 + i * 1_200))
  assert.equal(coverage(full).complete, true)
  assert.equal(coverage(full).maxGapSeconds, 1200)
  assert.equal(coverage(full.slice(1)).complete, false)
  assert.equal(coverage(full.filter((_, i) => i !== 100)).missing, 1)
  const gap = full.map((value) => ({ ...value }))
  for (let i = 100; i < gap.length; i++) gap[i].at += MAX_GAP_SECONDS + 1
  assert.equal(coverage(gap).complete, false)
  assert.equal(validRow({ ...full[0], cash: -1 }), false)
  assert.throws(() => coverage([...full, full[0]]), /duplicate/)
})

test('verified cached rows are reused once and conflicting exact blocks abort', () => {
  const a = row(GRID.first)
  const b = row(GRID.first + GRID.step)
  const merged = mergeCached(
    [],
    [
      { name: 'dense', rows: [a, b] },
      { name: 'sparse', rows: [a] },
    ],
  )
  assert.equal(merged.rows.length, 2)
  assert.deepEqual(merged.provenance, { dense: 2, sparse: 0 })
  assert.equal(merged.rows[0].source, 'dense')
  assert.throws(
    () =>
      mergeCached(
        [],
        [
          { name: 'dense', rows: [a] },
          { name: 'sparse', rows: [{ ...a, cash: 5 }] },
        ],
      ),
    /Conflicting exact-block/,
  )
})
