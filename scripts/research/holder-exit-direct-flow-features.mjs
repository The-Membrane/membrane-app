// Bounded, read-only gross-flow context for exact direct-supplier holder issues.
// A local publication witness is an operator clock, never prospective validation.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  DIRECT_SUPPLIER_FLOW_DIR,
  DIRECT_SUPPLIER_MARKETS,
} from '../lib/carry-direct-supplier-flow-summary.mjs'
import {
  STUDY,
  STUDY_V2,
  SUPPLY_STUDY,
  SUPPLY_STUDY_V2,
  verifyDirectSupplierFlowSegments,
} from './collect-carry-direct-supplier-flow.mjs'
import { readDirectSupplierFlowPublicationWitness } from './carry-direct-supplier-flow-publication-witness.mjs'

const DAY_MS = 86_400_000
const MAX_SEGMENTS = 144
const MAX_FILE_BYTES = 2 * 1024 ** 2
// Historical Aave USDC 24h windows reached 15.75 MiB across 113–116 segments.
// Keep a bounded margin for V2 capture fields and exact publication receipts.
export const MAX_DIRECT_FLOW_FEATURE_BYTES = 24 * 1024 ** 2
const SHA = /^[0-9a-f]{64}$/
const fail = (condition, reason) => {
  if (!condition) throw new Error(`holder_direct_flow_${reason}`)
}
const digest = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')

/** Canonical binding for the derived value and every exact contributing file. */
export function directFlowFeatureReceiptSha256(feature, marketKey, flowKind) {
  return digest({
    study: 'holder-direct-flow-24h-feature-v2',
    marketKey,
    flowKind,
    routeKey: feature.routeKey,
    destination: feature.destination,
    asset: feature.asset,
    startMs: Date.parse(feature.windowStartAt),
    endMs: Date.parse(feature.windowEndAt),
    sourceBlock: feature.sourceBlock,
    sourceBlockHash: feature.sourceBlockHash,
    sourceAt: feature.sourceAt,
    completedAtUtc: feature.completedAtUtc,
    firstLocalReceiptAt: feature.firstLocalReceiptAt,
    valueRaw: feature.valueRaw,
    segments: feature.constituentRefs,
  })
}

function frozenSubject(marketKey) {
  const market = DIRECT_SUPPLIER_MARKETS[marketKey]
  fail(market, 'market_unsupported')
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (item) => item.kind === market.kind && item.routeKey === market.routeKey,
  )
  fail(route, 'frozen_subject_missing')
  return { routeKey: route.routeKey, destination: route.destination, asset: route.asset }
}

function segmentEntries(directory, marketKey, flowKind) {
  const prefix = `${flowKind === 'supply' ? 'supply-' : ''}${marketKey}-`
  const pattern = new RegExp(`^${prefix}(0|[1-9][0-9]*)-(0|[1-9][0-9]*)\\.json$`)
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const match = pattern.exec(name)
      fail(match, 'filename_invalid')
      const fromBlock = Number(match[1])
      const toBlock = Number(match[2])
      fail(
        Number.isSafeInteger(fromBlock) && Number.isSafeInteger(toBlock) && toBlock >= fromBlock,
        'filename_invalid',
      )
      return { name, fromBlock, toBlock }
    })
    .sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock)
}

function readBoundedDocument(path, remainingBytes) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const file = fstatSync(fd)
    fail(file.isFile() && file.size > 0 && file.size <= MAX_FILE_BYTES, 'file_invalid')
    if (file.size > remainingBytes) return null
    const raw = readFileSync(fd, 'utf8')
    fail(Buffer.byteLength(raw) === file.size, 'file_invalid')
    let document
    try {
      document = JSON.parse(raw)
    } catch {
      throw new Error('holder_direct_flow_json_invalid')
    }
    return { document, bytes: file.size }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Read only the newest contiguous V2 suffix for one exact frozen market and flow. */
export function readBoundedDirectFlowV2Suffix({
  marketKey,
  flowKind,
  directory = DIRECT_SUPPLIER_FLOW_DIR,
}) {
  frozenSubject(marketKey)
  fail(flowKind === 'withdraw' || flowKind === 'supply', 'flow_kind_invalid')
  const entries = segmentEntries(directory, marketKey, flowKind)
  const selected = []
  let bytes = 0
  let boundary = entries.length ? 'coverage_under_24h' : 'no_segments'
  for (let index = entries.length - 1; index >= 0 && selected.length < MAX_SEGMENTS; index--) {
    const entry = entries[index]
    if (selected.length && entry.toBlock + 1 !== selected.at(-1).entry.fromBlock) {
      boundary = 'source_gap'
      break
    }
    const path = join(directory, entry.name)
    const read = readBoundedDocument(path, MAX_DIRECT_FLOW_FEATURE_BYTES - bytes)
    if (!read) {
      boundary = 'byte_budget'
      break
    }
    fail(
      read.document.marketKey === marketKey &&
        read.document.range?.fromBlock === entry.fromBlock &&
        read.document.range?.toBlock === entry.toBlock &&
        SHA.test(read.document.sha256 ?? ''),
      'market_or_range_mismatch',
    )
    const expectedStudy = flowKind === 'supply' ? SUPPLY_STUDY_V2 : STUDY_V2
    if (read.document.study !== expectedStudy) {
      if (read.document.study === (flowKind === 'supply' ? SUPPLY_STUDY : STUDY)) {
        boundary = 'legacy_v1'
        break
      }
      throw new Error('holder_direct_flow_study_invalid')
    }
    selected.push({ entry, path, document: read.document })
    bytes += read.bytes
  }
  if (selected.length === MAX_SEGMENTS) boundary = 'segment_budget'
  return { selected: selected.reverse(), boundary, bytes }
}

function lowerBound(events, timestampMs) {
  let low = 0
  let high = events.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (events[middle].timestampMs < timestampMs) low = middle + 1
    else high = middle
  }
  return low
}

/** All records must already have passed the full exact-market segment verifier. */
export function directFlowFeaturesFromVerifiedSuffix({
  marketKey,
  flowKind,
  selected,
  verified,
  witnesses,
}) {
  const subject = frozenSubject(marketKey)
  fail(flowKind === 'withdraw' || flowKind === 'supply', 'flow_kind_invalid')
  fail(
    Array.isArray(selected) &&
      selected.length > 0 &&
      selected.length <= MAX_SEGMENTS &&
      Array.isArray(witnesses) &&
      witnesses.length === selected.length &&
      verified?.coverage?.marketKey === marketKey &&
      Array.isArray(verified.coverage.intervals) &&
      verified.coverage.intervals.length === selected.length,
    'verified_input_invalid',
  )
  const intervals = verified.coverage.intervals
  const sourceRows = flowKind === 'supply' ? verified.supplies : verified.withdrawals
  fail(Array.isArray(sourceRows), 'verified_events_invalid')
  const events = sourceRows
    .map((row) => {
      const amount = row?.reconciliation?.evidence?.amountRaw
      fail(
        row?.marketKey === marketKey &&
          Number.isSafeInteger(row.timestampMs) &&
          typeof amount === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(amount),
        'verified_event_invalid',
      )
      return { timestampMs: row.timestampMs, amount: BigInt(amount) }
    })
    .sort((a, b) => a.timestampMs - b.timestampMs)
  const prefix = [0n]
  for (const event of events) prefix.push(prefix.at(-1) + event.amount)

  const features = []
  let startIndex = 0
  for (let endIndex = 0; endIndex < selected.length; endIndex++) {
    const endMs = intervals[endIndex].endMs
    const startMs = endMs - DAY_MS
    if (startMs < intervals[0].startMs) continue
    while (startIndex < endIndex && intervals[startIndex].endMs <= startMs) startIndex++
    const contributing = selected.slice(startIndex, endIndex + 1)
    const covered = intervals
      .slice(startIndex, endIndex + 1)
      .every(
        (item, index, rows) =>
          item.finalized === true &&
          item.receiptsComplete === true &&
          item.ambiguousReceipts === 0 &&
          item.startMs < item.endMs &&
          (index === 0 || rows[index - 1].endMs === item.startMs),
      )
    if (!covered || intervals[startIndex].startMs > startMs) continue
    const evidence = witnesses.slice(startIndex, endIndex + 1)
    if (
      evidence.some(
        (item) =>
          item?.status !== 'local_publication_witness' ||
          item.clockBasis !== 'local_operator_clock_unwitnessed' ||
          item.prospectiveValidation !== false ||
          !SHA.test(item.witnessSha256 ?? ''),
      )
    )
      continue
    const firstLocalReceiptAt = evidence.reduce(
      (latest, item) =>
        Date.parse(item.firstLocalReceiptAt) > Date.parse(latest)
          ? item.firstLocalReceiptAt
          : latest,
      evidence[0].firstLocalReceiptAt,
    )
    const completedAtUtc = contributing.reduce(
      (latest, item) =>
        Date.parse(item.document.captureCompletedAt) > Date.parse(latest)
          ? item.document.captureCompletedAt
          : latest,
      contributing[0].document.captureCompletedAt,
    )
    const left = lowerBound(events, startMs)
    const right = lowerBound(events, endMs)
    const last = contributing.at(-1)
    const feature = {
      kind: flowKind === 'supply' ? 'gross_supplier_supply_24h' : 'gross_supplier_withdraw_24h',
      ...subject,
      windowStartAt: new Date(startMs).toISOString(),
      windowEndAt: new Date(endMs).toISOString(),
      constituentRefs: contributing.map((item, index) => ({
        fromBlock: item.document.range.fromBlock,
        toBlock: item.document.range.toBlock,
        segmentSha256: item.document.sha256,
        publicationWitnessSha256: evidence[index].witnessSha256,
        captureCompletedAt: item.document.captureCompletedAt,
        firstLocalReceiptAt: evidence[index].firstLocalReceiptAt,
      })),
      collectionMode: 'historical_preissue',
      coverageComplete: true,
      sourceBlock: String(last.document.range.toBlock + 1),
      sourceBlockHash: last.document.blocks.at(-1).hash,
      sourceAt: new Date(endMs).toISOString(),
      firstLocalReceiptAt,
      completedAtUtc,
      valueRaw: (prefix[right] - prefix[left]).toString(),
      clockBasis: 'local_operator_clock_unwitnessed',
    }
    feature.receiptSha256 = directFlowFeatureReceiptSha256(feature, marketKey, flowKind)
    features.push(feature)
  }
  return features
}

/** One bounded pass per direct market and flow; no provider calls or writes. */
export function readVerifiedDirectFlowFeatures({
  directory = DIRECT_SUPPLIER_FLOW_DIR,
  marketKeys = Object.keys(DIRECT_SUPPLIER_MARKETS),
} = {}) {
  fail(Array.isArray(marketKeys) && marketKeys.length <= 4, 'markets_invalid')
  const features = []
  const sources = []
  for (const marketKey of marketKeys) {
    frozenSubject(marketKey)
    for (const flowKind of ['withdraw', 'supply']) {
      const suffix = readBoundedDirectFlowV2Suffix({ marketKey, flowKind, directory })
      if (!suffix.selected.length) {
        sources.push({ marketKey, flowKind, featureCount: 0, reason: suffix.boundary })
        continue
      }
      // The full replay checks sealed paired logs, receipts, exact-market filters,
      // finality, chain continuity, and V2 capture clocks before any feature.
      const verified = verifyDirectSupplierFlowSegments(
        suffix.selected.map((item) => item.document),
      )
      const witnesses = suffix.selected.map((item) =>
        readDirectSupplierFlowPublicationWitness(item.path, item.document),
      )
      const produced = directFlowFeaturesFromVerifiedSuffix({
        marketKey,
        flowKind,
        selected: suffix.selected,
        verified,
        witnesses,
      })
      features.push(...produced)
      sources.push({
        marketKey,
        flowKind,
        featureCount: produced.length,
        reason:
          produced.length > 0
            ? null
            : witnesses.some((item) => item.status !== 'local_publication_witness')
              ? 'post_publication_witness_missing'
              : 'coverage_under_24h_or_incomplete',
        segmentCount: suffix.selected.length,
        boundary: suffix.boundary,
      })
    }
  }
  return {
    features,
    sources,
    clockBasis: 'local_operator_clock_unwitnessed',
    forecastValidated: false,
  }
}
