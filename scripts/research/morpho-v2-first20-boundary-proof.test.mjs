import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyBoundary } from './morpho-v2-first20-boundary-proof.mjs'

const hash = `0x${'a'.repeat(64)}`
const selected = { block: 120, timestamp: 1_100, hash }
const probe = { status: 'success', ...selected }
const head = { block: 26_052_740, timestamp: 2_000, hash }

test('post-executable boundary needs exact first block and predecessor', () => {
  const args = { key: 'plus24h', target: 1_095, anchorBlock: 100, probe, selected,
    adjacent: { block: 119, timestamp: 1_090, hash }, head }
  assert.doesNotThrow(() => verifyBoundary(args))
  assert.throws(() => verifyBoundary({ ...args, adjacent: { ...args.adjacent, timestamp: 1_095 } }), /boundary mismatch/)
  assert.throws(() => verifyBoundary({ ...args, selected: { ...selected, hash: `0x${'b'.repeat(64)}` } }), /header mismatch/)
})

test('pre-executable boundary needs last prior block and successor', () => {
  const args = { key: 'preExecutable', target: 1_105, anchorBlock: 100, probe, selected,
    adjacent: { block: 121, timestamp: 1_105, hash }, head }
  assert.doesNotThrow(() => verifyBoundary(args))
  assert.throws(() => verifyBoundary({ ...args, adjacent: { ...args.adjacent, timestamp: 1_104 } }), /boundary mismatch/)
})

test('head censor requires the target to be beyond the pinned head', () => {
  const args = { key: 'plus7d', target: 2_001, anchorBlock: 100,
    probe: { status: 'head-censored' }, selected: null, adjacent: null, head }
  assert.doesNotThrow(() => verifyBoundary(args))
  assert.throws(() => verifyBoundary({ ...args, target: 2_000 }), /False head censor/)
})
