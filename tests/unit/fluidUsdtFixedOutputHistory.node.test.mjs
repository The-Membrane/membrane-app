import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, statSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { encodeFunctionResult, decodeFunctionData } from 'viem'
import {
  prepareFluidFixedOutputHistoryPlan,
  fluidFixedOutputHistoryRequests,
  captureFluidFixedOutputHistory,
  replayFluidFixedOutputHistory,
  writeFluidFixedOutputHistory,
  FLUID_FIXED_OUTPUT_ABI,
  FLUID_FIXED_OUTPUT_HISTORY_POLICY,
  FLUID_FIXED_OUTPUT_QUESTION_PROVENANCE,
  FLUID_FIXED_OUTPUT_LEGACY_CAPTURE_PIN,
  replayPinnedLegacyFluidFixedOutputHistory,
  importPinnedLegacyFluidFixedOutputHistory,
} from '../../scripts/research/fluid-usdt-fixed-output-history-capture.mjs'
globalThis.fetch = async () => {
  throw Error('offline_global_fetch_trap')
}
const plan = prepareFluidFixedOutputHistoryPlan()
const providers = [
  { url: 'https://eth-mainnet.g.alchemy.com/v2/offline-secret' },
  { url: 'https://rpc.ankr.com/eth/offline-secret' },
]
const sha = (v) => createHash('sha256').update(v).digest('hex')
const reseal = (v) => {
  const { sha256, ...body } = v
  return { ...body, sha256: sha(JSON.stringify(body)) }
}
function fake({ mutate, bytes, status = 200 } = {}) {
  let n = 0,
    active = 0,
    maxActive = 0,
    time = Date.parse('2026-10-07T22:00:00.000Z'),
    m = 0
  const starts = []
  const now = () => new Date(time++).toISOString(),
    monotonic = () => m++
  const fetchImpl = async (url, options) => {
    maxActive = Math.max(maxActive, ++active)
    const request = JSON.parse(options.body)
    starts.push({ host: new URL(url).hostname, request })
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, 'POST')
    assert.ok(options.signal instanceof AbortSignal)
    const source = plan.anchors[Math.floor((n % 6) / 3)].source
    let result =
      request.method === 'eth_getBlockByNumber'
        ? {
            number: '0x' + BigInt(source.blockNumber).toString(16),
            hash: source.blockHash,
            timestamp: '0x' + BigInt(Date.parse(source.blockTime) / 1000).toString(16),
          }
        : encodeFunctionResult({
            abi: FLUID_FIXED_OUTPUT_ABI,
            functionName: 'quoteExactOutputSingle',
            result: [10144n, 100000n, 0, 45000n],
          })
    let response = { jsonrpc: '2.0', id: request.id, result }
    if (mutate) response = mutate(response, n, request)
    n++
    const text = bytes ?? JSON.stringify(response)
    active--
    return new Response(text, { status })
  }
  return {
    fetchImpl,
    now,
    monotonic,
    starts,
    get maxActive() {
      return maxActive
    },
  }
}
let baseline
await test('zero-network immutable plan separates research final USDT target from original USDC first-leg question', () => {
  assert.equal(plan.physicalStarts, 12)
  assert.equal(plan.fixedFinalUsdtOutputRaw, '10145')
  assert.equal(plan.anchors.length, 2)
  assert.deepEqual(FLUID_FIXED_OUTPUT_HISTORY_POLICY, {
    maxRequests: 12,
    maxInFlightPerHost: 1,
    retries: 0,
    rpcTimeoutMs: 8000,
    maxResponseBytes: 65536,
    maxArtifactBytes: 1536 * 1024,
    reserveBytes: 128 * 1024 * 1024,
  })
  assert.equal(plan.anchors[0].nativeFullPositionEntitlementRaw, '1014574')
  assert.equal(plan.anchors[1].nativeFullPositionEntitlementRaw, '1014581')
  for (let i = 0; i < 2; i++) {
    const requests = fluidFixedOutputHistoryRequests(plan, i)
    assert.equal(requests.length, 3)
    assert.equal(requests[1].params.length, 2)
    const decoded = decodeFunctionData({
      abi: FLUID_FIXED_OUTPUT_ABI,
      data: requests[1].params[0].data,
    })
    assert.equal(decoded.functionName, 'quoteExactOutputSingle')
    assert.deepEqual(
      {
        ...decoded.args[0],
        tokenIn: decoded.args[0].tokenIn.toLowerCase(),
        tokenOut: decoded.args[0].tokenOut.toLowerCase(),
      },
      {
        tokenIn: plan.input.asset,
        tokenOut: plan.output.asset,
        amount: 10145n,
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
    )
    assert.deepEqual(requests[1].params[1], {
      blockHash: plan.anchors[i].source.blockHash,
      requireCanonical: true,
    })
  }
  assert.throws(() => fluidFixedOutputHistoryRequests(structuredClone(plan), 0), /unprepared/)
})
await test('capture executes exactly twelve physical mocked requests; replay retains all raw bodies', async () => {
  const f = fake()
  baseline = await captureFluidFixedOutputHistory(plan, providers, f)
  assert.equal(f.starts.length, 12)
  assert.equal(f.maxActive, 1)
  const replay = replayFluidFixedOutputHistory(baseline, plan)
  assert.equal(replay.points[0].requiredUsdcRaw, '10144')
  assert.equal(replay.points[1].fixedFinalUsdtOutputRaw, '10145')
  assert.equal(replay.execution, 'unassessed')
  assert.equal(replay.minedPayout, false)
  assert.equal(replay.forecastValidated, false)
  assert.equal(replay.sourceImplementationEquivalence, false)
  assert.ok(!JSON.stringify(baseline).includes('offline-secret'))
  for (const t of baseline.traces) {
    assert.equal(t.responseBytes, Buffer.byteLength(t.responseText))
    assert.equal(t.responseSha256, sha(t.responseText))
  }
})
await test('resealing tampered Q/source/calldata/raw bodies/count/clock/qualification does not authorize proof', () => {
  const edits = [
    (v) => (v.plan.fixedFinalUsdtOutputRaw = '10146'),
    (v) => v.traces[1].request.params.push({}),
    (v) => (v.traces[1].request.params[1].requireCanonical = false),
    (v) => (v.traces[0].response.result.hash = '0x' + '0'.repeat(64)),
    (v) => v.traces[0].responseBytes++,
    (v) => (v.physicalStarts = 11),
    (v) => v.traces.pop(),
    (v) => (v.traces[1].startedMonotonicMs = -1),
    (v) => (v.traces[1].startedAtUtc = v.traces[0].startedAtUtc),
    (v) => (v.forecastValidated = true),
    (v) => (v.traces[0].responseText += ' '),
  ]
  for (const edit of edits) {
    const v = structuredClone(baseline)
    edit(v)
    assert.throws(() => replayFluidFixedOutputHistory(reseal(v), plan))
  }
})
await test('unknown historical header stops dependent quote and stops retries', async () => {
  const f = fake({
    mutate: (v, n) => {
      if (n === 0) v.result.hash = '0x' + '0'.repeat(64)
      return v
    },
  })
  await assert.rejects(captureFluidFixedOutputHistory(plan, providers, f), /source_header/)
  assert.equal(f.starts.length, 1)
})
await test('RPC error stops all dependent calls; no transaction or state override', async () => {
  const f = fake({
    mutate: (v, n) =>
      n === 1 ? { jsonrpc: '2.0', id: v.id, error: { code: -32000, message: 'unavailable' } } : v,
  })
  await assert.rejects(captureFluidFixedOutputHistory(plan, providers, f), /rpc_envelope/)
  assert.equal(f.starts.length, 2)
  assert.equal(f.starts[1].request.method, 'eth_call')
  assert.equal(f.starts[1].request.params.length, 2)
})
await test('oversize and redirect/http failures never retry', async () => {
  for (const opts of [{ bytes: 'x'.repeat(65537) }, { status: 500 }, { status: 302 }]) {
    const f = fake(opts)
    await assert.rejects(captureFluidFixedOutputHistory(plan, providers, f), /rpc_stopped/)
    assert.equal(f.starts.length, 1)
  }
})
await test('same-source origin disagreement stays typed unknown', async () => {
  const f = fake({
    mutate: (v, n) => {
      if (n === 7)
        v.result = encodeFunctionResult({
          abi: FLUID_FIXED_OUTPUT_ABI,
          functionName: 'quoteExactOutputSingle',
          result: [10143n, 100000n, 0, 45000n],
        })
      return v
    },
  })
  const value = await captureFluidFixedOutputHistory(plan, providers, f),
    r = replayFluidFixedOutputHistory(value, plan)
  assert.equal(r.points[0].status, 'unknown_origin_disagreement')
  assert.equal(r.points[0].requiredUsdcRaw, null)
})
await test('private provider pair validation and exclusive 0600 nonsymlink output', async () => {
  const f = fake()
  await assert.rejects(
    captureFluidFixedOutputHistory(plan, [providers[0], providers[0]], f),
    /distinct_origins/,
  )
  assert.equal(f.starts.length, 0)
  const dir = mkdtempSync('/private/tmp/fluid-fixed-output-tests-')
  try {
    const path = dir + '/capture.json'
    writeFluidFixedOutputHistory(path, baseline, plan)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.throws(() => writeFluidFixedOutputHistory(path, baseline, plan))
    const link = dir + '/link'
    symlinkSync(path, link)
    assert.throws(() => writeFluidFixedOutputHistory(link, baseline, plan))
    assert.deepEqual(JSON.parse(readFileSync(path)), baseline)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
await test('whole physical timeout includes a stalled streamed body and stops at one start', async () => {
  let starts = 0,
    aborted = false
  const fetchImpl = async (_url, options) => {
    starts++
    options.signal.addEventListener('abort', () => {
      aborted = true
    })
    return { ok: true, redirected: false, url: '', body: new ReadableStream({ start() {} }) }
  }
  const before = performance.now()
  await assert.rejects(
    captureFluidFixedOutputHistory(plan, providers, { fetchImpl }),
    /rpc_stopped/,
  )
  assert.equal(starts, 1)
  assert.equal(aborted, true)
  assert.ok(performance.now() - before >= 7900)
  assert.ok(performance.now() - before < 9500)
})
await test('native response cannot persist provider URLs or unexpected RPC envelopes', async () => {
  const f = fake({
    mutate: (v) => ({
      ...v,
      result: { ...v.result, secret: 'https://rpc.ankr.com/eth/offline-secret' },
    }),
  })
  await assert.rejects(captureFluidFixedOutputHistory(plan, providers, f), /rpc_stopped/)
  assert.equal(f.starts.length, 1)
})
await test('escaped JSON provider URL is rejected before the next physical start', async () => {
  const source = plan.anchors[0].source
  const response = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      number: '0x' + BigInt(source.blockNumber).toString(16),
      hash: source.blockHash,
      timestamp: '0x' + BigInt(Date.parse(source.blockTime) / 1000).toString(16),
      extra: providers[1].url,
    },
  }
  const raw = JSON.stringify(response).replaceAll('https://', '\\u0068ttps:\\u002f\\u002f')
  assert.equal(/https?:\/\//i.test(raw), false)
  assert.equal(/https?:\/\//i.test(JSON.stringify(JSON.parse(raw))), true)
  const f = fake({ bytes: raw })
  await assert.rejects(captureFluidFixedOutputHistory(plan, providers, f), /rpc_stopped/)
  assert.equal(f.starts.length, 1)
})
await test('escaped JSON provider URL replay rejection survives recomputed raw and body seals', async () => {
  const value = structuredClone(await captureFluidFixedOutputHistory(plan, providers, fake()))
  const trace = value.traces[0]
  trace.response.result.extra = providers[1].url
  trace.responseText = JSON.stringify(trace.response).replaceAll(
    'https://',
    '\\u0068ttps:\\u002f\\u002f',
  )
  trace.responseBytes = Buffer.byteLength(trace.responseText)
  trace.responseSha256 = sha(trace.responseText)
  const candidate = reseal(value)
  assert.equal(candidate.sha256, reseal(candidate).sha256)
  assert.equal(trace.responseSha256, sha(trace.responseText))
  assert.deepEqual(JSON.parse(trace.responseText), trace.response)
  assert.throws(() => replayFluidFixedOutputHistory(candidate, plan), /raw_response_bound/)
})
await test('provenance separates a research final USDT target from the original USDC first-leg question', async () => {
  assert.equal(plan.schema, 'fluid_usdt_fixed_output_history_plan_v2')
  for (const [key, value] of Object.entries(FLUID_FIXED_OUTPUT_QUESTION_PROVENANCE)) {
    assert.deepEqual(plan[key], value)
    for (const anchor of plan.anchors) assert.deepEqual(anchor[key], value)
  }
  assert.equal(plan.originalFirstLegRequestAssetUnit, 'USDC')
  assert.equal(plan.originalFinalUsdtRequestedRaw, null)
  assert.equal(plan.questionBinding, 'unassessed')
  assert.equal(Object.hasOwn(plan, 'originalUsdtRequestedRaw'), false)
  const value = await captureFluidFixedOutputHistory(plan, providers, fake())
  assert.equal(value.schema, 'fluid_usdt_fixed_output_history_capture_v2')
  const view = replayFluidFixedOutputHistory(value, plan)
  for (const point of view.points) {
    assert.equal(point.fixedFinalUsdtOutputRaw, '10145')
    assert.equal(point.originalFirstLegUsdcRequestedRaw, '10145')
    assert.equal(point.originalFirstLegRequestAssetUnit, 'USDC')
    assert.equal(point.originalFinalUsdtRequestedRaw, null)
    assert.equal(point.questionBinding, 'unassessed')
    assert.equal(Object.hasOwn(point, 'originalUsdtRequestedRaw'), false)
  }
})
await test('provenance legacy import independently pins actual bytes and returns corrected immutable-clock view', () => {
  const text = readFileSync(FLUID_FIXED_OUTPUT_LEGACY_CAPTURE_PIN.path, 'utf8')
  assert.equal(Buffer.byteLength(text), 297606)
  assert.equal(sha(text), FLUID_FIXED_OUTPUT_LEGACY_CAPTURE_PIN.fileSha256)
  const raw = JSON.parse(text)
  assert.equal(raw.sha256, FLUID_FIXED_OUTPUT_LEGACY_CAPTURE_PIN.bodySha256)
  assert.equal(raw.plan.originalUsdtRequestedRaw, '10145') // Obsolete raw label, never a final-question assertion.
  const view = replayPinnedLegacyFluidFixedOutputHistory(text, plan)
  assert.deepEqual(importPinnedLegacyFluidFixedOutputHistory(plan), view)
  assert.equal(view.availableAtUtc, raw.availableAtUtc)
  assert.equal(view.physicalStarts, 12)
  assert.equal(view.provenanceCorrection.rawArtifactImmutable, true)
  assert.equal(view.provenanceCorrection.originalFinalUsdtRequestedRaw, null)
  assert.equal(view.questionBinding, 'unassessed')
  assert.deepEqual(
    view.points.map((p) => p.requiredUsdcRaw),
    ['10144', '10144'],
  )
  assert.deepEqual(
    view.points.map((p) => p.nativeFullPositionEntitlementRaw),
    ['1014574', '1014581'],
  )
  assert.deepEqual(
    view.points.map((p) => p.source),
    raw.plan.anchors.map((a) => a.source),
  )
  assert.equal(Object.hasOwn(view, 'originalUsdtRequestedRaw'), false)
  assert.throws(() => replayFluidFixedOutputHistory(raw, plan), /capture_integrity/)
})
await test('provenance tampering cannot bind a final question or change original units/target/native joins even after resealing', async () => {
  const captured = await captureFluidFixedOutputHistory(plan, providers, fake())
  const edits = [
    (v) => (v.plan.originalFirstLegRequestAssetUnit = 'USDT'),
    (v) => (v.plan.originalFinalUsdtRequestedRaw = '10145'),
    (v) => (v.plan.questionBinding = 'original_final_question_bound'),
    (v) => (v.plan.fixedFinalUsdtOutputRaw = '10146'),
    (v) => (v.plan.anchors[0].originalFirstLegUsdcRequestedRaw = '10146'),
    (v) => (v.plan.anchors[0].nativeFullPositionEntitlementRaw = '10144'),
    (v) => (v.plan.anchors[0].source.blockNumber = '26101888'),
    (v) => (v.traces[1].request.params[0].data = '0xdead'),
  ]
  for (const edit of edits) {
    const v = structuredClone(captured)
    edit(v)
    v.planSha256 = sha(JSON.stringify(v.plan))
    assert.throws(() => replayFluidFixedOutputHistory(reseal(v), plan))
  }
})
await test('provenance legacy candidate cannot substitute self-sealed question units/source/native receipt or raw bytes', () => {
  const text = readFileSync(FLUID_FIXED_OUTPUT_LEGACY_CAPTURE_PIN.path, 'utf8')
  assert.throws(
    () => replayPinnedLegacyFluidFixedOutputHistory(text + ' ', plan),
    /legacy_file_pin/,
  )
  for (const edit of [
    (v) => (v.plan.originalUsdtRequestedRaw = '10146'),
    (v) => (v.plan.input.asset = v.plan.output.asset),
    (v) => (v.plan.anchors[0].nativeFullPositionEntitlementRaw = '10144'),
    (v) => (v.traces[1].request.params[1].requireCanonical = false),
  ]) {
    const v = JSON.parse(text)
    edit(v)
    v.planSha256 = sha(JSON.stringify(v.plan))
    const altered = JSON.stringify(reseal(v)) + '\n'
    assert.throws(() => replayPinnedLegacyFluidFixedOutputHistory(altered, plan), /legacy_file_pin/)
  }
})
