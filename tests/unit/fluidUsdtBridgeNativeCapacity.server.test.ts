import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import * as firstLegModule from '../../lib/carry/fluidUsdcBridgeNativeCapacity'
import * as abiModule from '../../lib/carry/fluidUsdcBridgeNativeAbi'
import * as profileModule from '../../lib/carry/fluidUsdcBridgeJointTrustedProfile'
import * as quoteModule from '../../lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec'

// Isolated transpiled server + controlled native-control/sink dependencies.
// These are orchestration/private-pointer controls, never genuine acquisition authority.
// Pinned retained runtime BYTES are reused only in controlled fresh-source fixtures.
const requireRoot = createRequire(import.meta.url)
const ts = requireRoot('typescript')
const viem = requireRoot('viem')
const unwrap = (m: any) => ({ ...m.default, ...m })
const first = unwrap(firstLegModule),
  abi = unwrap(abiModule),
  profile = unwrap(profileModule),
  quote = unwrap(quoteModule)
const root = new URL('../../', import.meta.url)
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
function pinned(relative: string, hash: string) {
  const bytes = readFileSync(new URL(relative, root))
  assert.ok(bytes.length <= 8 * 1024 * 1024)
  assert.equal(sha(bytes), hash)
  return JSON.parse(bytes.toString('utf8'))
}
const archived = pinned(
  'data/research/venue-signals/holder-native-original-retention-evidence-2026-10-08/originals/062-current-native-terminal.json',
  'b696d534dcf26fe2ad0780a126809c191636d23614293c1fbd90bfff17b4c217',
)
const oldQuote = pinned(
  'data/research/venue-signals/fluid-usdt-native-conversion-extension-2026-10-09T04-41-15.376Z-c422e99c-0485-4706-90a0-975df770ffee/point-26050748-wire.json',
  '04978577e7107e234ece618a1a9d47e3159bd0ab4122f2ec309a6d7734cc058d',
)
const codes = new Map<string, string>()
for (const row of archived.ledger) {
  if (row.request.method === 'eth_getCode') {
    const env = JSON.parse(Buffer.from(row.rawBodyBase64, 'base64').toString('utf8'))
    codes.set(row.request.params[0], env.result)
  }
}
for (const t of oldQuote[0].traces)
  if (t.request.method === 'eth_getCode') codes.set(t.request.params[0], t.envelope.result)
const SOURCE_TEXT = readFileSync(
  new URL('lib/carry/fluidUsdtBridgeNativeCapacity.server.ts', root),
  'utf8',
)
const compiled = ts.transpileModule(SOURCE_TEXT, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const NOW = Date.parse('2026-10-09T08:00:00.000Z')
const owner = '0x1234567890123456789012345678901234567890'
const binding = () => ({
  owner,
  requestedFinalUsdtRaw: '10145',
  source: {
    chainId: 1 as const,
    blockNumber: 100,
    blockHash: '0x' + '1'.repeat(64),
    blockTime: new Date(NOW - 60000).toISOString(),
    finalized: true as const,
  },
  asOfMs: NOW,
})
function zero(param: any): any {
  if (param.type === 'tuple')
    return Object.fromEntries(param.components.map((p: any) => [p.name, zero(p)]))
  if (param.type === 'bool') return false
  if (param.type === 'address') return '0x' + '0'.repeat(40)
  return 0n
}
function harness(mode = '', onOrigins?: () => void) {
  let clock = NOW,
    closed = false
  const rows: any[] = [],
    stages: string[] = [],
    recordInputs: any[] = [],
    finishInputs: any[] = [],
    settlements: any[] = []
  const events: string[] = [],
    previews: bigint[] = [],
    outputQuestions: bigint[] = [],
    roundtripInputs: bigint[] = []
  const globals = {
    fetch: () => {
      throw Error('test native global must never be called')
    },
  }
  class ControlledDate extends Date {
    static now() {
      return clock
    }
  }
  const C = quote.FLUID_USDT_QUOTE_CONTRACTS,
    B = first.FLUID_USDC_BRIDGE_NATIVE_VAULT,
    BANK = first.FLUID_USDC_BRIDGE_BANK,
    F = first.FLUID_USDC_BRIDGE_FUSDC
  function nativeResult(request: any, second: boolean): any {
    const p = request.params
    if (request.method === 'eth_chainId') return mode === 'chain' && second ? '0x2' : '0x1'
    if (request.method === 'eth_getBlockByNumber')
      return {
        number: p[0] === 'finalized' ? (mode === 'finality' ? '0x63' : '0x65') : '0x64',
        hash:
          mode === 'source' && second && p[0] !== 'finalized'
            ? '0x' + '2'.repeat(64)
            : binding().source.blockHash,
        timestamp:
          '0x' + BigInt((NOW - 60000) / 1000 + (p[0] === 'finalized' ? 1 : 0)).toString(16),
        transactions: Array(381).fill('0x' + '3'.repeat(64)),
      }
    if (request.method === 'eth_getCode') {
      if (mode === 'quote-runtime' && p[0] === C.quoter) return '0x6000'
      if (mode === 'bridge-runtime' && p[0] === B) return '0x6000'
      return codes.get(p[0])
    }
    if (request.method === 'eth_getStorageAt')
      return '0x' + '0'.repeat(24) + first.FLUID_USDC_BRIDGE_IMPLEMENTATION.slice(2)
    const isQuote = [C.factory, C.quoter, C.pool].includes(p[0].to)
    const selectedAbi = isQuote ? quote.FLUID_USDT_QUOTE_ABI : abi.FLUID_USDC_BRIDGE_NATIVE_ABI
    const call = viem.decodeFunctionData({ abi: selectedAbi, data: p[0].data })
    const Q = BigInt(binding().requestedFinalUsdtRaw),
      S = mode === 'zero-shares' ? 0n : 100n
    let result: any
    if (call.functionName === 'getUserSupplyData') {
      result = selectedAbi.find((f: any) => f.name === call.functionName).outputs.map(zero)
      result[0].withdrawableUntilLimit = 3000000n
      result[0].withdrawable = 2500000n
    } else if (call.functionName === 'quoteExactOutputSingle') {
      const q = (call.args[0] as any).amount
      outputQuestions.push(q)
      result = [mode === 'zero-cost' ? 0n : q - 1n, 1n, 0, 1n]
    } else if (call.functionName === 'quoteExactInputSingle') {
      const r = (call.args[0] as any).amountIn
      roundtripInputs.push(r)
      result = [
        mode === 'roundtrip' ? Q - 1n : mode === 'quote-disagreement' && second ? Q + 1n : r + 1n,
        1n,
        0,
        1n,
      ]
    } else if (call.functionName === 'previewRedeem') {
      previews.push(call.args[0])
      result = S === 0n ? 0n : 2000000n
    } else {
      const values: Record<string, unknown> = {
        asset: C.usdc,
        decimals: p[0].to === B ? 18 : mode === 'units' && p[0].to === C.usdt ? 18 : 6,
        balanceOf: p[0].to === B ? S : mode === 'prong-disagreement' && second ? 999n : 5000000n,
        getFUSDC: F,
        getWithdrawalFeeBPS: mode === 'fee' ? 6n : 5n,
        isWithdrawalsPaused: mode === 'paused',
        maxWithdraw: 4000000n,
        getData: [BANK, owner, owner, owner, owner, false, 3500000n, 1n, 1n],
        LIQUIDITY: BANK,
        getPool: mode === 'pool' ? owner : C.pool,
        token0: C.usdc,
        token1: C.usdt,
        fee: 100,
        factory: C.factory,
      }
      result = values[call.functionName]
    }
    return viem.encodeFunctionResult({ abi: selectedAbi, functionName: call.functionName, result })
  }
  const control = {
    settlementReceipts: settlements,
    beginStage(name: string) {
      assert.equal(closed, false)
      stages.push(name)
    },
    async fetcher(url: string, opts: any) {
      assert.equal(closed, false)
      assert.equal(opts.redirect, 'error')
      const request = JSON.parse(opts.body),
        second = url.includes('ankr')
      const host = second ? 'rpc.ankr.com' : 'eth-mainnet.g.alchemy.com'
      const startedAtUtc = new Date(++clock).toISOString()
      let result = nativeResult(request, second)
      const errorMode = (mode === 'native-error' || mode === 'query-echo') && rows.length === 0
      let response = JSON.stringify(
        errorMode
          ? {
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: 3,
                message:
                  mode === 'query-echo' ? '%70rivate-alchemy-key' : 'unexplained native revert',
                data: '0x1234',
              },
            }
          : { jsonrpc: '2.0', id: mode === 'rpc-id' ? request.id + 1 : request.id, result },
      )
      if (mode === 'malformed-escaped' && rows.length === 0)
        response = '{"message":"\\u0070rivate-alchemy-key"'
      const bytes = Buffer.from(response)
      const row = {
        physicalId: rows.length + 1,
        host,
        stage: stages.at(-1),
        request,
        startedAtUtc,
        completedAtUtc: new Date(++clock).toISOString(),
        status: 'success',
        httpStatus: 200,
        bodyBytes: bytes.length,
        bodySha256: sha(bytes),
        rawBodyBase64: bytes.toString('base64'),
        safeCode: null,
        accepted: true,
      }
      rows.push(row)
      const body = {
        schema: 'usd3_hypothetical_physical_settlement_v1',
        physicalId: row.physicalId,
        captureAcceptance: false,
        observation: structuredClone(row),
      }
      settlements.push({ ...body, sha256: sha(JSON.stringify(body)) })
      return new Response(response, {
        status: 200,
        headers: { 'x-usd3-physical-id': String(row.physicalId) },
      })
    },
    async finish() {
      closed = true
      const ledger = structuredClone(rows)
      const commitments = ledger.map((row: any) => ({
        physicalId: row.physicalId,
        rowSha256: sha(JSON.stringify(row)),
      }))
      if (mode === 'raw-hash') ledger[0].bodySha256 = '0'.repeat(64)
      if (mode === 'commitment') commitments[0].rowSha256 = '0'.repeat(64)
      if (mode === 'settlement') settlements[0].sha256 = '0'.repeat(64)
      if (mode === 'late-privacy') {
        const bytes = Buffer.from('{"message":"\\u0070rivate-alchemy-key"}')
        settlements.push({
          observation: {
            rawBodyBase64: bytes.toString('base64'),
            bodyBytes: bytes.length,
            bodySha256: sha(bytes),
          },
          physicalId: 77,
        })
      }
      return {
        startedAtUtc: new Date(NOW).toISOString(),
        availableAtUtc: new Date(clock).toISOString(),
        physicalStarts: ledger.length,
        pendingSettlements: 0,
        failure: null,
        ledger,
        terminalCommitments: commitments,
      }
    },
  }
  const sink = {
    beginHolderNativeHistoryOriginalSeries(input: any) {
      events.push('begin')
      assert.deepEqual(input, { kind: 'fluid_usdt_bridge_current', sharesRaw: null })
      return Object.freeze({})
    },
    recordHolderNativeHistoryOriginalBatch(_handle: any, input: any) {
      events.push('record')
      recordInputs.push(structuredClone(input))
      return { status: 'partial', reason: 'pending_replay' }
    },
    finishHolderNativeHistoryOriginalSeries(_handle: any, input: any) {
      events.push(input.qualification ? 'finish-qualified' : 'finish-rejected')
      finishInputs.push(input)
      clock += mode === 'sink-expiry' ? 1800000 : 10
      return {
        status:
          mode === 'sink-unavailable'
            ? 'unavailable'
            : input.qualification
              ? 'retained'
              : 'partial',
        reason: mode === 'source-drift' ? 'source_changed' : input.reason,
        producerReplayQualification: input.qualification,
        recordedBatches: 1,
        originalAuthority: false,
        authenticated: false,
        executionQualified: false,
        historicalOwnership: false,
      }
    },
  }
  const exports: any = {},
    compiledModule = { exports }
  const actualRequire = (name: string) => {
    if (name === '@/scripts/research/usd3-hypothetical-history-capture.mjs')
      return {
        configuredUsd3HypotheticalOrigins: async () => {
          events.push('origins')
          onOrigins?.()
          return [
            {
              host: 'eth-mainnet.g.alchemy.com',
              url: mode.startsWith('query-')
                ? 'https://eth-mainnet.g.alchemy.com/v2?key=private-alchemy-key'
                : 'https://eth-mainnet.g.alchemy.com/v2/private-alchemy-key',
            },
            {
              host: 'rpc.ankr.com',
              url: mode.startsWith('query-')
                ? 'https://rpc.ankr.com/eth?key=private-ankr-key'
                : 'https://rpc.ankr.com/eth/private-ankr-key',
            },
          ]
        },
        createUsd3HypotheticalCaptureControl: (origins: any, ...options: any[]) => {
          assert.equal(origins.length, 2)
          assert.deepEqual(options, [])
          return control
        },
        parseUsd3HypotheticalJson: JSON.parse,
      }
    if (name === './holderNativeHistoryOriginals.server') return sink
    if (name === './fluidUsdcBridgeNativeCapacity') return first
    if (name === './fluidUsdcBridgeNativeAbi') return abi
    if (name === './fluidUsdcBridgeJointTrustedProfile') return profile
    if (name === './fluidUsdtBridgeNativeQuoteEvidenceCodec') return quote
    return requireRoot(name)
  }
  const wrapper = runInThisContext(
    '(function(require,exports,module,Date,globalThis){' + compiled + '\n})',
  )
  wrapper(actualRequire, exports, compiledModule, ControlledDate, globals)
  return {
    api: compiledModule.exports,
    rows,
    stages,
    events,
    recordInputs,
    finishInputs,
    previews,
    outputQuestions,
    roundtripInputs,
    advance(ms: number) {
      clock += ms
    },
    now: () => clock,
    globals,
  }
}
test('closed 76-start orchestration returns separate native first leg and quote evidence after retention', async () => {
  const h = harness(),
    b = binding(),
    value = await h.api.acquireFluidUsdtBridgeNativeCapacity(b)
  assert.ok(value)
  assert.equal(h.rows.length, 76)
  assert.equal(h.stages.length, 6)
  assert.deepEqual(h.events.slice(0, 2), ['begin', 'origins'])
  assert.deepEqual(h.events.slice(-2), ['record', 'finish-qualified'])
  assert.deepEqual(h.previews, [100n, 100n])
  assert.deepEqual(h.outputQuestions, [10145n, 10145n])
  assert.deepEqual(h.roundtripInputs, [10144n, 10144n])
  assert.equal(value.fact.sharesRaw, '100')
  assert.equal(value.fact.fullNetEaRaw, '2000000')
  assert.equal(value.fact.requiredNetUsdcRaw, '10144')
  assert.equal(value.fact.MRaw, null)
  assert.equal(Object.keys(value.fact.runtimeCodeHashes).length, 10)
  assert.equal(value.quoteWire.origins[0].traces.length, 18)
  assert.ok(
    value.underlyingOriginFacts.every(
      (f: any) => Date.parse(f.readAtUtc) < Date.parse(value.fact.acquiredAtUtc),
    ),
  )
  assert.equal(value.fact.readAtUtc, value.fact.acquiredAtUtc)
  assert.ok(Date.parse(value.fact.availableAtUtc) > Date.parse(value.fact.acquiredAtUtc))
  assert.equal(value.fact.executionQualified, false)
  assert.equal(value.fact.authenticated, false)
  assert.equal(value.fact.originalAuthority, false)
  assert.equal(value.fact.combinedBridgeUSDTExecutionRoute, 'unassessed')
  assert.ok(Object.isFrozen(value.fact.nativeProngs))
  assert.equal(
    h.api.selectedOriginalFluidUsdtBridgeNativeCapacity(value, { ...b, asOfMs: h.now() }),
    value.fact,
  )
})
test('genuine private pointer selects; cloning, serialization and forged wrappers never select', async () => {
  const h = harness(),
    b = binding(),
    value = await h.api.acquireFluidUsdtBridgeNativeCapacity(b)
  assert.ok(value)
  const q = { ...b, asOfMs: h.now() }
  for (const forged of [
    structuredClone(value),
    JSON.parse(JSON.stringify(value)),
    { ...value },
    { fact: value.fact },
  ])
    assert.equal(h.api.selectedOriginalFluidUsdtBridgeNativeCapacity(forged, q), null)
  assert.equal(h.api.selectedOriginalFluidUsdtBridgeNativeCapacity(value, q), value.fact)
})
test('owner, Q, source hash/time/number and extra route/unit claims cannot rebind an original', async () => {
  const h = harness(),
    b = binding(),
    value = await h.api.acquireFluidUsdtBridgeNativeCapacity(b)
  assert.ok(value)
  const q = { ...b, asOfMs: h.now() }
  for (const altered of [
    { ...q, owner: '0x' + '2'.repeat(40) },
    { ...q, requestedFinalUsdtRaw: '2' },
    { ...q, source: { ...q.source, blockHash: '0x' + '2'.repeat(64) } },
    { ...q, source: { ...q.source, blockTime: new Date(NOW - 59000).toISOString() } },
    { ...q, source: { ...q.source, blockNumber: 101 } },
    { ...q, routeKey: 'USDC' },
    { ...q, outputDecimals: 18 },
  ])
    assert.equal(h.api.selectedOriginalFluidUsdtBridgeNativeCapacity(value, altered), null)
})
test('caller mutation during first await is isolated; no accessor is evaluated', async () => {
  const b = binding(),
    h = harness('', () => {
      b.owner = '0x' + '2'.repeat(40)
      b.requestedFinalUsdtRaw = '5'
      b.source.blockHash = '0x' + '2'.repeat(64)
    })
  const value = await h.api.acquireFluidUsdtBridgeNativeCapacity(b)
  assert.ok(value)
  assert.equal(value.fact.owner, owner)
  assert.equal(value.fact.requestedFinalUsdtRaw, '10145')
  const bad: any = binding()
  let touched = false
  Object.defineProperty(bad, 'owner', {
    enumerable: true,
    get() {
      touched = true
      return owner
    },
  })
  assert.equal(await h.api.acquireFluidUsdtBridgeNativeCapacity(bad), null)
  assert.equal(touched, false)
})
test('only advancing real knowledge clock selects; stale, future and pre-retention clocks reject', async () => {
  const h = harness(),
    b = binding(),
    value = await h.api.acquireFluidUsdtBridgeNativeCapacity(b)
  assert.ok(value)
  assert.equal(h.api.selectedOriginalFluidUsdtBridgeNativeCapacity(value, b), null)
  assert.equal(
    h.api.selectedOriginalFluidUsdtBridgeNativeCapacity(value, { ...b, asOfMs: h.now() + 1 }),
    null,
  )
  h.advance(1800000)
  assert.equal(
    h.api.selectedOriginalFluidUsdtBridgeNativeCapacity(value, { ...b, asOfMs: h.now() }),
    null,
  )
})
test('invalid binding primitives, unfinalized source and caller options cause zero acquisition', async () => {
  for (const bad of [
    { ...binding(), requestedFinalUsdtRaw: '0' },
    { ...binding(), requestedFinalUsdtRaw: String(1n << 256n) },
    { ...binding(), owner: '0x' + '0'.repeat(40) },
    { ...binding(), asOfMs: 1.5 },
    { ...binding(), source: { ...binding().source, finalized: false } },
    { ...binding(), source: { ...binding().source, blockNumber: Number.MAX_SAFE_INTEGER + 1 } },
    {
      ...binding(),
      source: { ...binding().source, blockTime: new Date(NOW + 1000).toISOString() },
    },
    { ...binding(), profile: {} },
    { ...binding(), fetcher: () => null },
  ]) {
    const h = harness()
    assert.equal(await h.api.acquireFluidUsdtBridgeNativeCapacity(bad), null)
    assert.equal(h.rows.length, 0)
    assert.equal(h.events.length, 0)
  }
})
test('busy gate prevents overlapping native captures', async () => {
  const h = harness(),
    firstRead = h.api.acquireFluidUsdtBridgeNativeCapacity(binding())
  assert.equal(await h.api.acquireFluidUsdtBridgeNativeCapacity(binding()), null)
  assert.ok(await firstRead)
  assert.equal(h.rows.length, 76)
})
test('native zero shares/Ea are retained honestly and never fabricated positive', async () => {
  const h = harness('zero-shares'),
    value = await h.api.acquireFluidUsdtBridgeNativeCapacity(binding())
  assert.ok(value)
  assert.equal(value.fact.sharesRaw, '0')
  assert.equal(value.fact.fullNetEaRaw, '0')
  assert.deepEqual(h.previews, [0n, 0n])
})
test('native pause is retained as a gate; quotes do not establish executable combined route', async () => {
  const h = harness('paused'),
    value = await h.api.acquireFluidUsdtBridgeNativeCapacity(binding())
  assert.ok(value)
  assert.equal(value.fact.paused, true)
  assert.equal(value.fact.executionQualified, false)
})
for (const mode of [
  'chain',
  'finality',
  'source',
  'quote-runtime',
  'bridge-runtime',
  'fee',
  'units',
  'pool',
  'zero-cost',
  'roundtrip',
  'quote-disagreement',
  'prong-disagreement',
  'rpc-id',
  'raw-hash',
  'commitment',
  'settlement',
  'source-drift',
  'sink-unavailable',
  'sink-expiry',
]) {
  test('rejects ' + mode + ' without registering a native original', async () => {
    const h = harness(mode),
      value = await h.api.acquireFluidUsdtBridgeNativeCapacity(binding())
    assert.equal(value, null)
    assert.equal(
      h.api.selectedOriginalFluidUsdtBridgeNativeCapacity(
        { fact: {} },
        { ...binding(), asOfMs: h.now() },
      ),
      null,
    )
    assert.equal(h.api.getLastFluidUsdtBridgeNativeCapacityDiagnostic().qualified, false)
  })
}
test('safe native error retains partial originals unqualified', async () => {
  const h = harness('native-error')
  assert.equal(await h.api.acquireFluidUsdtBridgeNativeCapacity(binding()), null)
  assert.equal(h.recordInputs.length, 1)
  assert.equal(h.recordInputs[0].capturedAccepted, false)
  assert.equal(h.finishInputs.at(-1).qualification, false)
})
for (const mode of ['late-privacy', 'malformed-escaped'])
  test('unsafe ' + mode + ' never writes native originals', async () => {
    const h = harness(mode)
    assert.equal(await h.api.acquireFluidUsdtBridgeNativeCapacity(binding()), null)
    assert.equal(h.recordInputs.length, 0)
    assert.equal(h.finishInputs.at(-1).qualification, false)
    assert.equal(h.finishInputs.at(-1).reason, 'invalid_input')
  })
test('same S/native Ea remain unchanged under a new independently quoted Q', async () => {
  const h = harness(),
    b = binding()
  b.requestedFinalUsdtRaw = '20000'
  const value = await h.api.acquireFluidUsdtBridgeNativeCapacity(b)
  assert.ok(value)
  assert.equal(value.fact.sharesRaw, '100')
  assert.equal(value.fact.fullNetEaRaw, '2000000')
  assert.deepEqual(h.previews, [100n, 100n])
  assert.deepEqual(h.outputQuestions, [20000n, 20000n])
  assert.deepEqual(h.roundtripInputs, [19999n, 19999n])
  assert.equal(value.fact.requiredNetUsdcRaw, '19999')
})
test('query parameter names are routing syntax; ordinary key metadata does not reject acquisition', async () => {
  const h = harness('query-origin'),
    value = await h.api.acquireFluidUsdtBridgeNativeCapacity(binding())
  assert.ok(value)
  assert.equal(h.recordInputs.length, 1)
  assert.equal(h.rows.length, 76)
})
test('percent-escaped query credential value echo is rejected before native retention', async () => {
  const h = harness('query-echo')
  assert.equal(await h.api.acquireFluidUsdtBridgeNativeCapacity(binding()), null)
  assert.equal(h.recordInputs.length, 0)
  assert.equal(h.finishInputs.at(-1).reason, 'invalid_input')
})
