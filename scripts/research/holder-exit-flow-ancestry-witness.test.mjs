import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  buildDirectFlowAncestryWitness,
  MAX_FLOW_ANCESTRY_GAP,
  MAX_FLOW_ANCESTRY_WITNESS_BYTES,
  verifyDirectFlowAncestryWitness,
} from './holder-exit-flow-ancestry-witness.mjs'

const hash = (number) => `0x${number.toString(16).padStart(64, '0')}`
const issue = (number) => ({
  baseline: {
    targetBlock: String(number),
    targetHash: hash(number),
    targetParentBlock: String(number - 1),
    targetParentHash: hash(number - 1),
    canonicalityEvidenceDoc: {
      targetHeader: {
        number: String(number),
        hash: hash(number),
        parentHash: hash(number - 1),
        timestamp: '2026-10-04T00:00:00.000Z',
      },
      parentHeader: {
        number: String(number - 1),
        hash: hash(number - 1),
        parentHash: hash(number - 2),
        timestamp: '2026-10-03T23:59:48.000Z',
      },
    },
  },
})
const feature = (number) => ({ sourceBlock: String(number), sourceBlockHash: hash(number) })
const header = (number) => ({
  number: `0x${number.toString(16)}`,
  hash: hash(number),
  parentHash: hash(number - 1),
  timestamp: '0x1',
})
const reseal = (witness) => {
  const { witnessSha256: _old, ...body } = witness
  witness.witnessSha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

test('B=S anchors directly without querying any intermediate header', async () => {
  const baseline = issue(100)
  const source = feature(100)
  const result = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: () => {
      throw Error('unexpected read')
    },
  })
  assert.equal(result.status, 'attested_parent_links')
  assert.deepEqual(result.witness.headers, [])
  assert.equal(result.witness.trustlessHeaderHashProof, false)
  assert.equal(result.witness.utcWitnessed, false)
  assert.equal(
    verifyDirectFlowAncestryWitness({ issue: baseline, feature: source, witness: result.witness })
      .status,
    'consistent_parent_links',
  )
  assert.equal(
    verifyDirectFlowAncestryWitness({
      issue: baseline,
      feature: { ...source, sourceBlockHash: hash(999) },
      witness: result.witness,
    }).reason,
    'anchor_mismatch',
  )
})

test('B=S+1 uses the issue target parent hash and needs no extra header', async () => {
  const baseline = issue(101)
  const source = feature(100)
  const result = await buildDirectFlowAncestryWitness({ issue: baseline, feature: source })
  assert.equal(result.status, 'attested_parent_links')
  assert.deepEqual(result.witness.headers, [])
  const forked = issue(101)
  forked.baseline.targetParentHash = hash(999)
  const rejected = await buildDirectFlowAncestryWitness({ issue: forked, feature: source })
  assert.deepEqual(rejected, { status: 'abstained', reason: 'anchor_invalid' })
  const mismatchedHeader = issue(101)
  mismatchedHeader.baseline.canonicalityEvidenceDoc.parentHeader.hash = hash(999)
  assert.deepEqual(
    await buildDirectFlowAncestryWitness({ issue: mismatchedHeader, feature: source }),
    { status: 'abstained', reason: 'anchor_invalid' },
  )
  const mismatchedTarget = issue(101)
  mismatchedTarget.baseline.canonicalityEvidenceDoc.targetHeader.parentHash = hash(999)
  assert.deepEqual(
    await buildDirectFlowAncestryWitness({ issue: mismatchedTarget, feature: source }),
    { status: 'abstained', reason: 'anchor_invalid' },
  )
})

test('B=S+2 saves one minimal tuple only after both origins agree', async () => {
  const calls = []
  const baseline = issue(102)
  const source = feature(100)
  const result = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: async (number, originIndex) => {
      calls.push([number, originIndex])
      return header(number)
    },
  })
  assert.equal(result.status, 'attested_parent_links')
  assert.deepEqual(calls, [
    [101, 0],
    [101, 1],
  ])
  assert.deepEqual(result.witness.headers, [
    { number: '101', hash: hash(101), parentHash: hash(100) },
  ])
  assert.ok(Buffer.byteLength(JSON.stringify(result.witness)) < MAX_FLOW_ANCESTRY_WITNESS_BYTES)
  assert.equal(
    verifyDirectFlowAncestryWitness({ issue: baseline, feature: source, witness: result.witness })
      .status,
    'consistent_parent_links',
  )
})

test('larger bounded gap verifies every exact height and rejects tuple tampering', async () => {
  const baseline = issue(105)
  const source = feature(100)
  const calls = []
  const result = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: async (number, originIndex) => {
      calls.push([number, originIndex])
      return header(number)
    },
  })
  assert.equal(result.status, 'attested_parent_links')
  assert.deepEqual(
    result.witness.headers.map((item) => item.number),
    ['101', '102', '103', '104'],
  )
  assert.equal(calls.length, 8)

  const changedHash = structuredClone(result.witness)
  changedHash.headers[0].hash = hash(999)
  assert.equal(
    verifyDirectFlowAncestryWitness({ issue: baseline, feature: source, witness: changedHash })
      .reason,
    'digest_mismatch',
  )
  reseal(changedHash)
  assert.equal(
    verifyDirectFlowAncestryWitness({ issue: baseline, feature: source, witness: changedHash })
      .reason,
    'parent_link_mismatch',
  )
  const changedNumber = structuredClone(result.witness)
  changedNumber.headers[1].number = '104'
  reseal(changedNumber)
  assert.equal(
    verifyDirectFlowAncestryWitness({ issue: baseline, feature: source, witness: changedNumber })
      .reason,
    'header_invalid',
  )
  const changedTarget = structuredClone(result.witness)
  changedTarget.baselineParentHash = hash(999)
  reseal(changedTarget)
  assert.equal(
    verifyDirectFlowAncestryWitness({ issue: baseline, feature: source, witness: changedTarget })
      .reason,
    'anchor_mismatch',
  )
})

test('origin mismatch and failed reads abstain without accepting partial evidence', async () => {
  const baseline = issue(102)
  const source = feature(100)
  const disagree = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: async (number, originIndex) =>
      originIndex === 0 ? header(number) : { ...header(number), hash: hash(999) },
  })
  assert.deepEqual(disagree, { status: 'abstained', reason: 'origin_disagreement' })
  const failed = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: async (_number, originIndex) => {
      if (originIndex === 1) throw Error('do not expose provider text')
      return header(101)
    },
  })
  assert.deepEqual(failed, { status: 'abstained', reason: 'header_read_failed' })
  const syncFailed = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: (_number, originIndex) => {
      if (originIndex === 1) throw Error('synchronous provider failure')
      return header(101)
    },
  })
  assert.deepEqual(syncFailed, { status: 'abstained', reason: 'header_read_failed' })
  const missing = await buildDirectFlowAncestryWitness({ issue: baseline, feature: source })
  assert.deepEqual(missing, { status: 'abstained', reason: 'reader_unavailable' })
  const wrongHeight = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: async () => header(103),
  })
  assert.deepEqual(wrongHeight, { status: 'abstained', reason: 'header_invalid' })
})

test('two agreeing origins cannot bridge a bad parent link', async () => {
  const baseline = issue(102)
  const source = feature(100)
  const badParent = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: async (number) => ({ ...header(number), parentHash: hash(999) }),
  })
  assert.deepEqual(badParent, { status: 'abstained', reason: 'parent_link_mismatch' })
  const badBaseline = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: async (number) => ({ ...header(number), hash: hash(999) }),
  })
  assert.deepEqual(badBaseline, { status: 'abstained', reason: 'baseline_link_mismatch' })
  const inconsistentParent = issue(102)
  inconsistentParent.baseline.canonicalityEvidenceDoc.parentHeader.parentHash = hash(999)
  const inconsistent = await buildDirectFlowAncestryWitness({
    issue: inconsistentParent,
    feature: source,
    readHeader: async (number) => header(number),
  })
  assert.deepEqual(inconsistent, { status: 'abstained', reason: 'anchor_mismatch' })
})

test('256-block gap is accepted and wider gap abstains before any read', async () => {
  let reads = 0
  const source = feature(100)
  const accepted = await buildDirectFlowAncestryWitness({
    issue: issue(100 + MAX_FLOW_ANCESTRY_GAP),
    feature: source,
    readHeader: async (number) => {
      reads++
      return header(number)
    },
  })
  assert.equal(accepted.status, 'attested_parent_links')
  assert.equal(accepted.witness.headers.length, MAX_FLOW_ANCESTRY_GAP - 1)
  assert.equal(reads, 2 * (MAX_FLOW_ANCESTRY_GAP - 1))
  assert.ok(Buffer.byteLength(JSON.stringify(accepted.witness)) <= MAX_FLOW_ANCESTRY_WITNESS_BYTES)
  const tooWide = await buildDirectFlowAncestryWitness({
    issue: issue(100 + MAX_FLOW_ANCESTRY_GAP + 1),
    feature: source,
    readHeader: async () => {
      reads++
      throw Error('unexpected read')
    },
  })
  assert.deepEqual(tooWide, { status: 'abstained', reason: 'gap_over_limit' })
  assert.equal(reads, 2 * (MAX_FLOW_ANCESTRY_GAP - 1))
})

test('serialized witness budget is enforced and an absent source abstains', async () => {
  const baseline = issue(102)
  const source = feature(100)
  const bounded = await buildDirectFlowAncestryWitness({
    issue: baseline,
    feature: source,
    readHeader: async (number) => header(number),
    maxWitnessBytes: 256,
  })
  assert.deepEqual(bounded, { status: 'abstained', reason: 'witness_over_limit' })
  assert.equal(
    verifyDirectFlowAncestryWitness({
      issue: baseline,
      feature: source,
      witness: { padding: 'x'.repeat(MAX_FLOW_ANCESTRY_WITNESS_BYTES) },
    }).reason,
    'witness_over_limit',
  )
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(
    verifyDirectFlowAncestryWitness({ issue: baseline, feature: source, witness: cyclic }).reason,
    'witness_shape_invalid',
  )
  assert.deepEqual(await buildDirectFlowAncestryWitness({ issue: baseline, feature: null }), {
    status: 'abstained',
    reason: 'no_source',
  })
  assert.deepEqual(
    verifyDirectFlowAncestryWitness({ issue: baseline, feature: null, witness: null }),
    {
      status: 'abstained',
      reason: 'no_source',
    },
  )
})
