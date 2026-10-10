import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodeFunctionResult, keccak256 } from 'viem'
import {
  FLUID_USDT_QUOTE_ABI as ABI,
  FLUID_USDT_QUOTE_CONTRACTS as C,
  FLUID_USDT_QUOTE_ROUTE as ROUTE,
  FLUID_USDT_QUOTE_DESTINATION as DEST,
  FLUID_USDT_QUOTE_HOSTS as HOSTS,
  fluidUsdtNativeQuoteReadPlan as plan,
  createFluidUsdtNativeQuoteContext as context,
  decodeFluidUsdtNativeQuoteEvidence as decode,
  parseFluidUsdtNativeQuoteJson as parse,
  parseFluidUsdtNativeQuoteRpcBody as parseRpc,
} from '../../lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec'

const BASE = Date.parse('2026-10-09T06:00:00.000Z'),
  iso = (n: number) => new Date(n).toISOString()
const code = '0x6000600055'
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const body = (v: any) => Buffer.from(JSON.stringify(v))
function seal(t: any, kind: 'request' | 'response', v: any) {
  const b = body(v)
  t[kind + 'BodyBase64'] = b.toString('base64')
  t[kind + 'BodySha256'] = sha(b)
}
function change(t: any, kind: 'request' | 'response', fn: (v: any) => void) {
  const v = JSON.parse(Buffer.from(t[kind + 'BodyBase64'], 'base64').toString('utf8'))
  fn(v)
  seal(t, kind, v)
}
function fixture(Q = '10145', R = '10144', output = Q): { wire: any; context: any } {
  // Controlled raw fixtures establish structural consistency only, never native-original acquisition.
  const b = {
    routeKey: ROUTE,
    destination: DEST,
    inputAsset: C.usdc,
    inputDecimals: 6,
    outputAsset: C.usdt,
    outputDecimals: 6,
    requestedFinalUsdtRaw: Q,
    source: {
      chainId: 1,
      blockNumber: '100',
      blockHash: '0x' + '1'.repeat(64),
      blockTime: iso(BASE),
      finalized: true,
    },
  }
  const specs = plan(b, R)!
  assert.equal(specs.length, 18)
  const ctx = context({
    schema: 'fluid_usdt_quote_context_v1',
    runtimeCodeHashes: Object.fromEntries(Object.values(C).map((a) => [a, keccak256(code)])),
    sourceImplementationEquivalence: false,
    originalAuthority: false,
  })!
  const origins = HOSTS.map((host, j) => {
    const traces = specs.map((s, n) => {
      const physicalId = n * 2 + j + 1,
        startedAtUtc = iso(BASE + 2000 + n * 100 + j * 25),
        completedAtUtc = iso(BASE + 2050 + n * 100 + j * 25)
      let result: any
      if (s.key === 'chain') result = '0x1'
      else if (s.key === 'finalized')
        result = {
          number: '0x65',
          hash: '0x' + '2'.repeat(64),
          timestamp: '0x' + BigInt(BASE / 1000 + 1).toString(16),
        }
      else if (s.key.startsWith('header_'))
        result = {
          number: '0x64',
          hash: b.source.blockHash,
          timestamp: '0x' + BigInt(BASE / 1000).toString(16),
        }
      else if (s.key.startsWith('code_')) result = code
      else {
        const values: any = {
          factory_pool: C.pool,
          token0: C.usdc,
          token1: C.usdt,
          pool_fee: 100,
          pool_factory: C.factory,
          usdc_decimals: 6,
          usdt_decimals: 6,
          required_usdc: [BigInt(R), 1n, 0, 1n],
          roundtrip_usdt: [BigInt(output), 1n, 0, 1n],
        }
        result = encodeFunctionResult({
          abi: ABI,
          functionName: s.name!,
          result: values[s.key],
        } as never)
      }
      const t: any = {
        key: s.key,
        controlNamespace: 'controlled_original_namespace',
        physicalId,
        startedAtUtc,
        completedAtUtc,
      }
      seal(t, 'request', { jsonrpc: '2.0', id: physicalId, ...s.request })
      seal(t, 'response', { jsonrpc: '2.0', id: physicalId, result })
      return t
    })
    return {
      host,
      traces,
      acquiredAtUtc: traces.at(-1)!.completedAtUtc,
      availableAtUtc: iso(BASE + 5000 + j * 100),
    }
  })
  return {
    wire: {
      schema: 'fluid_usdt_native_quote_evidence_v1',
      binding: b,
      origins,
      acquiredAtUtc: origins[1].acquiredAtUtc,
      availableAtUtc: origins[1].availableAtUtc,
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      calibrated: false,
    },
    context: ctx,
  }
}
const trace = (w: any, key: string, origin = 0) =>
  w.origins[origin].traces.find((t: any) => t.key === key)
const positive = () => {
  const f = fixture()
  const v = decode(f.wire, f.context)
  assert.ok(v)
  return v
}

test('paired raw quotes reconstruct R and roundtrip, retain true composite clocks and false authority', () => {
  const r = positive()
  assert.equal(r.requiredNetUsdcRaw, '10144')
  assert.equal(r.roundtripUsdtRaw, '10145')
  assert.equal(r.availableAtUtc, iso(BASE + 5100))
  assert.equal(r.acquiredAtUtc, iso(BASE + 3775))
  assert.equal(r.originalAuthority, false)
  assert.equal(r.authenticated, false)
  assert.equal(r.executionQualified, false)
  assert.equal(r.calibrated, false)
  assert.equal(r.MRaw, null)
  assert.equal(r.combinedBridgeUSDTExecutionRoute, 'unassessed')
})
test('read plan is staged; no roundtrip input is implicitly guessed', () => {
  const { wire } = fixture()
  const first = plan(wire.binding)!
  assert.equal(first.length, 16)
  assert.equal(first.at(-1)!.key, 'required_usdc')
  assert.equal(
    first.some((s) => s.key === 'roundtrip_usdt'),
    false,
  )
  assert.equal(plan(wire.binding, '0'), null)
  assert.equal(plan(wire.binding, '01'), null)
})
test('native exact-input roundtrip below Q rejects rather than claiming output sufficiency', () => {
  const f = fixture('10145', '10144', '10144')
  assert.equal(decode(f.wire, f.context), null)
})
test('roundtrip calldata R must equal the independently decoded exact-output amount', () => {
  const f = fixture()
  const wrong = plan(f.wire.binding, '10143')!.find((s) => s.key === 'roundtrip_usdt')!
  for (let o = 0; o < 2; o++)
    change(trace(f.wire, 'roundtrip_usdt', o), 'request', (v) => {
      v.params = wrong.request.params
    })
  assert.equal(decode(f.wire, f.context), null)
})
test('changed Q cannot reuse unchanged native requests', () => {
  const f = fixture()
  f.wire.binding.requestedFinalUsdtRaw = '20000'
  assert.equal(decode(f.wire, f.context), null)
})
test('Q stays final USDT6 with no full-S, entitlement or capacity amount invented', () => {
  const r = positive()
  assert.equal(r.requestedFinalUsdtRaw, '10145')
  assert.equal(r.outputAsset, C.usdt)
  assert.equal(r.inputAsset, C.usdc)
  for (const k of ['sharesRaw', 'fullEaRaw', 'capacityUsdtRaw', 'amountBand', 'feeAdjustedEaRaw'])
    assert.equal(Object.hasOwn(r, k), false)
  assert.equal(r.noLinearScaling, true)
  assert.equal(r.noUSDTCapacityAmountBand, true)
})
test('wrong source hash, canonical bracket or finalized identity rejects', () => {
  for (const key of ['header_before', 'header_after', 'finalized']) {
    const f = fixture()
    change(trace(f.wire, key), 'response', (v) => {
      v.result.hash = '0x' + '3'.repeat(64)
      v.result.number = '0x64'
    })
    assert.equal(decode(f.wire, f.context), null)
  }
  const f = fixture()
  f.wire.binding.source.blockHash = '0x' + '4'.repeat(64)
  assert.equal(decode(f.wire, f.context), null)
})
test('wrong source timestamp, chain or future finalized block time rejects', () => {
  const f = fixture()
  change(trace(f.wire, 'header_before'), 'response', (v) => {
    v.result.timestamp = '0x1'
  })
  assert.equal(decode(f.wire, f.context), null)
  const c = fixture()
  change(trace(c.wire, 'chain'), 'response', (v) => {
    v.result = '0x2'
  })
  assert.equal(decode(c.wire, c.context), null)
  const x = fixture()
  change(trace(x.wire, 'finalized'), 'response', (v) => {
    v.result.timestamp = '0x' + BigInt(BASE / 1000 + 100).toString(16)
  })
  assert.equal(decode(x.wire, x.context), null)
})
test('both configured original host claims are mandatory and ordered', () => {
  for (const hosts of [
    [HOSTS[0], HOSTS[0]],
    [HOSTS[1], HOSTS[0]],
    ['example.com', HOSTS[1]],
  ]) {
    const f = fixture()
    hosts.forEach((h, n) => (f.wire.origins[n].host = h))
    assert.equal(decode(f.wire, f.context), null)
  }
})
test('token ordering, pool factory, fee and native decimals each fail closed', () => {
  for (const [key, name, value] of [
    ['token0', 'token0', C.usdt],
    ['token1', 'token1', C.usdc],
    ['factory_pool', 'getPool', DEST],
    ['pool_factory', 'factory', DEST],
    ['pool_fee', 'fee', 500],
    ['usdt_decimals', 'decimals', 18],
    ['usdc_decimals', 'decimals', 18],
  ] as const) {
    const f = fixture()
    change(trace(f.wire, key), 'response', (v) => {
      v.result = encodeFunctionResult({ abi: ABI, functionName: name, result: value } as never)
    })
    assert.equal(decode(f.wire, f.context), null)
  }
})
test('five runtime identities must match the separate unsigned context and paired native bytes', () => {
  const f = fixture()
  change(trace(f.wire, 'code_usdt'), 'response', (v) => {
    v.result = '0x6001'
  })
  assert.equal(decode(f.wire, f.context), null)
  const x = fixture()
  const bad = structuredClone(x.context)
  bad.runtimeCodeHashes[C.usdt] = '0x' + '3'.repeat(64)
  assert.equal(decode(x.wire, bad), null)
  delete bad.runtimeCodeHashes[C.pool]
  assert.equal(context(bad), null)
  assert.ok(Object.isFrozen(x.context.runtimeCodeHashes))
  assert.equal(x.context.originalAuthority, false)
})
test('request bytes must retain exact EIP1898 and native method', () => {
  for (const mutate of [
    (v: any) => {
      v.params[1].requireCanonical = false
    },
    (v: any) => {
      v.params[1] = 'latest'
    },
    (v: any) => {
      v.method = 'eth_getCode'
    },
  ]) {
    const f = fixture()
    change(trace(f.wire, 'required_usdc'), 'request', mutate)
    assert.equal(decode(f.wire, f.context), null)
  }
})
test('native ABI trailing bytes, narrowed-width overflow and empty code reject', () => {
  const f = fixture()
  change(trace(f.wire, 'required_usdc'), 'response', (v) => {
    v.result += '00'
  })
  assert.equal(decode(f.wire, f.context), null)
  const x = fixture()
  change(trace(x.wire, 'pool_fee'), 'response', (v) => {
    v.result = '0x' + 'f'.repeat(64)
  })
  assert.equal(decode(x.wire, x.context), null)
  const e = fixture()
  change(trace(e.wire, 'code_factory'), 'response', (v) => {
    v.result = '0x'
  })
  assert.equal(decode(e.wire, e.context), null)
})
test('RPC errors, censored result and mismatched response id never fabricate zero R', () => {
  const f = fixture()
  change(trace(f.wire, 'required_usdc'), 'response', (v) => {
    delete v.result
    v.error = { code: 3, message: 'native_error' }
  })
  assert.equal(decode(f.wire, f.context), null)
  const c = fixture()
  change(trace(c.wire, 'required_usdc'), 'response', (v) => {
    v.result = null
  })
  assert.equal(decode(c.wire, c.context), null)
  const x = fixture()
  change(trace(x.wire, 'chain'), 'response', (v) => {
    v.id++
  })
  assert.equal(decode(x.wire, x.context), null)
  const z = fixture()
  change(trace(z.wire, 'required_usdc'), 'response', (v) => {
    v.result = encodeFunctionResult({
      abi: ABI,
      functionName: 'quoteExactOutputSingle',
      result: [0n, 1n, 0, 1n],
    })
  })
  assert.equal(decode(z.wire, z.context), null)
})
test('cross-origin canonical result disagreement rejects', () => {
  const f = fixture()
  change(trace(f.wire, 'roundtrip_usdt', 1), 'response', (v) => {
    v.result = encodeFunctionResult({
      abi: ABI,
      functionName: 'quoteExactInputSingle',
      result: [10146n, 1n, 0, 1n],
    })
  })
  assert.equal(decode(f.wire, f.context), null)
})
test('raw request/response commitments authenticate only bytes, not acquisition authority', () => {
  const f = fixture()
  trace(f.wire, 'required_usdc').requestBodySha256 = '0'.repeat(64)
  assert.equal(decode(f.wire, f.context), null)
  const r = fixture()
  trace(r.wire, 'roundtrip_usdt').responseBodySha256 = 'f'.repeat(64)
  assert.equal(decode(r.wire, r.context), null)
  const s = fixture()
  assert.ok(decode(JSON.stringify(s.wire), s.context))
  assert.equal(decode(JSON.stringify(s.wire), s.context)!.authenticated, false)
})
test('duplicate keys inside raw RPC body and transport text reject before decoding', () => {
  const f = fixture(),
    t = trace(f.wire, 'chain'),
    v = Buffer.from('{"jsonrpc":"2.0","id":1,"id":1,"result":"0x1"}')
  t.responseBodyBase64 = v.toString('base64')
  t.responseBodySha256 = sha(v)
  assert.equal(decode(f.wire, f.context), null)
  const x = fixture()
  const text = JSON.stringify(x.wire).replace('"schema":', '"schema":"duplicate","schema":')
  assert.equal(decode(text, x.context), null)
  assert.throws(() => parse('{"x":1,"x":2}'))
})
test('malformed UTF8, noncanonical base64 and response byte overflow reject', () => {
  const f = fixture(),
    t = trace(f.wire, 'chain'),
    v = Buffer.from([255])
  t.responseBodyBase64 = v.toString('base64')
  t.responseBodySha256 = sha(v)
  assert.equal(decode(f.wire, f.context), null)
  const x = fixture()
  trace(x.wire, 'chain').requestBodyBase64 += '\n'
  assert.equal(decode(x.wire, x.context), null)
  const y = fixture(),
    b = Buffer.alloc(65537, 32)
  trace(y.wire, 'chain').responseBodyBase64 = b.toString('base64')
  trace(y.wire, 'chain').responseBodySha256 = sha(b)
  assert.equal(decode(y.wire, y.context), null)
})
test('missing roundtrip witness, duplicate physical ids or reordered traces reject', () => {
  const f = fixture()
  f.wire.origins[0].traces.splice(16, 1)
  assert.equal(decode(f.wire, f.context), null)
  const x = fixture()
  x.wire.origins[1].traces[0].physicalId = 1
  assert.equal(decode(x.wire, x.context), null)
  const z = fixture()
  ;[z.wire.origins[0].traces[8], z.wire.origins[0].traces[9]] = [
    z.wire.origins[0].traces[9],
    z.wire.origins[0].traces[8],
  ]
  assert.equal(decode(z.wire, z.context), null)
})
test('source, native completion, origin availability and composite clocks cannot be backdated', () => {
  for (const mutate of [
    (v: any) => {
      v.origins[0].traces[0].startedAtUtc = iso(BASE - 1)
    },
    (v: any) => {
      v.origins[0].traces[1].completedAtUtc = iso(BASE)
    },
    (v: any) => {
      v.origins[0].acquiredAtUtc = iso(BASE + 1)
    },
    (v: any) => {
      v.origins[0].availableAtUtc = iso(BASE + 1)
    },
    (v: any) => {
      v.acquiredAtUtc = iso(BASE + 1)
    },
    (v: any) => {
      v.availableAtUtc = iso(BASE + 1)
    },
  ]) {
    const f = fixture()
    mutate(f.wire)
    assert.equal(decode(f.wire, f.context), null)
  }
})
test('later retention availability must be included in the maximum, not made into native read time', () => {
  const f = fixture()
  f.wire.origins[0].availableAtUtc = iso(BASE + 10000)
  assert.equal(decode(f.wire, f.context), null)
  f.wire.availableAtUtc = iso(BASE + 10000)
  const r = decode(f.wire, f.context)!
  assert.ok(r)
  assert.equal(r.availableAtUtc, iso(BASE + 10000))
  assert.equal(r.acquiredAtUtc, iso(BASE + 3775))
})
test('positive canonical uint256 Q/R and exact route/unit shapes are mandatory', () => {
  for (const q of ['0', '01', '-1', String(1n << 256n)]) {
    const f = fixture()
    f.wire.binding.requestedFinalUsdtRaw = q
    assert.equal(decode(f.wire, f.context), null)
  }
  const f = fixture()
  f.wire.binding.outputDecimals = 18
  assert.equal(decode(f.wire, f.context), null)
  const x = fixture()
  x.wire.binding.destination = C.pool
  assert.equal(decode(x.wire, x.context), null)
  assert.ok(
    decode(fixture(String((1n << 256n) - 1n), String((1n << 256n) - 1n)).wire, fixture().context),
  )
})
test('accessors, cycles, sparse arrays, giant keys and arbitrary extra flags reject safely', () => {
  let calls = 0
  const f = fixture()
  Object.defineProperty(f.wire, 'binding', {
    enumerable: true,
    get() {
      calls++
      return null
    },
  })
  assert.equal(decode(f.wire, f.context), null)
  assert.equal(calls, 0)
  const x = fixture()
  x.wire.extra = x.wire
  assert.equal(decode(x.wire, x.context), null)
  const s = fixture()
  delete s.wire.origins[0].traces[0]
  assert.equal(decode(s.wire, s.context), null)
  const b = fixture()
  b.wire['x'.repeat(300000)] = 1
  assert.equal(decode(b.wire, b.context), null)
  const a = fixture()
  a.wire.originalAuthority = true
  assert.equal(decode(a.wire, a.context), null)
})
test('cloned and serialized consistent facts remain unsigned; output isolates caller mutation', () => {
  const f = fixture(),
    r = decode(f.wire, f.context)!
  assert.ok(r)
  f.wire.binding.requestedFinalUsdtRaw = '20000'
  assert.equal(r.requestedFinalUsdtRaw, '10145')
  assert.ok(Object.isFrozen(r.binding.source))
  assert.equal(r.originalAuthority, false)
  assert.equal(r.sourceImplementationEquivalence, false)
})
test('actual saved eighteen-call conversion prefix lacks exactInput(R) and cannot qualify', () => {
  const path = resolve(
    'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26050748-wire.json',
  )
  const actual = readFileSync(path)
  assert.equal(sha(actual), '04978577e7107e234ece618a1a9d47e3159bd0ab4122f2ec309a6d7734cc058d')
  const saved = JSON.parse(actual.toString('utf8'))
  assert.equal(saved.length, 2)
  assert.equal(saved[0].traces.length, 18)
  assert.ok(saved[0].traces.some((t: any) => t.key === 'required_usdc_for_research_q'))
  assert.equal(
    saved[0].traces.some((t: any) => t.key === 'roundtrip_usdt'),
    false,
  )
  assert.equal(decode(saved, fixture().context), null)
})

test('actual saved physical/RPC ids differ; bounded RPC id is separate from physical provenance', () => {
  const dir = resolve(
    'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee',
  )
  const old = JSON.parse(readFileSync(resolve(dir, 'batch-0-original-receipt.json'), 'utf8'))
  const row = old.ledger.find((r: any) => r.request.id !== r.physicalId)
  assert.ok(row)
  assert.notEqual(row.request.id, row.physicalId)
  const f = fixture()
  for (const id of [row.request.id, 0, 'original_native_rpc_id']) {
    const x = structuredClone(f)
    for (const origin of x.wire.origins)
      for (const t of origin.traces) {
        change(t, 'request', (v) => {
          v.id = id
        })
        change(t, 'response', (v) => {
          v.id = id
        })
      }
    assert.ok(decode(x.wire, x.context))
  }
})
test('physical uniqueness is controller-local and never a fabricated global admission cap', () => {
  const f = fixture()
  for (const t of f.wire.origins[1].traces) {
    t.controlNamespace = 'another_original_controller'
    t.physicalId += 1000
  }
  assert.ok(decode(f.wire, f.context))
  f.wire.origins[1].traces[1].physicalId = f.wire.origins[1].traces[0].physicalId
  assert.equal(decode(f.wire, f.context), null)
  const x = fixture()
  trace(x.wire, 'roundtrip_usdt').controlNamespace = 'different_retained_original'
  assert.ok(decode(x.wire, x.context))
})
test('invalid RPC id or namespace rejects without changing original request bytes', () => {
  for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', 'x'.repeat(65), null]) {
    const f = fixture()
    change(trace(f.wire, 'chain'), 'request', (v) => {
      v.id = id
    })
    change(trace(f.wire, 'chain'), 'response', (v) => {
      v.id = id
    })
    assert.equal(decode(f.wire, f.context), null)
  }
  const f = fixture()
  trace(f.wire, 'chain').controlNamespace = 'https://provider/key'
  assert.equal(decode(f.wire, f.context), null)
})

test('actual retained 342/381-transaction raw headers parse without projecting or rewriting bytes', () => {
  const dir = resolve(
    'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee',
  )
  for (const [block, count, batch] of [
    ['26050748', 342, 0],
    ['26100913', 381, 2],
  ] as const) {
    const old = JSON.parse(readFileSync(resolve(dir, 'point-' + block + '-wire.json'), 'utf8'))
    const headerTrace = old[0].traces.find((t: any) => t.key === 'header_before'),
      header = headerTrace.envelope.result
    assert.equal(header.transactions.length, count)
    const original = JSON.parse(
      readFileSync(resolve(dir, 'batch-' + batch + '-original-receipt.json'), 'utf8'),
    )
    const row = original.ledger.find((r: any) => r.bodySha256 === headerTrace.responseBodySha256)
    assert.ok(row)
    assert.ok(Buffer.from(row.rawBodyBase64, 'base64').length <= 65536)
    const parsed: any = parseRpc(row.rawBodyBase64, row.bodySha256)
    assert.deepEqual(parsed.result, header)
    assert.equal(decode(old, fixture().context), null)
  }
})
test('large realistic five-code and raw-header transport is admitted without changing body bounds', () => {
  const f = fixture(),
    codeBody = '0x' + '60'.repeat(20000),
    ctx: any = structuredClone(f.context)
  for (const a of Object.values(C)) ctx.runtimeCodeHashes[a] = keccak256(codeBody as `0x${string}`)
  for (const origin of f.wire.origins)
    for (const t of origin.traces) {
      if (t.key.startsWith('code_'))
        change(t, 'response', (v) => {
          v.result = codeBody
        })
      if (t.key.startsWith('header_') || t.key === 'finalized')
        change(t, 'response', (v) => {
          v.result.transactions = Array.from({ length: 381 }, () => '0x' + '3'.repeat(64))
        })
    }
  assert.ok(JSON.stringify(f.wire).length * 2 > 1048576)
  assert.ok(decode(JSON.stringify(f.wire), ctx))
  assert.equal(decode(f.wire, ctx)!.originalAuthority, false)
})
test('fixed native request bytes and oversized raw hash arrays remain bounded', () => {
  const f = fixture(),
    t = trace(f.wire, 'chain'),
    request = JSON.parse(Buffer.from(t.requestBodyBase64, 'base64').toString('utf8'))
  const b = Buffer.from(' '.repeat(2048) + JSON.stringify(request))
  t.requestBodyBase64 = b.toString('base64')
  t.requestBodySha256 = sha(b)
  assert.equal(decode(f.wire, f.context), null)
  assert.throws(() =>
    parseRpc(
      body(Array.from({ length: 2049 }, () => 1)).toString('base64'),
      sha(body(Array.from({ length: 2049 }, () => 1))),
    ),
  )
})

test('actual worst-observed paired runtime/header prefix exceeds old budget but raw parsing succeeds', () => {
  const dir = resolve(
    'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee',
  )
  const point = JSON.parse(readFileSync(resolve(dir, 'point-26100913-wire.json'), 'utf8'))
  const receipt = JSON.parse(readFileSync(resolve(dir, 'batch-2-original-receipt.json'), 'utf8'))
  let bytes = 0,
    count = 0
  for (const origin of point)
    for (const t of origin.traces) {
      if (!t.key.startsWith('code_') && !t.key.startsWith('header_')) continue
      const row = receipt.ledger.find((r: any) => r.bodySha256 === t.responseBodySha256)
      assert.ok(row)
      bytes += row.rawBodyBase64.length * 2
      count++
      assert.ok(parseRpc(row.rawBodyBase64, row.bodySha256))
    }
  assert.equal(count, 14)
  assert.equal(bytes, 1049344)
  assert.equal(decode(point, fixture().context), null)
})
