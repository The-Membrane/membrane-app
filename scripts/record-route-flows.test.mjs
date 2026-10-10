import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadConfig } from './lib/venue-reads.mjs'
import { recordRouteVenue } from './record-route-flows.mjs'

const HASH = `0x${'a'.repeat(64)}`
const venue = loadConfig().find((item) => item.name === 'sUSDe')

test('a bounded route pass seals its cursor and the next pass resumes through the head', async () => {
  const receipts = []
  const calls = []
  const store = {
    read: () => receipts,
    append: (_venue, receipt) => receipts.push(receipt),
  }
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockTag }) =>
      blockTag === 'finalized'
        ? { number: 650n, timestamp: 1_790_000_000n, hash: HASH }
        : { hash: HASH },
  }
  const collectRange = async ({ from, to }) => {
    calls.push([from, to])
    return { toBlock: String(to), end: { hash: HASH }, events: [], before: [], after: [] }
  }
  const first = await recordRouteVenue({
    client,
    store,
    venue,
    fromBlock: 1n,
    chunk: 200n,
    maxRanges: 2n,
    collectRange,
  })
  assert.deepEqual(first, { ranges: 2, events: 0, caughtUp: false })
  const second = await recordRouteVenue({
    client,
    store,
    venue,
    chunk: 200n,
    maxRanges: 2n,
    collectRange,
  })
  assert.deepEqual(second, { ranges: 2, events: 0, caughtUp: true })
  assert.deepEqual(calls, [
    [1n, 200n],
    [201n, 400n],
    [401n, 600n],
    [601n, 650n],
  ])
})

test('rejects invalid per-venue range caps before reading a provider', async () => {
  for (const maxRanges of [0n, 1001n, 2]) {
    await assert.rejects(
      recordRouteVenue({ client: {}, store: {}, venue, maxRanges }),
      /route_flow_invalid_max_ranges/,
    )
  }
})
