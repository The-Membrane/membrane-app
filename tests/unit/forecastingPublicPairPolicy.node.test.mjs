import assert from 'node:assert/strict'
import { PUBLIC_PAIR_POLICY, PUBLIC_PAIR_POLICY_SHA256, enrollPublicPairQualification,
  publicPairQualificationPlan, verifyPublicPairHead } from '../../scripts/research/forecasting-public-pair-policy.mjs'

const nowMs = Date.parse('2026-10-12T12:00:00Z')
const input = { policySha256: PUBLIC_PAIR_POLICY_SHA256, scope: 'finite-read-only-head-qualification',
  enrolledAtUtc: '2026-10-12T12:00:00Z', expiresAtUtc: '2026-10-12T12:30:00Z' }
const enrollment = enrollPublicPairQualification(input)
const first = publicPairQualificationPlan(enrollment, { nowMs })
const second = publicPairQualificationPlan(enrollment, { nowMs, agreedFinalizedBlock: '0x123', includeMorphoSchemaProbe: true })
assert.equal(first.requests.length + second.requests.length, PUBLIC_PAIR_POLICY.limits.maxRequests)
assert.deepEqual(first.requests.map((r) => r.body.method), ['eth_chainId', 'eth_getBlockByNumber', 'eth_chainId', 'eth_getBlockByNumber'])
assert.equal(second.requests[2].body.query, 'query QualificationSchema { __typename }')
assert.equal(enrollment.replacesActivePolicy, false)
assert.equal(first.archiveSupport, 'unqualified')
assert.equal(first.executionAllowed, false)
assert.throws(() => enrollPublicPairQualification({ ...input, policySha256: '0'.repeat(64) }))
assert.throws(() => enrollPublicPairQualification({ ...input, scope: 'archive-capture' }))
assert.throws(() => enrollPublicPairQualification({ ...input, expiresAtUtc: '2026-10-12T14:00:00Z' }))
assert.throws(() => publicPairQualificationPlan(enrollment, { nowMs: nowMs + 1800000 }))
assert.throws(() => publicPairQualificationPlan({ ...enrollment, replacesActivePolicy: true }, { nowMs }))
assert.throws(() => publicPairQualificationPlan(enrollment, { nowMs, agreedFinalizedBlock: 'latest' }))
assert.throws(() => publicPairQualificationPlan(enrollment, { nowMs, agreedFinalizedBlock: '0x0123' }))
const head = { number: '0x123', hash: '0x' + 'a'.repeat(64), timestamp: '0x456' }
const evidence = { chainIds: ['0x1', '0x1'], finalizedHeads: [head, head], exactHeads: [head, head] }
assert.equal(verifyPublicPairHead(evidence).status, 'head_agreement_only')
assert.equal(verifyPublicPairHead(evidence).holderCapacity, 'unqualified')
assert.throws(() => verifyPublicPairHead({ ...evidence, chainIds: ['0x1', '0x89'] }))
for (const field of ['number', 'hash', 'timestamp']) {
  assert.throws(() => verifyPublicPairHead({ ...evidence, exactHeads: [head,
    { ...head, [field]: field === 'hash' ? '0x' + 'b'.repeat(64) : '0x457' }] }))
}
assert.throws(() => verifyPublicPairHead({ ...evidence, exactHeads: [head, { ...head, timestamp: 'invalid' }] }))
console.log('public-pair policy: 20 scope/enrollment/head-binding assertions passed; no network calls')
