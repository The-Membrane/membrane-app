import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { lstatSync } from 'node:fs'
import { readBoundedReceiptFile } from '../../scripts/lib/boundedLocalReceiptFile.mjs'
import { registeredConditionalSampledCashIdentity } from './conditionalSampledCashPathProjection'
import {
  selectEventConditionedNetScenarios,
  type EventConditionedNetInput,
  type EventNetSubject,
  type ReviewedNetEvent,
} from './eventConditionedNetScenarios'

export const MORPHO_EVENT_CASH_MANIFEST_PATH =
  'scripts/research/morpho-native-event-cash-analysis-v1.manifest.json'
export const MORPHO_EVENT_CASH_MANIFEST_SHA =
  '47b32304f13093d345a9d71fde8a4fb910ec903208bb45e0c3759f3c32d2809c'
const ROOT = resolve(process.cwd())
const MB = 1024 * 1024
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const check: (ok: unknown, reason: string) => asserts ok = (ok, reason) => {
  if (!ok) throw Error('morpho_event_cash_' + reason)
}
const raw = (x: unknown): x is string =>
  typeof x === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(x) && BigInt(x) <= (1n << 256n) - 1n
const sha = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)
const hexHash = (x: unknown): x is string => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x)
const address = (x: unknown): x is string => typeof x === 'string' && /^0x[0-9a-f]{40}$/.test(x)
const utc = (x: unknown): x is string =>
  typeof x === 'string' &&
  Number.isSafeInteger(Date.parse(x)) &&
  new Date(Date.parse(x)).toISOString() === x
const key = (x: EventNetSubject) =>
  JSON.stringify([x.routeKey, x.destination, x.asset, x.assetDecimals])
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
// Only caller-owned data descriptors are read. This copy never invokes accessors.
function snapshot(value: unknown): unknown {
  const ancestry = new WeakSet<object>()
  let nodes = 0,
    strings = 0
  function copy(v: unknown, depth: number): unknown {
    check(++nodes <= 200000 && depth <= 16, 'input_bounds')
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'string') {
      strings += v.length * 2
      check(strings <= 16 * MB, 'input_string_bounds')
      return v
    }
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v), 'input_number')
      return v
    }
    check(v && typeof v === 'object' && !ancestry.has(v), 'input_object')
    const proto = Object.getPrototypeOf(v)
    check(
      Array.isArray(v) ? proto === Array.prototype : proto === Object.prototype || proto === null,
      'input_prototype',
    )
    check(Object.getOwnPropertySymbols(v).length === 0, 'input_symbols')
    const ds = Object.getOwnPropertyDescriptors(v)
    ancestry.add(v)
    try {
      if (Array.isArray(v)) {
        check(v.length <= 8192 && Object.keys(ds).length === v.length + 1, 'input_array')
        return Array.from({ length: v.length }, (_, i) => {
          const d = ds[String(i)]
          check(d && 'value' in d && d.enumerable, 'input_descriptor')
          return copy(d.value, depth + 1)
        })
      }
      const out: Record<string, unknown> = {}
      for (const [name, d] of Object.entries(ds)) {
        check('value' in d && d.enumerable && name !== '__proto__', 'input_descriptor')
        strings += name.length * 2
        check(strings <= 16 * MB, 'input_string_bounds')
        out[name] = copy(d.value, depth + 1)
      }
      return out
    } finally {
      ancestry.delete(v)
    }
  }
  return copy(value, 0)
}
type Descriptor = {
  id: string
  path: string
  bytes: number
  fileSha256: string
  bodySha256: string | null
}
type SourceDescriptor = { path: string; bytes: number; fileSha256: string }
type Manifest = {
  schema: string
  chainId: number
  informationMode: string
  taxonomy: { namespace: string; eventType: string; reviewRef: string; topic: string }
  otherNativeTopics: { withdraw: string; force: string }
  parameters: EventConditionedNetInput['parameters']
  originals: Descriptor[]
  sourceDefinitions: SourceDescriptor[]
  limits: { maxFileBytes: number; maxCohortBytes: number }
}
type Header = { block: string; hash: string; timestamp: string }
type Log = {
  address: string
  blockNumber: string
  blockHash: string
  transactionHash: string
  transactionIndex: number
  logIndex: number
  topics: string[]
  data: string
}
type Subject = { vault: string; asset: string; routeKeys: string[] }
type Witness = {
  origin: string
  raw: Log[]
  separate: Record<'deposit' | 'withdraw' | 'force', Log[]>
  eventHeaders: Header[]
}
type Slice = {
  fromBlock: string
  toBlock: string
  headers: { origin: string; prior: Header; end: Header }[]
  witnesses: Witness[]
}
type NativeReceipt = {
  study: string
  kind: string
  chainId: number
  sha256: string
  sequence: number
  enrollmentSha256: string
  previousSha256: string
  fromBlock: string
  toBlock: string
  priorHash: string
  toHash: string
  slices: Slice[]
  vaults: unknown[]
  firstLocalReceiptAt: string
  researchOnly: boolean
  prospectiveValidated: boolean
  holderExecutableExit: boolean
}
type Enrollment = {
  study: string
  kind: string
  chainId: number
  subjects: Subject[]
  sha256: string
  startBlock: string
  startHash: string
  campaignEndBlock: string
  campaignEndHash: string
  firstLocalReceiptAt: string
  predecessorArchiveSha256: string
  providerOrigins: string[]
}
type CashHistory = {
  identity: EventNetSubject
  witness: { manifestSha256: string; lastDailyReceiptSha256: string; availableAt: string }
  points: [number, string, string, string, string][]
}
export type PinnedMorphoEventCashText = { descriptorId: string; rawText: string }
export type MorphoEventCashCase = {
  identity: EventNetSubject
  metricRegime: string
  policyRegimeVerified: false
  protocolConfigurationStable: false
  originalCashAvailableAtUtc: string
  verificationAvailableAtUtc: string
  input: EventConditionedNetInput
}
export type MorphoNativeEventCashDataset = {
  schema: 'morpho_native_event_cash_dataset_v1'
  knowledgeCutoffUtc: string
  verificationClockBasis: 'measured_completed_verification' | 'caller_asserted_research_cutoff'
  manifest: { path: string; fileSha256: string }
  inputPins: Descriptor[]
  cases: MorphoEventCashCase[]
  excludedCashSubjects: unknown[]
  originalEventEnvelopeClockRange: [string, string]
  counts: {
    cashSubjects: number
    cashPoints: number
    originalBundles: number
    rawNativeLogs: number
    nativeDepositEvents: number
    subjectsWithNativeDeposits: number
  }
  historicallyIssuedForecast: false
  policyRegimeVerified: false
  protocolConfigurationStable: false
  eventCatalogueComplete: false
  authenticated: false
  originalAuthority: false
  calibrated: false
  holderExecutableExit: false
  competingMRaw: null
}
const originalDatasets = new WeakSet<object>()
function readFixed(
  path: string,
  expected: SourceDescriptor,
  budget: { maxFileBytes: number; maxTotalBytes: number; totalBytes: number },
): string {
  check(path === expected.path && !path.includes('..') && !path.startsWith('/'), 'fixed_path')
  let parent = dirname(resolve(ROOT, path))
  while (parent !== ROOT) {
    check(parent.startsWith(ROOT + '/'), 'path_parent')
    const stat = lstatSync(parent)
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'symlink_parent')
    parent = dirname(parent)
  }
  budget.maxFileBytes = Math.min(8 * MB, expected.bytes)
  const text = readBoundedReceiptFile(resolve(ROOT, path), budget) as string
  check(
    Buffer.byteLength(text) === expected.bytes && hash(text) === expected.fileSha256,
    'file_pin',
  )
  return text
}
function manifest(): Manifest {
  const budget = { maxFileBytes: 128 * 1024, maxTotalBytes: 128 * 1024, totalBytes: 0 }
  const text = readFixed(
    MORPHO_EVENT_CASH_MANIFEST_PATH,
    {
      path: MORPHO_EVENT_CASH_MANIFEST_PATH,
      bytes: 22053,
      fileSha256: MORPHO_EVENT_CASH_MANIFEST_SHA,
    },
    budget,
  )
  const m = JSON.parse(text) as Manifest
  check(
    m.schema === 'morpho_native_event_cash_analysis_manifest_v1' &&
      m.informationMode === 'retrospective_training' &&
      m.chainId === 1 &&
      m.originals.length === 57 &&
      m.sourceDefinitions.length === 6,
    'manifest_identity',
  )
  return freeze(m)
}
export function readPinnedMorphoEventCashTexts(): PinnedMorphoEventCashText[] {
  const m = manifest(),
    budget = { maxFileBytes: 8 * MB, maxTotalBytes: 32 * MB, totalBytes: 0 }
  for (const s of m.sourceDefinitions) readFixed(s.path, s, budget)
  const entries = m.originals.map((d) => ({
    descriptorId: d.id,
    rawText: readFixed(d.path, d, budget),
  }))
  for (const s of m.sourceDefinitions) readFixed(s.path, s, budget)
  return entries
}
function sealed(value: Record<string, unknown>): void {
  const { sha256, ...body } = value
  check(sha(sha256) && hash(JSON.stringify(body)) === sha256, 'body_seal')
}
function header(h: Header): number {
  check(
    h &&
      same(Object.keys(h), ['block', 'hash', 'timestamp']) &&
      raw(h.block) &&
      h.block !== '0' &&
      hexHash(h.hash) &&
      raw(h.timestamp) &&
      h.timestamp !== '0',
    'native_header',
  )
  const ms = Number(h.timestamp) * 1000
  check(
    Number.isSafeInteger(ms) && Number.isFinite(Date.parse(new Date(ms).toISOString())),
    'native_timestamp',
  )
  return ms
}
const logOrder = (a: Log, b: Log) =>
  Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
  a.transactionIndex - b.transactionIndex ||
  a.logIndex - b.logIndex
function validateLogs(
  rows: Log[],
  from: string,
  to: string,
  subjects: Map<string, Subject>,
  topics: Record<string, string>,
): void {
  check(Array.isArray(rows) && rows.length <= 4096, 'native_log_bounds')
  const seen = new Set<string>()
  for (const row of rows) {
    check(
      row &&
        same(Object.keys(row), [
          'address',
          'blockNumber',
          'blockHash',
          'transactionHash',
          'transactionIndex',
          'logIndex',
          'topics',
          'data',
        ]) &&
        subjects.has(row.address) &&
        raw(row.blockNumber) &&
        BigInt(row.blockNumber) >= BigInt(from) &&
        BigInt(row.blockNumber) <= BigInt(to) &&
        hexHash(row.blockHash) &&
        hexHash(row.transactionHash) &&
        Number.isSafeInteger(row.transactionIndex) &&
        row.transactionIndex >= 0 &&
        Number.isSafeInteger(row.logIndex) &&
        row.logIndex >= 0 &&
        Array.isArray(row.topics) &&
        row.topics.every(hexHash),
      'native_log_identity',
    )
    const kind = Object.keys(topics).find((k) => topics[k] === row.topics[0])
    check(
      kind &&
        row.topics.length === (kind === 'withdraw' ? 4 : 3) &&
        row.topics.slice(1).every((t) => t.slice(2, 26) === '0'.repeat(24)),
      'native_log_topics',
    )
    check(
      typeof row.data === 'string' &&
        /^0x[0-9a-f]*$/.test(row.data) &&
        row.data.length <= 65536 &&
        (kind === 'force'
          ? row.data.length >= 322 && (row.data.length - 2) % 64 === 0
          : row.data.length === 130),
      'native_log_ABI_data',
    )
    const id = row.transactionHash + ':' + row.logIndex
    check(!seen.has(id), 'native_duplicate_log')
    seen.add(id)
  }
  check(same(rows, [...rows].sort(logOrder)), 'native_log_order')
}
type Occurrence = {
  row: Log
  header: Header
  receipt: { path: string; fileSha256: string; bodySha256: string; firstLocalReceiptAt: string }
}
function validateArchive(
  parsed: Map<string, Record<string, unknown>>,
  m: Manifest,
): {
  occurrences: Occurrence[]
  clocks: [string, string]
  rawCount: number
  subjects: Map<string, Subject>
} {
  const en = parsed.get('event_enrollment') as unknown as Enrollment
  const pilot = parsed.get('pilot_tip') as unknown as NativeReceipt
  const pilotEn = parsed.get('pilot_enrollment') as unknown as Enrollment
  const assets = parsed.get('asset_identities') as unknown as {
    entries: { vault: string; asset: string; creation: { blockNumber: number } }[]
  }
  check(
    en.study === 'carry-morpho-v2-retrospective-block-gross-flow-v2' &&
      en.kind === 'enrollment' &&
      en.chainId === 1 &&
      pilotEn.study === 'carry-morpho-v2-retrospective-block-gross-flow-v1' &&
      pilot.sequence === 1 &&
      pilot.enrollmentSha256 === pilotEn.sha256 &&
      pilot.previousSha256 === pilotEn.sha256 &&
      en.predecessorArchiveSha256 === pilot.sha256 &&
      en.startBlock === pilot.toBlock &&
      en.startHash === pilot.toHash &&
      same(en.subjects, pilotEn.subjects),
    'archive_predecessor',
  )
  check(
    en.subjects.length === 49 &&
      assets.entries.length === 49 &&
      en.providerOrigins.length === 2 &&
      new Set(en.providerOrigins).size === 2 &&
      en.providerOrigins.every((s) => typeof s === 'string' && /^[a-z0-9.-]+$/.test(s)) &&
      raw(en.startBlock) &&
      hexHash(en.startHash) &&
      utc(en.firstLocalReceiptAt),
    'archive_enrollment',
  )
  const subjects = new Map(en.subjects.map((s) => [s.vault, s])),
    creations = new Map<string, bigint>()
  check(subjects.size === 49, 'archive_subject_duplicate')
  for (const s of en.subjects) {
    const a = assets.entries.find((a) => a.vault === s.vault)
    check(
      address(s.vault) &&
        address(s.asset) &&
        s.routeKeys.length === 1 &&
        a &&
        a.asset === s.asset &&
        Number.isSafeInteger(a.creation.blockNumber),
      'archive_asset_join',
    )
    creations.set(s.vault, BigInt(a.creation.blockNumber))
  }
  const topics = { deposit: m.taxonomy.topic, ...m.otherNativeTopics }
  const occurrences: Occurrence[] = [],
    seen = new Set<string>()
  let previous: Enrollment | NativeReceipt = en,
    rawCount = 0
  for (let seq = 1; seq <= 51; seq++) {
    const b = parsed.get('event_bundle_' + seq) as unknown as NativeReceipt
    const prevBlock = 'toBlock' in previous ? previous.toBlock : previous.startBlock
    const prevHash = 'toHash' in previous ? previous.toHash : previous.startHash
    check(
      b.study === en.study &&
        b.kind === 'bundle' &&
        b.chainId === 1 &&
        b.sequence === seq &&
        b.enrollmentSha256 === en.sha256 &&
        b.previousSha256 === previous.sha256 &&
        raw(b.fromBlock) &&
        raw(b.toBlock) &&
        b.fromBlock === String(BigInt(prevBlock) + 1n) &&
        b.priorHash === prevHash &&
        BigInt(b.toBlock) >= BigInt(b.fromBlock) &&
        BigInt(b.toBlock) - BigInt(b.fromBlock) < 512n &&
        BigInt(b.toBlock) <= BigInt(en.campaignEndBlock) &&
        b.researchOnly === true &&
        b.prospectiveValidated === false &&
        b.holderExecutableExit === false &&
        utc(b.firstLocalReceiptAt) &&
        b.firstLocalReceiptAt >= previous.firstLocalReceiptAt &&
        b.slices.length === Math.ceil((Number(b.toBlock) - Number(b.fromBlock) + 1) / 10),
      'archive_sequence',
    )
    let from = BigInt(b.fromBlock),
      priorHash = b.priorHash
    const all: Log[] = []
    for (const sl of b.slices) {
      check(
        sl.fromBlock === String(from) &&
          raw(sl.toBlock) &&
          BigInt(sl.toBlock) >= from &&
          BigInt(sl.toBlock) - from < 10n &&
          sl.headers.length === 2 &&
          sl.witnesses.length === 2 &&
          new Set(sl.headers.map((h) => h.origin)).size === 2 &&
          new Set(sl.witnesses.map((w) => w.origin)).size === 2 &&
          sl.headers.every((h) => en.providerOrigins.includes(h.origin)) &&
          sl.witnesses.every((w) => en.providerOrigins.includes(w.origin)) &&
          same(sl.headers[0].prior, sl.headers[1].prior) &&
          same(sl.headers[0].end, sl.headers[1].end),
        'archive_slice_pair',
      )
      const startMs = header(sl.headers[0].prior),
        endMs = header(sl.headers[0].end)
      check(
        sl.headers[0].prior.block === String(from - 1n) &&
          sl.headers[0].prior.hash === priorHash &&
          sl.headers[0].end.block === sl.toBlock &&
          startMs < endMs &&
          endMs <= Date.parse(b.firstLocalReceiptAt),
        'archive_slice_header',
      )
      for (const w of sl.witnesses) {
        validateLogs(w.raw, sl.fromBlock, sl.toBlock, subjects, topics)
        check(
          same(Object.keys(w.separate), ['deposit', 'withdraw', 'force']) &&
            Object.entries(w.separate).every(([kind, logs]) =>
              logs.every((r) => r.topics[0] === topics[kind as keyof typeof topics]),
            ) &&
            same(
              [...w.separate.deposit, ...w.separate.withdraw, ...w.separate.force].sort(logOrder),
              w.raw,
            ) &&
            same(w.eventHeaders, sl.witnesses[0].eventHeaders),
          'archive_topic_join',
        )
        const byBlock = new Map(w.eventHeaders.map((h) => [h.block, h]))
        check(
          byBlock.size === w.eventHeaders.length &&
            same([...byBlock.keys()], [...new Set(w.raw.map((r) => r.blockNumber))]),
          'archive_event_header_set',
        )
        for (const h of w.eventHeaders)
          check(header(h) > startMs && header(h) <= endMs, 'archive_event_timestamp')
        for (const row of w.raw)
          check(byBlock.get(row.blockNumber)?.hash === row.blockHash, 'archive_event_hash')
      }
      check(same(sl.witnesses[0].raw, sl.witnesses[1].raw), 'archive_raw_pair')
      const byBlock = new Map(sl.witnesses[0].eventHeaders.map((h) => [h.block, h]))
      for (const row of sl.witnesses[0].raw) {
        const id = row.transactionHash + ':' + row.logIndex
        check(!seen.has(id), 'archive_duplicate_across_bundles')
        seen.add(id)
        if (row.topics[0] === topics.deposit) {
          const d = m.originals.find((d) => d.id === 'event_bundle_' + seq)!
          occurrences.push({
            row,
            header: byBlock.get(row.blockNumber)!,
            receipt: {
              path: d.path,
              fileSha256: d.fileSha256,
              bodySha256: b.sha256,
              firstLocalReceiptAt: b.firstLocalReceiptAt,
            },
          })
        }
      }
      all.push(...sl.witnesses[0].raw)
      from = BigInt(sl.toBlock) + 1n
      priorHash = sl.headers[0].end.hash
    }
    check(from === BigInt(b.toBlock) + 1n && b.toHash === priorHash, 'archive_end_cursor')
    const census = en.subjects.map((s) => {
      const creation = creations.get(s.vault)!,
        deployed = creation <= BigInt(b.toBlock)
      return {
        vault: s.vault,
        asset: s.asset,
        routeKeys: s.routeKeys,
        state: deployed ? 'deployed' : 'predeployment',
        creationBlock: String(creation),
        observedFromBlock: deployed
          ? String(creation > BigInt(b.fromBlock) ? creation : BigInt(b.fromBlock))
          : null,
        counts: deployed
          ? Object.fromEntries(
              Object.entries(topics).map(([kind, topic]) => [
                kind,
                all.filter((r) => r.address === s.vault && r.topics[0] === topic).length,
              ]),
            )
          : null,
      }
    })
    check(same(b.vaults, census), 'archive_vault_census')
    rawCount += all.length
    previous = b
  }
  return {
    occurrences,
    rawCount,
    subjects,
    clocks: [
      (parsed.get('event_bundle_1') as unknown as NativeReceipt).firstLocalReceiptAt,
      (parsed.get('event_bundle_51') as unknown as NativeReceipt).firstLocalReceiptAt,
    ],
  }
}
function decodeTexts(supplied: unknown, m: Manifest) {
  const entries = snapshot(supplied) as PinnedMorphoEventCashText[]
  check(Array.isArray(entries) && entries.length === m.originals.length, 'original_count')
  const texts = new Map<string, string>(),
    parsed = new Map<string, Record<string, unknown>>()
  let bytes = 0
  for (const e of entries) {
    check(
      e && same(Object.keys(e), ['descriptorId', 'rawText']) && typeof e.rawText === 'string',
      'original_descriptor',
    )
    const d = m.originals.find((d) => d.id === e.descriptorId)
    check(d && !texts.has(e.descriptorId), 'original_identity')
    const size = Buffer.byteLength(e.rawText)
    bytes += size
    check(
      size === d.bytes && size <= 8 * MB && bytes <= 32 * MB && hash(e.rawText) === d.fileSha256,
      'original_file_pin',
    )
    const record = JSON.parse(e.rawText) as Record<string, unknown>
    check(record && Object.getPrototypeOf(record) === Object.prototype, 'original_JSON')
    if (d.bodySha256 !== null) {
      sealed(record)
      check(record.sha256 === d.bodySha256, 'original_body_pin')
      if (d.id.startsWith('event_') || d.id.startsWith('pilot_'))
        check(e.rawText === JSON.stringify(record) + '\n', 'native_canonical_file')
    }
    texts.set(e.descriptorId, e.rawText)
    parsed.set(e.descriptorId, record)
  }
  const audit = parsed.get('cash_audit') as unknown as {
    histories: Record<string, CashHistory>
    exclusions: unknown[]
    profile: unknown
    pinArtifactSha256: string
  }
  const pins = parsed.get('cash_pins') as unknown as {
    pins: Record<
      string,
      {
        compactSha256: string
        assetDecimals: number
        manifestSha256: string
        lastDailyReceiptSha256: string
        availableAt: string
      }
    >
    profile: unknown
    sha256: string
  }
  check(
    Object.keys(audit.histories).length === 64 &&
      Object.keys(pins.pins).length === 64 &&
      audit.exclusions.length === 4 &&
      audit.pinArtifactSha256 === pins.sha256 &&
      same(audit.profile, pins.profile),
    'cash_roster',
  )
  const histories = Object.values(audit.histories),
    identities = new Set<string>()
  for (const [k, h] of Object.entries(audit.histories)) {
    const native = registeredConditionalSampledCashIdentity(
        h.identity.routeKey,
        h.identity.destination,
      ),
      pin = pins.pins[k]
    check(
      native &&
        same(native, h.identity) &&
        k === [h.identity.routeKey, h.identity.destination, h.identity.asset].join('\0') &&
        !identities.has(key(h.identity)) &&
        pin &&
        pin.compactSha256 === hash(JSON.stringify(h)) &&
        pin.assetDecimals === h.identity.assetDecimals &&
        ['manifestSha256', 'lastDailyReceiptSha256', 'availableAt'].every(
          (name) => h.witness[name as keyof typeof h.witness] === pin[name as keyof typeof pin],
        ) &&
        utc(h.witness.availableAt) &&
        h.points.length >= 2 &&
        h.points.length <= 120,
      'cash_identity_pin',
    )
    identities.add(key(h.identity))
    for (const [i, p] of h.points.entries()) {
      check(
        Array.isArray(p) &&
          p.length === 5 &&
          Number.isSafeInteger(p[0]) &&
          p[0] >= 0 &&
          raw(p[1]) &&
          p[1] !== '0' &&
          hexHash(p[2]) &&
          utc(p[3]) &&
          raw(p[4]) &&
          Date.parse(p[3]) <= Date.parse(h.witness.availableAt) &&
          (!i ||
            (p[0] > h.points[i - 1][0] &&
              BigInt(p[1]) > BigInt(h.points[i - 1][1]) &&
              p[3] > h.points[i - 1][3])),
        'cash_point',
      )
    }
  }
  return { histories, exclusions: audit.exclusions, native: validateArchive(parsed, m) }
}
function dataset(
  decoded: ReturnType<typeof decodeTexts>,
  m: Manifest,
  cutoff: string,
  clockBasis: MorphoNativeEventCashDataset['verificationClockBasis'],
): MorphoNativeEventCashDataset {
  check(utc(cutoff), 'research_cutoff')
  check(
    decoded.histories.every((h) => h.witness.availableAt <= cutoff) &&
      decoded.native.clocks[1] <= cutoff,
    'cutoff_before_retention',
  )
  let depositCount = 0
  const cases = decoded.histories.map((h): MorphoEventCashCase => {
    const regime =
      'metric_only:ERC20.balanceOf(vault):chain1:' +
      h.identity.asset +
      ':decimals' +
      h.identity.assetDecimals
    const originalSubject = decoded.native.subjects.get(h.identity.destination)
    const originalOccurrences = decoded.native.occurrences.filter(
      (e) => e.row.address === h.identity.destination,
    )
    if (originalOccurrences.length)
      check(
        originalSubject &&
          originalSubject.asset === h.identity.asset &&
          originalSubject.routeKeys.includes(h.identity.routeKey),
        'event_cash_subject_join',
      )
    const events: ReviewedNetEvent[] = originalOccurrences.map((e) => {
      const id = 'ethereum1:' + e.row.address + ':' + e.row.transactionHash + ':' + e.row.logIndex
      const occurred = new Date(header(e.header)).toISOString()
      return {
        subject: h.identity,
        regime,
        taxonomy: {
          namespace: m.taxonomy.namespace,
          eventType: m.taxonomy.eventType,
          reviewRef: m.taxonomy.reviewRef,
        },
        eventId: id,
        storyId: id,
        duplicateGroupId: id,
        knowledgeBasis: 'reviewed_occurrence_without_publication',
        kind: 'official_observed',
        occurredAtUtc: occurred,
        firstKnownAtUtc: e.receipt.firstLocalReceiptAt,
        // Original envelope acquisition boundary, not a fabricated per-RPC timestamp.
        fetchedAtUtc: e.receipt.firstLocalReceiptAt,
        availableAtUtc: cutoff,
        publishedAtUtc: null,
        occurrenceProof: {
          kind: 'native_block',
          occurredAtUtc: occurred,
          availableAtUtc: cutoff,
          sourceRef:
            e.receipt.path +
            '#bodySHA=' +
            e.receipt.bodySha256 +
            ':tx=' +
            e.row.transactionHash +
            ':log=' +
            e.row.logIndex,
          reviewRef: m.taxonomy.reviewRef,
          block: e.row.blockNumber,
          blockHash: e.row.blockHash,
        },
      }
    })
    depositCount += events.length
    const last = h.points.at(-1)!
    const input: EventConditionedNetInput = {
      informationMode: 'retrospective_training',
      target: {
        subject: h.identity,
        regime,
        source: {
          block: last[1],
          blockHash: last[2],
          sourceAtUtc: last[3],
          availableAtUtc: cutoff,
        },
      },
      knowledgeCutoffUtc: cutoff,
      taxonomy: {
        namespace: m.taxonomy.namespace,
        eventType: m.taxonomy.eventType,
        reviewRef: m.taxonomy.reviewRef,
      },
      scope: { kind: 'exact_subject' },
      parameters: m.parameters,
      histories: [
        {
          subject: h.identity,
          points: h.points.map((p) => ({
            index: p[0],
            block: p[1],
            blockHash: p[2],
            sourceAtUtc: p[3],
            availableAtUtc: cutoff,
            regime,
            cashRaw: p[4],
            provenanceRef:
              h.witness.manifestSha256 + ':' + h.witness.lastDailyReceiptSha256 + ':index=' + p[0],
          })),
        },
      ],
      events,
    }
    return {
      identity: h.identity,
      metricRegime: regime,
      policyRegimeVerified: false,
      protocolConfigurationStable: false,
      originalCashAvailableAtUtc: h.witness.availableAt,
      verificationAvailableAtUtc: cutoff,
      input,
    }
  })
  const result: MorphoNativeEventCashDataset = {
    schema: 'morpho_native_event_cash_dataset_v1',
    knowledgeCutoffUtc: cutoff,
    verificationClockBasis: clockBasis,
    manifest: { path: MORPHO_EVENT_CASH_MANIFEST_PATH, fileSha256: MORPHO_EVENT_CASH_MANIFEST_SHA },
    inputPins: m.originals,
    cases,
    excludedCashSubjects: decoded.exclusions,
    originalEventEnvelopeClockRange: decoded.native.clocks,
    counts: {
      cashSubjects: cases.length,
      cashPoints: decoded.histories.reduce((n, h) => n + h.points.length, 0),
      originalBundles: 51,
      rawNativeLogs: decoded.native.rawCount,
      nativeDepositEvents: depositCount,
      subjectsWithNativeDeposits: cases.filter((c) => c.input.events.length > 0).length,
    },
    historicallyIssuedForecast: false,
    policyRegimeVerified: false,
    protocolConfigurationStable: false,
    eventCatalogueComplete: false,
    authenticated: false,
    originalAuthority: false,
    calibrated: false,
    holderExecutableExit: false,
    competingMRaw: null,
  }
  freeze(result)
  originalDatasets.add(result)
  return result
}
/** Pure research reconstruction at a declared cutoff. No original/native authority is issued. */
export function replayPinnedMorphoNativeEventCashDataset(
  texts: unknown,
  cutoff: string,
): MorphoNativeEventCashDataset {
  const m = manifest()
  return dataset(decodeTexts(texts, m), m, cutoff, 'caller_asserted_research_cutoff')
}
/** Fixed local inputs only. No provider, poller, SDK acquisition or network import. */
export function readPinnedMorphoNativeEventCashDataset(): MorphoNativeEventCashDataset {
  const m = manifest(),
    texts = readPinnedMorphoEventCashTexts(),
    decoded = decodeTexts(texts, m)
  return dataset(decoded, m, new Date(Date.now()).toISOString(), 'measured_completed_verification')
}
type Rate = { numeratorRaw: string; denominatorMs: number }
type Prediction = {
  // Status scores signed NET, not whether every stock-band scenario is usable.
  status: 'scored' | 'censored' | 'insufficient_training'
  reason: string | null
  donorCount: number
  predictedNETRaw: string | null
  actualNETRaw: string | null
  NETErrorRaw: string | null
  absoluteNETErrorRaw: string | null
  projectedLatentEndCashRaw: string | null
  predictedEndCashRaw: string | null
  band: { minimumRaw: string; maximumRaw: string } | null
  latentBand: { minimumRaw: string; maximumRaw: string } | null
  physicalStockBandStatus: 'qualified_native_range' | 'censored_boundary_risk' | 'unavailable'
  physicalStockBoundaryReason: 'negative_projected_cash' | 'above_uint256_projected_cash' | null
  pointErrorBasis: 'signed_NET_equivalent_latent_endpoint' | null
  errorRaw: string | null
  absoluteErrorRaw: string | null
  covered: boolean | null
}
export type RetrospectiveNativeCashFold = {
  fromIndex: number
  toIndex: number
  originSourceAtUtc: string
  labelSourceAtUtc: string
  actualDurationMs: number
  actualEndCashRaw: string | null
  featuresLatestOccurrenceAtUtc: string | null
  latestTrainingEndpointAtUtc: string | null
  baseline: Prediction
  eventAssociated: Prediction
  persistence: { predictedEndCashRaw: string | null; absoluteErrorRaw: string | null }
  matchedEventClusters: number
  sourceAgeMs: 0
  sourceTimeOriginIsCounterfactual: true
  historicallyIssuedForecast: false
}
const floor = (n: bigint, d: bigint) => (n >= 0n ? n / d : -((-n + d - 1n) / d))
const abs = (n: bigint) => (n < 0n ? -n : n)
const rateOrder = (a: Rate, b: Rate) => {
  const left = BigInt(a.numeratorRaw) * BigInt(b.denominatorMs),
    right = BigInt(b.numeratorRaw) * BigInt(a.denominatorMs)
  return left < right ? -1 : left > right ? 1 : 0
}
function predict(
  rates: Rate[],
  startCash: string,
  actualCash: string,
  dt: number,
  unavailableReason: string | null,
): Prediction {
  const none: Prediction = {
    status: 'insufficient_training',
    reason: unavailableReason,
    donorCount: rates.length,
    predictedNETRaw: null,
    actualNETRaw: null,
    NETErrorRaw: null,
    absoluteNETErrorRaw: null,
    projectedLatentEndCashRaw: null,
    predictedEndCashRaw: null,
    band: null,
    latentBand: null,
    physicalStockBandStatus: 'unavailable',
    physicalStockBoundaryReason: null,
    pointErrorBasis: null,
    errorRaw: null,
    absoluteErrorRaw: null,
    covered: null,
  }
  if (unavailableReason || rates.length < 3)
    return {
      ...none,
      status: unavailableReason?.startsWith('heldout_') ? 'censored' : 'insufficient_training',
      reason: unavailableReason ?? 'minimum_three_prior_native_donors',
    }
  const sorted = [...rates].sort(rateOrder)
  const net = (r: Rate) => floor(BigInt(r.numeratorRaw) * BigInt(dt), BigInt(r.denominatorMs))
  const predictedNET = net(sorted[Math.floor((sorted.length - 1) / 2)])
  const maximum = (1n << 256n) - 1n
  if (abs(predictedNET) > maximum)
    return { ...none, status: 'censored', reason: 'projected_NET_out_of_signed_native_range' }
  const actualNET = BigInt(actualCash) - BigInt(startCash)
  const lo = BigInt(startCash) + net(sorted[0]),
    hi = BigInt(startCash) + net(sorted.at(-1)!)
  const mid = BigInt(startCash) + predictedNET
  const boundary = [lo, hi, mid].some((n) => n < 0n)
    ? 'negative_projected_cash'
    : [lo, hi, mid].some((n) => n > maximum)
      ? 'above_uint256_projected_cash'
      : null
  const error = predictedNET - actualNET
  // A negative latent stock is boundary risk. Its signed NET error still counts.
  return {
    status: 'scored',
    reason: null,
    donorCount: rates.length,
    predictedNETRaw: String(predictedNET),
    actualNETRaw: String(actualNET),
    NETErrorRaw: String(error),
    absoluteNETErrorRaw: String(abs(error)),
    projectedLatentEndCashRaw: String(mid),
    predictedEndCashRaw: boundary ? null : String(mid),
    band: boundary ? null : { minimumRaw: String(lo), maximumRaw: String(hi) },
    latentBand: { minimumRaw: String(lo), maximumRaw: String(hi) },
    physicalStockBandStatus: boundary ? 'censored_boundary_risk' : 'qualified_native_range',
    physicalStockBoundaryReason: boundary,
    pointErrorBasis: 'signed_NET_equivalent_latent_endpoint',
    errorRaw: String(error),
    absoluteErrorRaw: String(abs(error)),
    covered: boundary ? null : BigInt(actualCash) >= lo && BigInt(actualCash) <= hi,
  }
}
/** Counterfactual source-time chronological benchmark. Actual retained clocks stay unchanged.
 * Held-out end cash and events after the origin cannot enter selection or fitting. */
export function scoreRetrospectiveNativeCashResearchCase(
  supplied: unknown,
): RetrospectiveNativeCashFold[] | null {
  try {
    const input = snapshot(supplied) as EventConditionedNetInput
    check(
      input.informationMode === 'retrospective_training' &&
        input.scope.kind === 'exact_subject' &&
        input.histories.length === 1 &&
        selectEventConditionedNetScenarios(input),
      'holdout_input',
    )
    const points = input.histories[0].points,
      folds: RetrospectiveNativeCashFold[] = []
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        z = points[i],
        dt = Date.parse(z.sourceAtUtc) - Date.parse(a.sourceAtUtc)
      const training = points.filter((p) => p.sourceAtUtc <= a.sourceAtUtc)
      const features = input.events.filter((e) => e.occurredAtUtc <= a.sourceAtUtc)
      const selection =
        training.length >= 2
          ? selectEventConditionedNetScenarios({
              ...input,
              target: {
                ...input.target,
                source: {
                  block: a.block,
                  blockHash: a.blockHash,
                  sourceAtUtc: a.sourceAtUtc,
                  availableAtUtc: a.availableAtUtc,
                },
              },
              histories: [{ ...input.histories[0], points: training }],
              events: features,
            })
          : null
      const selected = selection?.subjects[0]
      const originAvailable = Date.parse(a.availableAtUtc) <= Date.parse(input.knowledgeCutoffUtc)
      const labelAvailable = Date.parse(z.availableAtUtc) <= Date.parse(input.knowledgeCutoffUtc)
      const durationReason =
        !originAvailable || !labelAvailable
          ? 'heldout_observation_not_available_at_knowledge_cutoff'
          : dt < input.parameters.minimumIntervalSeconds * 1000 ||
              dt > input.parameters.maximumGapSeconds * 1000 ||
              z.index !== a.index + 1 ||
              a.regime !== input.target.regime ||
              z.regime !== input.target.regime
            ? 'heldout_gap_or_metric_regime_mismatch'
            : null
      const rates = selected?.baselineNativeNet ?? []
      const latest = rates.length
        ? rates
            .map((r) => r.toAtUtc)
            .sort()
            .at(-1)!
        : null
      check(latest === null || latest < a.sourceAtUtc, 'heldout_endpoint_leak')
      folds.push({
        fromIndex: a.index,
        toIndex: z.index,
        originSourceAtUtc: a.sourceAtUtc,
        labelSourceAtUtc: z.sourceAtUtc,
        actualDurationMs: dt,
        actualEndCashRaw: labelAvailable ? z.cashRaw : null,
        featuresLatestOccurrenceAtUtc: features.length
          ? features
              .map((e) => e.occurredAtUtc)
              .sort()
              .at(-1)!
          : null,
        latestTrainingEndpointAtUtc: latest,
        baseline: predict(
          rates.map((r) => r.rate),
          a.cashRaw,
          z.cashRaw,
          dt,
          durationReason,
        ),
        eventAssociated: predict(
          (selected?.matched ?? []).map((r) => r.rate),
          a.cashRaw,
          z.cashRaw,
          dt,
          durationReason ??
            (selected?.status === 'event_associated_net_scenarios'
              ? null
              : (selected?.reason ?? 'no_prior_event_selection')),
        ),
        persistence: {
          predictedEndCashRaw: originAvailable ? a.cashRaw : null,
          absoluteErrorRaw:
            originAvailable && labelAvailable
              ? String(abs(BigInt(a.cashRaw) - BigInt(z.cashRaw)))
              : null,
        },
        matchedEventClusters: selected?.counts.matchedEventClusters ?? 0,
        sourceAgeMs: 0,
        sourceTimeOriginIsCounterfactual: true,
        historicallyIssuedForecast: false,
      })
    }
    return freeze(folds)
  } catch {
    return null
  }
}
function meanError(values: string[]) {
  return values.length
    ? {
        numeratorRaw: String(values.reduce((n, s) => n + BigInt(s), 0n)),
        denominator: values.length,
      }
    : null
}
function describeRates(rates: { netDeltaRaw: string; rate: Rate }[]) {
  return {
    intervals: rates.length,
    persistenceEndpointMAERaw: meanError(rates.map((r) => String(abs(BigInt(r.netDeltaRaw))))),
    signedNETSumRaw: rates.length
      ? String(rates.reduce((n, r) => n + BigInt(r.netDeltaRaw), 0n))
      : null,
    nativeRateMinimum: rates.length
      ? [...rates].sort((a, b) => rateOrder(a.rate, b.rate))[0].rate
      : null,
    nativeRateMaximum: rates.length
      ? [...rates].sort((a, b) => rateOrder(a.rate, b.rate)).at(-1)!.rate
      : null,
  }
}
export function analyzeMorphoNativeEventCashDataset(value: unknown) {
  check(
    value && typeof value === 'object' && originalDatasets.has(value),
    'original_research_dataset_required',
  )
  const d = value as MorphoNativeEventCashDataset
  const subjects = d.cases.map((c) => {
    const selected = selectEventConditionedNetScenarios(c.input)
    check(selected, 'selector_rejected_pinned_case')
    const folds = scoreRetrospectiveNativeCashResearchCase(c.input)
    check(folds, 'holdout_rejected_pinned_case')
    const summary = (channel: 'baseline' | 'eventAssociated') => {
      const scored = folds.filter((f) => f[channel].status === 'scored')
      return {
        scoredFolds: scored.length,
        censoredFolds: folds.filter((f) => f[channel].status === 'censored').length,
        insufficientFolds: folds.filter((f) => f[channel].status === 'insufficient_training')
          .length,
        NETMAERaw: meanError(scored.map((f) => f[channel].absoluteNETErrorRaw!)),
        latentEndpointMAERaw: meanError(scored.map((f) => f[channel].absoluteErrorRaw!)),
        persistenceNETMAEOnSameFoldsRaw: meanError(
          scored.map((f) => f.persistence.absoluteErrorRaw!),
        ),
        scoringBasis: 'signed_NET_all_eligible_folds_not_only_finite_stock_bands',
        physicalStockBandQualifiedFolds: scored.filter(
          (f) => f[channel].physicalStockBandStatus === 'qualified_native_range',
        ).length,
        physicalStockBandBoundaryRiskFolds: scored.filter(
          (f) => f[channel].physicalStockBandStatus === 'censored_boundary_risk',
        ).length,
        empiricalBandCovered: scored.filter((f) => f[channel].covered === true).length,
        empiricalBandDenominator: scored.filter((f) => f[channel].band !== null).length,
        beatsPersistence: scored.filter(
          (f) => BigInt(f[channel].absoluteErrorRaw!) < BigInt(f.persistence.absoluteErrorRaw!),
        ).length,
        tiesPersistence: scored.filter(
          (f) => f[channel].absoluteErrorRaw === f.persistence.absoluteErrorRaw,
        ).length,
      }
    }
    return {
      identity: c.identity,
      metricRegime: c.metricRegime,
      input: c.input,
      selection: selected,
      chronologicalFolds: folds,
      summary: {
        status: selected.subjects[0].status,
        reason: selected.subjects[0].reason,
        counts: selected.subjects[0].counts,
        associated: describeRates(selected.subjects[0].matched),
        unmatched: describeRates(selected.subjects[0].comparableUnmatched),
        nativeBaseline: describeRates(selected.subjects[0].baselineNativeNet),
        chronologicalBaseline: summary('baseline'),
        chronologicalEventAssociated: summary('eventAssociated'),
        chronologicalFoldCount: folds.length,
        originalCashAvailableAtUtc: c.originalCashAvailableAtUtc,
        verificationAvailableAtUtc: c.verificationAvailableAtUtc,
        originalEventEnvelopeClockRange: d.originalEventEnvelopeClockRange,
        policyRegimeVerified: false,
        protocolConfigurationStable: false,
        retrospectiveDescriptive: true,
        historicallyIssuedForecast: false,
        sourceAgeAppliedHere: false,
        independentSampleCount: null,
        competingMRaw: null,
        fullPeriodCoverage: false,
        calibrated: false,
        holderExecutableExit: false,
      },
    }
  })
  return freeze({
    schema: 'morpho_native_event_cash_analysis_v1',
    dataset: d,
    subjects,
    counts: {
      ...d.counts,
      selectorSubjects: subjects.length,
      chronologicalFolds: subjects.reduce((n, s) => n + s.chronologicalFolds.length, 0),
      eventAssociatedModelsAvailable: subjects.filter(
        (s) => s.summary.status === 'event_associated_net_scenarios',
      ).length,
    },
    informationMode: 'retrospective_training',
    benchmark: 'counterfactual_source_time_chronological_native_cash',
    sourceTimeOriginIsCounterfactual: true,
    historicallyIssuedForecast: false,
    trainingEndpointsStrictlyBeforeOrigin: true,
    futureNativeEventsExcludedFromFeatures: true,
    signedNETScoredEvenWhenPhysicalStockBandCensored: true,
    negativePhysicalStockClamped: false,
    receiptClocksBackdated: false,
    sourceAgeMs: 0,
    originalAuthority: false,
    authenticated: false,
    causal: false,
    calibrated: false,
    forecastValidated: false,
    holderExecutableExit: false,
    competingMRaw: null,
  })
}
