import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  historicalProcessingWithin24h,
  validateProcessingWithin24h,
} from './holder-exit-processing-bounds.mjs'

const processed = (ticketId, waitSeconds) => ({
  ticketId,
  waitSeconds,
  waitCensored: false,
  status: 'processed_unclaimed',
  processedBlock: 100,
})
const pending = (ticketId, waitSeconds) => ({
  ticketId,
  waitSeconds,
  waitCensored: true,
  status: 'pending_at_cutoff',
  processedBlock: null,
})
const cohort = (episodes) => ({
  episodes,
  summary: {
    counts: {
      requested: episodes.length,
      processed: episodes.filter((row) => !row.waitCensored).length,
      pendingCensored: episodes.filter((row) => row.waitCensored).length,
    },
  },
})

test('24h ties count processed; censors at exactly horizon are already known unprocessed', () => {
  const result = historicalProcessingWithin24h(
    cohort([
      processed('1', 0),
      processed('2', 86_400),
      processed('3', 86_401),
      pending('4', 86_399),
      pending('5', 86_400),
      pending('6', 86_401),
    ]),
  )
  assert.deepEqual(result, {
    horizonSeconds: 86_400,
    confirmedProcessed: 2,
    possibleProcessed: 3,
    censoredBeforeHorizon: 1,
  })
  assert.equal(
    validateProcessingWithin24h(result, { requests: 6, processed: 3, pendingCensored: 3 }),
    result,
  )
})

test('all early censors may process by horizon, but none are counted as observed', () => {
  assert.deepEqual(historicalProcessingWithin24h(cohort([pending('1', 1), pending('2', 100)])), {
    horizonSeconds: 86_400,
    confirmedProcessed: 0,
    possibleProcessed: 2,
    censoredBeforeHorizon: 2,
  })
})

test('rejects duplicate tickets, inconsistent process/censor status and summary', () => {
  assert.throws(
    () => historicalProcessingWithin24h(cohort([processed('1', 3), pending('1', 4)])),
    /input_invalid/,
  )
  assert.throws(
    () => historicalProcessingWithin24h(cohort([{ ...pending('1', 4), status: 'claimed' }])),
    /input_invalid/,
  )
  assert.throws(
    () =>
      historicalProcessingWithin24h({
        ...cohort([processed('1', 3)]),
        summary: {
          counts: {
            requested: 1,
            processed: 0,
            pendingCensored: 1,
          },
        },
      }),
    /input_invalid/,
  )
})

test('bounds shape and arithmetic cannot be widened or relabeled', () => {
  const counts = { requests: 146, processed: 106, pendingCensored: 40 }
  const value = {
    horizonSeconds: 86_400,
    confirmedProcessed: 50,
    possibleProcessed: 60,
    censoredBeforeHorizon: 10,
  }
  assert.equal(validateProcessingWithin24h(value, counts), value)
  assert.throws(
    () => validateProcessingWithin24h({ ...value, horizonSeconds: 86_401 }, counts),
    /input_invalid/,
  )
  assert.throws(
    () => validateProcessingWithin24h({ ...value, possibleProcessed: 61 }, counts),
    /input_invalid/,
  )
  assert.throws(
    () => validateProcessingWithin24h({ ...value, forecastValidated: true }, counts),
    /input_invalid/,
  )
  assert.throws(
    () =>
      validateProcessingWithin24h(
        { ...value, censoredBeforeHorizon: 41, possibleProcessed: 91 },
        counts,
      ),
    /input_invalid/,
  )
})
