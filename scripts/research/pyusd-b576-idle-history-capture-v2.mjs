/** Closed V2 PYUSD_B576 native join; V1 remains immutable. Importing acquires no providers and starts no reads. */
import { createHash, randomUUID } from 'node:crypto'
import {
  constants, openSync, closeSync, readSync, writeSync, fsyncSync,
  fstatSync, lstatSync, statfsSync, mkdirSync,
} from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { encodeFunctionData, decodeFunctionResult, encodeFunctionResult, parseAbi, keccak256 } from 'viem'
import {
  configuredUsd3HypotheticalOrigins, createUsd3HypotheticalCaptureControl, parseUsd3HypotheticalJson,
} from './usd3-hypothetical-history-capture.mjs'
import { verifyProbeControl } from './morpho-observed-funded-holder-probe.mjs'
import {
  additionalHistoricalOwnerCredentialVariants, assertAdditionalHistoricalOwnerProbePrivacy,
} from './morpho-additional-historical-owner-funded-probe.mjs'
import {
  MORPHO_PROBE_ROW_STORAGE_SCHEMA, encodeMorphoProbeNativeRow, decodeMorphoProbeNativeRow,
  encodedMorphoProbeRowOverheadBytes, morphoProbeEncodedRawResponseBytes,
  serializeMorphoProbeStorageValue,
} from './morpho-probe-raw-body-storage.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const PYUSD_B576_V2_PLAN_PATH = 'scripts/research/pyusd-b576-idle-history-capture-v2.plan.json'
export const PYUSD_B576_V2_PLAN_SHA = '37d48e051021b046482fb451a3e6352dbfff2e6d3909fafebe555708be38beef'
const SELF = 'scripts/research/pyusd-b576-idle-history-capture-v2.mjs'
const FROZEN_V1_REFERENCES = freeze([
  { path: 'scripts/research/pyusd-b576-idle-history-capture.mjs', bytes: 47873,
    fileSha256: 'e199ff97ba55446413cb0ed311bc182c24060de2574863006a54e9a1e3f4858b' },
  { path: 'scripts/research/pyusd-b576-idle-history-capture.plan.json', bytes: 16261,
    fileSha256: '0f5f7a3cd147f601ed3f458b69432b72b594cfc28f41a9401be8f79f09f1c5bf' },
  { path: 'tests/unit/pyusdB576IdleHistoryCapture.original.test.mjs', bytes: 15724,
    fileSha256: 'aeacdb55970fdde5471f2830e46e6a3fafcc32aa12aa0174f3577b6144082ba6' },
])
const RETAINED_SOURCE_PATHS = Object.freeze([
  'scripts/research/usd3-hypothetical-history-capture.mjs',
  'scripts/research/carry-depth-quote-archive.mjs',
  'scripts/research/record-carry-morpho-v2-block-archive.mjs',
  'scripts/lib/boundedLocalReceiptFile.mjs',
  'scripts/research/morpho-observed-funded-holder-probe.mjs',
  'scripts/research/morpho-additional-historical-owner-funded-probe.mjs',
  'scripts/research/morpho-probe-raw-body-storage.mjs',
  'lib/carry/holderOriginCode.ts',
  'tests/unit/pyusdB576IdleHistoryCaptureV2.original.test.mjs',
])
const MB = 1024 * 1024, ZERO = '0x' + '0'.repeat(40)
const HASH = /^0x[0-9a-f]{64}$/, HEX = /^0x(?:[0-9a-f]{2})*$/
const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
const SUBJECT = Object.freeze({
  id: 'PYUSD_B576', vault: '0xb576765fb15505433af24fee2c0325895c559fb2',
  asset: '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
  owner: '0xf181e2cc93a47cb4903ac71c23ecb873726dc668', assetDecimals: 6, shareDecimals: 18,
})
const ANCHORS = Object.freeze([
  Object.freeze({ chainId: 1, blockNumber: '26100913',
    blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
    blockTime: '2026-10-01T23:59:59.000Z', finalized: true }),
  Object.freeze({ chainId: 1, blockNumber: '26108081',
    blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
    blockTime: '2026-10-02T23:59:59.000Z', finalized: true }),
])
const preparedInstances = new WeakSet()
export const PYUSD_B576_V2_POLICY = Object.freeze({
  starts: 100, plannedStarts: 98, deadline: 120000, acquisitionDeadline: 115000, retentionReserve: 5000,
  stage: 12000, timeout: 8000,
  spacing: 250, workers: 1, retries: 0, response: 65536, file: 8 * MB,
  cohort: 10 * MB, source: 6 * MB, report: 32768, terminal: 65536,
  rawAggregate: 5 * MB, retainedRawAggregate: 5 * MB + 65536,
  rowOverhead: 8192, fixedStorage: 2 * MB, controlSummary: 65536,
  files: 131, allocationUnit: 4096, fileAllocationMargin: 8192,
  allocationSlack: 3 * MB, directoryAllocationMargin: 8192,
  pre: 269 * MB, reserve: 256 * MB,
})
export const PYUSD_B576_V2_FLAGS = Object.freeze({
  researchOnly: true, authenticated: false, originalAuthority: false,
  historicalOwnership: false, currentWalletControl: false, profileApproval: false,
  sourceImplementationEquivalence: false, holderExecutableExit: false,
  forecastEligibility: false, calibrated: false, coveragePromotion: false, competingMRaw: null,
  executionAuthority: false, forecastAuthority: false, calibratedProbability: false, MRaw: null,
})
// The lossless immutable codec has its own narrower flags; extra flags remain on reports and facts.
const STORAGE_FLAGS = Object.freeze(Object.fromEntries(Object.entries(PYUSD_B576_V2_FLAGS).slice(0, 12)))
export const PYUSD_B576_V2_ABI = freeze(parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function liquidityAdapter() view returns (address)',
  'function liquidityData() view returns (bytes)',
  'function balanceOf(address owner) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
]))
const P = PYUSD_B576_V2_POLICY, FLAGS = PYUSD_B576_V2_FLAGS
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (ok, reason) => { if (!ok) throw Error('pyusd_b576_v2_' + reason) }
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const utc = (time) => new Date(time).toISOString()
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function fixedPath(relative) {
  check(typeof relative === 'string' && !relative.startsWith('/') && !relative.includes('..') &&
    !relative.includes('\\') && !relative.includes('://'), 'fixed_path')
  const path = resolve(ROOT, relative)
  let parent = dirname(path)
  while (parent !== ROOT) {
    const s = lstatSync(parent)
    check(parent.startsWith(ROOT + '/') && s.isDirectory() && !s.isSymbolicLink(), 'parent_identity')
    parent = dirname(parent)
  }
  return path
}
function readBytes(path, cap, budget = { bytes: 0, maximum: P.cohort }, privateFile = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd, { bigint: true })
    check(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(cap) &&
      budget.bytes + Number(before.size) <= budget.maximum &&
      (!privateFile || (before.mode & 0o777n) === 0o600n), 'read_size_mode_link')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let used = 0
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, null)
      if (!n) break
      used += n; check(used <= cap, 'read_cap')
    }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true })
    check(named.isFile() && !named.isSymbolicLink() && after.nlink === 1n && named.nlink === 1n &&
      BigInt(used) === after.size && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) =>
        before[key] === after[key] && after[key] === named[key]) &&
      (!privateFile || (named.mode & 0o777n) === 0o600n), 'read_identity')
    budget.bytes += used
    return bytes.subarray(0, used)
  } finally { closeSync(fd) }
}
function readPin(pin, budget) {
  check(pin && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && /^[0-9a-f]{64}$/.test(pin.fileSha256), 'pin')
  const bytes = readBytes(fixedPath(pin.path), Math.min(pin.bytes, P.file), budget, pin.private === true)
  check(bytes.length === pin.bytes && sha(bytes) === pin.fileSha256, 'file_pin')
  return bytes
}
function sealedJson(bytes) {
  const value = parseUsd3HypotheticalJson(bytes.toString('utf8')), { sha256, ...body } = value
  check(typeof sha256 === 'string' && sha(JSON.stringify(body)) === sha256, 'body_seal')
  return value
}
function freeBytes() {
  const disk = statfsSync(ROOT, { bigint: true })
  check(disk.bsize > 0n && disk.bsize <= BigInt(P.allocationUnit) &&
    BigInt(P.allocationUnit) % disk.bsize === 0n, 'disk_allocation_unit')
  return disk.bavail * disk.bsize
}
const rounded = (n) => Math.ceil(n / P.allocationUnit) * P.allocationUnit
export function assertPyusdB576V2DiskCapacity(free, bytes = 0, terminal = false, preflight = false) {
  check(typeof free === 'bigint' && free >= 0n && Number.isSafeInteger(bytes) && bytes >= 0, 'disk_shape')
  if (preflight) check(free >= BigInt(P.pre), 'disk_preflight')
  check(free >= BigInt(P.reserve + rounded(bytes) + P.fileAllocationMargin +
    (terminal ? 0 : rounded(P.terminal) + P.fileAllocationMargin)), 'disk_reserve')
  return true
}
function guard(bytes = 0, terminal = false, preflight = false) {
  return assertPyusdB576V2DiskCapacity(freeBytes(), bytes, terminal, preflight)
}
function header(value) {
  check(value && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value.number) && HASH.test(value.hash) &&
    /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value.timestamp), 'header')
  return { chainId: 1, blockNumber: String(BigInt(value.number)), blockHash: value.hash,
    blockTime: utc(Number(BigInt(value.timestamp)) * 1000), finalized: true }
}
function paired(traces, spec) {
  const rows = HOSTS.map((host) => traces.filter((t) => t.host === host && t.key === spec.key))
  check(rows.every((xs) => xs.length === 1 && same(xs[0].request, spec) && xs[0].envelope &&
    !Object.hasOwn(xs[0].envelope, 'error') && Object.hasOwn(xs[0].envelope, 'result')), 'paired_request')
  check(same(rows[0][0].envelope.result, rows[1][0].envelope.result), 'paired_result')
  return rows[0][0].envelope.result
}
function pairedHeader(traces, spec) {
  const values = HOSTS.map((host) => {
    const rows = traces.filter((t) => t.host === host && t.key === spec.key)
    check(rows.length === 1 && same(rows[0].request, spec) && !rows[0].envelope.error, 'paired_header_request')
    return header(rows[0].envelope.result)
  })
  check(same(values[0], values[1]), 'paired_header')
  return values[0]
}
export function decodePyusdB576V2Result(name, raw) {
  check(typeof raw === 'string' && HEX.test(raw), 'ABI_bytes')
  const value = decodeFunctionResult({ abi: PYUSD_B576_V2_ABI, functionName: name, data: raw })
  check(encodeFunctionResult({ abi: PYUSD_B576_V2_ABI, functionName: name, result: value }) === raw, 'ABI_canonical')
  return typeof value === 'string' ? value.toLowerCase() : String(value)
}
const blockHeader = (key, block) => ({ key, method: 'eth_getBlockByNumber', params: [block, false] })
/** Sixteen reads per point, including both brackets and the actual historical owner balance. */
export function pyusdB576V2PointReadPlan(label, source, probeSharesRaw) {
  check(['current', 'anchor_0', 'anchor_1'].includes(label) && HASH.test(source?.blockHash) &&
    /^[1-9][0-9]*$/.test(source.blockNumber) && /^(?:0|[1-9][0-9]*)$/.test(probeSharesRaw) &&
    BigInt(probeSharesRaw) < (1n << 256n), 'point_plan')
  const pin = { blockHash: source.blockHash, requireCanonical: true }, key = (k) => label + ':' + k
  const code = (k, to) => ({ key: key(k), method: 'eth_getCode', params: [to, pin] })
  const call = (k, to, name, args = []) => ({ key: key(k), name, method: 'eth_call', params: [
    { to, data: encodeFunctionData({ abi: PYUSD_B576_V2_ABI, functionName: name, args }) }, pin,
  ] })
  const number = '0x' + BigInt(source.blockNumber).toString(16)
  return [
    { key: key('chain'), method: 'eth_chainId', params: [] }, blockHeader(key('header_before'), number),
    code('vault_code', SUBJECT.vault), code('asset_code', SUBJECT.asset), code('owner_code', SUBJECT.owner),
    call('asset', SUBJECT.vault, 'asset'), call('share_decimals', SUBJECT.vault, 'decimals'),
    call('asset_decimals', SUBJECT.asset, 'decimals'),
    call('liquidity_adapter', SUBJECT.vault, 'liquidityAdapter'), call('liquidity_data', SUBJECT.vault, 'liquidityData'),
    call('idle_cash', SUBJECT.asset, 'balanceOf', [SUBJECT.vault]),
    call('total_assets', SUBJECT.vault, 'totalAssets'), call('total_supply', SUBJECT.vault, 'totalSupply'),
    call('actual_owner_shares', SUBJECT.vault, 'balanceOf', [SUBJECT.owner]),
    call('fixed_stock_preview', SUBJECT.vault, 'previewRedeem', [BigInt(probeSharesRaw)]),
    blockHeader(key('header_after'), number),
  ]
}
function runtime(code) {
  check(typeof code === 'string' && HEX.test(code), 'runtime_bytes')
  return { runtimeByteLength: (code.length - 2) / 2, runtimeKeccak256: keccak256(code) }
}
/** Historical preview always remains a hypothetical fixed-current-stock conversion. */
export function derivePyusdB576V2Point(traces, label, source, probeSharesRaw, expectedRuntimes, expectedCashRaw = null) {
  const specs = pyusdB576V2PointReadPlan(label, source, probeSharesRaw)
  const spec = (key) => specs.find((x) => x.key === label + ':' + key)
  const get = (key) => paired(traces, spec(key))
  check(get('chain') === '0x1' && same(pairedHeader(traces, spec('header_before')), source) &&
    same(pairedHeader(traces, spec('header_after')), source), 'point_chain_and_brackets')
  const decoded = (key) => decodePyusdB576V2Result(spec(key).name, get(key))
  const values = Object.fromEntries(specs.filter((x) => x.method === 'eth_call').map((x) =>
    [x.key.slice(label.length + 1), decodePyusdB576V2Result(x.name, paired(traces, x))]))
  const codes = { vault: get('vault_code'), asset: get('asset_code'), owner: get('owner_code') }
  const runtimes = Object.fromEntries(Object.entries(codes).map(([key, code]) => [key, runtime(code)]))
  const current = label === 'current', reasons = []
  if (values.asset !== SUBJECT.asset || values.asset_decimals !== '6' || values.share_decimals !== '18')
    reasons.push('native_identity_or_units_differ')
  if (values.liquidity_adapter !== ZERO || values.liquidity_data !== '0x') reasons.push('idle_regime_differed')
  if (['vault', 'asset'].some((key) => !same(runtimes[key], expectedRuntimes[key])))
    reasons.push('runtime_identity_differed')
  if (current && codes.owner !== '0x') reasons.push('fresh_owner_no_code_condition_differed')
  if (BigInt(probeSharesRaw) === 0n || BigInt(values.fixed_stock_preview) === 0n) reasons.push('unfunded_probe_stock')
  if (BigInt(probeSharesRaw) > BigInt(values.total_supply)) reasons.push('probe_stock_exceeds_native_supply')
  if (current && values.actual_owner_shares !== probeSharesRaw) reasons.push('fresh_stock_binding_differed')
  if (expectedCashRaw !== null && values.idle_cash !== expectedCashRaw) reasons.push('own_cash_anchor_differed')
  return freeze({
    label, ...SUBJECT, source, qualifiedNativeJoin: reasons.length === 0, qualificationReasons: reasons,
    nativeAsset: values.asset, nativeAssetDecimals: Number(values.asset_decimals),
    nativeShareDecimals: Number(values.share_decimals), liquidityAdapter: values.liquidity_adapter,
    liquidityData: values.liquidity_data,
    configurationRegimeId: sha(JSON.stringify({ adapter: values.liquidity_adapter, data: values.liquidity_data })),
    regimeKind: values.liquidity_adapter === ZERO && values.liquidity_data === '0x'
      ? 'zero_liquidity_adapter_empty_data' : 'other_native_configuration',
    LLTV: null, LLTVStatus: values.liquidity_adapter === ZERO && values.liquidity_data === '0x'
      ? 'inapplicable_idle_no_adapter' : 'unmeasured', allocation: null,
    CAssetRaw: values.idle_cash, cashAssetDecimals: Number(values.asset_decimals),
    CMeaning: 'asset.balanceOf(exact_vault)_only', cashIsTotalAssets: false, cashIsOwnedEntitlement: false,
    totalAssetsRaw: values.total_assets, totalAssetsAssetDecimals: Number(values.asset_decimals),
    totalSupplySharesRaw: values.total_supply, totalSupplyShareDecimals: Number(values.share_decimals),
    actualOwnerSharesRaw: values.actual_owner_shares, actualOwnerShareDecimals: Number(values.share_decimals),
    actualHistoricalOwnerSharesRaw: current ? null : values.actual_owner_shares,
    probeSharesRaw, probeShareDecimals: Number(values.share_decimals),
    probeEaAssetRaw: values.fixed_stock_preview, probeEaAssetDecimals: Number(values.asset_decimals),
    conversionBasis: current ? 'fresh_current_owner_full_stock' : 'hypothetical_fixed_current_stock_conversion',
    freshCurrentFullEaAssetRaw: current ? decoded('fixed_stock_preview') : null,
    historicalOwnedEntitlementAssetRaw: null,
    historicalOwnedEntitlementMeasured: false,
    historicalOwnerStockEqualsProbeStock: current ? null : values.actual_owner_shares === probeSharesRaw,
    ownerCodeStatus: codes.owner === '0x' ? 'no_code' : 'code_present',
    ownerCodeRawIfEmpty: codes.owner === '0x' ? '0x' : null,
    runtimes, sourceImplementationEquivalence: false, expectedCashRaw,
    nativeReferences: specs.map((x) => ({ key: x.key, physicalIds: HOSTS.map((host) =>
      traces.find((t) => t.host === host && t.key === x.key).physicalId) })),
    ...FLAGS,
  })
}
export function preparePyusdB576V2IdleHistory() {
  const budget = { bytes: 0, maximum: P.cohort }
  const planBytes = readBytes(fixedPath(PYUSD_B576_V2_PLAN_PATH), 65536, budget)
  check(sha(planBytes) === PYUSD_B576_V2_PLAN_SHA, 'plan_pin')
  const plan = parseUsd3HypotheticalJson(planBytes.toString('utf8'))
  check(plan.schema === 'pyusd_b576_idle_history_native_join_plan_v2' && plan.revision === 2 &&
    same(plan.subject, SUBJECT) && same(plan.origins, HOSTS) && same(plan.policy, P) &&
    same(plan.anchors.map((x) => x.source), ANCHORS) &&
    same(plan.anchors.map((x) => x.expectedCashRaw), ['20919825104652', '24375516077801']) &&
    plan.storage.schema === MORPHO_PROBE_ROW_STORAGE_SCHEMA &&
    same(plan.retainedSourcePaths, RETAINED_SOURCE_PATHS) &&
    same(plan.frozenV1References, FROZEN_V1_REFERENCES) &&
    plan.historicalProbeBasis === 'hypothetical_fixed_current_stock_conversion' &&
    plan.currentPoint === 'fresh_paired_finalized_header' && plan.stationaryRegimePooling === false &&
    Object.entries(FLAGS).every(([key, value]) => plan[key] === value), 'closed_plan')
  const sources = plan.sourcePins.map((pin) => ({ pin, bytes: readPin(pin, budget) }))
  check(RETAINED_SOURCE_PATHS.every((path) => sources.some((x) => x.pin.path === path)) &&
    FROZEN_V1_REFERENCES.every((pin) => sources.some((x) => same(x.pin, pin))) &&
    new Set(sources.map((x) => x.pin.path)).size === sources.length, 'source_set')
  const ownBytes = readBytes(fixedPath(SELF), P.source, budget)
  sources.push({ pin: { path: SELF, bytes: ownBytes.length, fileSha256: sha(ownBytes) }, bytes: ownBytes })
  check(sources.reduce((n, x) => n + x.bytes.length, 0) <= P.source, 'source_cap')
  const inputs = plan.inputPins.map((pin) => ({ pin, bytes: readPin(pin, budget) }))
  const input = (path) => { const found = inputs.find((x) => x.pin.path === path); check(found, 'input_reference'); return found }
  const discovery = sealedJson(input(plan.discoveryPath).bytes)
  check(discovery.schema === 'morpho49_configuration_discovery_capture_v1' && discovery.ordinal === 27 &&
    discovery.subject.vault === SUBJECT.vault && discovery.subject.asset === SUBJECT.asset &&
    discovery.facts.nativeVaultAsset === SUBJECT.asset && discovery.facts.nativeAdapter === ZERO &&
    discovery.facts.liquidityData === '0x' && discovery.facts.vaultDecimals === '18' &&
    same(discovery.facts.runtime, plan.expectedRuntimes), 'discovery_subject')
  const lead = sealedJson(input(plan.ownerLeadPath).bytes)
  const outputs = lead.outputs.filter((x) => x.subjectId === SUBJECT.id)
  check(outputs.length === 1 && outputs[0].vault === SUBJECT.vault && outputs[0].asset === SUBJECT.asset &&
    outputs[0].owner === SUBJECT.owner && outputs[0].shareDecimals === 18 && outputs[0].assetDecimals === 6 &&
    outputs[0].sharesRaw === plan.historicalLeadOnly.sharesRaw && outputs[0].fullEaRaw === plan.historicalLeadOnly.fullEaRaw &&
    outputs[0].ownerCodeStatus === 'no_code' && outputs[0].currentWalletControl === false &&
    same(outputs[0].ownerCodeRawReferences.map((x) => x.physicalId), [17, 18]), 'historical_lead_hint')
  for (const [index, path] of plan.ownerCodeHintPaths.entries()) {
    const row = sealedJson(input(path).bytes)
    check(row.schema === MORPHO_PROBE_ROW_STORAGE_SCHEMA && row.binding.physicalId === 17 + index &&
      row.row.observation.physicalId === 17 + index && row.row.observation.host === HOSTS[index], 'owner_hint_row')
    const raw = Buffer.from(row.row.observation.rawBodyBase64, 'base64')
    const envelope = parseUsd3HypotheticalJson(raw.toString('utf8'))
    const request = Buffer.from(row.row.request.requestBodyBase64, 'base64')
    const requested = parseUsd3HypotheticalJson(request.toString('utf8'))
    check(raw.toString('base64') === row.row.observation.rawBodyBase64 &&
      sha(raw) === row.row.observation.bodySha256 && raw.length === row.row.observation.bodyBytes &&
      sha(request) === row.row.request.requestBodySha256 && same(requested, row.row.observation.request) &&
      requested.method === 'eth_getCode' && requested.params[0] === SUBJECT.owner &&
      requested.params[1].blockHash === lead.source.blockHash && requested.params[1].requireCanonical === true &&
      envelope.id === requested.id && envelope.result === '0x', 'owner_hint_raw_body')
  }
  for (const anchor of plan.anchors) {
    const receipt = sealedJson(input(anchor.receiptPath).bytes)
    const rows = receipt.rows.filter((x) => x.destination === SUBJECT.vault)
    check(receipt.chainId === 1 && receipt.block === anchor.source.blockNumber &&
      receipt.blockHash === anchor.source.blockHash && receipt.blockAt === anchor.source.blockTime &&
      rows.length === 1 && rows[0].asset === SUBJECT.asset && rows[0].assetDecimals === 6 &&
      rows[0].shareDecimals === 18 && rows[0].cashRaw === anchor.expectedCashRaw &&
      rows[0].blockHash === anchor.source.blockHash && rows[0].block === anchor.source.blockNumber,
      'exact_own_cash_anchor')
  }
  const immutableEntries = (xs) => Object.freeze(xs.map((x) => Object.freeze({ pin: freeze(x.pin), bytes: x.bytes })))
  // Buffers stay readable; every use rechecks them against the immutable, independently read file pins.
  const prepared = Object.freeze({ plan: freeze(plan), planBytes, sources: immutableEntries(sources),
    inputs: immutableEntries(inputs), expectedRuntimes: freeze(plan.expectedRuntimes) })
  preparedInstances.add(prepared)
  pyusdB576V2StorageBudgetProof(prepared)
  return prepared
}
function verifyPrepared(prepared) {
  check(preparedInstances.has(prepared), 'prepared_original')
  const budget = { bytes: 0, maximum: P.cohort }
  check(readBytes(fixedPath(PYUSD_B576_V2_PLAN_PATH), 65536, budget).equals(prepared.planBytes), 'plan_recheck')
  for (const x of [...prepared.sources, ...prepared.inputs]) check(readPin(x.pin, budget).equals(x.bytes), 'source_recheck')
  pyusdB576V2StorageBudgetProof(prepared)
}
export function pyusdB576V2FixedArtifacts(prepared) {
  check(preparedInstances.has(prepared), 'prepared_original')
  return [
    { name: 'plan.json', value: seal({ rawText: prepared.planBytes.toString('utf8'), fileSha256: PYUSD_B576_V2_PLAN_SHA, ...FLAGS }) },
    { name: 'source-0.json', value: seal({ sources: prepared.sources.filter((x) =>
      x.pin.path === SELF || RETAINED_SOURCE_PATHS.includes(x.pin.path)).map((x) =>
      ({ pin: x.pin, sourceText: x.bytes.toString('utf8') })), ...FLAGS }) },
    ...prepared.inputs.map((x, i) => ({ name: 'input-' + i + '.json',
      value: seal({ pin: x.pin, rawText: x.bytes.toString('utf8'), historicalHintOnly: true, ...FLAGS }) })),
  ]
}
export function pyusdB576V2StorageBudgetProof(prepared) {
  const fixed = pyusdB576V2FixedArtifacts(prepared)
  const fixedSerializedBytes = fixed.reduce((n, x) => n + serializeMorphoProbeStorageValue(x.value).length, 0)
  const maximumBase64Bytes = 4 * Math.ceil(P.retainedRawAggregate / 3) + 4 * (P.starts - 1)
  const maximumFiles = fixed.length + P.starts + 3
  const maximumLogicalBytes = fixedSerializedBytes + maximumBase64Bytes + P.starts * P.rowOverhead +
    P.controlSummary + P.report + P.terminal
  const maximumAllocationExtra = maximumFiles * (P.allocationUnit - 1 + P.fileAllocationMargin) + P.directoryAllocationMargin
  check(fixedSerializedBytes <= P.fixedStorage && maximumLogicalBytes <= P.cohort &&
    maximumFiles <= P.files && maximumAllocationExtra <= P.allocationSlack &&
    P.pre === P.reserve + P.cohort + P.allocationSlack &&
    P.deadline === P.acquisitionDeadline + P.retentionReserve, 'storage_budget_proof')
  const pointReadCount = pyusdB576V2PointReadPlan('current', ANCHORS[0], '0').length
  const derivedWorstStarts = 2 + 3 * pointReadCount * HOSTS.length
  check(pointReadCount === 16 && derivedWorstStarts === P.plannedStarts && derivedWorstStarts <= P.starts, 'physical_budget_proof')
  return freeze({ fixedSerializedBytes, fixedFiles: fixed.length, maximumAcceptedRawResponseBytes: P.rawAggregate,
    maximumRetainedRawResponseBytes: P.retainedRawAggregate, maximumBase64Bytes,
    maximumRowOverheadBytes: P.starts * P.rowOverhead, maximumLogicalBytes, maximumFiles, maximumAllocationExtra,
    derivedWorstStarts, startsFormula: '2 + (3 points * 16 reads * 2 origins) = 98',
    logicalCohortCap: P.cohort, allocationSlack: P.allocationSlack })
}
export async function capturePyusdB576V2IdleHistory(prepared, origins, options = {}) {
  guard(0, false, true); verifyPrepared(prepared)
  check(Array.isArray(origins) && same(origins.map((x) => x.host), HOSTS) && origins.every((x) => {
    const u = new URL(x.url)
    return u.protocol === 'https:' && u.hostname === x.host && !u.username && !u.password && !u.hash
  }), 'origins')
  const now = options.now ?? Date.now, clock = options.monotonic ?? (() => performance.now())
  const started = options.started ?? clock(), startedAtUtc = utc(now())
  check(Number.isFinite(started) && Number.isFinite(clock()) && started <= clock(), 'monotonic_start')
  const absoluteAcquisitionDeadline = started + P.acquisitionDeadline
  const setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout
  const control = createUsd3HypotheticalCaptureControl(origins, {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}), now, monotonic: clock,
    ...(options.pace ? { pace: options.pace } : {}),
    setTimer, clearTimer,
  })
  let controllerConstructedAt, acquisitionExpired = false, cutoffTimer, cutoffTimerArmed = false,
    cutoffTimerCleared = false, receipt, settlements
  const stopAtPyusdB576V2AcquisitionDeadline = () => {
    acquisitionExpired = true
    control.stop('pyusd_b576_v2_acquisition_deadline')
  }
  const acquisitionRemaining = () => absoluteAcquisitionDeadline - clock()
  const deadline = () => {
    if (acquisitionRemaining() <= 0) stopAtPyusdB576V2AcquisitionDeadline()
    check(!acquisitionExpired && acquisitionRemaining() > 0, 'acquisition_deadline')
    check(clock() - started < P.deadline, 'overall_deadline'); guard()
  }
  const namespace = 'historical-owner-native-' + randomUUID(), requests = [], traces = [], points = []
  let currentSource = null, currentS = null, scheduled = 0, failure = null
  const dispatch = async (origin, spec) => {
    deadline(); check(scheduled < P.plannedStarts && scheduled < P.starts && spec.method !== 'eth_getLogs', 'start_budget')
    const request = { jsonrpc: '2.0', id: ++scheduled, method: spec.method, params: spec.params }
    const body = JSON.stringify(request)
    check(Buffer.byteLength(body) <= 2048, 'request_bound')
    const record = { controlNamespace: namespace, physicalId: null, rpcId: request.id, key: spec.key,
      host: origin.host, requestBodyBase64: Buffer.from(body).toString('base64'), requestBodySha256: sha(body) }
    requests.push(record)
    deadline()
    const response = await control.fetcher(origin.url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body })
    deadline()
    record.physicalId = Number(response.headers.get('x-usd3-physical-id'))
    check(Number.isSafeInteger(record.physicalId) && record.physicalId > 0 && record.physicalId <= P.starts, 'physical_id')
    const text = await response.text(); deadline()
    const envelope = parseUsd3HypotheticalJson(text)
    check(envelope.jsonrpc === '2.0' && envelope.id === request.id && !Object.hasOwn(envelope, 'error'), 'native_envelope')
    traces.push({ host: origin.host, key: spec.key, request: spec, envelope, physicalId: record.physicalId })
  }
  const group = async (label, specs) => {
    for (let i = 0; i < specs.length; i += 3) {
      const began = clock(); deadline(); control.beginStage(label + '_' + i)
      for (const spec of specs.slice(i, i + 3)) for (const origin of origins) {
        check(clock() - began < P.stage, 'stage_window'); await dispatch(origin, spec)
      }
      check(clock() - began <= P.stage, 'stage_window')
    }
  }
  try {
    controllerConstructedAt = clock()
    // Preparation and fixed writes consume this same CLI clock; construction never resets the cutoff.
    cutoffTimer = setTimer(stopAtPyusdB576V2AcquisitionDeadline, Math.max(0, acquisitionRemaining()))
    cutoffTimerArmed = true
    deadline()
    const finalized = blockHeader('fresh_finalized', 'finalized')
    await group('finalized', [finalized]); currentSource = pairedHeader(traces, finalized)
    check(now() - Date.parse(currentSource.blockTime) >= 0 && now() - Date.parse(currentSource.blockTime) <= 1800000 &&
      ANCHORS.every((x) => BigInt(x.blockNumber) < BigInt(currentSource.blockNumber)), 'fresh_finalized_age')
    const initial = pyusdB576V2PointReadPlan('current', currentSource, '0')
    await group('current_native', initial.slice(0, 14))
    currentS = decodePyusdB576V2Result('balanceOf', paired(traces, initial[13]))
    const current = pyusdB576V2PointReadPlan('current', currentSource, currentS)
    await group('current_full_stock', current.slice(14))
    points.push(derivePyusdB576V2Point(traces, 'current', currentSource, currentS, prepared.expectedRuntimes))
    for (const [index, anchor] of prepared.plan.anchors.entries()) {
      const label = 'anchor_' + index
      await group(label, pyusdB576V2PointReadPlan(label, anchor.source, currentS))
      points.push(derivePyusdB576V2Point(traces, label, anchor.source, currentS, prepared.expectedRuntimes, anchor.expectedCashRaw))
    }
    deadline(); verifyPrepared(prepared)
  } catch (error) {
    failure = acquisitionExpired || acquisitionRemaining() <= 0 ? 'pyusd_b576_v2_acquisition_deadline'
      : error instanceof Error && /^pyusd_b576_v2_[a-zA-Z0-9_]+$/.test(error.message)
        ? error.message : 'pyusd_b576_v2_native_unavailable'
    control.stop('pyusd_b576_v2_native_failed')
  } finally {
    // Keep the absolute abort armed until finish has aborted and settled the original controller.
    try { receipt = await control.finish(); settlements = structuredClone(control.settlementReceipts) }
    finally { if (cutoffTimerArmed) clearTimer(cutoffTimer); cutoffTimerCleared = true }
  }
  for (const request of requests) if (request.physicalId === null) {
    const row = receipt.ledger.find((x) => x.host === request.host && x.request.id === request.rpcId)
    if (row) request.physicalId = row.physicalId
  }
  if (!failure) try {
    check(receipt.physicalStarts === scheduled && scheduled === P.plannedStarts && points.length === 3 &&
      !acquisitionExpired && clock() < absoluteAcquisitionDeadline &&
      receipt.ledger.every((row) => row.accepted === true &&
        Number.isFinite(row.completedElapsedMs) &&
        row.completedElapsedMs + controllerConstructedAt < absoluteAcquisitionDeadline) &&
      clock() - started <= P.deadline && now() - Date.parse(currentSource.blockTime) <= 1800000, 'final_bounds')
    verifyProbeControl(receipt, requests, settlements, namespace)
  } catch { failure = 'pyusd_b576_v2_original_control_join_failed' }
  return { namespace, receipt, requests, settlements, traces, points, currentSource,
    freshCurrentSharesRaw: currentS, physicalStarts: receipt.physicalStarts, scheduledReads: scheduled,
    completeNativeAcquisition: failure === null, qualifiedNativeJoin: failure === null && points.every((x) => x.qualifiedNativeJoin),
    failure, startedAtUtc, nativeAcquisitionCompletedAtUtc: utc(now()), elapsedMs: clock() - started,
    acquisitionDeadlineElapsedMs: P.acquisitionDeadline, retentionReserveMs: P.retentionReserve,
    acquisitionExpired, cutoffTimerCleared, ...FLAGS }
}
function nativeRecord(capture, observation) {
  return { namespace: capture.namespace, physicalId: observation.physicalId,
    request: capture.requests.find((x) => x.physicalId === observation.physicalId) ?? null,
    observation, settlement: capture.settlements.find((x) => x.physicalId === observation.physicalId) ?? null,
    ...STORAGE_FLAGS }
}
function storageContext(record, source) {
  return { namespace: record.namespace, physicalId: record.physicalId, source,
    rowJsonSha256: sha(JSON.stringify(record)), observationJsonSha256: sha(JSON.stringify(record.observation)),
    settlementJsonSha256: sha(JSON.stringify(record.settlement)) }
}
export function pyusdB576V2EncodedOriginals(capture) {
  check(capture.receipt.ledger.length <= P.starts, 'row_count')
  let rawBytes = 0
  const rows = capture.receipt.ledger.map((observation, index) => {
    const record = nativeRecord(capture, observation), context = storageContext(record, capture.currentSource)
    const value = encodeMorphoProbeNativeRow(record, context), before = rawBytes
    rawBytes += morphoProbeEncodedRawResponseBytes(value)
    check(rawBytes <= P.rawAggregate || (before <= P.rawAggregate && rawBytes <= P.retainedRawAggregate &&
      index === capture.receipt.ledger.length - 1 && capture.receipt.failure !== null &&
      observation.accepted === false && observation.status === 'failed'), 'aggregate_raw_bound')
    check(same(decodeMorphoProbeNativeRow(value, context), record), 'lossless_original_row')
    return { name: 'native-row-' + String(observation.physicalId).padStart(3, '0') + '.json', value, context }
  })
  const { ledger, ...receipt } = capture.receipt
  const unmatchedRequests = capture.requests.filter((x) => !ledger.some((r) => r.physicalId === x.physicalId))
  check(unmatchedRequests.length <= 1 && capture.settlements.every((x) => ledger.some((r) => r.physicalId === x.physicalId)),
    'unmatched_channels')
  const summary = seal({ schema: 'pyusd_b576_idle_history_original_control_v2', namespace: capture.namespace,
    source: capture.currentSource, receipt, receiptKeyOrder: Object.keys(capture.receipt),
    requestOrder: capture.requests.map((x) => x.rpcId), unmatchedRequests,
    rows: rows.map((x) => { const { namespace, source, ...commitments } = x.context
      return { file: x.name, commitments } }), ...FLAGS })
  check(serializeMorphoProbeStorageValue(summary).length <= P.controlSummary, 'control_summary_bound')
  return { rows, summary, rawBytes }
}
/** Reconstruction retains every original field and verifies the immutable physical controller. */
export function reconstructPyusdB576V2OriginalControl(summary, encodedRows, requireComplete = true) {
  check(summary.schema === 'pyusd_b576_idle_history_original_control_v2' && summary.rows.length <= P.starts &&
    encodedRows.length === summary.rows.length && Object.entries(FLAGS).every(([key, value]) => summary[key] === value), 'original_summary')
  const ledger = [], requests = [], settlements = []
  for (const [index, entry] of summary.rows.entries()) {
    const context = { namespace: summary.namespace, source: summary.source, ...entry.commitments }
    const restored = decodeMorphoProbeNativeRow(encodedRows[index], context)
    ledger.push(restored.observation)
    if (restored.request !== null) requests.push(restored.request)
    if (restored.settlement !== null) settlements.push(restored.settlement)
  }
  requests.push(...structuredClone(summary.unmatchedRequests))
  requests.sort((a, b) => summary.requestOrder.indexOf(a.rpcId) - summary.requestOrder.indexOf(b.rpcId))
  check(Array.isArray(summary.receiptKeyOrder) && new Set(summary.receiptKeyOrder).size === summary.receiptKeyOrder.length &&
    same([...summary.receiptKeyOrder].sort(), [...Object.keys(summary.receipt), 'ledger'].sort()), 'receipt_field_order')
  const receipt = Object.fromEntries(summary.receiptKeyOrder.map((key) =>
    [key, key === 'ledger' ? ledger : summary.receipt[key]]))
  check(receipt.physicalStarts === ledger.length && ledger.length <= P.starts, 'restored_count')
  if (requireComplete) verifyProbeControl(receipt, requests, settlements, summary.namespace)
  return { namespace: summary.namespace, receipt, requests, settlements }
}
export function createPyusdB576V2Writer(out, secrets, { clock = () => performance.now(), started = clock() } = {}) {
  const parent = fixedPath('data/research/venue-signals')
  check(dirname(out) === parent && /^pyusd-b576-idle-history-v2-[A-Za-z0-9.-]+$/.test(basename(out)), 'output_root')
  guard(); const parentBefore = lstatSync(parent)
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
  const deadline = () => check(clock() - started <= P.deadline, 'retention_deadline')
  let bytes = 0, attemptedFiles = 0, fixedBytes = 0, rawBytes = 0
  const refs = []
  const verifyRetained = () => {
    identity()
    for (const ref of refs) {
      const path = resolve(out, ref.file), s = lstatSync(path)
      check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (s.mode & 0o777) === 0o600 &&
        s.dev === ref.dev && s.ino === ref.ino, 'retained_identity')
      check(sha(readBytes(path, ref.bytes, { bytes: 0, maximum: ref.bytes }, true)) === ref.fileSha256, 'retained_readback')
    }
    deadline()
  }
  return { refs, used: () => bytes, verifyRetained,
    write(name, value, terminal = false) {
      deadline(); identity(); check(/^[a-z0-9_.-]{1,80}$/.test(name), 'artifact_name')
      assertAdditionalHistoricalOwnerProbePrivacy(value, secrets)
      const data = serializeMorphoProbeStorageValue(value), fixed = /^(?:plan|source-[0-9]+|input-[0-9]+)\.json$/.test(name)
      check(data.length <= P.file && (!terminal || data.length <= P.terminal) &&
        bytes + data.length <= P.cohort - (terminal ? 0 : P.terminal) &&
        attemptedFiles + 1 <= P.files - (terminal ? 0 : 1) && (!fixed || fixedBytes + data.length <= P.fixedStorage), 'write_cap')
      if (name === 'control-summary.json') check(data.length <= P.controlSummary, 'summary_cap')
      if (name === 'report.json') check(data.length <= P.report, 'report_cap')
      let extraRaw = 0
      if (/^native-row-[0-9]{3}\.json$/.test(name)) {
        check(value.schema === MORPHO_PROBE_ROW_STORAGE_SCHEMA && encodedMorphoProbeRowOverheadBytes(value) <= P.rowOverhead, 'row_overhead')
        extraRaw = morphoProbeEncodedRawResponseBytes(value)
        check(rawBytes + extraRaw <= P.rawAggregate || (rawBytes <= P.rawAggregate && rawBytes + extraRaw <= P.retainedRawAggregate &&
          value.row.observation.accepted === false && value.row.observation.status === 'failed'), 'raw_cap')
      }
      guard(data.length, terminal)
      const path = resolve(out, name), fd = openSync(path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      bytes += data.length; attemptedFiles++; if (fixed) fixedBytes += data.length; rawBytes += extraRaw
      let after
      try {
        let used = 0
        while (used < data.length) { const n = writeSync(fd, data, used, data.length - used); check(n > 0, 'short_write'); used += n }
        fsyncSync(fd); syncDirectory(out); after = fstatSync(fd)
        const named = lstatSync(path)
        check(after.isFile() && named.isFile() && !named.isSymbolicLink() && after.nlink === 1 && named.nlink === 1 &&
          after.dev === named.dev && after.ino === named.ino && after.size === data.length && named.size === data.length &&
          (after.mode & 0o777) === 0o600 && (named.mode & 0o777) === 0o600, 'postfsync_identity')
      } finally { closeSync(fd) }
      check(readBytes(path, data.length, { bytes: 0, maximum: data.length }, true).equals(data), 'write_readback')
      identity(); deadline()
      const ref = { file: name, bytes: data.length, fileSha256: sha(data), dev: after.dev, ino: after.ino }
      refs.push(ref); return ref
    },
  }
}
export function pyusdB576V2Report(capture, prepared) {
  return seal({ schema: 'pyusd_b576_idle_history_native_join_report_v2', subject: prepared.plan.subject,
    status: !capture.completeNativeAcquisition ? 'partial_native_capture'
      : capture.qualifiedNativeJoin ? 'native_join_observed_retention_pending' : 'native_regime_qualification_declined',
    completeNativeAcquisition: capture.completeNativeAcquisition, qualifiedNativeJoin: capture.qualifiedNativeJoin,
    failure: capture.failure, currentSource: capture.currentSource, freshCurrentSharesRaw: capture.freshCurrentSharesRaw,
    points: capture.points, physicalStarts: capture.physicalStarts, scheduledReads: capture.scheduledReads,
    maximumPhysicalStarts: P.starts, maximumPlannedPhysicalStarts: P.plannedStarts, logStarts: 0,
    historicalProbeBasis: 'hypothetical_fixed_current_stock_conversion', historicalOwnedEntitlementMeasured: false,
    stationaryRegimePooling: false, unknownCompetingMRaw: null, suggestedFutureQAssetRaw: '500000',
    futureQNeedsFreshStockAndExactNativePath: true, nativeAcquisitionCompletedAtUtc: capture.nativeAcquisitionCompletedAtUtc,
    nativeAcquisitionElapsedMs: capture.elapsedMs, acquisitionDeadlineElapsedMs: P.acquisitionDeadline,
    retentionReserveMs: P.retentionReserve, acquisitionExpired: capture.acquisitionExpired,
    cutoffTimerCleared: capture.cutoffTimerCleared,
    sourcePins: prepared.sources.map((x) => x.pin), inputPins: prepared.inputs.map((x) => x.pin), ...FLAGS })
}
/** Bounded zero-RPC replay of freshly retained originals; it grants no forecast or execution authority. */
export function inspectPyusdB576V2RetainedHistory(directory) {
  const parent = fixedPath('data/research/venue-signals')
  check(dirname(directory) === parent && /^pyusd-b576-idle-history-v2-[A-Za-z0-9.-]+$/.test(basename(directory)), 'inspect_root')
  const d = lstatSync(directory)
  check(d.isDirectory() && !d.isSymbolicLink() && (d.mode & 0o777) === 0o700, 'inspect_directory')
  const budget = { bytes: 0, maximum: P.cohort }, p = preparePyusdB576V2IdleHistory()
  const terminal = sealedJson(readBytes(resolve(directory, 'terminal.json'), P.terminal, budget, true))
  check(terminal.schema === 'pyusd_b576_idle_history_terminal_v2' && terminal.files.length < P.files &&
    new Set(terminal.files.map((x) => x.file)).size === terminal.files.length &&
    Object.entries(FLAGS).every(([key, value]) => terminal[key] === value), 'terminal')
  const retained = new Map()
  for (const ref of terminal.files) {
    check(/^[a-z0-9_.-]{1,80}$/.test(ref.file) && Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= P.file,
      'retained_reference')
    const bytes = readBytes(resolve(directory, ref.file), ref.bytes, budget, true)
    check(bytes.length === ref.bytes && sha(bytes) === ref.fileSha256, 'retained_pin')
    retained.set(ref.file, sealedJson(bytes))
  }
  for (const fixed of pyusdB576V2FixedArtifacts(p)) check(same(retained.get(fixed.name), fixed.value), 'retained_fixed_original')
  const summary = retained.get('control-summary.json'), report = retained.get('report.json')
  check(summary && report && report.sha256 === terminal.reportSha256 &&
    report.completeNativeAcquisition === terminal.completeNativeAcquisition &&
    report.qualifiedNativeJoin === terminal.qualifiedNativeJoin && same(report.subject, SUBJECT) &&
    report.acquisitionDeadlineElapsedMs === P.acquisitionDeadline && report.retentionReserveMs === P.retentionReserve &&
    report.cutoffTimerCleared === true && Number.isFinite(report.nativeAcquisitionElapsedMs) &&
    report.nativeAcquisitionElapsedMs <= P.deadline && Number.isFinite(terminal.elapsedMs) &&
    terminal.elapsedMs <= P.deadline, 'retained_report_join')
  const restored = reconstructPyusdB576V2OriginalControl(summary, summary.rows.map((x) => {
    const row = retained.get(x.file); check(row, 'retained_row'); return row
  }), report.completeNativeAcquisition)
  check(restored.receipt.physicalStarts === terminal.physicalStarts &&
    restored.receipt.pendingSettlements === terminal.pendingSettlements, 'retained_accounting')
  if (report.completeNativeAcquisition) {
    check(report.acquisitionExpired === false && report.nativeAcquisitionElapsedMs < P.acquisitionDeadline,
      'retained_absolute_acquisition_clock')
    check(restored.receipt.physicalStarts === P.plannedStarts && report.physicalStarts === P.plannedStarts, 'complete_starts')
    const names = { asset: 'asset', share_decimals: 'decimals', asset_decimals: 'decimals',
      liquidity_adapter: 'liquidityAdapter', liquidity_data: 'liquidityData', idle_cash: 'balanceOf',
      total_assets: 'totalAssets', total_supply: 'totalSupply', actual_owner_shares: 'balanceOf', fixed_stock_preview: 'previewRedeem' }
    const traces = restored.receipt.ledger.map((row) => {
      const r = restored.requests.find((x) => x.physicalId === row.physicalId)
      check(r, 'retained_request')
      const name = names[r.key.split(':')[1]]
      const spec = { key: r.key, ...(name ? { name } : {}), method: row.request.method, params: row.request.params }
      return { host: row.host, key: r.key, request: spec, physicalId: row.physicalId,
        envelope: parseUsd3HypotheticalJson(Buffer.from(row.rawBodyBase64, 'base64').toString('utf8')) }
    })
    const currentSource = pairedHeader(traces, blockHeader('fresh_finalized', 'finalized'))
    const currentS = decodePyusdB576V2Result('balanceOf', paired(traces,
      pyusdB576V2PointReadPlan('current', currentSource, '0')[13]))
    const points = [derivePyusdB576V2Point(traces, 'current', currentSource, currentS, p.expectedRuntimes),
      ...p.plan.anchors.map((anchor, i) => derivePyusdB576V2Point(traces, 'anchor_' + i,
        anchor.source, currentS, p.expectedRuntimes, anchor.expectedCashRaw))]
    check(same(points, report.points) && same(currentSource, report.currentSource) && same(currentSource, summary.source) &&
      currentS === report.freshCurrentSharesRaw && report.qualifiedNativeJoin === points.every((x) => x.qualifiedNativeJoin), 'retained_native_fact_join')
  } else check(report.qualifiedNativeJoin === false && terminal.qualifiedNativeJoin === false, 'partial_no_qualification')
  verifyPrepared(p)
  return { status: report.completeNativeAcquisition ? 'retained_native_control_verified' : 'retained_partial_control_only',
    report, terminal, physicalStarts: restored.receipt.physicalStarts, originalControlVerified: report.completeNativeAcquisition,
    qualifiedNativeJoin: report.qualifiedNativeJoin, retainedBytes: budget.bytes, ...FLAGS }
}
export async function runPyusdB576V2IdleHistory(argv = process.argv.slice(2)) {
  check(argv.length <= 1 && ['', '--verify', '--dry-plan', '--capture'].includes(argv[0] ?? ''), 'closed_CLI')
  if (argv[0] !== '--capture') {
    const p = preparePyusdB576V2IdleHistory(), proof = pyusdB576V2StorageBudgetProof(p)
    return { status: argv[0] === '--dry-plan' ? 'closed_plan_no_RPC' : 'verified_no_RPC', subject: p.plan.subject,
      planSha256: PYUSD_B576_V2_PLAN_SHA, producerSha256: p.sources.at(-1).pin.fileSha256,
      anchors: p.plan.anchors, proof, policy: P, ...FLAGS }
  }
  guard(0, false, true)
  const started = performance.now(), p = preparePyusdB576V2IdleHistory()
  const origins = await configuredUsd3HypotheticalOrigins(), secrets = additionalHistoricalOwnerCredentialVariants(origins)
  const directory = resolve(ROOT, 'data/research/venue-signals/pyusd-b576-idle-history-v2-' +
    new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID())
  const writer = createPyusdB576V2Writer(directory, secrets, { started })
  for (const artifact of pyusdB576V2FixedArtifacts(p)) writer.write(artifact.name, artifact.value)
  const capture = await capturePyusdB576V2IdleHistory(p, origins, { started })
  const originals = pyusdB576V2EncodedOriginals(capture)
  for (const row of originals.rows) writer.write(row.name, row.value)
  writer.write('control-summary.json', originals.summary)
  const restored = reconstructPyusdB576V2OriginalControl(originals.summary, originals.rows.map((x) => x.value), capture.completeNativeAcquisition)
  check(same(restored.receipt, capture.receipt) && same(restored.requests, capture.requests) &&
    same(restored.settlements, capture.settlements), 'retained_original_control_equality')
  const report = pyusdB576V2Report(capture, p); writer.write('report.json', report)
  writer.verifyRetained(); verifyPrepared(p)
  const availableAtUtc = utc(Date.now())
  check(performance.now() - started <= P.deadline && freeBytes() >= BigInt(P.reserve) &&
    (!capture.completeNativeAcquisition || Date.parse(availableAtUtc) - Date.parse(capture.currentSource.blockTime) <= 1800000),
    'post_retention_deadline_reserve_age')
  const terminal = seal({ schema: 'pyusd_b576_idle_history_terminal_v2', reportSha256: report.sha256,
    completeNativeAcquisition: capture.completeNativeAcquisition, qualifiedNativeJoin: capture.qualifiedNativeJoin,
    failure: capture.failure, currentSource: capture.currentSource, physicalStarts: capture.physicalStarts,
    pendingSettlements: capture.receipt.pendingSettlements, retainedRows: originals.rows.length,
    postRetentionAvailableAtUtc: availableAtUtc, elapsedMs: performance.now() - started,
    acquisitionDeadlineElapsedMs: P.acquisitionDeadline, retentionReserveMs: P.retentionReserve,
    files: writer.refs.map(({ dev, ino, ...ref }) => ref), ...FLAGS })
  writer.write('terminal.json', terminal, true); writer.verifyRetained(); verifyPrepared(p)
  return { directory, status: capture.completeNativeAcquisition ? 'native_capture_retained' : 'partial_capture_retained',
    qualifiedNativeJoin: capture.qualifiedNativeJoin, failure: capture.failure, physicalStarts: capture.physicalStarts,
    retainedFiles: writer.refs.length, retainedBytes: writer.used(), terminalSha256: terminal.sha256,
    SDKphysicalStarts: null, ...FLAGS }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPyusdB576V2IdleHistory().then((value) => process.stdout.write(JSON.stringify(value) + '\n')).catch(() => {
    process.stderr.write('pyusd_b576_v2_closed_capture_unavailable\n'); process.exitCode = 1
  })
}
