import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  captureIssueDirectFlowAncestry,
  issueFlowAncestryMarker,
  MAX_NATIVE_FLOW_ANCESTRY_GAP,
  verifyIssueDirectFlowAncestry,
} from './holder-exit-direct-flow-issue-ancestry.mjs'
import { buildIssueDirectFlowSnapshot } from './holder-exit-direct-flow-issue-snapshot.mjs'
import { directFlowFeatureReceiptSha256 } from './holder-exit-direct-flow-features.mjs'

const hash = (number) => `0x${number.toString(16).padStart(64, '0')}`
const sha = (value) => createHash('sha256').update(value).digest('hex')
const sourceMs = Date.parse('2026-10-04T00:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const sourceBlock = 100

function issueWithSnapshot({ gap = 2, kinds = ['withdraw', 'supply'] } = {}) {
  const baselineBlock = sourceBlock + gap
  const baselineMs = sourceMs + gap * 12_000
  const issue = {
    marketKey: 'aaveV3Usdc',
    routeKey: 'aave-v3-usdc',
    destination: '0x00000000000000000000000000000000000000a1',
    originalAsset: '0x00000000000000000000000000000000000000b1',
    issuedAtUtc: iso(baselineMs + 300_000),
    baseline: {
      targetBlock: String(baselineBlock),
      targetHash: hash(baselineBlock),
      targetParentBlock: String(baselineBlock - 1),
      targetParentHash: hash(baselineBlock - 1),
      targetBlockAt: iso(baselineMs),
      canonicalityEvidenceDoc: {
        targetHeader: {
          number: String(baselineBlock),
          hash: hash(baselineBlock),
          parentHash: hash(baselineBlock - 1),
          timestamp: iso(baselineMs),
        },
        parentHeader: {
          number: String(baselineBlock - 1),
          hash: hash(baselineBlock - 1),
          parentHash: hash(baselineBlock - 2),
          timestamp: iso(baselineMs - 12_000),
        },
      },
    },
  }
  const features = kinds.map((kind) => {
    const feature = {
      kind: kind === 'supply' ? 'gross_supplier_supply_24h' : 'gross_supplier_withdraw_24h',
      routeKey: issue.routeKey,
      destination: issue.destination,
      asset: issue.originalAsset,
      collectionMode: 'historical_preissue',
      coverageComplete: true,
      sourceBlock: String(sourceBlock),
      sourceBlockHash: hash(sourceBlock),
      sourceAt: iso(sourceMs),
      firstLocalReceiptAt: iso(sourceMs + 3_000),
      completedAtUtc: iso(sourceMs + 2_000),
      valueRaw: kind === 'supply' ? '250' : '1000',
      clockBasis: 'local_operator_clock_unwitnessed',
      windowStartAt: iso(sourceMs - 86_400_000),
      windowEndAt: iso(sourceMs),
      constituentRefs: [
        {
          fromBlock: sourceBlock - 1,
          toBlock: sourceBlock - 1,
          segmentSha256: sha(`${kind}-segment`),
          publicationWitnessSha256: sha(`${kind}-publication`),
          captureCompletedAt: iso(sourceMs + 2_000),
          firstLocalReceiptAt: iso(sourceMs + 3_000),
        },
      ],
    }
    feature.receiptSha256 = directFlowFeatureReceiptSha256(feature, issue.marketKey, kind)
    return feature
  })
  issue.flowSnapshot = buildIssueDirectFlowSnapshot(issue, { features, failed: false })
  return issue
}

const header = (number) => ({
  number: `0x${number.toString(16)}`,
  hash: hash(number),
  parentHash: hash(number - 1),
  timestamp: '0x1',
})

test('each available slot seals independent parent-link agreement without promoting its clock', async () => {
  const issue = issueWithSnapshot()
  const calls = []
  issue.flowAncestry = await captureIssueDirectFlowAncestry(issue, {
    readHeader: async (number, originIndex) => {
      calls.push([number, originIndex])
      return header(number)
    },
  })
  assert.deepEqual(calls, [
    [101, 0],
    [101, 1],
    [101, 0],
    [101, 1],
  ])
  assert.equal(issue.flowAncestry.withdrawals.status, 'available')
  assert.equal(issue.flowAncestry.supplies.status, 'available')
  assert.deepEqual(issue.flowAncestry.withdrawals.witness.headers, [
    { number: '101', hash: hash(101), parentHash: hash(100) },
  ])
  assert.equal(issue.flowAncestry.withdrawals.witness.utcWitnessed, false)
  assert.equal(verifyIssueDirectFlowAncestry(issue), issue.flowAncestry)
  assert.equal(issueFlowAncestryMarker(issue, 'withdraw'), 'two_origin_attested_parent_links')
  assert.equal(issueFlowAncestryMarker(issue, 'supply'), 'two_origin_attested_parent_links')
  assert.equal(issue.flowSnapshot.sourceBaselineAncestry, 'unproven')
})

test('origin disagreement abstains for the available slot and never promotes the other slot', async () => {
  const issue = issueWithSnapshot({ kinds: ['withdraw'] })
  issue.flowAncestry = await captureIssueDirectFlowAncestry(issue, {
    readHeader: async (number, originIndex) =>
      originIndex === 0 ? header(number) : { ...header(number), hash: hash(999) },
  })
  assert.deepEqual(issue.flowAncestry.withdrawals, {
    status: 'unavailable',
    reason: 'origin_disagreement',
  })
  assert.deepEqual(issue.flowAncestry.supplies, {
    status: 'unavailable',
    reason: 'no_frozen_flow_feature',
  })
  assert.equal(verifyIssueDirectFlowAncestry(issue), issue.flowAncestry)
  assert.equal(issueFlowAncestryMarker(issue, 'withdraw'), 'unproven')
  assert.equal(issueFlowAncestryMarker(issue, 'supply'), 'unproven')
})

test('missing frozen features carry typed absence and require no header reads', async () => {
  const issue = issueWithSnapshot({ kinds: [] })
  issue.flowAncestry = await captureIssueDirectFlowAncestry(issue, {
    readHeader: () => {
      throw Error('no available feature requires a header')
    },
  })
  assert.deepEqual(issue.flowAncestry.withdrawals, {
    status: 'unavailable',
    reason: 'no_frozen_flow_feature',
  })
  assert.deepEqual(issue.flowAncestry.supplies, issue.flowAncestry.withdrawals)
  assert.equal(verifyIssueDirectFlowAncestry(issue), issue.flowAncestry)
  assert.equal(issueFlowAncestryMarker(issue, 'withdraw'), 'unproven')
  assert.equal(verifyIssueDirectFlowAncestry(issueWithSnapshot()), null)
  await assert.rejects(
    captureIssueDirectFlowAncestry({ ...issue, flowSnapshot: undefined }),
    /holder_issue_flow_/,
  )
})

test('identity, slot and digest mutations reject instead of silently accepting ancestry', async () => {
  const issue = issueWithSnapshot({ kinds: ['withdraw'] })
  issue.flowAncestry = await captureIssueDirectFlowAncestry(issue, {
    readHeader: async (number) => header(number),
  })
  for (const mutate of [
    (row) => {
      row.flowAncestry.routeKey = 'wrong-route'
    },
    (row) => {
      row.flowAncestry.supplies = row.flowAncestry.withdrawals
    },
    (row) => {
      row.flowAncestry.withdrawals = {
        status: 'unavailable',
        reason: 'no_frozen_flow_feature',
      }
    },
    (row) => {
      row.flowAncestry.withdrawals.witness.headers[0].parentHash = hash(999)
    },
    (row) => {
      row.flowSnapshot.withdrawals.feature.valueRaw = '999'
    },
  ]) {
    const changed = structuredClone(issue)
    mutate(changed)
    assert.throws(() => verifyIssueDirectFlowAncestry(changed), /holder_issue_flow_/)
  }
  assert.throws(() => issueFlowAncestryMarker(issue, 'not-a-flow'), /flow_kind_invalid/)
})

test('native gap cap abstains before RPC even when the generic witness gap permits it', async () => {
  const issue = issueWithSnapshot({ gap: MAX_NATIVE_FLOW_ANCESTRY_GAP + 1, kinds: ['withdraw'] })
  let reads = 0
  issue.flowAncestry = await captureIssueDirectFlowAncestry(issue, {
    readHeader: () => {
      reads++
      throw Error('native cap should avoid RPC')
    },
  })
  assert.equal(reads, 0)
  assert.deepEqual(issue.flowAncestry.withdrawals, {
    status: 'unavailable',
    reason: 'gap_over_native_limit',
  })
  assert.equal(verifyIssueDirectFlowAncestry(issue), issue.flowAncestry)
  assert.equal(issueFlowAncestryMarker(issue, 'withdraw'), 'unproven')
})
