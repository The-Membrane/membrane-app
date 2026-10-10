import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFollowThrough, selectTreated20 } from './morpho-v2-treated-exit-first20.mjs'

const hash = `0x${'a'.repeat(64)}`
const holder = `0x${'b'.repeat(40)}`

test('the denominator remains 20 independent vaults, including zero-size exclusions', () => {
  const results = Array.from({ length: 20 }, (_, i) => ({
    proposalIndex: i, vault: `0x${String(i + 1).padStart(40, '0')}`,
    block: 100 + i, timestamp: 1_000 + i, preBlock: 99 + i,
    preBlockHash: hash, holder, qAssets: i < 18 ? '10' : '0',
    runtimeCodeHash: hash, status: i < 18 ? 'baseline-success' : 'zero-baseline-size',
  }))
  const stage1 = {
    study: 'morpho-v2-cap-submit-stage1-v1', status: 'complete', coverage: { complete: true },
    summary: { independentEligibleCount: 304, independentEligibleProposalIndexes: results.map((_, i) => i) },
    proposals: results.map((row) => ({ vault: row.vault, block: row.block, executableAts: ['1500', '1800'], classes: ['eligible', 'eligible'] })),
  }
  const baseline = { study: 'morpho-v2-exit-baseline-pilot-v1', status: 'complete', maxVaults: 20, results }
  const selected = selectTreated20(stage1, baseline)
  assert.equal(selected.length, 20)
  assert.equal(selected.filter((row) => row.baselineStatus === 'baseline-success').length, 18)
  assert.equal(selected[0].executableAt, 1500)
  assert.deepEqual(selected[0].coInterventionTimes, [1800])
  assert.throws(() => selectTreated20({ ...stage1, proposals: stage1.proposals.slice(1) }, baseline), /mismatch/)
})

test('fixed-q withdrawal results separate failure from censoring', () => {
  const anchor = { baselineStatus: 'baseline-success', baselineRuntimeHash: hash }
  const good = { status: 'success', runtimeCodeHash: hash }
  assert.equal(classifyFollowThrough(anchor, { preExecutable: good, plus24h: good, plus7d: good }), 'plus24h-success')
  assert.equal(classifyFollowThrough(anchor, { preExecutable: good, plus24h: { status: 'evm-revert', runtimeCodeHash: hash }, plus7d: good }), 'plus24h-revert')
  assert.equal(classifyFollowThrough(anchor, { preExecutable: good, plus24h: { status: 'holder-attrition', runtimeCodeHash: hash }, plus7d: good }), 'holder-censored')
  assert.equal(classifyFollowThrough(anchor, { preExecutable: good, plus24h: { status: 'success', runtimeCodeHash: `0x${'c'.repeat(64)}` }, plus7d: good }), 'code-or-probe-censored')
  assert.equal(classifyFollowThrough(anchor, { preExecutable: good, plus24h: good, plus7d: { status: 'head-censored' } }), 'plus24h-success')
  assert.equal(classifyFollowThrough(anchor, { preExecutable: good, plus24h: { status: 'head-censored' }, plus7d: good }), 'head-censored')
})
