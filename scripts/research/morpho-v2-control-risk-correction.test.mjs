import assert from 'node:assert/strict'
import test from 'node:test'
import { eventKey } from './morpho-v2-cap-lifecycle-census.mjs'
import { classifyPrior } from './morpho-v2-control-risk-correction.mjs'

const ANCHOR = 1_000_000
const prior = {
  vault: '0x1111111111111111111111111111111111111111',
  selector: '0xf6f98fd5',
  data: '0xf6f98fd500',
  timestamp: ANCHOR - 8 * 86_400,
  executableAt: ANCHOR - 1,
}
const state = (pending, ambiguous = false) =>
  new Map([[eventKey(prior), { pending, ambiguous, cycles: 1 }]])

test('an overdue but still-pending proposal is not a clean control', () => {
  assert.equal(classifyPrior([prior], state(true), ANCHOR), 'new-only')
})

test('a future-dated but settled proposal is not still pending', () => {
  assert.equal(
    classifyPrior([{ ...prior, executableAt: ANCHOR + 100 }], state(false), ANCHOR),
    'old-only',
  )
})

test('seven-day exclusion precedes pending state; missing state fails closed', () => {
  assert.equal(
    classifyPrior([{ ...prior, timestamp: ANCHOR - 86_400 }], state(false), ANCHOR),
    'recent-submit',
  )
  assert.equal(classifyPrior([prior], new Map(), ANCHOR), 'ambiguous')
  assert.equal(classifyPrior([prior], state(true, true), ANCHOR), 'ambiguous')
  assert.equal(classifyPrior([], new Map(), ANCHOR), 'neither')
})
