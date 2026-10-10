import assert from 'node:assert/strict'
import test from 'node:test'

import {
  summarize,
  summarizeElapsedPriceGate,
  ticketAt,
  validateSnapshotRow,
} from './saturn-queue-pending-current.mjs'

const HOLDER = '0x1111111111111111111111111111111111111111'
const block = { hash: `0x${'a'.repeat(64)}` }
const original = {
  ticketId: '1669',
  sharesRaw: '1000000000000000000',
  requestTimestamp: '1000',
  holder: HOLDER,
}

test('requested ticket compares net per-share quote to its stored minimum', async () => {
  const calls = []
  const entry = {
    client: {
      readContract: async ({ functionName }) => {
        calls.push(functionName)
        if (functionName === 'requests')
          return [1000000000000000000n, 0n, 1000n, 1100000000000000000n, 1]
        if (functionName === 'ownerOf') return HOLDER
        if (functionName === 'previewRedeem') return 1000000000000000000n
        throw Error('unexpected_call')
      },
    },
  }
  const row = await ticketAt(entry, block, original)
  assert.equal(row.status, 1)
  assert.equal(row.belowMin, true)
  assert.doesNotThrow(() => validateSnapshotRow(row, original, original.requestTimestamp))
  assert.throws(
    () => validateSnapshotRow({ ...row, belowMin: false }, original, original.requestTimestamp),
    /saturn_current_ticket_mismatch/,
  )
  assert.deepEqual(calls, ['requests', 'ownerOf', 'previewRedeem'])
  assert.deepEqual(summarize([row]), {
    cohort: 1,
    stillRequested: 1,
    noLongerRequested: 0,
    requestedPriceGated: 1,
    requestedQuoteEligible: 0,
    requestedHolderChanged: 0,
  })
})

test('cleared ticket is not mistaken for a live price gate', async () => {
  const calls = []
  const entry = {
    client: {
      readContract: async ({ functionName }) => {
        calls.push(functionName)
        return [0n, 0n, 0n, 0n, 0]
      },
    },
  }
  const row = await ticketAt(entry, block, original)
  assert.equal(row.belowMin, null)
  assert.doesNotThrow(() => validateSnapshotRow(row, original, original.requestTimestamp))
  assert.deepEqual(calls, ['requests'])
  assert.equal(summarize([row]).noLongerRequested, 1)
  assert.throws(
    () => validateSnapshotRow({ ...row, status: 6 }, original, original.requestTimestamp),
    /saturn_current_ticket_mismatch/,
  )
  await assert.rejects(
    ticketAt(
      {
        client: {
          readContract: async () => [0n, 0n, 0n, 0n, 6],
        },
      },
      block,
      original,
    ),
    /saturn_current_ticket_identity_changed/,
  )
})

test('elapsed price-gate wait is right-censored at the verified block time', () => {
  const rows = [1000, 2000, 5000, 6000].map((timestamp) => ({
    status: 1,
    belowMin: true,
    requestTimestamp: String(timestamp),
  }))
  assert.deepEqual(summarizeElapsedPriceGate(rows, 608800), {
    medianElapsedSeconds: 605300,
    atLeastSevenDays: 2,
  })
  assert.deepEqual(summarizeElapsedPriceGate([], 608800), {
    medianElapsedSeconds: null,
    atLeastSevenDays: 0,
  })
  assert.throws(
    () => summarizeElapsedPriceGate([{ ...rows[0], requestTimestamp: '608801' }], 608800),
    /saturn_current_request_time_invalid/,
  )
})
