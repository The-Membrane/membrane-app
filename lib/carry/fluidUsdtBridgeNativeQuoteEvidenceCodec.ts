import {
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  sha256,
  toHex,
} from 'viem'

export const FLUID_USDT_QUOTE_ROUTE = 'USDT → FluidBridgeAggregatorProxy [USDC]' as const
export const FLUID_USDT_QUOTE_DESTINATION = '0x273da948aca9261043fbdb2a857bc255ecc29012' as const
export const FLUID_USDT_QUOTE_CONTRACTS = Object.freeze({
  usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
  pool: '0x3416cf6c708da44db2624d63ea0aaef7113527c6',
} as const)
export const FLUID_USDT_QUOTE_ABI = parseAbi([
  'function getPool(address,address,uint24) view returns(address)',
  'function token0() view returns(address)',
  'function token1() view returns(address)',
  'function fee() view returns(uint24)',
  'function factory() view returns(address)',
  'function decimals() view returns(uint8)',
  'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
])
export type FluidUsdtNativeQuoteSource = Readonly<{
  chainId: 1
  blockNumber: string
  blockHash: string
  blockTime: string
  finalized: true
}>
/** Independently selected by a future closed producer. These unsigned hashes confer no approval. */
export type FluidUsdtNativeQuoteContext = Readonly<{
  schema: 'fluid_usdt_quote_context_v1'
  runtimeCodeHashes: Readonly<Record<string, string>>
  sourceImplementationEquivalence: false
  originalAuthority: false
}>
export type FluidUsdtNativeQuoteBinding = Readonly<{
  routeKey: typeof FLUID_USDT_QUOTE_ROUTE
  destination: typeof FLUID_USDT_QUOTE_DESTINATION
  inputAsset: typeof FLUID_USDT_QUOTE_CONTRACTS.usdc
  inputDecimals: 6
  outputAsset: typeof FLUID_USDT_QUOTE_CONTRACTS.usdt
  outputDecimals: 6
  requestedFinalUsdtRaw: string
  source: FluidUsdtNativeQuoteSource
}>
export type FluidUsdtNativeQuoteTrace = Readonly<{
  key: string
  controlNamespace: string
  physicalId: number
  startedAtUtc: string
  completedAtUtc: string
  requestBodyBase64: string
  requestBodySha256: string
  responseBodyBase64: string
  responseBodySha256: string
}>
export type FluidUsdtNativeQuoteEvidenceTransport = Readonly<{
  schema: 'fluid_usdt_native_quote_evidence_v1'
  binding: FluidUsdtNativeQuoteBinding
  origins: readonly Readonly<{
    host: string
    traces: readonly FluidUsdtNativeQuoteTrace[]
    acquiredAtUtc: string
    availableAtUtc: string
  }>[]
  acquiredAtUtc: string
  availableAtUtc: string
  originalAuthority: false
  authenticated: false
  executionQualified: false
  calibrated: false
}>
export const FLUID_USDT_QUOTE_HOSTS = Object.freeze([
  'eth-mainnet.g.alchemy.com',
  'rpc.ankr.com',
] as const)
export const FLUID_USDT_NATIVE_QUOTE_LIMITS = Object.freeze({
  responseBytes: 65536,
  requestBytes: 2048,
  transportJsonBytes: 8 * 1024 * 1024,
  snapshotStringBytes: 8 * 1024 * 1024,
  rawJsonArrayItems: 2048,
  tracesPerOrigin: 18,
  origins: 2,
})
// 36 responses×64KiB plus 36 fixed-plan requests×2KiB base64 require <6.6MiB UTF16;
// 8MiB additionally bounds metadata/keys. Native block hash arrays are raw-body bounded.
const C = FLUID_USDT_QUOTE_CONTRACTS,
  MAX = (1n << 256n) - 1n
const fail = (reason: string): never => {
  throw Error(reason)
}
const check = (ok: unknown, reason = 'invalid_quote_evidence'): void => {
  if (!ok) fail(reason)
}
const record = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
function exact(v: unknown, keys: string[]) {
  check(record(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|'))
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
function snapshot(
  v: unknown,
  maxBytes = FLUID_USDT_NATIVE_QUOTE_LIMITS.snapshotStringBytes,
  arrayCap = 256,
): any {
  let nodes = 0,
    bytes = 0
  const parents = new Set<object>()
  const copy = (x: unknown, depth: number): any => {
    check(++nodes <= 50000 && depth <= 24)
    if (x === null || typeof x === 'boolean') return x
    if (typeof x === 'number') {
      check(Number.isFinite(x))
      return x
    }
    if (typeof x === 'string') {
      bytes += x.length * 2
      check(bytes <= maxBytes)
      return x
    }
    check(
      x &&
        typeof x === 'object' &&
        !parents.has(x as object) &&
        Object.getOwnPropertySymbols(x).length === 0,
    )
    const o = x as object,
      ds = Object.getOwnPropertyDescriptors(o),
      a = Array.isArray(o),
      p = Object.getPrototypeOf(o)
    check(a ? p === Array.prototype : p === Object.prototype || p === null)
    parents.add(o)
    try {
      if (a) {
        check(o.length <= arrayCap && Object.keys(ds).length === o.length + 1)
        return Array.from({ length: o.length }, (_, n) => {
          const d = ds[String(n)]
          check(d?.enumerable && Object.hasOwn(d, 'value'))
          return copy(d.value, depth + 1)
        })
      }
      check(Object.keys(ds).length <= 64)
      const out: Record<string, unknown> = {}
      for (const [k, d] of Object.entries(ds)) {
        bytes += k.length * 2
        check(
          k.length <= 256 &&
            bytes <= maxBytes &&
            d.enumerable &&
            Object.hasOwn(d, 'value') &&
            !['__proto__', 'constructor', 'prototype'].includes(k),
        )
        out[k] = copy(d.value, depth + 1)
      }
      return out
    } finally {
      parents.delete(o)
    }
  }
  return copy(v, 0)
}
function canonical(v: any): string {
  if (typeof v === 'bigint') return JSON.stringify(String(v))
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  return Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
}
/** Duplicate keys are rejected before ordinary JSON parsing or schema validation. */
function parseBoundedJson(text: string, maxBytes: number, arrayCap: number): unknown {
  check(typeof text === 'string' && new TextEncoder().encode(text).length <= maxBytes)
  let n = 0,
    tokens = 0
  const white = () => {
    while (/\s/.test(text[n] ?? '') && n < text.length) n++
  }
  const string = () => {
    const start = n
    check(text[n++] === '"')
    let escaped = false
    while (n < text.length) {
      const ch = text[n++]
      if (ch === '"' && !escaped) return JSON.parse(text.slice(start, n))
      if (ch === '\\' && !escaped) escaped = true
      else escaped = false
    }
    return fail('invalid_json')
  }
  const value = (depth: number): void => {
    check(depth <= 24 && ++tokens <= 50000)
    white()
    const ch = text[n]
    if (ch === '"') {
      string()
      return
    }
    if (ch === '{') {
      n++
      white()
      const keys = new Set<string>()
      if (text[n] === '}') {
        n++
        return
      }
      for (;;) {
        white()
        const key = string()
        check(!keys.has(key), 'duplicate_json_key')
        keys.add(key)
        white()
        check(text[n++] === ':')
        value(depth + 1)
        white()
        const c = text[n++]
        if (c === '}') return
        check(c === ',')
      }
    }
    if (ch === '[') {
      n++
      white()
      if (text[n] === ']') {
        n++
        return
      }
      for (;;) {
        value(depth + 1)
        white()
        const c = text[n++]
        if (c === ']') return
        check(c === ',')
      }
    }
    const m = text
      .slice(n)
      .match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/)
    check(m)
    n += m![0].length
  }
  value(0)
  white()
  check(n === text.length)
  return snapshot(
    JSON.parse(text),
    Math.min(maxBytes * 2, FLUID_USDT_NATIVE_QUOTE_LIMITS.snapshotStringBytes),
    arrayCap,
  )
}
export function parseFluidUsdtNativeQuoteJson(text: string): unknown {
  return parseBoundedJson(text, FLUID_USDT_NATIVE_QUOTE_LIMITS.transportJsonBytes, 256)
}
function bytes(base64: unknown, digest: unknown, maxBytes = 65536): Uint8Array {
  check(
    typeof base64 === 'string' &&
      base64.length <= 87384 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64),
  )
  const bin = atob(base64 as string)
  check(bin.length > 0 && bin.length <= maxBytes && btoa(bin) === base64)
  const b = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  check(
    typeof digest === 'string' &&
      /^[0-9a-f]{64}$/.test(digest) &&
      sha256(toHex(b)).slice(2) === digest,
    'raw_body_hash',
  )
  return b
}
const nativeJson = (b: Uint8Array) =>
  parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(b), 65536, 2048) as Record<
    string,
    any
  >
/** Raw-byte diagnostic only; neither this parser nor the SHA grants acquisition authority. */
export function parseFluidUsdtNativeQuoteRpcBody(base64: string, digest: string): unknown {
  return nativeJson(bytes(base64, digest))
}
function binding(v: any): FluidUsdtNativeQuoteBinding {
  exact(v, [
    'routeKey',
    'destination',
    'inputAsset',
    'inputDecimals',
    'outputAsset',
    'outputDecimals',
    'requestedFinalUsdtRaw',
    'source',
  ])
  check(
    v.routeKey === FLUID_USDT_QUOTE_ROUTE &&
      v.destination === FLUID_USDT_QUOTE_DESTINATION &&
      v.inputAsset === C.usdc &&
      v.inputDecimals === 6 &&
      v.outputAsset === C.usdt &&
      v.outputDecimals === 6,
  )
  check(raw(v.requestedFinalUsdtRaw) && v.requestedFinalUsdtRaw !== '0')
  exact(v.source, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'])
  check(
    v.source.chainId === 1 &&
      v.source.finalized === true &&
      raw(v.source.blockNumber) &&
      v.source.blockNumber !== '0' &&
      hash(v.source.blockHash) &&
      utc(v.source.blockTime) &&
      Date.parse(v.source.blockTime) % 1000 === 0,
  )
  return v
}
export function createFluidUsdtNativeQuoteContext(
  supplied: unknown,
): FluidUsdtNativeQuoteContext | null {
  try {
    const v = snapshot(supplied)
    exact(v, [
      'schema',
      'runtimeCodeHashes',
      'sourceImplementationEquivalence',
      'originalAuthority',
    ])
    check(
      v.schema === 'fluid_usdt_quote_context_v1' &&
        v.sourceImplementationEquivalence === false &&
        v.originalAuthority === false,
    )
    exact(v.runtimeCodeHashes, Object.values(C))
    check(Object.values(v.runtimeCodeHashes).every(hash))
    return freeze(v)
  } catch {
    return null
  }
}
type Spec = { key: string; request: { method: string; params: unknown[] }; name?: string }
function specs(b: FluidUsdtNativeQuoteBinding, R?: string): Spec[] {
  const pin = { blockHash: b.source.blockHash, requireCanonical: true },
    head = {
      method: 'eth_getBlockByNumber',
      params: ['0x' + BigInt(b.source.blockNumber).toString(16), false],
    }
  const call = (key: string, to: string, name: string, args: unknown[] = []): Spec => ({
    key,
    name,
    request: {
      method: 'eth_call',
      params: [
        {
          to,
          data: encodeFunctionData({
            abi: FLUID_USDT_QUOTE_ABI,
            functionName: name,
            args,
          } as never),
        },
        pin,
      ],
    },
  })
  const list: Spec[] = [
    { key: 'chain', request: { method: 'eth_chainId', params: [] } },
    { key: 'finalized', request: { method: 'eth_getBlockByNumber', params: ['finalized', false] } },
    { key: 'header_before', request: head },
    ...Object.entries(C).map(([key, to]) => ({
      key: 'code_' + key,
      request: { method: 'eth_getCode', params: [to, pin] },
    })),
    call('factory_pool', C.factory, 'getPool', [C.usdc, C.usdt, 100]),
    call('token0', C.pool, 'token0'),
    call('token1', C.pool, 'token1'),
    call('pool_fee', C.pool, 'fee'),
    call('pool_factory', C.pool, 'factory'),
    call('usdc_decimals', C.usdc, 'decimals'),
    call('usdt_decimals', C.usdt, 'decimals'),
    call('required_usdc', C.quoter, 'quoteExactOutputSingle', [
      {
        tokenIn: C.usdc,
        tokenOut: C.usdt,
        amount: BigInt(b.requestedFinalUsdtRaw),
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
    ]),
  ]
  if (R !== undefined) {
    check(raw(R) && R !== '0')
    list.push(
      call('roundtrip_usdt', C.quoter, 'quoteExactInputSingle', [
        { tokenIn: C.usdc, tokenOut: C.usdt, amountIn: BigInt(R), fee: 100, sqrtPriceLimitX96: 0n },
      ]),
      { key: 'header_after', request: head },
    )
  }
  return list
}
/** Initial plan ends at R. Roundtrip plan is completed only after native R has been decoded. */
export function fluidUsdtNativeQuoteReadPlan(
  supplied: FluidUsdtNativeQuoteBinding,
  requiredUsdcRaw?: string,
): readonly Spec[] | null {
  try {
    return freeze(specs(binding(snapshot(supplied)), requiredUsdcRaw))
  } catch {
    return null
  }
}
function header(v: any) {
  check(
    record(v) &&
      typeof v.number === 'string' &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v.number) &&
      hash(v.hash) &&
      typeof v.timestamp === 'string' &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v.timestamp),
  )
  if (Object.hasOwn(v, 'transactions'))
    check(
      Array.isArray(v.transactions) && v.transactions.length <= 2048 && v.transactions.every(hash),
    )
  const number = BigInt(v.number),
    seconds = BigInt(v.timestamp)
  check(number > 0n && seconds <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)))
  return {
    blockNumber: String(number),
    blockHash: v.hash,
    blockTime: new Date(Number(seconds) * 1000).toISOString(),
  }
}
function decode(spec: Spec, result: unknown): any {
  check(typeof result === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(result))
  const v = decodeFunctionResult({
    abi: FLUID_USDT_QUOTE_ABI,
    functionName: spec.name!,
    data: result as `0x${string}`,
  })
  check(
    encodeFunctionResult({
      abi: FLUID_USDT_QUOTE_ABI,
      functionName: spec.name!,
      result: v,
    } as never) === result,
    'canonical_abi',
  )
  return v
}
export function decodeFluidUsdtNativeQuoteEvidence(
  supplied: unknown,
  suppliedContext: FluidUsdtNativeQuoteContext,
) {
  try {
    const v =
      typeof supplied === 'string' ? parseFluidUsdtNativeQuoteJson(supplied) : snapshot(supplied)
    const context = createFluidUsdtNativeQuoteContext(suppliedContext)
    check(context)
    exact(v, [
      'schema',
      'binding',
      'origins',
      'acquiredAtUtc',
      'availableAtUtc',
      'originalAuthority',
      'authenticated',
      'executionQualified',
      'calibrated',
    ])
    check(
      v.schema === 'fluid_usdt_native_quote_evidence_v1' &&
        v.originalAuthority === false &&
        v.authenticated === false &&
        v.executionQualified === false &&
        v.calibrated === false,
    )
    const b = binding(v.binding),
      seen = new Set<string>()
    check(Array.isArray(v.origins) && v.origins.length === 2)
    const replayed = v.origins.map((o: any, index: number) => {
      exact(o, ['host', 'traces', 'acquiredAtUtc', 'availableAtUtc'])
      check(
        o.host === FLUID_USDT_QUOTE_HOSTS[index] &&
          Array.isArray(o.traces) &&
          o.traces.length === 18,
      )
      const initial = specs(b),
        out: Record<string, any> = {},
        identities: Record<string, string> = {}
      let previous = Date.parse(b.source.blockTime),
        R: string | undefined
      const commitments: {
        controlNamespace: string
        physicalId: number
        requestBodySha256: string
        responseBodySha256: string
      }[] = []
      o.traces.forEach((t: any, n: number) => {
        exact(t, [
          'key',
          'controlNamespace',
          'physicalId',
          'startedAtUtc',
          'completedAtUtc',
          'requestBodyBase64',
          'requestBodySha256',
          'responseBodyBase64',
          'responseBodySha256',
        ])
        check(
          typeof t.controlNamespace === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/.test(t.controlNamespace),
        )
        const physicalKey = t.controlNamespace + ':' + t.physicalId
        check(Number.isSafeInteger(t.physicalId) && t.physicalId > 0 && !seen.has(physicalKey))
        seen.add(physicalKey)
        check(
          utc(t.startedAtUtc) &&
            utc(t.completedAtUtc) &&
            Date.parse(t.startedAtUtc) >= previous &&
            Date.parse(t.completedAtUtc) >= Date.parse(t.startedAtUtc),
        )
        previous = Date.parse(t.completedAtUtc)
        const spec = n < initial.length ? initial[n] : specs(b, R)[n]
        check(spec && t.key === spec.key, 'missing_or_wrong_native_witness')
        const req = nativeJson(bytes(t.requestBodyBase64, t.requestBodySha256, 2048)),
          res = nativeJson(bytes(t.responseBodyBase64, t.responseBodySha256))
        exact(req, ['jsonrpc', 'id', 'method', 'params'])
        exact(res, ['jsonrpc', 'id', 'result'])
        check(
          (Number.isSafeInteger(req.id) && req.id >= 0) ||
            (typeof req.id === 'string' && /^[A-Za-z0-9_:.-]{1,64}$/.test(req.id)),
          'native_rpc_id',
        )
        check(
          req.jsonrpc === '2.0' &&
            res.jsonrpc === '2.0' &&
            res.id === req.id &&
            req.method === spec.request.method &&
            canonical(req.params) === canonical(spec.request.params),
          'native_request_join',
        )
        commitments.push({
          controlNamespace: t.controlNamespace,
          physicalId: t.physicalId,
          requestBodySha256: t.requestBodySha256,
          responseBodySha256: t.responseBodySha256,
        })
        if (spec.key === 'chain') {
          check(res.result === '0x1')
          return
        }
        if (spec.key === 'finalized') {
          const f = header(res.result)
          check(
            BigInt(f.blockNumber) >= BigInt(b.source.blockNumber) &&
              Date.parse(f.blockTime) >= Date.parse(b.source.blockTime) &&
              Date.parse(f.blockTime) <= Date.parse(t.completedAtUtc),
          )
          if (f.blockNumber === b.source.blockNumber)
            check(f.blockHash === b.source.blockHash && f.blockTime === b.source.blockTime)
          return
        }
        if (spec.key.startsWith('header_')) {
          check(
            canonical(header(res.result)) ===
              canonical({
                blockNumber: b.source.blockNumber,
                blockHash: b.source.blockHash,
                blockTime: b.source.blockTime,
              }),
            'source_header',
          )
          return
        }
        if (spec.key.startsWith('code_')) {
          check(typeof res.result === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(res.result))
          const address = C[spec.key.slice(5) as keyof typeof C],
            h = keccak256(res.result)
          check(h === context!.runtimeCodeHashes[address], 'runtime_context')
          identities[address] = h
          out[spec.key] = res.result
          return
        }
        const value = decode(spec, res.result)
        out[spec.key] = value
        if (spec.key === 'required_usdc') {
          R = String(value[0])
          check(raw(R) && R !== '0')
        }
      })
      check(
        out.factory_pool.toLowerCase() === C.pool &&
          out.token0.toLowerCase() === C.usdc &&
          out.token1.toLowerCase() === C.usdt &&
          out.pool_factory.toLowerCase() === C.factory &&
          out.pool_fee === 100 &&
          out.usdc_decimals === 6 &&
          out.usdt_decimals === 6,
        'pool_identity_units',
      )
      check(
        BigInt(out.roundtrip_usdt[0]) >= BigInt(b.requestedFinalUsdtRaw),
        'roundtrip_below_requested_USDT',
      )
      check(
        utc(o.acquiredAtUtc) &&
          Date.parse(o.acquiredAtUtc) === previous &&
          utc(o.availableAtUtc) &&
          Date.parse(o.availableAtUtc) >= previous,
        'native_availability',
      )
      return {
        host: o.host,
        out,
        identities,
        R: R!,
        roundtripUsdtRaw: String(out.roundtrip_usdt[0]),
        acquiredAtUtc: o.acquiredAtUtc,
        availableAtUtc: o.availableAtUtc,
        commitments,
      }
    })
    const [a, z] = replayed
    check(canonical(a.out) === canonical(z.out), 'cross_origin_native_drift')
    const acquired = Math.max(...replayed.map((o) => Date.parse(o.acquiredAtUtc))),
      available = Math.max(...replayed.map((o) => Date.parse(o.availableAtUtc)))
    check(
      utc(v.acquiredAtUtc) &&
        Date.parse(v.acquiredAtUtc) === acquired &&
        utc(v.availableAtUtc) &&
        Date.parse(v.availableAtUtc) === available,
      'composite_clock',
    )
    return freeze({
      schema: 'fluid_usdt_structurally_replayed_quote_leg_v1' as const,
      binding: b,
      requiredNetUsdcRaw: a.R,
      roundtripUsdtRaw: a.roundtripUsdtRaw,
      runtimeCodeHashes: a.identities,
      factory: C.factory,
      quoter: C.quoter,
      pool: C.pool,
      poolFee: 100,
      inputAsset: C.usdc,
      inputDecimals: 6,
      outputAsset: C.usdt,
      outputDecimals: 6,
      requestedFinalUsdtRaw: b.requestedFinalUsdtRaw,
      acquiredAtUtc: v.acquiredAtUtc,
      availableAtUtc: v.availableAtUtc,
      origins: replayed.map((o) => ({
        host: o.host,
        acquiredAtUtc: o.acquiredAtUtc,
        availableAtUtc: o.availableAtUtc,
        commitments: o.commitments,
      })),
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      calibrated: false,
      sourceImplementationEquivalence: false,
      combinedBridgeUSDTExecutionRoute: 'unassessed' as const,
      noUSDTCapacityAmountBand: true,
      noLinearScaling: true,
      MRaw: null,
    })
  } catch {
    return null
  }
}
export type FluidUsdtNativeQuoteEvidence = NonNullable<
  ReturnType<typeof decodeFluidUsdtNativeQuoteEvidence>
>
