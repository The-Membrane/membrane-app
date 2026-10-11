import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, keccak256 } from 'viem'
import {
  configuredUsd3HypotheticalOrigins,
  createUsd3HypotheticalCaptureControl,
  parseUsd3HypotheticalJson,
} from '@/scripts/research/usd3-hypothetical-history-capture.mjs'
import {
  beginHolderNativeHistoryOriginalSeries,
  recordHolderNativeHistoryOriginalBatch,
  finishHolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalSeries,
  type HolderNativeHistoryOriginalReason,
  type HolderNativeHistoryOriginalRetentionStatus,
} from './holderNativeHistoryOriginals.server'
import { FLUID_USDC_BRIDGE_NATIVE_ABI } from './fluidUsdcBridgeNativeAbi'
import {
  fluidUsdcBridgeNativeCapacityReadPlan,
  replayFluidUsdcBridgeNativeCapacityFact,
  FLUID_USDC_BRIDGE_NATIVE_ROUTE,
  FLUID_USDC_BRIDGE_NATIVE_VAULT,
  FLUID_USDC_BRIDGE_NATIVE_ASSET,
  type FluidUsdcBridgeNativeCapacityFact,
} from './fluidUsdcBridgeNativeCapacity'
import { resolveFluidUsdcBridgeJointTrustedProfile } from './fluidUsdcBridgeJointTrustedProfile'
import {
  FLUID_USDT_QUOTE_ABI,
  FLUID_USDT_QUOTE_CONTRACTS,
  FLUID_USDT_QUOTE_ROUTE,
  FLUID_USDT_QUOTE_HOSTS,
  createFluidUsdtNativeQuoteContext,
  fluidUsdtNativeQuoteReadPlan,
  decodeFluidUsdtNativeQuoteEvidence,
  type FluidUsdtNativeQuoteBinding,
  type FluidUsdtNativeQuoteEvidenceTransport,
  type FluidUsdtNativeQuoteEvidence,
  type FluidUsdtNativeQuoteTrace,
} from './fluidUsdtBridgeNativeQuoteEvidenceCodec'

type Source = FluidUsdcBridgeNativeCapacityFact['source']
type Spec = { key: string; request: { method: string; params: unknown[] } }
type Trace = Spec & { result: unknown }
export type FluidUsdtBridgeNativeCapacityBinding = Readonly<{
  owner: string
  requestedFinalUsdtRaw: string
  source: Source
  asOfMs: number
}>
export type FluidUsdtBridgeNativeCapacityFact = Readonly<{
  schema: 'fluid_usdt_bridge_native_current_v1'
  routeKey: typeof FLUID_USDT_QUOTE_ROUTE
  destination: typeof FLUID_USDC_BRIDGE_NATIVE_VAULT
  owner: string
  source: Source
  inputAsset: typeof FLUID_USDC_BRIDGE_NATIVE_ASSET
  inputDecimals: 6
  outputAsset: typeof FLUID_USDT_QUOTE_CONTRACTS.usdt
  outputDecimals: 6
  shareDecimals: 18
  sharesRaw: string
  fullNetEaRaw: string
  nativeProngs: FluidUsdcBridgeNativeCapacityFact['nativeProngs']
  withdrawalFeeBps: number
  paused: boolean
  requestedFinalUsdtRaw: string
  requiredNetUsdcRaw: string
  roundtripUsdtRaw: string
  runtimeCodeHashes: Readonly<Record<string, string>>
  readAtUtc: string
  acquiredAtUtc: string
  availableAtUtc: string
  profileId: 'fluid-usdt-bridge-same-pool-quote-funding-v1'
  conversion: FluidUsdtNativeQuoteEvidence
  originalAuthority: false
  authenticated: false
  executionQualified: false
  calibrated: false
  sourceImplementationEquivalence: false
  combinedBridgeUSDTExecutionRoute: 'unassessed'
  noUSDTCapacityAmountBand: true
  noLinearScaling: true
  MRaw: null
}>
/** Server-only retention metadata must not be serialized into public API responses. */
export type FluidUsdtBridgeNativeCapacityAcquisition = Readonly<{
  fact: FluidUsdtBridgeNativeCapacityFact
  underlyingOriginFacts: readonly FluidUsdcBridgeNativeCapacityFact[]
  quoteWire: FluidUsdtNativeQuoteEvidenceTransport
  retention: HolderNativeHistoryOriginalRetentionStatus
  originalAuthority: false
  authenticated: false
  executionAuthority: false
}>

// Native runtime observations in all ten observed retained conversion points.
// FILE 6df0232007e7ab53bd357387e48692d5a1adae0f736305961c2cf91cc200e88e:
// data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/replayed-conversion-points.json.
// Matching these identities does not establish financial implementation equivalence.
const QUOTE_CONTEXT = createFluidUsdtNativeQuoteContext({
  schema: 'fluid_usdt_quote_context_v1',
  runtimeCodeHashes: {
    '0x1f98431c8ad98523631ae4a59f267346ea31f984':
      '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69',
    '0x61ffe014ba17989e743c5f6cb21bf9697530b21e':
      '0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b',
    '0x3416cf6c708da44db2624d63ea0aaef7113527c6':
      '0x2ff673bacc60a73fc85c678888296c6bce3de2a9d7475c032fe7aa6e0eacba86',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
      '0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505',
    '0xdac17f958d2ee523a2206206994597c13d831ec7':
      '0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55',
  },
  sourceImplementationEquivalence: false,
  originalAuthority: false,
})!
const nativeNow = Date.now,
  nativeFetch = globalThis.fetch
const TTL = 1800000,
  MAX = (1n << 256n) - 1n,
  MAX_STARTS = 76
const originals = new WeakMap<
  object,
  {
    binding: FluidUsdtBridgeNativeCapacityBinding
    fact: FluidUsdtBridgeNativeCapacityFact
    acquisition: FluidUsdtBridgeNativeCapacityAcquisition
    receipt: unknown
  }
>()
let busy = false
let diagnostic: Readonly<{ phase: string; qualified: boolean }> | null = null
export function getLastFluidUsdtBridgeNativeCapacityDiagnostic() {
  return diagnostic
}
function check(v: unknown): asserts v {
  if (!v) throw Error('fluid_usdt_native_current_unavailable')
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
function bindingAt(value: unknown, wall: number): FluidUsdtBridgeNativeCapacityBinding {
  let nodes = 0,
    bytes = 0
  const ancestors = new Set<object>()
  const copy = (v: any, depth: number): any => {
    check(++nodes <= 64 && depth <= 3)
    if (typeof v === 'string') {
      check(v.length <= 128 && (bytes += v.length * 2) <= 4096)
      return v
    }
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))
      return v
    check(
      v &&
        typeof v === 'object' &&
        Object.getPrototypeOf(v) === Object.prototype &&
        !Object.getOwnPropertySymbols(v).length &&
        !ancestors.has(v),
    )
    ancestors.add(v)
    const out: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      check(
        k.length <= 64 &&
          (bytes += k.length * 2) <= 4096 &&
          !['__proto__', 'constructor', 'prototype'].includes(k) &&
          d.enumerable &&
          Object.hasOwn(d, 'value'),
      )
      out[k] = copy(d.value, depth + 1)
    }
    ancestors.delete(v)
    return out
  }
  const b = copy(value, 0) as FluidUsdtBridgeNativeCapacityBinding
  check(Object.keys(b).sort().join(',') === 'asOfMs,owner,requestedFinalUsdtRaw,source')
  check(
    /^0x[0-9a-f]{40}$/.test(b.owner) &&
      !/^0x0{40}$/.test(b.owner) &&
      raw(b.requestedFinalUsdtRaw) &&
      BigInt(b.requestedFinalUsdtRaw) > 0n,
  )
  const s = b.source
  check(
    s && Object.keys(s).sort().join(',') === 'blockHash,blockNumber,blockTime,chainId,finalized',
  )
  check(
    s.chainId === 1 &&
      s.finalized === true &&
      Number.isSafeInteger(s.blockNumber) &&
      s.blockNumber > 0 &&
      /^0x[0-9a-f]{64}$/.test(s.blockHash) &&
      utc(s.blockTime) &&
      Date.parse(s.blockTime) % 1000 === 0,
  )
  check(
    Number.isSafeInteger(wall) &&
      Number.isSafeInteger(b.asOfMs) &&
      b.asOfMs >= 0 &&
      b.asOfMs <= wall &&
      Date.parse(s.blockTime) <= b.asOfMs &&
      wall - Date.parse(s.blockTime) <= TTL,
  )
  check(Date.now === nativeNow && globalThis.fetch === nativeFetch)
  return freeze(b)
}
function quoteBinding(b: FluidUsdtBridgeNativeCapacityBinding): FluidUsdtNativeQuoteBinding {
  // Safe integer source conversion is explicitly checked before decimal-string transport.
  check(Number.isSafeInteger(b.source.blockNumber) && b.source.blockNumber > 0)
  return freeze({
    routeKey: FLUID_USDT_QUOTE_ROUTE,
    destination: FLUID_USDC_BRIDGE_NATIVE_VAULT,
    inputAsset: FLUID_USDC_BRIDGE_NATIVE_ASSET,
    inputDecimals: 6,
    outputAsset: FLUID_USDT_QUOTE_CONTRACTS.usdt,
    outputDecimals: 6,
    requestedFinalUsdtRaw: b.requestedFinalUsdtRaw,
    source: { ...b.source, blockNumber: String(b.source.blockNumber) },
  })
}
function abiResult(t: Trace, name: string, quote = false): any {
  check(
    typeof t.result === 'string' &&
      /^0x(?:[0-9a-f]{2})*$/.test(t.result) &&
      t.result.length <= 131074,
  )
  const abi = quote ? FLUID_USDT_QUOTE_ABI : FLUID_USDC_BRIDGE_NATIVE_ABI
  const result = decodeFunctionResult({ abi, functionName: name, data: t.result } as never)
  check(encodeFunctionResult({ abi, functionName: name, result } as never) === t.result)
  return result
}
function fullEaSpec(S: string, source: Source): Spec {
  check(raw(S))
  return {
    key: 'full_net_ea',
    request: {
      method: 'eth_call',
      params: [
        {
          to: FLUID_USDC_BRIDGE_NATIVE_VAULT,
          data: encodeFunctionData({
            abi: FLUID_USDC_BRIDGE_NATIVE_ABI,
            functionName: 'previewRedeem',
            args: [BigInt(S)],
          }),
        },
        { blockHash: source.blockHash, requireCanonical: true },
      ],
    },
  }
}
function underlying(
  traces: Trace[],
  b: FluidUsdtBridgeNativeCapacityBinding,
  readAtUtc: string,
): FluidUsdcBridgeNativeCapacityFact {
  const get = (key: string, name: string) => abiResult(traces.find((t) => t.key === key)!, name)
  const data = get('bank_data', 'getData'),
    supply = get('bank_supply', 'getUserSupplyData')[0]
  const candidate = {
    schema: 'fluid_usdc_bridge_native_capacity_v1' as const,
    routeKey: FLUID_USDC_BRIDGE_NATIVE_ROUTE,
    destination: FLUID_USDC_BRIDGE_NATIVE_VAULT,
    owner: b.owner,
    asset: FLUID_USDC_BRIDGE_NATIVE_ASSET,
    assetDecimals: 6 as const,
    shareDecimals: 18 as const,
    source: b.source,
    readAtUtc,
    sharesRaw: String(get('holder_shares', 'balanceOf')),
    fullNetEaRaw: String(get('full_net_ea', 'previewRedeem')),
    feeBps: Number(get('fee', 'getWithdrawalFeeBPS')),
    paused: get('pause', 'isWithdrawalsPaused'),
    nativeProngs: {
      bridgeFunding: String(get('bridge_funding', 'maxWithdraw')),
      bankCash: String(get('bank_cash', 'balanceOf')),
      bankSupply: String(data[6]),
      bankWithdrawableUntilLimit: String(supply.withdrawableUntilLimit),
      bankResolverWithdrawable: String(supply.withdrawable),
    },
    runtimeCodeHashes: Object.fromEntries(
      traces
        .filter((t) => t.key.startsWith('code:'))
        .map((t) => {
          check(typeof t.result === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(t.result))
          return [t.key.slice(5), keccak256(t.result as `0x${string}`)]
        }),
    ),
    traces,
  }
  const fact = replayFluidUsdcBridgeNativeCapacityFact(candidate, b.owner, b.source, nativeNow())
  const profile = resolveFluidUsdcBridgeJointTrustedProfile(
    FLUID_USDC_BRIDGE_NATIVE_ROUTE,
    FLUID_USDC_BRIDGE_NATIVE_VAULT,
    FLUID_USDC_BRIDGE_NATIVE_ASSET,
  )
  check(
    fact &&
      profile &&
      isDeepStrictEqual(fact.runtimeCodeHashes, profile.runtimeCodeHashes) &&
      fact.feeBps === profile.feeBps,
  )
  return fact
}
function tokens(origins: readonly { url: string }[]): string[] {
  const routing = new Set(['v1', 'v2', 'v3', 'eth', 'ethereum', 'mainnet', 'rpc'])
  return [
    ...new Set(
      origins.flatMap((o) => {
        const u = new URL(o.url)
        const decode = (s: string) => {
          try {
            return decodeURIComponent(s)
          } catch {
            return s
          }
        }
        return [
          o.url,
          decode(o.url),
          ...u.pathname
            .split('/')
            .filter((s) => s && !routing.has(s.toLowerCase()))
            .flatMap((s) => [s, decode(s)]),
          ...Array.from(u.searchParams.values()).flatMap((v) => [v, decode(v)]),
        ].filter(Boolean)
      }),
    ),
  ]
}
function privateBytes(text: string, forbidden: readonly string[]): void {
  let nodes = 0
  const test = (s: string) => {
    check(!forbidden.some((t) => s.includes(t)))
    try {
      check(!forbidden.some((t) => decodeURIComponent(s).includes(t)))
    } catch (e) {
      if (e instanceof Error && e.message === 'fluid_usdt_native_current_unavailable') throw e
    }
  }
  test(text)
  let v: unknown
  try {
    v = parseUsd3HypotheticalJson(text)
  } catch {
    check(!text.includes('\\'))
    return
  }
  const visit = (x: any, depth: number): void => {
    check(++nodes <= 100000 && depth <= 24)
    if (typeof x === 'string') test(x)
    else if (x && typeof x === 'object')
      Object.entries(x).forEach(([k, y]) => {
        test(k)
        visit(y, depth + 1)
      })
  }
  visit(v, 0)
}
type Observation = {
  host: string
  key: string
  request: any
  result: unknown
  physicalId: number
  requestBodyBase64: string
  requestBodySha256: string
}
type RequestOriginal = {
  host: string
  key: string
  rpcId: number
  requestBodyBase64: string
  requestBodySha256: string
}
/** Closed on-demand native current read: no caller transport, runtime context, clock, or history hooks. */
export async function acquireFluidUsdtBridgeNativeCapacity(
  binding: FluidUsdtBridgeNativeCapacityBinding,
): Promise<FluidUsdtBridgeNativeCapacityAcquisition | null> {
  if (busy) return null
  let control: ReturnType<typeof createUsd3HypotheticalCaptureControl> | undefined
  let series: HolderNativeHistoryOriginalSeries | undefined
  let recorded = false,
    finished = false,
    unsafe = false,
    phase = 'binding'
  let reason: HolderNativeHistoryOriginalReason = 'provider_unavailable'
  let b: FluidUsdtBridgeNativeCapacityBinding | undefined
  let secretTokens: string[] = []
  const observations: Observation[] = [],
    requests: RequestOriginal[] = []
  let starts = 0,
    rpcId = 0
  const controlNamespace = 'fluid_usdt_' + randomUUID()
  let capturedSettlements: any[] = []
  const started = nativeNow()
  const retain = (receipt: any, accepted: boolean) => {
    check(series && !recorded && control)
    // Snapshot append-only settlements exactly once; late bodies absent from frozen ledger are scanned too.
    const settlements = (capturedSettlements = structuredClone(control.settlementReceipts))
    try {
      for (const row of [...receipt.ledger, ...settlements.map((s: any) => s.observation)]) {
        if (row.rawBodyBase64 !== null) {
          check(typeof row.rawBodyBase64 === 'string')
          const bytes = Buffer.from(row.rawBodyBase64, 'base64')
          check(
            bytes.length <= 65536 &&
              bytes.toString('base64') === row.rawBodyBase64 &&
              sha(bytes) === row.bodySha256 &&
              bytes.length === row.bodyBytes,
          )
          privateBytes(new TextDecoder('utf-8', { fatal: true }).decode(bytes), secretTokens)
        }
      }
      for (const request of requests)
        privateBytes(
          Buffer.from(request.requestBodyBase64, 'base64').toString('utf8'),
          secretTokens,
        )
      // Also inspect non-base64 native metadata/keys before writing any receipt.
      privateBytes(JSON.stringify({ receipt, settlements, requests }), secretTokens)
    } catch {
      unsafe = true
      reason = 'invalid_input'
      throw Error('fluid_usdt_native_current_unavailable')
    }
    recorded = true
    return recordHolderNativeHistoryOriginalBatch(series, {
      batchIndex: 0,
      plan: {
        schema: 'fluid_usdt_bridge_current_native_read_plan_v1',
        binding: b,
        quoteRuntimeObservationContext: QUOTE_CONTEXT,
        maxPhysicalStarts: MAX_STARTS,
        requests,
      },
      receipt: { ...receipt, requests, settlements },
      capturedAccepted: accepted,
    })
  }
  try {
    b = bindingAt(binding, started)
    busy = true
    series = beginHolderNativeHistoryOriginalSeries({
      kind: 'fluid_usdt_bridge_current',
      sharesRaw: null,
    })
    phase = 'origins'
    const origins = await configuredUsd3HypotheticalOrigins()
    check(
      origins.length === 2 &&
        origins.every((o: { host: string }, i: number) => o.host === FLUID_USDT_QUOTE_HOSTS[i]),
    )
    secretTokens = tokens(origins)
    bindingAt(b, nativeNow())
    control = createUsd3HypotheticalCaptureControl(origins)
    const controller = control,
      qb = quoteBinding(b)
    const initial = fluidUsdtNativeQuoteReadPlan(qb)!
    check(initial.length === 16)
    const states = origins.map((origin: { host: string; url: string }) => ({
      origin,
      first: [] as Trace[],
      quote: [] as Trace[],
      quoteIds: [] as number[],
      R: '',
    }))
    const request = async (
      state: (typeof states)[number],
      spec: Spec,
      quote: boolean,
    ): Promise<Trace> => {
      check(++starts <= MAX_STARTS && nativeNow() >= started && nativeNow() - started <= 120000)
      const body = { jsonrpc: '2.0', id: ++rpcId, ...spec.request },
        bytes = Buffer.from(JSON.stringify(body))
      check(bytes.length <= 2048)
      const original = {
        host: state.origin.host,
        key: (quote ? 'quote:' : 'bridge:') + spec.key,
        rpcId: body.id,
        requestBodyBase64: bytes.toString('base64'),
        requestBodySha256: sha(bytes),
      }
      requests.push(original) // Preserve actual request bytes before physical dispatch.
      const response = await controller.fetcher(state.origin.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: bytes.toString('utf8'),
      })
      const text = await response.text()
      check(Buffer.byteLength(text) <= 65536)
      const envelope = parseUsd3HypotheticalJson(text)
      check(
        Object.keys(envelope).sort().join(',') === 'id,jsonrpc,result' &&
          envelope.jsonrpc === '2.0' &&
          envelope.id === body.id,
      )
      const physicalId = Number(response.headers.get('x-usd3-physical-id'))
      check(Number.isSafeInteger(physicalId) && physicalId > 0)
      observations.push({ ...original, request: body, result: envelope.result, physicalId })
      const trace = { key: spec.key, request: spec.request, result: envelope.result }
      if (quote) {
        state.quote.push(trace)
        state.quoteIds.push(physicalId)
      } else state.first.push(trace)
      return trace
    }
    const stage = async (name: string, run: (s: (typeof states)[number]) => Promise<void>) => {
      bindingAt(b!, nativeNow())
      controller.beginStage(name)
      await Promise.all(states.map(run))
    }
    await stage('usdt_witness', async (s) => {
      for (const spec of initial.slice(0, 3)) await request(s, spec, true)
    })
    const base = fluidUsdcBridgeNativeCapacityReadPlan(b.owner, b.source)
    check(base.length === 19)
    await stage('usdt_bridge_a', async (s) => {
      for (const spec of base.slice(0, 10)) await request(s, spec, false)
    })
    await stage('usdt_bridge_b', async (s) => {
      for (const spec of base.slice(10)) await request(s, spec, false)
      const S = abiResult(s.first.find((t) => t.key === 'holder_shares')!, 'balanceOf')
      check(typeof S === 'bigint' && raw(String(S)))
      await request(s, fullEaSpec(String(S), b!.source), false)
    })
    await stage('usdt_quote_a', async (s) => {
      for (const spec of initial.slice(3, 10)) await request(s, spec, true)
    })
    await stage('usdt_quote_b', async (s) => {
      for (const spec of initial.slice(10)) await request(s, spec, true)
      const result = abiResult(s.quote.at(-1)!, 'quoteExactOutputSingle', true)
      s.R = String(result[0])
      check(raw(s.R) && BigInt(s.R) > 0n)
    })
    await stage('usdt_quote_c', async (s) => {
      const complete = fluidUsdtNativeQuoteReadPlan(qb, s.R)!
      check(complete.length === 18)
      for (const spec of complete.slice(16)) await request(s, spec, true)
    })
    phase = 'raw_receipt'
    const receipt = await controller.finish()
    retain(
      receipt,
      receipt.failure === null &&
        receipt.physicalStarts === MAX_STARTS &&
        receipt.pendingSettlements === 0,
    )
    reason = 'replay_rejected'
    const replayAt = nativeNow()
    check(
      receipt.failure === null &&
        receipt.pendingSettlements === 0 &&
        receipt.physicalStarts === MAX_STARTS &&
        starts === MAX_STARTS &&
        replayAt - started <= 120000,
    )
    check(
      receipt.ledger.length === MAX_STARTS &&
        receipt.terminalCommitments.length === MAX_STARTS &&
        observations.length === MAX_STARTS &&
        requests.length === MAX_STARTS,
    )
    check(new Set(observations.map((o) => o.physicalId)).size === MAX_STARTS)
    const settlements = capturedSettlements
    check(
      settlements.length === MAX_STARTS &&
        new Set(settlements.map((s: any) => s.physicalId)).size === MAX_STARTS,
    )
    for (const o of observations) {
      const row = receipt.ledger.find((r: any) => r.physicalId === o.physicalId)
      const commit = receipt.terminalCommitments.find((r: any) => r.physicalId === o.physicalId)
      const settled = settlements.find((s: any) => s.physicalId === o.physicalId)
      check(
        row &&
          row.accepted === true &&
          row.status === 'success' &&
          row.httpStatus === 200 &&
          row.host === o.host &&
          isDeepStrictEqual(row.request, o.request),
      )
      check(commit?.rowSha256 === sha(JSON.stringify(row)))
      const requestBytes = Buffer.from(o.requestBodyBase64, 'base64')
      check(
        requestBytes.length <= 2048 &&
          requestBytes.toString('base64') === o.requestBodyBase64 &&
          sha(requestBytes) === o.requestBodySha256 &&
          isDeepStrictEqual(parseUsd3HypotheticalJson(requestBytes.toString('utf8')), row.request),
      )
      const { sha256, ...settlementBody } = settled
      check(
        sha256 === sha(JSON.stringify(settlementBody)) &&
          settled.captureAcceptance === false &&
          isDeepStrictEqual(settled.observation, row),
      )
      const bytes = Buffer.from(row.rawBodyBase64, 'base64')
      check(
        bytes.toString('base64') === row.rawBodyBase64 &&
          bytes.length === row.bodyBytes &&
          sha(bytes) === row.bodySha256,
      )
      const response = parseUsd3HypotheticalJson(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      )
      check(
        response.jsonrpc === '2.0' &&
          response.id === o.request.id &&
          isDeepStrictEqual(response.result, o.result),
      )
      check(
        utc(row.startedAtUtc) &&
          utc(row.completedAtUtc) &&
          Date.parse(row.startedAtUtc) >= started &&
          Date.parse(row.completedAtUtc) >= Date.parse(row.startedAtUtc) &&
          Date.parse(row.completedAtUtc) <= replayAt,
      )
    }
    phase = 'native_replay'
    const acquiredAtUtc = new Date(
      Math.max(...receipt.ledger.map((r: any) => Date.parse(r.completedAtUtc))),
    ).toISOString()
    const facts = states.map((s) =>
      underlying(
        s.first,
        b!,
        new Date(
          Math.max(
            ...observations
              .filter((o) => o.host === s.origin.host && o.key.startsWith('bridge:'))
              .map((o) =>
                Date.parse(
                  receipt.ledger.find((r: any) => r.physicalId === o.physicalId).completedAtUtc,
                ),
              ),
          ),
        ).toISOString(),
      ),
    )
    check(isDeepStrictEqual({ ...facts[0], readAtUtc: null }, { ...facts[1], readAtUtc: null }))
    const wireAt = (availableAtUtc: string): FluidUsdtNativeQuoteEvidenceTransport => ({
      schema: 'fluid_usdt_native_quote_evidence_v1',
      binding: qb,
      origins: states.map((s) => {
        const traces: FluidUsdtNativeQuoteTrace[] = s.quote.map((t, i) => {
          const row = receipt.ledger.find((r: any) => r.physicalId === s.quoteIds[i])
          const original = observations.find((o) => o.physicalId === row.physicalId)!
          return {
            key: t.key,
            controlNamespace,
            physicalId: row.physicalId,
            startedAtUtc: row.startedAtUtc,
            completedAtUtc: row.completedAtUtc,
            requestBodyBase64: original.requestBodyBase64,
            requestBodySha256: original.requestBodySha256,
            responseBodyBase64: row.rawBodyBase64,
            responseBodySha256: row.bodySha256,
          }
        })
        return {
          host: s.origin.host,
          traces,
          acquiredAtUtc: traces.at(-1)!.completedAtUtc,
          availableAtUtc,
        }
      }),
      acquiredAtUtc,
      availableAtUtc,
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      calibrated: false,
    })
    check(decodeFluidUsdtNativeQuoteEvidence(wireAt(acquiredAtUtc), QUOTE_CONTEXT))
    phase = 'retention'
    const retention = finishHolderNativeHistoryOriginalSeries(series, {
      qualification: true,
      reason: 'qualified',
      batchQualifications: [true],
    })
    finished = true
    check(
      retention.status === 'retained' &&
        retention.reason === 'qualified' &&
        retention.producerReplayQualification === true &&
        retention.recordedBatches === 1,
    )
    const availableAtMs = nativeNow(),
      availableAtUtc = new Date(availableAtMs).toISOString()
    bindingAt(b, availableAtMs)
    check(availableAtMs >= replayAt && availableAtMs - started <= 120000)
    const quoteWire = freeze(wireAt(availableAtUtc))
    const conversion = decodeFluidUsdtNativeQuoteEvidence(quoteWire, QUOTE_CONTEXT)
    check(
      conversion &&
        conversion.runtimeCodeHashes[FLUID_USDC_BRIDGE_NATIVE_ASSET] ===
          facts[0].runtimeCodeHashes[FLUID_USDC_BRIDGE_NATIVE_ASSET],
    )
    const fact: FluidUsdtBridgeNativeCapacityFact = freeze({
      schema: 'fluid_usdt_bridge_native_current_v1',
      routeKey: FLUID_USDT_QUOTE_ROUTE,
      destination: FLUID_USDC_BRIDGE_NATIVE_VAULT,
      owner: b.owner,
      source: b.source,
      inputAsset: FLUID_USDC_BRIDGE_NATIVE_ASSET,
      inputDecimals: 6,
      outputAsset: FLUID_USDT_QUOTE_CONTRACTS.usdt,
      outputDecimals: 6,
      shareDecimals: 18,
      sharesRaw: facts[0].sharesRaw,
      fullNetEaRaw: facts[0].fullNetEaRaw,
      nativeProngs: facts[0].nativeProngs,
      withdrawalFeeBps: facts[0].feeBps,
      paused: facts[0].paused,
      requestedFinalUsdtRaw: b.requestedFinalUsdtRaw,
      requiredNetUsdcRaw: conversion.requiredNetUsdcRaw,
      roundtripUsdtRaw: conversion.roundtripUsdtRaw,
      runtimeCodeHashes: { ...facts[0].runtimeCodeHashes, ...conversion.runtimeCodeHashes },
      readAtUtc: acquiredAtUtc,
      acquiredAtUtc,
      availableAtUtc,
      profileId: 'fluid-usdt-bridge-same-pool-quote-funding-v1',
      conversion,
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      calibrated: false,
      sourceImplementationEquivalence: false,
      combinedBridgeUSDTExecutionRoute: 'unassessed',
      noUSDTCapacityAmountBand: true,
      noLinearScaling: true,
      MRaw: null,
    })
    // Final real-clock TTL check follows all replay and retention work; no authority from copied JSON.
    const registrationAt = nativeNow()
    bindingAt(b, registrationAt)
    check(registrationAt >= availableAtMs && registrationAt - started <= 120000)
    const acquisition = freeze({
      fact,
      underlyingOriginFacts: facts,
      quoteWire,
      retention,
      originalAuthority: false as const,
      authenticated: false as const,
      executionAuthority: false as const,
    })
    originals.set(acquisition, { binding: b, fact, acquisition, receipt })
    phase = 'complete'
    diagnostic = Object.freeze({ phase, qualified: true })
    return acquisition
  } catch {
    diagnostic = Object.freeze({ phase, qualified: false })
    return null
  } finally {
    if (control && !recorded && !unsafe) {
      try {
        retain(await control.finish(), false)
      } catch {
        /* Bounded fixed diagnostic; never print provider text. */
      }
    }
    if (series && !finished) {
      try {
        finishHolderNativeHistoryOriginalSeries(series, {
          qualification: false,
          reason,
          batchQualifications: recorded ? [false] : [],
        })
      } catch {
        /* Local sink failure does not create an original identity. */
      }
    }
    busy = false
  }
}
/** Only the original server acquisition pointer selects; serialized/forged/cloned objects cannot. */
export function selectedOriginalFluidUsdtBridgeNativeCapacity(
  value: unknown,
  binding: FluidUsdtBridgeNativeCapacityBinding,
): FluidUsdtBridgeNativeCapacityFact | null {
  try {
    check(value && typeof value === 'object')
    const original = originals.get(value as object)
    check(original)
    const b = bindingAt(binding, nativeNow())
    check(isDeepStrictEqual({ ...b, asOfMs: null }, { ...original.binding, asOfMs: null }))
    check(
      b.asOfMs >= original.binding.asOfMs &&
        b.asOfMs >= Date.parse(original.fact.availableAtUtc) &&
        b.asOfMs >= Date.parse(original.fact.acquiredAtUtc),
    )
    return original.fact
  } catch {
    return null
  }
}
