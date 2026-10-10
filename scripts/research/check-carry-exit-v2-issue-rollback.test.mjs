import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildUnavailablePlan } from './check-carry-exit-v2-issue-rollback.mjs'

const route = {
  routeKey: 'Test → VaultV2 [USDC]',
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
    selectedHolderCommitment: 'test',
    ladder: {
      labels: [
        { label: 'small', assetsRaw: '100' },
        { label: 'duplicate', assetsRaw: null, reason: 'duplicate' },
        { label: 'large', assetsRaw: '1000' },
      ],
    },
  },
}

test('live gate plan retains only positive Q as explicit unavailable cases', () => {
  const plan = buildUnavailablePlan({
    route,
    baseline,
    candidate,
    slotAt: '2026-09-30T00:10:00.000Z',
    candidateDigest: 'a'.repeat(64),
  })
  assert.deepEqual(plan.horizons, [1, 4, 24, 48, 168])
  assert.deepEqual(plan.cases, [
    { assetsRaw: '100', baselineStatus: 'unavailable', unavailableReason: 'quote_unavailable' },
    { assetsRaw: '1000', baselineStatus: 'unavailable', unavailableReason: 'quote_unavailable' },
  ])
  assert.equal(plan.candidateEvidenceDoc, candidate.evidenceDoc)
})

test('live gate cannot issue without a holder or positive amount', () => {
  const input = {
    route,
    baseline,
    candidate,
    slotAt: '2026-09-30T00:10:00.000Z',
    candidateDigest: 'a'.repeat(64),
  }
  assert.throws(
    () => buildUnavailablePlan({ ...input, candidate: { ...candidate, holder: null } }),
    /candidate_not_issuable/,
  )
  assert.throws(
    () =>
      buildUnavailablePlan({
        ...input,
        candidate: { ...candidate, evidenceDoc: { ladder: { labels: [] } } },
      }),
    /positive_q_unavailable/,
  )
})
