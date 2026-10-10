import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import * as quoteModule from '../../lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec'
import * as abiModule from '../../lib/carry/fluidUsdcBridgeNativeAbi'
import * as composedModule from '../../lib/carry/fluidUsdtBridgeJointComposedHistoricalEvidenceCodec'
import * as profileModule from '../../lib/carry/fluidUsdcBridgeJointTrustedProfile'

// Controlled transpiled orchestration: substituted factory/controller/current capability/sink/codec/files.
// No actual acquisition authority, private research-data writes, providers, or native network in these tests.
// The actual composed codec and original raw-body gates are independently tested in its own suite.
const requireRoot = createRequire(import.meta.url),
  ts = requireRoot('typescript'),
  viem = requireRoot('viem')
const unwrap = (m: any) => ({ ...m.default, ...m }),
  quote = unwrap(quoteModule),
  abi = unwrap(abiModule),
  composed = unwrap(composedModule),
  profileApi = unwrap(profileModule)
const pinnedOriginalBytes = new Map<string, Buffer>()
function pinnedBytes(path: string) {
  let bytes = pinnedOriginalBytes.get(path)
  if (!bytes) {
    bytes = readFileSync(path)
    pinnedOriginalBytes.set(path, bytes)
  }
  return bytes
}
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const NOW = Date.parse('2026-10-09T12:00:00.000Z'),
  B = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const sourcePath = new URL(
  '../../lib/carry/fluidUsdtBridgeJointHistoricalEvidence.server.ts',
  import.meta.url,
)
const source = readFileSync(sourcePath, 'utf8')
function harness(mode = '') {
  const useRealCodec = mode === 'real-codec' || mode === 'real-codec-retimed-batches'
  const replayObservations: any[] = []
  let clock = NOW,
    controls = 0,
    sourceChanged = false,
    oldChanged = false,
    closed = false,
    gateResolve: () => void = () => {}
  const gate = new Promise<void>((r) => {
    gateResolve = r
  })
  const records: any[] = [],
    finishes: any[] = [],
    events: string[] = [],
    fullS: bigint[] = [],
    questions: bigint[] = [],
    roundtrip: bigint[] = []
  const globals = {
    fetch: () => {
      throw Error('test globals never dispatch')
    },
  }
  class ControlledDate extends Date {
    static now() {
      return clock
    }
  }
  const nativeSource = {
    chainId: 1,
    blockNumber: useRealCodec ? 26152926 : 1000,
    blockHash: '0x' + 'a'.repeat(64),
    blockTime: new Date(NOW - 60000).toISOString(),
    finalized: true,
  }
  const anchors = useRealCodec
    ? composed.FLUID_USDT_COMPOSED_HISTORY_ANCHORS
    : Array.from({ length: 8 }, (_, i) => ({
        cashIndex: 111 + i,
        source: {
          chainId: 1,
          blockNumber: String(100 + i),
          blockHash: '0x' + String(i + 1).repeat(64),
          blockTime: new Date(NOW - 86400000 * (9 - i)).toISOString(),
          finalized: true,
        },
      }))
  const currentPointers = new WeakMap<object, any>()
  const fact: any = {
    schema: 'fluid_usdt_bridge_native_current_v1',
    owner: '0x' + '1'.repeat(40),
    source: nativeSource,
    sharesRaw: '1000',
    requestedFinalUsdtRaw: '500',
    withdrawalFeeBps: 5,
    profileId: 'controlled_profile_not_native_approval',
    runtimeCodeHashes: { [B]: '0x' + 'b'.repeat(64) },
    availableAtUtc: new Date(NOW).toISOString(),
    acquiredAtUtc: new Date(NOW).toISOString(),
  }
  if (useRealCodec) {
    const C = quote.FLUID_USDT_QUOTE_CONTRACTS
    const p = profileApi.resolveFluidUsdcBridgeJointTrustedProfile(
      'USDC → FluidBridgeAggregatorProxy [USDC]',
      B,
      C.usdc,
    )
    assert.ok(p)
    fact.profileId = 'fluid-usdt-bridge-same-pool-quote-funding-v1'
    fact.runtimeCodeHashes = {
      ...p.runtimeCodeHashes,
      [C.factory]: '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69',
      [C.quoter]: '0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b',
      [C.pool]: '0x2ff673bacc60a73fc85c678888296c6bce3de2a9d7475c032fe7aa6e0eacba86',
      [C.usdt]: '0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55',
    }
  }
  const current = Object.freeze({ controlledOriginal: true })
  currentPointers.set(current, fact)
  const binding = (f = fact) => ({
    owner: f.owner,
    requestedFinalUsdtRaw: f.requestedFinalUsdtRaw,
    source: { ...f.source },
    asOfMs: clock,
  })
  const oldBytes = Buffer.from('{"controlled":true}\n'),
    oldPath = 'data/research/venue-signals/controlled-old.json'
  const descriptors = useRealCodec
    ? composed.FLUID_USDT_COMPOSED_HISTORY_ORIGINAL_FILES
    : [{ id: 'controlled_old', path: oldPath, fileSha256: sha(oldBytes), bytes: oldBytes.length }]
  const originalPaths = new Set(descriptors.map((d: any) => process.cwd() + '/' + d.path))
  const files = new Map<number, { path: string; bytes: Buffer }>()
  let fd = 0
  const file = (path: string) =>
    useRealCodec && originalPaths.has(path)
      ? pinnedBytes(path)
      : path.endsWith(oldPath)
        ? oldChanged
          ? Buffer.from('{"changed":true}\n')
          : oldBytes
        : Buffer.from((sourceChanged ? 'changed source:' : 'controlled source:') + path)
  const info = (path: string, bytes?: Buffer) => ({
    isFile: () => !!bytes,
    isDirectory: () => !bytes,
    isSymbolicLink: () => false,
    dev: 1n,
    ino: BigInt(sha(path).slice(0, 10) && parseInt(sha(path).slice(0, 10), 16)),
    size: BigInt(bytes?.length ?? 0),
    mode: 0o600n,
    nlink: 1n,
    mtimeNs: 1n,
    ctimeNs: 1n,
  })
  const fs = {
    constants: requireRoot('node:fs').constants,
    realpathSync: (p: string) => p,
    lstatSync: (p: string, options?: any) => {
      if (options?.bigint) return info(p, file(p))
      return { isDirectory: () => p.endsWith('/.git'), isSymbolicLink: () => false }
    },
    openSync: (p: string) => {
      files.set(++fd, { path: p, bytes: file(p) })
      return fd
    },
    closeSync: (n: number) => files.delete(n),
    fstatSync: (n: number) => {
      const f = files.get(n)!
      return info(f.path, f.bytes)
    },
    readSync: (n: number, out: Buffer, offset: number, length: number) => {
      const f = files.get(n)!
      const pos = (f as any).position ?? 0
      const amount = Math.min(length, f.bytes.length - pos)
      f.bytes.copy(out, offset, pos, pos + amount)
      ;(f as any).position = pos + amount
      return amount
    },
  }
  let api: any
  const closure = () =>
    sha(
      JSON.stringify(
        api.FLUID_USDT_HISTORY_SOURCE_FILES.map((p: string) => {
          const bytes = file(process.cwd() + '/' + p)
          return { source: p, bytes: bytes.length, sha256: sha(bytes) }
        }),
      ),
    )
  const pin = (ctx: any, index: number) => ({
    blockHash: anchors.find((a) => a.cashIndex === index)!.source.blockHash,
    requireCanonical: true,
  })
  const plans = (ctx: any, index: number, R?: string) => {
    const a = anchors.find((a) => a.cashIndex === index)
    if (!a) return null
    const call = (key: string, to: string, name: string, args: any[], selectedAbi: any) => ({
      key,
      request: {
        method: 'eth_call',
        params: [
          { to, data: viem.encodeFunctionData({ abi: selectedAbi, functionName: name, args }) },
          pin(ctx, index),
        ],
      },
    })
    const C = quote.FLUID_USDT_QUOTE_CONTRACTS
    const first = [
      {
        key: 'header_before',
        request: {
          method: 'eth_getBlockByNumber',
          params: ['0x' + BigInt(a.source.blockNumber).toString(16), false],
        },
      },
      call(
        'full_net_ea',
        B,
        'previewRedeem',
        [BigInt(ctx.sharesRaw)],
        abi.FLUID_USDC_BRIDGE_NATIVE_ABI,
      ),
      call(
        'required_usdc',
        C.quoter,
        'quoteExactOutputSingle',
        [
          {
            tokenIn: C.usdc,
            tokenOut: C.usdt,
            amount: BigInt(ctx.requestedFinalUsdtRaw),
            fee: 100,
            sqrtPriceLimitX96: 0n,
          },
        ],
        quote.FLUID_USDT_QUOTE_ABI,
      ),
    ]
    return R === undefined
      ? first
      : [
          ...first,
          call(
            'roundtrip_usdt',
            C.quoter,
            'quoteExactInputSingle',
            [
              {
                tokenIn: C.usdc,
                tokenOut: C.usdt,
                amountIn: BigInt(R),
                fee: 100,
                sqrtPriceLimitX96: 0n,
              },
            ],
            quote.FLUID_USDT_QUOTE_ABI,
          ),
          { key: 'header_after', request: first[0].request },
        ]
  }
  const codec: any = {
    FLUID_USDT_COMPOSED_HISTORY_ORIGINAL_FILES:
      mode === 'old-pin'
        ? descriptors.map((d) => ({ ...d, fileSha256: '0'.repeat(64) }))
        : descriptors,
    FLUID_USDT_COMPOSED_HISTORY_ANCHORS: anchors,
    createFluidUsdtComposedHistoricalContext: (c: any) => Object.freeze(structuredClone(c)),
    prepareFluidUsdtComposedHistoricalOriginals: (old: any, c: any) =>
      mode === 'old-replay' ? null : Object.freeze({ unsigned: true, old }),
    fluidUsdtComposedHistoricalReadPlan: plans,
    replayFluidUsdtComposedHistoricalEvidence: (wire: any, c: any) => {
      if (mode === 'codec') return null
      const acquiredAtUtc = new Date(
        Math.max(
          ...wire.batches.flatMap((b: any) =>
            b.receipt.ledger.map((r: any) => Date.parse(r.completedAtUtc)),
          ),
        ),
      ).toISOString()
      const availableAtUtc = new Date(
        Math.max(
          Date.parse(wire.seriesAvailableAtUtc),
          ...wire.batches.map((b: any) => Date.parse(b.availableAtUtc)),
        ),
      ).toISOString()
      return {
        points: anchors.map((a) => ({
          source: a.source,
          holderSharesRaw: c.sharesRaw,
          owner: null,
          historicalOwnership: false,
          acquiredAtUtc,
          availableAtUtc,
          conversion: {
            fixedFinalUsdtOutputRaw: c.requestedFinalUsdtRaw,
            requiredNetUsdcRaw: String(BigInt(c.requestedFinalUsdtRaw) - 1n),
          },
        })),
        acquiredAtUtc,
        availableAtUtc,
      }
    },
  }
  if (useRealCodec) {
    Object.assign(codec, composed)
    codec.replayFluidUsdtComposedHistoricalEvidence = (wire: any, c: any) => {
      const batchAvailable = wire.batches.map((b: any) => b.availableAtUtc)
      const nativeRows = wire.batches.map((b: any) => sha(JSON.stringify(b.receipt.ledger)))
      const start = wire.batches[1].receipt.startedAtUtc
      const checked =
        mode === 'real-codec-retimed-batches' && replayObservations.length === 1
          ? {
              ...wire,
              batches: wire.batches.map((b: any) => ({
                ...b,
                availableAtUtc: wire.seriesAvailableAtUtc,
              })),
            }
          : wire
      const result = composed.replayFluidUsdtComposedHistoricalEvidence(checked, c)
      replayObservations.push({
        batchAvailable,
        nativeRows,
        secondStartedAtUtc: start,
        seriesAvailableAtUtc: wire.seriesAvailableAtUtc,
        acquiredAtUtc: result?.acquiredAtUtc,
        availableAtUtc: result?.availableAtUtc,
        result,
      })
      return result
    }
  }
  const origins = [
    {
      host: quote.FLUID_USDT_QUOTE_HOSTS[0],
      url: 'https://eth-mainnet.g.alchemy.com/v2?key=private-alchemy-key',
    },
    { host: quote.FLUID_USDT_QUOTE_HOSTS[1], url: 'https://rpc.ankr.com/eth?key=private-ankr-key' },
  ]
  function controller() {
    controls++
    const rows: any[] = [],
      settlements: any[] = [],
      started = clock
    let done: any,
      stage = 'unset'
    return {
      settlementReceipts: settlements,
      beginStage: (name: string) => {
        stage = name
        events.push(name)
      },
      async fetcher(url: string, options: any) {
        assert.equal(options.redirect, 'error')
        const req = JSON.parse(options.body),
          entered = clock - started,
          startedAtUtc = new Date(clock).toISOString()
        clock += 300
        let result: any = '0x1'
        if (req.method === 'eth_getBlockByNumber') {
          const a = anchors.find((a) => BigInt(a.source.blockNumber) === BigInt(req.params[0]))!
          result = {
            number: req.params[0],
            hash: a.source.blockHash,
            timestamp: '0x' + BigInt(Date.parse(a.source.blockTime) / 1000).toString(16),
          }
        } else if (req.method === 'eth_call') {
          const selected =
            req.params[0].to === B ? abi.FLUID_USDC_BRIDGE_NATIVE_ABI : quote.FLUID_USDT_QUOTE_ABI
          const d = viem.decodeFunctionData({ abi: selected, data: req.params[0].data })
          if (d.functionName === 'previewRedeem') {
            fullS.push(d.args[0])
            result = viem.encodeFunctionResult({
              abi: selected,
              functionName: d.functionName,
              result: d.args[0] * 2n,
            })
          } else if (d.functionName === 'quoteExactOutputSingle') {
            const q = d.args[0].amount
            questions.push(q)
            result = viem.encodeFunctionResult({
              abi: selected,
              functionName: d.functionName,
              result: [mode === 'zero-cost' ? 0n : q - 1n, 1n, 0, 1n],
            })
          } else {
            const r = d.args[0].amountIn
            roundtrip.push(r)
            result = viem.encodeFunctionResult({
              abi: selected,
              functionName: d.functionName,
              result: [r + 1n, 1n, 0, 1n],
            })
          }
        }
        let text = JSON.stringify({ jsonrpc: '2.0', id: req.id, result })
        if (mode === 'secret')
          text = JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            error: { message: 'private-alchemy-key' },
          })
        if (mode === 'malformed-secret') text = '{"message":"\\u0070rivate-alchemy-key"'
        const bytes = Buffer.from(text),
          row = {
            physicalId: rows.length + 1,
            host: origins.find((o) => o.url === url)!.host,
            request: req,
            accepted: true,
            status: 'success',
            httpStatus: 200,
            rawBodyBase64: bytes.toString('base64'),
            bodyBytes: bytes.length,
            bodySha256: sha(bytes),
            startedAtUtc,
            completedAtUtc: new Date(clock).toISOString(),
            stage,
            ...(useRealCodec
              ? { startedElapsedMs: entered, safeCode: null }
              : { enteredElapsedMs: entered }),
            completedElapsedMs: clock - started,
          }
        rows.push(row)
        const body = {
          ...(useRealCodec ? { schema: 'usd3_hypothetical_physical_settlement_v1' } : {}),
          physicalId: row.physicalId,
          captureAcceptance: false,
          observation: structuredClone(row),
        }
        settlements.push({ ...body, sha256: sha(JSON.stringify(body)) })
        return new Response(text, { headers: { 'x-usd3-physical-id': String(row.physicalId) } })
      },
      async finish() {
        if (done) return done
        const ledger = structuredClone(rows),
          terminalCommitments = ledger.map((r: any) => ({
            physicalId: r.physicalId,
            rowSha256: sha(JSON.stringify(r)),
          }))
        if (mode === 'raw-hash') ledger[0].bodySha256 = '0'.repeat(64)
        if (mode === 'commitment') terminalCommitments[0].rowSha256 = '0'.repeat(64)
        if (mode === 'settlement') settlements[0].sha256 = '0'.repeat(64)
        if (mode === 'late-secret') {
          const bytes = Buffer.from('{"message":"\\u0070rivate-alchemy-key"}')
          settlements.push({
            physicalId: 99,
            observation: {
              rawBodyBase64: bytes.toString('base64'),
              bodyBytes: bytes.length,
              bodySha256: sha(bytes),
            },
          })
        }
        if (mode === 'ttl-before-replay') clock += 1800000
        if (mode === 'cohort-second' && controls === 2) clock += 120001
        done = {
          ...(useRealCodec
            ? {
                startedAtUtc: new Date(started).toISOString(),
                availableAtUtc: new Date(clock).toISOString(),
                elapsedMs: clock - started,
              }
            : {}),
          failure: mode === 'controller-failure' ? 'native_failure' : null,
          pendingSettlements: mode === 'pending' ? 1 : 0,
          physicalStarts: ledger.length,
          ledger,
          terminalCommitments,
        }
        return done
      },
    }
  }
  const seriesBatchCounts = new WeakMap<object, number>()
  const sink = {
    beginHolderNativeHistoryOriginalSeries: (input: any) => {
      events.push('begin')
      assert.deepEqual(input, { kind: 'fluid_usdt_bridge_history', sharesRaw: '1000' })
      const handle = Object.freeze({})
      seriesBatchCounts.set(handle, 0)
      return handle
    },
    recordHolderNativeHistoryOriginalBatch: (_h: any, input: any) => {
      seriesBatchCounts.set(_h, (seriesBatchCounts.get(_h) ?? 0) + 1)
      records.push(structuredClone(input))
      events.push('record')
      if (mode === 'record-throws') throw Error('controlled sink failure')
      return { status: 'partial' }
    },
    finishHolderNativeHistoryOriginalSeries: (_h: any, input: any) => {
      finishes.push(input)
      events.push('finish')
      clock += mode === 'ttl-after-fsync' ? 1800000 : mode === 'cohort-fsync' ? 120001 : 10
      if (mode === 'source-drift') sourceChanged = true
      if (mode === 'old-drift') oldChanged = true
      const status = {
        status:
          mode === 'sink-unavailable'
            ? 'unavailable'
            : input.qualification
              ? 'retained'
              : 'partial',
        reason: input.reason,
        producerReplayQualification: input.qualification,
        recordedBatches: seriesBatchCounts.get(_h) ?? 0,
        sourceClosureSha256: mode === 'closure' ? '0'.repeat(64) : closure(),
        originalAuthority: false,
        authenticated: false,
        executionQualified: false,
        historicalOwnership: false,
      }
      return status
    },
  }
  const currentModule = {
    selectedOriginalFluidUsdtBridgeNativeCapacity: (v: any, b: any) => {
      const f = currentPointers.get(v)
      if (
        !f ||
        b.owner !== f.owner ||
        b.requestedFinalUsdtRaw !== f.requestedFinalUsdtRaw ||
        JSON.stringify(b.source) !== JSON.stringify(f.source) ||
        b.asOfMs < Date.parse(f.availableAtUtc) ||
        clock - Date.parse(f.source.blockTime) > 1800000
      )
        return null
      return f
    },
  }
  const exp: any = {},
    compiledModule = { exports: exp }
  const localRequire = (name: string) => {
    if (name === 'node:fs') return fs
    if (name === './fluidUsdtBridgeJointComposedHistoricalEvidenceCodec') return codec
    if (name === './fluidUsdtBridgeNativeCapacity.server') return currentModule
    if (name === './holderNativeHistoryOriginals.server') return sink
    if (name === './fluidUsdtBridgeNativeQuoteEvidenceCodec') return quote
    if (name === '@/scripts/research/usd3-hypothetical-history-capture.mjs')
      return {
        configuredUsd3HypotheticalOrigins: async () => {
          events.push('origins')
          if (mode === 'blocked') await gate
          return origins
        },
        createUsd3HypotheticalCaptureControl: (o: any, ...options: any[]) => {
          assert.strictEqual(o, origins)
          assert.deepEqual(options, [])
          return controller()
        },
        parseUsd3HypotheticalJson: JSON.parse,
      }
    return requireRoot(name)
  }
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInThisContext(
    '(function(require,exports,module,Date,globalThis,setTimeout,clearTimeout){' + js + '\n})',
    { filename: 'controlled-fluid-usdt-history-server.cjs' },
  )(
    localRequire,
    exp,
    compiledModule,
    ControlledDate,
    globals,
    () => ({}),
    () => {},
  )
  api = compiledModule.exports
  return {
    api,
    current,
    fact,
    binding,
    replayObservations,
    records,
    finishes,
    events,
    fullS,
    questions,
    roundtrip,
    controls: () => controls,
    clock: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
    release: gateResolve,
    newCurrent: (override: any) => {
      const f = { ...fact, ...override }
      const p = Object.freeze({ newControlledOriginal: true })
      currentPointers.set(p, f)
      return { current: p, binding: binding(f), fact: f }
    },
  }
}
test('retains exactly two42-start batches and native same-full-S/Q legs before issuing an exact private capability', async () => {
  const h = harness(),
    result = await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding())
  assert.ok(result)
  assert.equal(h.controls(), 2)
  assert.equal(h.records.length, 2)
  assert.deepEqual(
    h.records.map((r) => r.receipt.receipt.physicalStarts),
    [42, 42],
  )
  assert.ok(h.events.indexOf('begin') < h.events.indexOf('origins'))
  assert.ok(h.events.lastIndexOf('record') < h.events.lastIndexOf('finish'))
  assert.deepEqual(new Set(h.fullS), new Set([1000n]))
  assert.equal(h.fullS.length, 16)
  assert.deepEqual(new Set(h.questions), new Set([500n]))
  assert.deepEqual(new Set(h.roundtrip), new Set([499n]))
  assert.equal(result.evidence.points.length, 8)
  assert.equal(result.evidence.owner, null)
  assert.equal(result.evidence.originalAuthority, false)
  assert.ok(Date.parse(result.issuedAtUtc) >= Date.parse(result.evidence.availableAtUtc))
  assert.strictEqual(
    h.api.selectedOriginalFluidUsdtBridgeJointHistoricalEvidence(result, h.current, h.binding()),
    result.evidence.points,
  )
})
for (const mode of [
  'old-pin',
  'old-replay',
  'zero-cost',
  'raw-hash',
  'commitment',
  'settlement',
  'controller-failure',
  'pending',
  'codec',
  'record-throws',
  'sink-unavailable',
  'closure',
  'ttl-before-replay',
  'ttl-after-fsync',
  'source-drift',
  'old-drift',
  'cohort-second',
  'cohort-fsync',
]) {
  test('fails closed without private history registration: ' + mode, async () => {
    const h = harness(mode),
      result = await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding())
    assert.equal(result, null)
    assert.equal(
      h.api.selectedOriginalFluidUsdtBridgeJointHistoricalEvidence({}, h.current, h.binding()),
      null,
    )
    assert.notEqual(
      h.api.getLastFluidUsdtBridgeJointHistoricalEvidenceDiagnostic()?.qualified,
      true,
    )
  })
}
for (const mode of ['secret', 'malformed-secret', 'late-secret'])
  test('keeps unsafe raw/native late settlement out of retained batches: ' + mode, async () => {
    const h = harness(mode)
    assert.equal(
      await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding()),
      null,
    )
    assert.equal(h.records.length, 0)
    assert.equal(h.finishes.at(-1)?.qualification, false)
  })
test('JSON and clone history/current pointers cannot select or initiate private originals', async () => {
  const h = harness(),
    result = await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding())
  assert.ok(result)
  for (const fake of [JSON.parse(JSON.stringify(result)), structuredClone(result), {}])
    assert.equal(
      h.api.selectedOriginalFluidUsdtBridgeJointHistoricalEvidence(fake, h.current, h.binding()),
      null,
    )
  assert.equal(
    await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(
      structuredClone(h.current),
      h.binding(),
    ),
    null,
  )
})
test('owner/Q/source/full-source-time/asOf drift and getters fail before any default controller is created', async () => {
  for (const change of [
    { owner: '0x' + '2'.repeat(40) },
    { requestedFinalUsdtRaw: '501' },
    { source: { ...harness().binding().source, blockHash: '0x' + 'c'.repeat(64) } },
    { asOfMs: NOW + 1 },
    { asOfMs: 1.5 },
    { H: 168 },
  ]) {
    const h = harness()
    assert.equal(
      await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, {
        ...h.binding(),
        ...change,
      }),
      null,
    )
    assert.equal(h.controls(), 0)
  }
  const h = harness()
  let touches = 0
  const b = h.binding()
  Object.defineProperty(b, 'owner', {
    enumerable: true,
    get() {
      touches++
      return h.fact.owner
    },
  })
  assert.equal(await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, b), null)
  assert.equal(touches, 0)
})
test('cache reuses older-reference history for same S/Q and another genuine controlled owner with fresh larger source without retiming', async () => {
  const h = harness(),
    a = await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding())
  assert.ok(a)
  h.advance(20)
  const fresh = h.newCurrent({
    owner: '0x' + '2'.repeat(40),
    source: {
      ...h.fact.source,
      blockNumber: 1001,
      blockHash: '0x' + 'd'.repeat(64),
      blockTime: new Date(NOW - 59000).toISOString(),
    },
  })
  const b = await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(
    fresh.current,
    fresh.binding,
  )
  assert.ok(b)
  assert.equal(h.controls(), 2)
  assert.strictEqual(a.evidence.points, b.evidence.points)
  assert.equal(a.evidence.availableAtUtc, b.evidence.availableAtUtc)
  assert.equal(a.evidence.acquiredAtUtc, b.evidence.acquiredAtUtc)
  assert.equal(
    h.api.selectedOriginalFluidUsdtBridgeJointHistoricalEvidence(b, h.current, h.binding()),
    null,
  )
})
test('different Q uses new native quotes while keeping native full S independent', async () => {
  const h = harness()
  assert.ok(await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding()))
  const fresh = h.newCurrent({ requestedFinalUsdtRaw: '600' })
  assert.ok(
    await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(fresh.current, fresh.binding),
  )
  assert.equal(h.controls(), 4)
  assert.deepEqual(new Set(h.fullS), new Set([1000n]))
  assert.deepEqual(new Set(h.questions), new Set([500n, 600n]))
})
test('source TTL is rechecked on private selection rather than preserved as live by JSON', async () => {
  const h = harness(),
    a = await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding())
  assert.ok(a)
  h.advance(1800000)
  assert.equal(
    h.api.selectedOriginalFluidUsdtBridgeJointHistoricalEvidence(a, h.current, h.binding()),
    null,
  )
})
test('same-key work coalesces and another question cannot start a concurrent cohort', async () => {
  const h = harness('blocked'),
    a = h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding()),
    b = h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding())
  const other = h.newCurrent({ requestedFinalUsdtRaw: '600' })
  assert.equal(
    await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(other.current, other.binding),
    null,
  )
  h.release()
  const [x, y] = await Promise.all([a, b])
  assert.ok(x && y)
  assert.equal(h.controls(), 2)
})

test('an older reference or conflicting same-block source cannot reuse the cached original history', async () => {
  for (const sourceChange of [
    {
      blockNumber: 999,
      blockHash: '0x' + 'c'.repeat(64),
      blockTime: new Date(NOW - 61000).toISOString(),
    },
    { blockHash: '0x' + 'd'.repeat(64) },
  ]) {
    const h = harness()
    assert.ok(await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(h.current, h.binding()))
    const other = h.newCurrent({ source: { ...h.fact.source, ...sourceChange } })
    assert.equal(
      await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(other.current, other.binding),
      null,
    )
    assert.equal(h.controls(), 2)
  }
})
test('history anchors must precede the freshly selected current source, before any native control starts', async () => {
  const h = harness(),
    past = h.newCurrent({ source: { ...h.fact.source, blockNumber: 99 } })
  assert.equal(
    await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(past.current, past.binding),
    null,
  )
  assert.equal(h.controls(), 0)
})

test('real composed codec preserves ordered batch clocks and includes only the later series fsync barrier in availability', async () => {
  // Sixteen unchanged pinned native originals are replayed by the REAL unsigned codec.
  // New native transport/current WeakMap/sink are controlled orchestration only.
  const h = harness('real-codec')
  const result = await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(
    h.current,
    h.binding(),
  )
  assert.ok(result, 'real codec must accept the producer before and after final retention')
  assert.equal(h.replayObservations.length, 2)
  const [preliminary, final] = h.replayObservations
  assert.ok(preliminary.result)
  assert.ok(final.result)
  assert.deepEqual(final.batchAvailable, preliminary.batchAvailable)
  assert.deepEqual(final.nativeRows, preliminary.nativeRows)
  assert.ok(Date.parse(final.batchAvailable[0]) <= Date.parse(final.secondStartedAtUtc))
  assert.equal(preliminary.seriesAvailableAtUtc, preliminary.batchAvailable[1])
  assert.ok(Date.parse(final.seriesAvailableAtUtc) > Date.parse(final.batchAvailable[1]))
  assert.equal(final.acquiredAtUtc, preliminary.acquiredAtUtc)
  assert.equal(result.evidence.availableAtUtc, final.seriesAvailableAtUtc)
  assert.ok(
    result.evidence.points.every((p: any) => p.availableAtUtc === final.seriesAvailableAtUtc),
  )
  assert.ok(Date.parse(result.issuedAtUtc) >= Date.parse(final.seriesAvailableAtUtc))
  assert.strictEqual(
    h.api.selectedOriginalFluidUsdtBridgeJointHistoricalEvidence(result, h.current, h.binding()),
    result.evidence.points,
  )
})
test('real composed codec rejects the former final barrier overwrite without privately issuing history', async () => {
  const h = harness('real-codec-retimed-batches')
  const result = await h.api.readFluidUsdtBridgeJointHistoricalEvidenceAtIssue(
    h.current,
    h.binding(),
  )
  assert.equal(result, null)
  assert.equal(h.replayObservations.length, 2)
  assert.ok(h.replayObservations[0].result)
  assert.equal(h.replayObservations[1].result, null)
  assert.equal(h.api.getLastFluidUsdtBridgeJointHistoricalEvidenceDiagnostic().qualified, false)
})
