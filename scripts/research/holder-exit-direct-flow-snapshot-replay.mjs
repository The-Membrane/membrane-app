// Exact-file offline replay for gross-flow features sealed into a holder issue.
// Local publication clocks remain unwitnessed; this only proves that the
// archived bytes reproduce the frozen issue-time feature.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  DIRECT_SUPPLIER_FLOW_DIR,
  DIRECT_SUPPLIER_MARKETS,
} from '../lib/carry-direct-supplier-flow-summary.mjs'
import {
  STUDY_V2,
  SUPPLY_STUDY_V2,
  verifyDirectSupplierFlowSegments,
} from './collect-carry-direct-supplier-flow.mjs'
import { directSupplierFlowPublicationWitnessPath } from './carry-direct-supplier-flow-publication-witness.mjs'
import {
  directFlowFeaturesFromVerifiedSuffix,
  MAX_DIRECT_FLOW_FEATURE_BYTES,
} from './holder-exit-direct-flow-features.mjs'
import { verifyIssueDirectFlowSnapshot } from './holder-exit-direct-flow-issue-snapshot.mjs'

const MAX_SEGMENTS_PER_FLOW = 144
const MAX_SEGMENT_BYTES = 2 * 1024 ** 2
const MAX_WITNESS_BYTES = 2 * 1024
const SHA = /^[0-9a-f]{64}$/
const WITNESS_STUDY = 'carry-direct-supplier-flow-publication-witness-v1'
const fail = (condition, reason) => {
  if (!condition) throw new Error(`holder_direct_flow_replay_${reason}`)
}
const digest = (value) => createHash('sha256').update(value).digest('hex')

function utcMs(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value ? ms : NaN
}

function readPinnedCanonicalFile(path, remainingBytes, maxFileBytes, kind) {
  let fd
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new Error(`holder_direct_flow_replay_${kind}_open_invalid`)
    }
    const stat = fstatSync(fd)
    fail(
      stat.isFile() && stat.size > 0 && stat.size <= maxFileBytes && stat.size <= remainingBytes,
      `${kind}_size_invalid`,
    )
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      fail(count > 0, `${kind}_read_invalid`)
      offset += count
    }
    fail(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0, `${kind}_read_invalid`)
    let document
    try {
      document = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error(`holder_direct_flow_replay_${kind}_json_invalid`)
    }
    fail(
      bytes.equals(Buffer.from(`${JSON.stringify(document)}\n`, 'utf8')),
      `${kind}_canonical_invalid`,
    )
    return { document, bytes: stat.size, fileSha256: digest(bytes) }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readPinnedWitness(segmentPath, segment, segmentFileSha256, remainingBytes) {
  const read = readPinnedCanonicalFile(
    directSupplierFlowPublicationWitnessPath(segmentPath),
    remainingBytes,
    MAX_WITNESS_BYTES,
    'witness',
  )
  if (!read) return null
  const witness = read.document
  fail(
    witness &&
      typeof witness === 'object' &&
      !Array.isArray(witness) &&
      Object.keys(witness).sort().join('|') ===
        [
          'study',
          'segmentFileName',
          'segmentSha256',
          'segmentFileSha256',
          'captureCompletedAt',
          'firstLocalReceiptAt',
          'sha256',
        ]
          .sort()
          .join('|'),
    'witness_fields_invalid',
  )
  const { sha256, ...body } = witness
  fail(SHA.test(sha256) && sha256 === digest(JSON.stringify(body)), 'witness_digest_invalid')
  fail(
    body.study === WITNESS_STUDY &&
      body.segmentFileName === basename(segmentPath) &&
      body.segmentSha256 === segment.sha256 &&
      body.segmentFileSha256 === segmentFileSha256 &&
      body.captureCompletedAt === segment.captureCompletedAt &&
      Number.isSafeInteger(utcMs(body.firstLocalReceiptAt)) &&
      utcMs(body.firstLocalReceiptAt) >= utcMs(segment.captureCompletedAt),
    'witness_identity_mismatch',
  )
  return {
    bytes: read.bytes,
    status: 'local_publication_witness',
    clockBasis: 'local_operator_clock_unwitnessed',
    prospectiveValidation: false,
    witnessSha256: sha256,
    segmentSha256: segment.sha256,
    firstLocalReceiptAt: body.firstLocalReceiptAt,
  }
}

function replayFlowSlot(issue, flowKind, feature, directory) {
  const refs = feature.constituentRefs
  fail(refs.length > 0 && refs.length <= MAX_SEGMENTS_PER_FLOW, 'segment_count_invalid')
  const expectedStudy = flowKind === 'supply' ? SUPPLY_STUDY_V2 : STUDY_V2
  const prefix = flowKind === 'supply' ? 'supply-' : ''
  const selected = []
  const presentDocuments = []
  const witnesses = []
  let bytes = 0
  let missing = false
  for (const ref of refs) {
    const name = `${prefix}${issue.marketKey}-${ref.fromBlock}-${ref.toBlock}.json`
    const path = join(directory, name)
    const read = readPinnedCanonicalFile(
      path,
      MAX_DIRECT_FLOW_FEATURE_BYTES - bytes,
      MAX_SEGMENT_BYTES,
      'segment',
    )
    if (!read) {
      missing = true
      continue
    }
    bytes += read.bytes
    const { document } = read
    fail(
      document?.study === expectedStudy &&
        document.marketKey === issue.marketKey &&
        document.range?.fromBlock === ref.fromBlock &&
        document.range?.toBlock === ref.toBlock &&
        SHA.test(document.sha256 ?? '') &&
        document.sha256 === ref.segmentSha256 &&
        document.captureCompletedAt === ref.captureCompletedAt,
      'segment_identity_mismatch',
    )
    presentDocuments.push(document)
    const witness = readPinnedWitness(
      path,
      document,
      read.fileSha256,
      MAX_DIRECT_FLOW_FEATURE_BYTES - bytes,
    )
    if (!witness) {
      missing = true
      continue
    }
    bytes += witness.bytes
    fail(
      witness.status === 'local_publication_witness' &&
        witness.witnessSha256 === ref.publicationWitnessSha256 &&
        witness.segmentSha256 === ref.segmentSha256 &&
        witness.firstLocalReceiptAt === ref.firstLocalReceiptAt,
      'publication_witness_mismatch',
    )
    selected.push({ path, document })
    witnesses.push(witness)
  }
  if (missing) {
    // An absence must never mask contradictory evidence already on disk.
    for (const document of presentDocuments) verifyDirectSupplierFlowSegments([document])
    return null
  }
  fail(selected.length === refs.length, 'segment_count_mismatch')
  const verified = verifyDirectSupplierFlowSegments(selected.map((item) => item.document))
  const rebuilt = directFlowFeaturesFromVerifiedSuffix({
    marketKey: issue.marketKey,
    flowKind,
    selected,
    verified,
    witnesses,
  }).at(-1)
  fail(rebuilt && isDeepStrictEqual(rebuilt, feature), 'feature_mismatch')
  return rebuilt
}

/**
 * Read only files named in an already verified issue; no directory scan, RPC,
 * writes, or reconstruction of an issue-time snapshot from the latest suffix.
 * Missing pinned evidence abstains the entire issue. Present contradictions
 * throw, including if another constituent is missing.
 */
export function readVerifiedIssueDirectFlowFeatures(
  issue,
  { directory = DIRECT_SUPPLIER_FLOW_DIR } = {},
) {
  const snapshot = verifyIssueDirectFlowSnapshot(issue)
  if (!snapshot)
    return { features: [], status: 'unavailable', reason: 'issue_has_no_flow_snapshot' }
  fail(
    Object.hasOwn(DIRECT_SUPPLIER_MARKETS, issue.marketKey) &&
      /^[A-Za-z][A-Za-z0-9_]*$/.test(issue.marketKey),
    'market_invalid',
  )
  const available = [
    ['withdraw', snapshot.withdrawals],
    ['supply', snapshot.supplies],
  ].filter(([, slot]) => slot.status === 'available')
  if (!available.length)
    return { features: [], status: 'unavailable', reason: 'no_available_flow_slot' }

  const features = []
  let missing = false
  for (const [flowKind, slot] of available) {
    const feature = replayFlowSlot(issue, flowKind, slot.feature, directory)
    if (feature) features.push(feature)
    else missing = true
  }
  if (missing)
    return {
      features: [],
      status: 'unavailable',
      reason: 'pinned_direct_flow_evidence_missing',
    }
  return { features, status: 'verified', reason: null }
}
