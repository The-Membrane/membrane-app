// Optional issue-bound parent-link evidence for frozen direct-supplier flow.
// The V1 flow snapshot remains unchanged. This envelope adds no UTC witness
// or trustless Ethereum header-hash proof.
import {
  buildDirectFlowAncestryWitness,
  MAX_FLOW_ANCESTRY_GAP,
  verifyDirectFlowAncestryWitness,
} from './holder-exit-flow-ancestry-witness.mjs'
import { verifyIssueDirectFlowSnapshot } from './holder-exit-direct-flow-issue-snapshot.mjs'

export const ISSUE_FLOW_ANCESTRY_SCHEMA = 'holder_exit_direct_flow_issue_ancestry_v1'
export const MAX_NATIVE_FLOW_ANCESTRY_GAP = 128

const REASONS = new Set([
  'no_frozen_flow_feature',
  'gap_over_native_limit',
  'no_source',
  'anchor_invalid',
  'source_after_baseline',
  'gap_over_limit',
  'budget_invalid',
  'reader_unavailable',
  'header_read_failed',
  'header_invalid',
  'origin_disagreement',
  'witness_over_limit',
  'witness_shape_invalid',
  'anchor_mismatch',
  'digest_mismatch',
  'parent_link_mismatch',
  'baseline_link_mismatch',
])
const fail = (valid, reason) => {
  if (!valid) throw Error(`holder_issue_flow_ancestry_${reason}`)
}
const exactKeys = (value, expected) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...expected].sort().join('|')

function issueIdentity(issue) {
  return {
    schema: ISSUE_FLOW_ANCESTRY_SCHEMA,
    marketKey: issue.marketKey,
    routeKey: issue.routeKey,
    destination: issue.destination,
    asset: issue.originalAsset,
    baselineBlock: issue.baseline.targetBlock,
    baselineHash: issue.baseline.targetHash,
  }
}

function verifySlot(issue, snapshotSlot, envelopeSlot, flowKind) {
  if (envelopeSlot?.status === 'unavailable') {
    fail(
      exactKeys(envelopeSlot, ['status', 'reason']) && REASONS.has(envelopeSlot.reason),
      'unavailable_invalid',
    )
    fail(
      snapshotSlot.status === 'available' || envelopeSlot.reason === 'no_frozen_flow_feature',
      'slot_mismatch',
    )
    fail(
      snapshotSlot.status !== 'available' || envelopeSlot.reason !== 'no_frozen_flow_feature',
      'slot_mismatch',
    )
    return
  }
  fail(
    envelopeSlot?.status === 'available' && exactKeys(envelopeSlot, ['status', 'witness']),
    'slot_invalid',
  )
  fail(snapshotSlot.status === 'available', 'slot_mismatch')
  const checked = verifyDirectFlowAncestryWitness({
    issue,
    feature: snapshotSlot.feature,
    witness: envelopeSlot.witness,
  })
  fail(checked.status === 'consistent_parent_links', `${flowKind}_${checked.reason ?? 'invalid'}`)
}

/** A missing field preserves legacy issue bytes; a present field is strict. */
export function verifyIssueDirectFlowAncestry(issue) {
  if (!Object.hasOwn(issue, 'flowAncestry')) return null
  const snapshot = verifyIssueDirectFlowSnapshot(issue)
  fail(snapshot, 'snapshot_missing')
  const envelope = issue.flowAncestry
  const identity = issueIdentity(issue)
  fail(
    exactKeys(envelope, [...Object.keys(identity), 'withdrawals', 'supplies']) &&
      Object.entries(identity).every(([key, value]) => envelope[key] === value),
    'identity_invalid',
  )
  verifySlot(issue, snapshot.withdrawals, envelope.withdrawals, 'withdrawals')
  verifySlot(issue, snapshot.supplies, envelope.supplies, 'supplies')
  return envelope
}

async function captureSlot(issue, slot, readHeader) {
  if (slot.status !== 'available')
    return { status: 'unavailable', reason: 'no_frozen_flow_feature' }
  const gap = BigInt(issue.baseline.targetBlock) - BigInt(slot.feature.sourceBlock)
  if (gap > BigInt(MAX_NATIVE_FLOW_ANCESTRY_GAP))
    return { status: 'unavailable', reason: 'gap_over_native_limit' }
  const result = await buildDirectFlowAncestryWitness({ issue, feature: slot.feature, readHeader })
  if (result.status === 'attested_parent_links')
    return { status: 'available', witness: result.witness }
  fail(result.status === 'abstained' && REASONS.has(result.reason), 'capture_invalid')
  return { status: 'unavailable', reason: result.reason }
}

/** Called before the final issuedAtUtc; readHeader performs caller-supplied two-origin reads. */
export async function captureIssueDirectFlowAncestry(provisionalIssue, { readHeader } = {}) {
  const snapshot = verifyIssueDirectFlowSnapshot(provisionalIssue)
  fail(snapshot, 'snapshot_missing')
  const envelope = {
    ...issueIdentity(provisionalIssue),
    withdrawals: await captureSlot(provisionalIssue, snapshot.withdrawals, readHeader),
    supplies: await captureSlot(provisionalIssue, snapshot.supplies, readHeader),
  }
  verifyIssueDirectFlowAncestry({ ...provisionalIssue, flowAncestry: envelope })
  return envelope
}

export function issueFlowAncestryMarker(issue, flowKind) {
  fail(['withdraw', 'supply'].includes(flowKind), 'flow_kind_invalid')
  const envelope = verifyIssueDirectFlowAncestry(issue)
  const slot = envelope?.[flowKind === 'supply' ? 'supplies' : 'withdrawals']
  return slot?.status === 'available' ? 'two_origin_attested_parent_links' : 'unproven'
}

fail(MAX_NATIVE_FLOW_ANCESTRY_GAP <= MAX_FLOW_ANCESTRY_GAP, 'native_limit_invalid')
