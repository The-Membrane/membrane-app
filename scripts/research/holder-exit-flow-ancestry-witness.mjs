// Read-only source→baseline parent-link evidence for a V2 direct-supplier flow feature.
// The saved tuples were compared through two caller-supplied origins. They are
// not a trustless cryptographic proof that a header hashes to its claimed hash,
// and they do not independently witness any UTC or publication clock.
import { createHash } from 'node:crypto'

export const FLOW_ANCESTRY_SCHEMA = 'holder_exit_direct_flow_ancestry_witness_v1'
export const MAX_FLOW_ANCESTRY_GAP = 256
export const MAX_FLOW_ANCESTRY_WITNESS_BYTES = 64 * 1024

const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const SHA = /^[0-9a-f]{64}$/
const HEADER_FIELDS = ['number', 'hash', 'parentHash']
const WITNESS_FIELDS = [
  'schema',
  'evidenceKind',
  'sourceBlock',
  'sourceBlockHash',
  'baselineBlock',
  'baselineHash',
  'baselineParentHash',
  'originCount',
  'trustlessHeaderHashProof',
  'utcWitnessed',
  'headers',
  'witnessSha256',
]

const exactFields = (value, expected) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...expected].sort().join('|')

function blockNumber(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string' || (!DECIMAL.test(value) && !/^0x[0-9a-f]+$/.test(value)))
    return null
  const number = BigInt(value)
  return number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : null
}

function anchors(issue, feature) {
  if (!feature) return { status: 'abstained', reason: 'no_source' }
  const source = feature.sourceBlock
  const baseline = issue?.baseline?.targetBlock
  const targetHeader = issue?.baseline?.canonicalityEvidenceDoc?.targetHeader
  const parentHeader = issue?.baseline?.canonicalityEvidenceDoc?.parentHeader
  const sourceNumber = blockNumber(source)
  const baselineNumber = blockNumber(baseline)
  if (
    typeof source !== 'string' ||
    !DECIMAL.test(source) ||
    typeof baseline !== 'string' ||
    !DECIMAL.test(baseline) ||
    sourceNumber === null ||
    baselineNumber === null ||
    baselineNumber < 1 ||
    !HASH.test(feature.sourceBlockHash ?? '') ||
    !HASH.test(issue.baseline.targetHash ?? '') ||
    !HASH.test(issue.baseline.targetParentHash ?? '') ||
    targetHeader?.number !== baseline ||
    targetHeader?.hash !== issue.baseline.targetHash ||
    targetHeader?.parentHash !== issue.baseline.targetParentHash ||
    issue.baseline.targetParentBlock !== String(baselineNumber - 1) ||
    parentHeader?.number !== issue.baseline.targetParentBlock ||
    parentHeader?.hash !== issue.baseline.targetParentHash ||
    !HASH.test(parentHeader?.parentHash ?? '')
  )
    return { status: 'abstained', reason: 'anchor_invalid' }
  if (sourceNumber > baselineNumber) return { status: 'abstained', reason: 'source_after_baseline' }
  const gap = baselineNumber - sourceNumber
  if (gap > MAX_FLOW_ANCESTRY_GAP) return { status: 'abstained', reason: 'gap_over_limit' }
  return { status: 'ready', sourceNumber, baselineNumber, gap }
}

function minimalHeader(raw) {
  const number = blockNumber(raw?.number)
  const hash = typeof raw?.hash === 'string' ? raw.hash.toLowerCase() : null
  const parentHash = typeof raw?.parentHash === 'string' ? raw.parentHash.toLowerCase() : null
  if (number === null || !HASH.test(hash ?? '') || !HASH.test(parentHash ?? '')) return null
  return { number: String(number), hash, parentHash }
}

function payload(witness) {
  return {
    schema: witness.schema,
    evidenceKind: witness.evidenceKind,
    sourceBlock: witness.sourceBlock,
    sourceBlockHash: witness.sourceBlockHash,
    baselineBlock: witness.baselineBlock,
    baselineHash: witness.baselineHash,
    baselineParentHash: witness.baselineParentHash,
    originCount: witness.originCount,
    trustlessHeaderHashProof: witness.trustlessHeaderHashProof,
    utcWitnessed: witness.utcWitnessed,
    headers: witness.headers,
  }
}

function digest(witness) {
  return createHash('sha256')
    .update(JSON.stringify(payload(witness)))
    .digest('hex')
}

function serializedBytes(value) {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? Buffer.byteLength(serialized) : null
  } catch {
    return null
  }
}

/**
 * Offline consistency check against the issue and frozen feature anchors.
 * This checks parent links and the local tuple digest; it cannot independently
 * recreate the two RPC observations or hash full Ethereum headers.
 */
export function verifyDirectFlowAncestryWitness({ issue, feature, witness }) {
  const anchor = anchors(issue, feature)
  if (anchor.status !== 'ready') return anchor
  if (!witness) return { status: 'rejected', reason: 'witness_missing' }
  const bytes = serializedBytes(witness)
  if (bytes === null) return { status: 'rejected', reason: 'witness_shape_invalid' }
  if (bytes > MAX_FLOW_ANCESTRY_WITNESS_BYTES)
    return { status: 'rejected', reason: 'witness_over_limit' }
  if (
    !exactFields(witness, WITNESS_FIELDS) ||
    witness.schema !== FLOW_ANCESTRY_SCHEMA ||
    witness.evidenceKind !== 'two_origin_attested_parent_links' ||
    witness.originCount !== 2 ||
    witness.trustlessHeaderHashProof !== false ||
    witness.utcWitnessed !== false ||
    !Array.isArray(witness.headers) ||
    witness.headers.length !== Math.max(anchor.gap - 1, 0) ||
    !SHA.test(witness.witnessSha256 ?? '')
  )
    return { status: 'rejected', reason: 'witness_shape_invalid' }
  if (
    witness.sourceBlock !== feature.sourceBlock ||
    witness.sourceBlockHash !== feature.sourceBlockHash ||
    witness.baselineBlock !== issue.baseline.targetBlock ||
    witness.baselineHash !== issue.baseline.targetHash ||
    witness.baselineParentHash !== issue.baseline.targetParentHash
  )
    return { status: 'rejected', reason: 'anchor_mismatch' }
  if (witness.witnessSha256 !== digest(witness))
    return { status: 'rejected', reason: 'digest_mismatch' }

  let previousHash = witness.sourceBlockHash
  for (let index = 0; index < witness.headers.length; index++) {
    const item = witness.headers[index]
    if (
      !exactFields(item, HEADER_FIELDS) ||
      item.number !== String(anchor.sourceNumber + index + 1) ||
      !HASH.test(item.hash ?? '') ||
      !HASH.test(item.parentHash ?? '')
    )
      return { status: 'rejected', reason: 'header_invalid' }
    if (item.parentHash !== previousHash)
      return { status: 'rejected', reason: 'parent_link_mismatch' }
    previousHash = item.hash
  }
  if (
    (anchor.gap === 0 && witness.sourceBlockHash !== witness.baselineHash) ||
    (anchor.gap > 0 && previousHash !== witness.baselineParentHash)
  )
    return { status: 'rejected', reason: 'baseline_link_mismatch' }
  if (
    anchor.gap >= 2 &&
    witness.headers.at(-1).parentHash !==
      issue.baseline.canonicalityEvidenceDoc.parentHeader.parentHash
  )
    return { status: 'rejected', reason: 'anchor_mismatch' }
  return { status: 'consistent_parent_links', witnessSha256: witness.witnessSha256 }
}

/**
 * Query only the missing heights S+1..B-1, twice each. readHeader must map
 * origin indices 0 and 1 to genuinely independent origins; this helper has
 * no network access and cannot authenticate that mapping offline.
 */
export async function buildDirectFlowAncestryWitness({
  issue,
  feature,
  readHeader,
  maxWitnessBytes = MAX_FLOW_ANCESTRY_WITNESS_BYTES,
}) {
  const anchor = anchors(issue, feature)
  if (anchor.status !== 'ready') return anchor
  if (
    !Number.isSafeInteger(maxWitnessBytes) ||
    maxWitnessBytes < 1 ||
    maxWitnessBytes > MAX_FLOW_ANCESTRY_WITNESS_BYTES
  )
    return { status: 'abstained', reason: 'budget_invalid' }
  const headers = []
  for (let number = anchor.sourceNumber + 1; number < anchor.baselineNumber; number++) {
    if (typeof readHeader !== 'function')
      return { status: 'abstained', reason: 'reader_unavailable' }
    const reads = await Promise.allSettled([
      Promise.resolve().then(() => readHeader(number, 0)),
      Promise.resolve().then(() => readHeader(number, 1)),
    ])
    if (reads.some((read) => read.status !== 'fulfilled'))
      return { status: 'abstained', reason: 'header_read_failed' }
    const first = minimalHeader(reads[0].value)
    const second = minimalHeader(reads[1].value)
    if (!first || !second || first.number !== String(number) || second.number !== String(number))
      return { status: 'abstained', reason: 'header_invalid' }
    if (first.hash !== second.hash || first.parentHash !== second.parentHash)
      return { status: 'abstained', reason: 'origin_disagreement' }
    headers.push(first)
  }
  const witness = {
    schema: FLOW_ANCESTRY_SCHEMA,
    evidenceKind: 'two_origin_attested_parent_links',
    sourceBlock: feature.sourceBlock,
    sourceBlockHash: feature.sourceBlockHash,
    baselineBlock: issue.baseline.targetBlock,
    baselineHash: issue.baseline.targetHash,
    baselineParentHash: issue.baseline.targetParentHash,
    originCount: 2,
    trustlessHeaderHashProof: false,
    utcWitnessed: false,
    headers,
  }
  witness.witnessSha256 = digest(witness)
  if (serializedBytes(witness) > maxWitnessBytes)
    return { status: 'abstained', reason: 'witness_over_limit' }
  const checked = verifyDirectFlowAncestryWitness({ issue, feature, witness })
  if (checked.status !== 'consistent_parent_links')
    return { status: 'abstained', reason: checked.reason }
  return { status: 'attested_parent_links', witness }
}
