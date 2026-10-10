// Immutable issue-time gross-flow context. The archived issue binds the
// contributing segment and publication-witness digests; its local clock and
// prebaseline block ordering do not independently prove same-chain ancestry.
import {
  directFlowFeatureReceiptSha256,
  readVerifiedDirectFlowFeatures,
} from './holder-exit-direct-flow-features.mjs'

export const FLOW_SNAPSHOT_SCHEMA = 'holder_exit_direct_flow_issue_snapshot_v1'
const CLOCK_BASIS = 'local_operator_clock_unwitnessed'
const MAX_CONSTITUENTS = 144
const SHA = /^[0-9a-f]{64}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const DAY_MS = 86_400_000
export const MAX_FRESH_FLOW_AGE_MS = 2 * 60 * 60 * 1000
const fail = (valid, reason) => {
  if (!valid) throw Error(`holder_issue_flow_${reason}`)
}
const keys = (value, expected) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...expected].sort().join('|')
const utc = (value) => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  fail(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}

const identityFields = [
  'schema',
  'marketKey',
  'routeKey',
  'destination',
  'asset',
  'baselineBlock',
  'baselineHash',
  'clockBasis',
  'sourceBaselineAncestry',
  'withdrawals',
  'supplies',
]
const featureFields = [
  'kind',
  'routeKey',
  'destination',
  'asset',
  'receiptSha256',
  'collectionMode',
  'coverageComplete',
  'sourceBlock',
  'sourceBlockHash',
  'sourceAt',
  'firstLocalReceiptAt',
  'completedAtUtc',
  'valueRaw',
  'clockBasis',
  'windowStartAt',
  'windowEndAt',
  'constituentRefs',
]

/** A failed bounded read is a sealed absence, not a fabricated zero-flow row. */
export function captureIssueDirectFlowCandidates({
  marketKey,
  readFlow = readVerifiedDirectFlowFeatures,
}) {
  try {
    const result = readFlow({ marketKeys: [marketKey] })
    fail(result && Array.isArray(result.features), 'reader_invalid')
    return { features: result.features, failed: false }
  } catch {
    return { features: [], failed: true }
  }
}

function verifyFeature(feature, issue, flowKind) {
  fail(keys(feature, featureFields), 'feature_fields_invalid')
  fail(
    feature.kind ===
      (flowKind === 'supply' ? 'gross_supplier_supply_24h' : 'gross_supplier_withdraw_24h') &&
      feature.routeKey === issue.routeKey &&
      feature.destination === issue.destination &&
      feature.asset === issue.originalAsset &&
      feature.collectionMode === 'historical_preissue' &&
      feature.coverageComplete === true &&
      feature.clockBasis === CLOCK_BASIS &&
      DECIMAL.test(feature.valueRaw) &&
      DECIMAL.test(feature.sourceBlock) &&
      BLOCK_HASH.test(feature.sourceBlockHash) &&
      SHA.test(feature.receiptSha256) &&
      Array.isArray(feature.constituentRefs) &&
      feature.constituentRefs.length > 0 &&
      feature.constituentRefs.length <= MAX_CONSTITUENTS &&
      feature.constituentRefs.every(
        (item) =>
          keys(item, [
            'fromBlock',
            'toBlock',
            'segmentSha256',
            'publicationWitnessSha256',
            'captureCompletedAt',
            'firstLocalReceiptAt',
          ]) &&
          Number.isSafeInteger(item.fromBlock) &&
          Number.isSafeInteger(item.toBlock) &&
          item.fromBlock >= 0 &&
          item.toBlock >= item.fromBlock &&
          SHA.test(item.segmentSha256) &&
          SHA.test(item.publicationWitnessSha256),
      ),
    'feature_identity_invalid',
  )
  const issuedMs = utc(issue.issuedAtUtc)
  const baselineMs = utc(issue.baseline.targetBlockAt)
  const startMs = utc(feature.windowStartAt)
  const endMs = utc(feature.windowEndAt)
  const sourceMs = utc(feature.sourceAt)
  const completedMs = utc(feature.completedAtUtc)
  const receiptMs = utc(feature.firstLocalReceiptAt)
  const refClocks = feature.constituentRefs.map((ref) => ({
    completedMs: utc(ref.captureCompletedAt),
    receiptMs: utc(ref.firstLocalReceiptAt),
  }))
  fail(
    endMs - startMs === DAY_MS &&
      endMs === sourceMs &&
      sourceMs <= baselineMs &&
      sourceMs <= issuedMs &&
      completedMs >= sourceMs &&
      completedMs <= receiptMs &&
      receiptMs <= issuedMs &&
      refClocks.every(
        (ref) =>
          ref.completedMs >= sourceMs - DAY_MS &&
          ref.completedMs <= ref.receiptMs &&
          ref.receiptMs <= issuedMs,
      ) &&
      completedMs === Math.max(...refClocks.map((ref) => ref.completedMs)) &&
      receiptMs === Math.max(...refClocks.map((ref) => ref.receiptMs)) &&
      BigInt(feature.sourceBlock) <= BigInt(issue.baseline.targetBlock) &&
      feature.constituentRefs.every(
        (ref, index) =>
          index === 0 ||
          BigInt(feature.constituentRefs[index - 1].toBlock) + 1n === BigInt(ref.fromBlock),
      ) &&
      BigInt(feature.constituentRefs.at(-1).toBlock) + 1n === BigInt(feature.sourceBlock) &&
      (feature.sourceBlock !== issue.baseline.targetBlock ||
        feature.sourceBlockHash === issue.baseline.targetHash) &&
      feature.receiptSha256 === directFlowFeatureReceiptSha256(feature, issue.marketKey, flowKind),
    'feature_asof_or_digest_invalid',
  )
}

function verifySlot(slot, issue, flowKind) {
  if (slot?.status === 'unavailable') {
    fail(
      keys(slot, ['status', 'reason']) &&
        ['no_preissue_complete_v2_window', 'flow_read_unavailable'].includes(slot.reason),
      'unavailable_invalid',
    )
    return
  }
  fail(slot?.status === 'available' && keys(slot, ['status', 'feature']), 'slot_invalid')
  verifyFeature(slot.feature, issue, flowKind)
}

/** Old issued records have no field and preserve their exact sealed bytes. */
export function verifyIssueDirectFlowSnapshot(issue) {
  if (!Object.hasOwn(issue, 'flowSnapshot')) return null
  const snapshot = issue.flowSnapshot
  fail(
    keys(snapshot, identityFields) &&
      snapshot.schema === FLOW_SNAPSHOT_SCHEMA &&
      snapshot.marketKey === issue.marketKey &&
      snapshot.routeKey === issue.routeKey &&
      snapshot.destination === issue.destination &&
      snapshot.asset === issue.originalAsset &&
      snapshot.baselineBlock === issue.baseline.targetBlock &&
      snapshot.baselineHash === issue.baseline.targetHash &&
      snapshot.clockBasis === CLOCK_BASIS &&
      snapshot.sourceBaselineAncestry === 'unproven',
    'identity_invalid',
  )
  verifySlot(snapshot.withdrawals, issue, 'withdraw')
  verifySlot(snapshot.supplies, issue, 'supply')
  return snapshot
}

/** Campaign-only gate: both gross-flow windows must still describe this baseline. */
export function requireFreshIssueDirectFlowSnapshot(issue) {
  const snapshot = verifyIssueDirectFlowSnapshot(issue)
  fail(snapshot !== null, 'fresh_window_missing')
  const baselineMs = utc(issue.baseline.targetBlockAt)
  const issuedMs = utc(issue.issuedAtUtc)
  for (const slot of [snapshot.withdrawals, snapshot.supplies]) {
    fail(slot.status === 'available', 'fresh_window_missing')
    const sourceMs = utc(slot.feature.sourceAt)
    fail(
      baselineMs >= sourceMs &&
        baselineMs - sourceMs <= MAX_FRESH_FLOW_AGE_MS &&
        issuedMs >= sourceMs &&
        issuedMs - sourceMs <= MAX_FRESH_FLOW_AGE_MS,
      'fresh_window_stale',
    )
  }
  return snapshot
}

function copyFeature(feature) {
  return Object.fromEntries(
    featureFields.map((key) => [
      key,
      key === 'constituentRefs' && Array.isArray(feature[key])
        ? feature[key].map((ref) => ({ ...ref }))
        : feature[key],
    ]),
  )
}

function eligibleSlot(issue, features, flowKind) {
  const expected =
    flowKind === 'supply' ? 'gross_supplier_supply_24h' : 'gross_supplier_withdraw_24h'
  const choices = []
  for (const feature of features) {
    if (feature?.kind !== expected) continue
    try {
      const copy = copyFeature(feature)
      verifyFeature(copy, issue, flowKind)
      choices.push(copy)
    } catch {
      // A late, future, incomplete or malformed candidate cannot enter this issue.
    }
  }
  if (!choices.length) return { status: 'unavailable', reason: 'no_preissue_complete_v2_window' }
  choices.sort((a, b) => {
    const left = BigInt(a.sourceBlock)
    const right = BigInt(b.sourceBlock)
    if (left !== right) return left < right ? 1 : -1
    return utc(b.sourceAt) - utc(a.sourceAt)
  })
  return { status: 'available', feature: choices[0] }
}

/** Build after baseline measurements, using candidates read before issue time. */
export function buildIssueDirectFlowSnapshot(issue, capture) {
  const unavailable = (reason) => ({ status: 'unavailable', reason })
  const failed = capture?.failed === true || !Array.isArray(capture?.features)
  const snapshot = {
    schema: FLOW_SNAPSHOT_SCHEMA,
    marketKey: issue.marketKey,
    routeKey: issue.routeKey,
    destination: issue.destination,
    asset: issue.originalAsset,
    baselineBlock: issue.baseline.targetBlock,
    baselineHash: issue.baseline.targetHash,
    clockBasis: CLOCK_BASIS,
    sourceBaselineAncestry: 'unproven',
    withdrawals: failed
      ? unavailable('flow_read_unavailable')
      : eligibleSlot(issue, capture.features, 'withdraw'),
    supplies: failed
      ? unavailable('flow_read_unavailable')
      : eligibleSlot(issue, capture.features, 'supply'),
  }
  verifyIssueDirectFlowSnapshot({ ...issue, flowSnapshot: snapshot })
  return snapshot
}

/** Pure panel adapter: only issue-bound, schema-checked available features. */
export function flowFeaturesFromIssueSnapshot(issue) {
  const snapshot = verifyIssueDirectFlowSnapshot(issue)
  if (!snapshot) return []
  return [snapshot.withdrawals, snapshot.supplies]
    .filter((slot) => slot.status === 'available')
    .map((slot) => ({
      ...slot.feature,
      constituentRefs: slot.feature.constituentRefs.map((ref) => ({ ...ref })),
    }))
}
