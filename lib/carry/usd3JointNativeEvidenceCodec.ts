import { encodeFunctionData, keccak256, sha256, stringToHex, bytesToHex, type Abi } from 'viem'
import {
  resolveUsd3JointTrustedProfile,
  type Usd3JointHistorySource,
} from './usd3JointTrustedProfile'

export const USD3_JOINT_NATIVE_EVIDENCE_LIMITS = Object.freeze({
  transportBytes: 512 * 1024,
  privateCaptureBytes: 8 * 1024 * 1024,
  responseBytes: 64 * 1024,
  codeDictionaryItems: 16,
  runtimeBytes: 64 * 1024,
  origins: 2,
  anchors: 4,
  tracesPerAnchor: 17,
})
export type Usd3JointNativeHistorySubject = {
  routeKey: string
  destination: string
  asset: string
  assetDecimals: 6
  shareDecimals: 6
  sharesRaw: string
  withdrawalLimitSubject: string
}
export type Usd3JointNativeRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params: unknown[]
}
export type Usd3JointNativeResponse =
  | { jsonrpc: '2.0'; id: number; result: unknown }
  | {
      jsonrpc: '2.0'
      id: number
      error: { code: number; message: 'native_withdrawal_limit_unavailable' }
    }
export type Usd3JointNativeTrace = {
  key: string
  request: Usd3JointNativeRequest
  response: Usd3JointNativeResponse
  startedAtUtc: string
  completedAtUtc: string
}
export type Usd3JointNativeHistoryEvidenceTransport = {
  schemaVersion: 1
  kind: 'usd3_joint_native_history_evidence_v1'
  profileId: string
  subject: Usd3JointNativeHistorySubject
  anchors: { cashIndex: number; source: Usd3JointHistorySource }[]
  startedAtUtc: string
  acquiredAtUtc: string
  provenance: { originalBodySha256: string; originalPlanSha256: string }
  owner: null
  historicalOwnership: false
  ownerCommitmentQualification: false
  authenticated: false
  originalAuthority: false
  codeDictionary: Record<string, string>
  origins: { host: string; chain: Usd3JointNativeTrace; anchors: Usd3JointNativeTrace[][] }[]
}
export type Usd3JointNativeHistoryPoint = {
  source: Usd3JointHistorySource
  acquiredAtUtc: string
  hypotheticalSharesRaw: string
  shareDecimals: 6
  asset: string
  assetDecimals: 6
  nativeEaRaw: string
  availableWithdrawLimitRaw: string | null
  nativeQuoteStatus:
    | 'conditional_reference_address_quote'
    | 'censored_native_withdrawal_limit_unavailable'
  withdrawalLimitSubject: string
  conditionalReferenceAddressQuote: true
  ownerCommitmentQualification: false
  shutdown: boolean
  navRaw: string
  totalAssetsRaw: string
  idleUsdcDiagnosticRaw: string
  idleUsdcIsTotalFundingUpperBound: false
  sourceClass: 'captured_identical_runtimes_only'
  runtimeIdentities: { address: string; runtimeKeccak256: string }[]
  sourceImplementationEquivalence: false
}
export type Usd3JointDecodedNativeHistoryEvidence = {
  profileId: string
  provenance: Usd3JointNativeHistoryEvidenceTransport['provenance']
  subject: Usd3JointNativeHistorySubject
  startedAtUtc: string
  acquiredAtUtc: string
  availableAtUtc: string
  points: Usd3JointNativeHistoryPoint[]
  owner: null
  historicalOwnership: false
  ownerCommitmentQualification: false
  authenticated: false
  originalAuthority: false
  authoritativeNativeCapture: false
}
const ADDRESS = /^0x[0-9a-f]{40}$/,
  WORD = /^0x[0-9a-f]{64}$/,
  DIGEST = /^[0-9a-f]{64}$/
const MAX = (1n << 256n) - 1n
const encoder = new TextEncoder()
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw Error('usd3_joint_codec_' + code)
}
const obj = (v: unknown): Record<string, unknown> => {
  check(v && typeof v === 'object' && !Array.isArray(v), 'object')
  return v as Record<string, unknown>
}
const exact = (v: unknown, names: readonly string[]) => {
  const o = obj(v)
  check(Object.keys(o).length === names.length && names.every((k) => Object.hasOwn(o, k)), 'keys')
  return o
}
const arr = (v: unknown, count: number) => {
  check(
    Array.isArray(v) && v.length === count && Object.getOwnPropertyNames(v).length === count + 1,
    'dense_array',
  )
  return v as unknown[]
}
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, n) => same(v, b[n]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const x = obj(a),
      y = obj(b)
    return (
      Object.keys(x).length === Object.keys(y).length &&
      Object.keys(x).every((k) => Object.hasOwn(y, k) && same(x[k], y[k]))
    )
  }
  return false
}
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const uint = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const digest = (v: unknown) => typeof v === 'string' && DIGEST.test(v)
const hash = (v: string) => sha256(stringToHex(v)).slice(2)
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}

// Snapshot plain own-data trees with bounded work before serialization can execute accessors.
function snapshot(input: unknown, cap: number): unknown {
  let count = 0,
    bytes = 0
  const seen = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(depth <= 32 && ++count <= 100000, 'tree_limit')
    if (typeof v === 'string') {
      check(v.length <= cap, 'tree_bytes')
      bytes += encoder.encode(v).length
      check(bytes <= cap, 'tree_bytes')
      return v
    }
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      check(Number.isFinite(v), 'number')
      return v
    }
    check(
      v && typeof v === 'object' && !seen.has(v) && Object.getOwnPropertySymbols(v).length === 0,
      'plain_tree',
    )
    check(
      Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),
      'prototype',
    )
    seen.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    check(
      Object.values(ds).every((d) => Object.hasOwn(d, 'value')),
      'accessor',
    )
    if (Array.isArray(v)) {
      arr(v, v.length)
      return Array.from({ length: v.length }, (_, n) => {
        check(ds[n]?.enumerable, 'sparse')
        return copy(ds[n].value, depth + 1)
      })
    }
    const out: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(ds)) {
      check(d.enumerable && !['__proto__', 'constructor', 'prototype'].includes(k), 'hidden_key')
      bytes += k.length
      check(bytes <= cap, 'tree_bytes')
      out[k] = copy(d.value, depth + 1)
    }
    return out
  }
  const result = copy(input, 0)
  check(encoder.encode(JSON.stringify(result)).length <= cap, 'serialized_bytes')
  return result
}
/** Reject duplicate decoded keys before JSON.parse can discard evidence. */
export function parseUsd3JointNativeEvidenceJson(
  text: string,
  cap = USD3_JOINT_NATIVE_EVIDENCE_LIMITS.transportBytes,
): unknown {
  check(
    typeof text === 'string' && text.length <= cap && encoder.encode(text).length <= cap,
    'json_bytes',
  )
  let i = 0
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  const string = () => {
    const start = i++
    check(text[start] === '"', 'json_string')
    while (i < text.length) {
      const c = text[i++]
      if (c === '\\') i++
      else if (c === '"') return JSON.parse(text.slice(start, i)) as string
    }
    throw Error('usd3_joint_codec_json_string')
  }
  const value = (depth: number): void => {
    check(depth <= 32, 'json_depth')
    ws()
    if (text[i] === '"') {
      string()
      return
    }
    if (text[i] === '{') {
      i++
      ws()
      const keys = new Set<string>()
      if (text[i] === '}') {
        i++
        return
      }
      while (true) {
        ws()
        const k = string()
        check(!keys.has(k), 'duplicate_json_key')
        keys.add(k)
        ws()
        check(text[i++] === ':', 'json_colon')
        value(depth + 1)
        ws()
        const c = text[i++]
        if (c === '}') return
        check(c === ',', 'json_object')
      }
    }
    if (text[i] === '[') {
      i++
      ws()
      if (text[i] === ']') {
        i++
        return
      }
      while (true) {
        value(depth + 1)
        ws()
        const c = text[i++]
        if (c === ']') return
        check(c === ',', 'json_array')
      }
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    check(m, 'json_atom')
    i += m[0].length
  }
  value(0)
  ws()
  check(i === text.length, 'json_trailing')
  return JSON.parse(text)
}
const ABI: Abi = [
  ...['tokenizedStrategyAddress', 'asset'].map((name) => ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  })),
  ...['decimals', 'nav', 'totalAssets'].map((name) => ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: name === 'decimals' ? 'uint8' : 'uint256' }],
  })),
  {
    type: 'function',
    name: 'isShutdown',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  ...[
    ['previewRedeem', 'uint256'],
    ['availableWithdrawLimit', 'address'],
    ['balanceOf', 'address'],
  ].map(([name, type]) => ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [{ name: 'subject', type }],
    outputs: [{ type: 'uint256' }],
  })),
]
const profile = resolveUsd3JointTrustedProfile(
  'USDC → USD3 [USDC]',
  '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
)!
function specs(subject: Usd3JointNativeHistorySubject, source: Usd3JointHistorySource) {
  const [proxy, impl, delegate, asset] = profile.runtimePins.map((p) => p.address)
  const pin = { blockHash: source.blockHash, requireCanonical: true },
    header = {
      method: 'eth_getBlockByNumber',
      params: ['0x' + source.blockNumber.toString(16), false],
    }
  const call = (to: string, functionName: string, args: readonly unknown[] = []) => ({
    method: 'eth_call',
    params: [{ to, data: encodeFunctionData({ abi: ABI, functionName, args }) }, pin],
  })
  return [
    { key: 'header_before', ...header },
    { key: 'proxy_code', method: 'eth_getCode', params: [proxy, pin] },
    {
      key: 'implementation_slot',
      method: 'eth_getStorageAt',
      params: [proxy, profile.implementationSlot, pin],
    },
    { key: 'implementation_code', method: 'eth_getCode', params: [impl, pin] },
    { key: 'delegate', ...call(proxy, 'tokenizedStrategyAddress') },
    { key: 'delegate_code', method: 'eth_getCode', params: [delegate, pin] },
    { key: 'asset_code', method: 'eth_getCode', params: [asset, pin] },
    { key: 'asset', ...call(proxy, 'asset') },
    { key: 'share_decimals', ...call(proxy, 'decimals') },
    { key: 'asset_decimals', ...call(asset, 'decimals') },
    { key: 'native_ea', ...call(proxy, 'previewRedeem', [BigInt(subject.sharesRaw)]) },
    {
      key: 'withdrawal_limit',
      ...call(proxy, 'availableWithdrawLimit', [subject.withdrawalLimitSubject]),
    },
    { key: 'shutdown', ...call(proxy, 'isShutdown') },
    { key: 'nav', ...call(proxy, 'nav') },
    { key: 'total_assets', ...call(proxy, 'totalAssets') },
    { key: 'idle_usdc_diagnostic', ...call(asset, 'balanceOf', [proxy]) },
    { key: 'header_after', ...header },
  ]
}
function checkedSubject(v: unknown): Usd3JointNativeHistorySubject {
  const s = exact(v, [
    'routeKey',
    'destination',
    'asset',
    'assetDecimals',
    'shareDecimals',
    'sharesRaw',
    'withdrawalLimitSubject',
  ])
  check(
    s.routeKey === profile.subject.routeKey &&
      s.destination === profile.subject.destination &&
      s.asset === profile.subject.asset &&
      s.assetDecimals === 6 &&
      s.shareDecimals === 6 &&
      uint(s.sharesRaw) &&
      BigInt(s.sharesRaw) > 0n &&
      typeof s.withdrawalLimitSubject === 'string' &&
      ADDRESS.test(s.withdrawalLimitSubject),
    'subject',
  )
  return s as Usd3JointNativeHistorySubject
}
function decodeTrace(
  input: unknown,
  expected: { key: string; method: string; params: unknown[] },
  id: number,
  source: Usd3JointHistorySource | null,
  dictionary: Record<string, unknown>,
  start: string,
  acquired: string,
) {
  const t = exact(input, ['key', 'request', 'response', 'startedAtUtc', 'completedAtUtc'])
  check(
    t.key === expected.key &&
      same(t.request, { jsonrpc: '2.0', id, method: expected.method, params: expected.params }),
    'native_request',
  )
  check(
    utc(t.startedAtUtc) &&
      utc(t.completedAtUtc) &&
      Date.parse(t.startedAtUtc) >= Date.parse(start) &&
      Date.parse(t.completedAtUtc) >= Date.parse(t.startedAtUtc) &&
      Date.parse(t.completedAtUtc) <= Date.parse(acquired) &&
      Date.parse(t.completedAtUtc) - Date.parse(t.startedAtUtc) <= 8000,
    'trace_clock',
  )
  const r = obj(t.response)
  check(r.jsonrpc === '2.0' && r.id === id, 'response_id')
  if (Object.hasOwn(r, 'error')) {
    exact(r, ['jsonrpc', 'id', 'error'])
    const e = exact(r.error, ['code', 'message'])
    check(
      t.key === 'withdrawal_limit' &&
        Number.isSafeInteger(e.code) &&
        e.message === 'native_withdrawal_limit_unavailable',
      'getter_error',
    )
    return { censored: true, errorCode: e.code }
  }
  exact(r, ['jsonrpc', 'id', 'result'])
  if (t.key === 'chain_id') {
    check(r.result === '0x1', 'chain_id')
    return '0x1'
  }
  check(source, 'source')
  if (expected.key.startsWith('header')) {
    check(
      same(r.result, {
        number: '0x' + source.blockNumber.toString(16),
        hash: source.blockHash,
        timestamp: '0x' + (Date.parse(source.blockTime) / 1000).toString(16),
      }),
      'header',
    )
    return r.result
  }
  if (expected.method === 'eth_getCode') {
    check(
      same(r.result, { codeRef: expected.key }) && typeof dictionary[expected.key] === 'string',
      'code_reference',
    )
    return dictionary[expected.key]
  }
  check(typeof r.result === 'string' && WORD.test(r.result), 'canonical_word')
  if (expected.key === 'implementation_slot') {
    check(
      r.result === '0x' + '0'.repeat(24) + profile.runtimePins[1].address.slice(2),
      'implementation_slot',
    )
    return profile.runtimePins[1].address
  }
  if (expected.key === 'delegate' || expected.key === 'asset') {
    const address =
      expected.key === 'delegate' ? profile.runtimePins[2].address : profile.subject.asset
    check(r.result === '0x' + '0'.repeat(24) + address.slice(2), 'address_pin')
    return address
  }
  const n = BigInt(r.result)
  if (expected.key === 'shutdown') {
    check(n === 0n || n === 1n, 'bool')
    return n === 1n
  }
  if (expected.key.endsWith('decimals')) check(n === 6n, 'decimals')
  return n.toString()
}
/** Structural replay only: unsigned transport cannot prove who performed these reads. */
export function decodeUsd3JointNativeHistoryEvidence(
  input: unknown,
): Usd3JointDecodedNativeHistoryEvidence {
  const v = exact(
    snapshot(
      typeof input === 'string' ? parseUsd3JointNativeEvidenceJson(input) : input,
      USD3_JOINT_NATIVE_EVIDENCE_LIMITS.transportBytes,
    ),
    [
      'schemaVersion',
      'kind',
      'profileId',
      'subject',
      'anchors',
      'startedAtUtc',
      'acquiredAtUtc',
      'provenance',
      'owner',
      'historicalOwnership',
      'ownerCommitmentQualification',
      'authenticated',
      'originalAuthority',
      'codeDictionary',
      'origins',
    ],
  )
  check(
    v.schemaVersion === 1 &&
      v.kind === 'usd3_joint_native_history_evidence_v1' &&
      v.profileId === profile.id &&
      v.owner === null &&
      v.historicalOwnership === false &&
      v.ownerCommitmentQualification === false &&
      v.authenticated === false &&
      v.originalAuthority === false,
    'claims',
  )
  const subject = checkedSubject(v.subject),
    provenance = exact(v.provenance, ['originalBodySha256', 'originalPlanSha256'])
  check(
    digest(provenance.originalBodySha256) && digest(provenance.originalPlanSha256),
    'provenance',
  )
  check(same(v.anchors, profile.anchors), 'anchors')
  check(
    utc(v.startedAtUtc) &&
      utc(v.acquiredAtUtc) &&
      Date.parse(v.startedAtUtc) >= Date.parse(profile.anchors[3].source.blockTime) &&
      Date.parse(v.acquiredAtUtc) >= Date.parse(v.startedAtUtc) &&
      Date.parse(v.acquiredAtUtc) - Date.parse(v.startedAtUtc) <= 120000,
    'capture_clock',
  )
  const dictionary = exact(
    v.codeDictionary,
    profile.runtimePins.map((p) => p.key),
  )
  for (const pin of profile.runtimePins) {
    const code = dictionary[pin.key]
    check(
      typeof code === 'string' &&
        /^0x(?:[0-9a-f]{2})+$/.test(code) &&
        (code.length - 2) / 2 <= USD3_JOINT_NATIVE_EVIDENCE_LIMITS.runtimeBytes &&
        keccak256(code as `0x${string}`) === pin.runtimeKeccak256,
      'runtime_pin',
    )
  }
  let maximumCompletedAt = 0
  const byOrigin = arr(v.origins, 2).map((value, j) => {
    const o = exact(value, ['host', 'chain', 'anchors'])
    check(o.host === profile.originHosts[j], 'origin_host')
    decodeTrace(
      o.chain,
      { key: 'chain_id', method: 'eth_chainId', params: [] },
      1,
      null,
      dictionary,
      v.startedAtUtc as string,
      v.acquiredAtUtc as string,
    )
    let previousCompleted = String(obj(o.chain).completedAtUtc)
    maximumCompletedAt = Math.max(maximumCompletedAt, Date.parse(previousCompleted))
    return arr(o.anchors, 4).map((a, n) => {
      const traces = arr(a, 17),
        d: Record<string, unknown> = {},
        expected = specs(subject, profile.anchors[n].source)
      const stageStart = String(obj(traces[0]).startedAtUtc)
      for (const [k, spec] of expected.entries()) {
        const t = obj(traces[k])
        check(
          utc(t.startedAtUtc) && Date.parse(t.startedAtUtc) >= Date.parse(previousCompleted),
          'origin_chronology',
        )
        d[spec.key] = decodeTrace(
          t,
          spec,
          k + 2,
          profile.anchors[n].source,
          dictionary,
          v.startedAtUtc as string,
          v.acquiredAtUtc as string,
        )
        previousCompleted = String(t.completedAtUtc)
        maximumCompletedAt = Math.max(maximumCompletedAt, Date.parse(previousCompleted))
        check(Date.parse(previousCompleted) - Date.parse(stageStart) <= 12000, 'origin_window')
      }
      return d
    })
  })
  check(
    Date.parse(v.acquiredAtUtc as string) - maximumCompletedAt <= 250,
    'terminal_acquisition_clock',
  )
  const points = profile.anchors.map((a, n): Usd3JointNativeHistoryPoint => {
    const d = byOrigin[0][n]
    check(same(d, byOrigin[1][n]), 'origin_consensus')
    const censored = typeof d.withdrawal_limit === 'object'
    return {
      source: { ...a.source },
      acquiredAtUtc: v.acquiredAtUtc as string,
      hypotheticalSharesRaw: subject.sharesRaw,
      shareDecimals: 6,
      asset: subject.asset,
      assetDecimals: 6,
      nativeEaRaw: d.native_ea as string,
      availableWithdrawLimitRaw: censored ? null : (d.withdrawal_limit as string),
      nativeQuoteStatus: censored
        ? 'censored_native_withdrawal_limit_unavailable'
        : 'conditional_reference_address_quote',
      withdrawalLimitSubject: subject.withdrawalLimitSubject,
      conditionalReferenceAddressQuote: true,
      ownerCommitmentQualification: false,
      shutdown: d.shutdown as boolean,
      navRaw: d.nav as string,
      totalAssetsRaw: d.total_assets as string,
      idleUsdcDiagnosticRaw: d.idle_usdc_diagnostic as string,
      idleUsdcIsTotalFundingUpperBound: false,
      sourceClass: 'captured_identical_runtimes_only',
      runtimeIdentities: profile.runtimePins.map((p) => ({
        address: p.address,
        runtimeKeccak256: keccak256(dictionary[p.key] as `0x${string}`),
      })),
      sourceImplementationEquivalence: false,
    }
  })
  return freeze({
    profileId: profile.id,
    provenance: provenance as Usd3JointDecodedNativeHistoryEvidence['provenance'],
    subject,
    startedAtUtc: v.startedAtUtc as string,
    acquiredAtUtc: v.acquiredAtUtc as string,
    availableAtUtc: v.acquiredAtUtc as string,
    points,
    owner: null,
    historicalOwnership: false,
    ownerCommitmentQualification: false,
    authenticated: false,
    originalAuthority: false,
    authoritativeNativeCapture: false,
  })
}

/** Public serialization only. A valid self-seal is provenance, never original authority. */
export function encodeUsd3JointNativeHistoryEvidence(
  capture: unknown,
): Usd3JointNativeHistoryEvidenceTransport {
  const v = obj(snapshot(capture, USD3_JOINT_NATIVE_EVIDENCE_LIMITS.privateCaptureBytes)),
    plan = obj(v.plan)
  check(
    v.schema === 'usd3_hypothetical_history_capture_v1' &&
      digest(v.sha256) &&
      digest(v.planSha256) &&
      v.planSha256 === hash(JSON.stringify(plan)),
    'capture_schema',
  )
  const { sha256: _seal, ...body } = v
  check(v.sha256 === hash(JSON.stringify(body)), 'capture_self_seal')
  check(
    v.physicalStarts === 138 &&
      v.pendingSettlements === 0 &&
      v.failure === null &&
      plan.owner === null &&
      plan.historicalOwnership === false &&
      plan.ownerCommitmentQualification === false,
    'capture_lifecycle',
  )
  const ps = obj(plan.subject),
    subject = checkedSubject({ ...ps, withdrawalLimitSubject: plan.withdrawalLimitSubject })
  check(
    same(
      arr(plan.anchors, 4).map((a) => {
        const p = obj(a)
        return { cashIndex: p.cashIndex, source: p.source }
      }),
      profile.anchors,
    ),
    'capture_anchors',
  )
  const ledger = new Map<number, Record<string, unknown>>(),
    terminal = new Map<number, string>()
  for (const item of arr(v.terminalCommitments, 138)) {
    const t = exact(item, ['physicalId', 'rowSha256'])
    check(
      Number.isSafeInteger(t.physicalId) &&
        digest(t.rowSha256) &&
        !terminal.has(t.physicalId as number),
      'terminal',
    )
    terminal.set(t.physicalId as number, t.rowSha256 as string)
  }
  for (const item of arr(v.ledger, 138)) {
    const r = obj(item)
    check(
      Number.isSafeInteger(r.physicalId) &&
        (r.physicalId as number) >= 1 &&
        (r.physicalId as number) <= 138 &&
        !ledger.has(r.physicalId as number) &&
        r.status === 'success' &&
        r.accepted === true &&
        r.httpStatus === 200 &&
        r.safeCode === null &&
        terminal.get(r.physicalId as number) === hash(JSON.stringify(r)),
      'physical_row',
    )
    ledger.set(r.physicalId as number, r)
  }
  const dictionary: Record<string, string> = {},
    used = new Set<number>()
  const trace = (input: unknown, host: string, stage: string): Usd3JointNativeTrace => {
    const t = exact(input, ['physicalId', 'key']),
      r = ledger.get(t.physicalId as number)
    check(
      r &&
        !used.has(t.physicalId as number) &&
        r.host === host &&
        r.stage === stage &&
        typeof t.key === 'string',
      'physical_join',
    )
    used.add(t.physicalId as number)
    check(
      typeof r.rawBodyBase64 === 'string' &&
        r.rawBodyBase64.length <= 4 * Math.ceil(65536 / 3) &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(r.rawBodyBase64),
      'base64',
    )
    const binary = globalThis.atob(r.rawBodyBase64)
    check(globalThis.btoa(binary) === r.rawBodyBase64, 'canonical_base64')
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    check(
      bytes.length <= 65536 &&
        r.bodyBytes === bytes.length &&
        r.bodySha256 === sha256(bytesToHex(bytes)).slice(2),
      'raw_response_digest',
    )
    const response = obj(
        parseUsd3JointNativeEvidenceJson(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          65536,
        ),
      ),
      request = exact(r.request, ['jsonrpc', 'id', 'method', 'params'])
    check(response.jsonrpc === '2.0' && response.id === request.id, 'raw_response_id')
    let normalized: Usd3JointNativeResponse
    if (Object.hasOwn(response, 'error')) {
      exact(response, ['jsonrpc', 'id', 'error'])
      const e = obj(response.error)
      check(
        t.key === 'withdrawal_limit' &&
          Number.isSafeInteger(e.code) &&
          typeof e.message === 'string',
        'raw_getter_error',
      )
      normalized = {
        jsonrpc: '2.0',
        id: response.id as number,
        error: { code: e.code as number, message: 'native_withdrawal_limit_unavailable' },
      }
    } else {
      exact(response, ['jsonrpc', 'id', 'result'])
      let result = response.result
      if (profile.runtimePins.some((p) => p.key === t.key)) {
        check(
          typeof result === 'string' && (!dictionary[t.key] || dictionary[t.key] === result),
          'code_consensus',
        )
        dictionary[t.key] = result
        result = { codeRef: t.key }
      }
      if (t.key.startsWith('header')) {
        const h = obj(result)
        result = { number: h.number, hash: h.hash, timestamp: h.timestamp }
      }
      normalized = { jsonrpc: '2.0', id: response.id as number, result }
    }
    return {
      key: t.key,
      request: request as Usd3JointNativeRequest,
      response: normalized,
      startedAtUtc: r.startedAtUtc as string,
      completedAtUtc: r.completedAtUtc as string,
    }
  }
  const origins = arr(v.origins, 2).map((item, j) => {
    const o = exact(item, ['host', 'chain', 'anchors'])
    check(o.host === profile.originHosts[j], 'capture_origin')
    return {
      host: o.host as string,
      chain: trace(o.chain, o.host as string, 'chain'),
      anchors: arr(o.anchors, 4).map((a, n) =>
        arr(a, 17).map((t) => trace(t, o.host as string, 'anchor_' + n)),
      ),
    }
  })
  check(used.size === 138, 'unjoined_ledger')
  const transport: Usd3JointNativeHistoryEvidenceTransport = {
    schemaVersion: 1,
    kind: 'usd3_joint_native_history_evidence_v1',
    profileId: profile.id,
    subject,
    anchors: profile.anchors.map((a) => ({ cashIndex: a.cashIndex, source: { ...a.source } })),
    startedAtUtc: v.startedAtUtc as string,
    acquiredAtUtc: v.availableAtUtc as string,
    provenance: {
      originalBodySha256: v.sha256 as string,
      originalPlanSha256: v.planSha256 as string,
    },
    owner: null,
    historicalOwnership: false,
    ownerCommitmentQualification: false,
    authenticated: false,
    originalAuthority: false,
    codeDictionary: dictionary,
    origins,
  }
  decodeUsd3JointNativeHistoryEvidence(transport)
  return freeze(transport)
}
