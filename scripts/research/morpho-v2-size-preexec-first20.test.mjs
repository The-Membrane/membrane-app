import assert from 'node:assert/strict'
import test from 'node:test'
import { onset } from './morpho-v2-size-preexec-first20.mjs'

test('secondary-size failure timing distinguishes preexisting, pre-executable, and later onset', () => {
  const row = (a, b) => ({ qAssets: '100', baselineProbe: { status: a }, plus24hProbe: { status: b } })
  assert.equal(onset(row('success', 'evm-revert'), { status: 'evm-revert' }), 'pre-executable-onset')
  assert.equal(onset(row('success', 'evm-revert'), { status: 'success' }), 'post-executable-onset')
  assert.equal(onset(row('evm-revert', 'success'), { status: 'success' }), 'preexisting')
  assert.equal(onset(row('success', 'success'), { status: 'success' }), 'success-through-plus24h')
  assert.equal(onset(row('success', 'holder-attrition'), { status: 'success' }), 'state-or-rpc-censored')
  assert.equal(onset({ qAssets: '0' }, null), 'baseline-excluded')
})
