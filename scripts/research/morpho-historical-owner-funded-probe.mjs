/** Manual CURRENT observations from fixed historical hints. Importing starts no jobs. */
import { createHash, randomUUID } from 'node:crypto'
import {
  constants, openSync, closeSync, readSync, writeSync, fsyncSync,
  fstatSync, lstatSync, statfsSync, mkdirSync,
} from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import * as holderOriginCodeModule from '../../lib/carry/holderOriginCode.ts'
import {
  configuredUsd3HypotheticalOrigins, createUsd3HypotheticalCaptureControl,
  parseUsd3HypotheticalJson,
} from './usd3-hypothetical-history-capture.mjs'
import {
  decodeProbeHeader, probeNativeCall, pairedProbeResult, decodeProbeWord,
  assertFundedHolderProbePrivacy, verifyProbeControl,
} from './morpho-observed-funded-holder-probe.mjs'
import {
  MORPHO_PROBE_ROW_STORAGE_SCHEMA, encodeMorphoProbeNativeRow, decodeMorphoProbeNativeRow,
  encodedMorphoProbeRowOverheadBytes, morphoProbeEncodedRawResponseBytes,
  serializeMorphoProbeStorageValue,
} from './morpho-probe-raw-body-storage.mjs'

const isEoaTransactionOriginCode = holderOriginCodeModule.isEoaTransactionOriginCode ??
  holderOriginCodeModule.default?.isEoaTransactionOriginCode
if (typeof isEoaTransactionOriginCode !== 'function') throw new Error('holder_origin_helper_export')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const PLAN_PATH = 'scripts/research/morpho-historical-owner-funded-probe.plan.json'
export const PLAN_SHA = '7299eba2d257a11c8c29ce5bee351b54c28618526af16f96c87fab66bc102822'
const OWN_PATH = 'scripts/research/morpho-historical-owner-funded-probe.mjs'
const MB = 1024 * 1024, ZERO = '0x' + '0'.repeat(40)
const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x(?:[0-9a-f]{2})*$/
const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
const preparedInstances = new WeakSet()
export const HISTORICAL_OWNER_POLICY = Object.freeze({
  starts: 100, plannedStarts: 92, deadline: 120000, stage: 12000, timeout: 8000,
  spacing: 250, workers: 1, retries: 0, response: 65536, file: 8 * MB,
  cohort: 10 * MB, source: 6 * MB, report: 32768, terminal: 65536,
  rawAggregate: 5 * MB, retainedRawAggregate: 5 * MB + 65536,
  rowOverhead: 8192, fixedStorage: 2 * MB, controlSummary: 65536,
  files: 131, allocationUnit: 4096, fileAllocationMargin: 8192,
  allocationSlack: 3 * MB, directoryAllocationMargin: 8192,
  pre: 269 * MB, reserve: 256 * MB,
})
const POLICY = HISTORICAL_OWNER_POLICY
export const HISTORICAL_OWNER_FLAGS = Object.freeze({
  researchOnly: true, authenticated: false, originalAuthority: false,
  historicalOwnership: false, currentWalletControl: false, profileApproval: false,
  sourceImplementationEquivalence: false, holderExecutableExit: false,
  forecastEligibility: false, calibrated: false, coveragePromotion: false, competingMRaw: null,
})
const FLAGS = HISTORICAL_OWNER_FLAGS
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (ok, reason) => { if (!ok) throw Error('morpho_historical_owner_probe_' + reason) }
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const utc = (time) => new Date(time).toISOString()
export function roundedHistoricalOwnerAllocation(bytes) {
  check(Number.isSafeInteger(bytes) && bytes >= 0, 'allocation_bytes')
  return Math.ceil(bytes / POLICY.allocationUnit) * POLICY.allocationUnit
}
export function assertHistoricalOwnerDiskCapacity(free, bytes = 0, terminal = false, preflight = false) {
  check(typeof free === 'bigint' && free >= 0n && Number.isSafeInteger(bytes) && bytes >= 0,
    'disk_capacity_shape')
  if (preflight) check(free >= BigInt(POLICY.pre), 'disk_preflight')
  const pendingAllocation = roundedHistoricalOwnerAllocation(bytes) + POLICY.fileAllocationMargin
  const reservedTerminal = terminal ? 0 : roundedHistoricalOwnerAllocation(POLICY.terminal) + POLICY.fileAllocationMargin
  check(free >= BigInt(POLICY.reserve + pendingAllocation + reservedTerminal), 'disk_reserve')
  return true
}
export function qualifyHistoricalOwnerPostRetentionAvailability({ availableAtMs, elapsedMs, freeBytes, source, complete }) {
  check(Number.isSafeInteger(availableAtMs) && Number.isFinite(elapsedMs) && elapsedMs >= 0 &&
    elapsedMs <= POLICY.deadline, 'retention_deadline')
  check(typeof freeBytes === 'bigint' && freeBytes >= BigInt(POLICY.reserve), 'post_retention_reserve')
  if (complete) {
    const sourceAtMs = Date.parse(source?.blockTime)
    check(Number.isSafeInteger(sourceAtMs) && availableAtMs - sourceAtMs >= 0 &&
      availableAtMs - sourceAtMs <= 1800000, 'post_retention_source_age')
  }
  return utc(availableAtMs)
}
function guard(bytes = 0, terminal = false, preflight = false) {
  const disk = statfsSync(ROOT, { bigint: true }), free = disk.bavail * disk.bsize
  check(disk.bsize > 0n && disk.bsize <= BigInt(POLICY.allocationUnit) &&
    BigInt(POLICY.allocationUnit) % disk.bsize === 0n, 'disk_allocation_unit')
  return assertHistoricalOwnerDiskCapacity(free, bytes, terminal, preflight)
}
function fixedPath(relative) {
  check(typeof relative === 'string' && !relative.startsWith('/') &&
    !relative.includes('..') && !relative.includes('\\') && !relative.includes('://'), 'fixed_path')
  const path = resolve(ROOT, relative)
  let parent = dirname(path)
  while (parent !== ROOT) {
    const stat = lstatSync(parent)
    check(parent.startsWith(ROOT + '/') && stat.isDirectory() && !stat.isSymbolicLink(), 'parent_identity')
    parent = dirname(parent)
  }
  return path
}
function readBytes(path, cap, budget) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd, { bigint: true })
    check(before.isFile() && before.size > 0n && before.size <= BigInt(cap) &&
      budget.bytes + Number(before.size) <= budget.maximum, 'read_size')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let used = 0
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null)
      if (!count) break
      used += count
      check(used <= cap, 'read_cap')
    }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true })
    check(named.isFile() && !named.isSymbolicLink() && BigInt(used) === after.size &&
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) =>
        before[key] === after[key] && after[key] === named[key]), 'read_identity')
    budget.bytes += used
    return bytes.subarray(0, used)
  } finally { closeSync(fd) }
}
function readPin(pin, budget) {
  check(pin && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 &&
    /^[0-9a-f]{64}$/.test(pin.fileSha256), 'pin_shape')
  const bytes = readBytes(fixedPath(pin.path), Math.min(pin.bytes, POLICY.file), budget)
  check(bytes.length === pin.bytes && sha(bytes) === pin.fileSha256, 'file_pin')
  return bytes
}
/** Event amounts select hints only: Deposit shares, Withdraw burned shares, Transfer mint value. */
export function validateHistoricalOwnerLead(bytes, pin, subject, candidate, rules) {
  check(Buffer.isBuffer(bytes) && bytes.length === pin.bytes && sha(bytes) === pin.fileSha256,
    'lead_file_pin')
  const bundle = parseUsd3HypotheticalJson(bytes.toString('utf8'))
  const lead = candidate.lead, rule = rules[lead.event]
  check(ADDRESS.test(candidate.owner) && candidate.owner !== ZERO &&
    candidate.owner !== subject.vault && lead.originalPath === pin.path &&
    lead.historicalHintOnly === true && rule && lead.selector === rule.selector &&
    lead.ownerTopicIndex === rule.ownerTopicIndex, 'lead_rule')
  let occurrence
  if (lead.format === 'paired_bundle') {
    const { sha256, ...body } = bundle
    check(sha(JSON.stringify(body)) === sha256 && bytes.toString('utf8') === JSON.stringify(bundle) + '\n' &&
      bundle.kind === 'bundle' && bundle.chainId === 1 && bundle.researchOnly === true &&
      bundle.holderExecutableExit === false && lead.selectorDeclaredOnly === false &&
      lead.pairedEventHeaders === true && ['Deposit', 'Withdraw'].includes(lead.event), 'lead_seal')
    const matches = []
    for (const slice of bundle.slices) {
      check(Array.isArray(slice.witnesses) && slice.witnesses.length === 2 &&
        same([...slice.witnesses.map((w) => w.origin)].sort(), [...HOSTS].sort()) &&
        same(slice.witnesses[0].raw, slice.witnesses[1].raw) &&
        same(slice.witnesses[0].eventHeaders, slice.witnesses[1].eventHeaders), 'lead_pair')
      for (const row of slice.witnesses[0].raw)
        if (same(row, lead.eventRow)) {
          check(row.address === subject.vault && row.topics.length === rule.ownerTopicIndex + 1 &&
            row.topics[0] === rule.selector &&
            row.topics.slice(1).every((topic) => /^0x0{24}[0-9a-f]{40}$/.test(topic)) &&
            '0x' + row.topics[rule.ownerTopicIndex].slice(-40) === candidate.owner &&
            new RegExp('^0x[0-9a-f]{' + rule.dataWords * 64 + '}$').test(row.data) &&
            BigInt('0x' + row.data.slice(-64)) > 0n && HASH.test(row.blockHash) &&
            HASH.test(row.transactionHash) && /^[1-9][0-9]*$/.test(row.blockNumber) &&
            Number.isSafeInteger(row.logIndex) && row.logIndex >= 0, 'lead_event_ABI')
          const header = slice.witnesses[0].eventHeaders.find((h) => h.block === row.blockNumber)
          check(same(header, lead.eventHeader) && header.hash === row.blockHash &&
            /^[1-9][0-9]*$/.test(header.timestamp), 'lead_event_header')
          matches.push(row)
        }
    }
    check(matches.length === 1, 'lead_absent_or_duplicate')
    occurrence = { ...lead.eventRow, header: lead.eventHeader }
  } else {
    check(lead.format === 'decoded_single_origin_transfer' && lead.event === 'Transfer' &&
      lead.selectorDeclaredOnly === true && lead.pairedEventHeaders === false &&
      lead.eventHeader === null && bundle.chainId === 1 && bundle.vault === subject.vault &&
      bundle.study === 'morpho-v2-full-cohort-transfer-prefix-v1' &&
      bundle.logs.filter((row) => same(row, lead.eventRow)).length === 1, 'decoded_transfer_hint')
    const row = lead.eventRow
    check(row.from === ZERO && row.to === candidate.owner &&
      /^[1-9][0-9]*$/.test(row.value) && BigInt(row.value) < (1n << 256n) &&
      HASH.test(row.blockHash) && HASH.test(row.txHash) && Number.isSafeInteger(row.block) &&
      row.block > 0 && Number.isSafeInteger(row.logIndex) && row.logIndex >= 0, 'decoded_mint_receiver')
    occurrence = { ...row, header: null }
  }
  return freeze({
    ...FLAGS, historicalHintOnly: true, historicalRemainingSharesKnown: false,
    currentBalanceKnown: false, historicalSelectorDeclaredOnly: lead.selectorDeclaredOnly,
    historicalPairedEventHeaders: lead.pairedEventHeaders,
    originalFileSha256: pin.fileSha256, event: lead.event,
    ownerField: lead.event === 'Withdraw' ? 'onBehalf' : 'receiver', occurrence,
  })
}
export function prepareMorphoHistoricalOwnerFundedProbe() {
  const budget = { bytes: 0, maximum: POLICY.cohort }
  const planBytes = readBytes(fixedPath(PLAN_PATH), 65536, budget)
  check(sha(planBytes) === PLAN_SHA, 'plan_pin')
  const plan = parseUsd3HypotheticalJson(planBytes.toString('utf8'))
  check(plan.schema === 'morpho_historical_owner_funded_probe_plan_v1' && plan.revision === 2 &&
    plan.chainId === 1 && same(plan.origins, HOSTS) && plan.subjects.length === 3 &&
    plan.subjects.every((s) => ADDRESS.test(s.vault) && ADDRESS.test(s.asset) &&
      s.shareDecimals === 18 && s.candidates.length === 3) &&
    new Set(plan.subjects.flatMap((s) => s.candidates.map((c) => c.owner))).size === 9 &&
    plan.budget.maximumPhysicalStarts === 100 && plan.budget.maximumPlannedPhysicalStarts === 92 &&
    plan.budget.maximumLogStarts === 0 && plan.budget.workers === 1 &&
    ['bootstrap', 'sourceBefore', 'identityAndRuntime', 'ownerCodeAndBalance',
      'positiveOwnerFullPreviews', 'sourceAfter'].reduce((n, k) => n + plan.budget[k], 0) === 92,
    'plan_bounds')
  const sources = plan.sourcePins.map((pin) => ({ pin, bytes: readPin(pin, budget) }))
  const own = readBytes(fixedPath(OWN_PATH), POLICY.source, budget)
  sources.push({ pin: freeze({ path: OWN_PATH, bytes: own.length, fileSha256: sha(own) }), bytes: own })
  check(sources.reduce((n, s) => n + s.bytes.length, 0) <= POLICY.source, 'source_cap')
  const originals = plan.leadOriginals.map((pin) => ({ pin, bytes: readPin(pin, budget) }))
  const leads = plan.subjects.flatMap((subject) => subject.candidates.map((candidate) => {
    const input = originals.find((s) => s.pin.path === candidate.lead.originalPath)
    check(input, 'lead_original')
    return { subjectId: subject.id, owner: candidate.owner,
      proof: validateHistoricalOwnerLead(input.bytes, input.pin, subject, candidate, plan.eventRules) }
  }))
  const result = Object.freeze({ plan: freeze(plan), planBytes,
    sources: Object.freeze(sources.map(Object.freeze)),
    originals: Object.freeze(originals.map(Object.freeze)), leads: freeze(leads) })
  // The same serializer used by the writer proves the fixed representation before acquisition.
  historicalOwnerStorageBudgetProof(result)
  preparedInstances.add(result)
  return result
}
function verifyPrepared(prepared) {
  check(preparedInstances.has(prepared), 'prepared_original')
  const budget = { bytes: 0, maximum: POLICY.cohort }
  const plan = readBytes(fixedPath(PLAN_PATH), 65536, budget)
  check(sha(plan) === PLAN_SHA && plan.equals(prepared.planBytes), 'plan_recheck')
  for (const entry of [...prepared.sources, ...prepared.originals])
    check(readPin(entry.pin, budget).equals(entry.bytes), 'source_recheck')
  check(prepared.sources.reduce((n, s) => n + s.bytes.length, 0) <= POLICY.source, 'source_cap')
  historicalOwnerStorageBudgetProof(prepared)
}
export function historicalOwnerFixedStorageArtifacts(prepared) {
  return [
    { name: 'plan.json', value: seal({ rawText: prepared.planBytes.toString('utf8'), fileSha256: PLAN_SHA, ...FLAGS }) },
    ...prepared.sources.map((source, index) => ({ name: 'source-' + index + '.json',
      value: seal({ pin: source.pin, sourceText: source.bytes.toString('utf8'), ...FLAGS }) })),
    ...prepared.originals.map((original, index) => ({ name: 'lead-original-' + index + '.json',
      value: seal({ pin: original.pin, rawText: original.bytes.toString('utf8'), historicalHintOnly: true, ...FLAGS }) })),
  ]
}
export function historicalOwnerStorageBudgetProof(prepared) {
  const fixed = historicalOwnerFixedStorageArtifacts(prepared)
  const fixedSerializedBytes = fixed.reduce((n, artifact) => n + serializeMorphoProbeStorageValue(artifact.value).length, 0)
  check(fixedSerializedBytes <= POLICY.fixedStorage &&
    fixed.every((artifact) => serializeMorphoProbeStorageValue(artifact.value).length <= POLICY.file), 'fixed_serialization_bound')
  // The immutable controller retains the single failed crossing row before enforcing its 5 MiB cap.
  const maximumBase64Bytes = 4 * Math.ceil(POLICY.retainedRawAggregate / 3) + 4 * (POLICY.starts - 1)
  const maximumFiles = fixed.length + POLICY.starts + 3
  const maximumLogicalBytes = fixedSerializedBytes + maximumBase64Bytes +
    POLICY.starts * POLICY.rowOverhead + POLICY.controlSummary + POLICY.report + POLICY.terminal
  const maximumAllocationExtra = maximumFiles *
    (POLICY.allocationUnit - 1 + POLICY.fileAllocationMargin) + POLICY.directoryAllocationMargin
  check(maximumLogicalBytes <= POLICY.cohort && maximumFiles <= POLICY.files && maximumFiles < 132 &&
    maximumAllocationExtra <= POLICY.allocationSlack &&
    POLICY.pre === POLICY.reserve + POLICY.cohort + POLICY.allocationSlack &&
    prepared.plan.storage?.schema === MORPHO_PROBE_ROW_STORAGE_SCHEMA &&
    prepared.plan.policy?.cohortBytes === POLICY.cohort && prepared.plan.policy?.preFreeBytes === POLICY.pre &&
    prepared.plan.sourcePins.some((p) => p.path === 'scripts/research/morpho-probe-raw-body-storage.mjs'), 'storage_budget_proof')
  return freeze({ schema: MORPHO_PROBE_ROW_STORAGE_SCHEMA, fixedSerializedBytes, fixedFiles: fixed.length,
    maximumAcceptedRawResponseBytes: POLICY.rawAggregate,
    maximumRetainedRawResponseBytes: POLICY.retainedRawAggregate, maximumBase64Bytes,
    maximumRowOverheadBytes: POLICY.starts * POLICY.rowOverhead,
    maximumLogicalBytes, maximumFiles, maximumAllocationExtra,
    logicalCohortCap: POLICY.cohort, allocationSlack: POLICY.allocationSlack })
}
function nativeStorageRecord(namespace, row, requests, settlements) {
  return { namespace, physicalId: row.physicalId,
    request: requests.find((request) => request.physicalId === row.physicalId) ?? null,
    observation: row, settlement: settlements.find((settlement) => settlement.physicalId === row.physicalId) ?? null, ...FLAGS }
}
function nativeStorageContext(record, source) {
  return { namespace: record.namespace, physicalId: record.physicalId, source,
    rowJsonSha256: sha(JSON.stringify(record)), observationJsonSha256: sha(JSON.stringify(record.observation)),
    settlementJsonSha256: sha(JSON.stringify(record.settlement)) }
}
/** Decode copies before invoking the immutable control verifier; native capture records are never changed. */
export function reconstructHistoricalOwnerProbeControl(receipt, requests, settlements, namespace, source) {
  const ledger = [], reconstructedSettlements = [], reconstructedRequests = []
  let rawBytes = 0
  check(receipt.ledger.length <= POLICY.starts, 'storage_row_count')
  for (const [index, row] of receipt.ledger.entries()) {
    const original = nativeStorageRecord(namespace, row, requests, settlements)
    const context = nativeStorageContext(original, source)
    const encoded = encodeMorphoProbeNativeRow(original, context)
    const before = rawBytes
    rawBytes += morphoProbeEncodedRawResponseBytes(encoded)
    check(rawBytes <= POLICY.rawAggregate ||
      (before <= POLICY.rawAggregate && rawBytes <= POLICY.retainedRawAggregate &&
        index === receipt.ledger.length - 1 && receipt.failure !== null && row.accepted === false && row.status === 'failed'),
      'aggregate_raw_bound')
    const restored = decodeMorphoProbeNativeRow(encoded, context)
    ledger.push(restored.observation)
    if (restored.request !== null) reconstructedRequests.push(restored.request)
    if (restored.settlement !== null) reconstructedSettlements.push(restored.settlement)
  }
  // These channels are retained even if a failed scheduled read never obtained a physical id.
  const unmatchedRequests = requests.filter((r) => !receipt.ledger.some((row) => row.physicalId === r.physicalId))
  const unmatchedSettlements = settlements.filter((s) => !receipt.ledger.some((row) => row.physicalId === s.physicalId))
  check(unmatchedRequests.length <= 1 && unmatchedSettlements.length === 0, 'unmatched_storage_bounds')
  reconstructedRequests.push(...structuredClone(unmatchedRequests))
  return { receipt: { ...receipt, ledger }, requests: reconstructedRequests, settlements: reconstructedSettlements,
    aggregateRawResponseBytes: rawBytes }
}
export function historicalOwnerCodeCall(key, owner, source) {
  check(ADDRESS.test(owner) && HASH.test(source.blockHash), 'owner_code_source')
  return { key, method: 'eth_getCode', params: [owner,
    { blockHash: source.blockHash, requireCanonical: true }] }
}
export function classifyHistoricalOwnerCode(rawCode) {
  check(typeof rawCode === 'string' && HEX.test(rawCode) && Buffer.byteLength(rawCode) <= POLICY.response,
    'owner_code_shape')
  const holderEoa = isEoaTransactionOriginCode(rawCode)
  return {
    rawCode, codeSha256: sha(rawCode), transactionOriginCodeCompatible: holderEoa,
    ownerCodeStatus: rawCode === '0x' ? 'no_code' : holderEoa ? 'eip7702_delegated' : 'contract_code',
    currentWalletControl: false, forecastEligibility: false,
  }
}
/** Code shape is separate from positive shares, and never proves possession of a signing key. */
export function deriveHistoricalOwnerFundedObservation(traces, subject, candidate, source, hosts = HOSTS) {
  check(subject.shareDecimals === 18 && Number.isInteger(subject.assetDecimals) &&
    subject.assetDecimals >= 0 && subject.assetDecimals <= 36 && ADDRESS.test(candidate.owner), 'units_owner')
  const owner = candidate.owner, codeKey = subject.id + ':ownerCode:' + owner
  const SKey = subject.id + ':S:' + owner, EaKey = subject.id + ':Ea:' + owner
  const exact = (key, expected) => {
    const rows = traces.filter((t) => t.key === key)
    check(rows.length === 2 && rows.every((t) => same(t.request, expected)), 'native_request_source')
    return pairedProbeResult(traces, key, hosts)
  }
  const code = classifyHistoricalOwnerCode(exact(codeKey, historicalOwnerCodeCall(codeKey, owner, source)))
  const S = decodeProbeWord(exact(SKey, probeNativeCall(SKey, subject.vault, 'balanceOf', [owner], source)))
  const quoteRows = traces.filter((t) => t.key === EaKey)
  let Ea = null
  if (S === '0') check(quoteRows.length === 0, 'zero_S_no_preview')
  else Ea = decodeProbeWord(exact(EaKey,
    probeNativeCall(EaKey, subject.vault, 'previewRedeem', [BigInt(S)], source)))
  return {
    ...FLAGS, subjectId: subject.id, vault: subject.vault, asset: subject.asset,
    shareDecimals: 18, assetDecimals: subject.assetDecimals, owner, ...code,
    sharesRaw: S, fullEaRaw: Ea, source, nativeBalanceObservedAtSource: true,
    historicalHintOnly: true, historicalRemainingSharesKnown: false,
    status: S === '0' ? 'zero_native_balance' : Ea === '0'
      ? 'paired_native_funded_balance_zero_entitlement' : 'paired_native_funded_balance',
  }
}
export function historicalOwnerCredentialVariants(origins) {
  const values = new Set(), generic = new Set(['', 'eth', 'ethereum', 'mainnet', 'rpc', 'api', 'v1', 'v2', 'v3', 'jsonrpc'])
  for (const origin of origins) {
    const url = new URL(origin.url)
    for (const value of [origin.url, ...[...url.searchParams].map(([, v]) => v),
      ...url.pathname.split('/').filter((p) => !generic.has(p.toLowerCase()))]) {
      let decoded = value
      try { decoded = decodeURIComponent(value) } catch {}
      for (const token of [value, decoded]) {
        if (!token) continue
        const unicode = [...token].map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')
        for (const v of [token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1),
          Buffer.from(token).toString('hex'), Buffer.from(token).toString('hex').toUpperCase(),
          Buffer.from(token).toString('base64'), unicode, unicode.toUpperCase().replaceAll('\\U', '\\u')])
          values.add(v)
      }
    }
  }
  check(values.size > 0 && values.size <= 128, 'privacy_variant_cap')
  return [...values]
}
export function assertHistoricalOwnerProbePrivacy(value, secrets) {
  // The shared descriptor walk checks raw body Base64 and parses JSON before examining escaped keys.
  assertFundedHolderProbePrivacy(value, secrets)
  let count = 0
  const visit = (input, depth = 0) => {
    check(++count <= 100000 && depth <= 32, 'privacy_bounds')
    if (typeof input === 'string') {
      // Inspect textual source escapes without executing source or invoking its descriptors.
      const decoded = input.replace(/\\+(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2}))/gi,
        (_match, wide, unicode, byte) => {
          const point = Number.parseInt(wide ?? unicode ?? byte, 16)
          return point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd'
        })
      if (decoded !== input) assertFundedHolderProbePrivacy(decoded, secrets)
      if (input.includes('\\')) {
        let parsed
        try { parsed = parseUsd3HypotheticalJson(input) } catch { return }
        assertFundedHolderProbePrivacy(parsed, secrets)
        visit(parsed, depth + 1)
      }
    } else if (input && typeof input === 'object')
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input)))
        if (Object.hasOwn(descriptor, 'value')) visit(descriptor.value, depth + 1)
  }
  visit(value)
  return true
}
function validateOrigins(origins) {
  check(Array.isArray(origins) && origins.length === 2 && same(origins.map((o) => o.host), HOSTS) &&
    origins.every((o) => {
      try {
        const url = new URL(o.url)
        return url.protocol === 'https:' && url.hostname === o.host && !url.username && !url.password && !url.hash
      } catch { return false }
    }), 'origins')
}
export async function captureMorphoHistoricalOwnerFundedProbe(prepared, origins, options = {}) {
  // Direct callers must pass the same real before-network preflight as the fixed CLI.
  guard(0, false, true)
  verifyPrepared(prepared)
  validateOrigins(origins)
  const { plan } = prepared, now = options.now ?? Date.now
  const clock = options.monotonic ?? (() => performance.now())
  const pace = options.pace ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const started = clock(), secrets = historicalOwnerCredentialVariants(origins)
  for (const value of [plan, ...prepared.sources.map((s) => ({ sourceText: s.bytes.toString('utf8') })),
    ...prepared.originals.map((s) => ({ rawText: s.bytes.toString('utf8') }))])
    assertHistoricalOwnerProbePrivacy(value, secrets)
  const control = createUsd3HypotheticalCaptureControl(origins, {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}), now, monotonic: clock, pace,
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
  })
  const namespace = 'historical-owner-native-' + randomUUID(), requests = [], traces = []
  let source = null, failure = null, scheduled = 0, outputs = []
  const deadline = () => check(clock() - started < POLICY.deadline, 'overall_deadline')
  const dispatch = async (origin, spec) => {
    deadline()
    check(scheduled < POLICY.starts && spec.method !== 'eth_getLogs', 'start_budget_or_method')
    const request = { jsonrpc: '2.0', id: ++scheduled, method: spec.method, params: spec.params }
    const body = JSON.stringify(request), record = {
      controlNamespace: namespace, physicalId: null, rpcId: request.id, key: spec.key,
      host: origin.host, requestBodyBase64: Buffer.from(body).toString('base64'), requestBodySha256: sha(body),
    }
    requests.push(record)
    const response = await control.fetcher(origin.url, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body,
    })
    const physicalId = Number(response.headers.get('x-usd3-physical-id'))
    check(Number.isSafeInteger(physicalId) && physicalId > 0, 'physical_id')
    record.physicalId = physicalId
    const envelope = parseUsd3HypotheticalJson(await response.text())
    check(!Object.hasOwn(envelope, 'error'), 'rpc_native_error')
    traces.push({ host: origin.host, key: spec.key, request: spec, envelope,
      physicalId, controlNamespace: namespace })
  }
  const group = async (name, specs) => {
    if (specs.length === 0) return
    control.beginStage(name)
    const began = clock()
    // Exactly one worker across both origins. Each required observation still has two raw reads.
    for (const spec of specs) for (const origin of origins) {
      check(clock() - began < POLICY.stage, 'stage_window')
      await dispatch(origin, spec)
    }
    check(clock() - began <= POLICY.stage, 'stage_window')
  }
  const header = (key, block) => ({ key, method: 'eth_getBlockByNumber', params: [block, false] })
  const native = (key, to, name, args = []) => probeNativeCall(key, to, name, args, source)
  const bracket = async (name) => {
    await group(name, [header(name, '0x' + BigInt(source.blockNumber).toString(16))])
    for (const host of HOSTS)
      check(same(decodeProbeHeader(traces.find((t) => t.host === host && t.key === name).envelope, now()), source),
        'source_bracket')
  }
  try {
    await group('bootstrap', [{ key: 'chain', method: 'eth_chainId', params: [] }, header('finalized', 'finalized')])
    check(pairedProbeResult(traces, 'chain', HOSTS) === '0x1', 'chain')
    const sources = HOSTS.map((host) => decodeProbeHeader(
      traces.find((t) => t.host === host && t.key === 'finalized').envelope, now()))
    check(same(sources[0], sources[1]), 'source_pair')
    source = sources[0]
    check(now() - Date.parse(source.blockTime) >= 0 && now() - Date.parse(source.blockTime) <= 1800000, 'source_age')
    await bracket('source_before')
    const block = { blockHash: source.blockHash, requireCanonical: true }
    for (const subject of plan.subjects) {
      await group('identity_' + subject.id, [
        { key: subject.id + ':vaultCode', method: 'eth_getCode', params: [subject.vault, block] },
        { key: subject.id + ':assetCode', method: 'eth_getCode', params: [subject.asset, block] },
        native(subject.id + ':asset', subject.vault, 'asset'),
        native(subject.id + ':shareDecimals', subject.vault, 'decimals'),
        native(subject.id + ':assetDecimals', subject.asset, 'decimals'),
      ])
      const assetWord = pairedProbeResult(traces, subject.id + ':asset', HOSTS)
      check(/^0x0{24}[0-9a-f]{40}$/.test(assetWord) && '0x' + assetWord.slice(-40) === subject.asset &&
        decodeProbeWord(pairedProbeResult(traces, subject.id + ':shareDecimals', HOSTS)) === '18' &&
        decodeProbeWord(pairedProbeResult(traces, subject.id + ':assetDecimals', HOSTS)) === String(subject.assetDecimals),
        'identity_units')
      for (const key of [':vaultCode', ':assetCode']) {
        const code = pairedProbeResult(traces, subject.id + key, HOSTS)
        check(typeof code === 'string' && HEX.test(code) && code !== '0x', 'runtime_presence')
      }
      await group('owners_' + subject.id, subject.candidates.flatMap((candidate) => [
        historicalOwnerCodeCall(subject.id + ':ownerCode:' + candidate.owner, candidate.owner, source),
        native(subject.id + ':S:' + candidate.owner, subject.vault, 'balanceOf', [candidate.owner]),
      ]))
      const quotes = subject.candidates.flatMap((candidate) => {
        const S = decodeProbeWord(pairedProbeResult(traces, subject.id + ':S:' + candidate.owner, HOSTS))
        return S === '0' ? [] : [native(subject.id + ':Ea:' + candidate.owner,
          subject.vault, 'previewRedeem', [BigInt(S)])]
      })
      await group('full_previews_' + subject.id, quotes)
      outputs.push(...subject.candidates.map((candidate) =>
        deriveHistoricalOwnerFundedObservation(traces, subject, candidate, source)))
    }
    await bracket('source_after')
    deadline()
  } catch (error) {
    failure = error instanceof Error && /^morpho_historical_owner_probe_[a-zA-Z0-9_]+$/.test(error.message)
      ? error.message : 'morpho_historical_owner_probe_native_unavailable'
    control.stop('historical_owner_probe_failed')
  }
  const receipt = await control.finish(), settlements = structuredClone(control.settlementReceipts)
  for (const request of requests) if (request.physicalId === null) {
    const row = receipt.ledger.find((r) => r.host === request.host && r.request.id === request.rpcId)
    if (row) request.physicalId = row.physicalId
  }
  if (!failure) try {
    check(receipt.physicalStarts === scheduled && scheduled <= POLICY.plannedStarts &&
      clock() - started <= POLICY.deadline && outputs.length === 9 &&
      now() - Date.parse(source.blockTime) <= 1800000, 'capture_final_bounds')
    const restored = reconstructHistoricalOwnerProbeControl(receipt, requests, settlements, namespace, source)
    check(same(restored.receipt, receipt) && same(restored.requests, requests) && same(restored.settlements, settlements),
      'lossless_reconstruction')
    verifyProbeControl(restored.receipt, restored.requests, restored.settlements, namespace)
    verifyPrepared(prepared)
  } catch { failure = 'morpho_historical_owner_probe_final_join_failed' }
  const capture = {
    ...FLAGS, complete: failure === null, failure, source, outputs,
    namespace, receipt, requests, settlements, scheduledReads: scheduled,
    physicalStarts: receipt.physicalStarts, nativeAcquisitionCompletedAtUtc: utc(now()),
    elapsedMs: clock() - started,
  }
  // Check every retained field in bounded pieces; Base64 + decoded JSON scans must not reject an admitted 5 MiB cohort.
  const { receipt: originalReceipt, settlements: originalSettlements, ...metadata } = capture
  const { ledger, ...receiptMetadata } = originalReceipt
  assertHistoricalOwnerProbePrivacy({ ...metadata, receipt: receiptMetadata }, secrets)
  for (const row of ledger) assertHistoricalOwnerProbePrivacy(row, secrets)
  for (const settlement of originalSettlements) assertHistoricalOwnerProbePrivacy(settlement, secrets)
  return capture
}
/** This separate prefix never reuses the immutable old producer's fixed-prefix writer. */
export function createHistoricalOwnerProbeWriter(out, secrets,
  { clock = () => performance.now(), started = performance.now() } = {}) {
  const parent = fixedPath('data/research/venue-signals')
  check(dirname(out) === parent && /^morpho-historical-owner-funded-probe-[A-Za-z0-9.-]+$/.test(basename(out)), 'output_root')
  guard()
  const parentBefore = lstatSync(parent)
  check(parentBefore.isDirectory() && !parentBefore.isSymbolicLink(), 'output_parent')
  mkdirSync(out, { mode: 0o700 })
  const made = lstatSync(out)
  check(made.isDirectory() && !made.isSymbolicLink() && (made.mode & 0o777) === 0o700, 'output_directory')
  const syncDirectory = (path) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  syncDirectory(parent)
  const identity = () => {
    const p = lstatSync(parent), d = lstatSync(out)
    check(p.isDirectory() && !p.isSymbolicLink() && p.dev === parentBefore.dev && p.ino === parentBefore.ino &&
      d.isDirectory() && !d.isSymbolicLink() && d.dev === made.dev && d.ino === made.ino &&
      (d.mode & 0o777) === 0o700, 'writer_directory_identity')
  }
  const deadline = () => check(clock() - started <= POLICY.deadline, 'retention_deadline')
  let bytes = 0, allocationBytes = 0, attemptedFiles = 0, fixedBytes = 0, rawResponseBytes = 0
  const refs = []
  const verifyRetained = () => {
    identity()
    for (const ref of refs) {
      const path = resolve(out, ref.file), stat = lstatSync(path)
      check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
        (stat.mode & 0o777) === 0o600 && stat.dev === ref.dev && stat.ino === ref.ino, 'retained_identity')
      const back = readBytes(path, ref.bytes, { bytes: 0, maximum: ref.bytes })
      check(back.length === ref.bytes && sha(back) === ref.fileSha256, 'retained_readback')
    }
    deadline()
  }
  return {
    refs, used: () => bytes, allocated: () => allocationBytes, filesAttempted: () => attemptedFiles, deadline, verifyRetained,
    write(name, value, terminal = false) {
      deadline(); identity()
      check(/^[a-z0-9_.-]{1,80}$/.test(name), 'artifact_name')
      assertHistoricalOwnerProbePrivacy(value, secrets)
      const data = serializeMorphoProbeStorageValue(value)
      check(data.length <= POLICY.file && (!terminal || data.length <= POLICY.terminal) &&
        bytes + data.length <= POLICY.cohort - (terminal ? 0 : POLICY.terminal) &&
        attemptedFiles + 1 <= POLICY.files - (terminal ? 0 : 1), 'write_cap')
      const fixed = /^(?:plan|source-[0-9]+|lead-original-[0-9]+)\.json$/.test(name)
      check(!fixed || fixedBytes + data.length <= POLICY.fixedStorage, 'fixed_storage_cap')
      if (name === 'control-summary.json') check(data.length <= POLICY.controlSummary, 'control_summary_cap')
      if (name === 'report.json') check(data.length <= POLICY.report, 'report_cap')
      let addedRawBytes = 0
      if (/^native-row-[0-9]{3}\.json$/.test(name)) {
        check(value.schema === MORPHO_PROBE_ROW_STORAGE_SCHEMA &&
          encodedMorphoProbeRowOverheadBytes(value) <= POLICY.rowOverhead, 'native_storage_overhead')
        addedRawBytes = morphoProbeEncodedRawResponseBytes(value)
        check(rawResponseBytes + addedRawBytes <= POLICY.rawAggregate ||
          (rawResponseBytes <= POLICY.rawAggregate && rawResponseBytes + addedRawBytes <= POLICY.retainedRawAggregate &&
            value.row.observation.accepted === false && value.row.observation.status === 'failed'), 'aggregate_raw_bound')
      }
      guard(data.length, terminal)
      const path = resolve(out, name), fd = openSync(path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      bytes += data.length
      allocationBytes += roundedHistoricalOwnerAllocation(data.length) + POLICY.fileAllocationMargin
      attemptedFiles++
      if (fixed) fixedBytes += data.length
      rawResponseBytes += addedRawBytes
      let after
      try {
        let count = 0
        while (count < data.length) {
          const written = writeSync(fd, data, count, data.length - count)
          check(written > 0, 'short_write'); count += written
        }
        fsyncSync(fd); syncDirectory(out)
        after = fstatSync(fd)
        const named = lstatSync(path)
        check(after.isFile() && named.isFile() && !named.isSymbolicLink() &&
          after.dev === named.dev && after.ino === named.ino && after.nlink === 1 && named.nlink === 1 &&
          after.size === data.length && named.size === data.length &&
          (after.mode & 0o777) === 0o600 && (named.mode & 0o777) === 0o600, 'postfsync_identity')
      } finally { closeSync(fd) }
      const back = readBytes(path, data.length, { bytes: 0, maximum: data.length })
      check(back.equals(data), 'write_readback')
      identity(); deadline()
      const ref = { file: name, bytes: data.length, fileSha256: sha(data), dev: after.dev, ino: after.ino }
      refs.push(ref)
      return ref
    },
  }
}
export async function runMorphoHistoricalOwnerFundedProbe(argv = process.argv.slice(2)) {
  check(argv.length === 0, 'fixed_CLI_no_options')
  guard(0, false, true)
  const started = performance.now(), prepared = prepareMorphoHistoricalOwnerFundedProbe()
  const origins = await configuredUsd3HypotheticalOrigins()
  const secrets = historicalOwnerCredentialVariants(origins)
  verifyPrepared(prepared)
  const capture = await captureMorphoHistoricalOwnerFundedProbe(prepared, origins)
  verifyPrepared(prepared)
  const out = resolve(ROOT, 'data/research/venue-signals/morpho-historical-owner-funded-probe-' +
    utc(Date.now()).replaceAll(':', '-') + '-' + randomUUID())
  const writer = createHistoricalOwnerProbeWriter(out, secrets, { started })
  try {
    const storageBudget = historicalOwnerStorageBudgetProof(prepared)
    for (const artifact of historicalOwnerFixedStorageArtifacts(prepared)) writer.write(artifact.name, artifact.value)
    const rowReferences = []
    for (const row of capture.receipt.ledger) {
      const original = nativeStorageRecord(capture.namespace, row, capture.requests, capture.settlements)
      const context = nativeStorageContext(original, capture.source)
      const encoded = encodeMorphoProbeNativeRow(original, context)
      check(same(decodeMorphoProbeNativeRow(encoded, context), original), 'lossless_retention_row')
      rowReferences.push(writer.write('native-row-' + String(row.physicalId).padStart(3, '0') + '.json', encoded))
    }
    const { ledger, ...summary } = capture.receipt
    const unmatchedRequests = capture.requests.filter((r) => r.physicalId === null)
    check(unmatchedRequests.length <= 1, 'unmatched_storage_bounds')
    writer.write('control-summary.json', seal({ namespace: capture.namespace,
      storageSchema: MORPHO_PROBE_ROW_STORAGE_SCHEMA, storageBudget,
      receipt: summary, rowReferences, unmatchedRequests, ...FLAGS }))
    const reportOutputs = capture.outputs.map(({ rawCode, ...observation }) => ({
      ...observation,
      ownerCodeRawReferences: capture.requests.filter((r) =>
        r.key === observation.subjectId + ':ownerCode:' + observation.owner).map((r) => ({
        namespace: capture.namespace, physicalId: r.physicalId,
        file: 'native-row-' + String(r.physicalId).padStart(3, '0') + '.json', host: r.host,
      })),
    }))
    const report = seal({ schema: 'morpho_historical_owner_funded_probe_report_v1', ...FLAGS,
      status: capture.complete ? 'native_capture_qualified_retention_pending' : 'partial',
      reason: capture.failure, source: capture.source, outputs: reportOutputs,
      historicalLeads: prepared.leads.map(({ proof, ...identity }) => ({
        ...identity, ...FLAGS, event: proof.event, ownerField: proof.ownerField,
        originalFileSha256: proof.originalFileSha256, historicalHintOnly: true,
        historicalRemainingSharesKnown: false, currentBalanceKnown: false,
        historicalSelectorDeclaredOnly: proof.historicalSelectorDeclaredOnly,
        historicalPairedEventHeaders: proof.historicalPairedEventHeaders,
      })),
      physicalStarts: capture.physicalStarts, scheduledReads: capture.scheduledReads,
      maximumPhysicalStarts: POLICY.starts, maximumPlannedPhysicalStarts: POLICY.plannedStarts,
      logStarts: 0, nativeAcquisitionCompletedAtUtc: capture.nativeAcquisitionCompletedAtUtc,
      postRetentionAvailableAtUtc: null, availabilityBoundary: 'series_retention_pending',
      sourcePins: prepared.sources.map((s) => s.pin), inputPins: prepared.originals.map((s) => s.pin),
    })
    check(Buffer.byteLength(JSON.stringify(report)) <= POLICY.report, 'report_cap')
    writer.write('report.json', report)
    verifyPrepared(prepared); writer.deadline()
    const terminal = writer.write('terminal.json', seal({
      schema: 'morpho_historical_owner_funded_probe_terminal_v1', ...FLAGS,
      status: capture.complete ? 'native_capture_qualified_retention_pending' : 'partial',
      reason: capture.failure, qualificationAtUtc: utc(Date.now()),
      qualificationBoundary: 'before_terminal_fsync', retentionQualified: false,
      references: [...writer.refs], attemptedBytesBeforeTerminal: writer.used(),
      source: capture.source, physicalStarts: capture.physicalStarts,
      originalsAreNotReissuableCapabilities: true,
    }), true)
    // The availability clock is sampled ONLY after terminal fsync/readback, source/deadline and identity checks.
    verifyPrepared(prepared)
    writer.verifyRetained(); writer.deadline()
    const finalDisk = statfsSync(ROOT, { bigint: true })
    const availableAtMs = Date.now(), elapsedMs = performance.now() - started
    const postRetentionAvailableAtUtc = qualifyHistoricalOwnerPostRetentionAvailability({
      availableAtMs, elapsedMs, freeBytes: finalDisk.bavail * finalDisk.bsize,
      source: capture.source, complete: capture.complete,
    })
    return seal({ ...FLAGS, complete: capture.complete, reason: capture.failure, out, terminal,
      physicalStarts: capture.physicalStarts, fundedObservations: capture.outputs.filter((r) => BigInt(r.sharesRaw) > 0n).length,
      postRetentionAvailableAtUtc, availabilityBoundary: 'after_terminal_fsync_readback_source_deadline_and_identity_checks',
      elapsedMs })
  } catch (error) {
    const reason = error instanceof Error && /^morpho_historical_owner_probe_[a-zA-Z0-9_]+$/.test(error.message)
      ? error.message : 'morpho_historical_owner_probe_retention_failed'
    return { ...FLAGS, complete: false, out, reason, retainedFiles: writer.refs.length,
      attemptedWriteBytes: writer.used(), physicalStarts: capture.physicalStarts,
      postRetentionAvailableAtUtc: null }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMorphoHistoricalOwnerFundedProbe().then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!result.complete) process.exitCode = 2
  }).catch(() => {
    process.stderr.write('morpho_historical_owner_probe_failed\n')
    process.exitCode = 1
  })
}
