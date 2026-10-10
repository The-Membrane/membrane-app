import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySecondary, secondaryQ } from './morpho-v2-size-ladder-first20.mjs'

test('secondary size is 1% of vault assets capped by 10% holder claim', () => {
  assert.equal(secondaryQ({ status: 'baseline-success', totalAssets: '100000', previewRedeemableAssets: '20000' }), 1000n)
  assert.equal(secondaryQ({ status: 'baseline-success', totalAssets: '100000', previewRedeemableAssets: '5000' }), 500n)
  assert.equal(secondaryQ({ status: 'zero-baseline-size' }), 0n)
})

test('preexisting reverts are not counted as new failures', () => {
  const hash = `0x${'a'.repeat(64)}`
  const success = { status: 'success', runtimeCodeHash: hash }
  const revert = { status: 'evm-revert', runtimeCodeHash: hash }
  assert.equal(classifySecondary(revert, revert, hash), 'preexisting-1pct-revert')
  assert.equal(classifySecondary(success, revert, hash), 'new-1pct-revert')
  assert.equal(classifySecondary(success, success, hash), 'success-both')
  assert.equal(classifySecondary(success, { status: 'holder-attrition', runtimeCodeHash: hash }, hash), 'state-or-rpc-censored')
})
