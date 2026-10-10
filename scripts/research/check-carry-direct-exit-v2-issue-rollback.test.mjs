import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDirectRollbackPlan } from './check-carry-direct-exit-v2-issue-rollback.mjs'

const route = {
  kind: 'spark',
  routeKey: 'USDT → supply on Spark',
  destination: `0x${'1'.repeat(40)}`,
  asset: `0x${'2'.repeat(40)}`,
}
const baseline = {
  assetDecimals: 6,
  targetBlock: '123',
  targetHash: `0x${'3'.repeat(64)}`,
  targetBlockAt: '2026-09-30T00:00:00.000Z',
  targetObservedAt: '2026-09-30T00:01:00.000Z',
  canonicalityEvidenceDoc: { schema: 'test' },
}
const candidate = {
  holder: `0x${'4'.repeat(40)}`,
  evidenceDoc: {
    selectedHolderCommitment: 'fixture',
    ladder: {
      labels: [
        { label: 'holder', assetsRaw: '100', reason: null },
        { label: 'duplicate', assetsRaw: null, reason: 'duplicate_q', duplicateOf: 'holder' },
        { label: 'market', assetsRaw: '1000', reason: null },
      ],
    },
  },
}
const cases = [
  { assetsRaw: '100', baselineStatus: 'success' },
  { assetsRaw: '1000', baselineStatus: 'ineligible' },
]
const input = {
  route,
  baseline,
  candidate,
  slotAt: '2026-09-30T00:10:00.000Z',
  candidateDigest: 'a'.repeat(64),
  cases,
}

test('direct rollback plan preserves frozen Q order, unavailable labels and success', () => {
  const plan = buildDirectRollbackPlan(input)
  assert.deepEqual(plan.horizons, [1, 4, 24, 48, 168])
  assert.equal(plan.candidateProvenance, 'receipt_verified_transfer')
  assert.equal(plan.cases, cases)
  assert.deepEqual(plan.omittedLadder, [
    { label: 'duplicate', reason: 'duplicate_q', duplicateOf: 'holder' },
  ])
  assert.equal(plan.baselineHash, baseline.targetHash)
  assert.equal(plan.candidateEvidenceDoc, candidate.evidenceDoc)
})

test('Compound route uses receipt-verified Supply provenance', () => {
  const plan = buildDirectRollbackPlan({ ...input, route: { ...route, kind: 'comet' } })
  assert.equal(plan.candidateProvenance, 'receipt_verified_supply')
})

test('gate cannot issue a holderless, Q-mutated or no-success plan', () => {
  assert.throws(
    () => buildDirectRollbackPlan({ ...input, candidate: { ...candidate, holder: null } }),
    /candidate_not_issuable/,
  )
  assert.throws(
    () =>
      buildDirectRollbackPlan({ ...input, cases: [{ ...cases[0], assetsRaw: '101' }, cases[1]] }),
    /positive_q_mismatch/,
  )
  assert.throws(
    () =>
      buildDirectRollbackPlan({
        ...input,
        cases: cases.map((row) => ({ ...row, baselineStatus: 'unavailable' })),
      }),
    /verified_direct_success_unavailable/,
  )
})
