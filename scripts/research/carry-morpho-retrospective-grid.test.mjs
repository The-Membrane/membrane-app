import assert from 'node:assert/strict'
import test from 'node:test'

import { BOARD_ROUTES } from './carry-local-morpho-holder-v2.mjs'
import { buildGrid, validateGrid } from './carry-morpho-retrospective-grid.mjs'

const manifest = {
  sha256: 'fixture-manifest',
  subjects: [
    ...BOARD_ROUTES.map((route) => ({
      route_key: route.routeKey,
      destination: route.destination,
      asset: route.asset,
    })),
    ...Array.from({ length: 67 - BOARD_ROUTES.length }, (_, index) => ({
      route_key: `other-${index}`,
      destination: `0x${String(index + 1).padStart(40, '0')}`,
      asset: `0x${String(index + 101).padStart(40, '0')}`,
    })),
  ],
}
const start = Date.parse('2026-06-01T00:00:00.000Z')
const observations = Array.from({ length: 120 }, (_, index) => {
  const anchorAt = new Date(start + index * 86_400_000).toISOString()
  return {
    collectionMode: 'retrospective',
    anchorAt,
    receiptSha256: 'a'.repeat(64),
    source: {
      block: String(25_000_000 + index * 7_200),
      blockHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      blockAt: new Date(Date.parse(anchorAt) - 12_000).toISOString(),
    },
  }
})

test('grid fixes all Morpho subjects and windows before any future outcome', () => {
  const grid = buildGrid({ manifest, observations })
  assert.equal(grid.anchors.length, 12)
  assert.equal(grid.cells.length, BOARD_ROUTES.length * 12)
  assert.equal(grid.anchors[0].anchorAt, observations[0].anchorAt)
  assert.equal(grid.anchors[1].anchorAt, observations[10].anchorAt)
  assert.equal(grid.cells[0].fromBlock, grid.cells[0].sourceBlock - 64)
  assert.equal(grid.cells[0].toBlock, grid.cells[0].sourceBlock - 1)
  assert.equal(grid.forecastValidated, false)
  assert.equal(validateGrid(grid, grid), grid)
  assert.throws(() => validateGrid({ ...grid, cells: grid.cells.slice(1) }, grid), /seal_invalid/)
})

test('grid refuses a missing historical day or a source later than its anchor', () => {
  const gap = structuredClone(observations)
  gap[42].anchorAt = gap[41].anchorAt
  assert.throws(() => buildGrid({ manifest, observations: gap }), /daily_anchors_invalid/)
  const late = structuredClone(observations)
  late[10].source.blockAt = new Date(Date.parse(late[10].anchorAt) + 12_000).toISOString()
  assert.throws(() => buildGrid({ manifest, observations: late }), /anchor_invalid/)
})
