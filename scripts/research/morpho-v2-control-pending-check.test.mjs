import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPending, selectChecks } from './morpho-v2-control-pending-check.mjs'

test('expired but unaccepted proposals remain pending', () => {
  assert.equal(classifyPending(0n, 100), 'settled')
  assert.equal(classifyPending(99n, 100), 'pending-executable')
  assert.equal(classifyPending(100n, 100), 'pending-executable')
  assert.equal(classifyPending(101n, 100), 'pending-timelocked')
})

test('eight checks are selected solely from the frozen four control risk sets', () => {
  const controls = Array.from({ length: 4 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`)
  const hash = `0x${'a'.repeat(64)}`
  const treated = [0, 1].map((i) => ({
    anchor: { anchorBlock: 101 + i },
    controls: controls.slice(i * 2, i * 2 + 2).map((vault) => ({ vault, preBlock: 100 + i, preBlockHash: hash })),
  }))
  const rawEvents = controls.flatMap((vault) => [10, 11].map((block) => ({
    vault, block, txHash: hash, logIndex: block, data: `0x${String(block).padStart(2, '0')}`,
  })))
  const checks = selectChecks({ status: 'complete', rawEvents }, { status: 'complete', treated })
  assert.equal(checks.length, 8)
  assert.deepEqual(checks.map((row) => row.controlVault), controls.flatMap((vault) => [vault, vault]))
  assert.throws(() => selectChecks({ status: 'complete', rawEvents: rawEvents.slice(1) }, { status: 'complete', treated }), /two prior/)
})
