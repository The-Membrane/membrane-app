import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolve } from 'node:path'
import { PANIC_SELECTOR, selectIncidents, summarizeTrace } from './morpho-v2-route-exit-panic-drilldown.mjs'

const baseline = JSON.parse(readFileSync(resolve('data/research/venue-signals/morpho-v2-route-exit-baseline-first20.json')))
const followthrough = JSON.parse(readFileSync(resolve('data/research/venue-signals/morpho-v2-route-exit-followthrough-first20.json')))

test('selection is exactly the two frozen baseline-success B panic rows with event coordinates', () => {
  const selected = selectIncidents(baseline, followthrough)
  assert.deepEqual(selected.map((x) => x.index), [15, 18])
  for (const row of selected) {
    const anchor = baseline.anchors[row.index]
    assert.equal(row.txHash, anchor.txHash)
    assert.equal(row.transactionIndex, anchor.transactionIndex)
    assert.equal(row.logIndex, anchor.logIndex)
    assert.equal(followthrough.results.find((x) => x.index === row.index).errorSelector, PANIC_SELECTOR)
  }
})

test('selection fails closed if a frozen outcome changes', () => {
  const changed = structuredClone(followthrough)
  changed.results[2].status = 'b-success'
  assert.throws(() => selectIncidents(baseline, changed), /pair changed/)
})

test('trace keeps full Panic output/code and bounded deepest path, not input payloads', () => {
  const output = `${PANIC_SELECTOR}${'0'.repeat(63)}1`
  const trace = summarizeTrace({ type: 'CALL', from: baseline.results[15].holder,
    to: baseline.results[15].vault, input: `0x2e1a7d4d${'ab'.repeat(400)}`,
    error: 'execution reverted', calls: [{ type: 'CALL',
      from: baseline.results[15].vault, to: followthrough.results[2].adapter,
      input: '0x12345678', error: 'execution reverted', output }] })
  assert.equal(trace.nodes, 2)
  assert.equal(trace.panicOutput, output)
  assert.equal(trace.panicCode, '1')
  assert.equal(trace.failurePath.length, 2)
  assert.equal(trace.failurePath[0].inputSelector, '0x2e1a7d4d')
  assert.equal(JSON.stringify(trace).includes('ab'.repeat(20)), false)
})

test('trace complexity is capped', () => {
  let root = { type: 'CALL', calls: [] }, cursor = root
  for (let i = 0; i < 50; i++) {
    const child = { type: 'CALL', calls: [] }
    cursor.calls.push(child)
    cursor = child
  }
  assert.throws(() => summarizeTrace(root), /complexity cap/)
})
