import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CARRY_ROUTE_CADENCE_MS,
  dueCarryRouteKinds,
  HOLDER_ROUTE_KEY,
  SPREAD_ROUTE_KEY,
} from './carry-route-cadence.mjs'

const NOW = Date.parse('2026-09-26T12:00:00.000Z')
const recorded = (kind, ageMs) => ({
  kind,
  route_key: kind === 'holder_stock' ? HOLDER_ROUTE_KEY : SPREAD_ROUTE_KEY,
  recorded_at: new Date(NOW - ageMs).toISOString(),
})

test('both route readings are due before any successful record', () => {
  assert.deepEqual(dueCarryRouteKinds([], NOW), { holder_stock: true, spread: true })
})

test('a successful reading is skipped until the 24-hour boundary', () => {
  assert.deepEqual(
    dueCarryRouteKinds(
      [recorded('holder_stock', CARRY_ROUTE_CADENCE_MS - 1), recorded('spread', 0)],
      NOW,
    ),
    { holder_stock: false, spread: false },
  )
  assert.deepEqual(dueCarryRouteKinds([recorded('holder_stock', CARRY_ROUTE_CADENCE_MS)], NOW), {
    holder_stock: true,
    spread: true,
  })
})

test('each leg is scheduled independently after partial failure', () => {
  assert.deepEqual(dueCarryRouteKinds([recorded('spread', 0)], NOW), {
    holder_stock: true,
    spread: false,
  })
  assert.deepEqual(dueCarryRouteKinds([recorded('holder_stock', 0)], NOW), {
    holder_stock: false,
    spread: true,
  })
})

test('holder and spread have different stored keys; a wrong-key row cannot suppress either leg', () => {
  assert.notEqual(HOLDER_ROUTE_KEY, SPREAD_ROUTE_KEY)
  assert.deepEqual(
    dueCarryRouteKinds(
      [
        { ...recorded('holder_stock', 0), route_key: SPREAD_ROUTE_KEY },
        { ...recorded('spread', 0), route_key: HOLDER_ROUTE_KEY },
      ],
      NOW,
    ),
    { holder_stock: true, spread: true },
  )
  assert.deepEqual(dueCarryRouteKinds([recorded('holder_stock', 0), recorded('spread', 0)], NOW), {
    holder_stock: false,
    spread: false,
  })
})

test('invalid timestamps cannot indefinitely suppress collection', () => {
  assert.deepEqual(
    dueCarryRouteKinds([{ ...recorded('holder_stock', 0), recorded_at: 'bad' }], NOW),
    {
      holder_stock: true,
      spread: true,
    },
  )
})
