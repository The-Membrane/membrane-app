import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  sha256,
  stringToHex,
} from 'viem'
import { FLUID_USDC_BRIDGE_NATIVE_ABI } from './fluidUsdcBridgeNativeAbi'
import type { FluidBridgeUsdcFrame } from './fluidBridgeUsdcJointHistoricalProcess'
import { resolveFluidUsdcBridgeJointTrustedProfile } from './fluidUsdcBridgeJointTrustedProfile'

// Six dictionary entries retain native bytecodes once. Twelve dates with two
// 26-request origins fit the 1 MiB transport cap; raw collector receipts are 8 MiB.
export const FLUID_USDC_BRIDGE_NATIVE_EVIDENCE_LIMITS = Object.freeze({
  transportBytes: 1024 * 1024,
  captureBytes: 8 * 1024 * 1024,
  responseBytes: 65536,
  captures: 3,
  anchorsPerCapture: 4,
  tracesPerOrigin: 26,
})
const BRIDGE = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const IMPL = '0xe16ccc91a8134d428e7b6240177f9e2b227b9743'
const FUSDC = '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const BANK = '0x52aa899454998be5b000ad077a46bbe360f4e497'
const RESOLVER = '0xca13a15de31235a37134b4717021c35a3cf25c60'
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ROUTE = 'USDC → FluidBridgeAggregatorProxy [USDC]'
const ABI = [
  ...FLUID_USDC_BRIDGE_NATIVE_ABI,
  ...parseAbi(['function getIdleBalance() view returns (uint256)']),
] as const
type Header = { number: string; hash: string; timestamp: string }
type Request = { jsonrpc: '2.0'; id: number; method: string; params: unknown[] }
type Response = { jsonrpc: '2.0'; id: number; result: string | Header | { codeRef: string } }
export type FluidUsdcBridgeJointNativeTrace = {
  stage: 'protocol' | 'wrapper'
  key: string
  physicalId: number
  startedAtUtc: string
  completedAtUtc: string
  bodySha256: string
  request: Request
  response: Response
}
export type FluidUsdcBridgeJointNativeHistoryEvidenceTransport = {
  schema: 'fluid_usdc_bridge_joint_native_history_evidence_v1'
  profileId: string
  subject: {
    routeKey: string
    destination: string
    asset: string
    assetDecimals: 6
    shareDecimals: 18
    sharesRaw: string
  }
  codes: Record<string, string>
  captures: {
    originalBodySha256: string
    planSha256: string
    startedAtUtc: string
    acquiredAtUtc: string
    anchors: {
      cashIndex: number
      source: {
        chainId: 1
        blockNumber: number
        blockHash: string
        blockTime: string
        finalized: true
      }
      origins: { host: string; traces: FluidUsdcBridgeJointNativeTrace[] }[]
    }[]
  }[]
  owner: null
  historicalOwnership: false
  originalAuthority: false
  authenticated: false
}
export type FluidUsdcBridgeJointDecodedNativeHistoryEvidence = {
  profileId: string
  acquiredAtUtc: string
  frames: FluidBridgeUsdcFrame[]
  originalAuthority: false
  authenticated: false
}
type Obj = Record<string, unknown>
function check(ok: unknown): asserts ok {
  if (!ok) throw Error('fluid_bridge_native_evidence_invalid')
}
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: string[]): v is Obj =>
  obj(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const hex = (v: unknown): v is `0x${string}` =>
  typeof v === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(v)
const qty = (v: unknown): v is string =>
  typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v) && BigInt(v) < 1n << 256n
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    )
  return (
    obj(a) &&
    obj(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  )
}
function snapshot(input: unknown, cap: number): unknown {
  let nodes = 0,
    bytes = 0
  const seen = new WeakSet<object>()
  const copy = (v: unknown, depth: number): unknown => {
    check(++nodes <= 100000 && depth <= 32)
    if (typeof v === 'string') {
      bytes += new TextEncoder().encode(v).length
      check(bytes <= cap)
      return v
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v
    check(
      v &&
        typeof v === 'object' &&
        !seen.has(v) &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),
    )
    seen.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    check(Object.values(ds).every((d) => Object.hasOwn(d, 'value')))
    let out: unknown
    if (Array.isArray(v)) {
      check(v.length <= 2000 && Object.keys(ds).length === v.length + 1)
      out = Array.from({ length: v.length }, (_, n) => {
        check(ds[n]?.enumerable)
        return copy(ds[n].value, depth + 1)
      })
    } else {
      const r: Obj = {}
      for (const [k, d] of Object.entries(ds)) {
        check(d.enumerable && !['__proto__', 'constructor', 'prototype'].includes(k))
        bytes += k.length
        check(bytes <= cap)
        r[k] = copy(d.value, depth + 1)
      }
      out = r
    }
    seen.delete(v)
    return out
  }
  return copy(input, 0)
}
/** Duplicate keys are rejected before ordinary JSON parsing. */
export function parseFluidUsdcBridgeJointNativeEvidenceJson(
  text: string,
  cap = 1024 * 1024,
): unknown {
  check(typeof text === 'string' && new TextEncoder().encode(text).length <= cap)
  let i = 0
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  const str = (): string => {
    const start = i++
    check(text[start] === '"')
    while (i < text.length) {
      const c = text[i++]
      if (c === '\\') {
        i++
        continue
      }
      if (c === '"') return JSON.parse(text.slice(start, i)) as string
    }
    throw Error('fluid_bridge_json_string')
  }
  const visit = (d: number): void => {
    check(d <= 32)
    ws()
    if (text[i] === '"') {
      str()
      return
    }
    if (text[i] === '{') {
      i++
      ws()
      const used = new Set<string>()
      if (text[i] === '}') {
        i++
        return
      }
      while (true) {
        ws()
        const k = str()
        check(!used.has(k))
        used.add(k)
        ws()
        check(text[i++] === ':')
        visit(d + 1)
        ws()
        const c = text[i++]
        if (c === '}') return
        check(c === ',')
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
        visit(d + 1)
        ws()
        const c = text[i++]
        if (c === ']') return
        check(c === ',')
      }
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    check(m)
    i += m[0].length
  }
  visit(0)
  ws()
  check(i === text.length)
  return JSON.parse(text) as unknown
}
const bodyHash = (text: string) => sha256(stringToHex(text)).slice(2)
const freeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
type Spec = {
  stage: 'protocol' | 'wrapper'
  key: string
  method: string
  params: unknown[]
  name?: string
}
function specs(
  source: FluidUsdcBridgeJointNativeHistoryEvidenceTransport['captures'][number]['anchors'][number]['source'],
  sharesRaw: string,
): Spec[] {
  const pin = { blockHash: source.blockHash, requireCanonical: true },
    head = ['0x' + source.blockNumber.toString(16), false]
  const header = (stage: 'protocol' | 'wrapper', key: string): Spec => ({
    stage,
    key,
    method: 'eth_getBlockByNumber',
    params: head,
  })
  const code = (stage: 'protocol' | 'wrapper', key: string, address: string): Spec => ({
    stage,
    key,
    method: 'eth_getCode',
    params: [address, pin],
  })
  const call = (
    stage: 'protocol' | 'wrapper',
    key: string,
    address: string,
    name: string,
    args: unknown[] = [],
  ): Spec => ({
    stage,
    key,
    method: 'eth_call',
    params: [
      {
        to: address,
        data: encodeFunctionData({ abi: ABI, functionName: name as never, args: args as never }),
      },
      pin,
    ],
    name,
  })
  return [
    { stage: 'protocol', key: 'chain', method: 'eth_chainId', params: [] },
    {
      stage: 'protocol',
      key: 'finalized',
      method: 'eth_getBlockByNumber',
      params: ['finalized', false],
    },
    header('protocol', 'header_before'),
    ...[FUSDC, USDC, BANK, RESOLVER].map((a) => code('protocol', 'code:' + a, a)),
    call('protocol', 'asset', FUSDC, 'asset'),
    call('protocol', 'decimals', USDC, 'decimals'),
    call('protocol', 'getData', FUSDC, 'getData'),
    call('protocol', 'resolver_liquidity', RESOLVER, 'LIQUIDITY'),
    call('protocol', 'supplyData', RESOLVER, 'getUserSupplyData', [FUSDC, USDC]),
    call('protocol', 'cash', USDC, 'balanceOf', [BANK]),
    header('protocol', 'header_after'),
    header('wrapper', 'header_before'),
    code('wrapper', 'bridge_code', BRIDGE),
    {
      stage: 'wrapper',
      key: 'implementation_slot',
      method: 'eth_getStorageAt',
      params: [BRIDGE, SLOT, pin],
    },
    code('wrapper', 'implementation_code', IMPL),
    call('wrapper', 'get_fusdc', BRIDGE, 'getFUSDC'),
    code('wrapper', 'fusdc_code', FUSDC),
    call('wrapper', 'fee', BRIDGE, 'getWithdrawalFeeBPS'),
    call('wrapper', 'pause', BRIDGE, 'isWithdrawalsPaused'),
    call('wrapper', 'idle_fusdc_claim', BRIDGE, 'getIdleBalance'),
    call('wrapper', 'full_net_ea', BRIDGE, 'previewRedeem', [BigInt(sharesRaw)]),
    call('wrapper', 'bridge_funding', FUSDC, 'maxWithdraw', [BRIDGE]),
    header('wrapper', 'header_after'),
  ]
}
function nativeHeader(v: unknown): Header {
  check(
    exact(v, ['number', 'hash', 'timestamp']) && qty(v.number) && hash(v.hash) && qty(v.timestamp),
  )
  check(
    BigInt(v.number) > 0n &&
      BigInt(v.number) <= BigInt(Number.MAX_SAFE_INTEGER) &&
      BigInt(v.timestamp) <= BigInt(Number.MAX_SAFE_INTEGER),
  )
  return v as Header
}
/** Public structural reconstruction. A transport can never register original authority. */
export function decodeFluidUsdcBridgeJointNativeHistoryEvidence(
  input: unknown,
): FluidUsdcBridgeJointDecodedNativeHistoryEvidence | null {
  try {
    const v = snapshot(
      typeof input === 'string' ? parseFluidUsdcBridgeJointNativeEvidenceJson(input) : input,
      1024 * 1024,
    )
    check(
      exact(v, [
        'schema',
        'profileId',
        'subject',
        'codes',
        'captures',
        'owner',
        'historicalOwnership',
        'originalAuthority',
        'authenticated',
      ]),
    )
    check(
      v.schema === 'fluid_usdc_bridge_joint_native_history_evidence_v1' &&
        v.owner === null &&
        v.historicalOwnership === false &&
        v.originalAuthority === false &&
        v.authenticated === false,
    )
    check(
      exact(v.subject, [
        'routeKey',
        'destination',
        'asset',
        'assetDecimals',
        'shareDecimals',
        'sharesRaw',
      ]),
    )
    const subject = v.subject
    const profile = resolveFluidUsdcBridgeJointTrustedProfile(
      subject.routeKey,
      subject.destination,
      subject.asset,
    )
    check(
      profile &&
        v.profileId === profile.profileId &&
        subject.assetDecimals === 6 &&
        subject.shareDecimals === 18 &&
        raw(subject.sharesRaw) &&
        subject.sharesRaw !== '0',
    )
    check(
      obj(v.codes) &&
        equal(Object.keys(v.codes).sort(), Object.keys(profile.runtimeCodeHashes).sort()),
    )
    for (const [address, code] of Object.entries(v.codes))
      check(
        hex(code) &&
          code !== '0x' &&
          code.length <= 131074 &&
          keccak256(code) === profile.runtimeCodeHashes[address],
      )
    check(Array.isArray(v.captures) && v.captures.length >= 1 && v.captures.length <= 3)
    const frames: FluidBridgeUsdcFrame[] = []
    let lastIndex = -1,
      lastBlock = 0,
      lastTime = 0,
      acquiredMs = 0,
      priorCaptureEnd = 0
    for (const capture of v.captures) {
      check(
        exact(capture, [
          'originalBodySha256',
          'planSha256',
          'startedAtUtc',
          'acquiredAtUtc',
          'anchors',
        ]) &&
          digest(capture.originalBodySha256) &&
          digest(capture.planSha256) &&
          utc(capture.startedAtUtc) &&
          utc(capture.acquiredAtUtc),
      )
      const startMs = Date.parse(capture.startedAtUtc),
        endMs = Date.parse(capture.acquiredAtUtc)
      check(
        startMs >= priorCaptureEnd &&
          endMs >= startMs &&
          endMs - startMs <= 120000 &&
          Array.isArray(capture.anchors) &&
          capture.anchors.length === 4,
      )
      acquiredMs = Math.max(acquiredMs, endMs)
      priorCaptureEnd = endMs
      const ids = new Set<number>(),
        physical: { host: string; start: number; end: number }[] = []
      for (const [index, anchor] of capture.anchors.entries()) {
        check(
          exact(anchor, ['cashIndex', 'source', 'origins']) &&
            Number.isSafeInteger(anchor.cashIndex),
        )
        const pin = profile.anchors.find((a) => a.cashIndex === anchor.cashIndex)
        check(
          pin &&
            equal(pin.source, anchor.source) &&
            pin.cashIndex > lastIndex &&
            (index === 0 || pin.cashIndex === lastIndex + 1),
        )
        const source = pin.source
        check(
          source.blockNumber > lastBlock &&
            Date.parse(source.blockTime) > lastTime &&
            Date.parse(source.blockTime) <= startMs,
        )
        lastIndex = pin.cashIndex
        lastBlock = source.blockNumber
        lastTime = Date.parse(source.blockTime)
        check(Array.isArray(anchor.origins) && anchor.origins.length === 2)
        const decoded = anchor.origins.map((origin, originIndex) => {
          check(
            exact(origin, ['host', 'traces']) &&
              origin.host === profile.originHosts[originIndex] &&
              Array.isArray(origin.traces) &&
              origin.traces.length === 26,
          )
          const expected = specs(source, subject.sharesRaw as string),
            facts: Record<string, unknown> = {}
          let priorEnd = startMs
          const stageStarts = new Map<string, number>()
          for (const [n, t] of origin.traces.entries()) {
            const s = expected[n]
            check(
              exact(t, [
                'stage',
                'key',
                'physicalId',
                'startedAtUtc',
                'completedAtUtc',
                'bodySha256',
                'request',
                'response',
              ]) &&
                t.stage === s.stage &&
                t.key === s.key &&
                Number.isSafeInteger(t.physicalId) &&
                (t.physicalId as number) > 0 &&
                (t.physicalId as number) <= 208 &&
                !ids.has(t.physicalId as number) &&
                utc(t.startedAtUtc) &&
                utc(t.completedAtUtc) &&
                digest(t.bodySha256),
            )
            ids.add(t.physicalId as number)
            const ts = Date.parse(t.startedAtUtc),
              te = Date.parse(t.completedAtUtc)
            if (!stageStarts.has(s.stage)) stageStarts.set(s.stage, ts)
            check(
              ts >= priorEnd &&
                te >= ts &&
                te - ts <= 8000 &&
                te <= endMs &&
                te - stageStarts.get(s.stage)! <= 12000,
            )
            priorEnd = te
            physical.push({ host: origin.host as string, start: ts, end: te })
            check(
              exact(t.request, ['jsonrpc', 'id', 'method', 'params']) &&
                t.request.jsonrpc === '2.0' &&
                Number.isSafeInteger(t.request.id) &&
                (t.request.id as number) > 0 &&
                t.request.method === s.method &&
                equal(t.request.params, s.params),
            )
            check(
              exact(t.response, ['jsonrpc', 'id', 'result']) &&
                t.response.jsonrpc === '2.0' &&
                t.response.id === t.request.id,
            )
            const result = t.response.result,
              k = s.stage + ':' + s.key
            if (s.key === 'chain') {
              check(result === '0x1')
              facts[k] = result
            } else if (s.method === 'eth_getBlockByNumber') {
              const h = nativeHeader(result)
              if (s.key === 'finalized') {
                check(BigInt(h.number) >= BigInt(source.blockNumber))
                if (BigInt(h.number) === BigInt(source.blockNumber))
                  check(
                    equal(h, {
                      number: '0x' + source.blockNumber.toString(16),
                      hash: source.blockHash,
                      timestamp: '0x' + (Date.parse(source.blockTime) / 1000).toString(16),
                    }),
                  )
              } else
                check(
                  equal(h, {
                    number: '0x' + source.blockNumber.toString(16),
                    hash: source.blockHash,
                    timestamp: '0x' + (Date.parse(source.blockTime) / 1000).toString(16),
                  }),
                )
              // Finalized head may advance between independently acquired origins.
              if (s.key !== 'finalized') facts[k] = h
            } else if (s.method === 'eth_getCode') {
              check(
                exact(result, ['codeRef']) &&
                  result.codeRef === s.params[0] &&
                  Object.hasOwn(v.codes as Obj, result.codeRef as string),
              )
              facts[k] = profile.runtimeCodeHashes[result.codeRef as string]
            } else if (s.method === 'eth_getStorageAt') {
              check(result === '0x' + '0'.repeat(24) + IMPL.slice(2))
              facts[k] = result
            } else {
              check(hex(result))
              const d: unknown = decodeFunctionResult({
                abi: ABI,
                functionName: s.name as never,
                data: result,
              })
              check(
                encodeFunctionResult({
                  abi: ABI,
                  functionName: s.name as never,
                  result: d as never,
                }).toLowerCase() === result,
              )
              facts[k] = d
            }
          }
          check(
            typeof facts['protocol:asset'] === 'string' &&
              (facts['protocol:asset'] as string).toLowerCase() === USDC &&
              facts['protocol:decimals'] === 6 &&
              typeof facts['protocol:resolver_liquidity'] === 'string' &&
              (facts['protocol:resolver_liquidity'] as string).toLowerCase() === BANK &&
              typeof facts['wrapper:get_fusdc'] === 'string' &&
              (facts['wrapper:get_fusdc'] as string).toLowerCase() === FUSDC &&
              facts['wrapper:fee'] === 5n &&
              facts['wrapper:pause'] === false,
          )
          return facts
        })
        // BigInts are compared recursively without JSON serialization.
        check(equal(decoded[0], decoded[1]))
        const f = decoded[0],
          data = f['protocol:getData'],
          supply = f['protocol:supplyData']
        check(
          Array.isArray(data) &&
            data.length === 9 &&
            typeof data[0] === 'string' &&
            data[0].toLowerCase() === BANK &&
            Array.isArray(supply) &&
            supply.length === 2 &&
            obj(supply[0]),
        )
        const r = (x: unknown): string => {
          check(typeof x === 'bigint' && x >= 0n && x < 1n << 256n)
          return x.toString()
        }
        frames.push({
          source: {
            chainId: 1,
            blockNumber: String(source.blockNumber),
            blockHash: source.blockHash,
            blockTime: source.blockTime,
          },
          availableAtUtc: capture.acquiredAtUtc as string,
          acquiredAtUtc: capture.acquiredAtUtc as string,
          provenanceRef:
            'unsigned_native_capture:' + capture.originalBodySha256 + ':' + pin.cashIndex,
          holderSharesRaw: subject.sharesRaw as string,
          shareDecimals: 18,
          asset: USDC,
          assetDecimals: 6,
          fundingUnit: 'gross_native_USDC',
          entitlementUnit: 'net_native_USDC',
          runtimeCodeHashes: { ...profile.runtimeCodeHashes },
          regime: profile.profileId,
          paused: false,
          withdrawalFeeBps: 5,
          fullHolderNetUsdcRaw: r(f['wrapper:full_net_ea']),
          nativeProngs: {
            bridgeFunding: r(f['wrapper:bridge_funding']),
            bankCash: r(f['protocol:cash']),
            bankSupply: r(data[6]),
            bankWithdrawableUntilLimit: r(supply[0].withdrawableUntilLimit),
            bankResolverWithdrawable: r(supply[0].withdrawable),
          },
          provenanceKind: 'native_hypothetical_shares',
          owner: null,
          historicalOwnership: false,
        })
      }
      check(ids.size === 208)
      for (const host of profile.originHosts) {
        const rows = physical.filter((t) => t.host === host).sort((a, b) => a.start - b.start)
        check(rows.length === 104 && rows.every((t, i) => i === 0 || t.start >= rows[i - 1].end))
        // UTC clock granularity is one millisecond; physical monotonic pacing is
        // authenticated by the protected collector, not asserted by this codec.
      }
    }
    check(frames.length <= 12 && new TextEncoder().encode(JSON.stringify(v)).length <= 1024 * 1024)
    return freeze({
      profileId: profile.profileId,
      acquiredAtUtc: new Date(acquiredMs).toISOString(),
      frames,
      originalAuthority: false,
      authenticated: false,
    })
  } catch {
    return null
  }
}
/** Serialization only. Private server original replay must happen before calling. */
export function encodeFluidUsdcBridgeJointNativeHistoryEvidence(
  input: unknown,
): FluidUsdcBridgeJointNativeHistoryEvidenceTransport {
  const copied = snapshot(input, 24 * 1024 * 1024)
  const captures = Array.isArray(copied) ? copied : [copied]
  check(captures.length >= 1 && captures.length <= 3)
  for (const capture of captures)
    check(new TextEncoder().encode(JSON.stringify(capture)).length <= 8 * 1024 * 1024)
  const codes: Record<string, string> = {}
  let subject: FluidUsdcBridgeJointNativeHistoryEvidenceTransport['subject'] | null = null
  const profile = resolveFluidUsdcBridgeJointTrustedProfile(ROUTE, BRIDGE, USDC)!
  const projected = captures.map((c) => {
    check(
      obj(c) &&
        c.schema === 'fluid_bridge_usdc_hypothetical_history_capture_v1' &&
        obj(c.plan) &&
        obj(c.plan.subject) &&
        Array.isArray(c.ledger) &&
        c.ledger.length === 208 &&
        c.physicalStarts === 208 &&
        c.pendingSettlements === 0 &&
        c.failure === null &&
        Array.isArray(c.plan.anchors) &&
        c.plan.anchors.length === 4 &&
        Array.isArray(c.protocolCaptures) &&
        Array.isArray(c.wrapperOrigins),
    )
    const { sha256: seal, ...body } = c
    check(
      digest(seal) &&
        bodyHash(JSON.stringify(body)) === seal &&
        c.planSha256 === bodyHash(JSON.stringify(c.plan)) &&
        c.owner === null &&
        c.historicalOwnership === false,
    )
    const s = c.plan.subject
    const next = {
      routeKey: s.routeKey,
      destination: s.destination,
      asset: s.asset,
      assetDecimals: s.assetDecimals,
      shareDecimals: s.shareDecimals,
      sharesRaw: s.sharesRaw,
    }
    if (subject) check(equal(subject, next))
    else subject = next as FluidUsdcBridgeJointNativeHistoryEvidenceTransport['subject']
    const used = new Set<number>()
    const anchors = c.plan.anchors.map((a, n) => {
      check(obj(a) && obj(a.source))
      const protocol = (c.protocolCaptures as unknown[])[n]
      check(obj(protocol) && Array.isArray(protocol.traces))
      const origins = profile.originHosts.map((host, j) => {
        const wrapper = (c.wrapperOrigins as unknown[])[j]
        check(
          obj(wrapper) &&
            wrapper.host === host &&
            Array.isArray(wrapper.anchors) &&
            Array.isArray(wrapper.anchors[n]),
        )
        const native: Obj[] = [
          ...protocol.traces
            .filter((t) => obj(t) && t.host === host)
            .map((t) => ({ ...(t as Obj), stage: 'protocol', key: (t as Obj).phase })),
          ...(wrapper.anchors[n] as Obj[]).map((t) => ({ ...t, stage: 'wrapper' })),
        ]
        check(native.length === 26)
        const traces = native.map((t) => {
          const rows = (c.ledger as Obj[]).filter(
            (r) => r.host === host && r.stage === t.stage + '_' + n && equal(r.request, t.request),
          )
          check(rows.length === 1)
          const row = rows[0]
          check(
            Number.isSafeInteger(row.physicalId) &&
              !used.has(row.physicalId as number) &&
              row.status === 'success' &&
              row.httpStatus === 200 &&
              row.accepted === true &&
              row.safeCode === null &&
              typeof row.rawBodyBase64 === 'string' &&
              typeof row.bodyBytes === 'number' &&
              row.bodyBytes <= 65536,
          )
          used.add(row.physicalId as number)
          const binary = atob(row.rawBodyBase64),
            bytes = Uint8Array.from(binary, (x) => x.charCodeAt(0))
          check(btoa(binary) === row.rawBodyBase64 && bytes.length === row.bodyBytes)
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          check(bodyHash(text) === row.bodySha256)
          const response = parseFluidUsdcBridgeJointNativeEvidenceJson(text, 65536)
          check(
            equal(response, t.response) &&
              exact(response, ['jsonrpc', 'id', 'result']) &&
              obj(t.request),
          )
          let result = response.result
          if (t.request.method === 'eth_getCode') {
            check(
              Array.isArray(t.request.params) &&
                typeof t.request.params[0] === 'string' &&
                hex(result) &&
                result !== '0x',
            )
            const address = t.request.params[0]
            if (codes[address]) check(codes[address] === result)
            else codes[address] = result
            result = { codeRef: address }
          } else if (t.request.method === 'eth_getBlockByNumber') {
            check(obj(result))
            result = { number: result.number, hash: result.hash, timestamp: result.timestamp }
          }
          return {
            stage: t.stage,
            key: t.key,
            physicalId: row.physicalId,
            startedAtUtc: row.startedAtUtc,
            completedAtUtc: row.completedAtUtc,
            bodySha256: row.bodySha256,
            request: t.request,
            response: { jsonrpc: response.jsonrpc, id: response.id, result },
          } as FluidUsdcBridgeJointNativeTrace
        })
        return { host, traces }
      })
      return { cashIndex: a.cashIndex, source: a.source, origins }
    })
    check(used.size === 208)
    return {
      originalBodySha256: seal,
      planSha256: c.planSha256,
      startedAtUtc: c.startedAtUtc,
      acquiredAtUtc: c.availableAtUtc,
      anchors,
    }
  })
  check(subject)
  const transport = {
    schema: 'fluid_usdc_bridge_joint_native_history_evidence_v1',
    profileId: profile.profileId,
    subject,
    codes,
    captures: projected,
    owner: null,
    historicalOwnership: false,
    originalAuthority: false,
    authenticated: false,
  } as FluidUsdcBridgeJointNativeHistoryEvidenceTransport
  check(decodeFluidUsdcBridgeJointNativeHistoryEvidence(transport))
  return freeze(transport)
}
