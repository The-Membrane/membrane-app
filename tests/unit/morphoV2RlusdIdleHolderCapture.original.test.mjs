/** Original physical controller tests. All responses are local fixtures; no RPC is acquired. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, encodeFunctionResult, encodeFunctionData } from 'viem'
import {
  finalizeMorphoV2RlusdIdleHolderRetention, createMorphoV2RlusdIdleHolderNativeTransport,
  MORPHO_V2_RLUSD_IDLE_HOLDER_ABI, MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY, MORPHO_V2_RLUSD_IDLE_HOLDER_FLAGS, prepareMorphoV2RlusdIdleHolderIdleHistory,
  morphoV2RlusdIdleHolderPointReadPlan, morphoV2RlusdIdleHolderStorageBudgetProof, captureMorphoV2RlusdIdleHolderIdleHistory,
  deriveMorphoV2RlusdIdleHolderPoint, morphoV2RlusdIdleHolderEncodedOriginals, reconstructMorphoV2RlusdIdleHolderOriginalControl,
  assertMorphoV2RlusdIdleHolderDiskCapacity, morphoV2RlusdIdleHolderFixedArtifacts, createMorphoV2RlusdIdleHolderWriter,
  morphoV2RlusdIdleHolderReport, inspectMorphoV2RlusdIdleHolderRetainedHistory, runMorphoV2RlusdIdleHolderIdleHistory,
} from '../../scripts/research/morpho-v2-rlusd-idle-holder-capture-v1.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url)), ZERO = '0x' + '0'.repeat(40)
const sha = (x) => createHash('sha256').update(x).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const hosts = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const origins = hosts.map((host) => ({ host, url: 'https://' + host + '/local-pyusd-test-fixture' }))
const FRESH_S = '2000000000000000000' // Local fixture stock, never an observed holder amount.
const nativeReply = (name, value) => encodeFunctionResult({ abi: MORPHO_V2_RLUSD_IDLE_HOLDER_ABI, functionName: name, result: value })

/** Test-only deterministic timers; the real CLI uses performance.now and native timers. */
function timerHarness(initial = 0, throwOnTimer = null) {
  let elapsed = initial, id = 0
  const active = new Map(), armed = [], cleared = []
  const setTimer = (callback, ms) => {
    const next = ++id
    if (next === throwOnTimer) throw Error('local_timer_arm_failure')
    const row = { id: next, callback, at: elapsed + ms, delay: ms, name: callback.name }
    active.set(next, row); armed.push(row); return next
  }
  const clearTimer = (timer) => { cleared.push(timer); active.delete(timer) }
  const advance = (ms) => {
    const target = elapsed + ms
    while (true) {
      const next = [...active.values()].filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!next) break
      elapsed = next.at; active.delete(next.id); next.callback()
    }
    elapsed = target
  }
  return { active, armed, cleared, advance, setTimer, clearTimer, monotonic: () => elapsed,
    now: () => Date.parse('2026-10-10T05:10:00.000Z') + elapsed,
    pace: async (ms) => advance(ms) }
}
const timed = (f, timers) => ({ ...f, ...timers, started: 0 })
function assertCutoffTimerCleared(timers) {
  const cutoffs = timers.armed.filter((x) => x.name === 'stopAtMorphoV2RlusdIdleHolderAcquisitionDeadline')
  assert.equal(cutoffs.length, 1)
  assert.ok(timers.cleared.includes(cutoffs[0].id))
  assert.equal(timers.active.size, 0)
  return cutoffs[0]
}

function fixture(prepared, { drift = false, zeroStock = false, ownerHasCode = false, zeroCurrentCash = false, zeroEa = false, impossibleStock = false, incorrectHistoricalCash = false,
  wrongHeader = false, failAt = null, headerBytes = 0 } = {}) {
  const discovery = JSON.parse(prepared.inputs.find((x) => x.pin.path === prepared.plan.discoveryPath).bytes)
  const codeOf = (address) => {
    const row = discovery.control.ledger.find((r) => r.request.method === 'eth_getCode' && r.request.params[0] === address)
    assert.ok(row?.rawBodyBase64)
    return JSON.parse(Buffer.from(row.rawBodyBase64, 'base64')).result
  }
  const codes = { [prepared.plan.subject.vault]: codeOf(prepared.plan.subject.vault),
    [prepared.plan.subject.asset]: codeOf(prepared.plan.subject.asset), [prepared.plan.subject.owner]: ownerHasCode ? '0x6000' : '0x' }
  const freshSource = { chainId: 1, blockNumber: '26160000', blockHash: '0x' + 'ab'.repeat(32),
    blockTime: '2026-10-10T05:00:00.000Z', finalized: true }
  const sources = [freshSource, ...prepared.plan.anchors.map((x) => x.source)]
  let elapsed = 0, calls = 0
  const requests = []
  const headerOf = (source) => ({ number: '0x' + BigInt(source.blockNumber).toString(16),
    hash: wrongHeader && calls === 6 ? '0x' + 'cd'.repeat(32) : source.blockHash,
    timestamp: '0x' + BigInt(Date.parse(source.blockTime) / 1000).toString(16) })
  const fetcher = async (_url, options) => {
    const r = JSON.parse(options.body); requests.push(structuredClone(r)); calls++
    if (calls === failAt) throw Error('local_fixture_failure')
    let result
    if (r.method === 'eth_chainId') result = '0x1'
    else if (r.method === 'eth_getBlockByNumber') {
      const source = r.params[0] === 'finalized' ? freshSource : sources.find((s) => BigInt(r.params[0]) === BigInt(s.blockNumber))
      assert.ok(source); result = headerOf(source)
    } else {
      const pin = r.params.at(-1)
      assert.equal(pin.requireCanonical, true)
      const index = sources.findIndex((s) => s.blockHash === pin.blockHash)
      assert.ok(index >= 0)
      if (r.method === 'eth_getCode') result = codes[r.params[0]]
      else {
        assert.equal(r.method, 'eth_call')
        const { functionName, args } = decodeFunctionData({ abi: MORPHO_V2_RLUSD_IDLE_HOLDER_ABI, data: r.params[0].data })
        let value
        if (functionName === 'asset') value = prepared.plan.subject.asset
        else if (functionName === 'decimals') value = r.params[0].to === prepared.plan.subject.asset ? 18 : 18
        else if (functionName === 'liquidityAdapter') value = drift && index === 1 ? '0x' + '11'.repeat(20) : ZERO
        else if (functionName === 'liquidityData') value = drift && index === 1 ? '0x01' : '0x'
        else if (functionName === 'totalAssets') value = 100000000000000000000000000n
        else if (functionName === 'totalSupply') value = impossibleStock && index === 1 ? 0n : 100000000000000000000000000n
        else if (functionName === 'balanceOf') {
          if (r.params[0].to === prepared.plan.subject.asset) {
            assert.equal(args[0].toLowerCase(), prepared.plan.subject.vault)
            value = index === 0 ? zeroCurrentCash ? 0n : 50000000000000000000000000n : BigInt(prepared.plan.anchors[index - 1].expectedCashRaw)
            if (incorrectHistoricalCash && index === 1) value++
          } else {
            assert.equal(r.params[0].to, prepared.plan.subject.vault)
            assert.equal(args[0].toLowerCase(), prepared.plan.subject.owner)
            value = zeroStock && index === 0 ? 0n : index === 0 ? BigInt(FRESH_S) : index === 1 ? 0n : 100n
          }
        } else {
          assert.equal(functionName, 'previewRedeem')
          assert.equal(String(args[0]), FRESH_S)
          value = zeroEa && index === 1 ? 0n : zeroStock ? 0n : index === 0 ? 3000000000000000000n : index === 1 ? 1800000000000000000n : 1900000000000000000n
        }
        result = nativeReply(functionName, value)
      }
    }
    let raw = JSON.stringify({ jsonrpc: '2.0', id: r.id, result })
    if (r.method === 'eth_getBlockByNumber' && headerBytes > 0) raw += ' '.repeat(headerBytes - Buffer.byteLength(raw))
    return new Response(raw, {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return { requests, freshSource, fetcher, monotonic: () => elapsed,
    now: () => Date.parse('2026-10-10T05:10:00.000Z') + elapsed,
    pace: async (ms) => { elapsed += ms }, calls: () => calls }
}

test('closed dry plan performs no fetch and derives 98 starts under all original limits', async () => {
  const prepared = prepareMorphoV2RlusdIdleHolderIdleHistory(), before = globalThis.fetch
  globalThis.fetch = () => { throw Error('zero_RPC_control') }
  try {
    const value = await runMorphoV2RlusdIdleHolderIdleHistory(['--dry-plan'])
    assert.equal(value.status, 'closed_plan_no_RPC')
    assert.equal(value.proof.derivedWorstStarts, 98)
  } finally { globalThis.fetch = before }
  const proof = morphoV2RlusdIdleHolderStorageBudgetProof(prepared)
  assert.ok(proof.fixedSerializedBytes <= 2 * 1024 * 1024)
  assert.ok(proof.maximumLogicalBytes <= 10 * 1024 * 1024)
  assert.ok(proof.maximumAllocationExtra <= 3 * 1024 * 1024)
  assert.ok(proof.maximumFiles <= 131)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.pre, 269 * 1024 * 1024)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.reserve, 256 * 1024 * 1024)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.deadline, 60000)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.acquisitionDeadline, 55000)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.retentionReserve, 5000)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.stage, 12000)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.timeout, 8000)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.spacing, 250)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.workers, 1)
  assert.equal(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.retries, 0)
  assert.throws(() => assertMorphoV2RlusdIdleHolderDiskCapacity(BigInt(MORPHO_V2_RLUSD_IDLE_HOLDER_POLICY.pre - 1), 0, false, true))
})

test('actual original controller joins S, full Ea and C with distinct units at all three points', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), f = fixture(p)
  const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, true)
  assert.equal(capture.qualifiedNativeJoin, true)
  assert.equal(capture.physicalStarts, 98)
  assert.equal(f.calls(), 98)
  assert.equal(capture.receipt.pendingSettlements, 0)
  assert.equal(capture.freshCurrentSharesRaw, FRESH_S)
  const [current, first, second] = capture.points
  assert.equal(current.freshCurrentFullEaAssetRaw, '3000000000000000000')
  assert.equal(current.actualOwnerSharesRaw, FRESH_S)
  assert.equal(current.probeShareDecimals, 18)
  assert.equal(current.probeEaAssetDecimals, 18)
  assert.equal(current.cashAssetDecimals, 18)
  assert.equal(first.CAssetRaw, '33839334665030112550605947')
  assert.equal(second.CAssetRaw, '42034598885855843780937500')
  assert.equal(first.totalAssetsRaw, '100000000000000000000000000')
  assert.notEqual(first.totalAssetsRaw, first.CAssetRaw)
  assert.equal(first.actualHistoricalOwnerSharesRaw, '0')
  assert.equal(second.actualHistoricalOwnerSharesRaw, '100')
  for (const point of [first, second]) {
    assert.equal(point.probeSharesRaw, FRESH_S)
    assert.equal(point.conversionBasis, 'hypothetical_fixed_current_stock_conversion')
    assert.equal(point.historicalOwnedEntitlementAssetRaw, null)
    assert.equal(point.historicalOwnedEntitlementMeasured, false)
    assert.equal(point.historicalOwnerStockEqualsProbeStock, false)
    assert.equal(point.freshCurrentFullEaAssetRaw, null)
    assert.equal(point.LLTV, null)
    assert.equal(point.LLTVStatus, 'inapplicable_idle_no_adapter')
    assert.equal(point.allocation, null)
  }
  const originals = morphoV2RlusdIdleHolderEncodedOriginals(capture)
  const restored = reconstructMorphoV2RlusdIdleHolderOriginalControl(originals.summary, originals.rows.map((x) => x.value))
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
  const mutated = structuredClone(originals.rows.map((x) => x.value))
  mutated[0].row.observation.rawBodyBase64 = Buffer.from('{"error":"replaced"}').toString('base64')
  assert.throws(() => reconstructMorphoV2RlusdIdleHolderOriginalControl(originals.summary, mutated))
  const badSource = structuredClone(originals.summary); badSource.source.blockHash = '0x' + 'de'.repeat(32)
  assert.throws(() => reconstructMorphoV2RlusdIdleHolderOriginalControl(badSource, originals.rows.map((x) => x.value)))
  for (const flag of ['holderExecutableExit', 'executionAuthority', 'forecastAuthority', 'forecastEligibility',
    'sourceImplementationEquivalence', 'calibrated', 'calibratedProbability', 'coveragePromotion']) assert.equal(capture[flag], false)
  assert.equal(capture.competingMRaw, null)
})

test('a configuration difference retains paired native facts and declines qualification', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), f = fixture(p, { drift: true })
  const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, true)
  assert.equal(capture.physicalStarts, 98)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.ok(capture.points[1].qualificationReasons.includes('idle_regime_differed'))
  assert.equal(capture.points[1].liquidityData, '0x01')
  assert.equal(capture.points[1].LLTVStatus, 'unmeasured')
  assert.equal(capture.points[1].probeEaAssetRaw, '1800000000000000000')
  assert.equal(capture.points[2].qualifiedNativeJoin, true)
})

test('zero fresh stock and changed historical cash cannot qualify the historical hint', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory()
  for (const options of [{ zeroStock: true }, { incorrectHistoricalCash: true }]) {
    const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, fixture(p, options))
    assert.equal(capture.completeNativeAcquisition, !options.zeroStock)
    assert.equal(capture.qualifiedNativeJoin, false)
    assert.ok(capture.pointStatuses.some((x) => x.censorReasons.length > 0))
  }
})

test('native provider failure preserves bounded partial original control without qualification', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), f = fixture(p, { failAt: 41 })
  const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.ok(capture.physicalStarts <= 41)
  assert.equal(capture.points.length, 1)
  const originals = morphoV2RlusdIdleHolderEncodedOriginals(capture)
  const restored = reconstructMorphoV2RlusdIdleHolderOriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
  assert.throws(() => reconstructMorphoV2RlusdIdleHolderOriginalControl(originals.summary, originals.rows.map((x) => x.value), true))
})

test('canonical source disagreement cannot qualify a native point', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), f = fixture(p, { wrongHeader: true })
  const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.points.length, 0)
  assert.ok(capture.physicalStarts <= 34)
  const originals = morphoV2RlusdIdleHolderEncodedOriginals(capture)
  assert.equal(originals.rows.length, capture.physicalStarts)
  assert.throws(() => reconstructMorphoV2RlusdIdleHolderOriginalControl(originals.summary, originals.rows.map((x) => x.value), true))
})

test('historical preview request cannot silently substitute actual historical stock', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), f = fixture(p)
  const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, f)
  const traces = structuredClone(capture.traces)
  for (const trace of traces.filter((x) => x.key === 'anchor_0:fixed_stock_preview'))
    trace.request.params[0].data = encodeFunctionData({ abi: MORPHO_V2_RLUSD_IDLE_HOLDER_ABI, functionName: 'previewRedeem', args: [0n] })
  assert.throws(() => deriveMorphoV2RlusdIdleHolderPoint(traces, 'anchor_0', p.plan.anchors[0].source,
    FRESH_S, p.expectedRuntimes, p.plan.anchors[0].expectedCashRaw))
  const specs = morphoV2RlusdIdleHolderPointReadPlan('anchor_0', p.plan.anchors[0].source, FRESH_S)
  assert.equal(specs.length, 16)
  assert.equal(specs.filter((x) => x.method === 'eth_getBlockByNumber').length, 2)
  assert.equal(specs.filter((x) => x.method === 'eth_getCode').length, 3)
  assert.equal(specs.filter((x) => x.method === 'eth_getLogs').length, 0)
})

test('private immutable writer roundtrips 98 original rows including exact 256 KiB native headers and refuses overwrite and symlink', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, fixture(p, { headerBytes: 262144 }))
  const headers = capture.receipt.ledger.filter((row) => row.request.method === 'eth_getBlockByNumber')
  assert.equal(headers.length, 14)
  assert.ok(headers.every((row) => row.bodyBytes === 262144 && Buffer.from(row.rawBodyBase64, 'base64').length === 262144))
  const directory = resolve(ROOT, 'data/research/venue-signals/morpho-v2-rlusd-idle-holder-capture-v1-unit-' + randomUUID())
  const writer = createMorphoV2RlusdIdleHolderWriter(directory, ['local-secret-never-in-fixtures-' + randomUUID()])
  try {
    for (const artifact of morphoV2RlusdIdleHolderFixedArtifacts(p)) writer.write(artifact.name, artifact.value)
    const originals = morphoV2RlusdIdleHolderEncodedOriginals(capture)
    for (const row of originals.rows) writer.write(row.name, row.value)
    writer.write('control-summary.json', originals.summary)
    const report = morphoV2RlusdIdleHolderReport(capture, p); writer.write('report.json', report)
    writer.verifyRetained()
    const terminal = seal({ schema: 'morpho_v2_rlusd_idle_holder_terminal_v1', reportSha256: report.sha256,
      completeNativeAcquisition: true, qualifiedNativeJoin: true, failure: null, currentSource: capture.currentSource,
      physicalStarts: capture.physicalStarts, pendingSettlements: 0, retainedRows: originals.rows.length,
      preTerminalRetentionCheckedAtUtc: '2026-10-10T05:10:30.000Z', retentionClockStage: 'before_terminal_write', elapsedMs: 30000,
      acquisitionDeadlineElapsedMs: 55000, retentionReserveMs: 5000,
      files: writer.refs.map(({ dev, ino, ...ref }) => ref), ...MORPHO_V2_RLUSD_IDLE_HOLDER_FLAGS })
    writer.write('terminal.json', terminal, true)
    const inspected = inspectMorphoV2RlusdIdleHolderRetainedHistory(directory)
    assert.equal(inspected.originalControlVerified, true)
    assert.equal(inspected.qualifiedNativeJoin, true)
    assert.equal(inspected.physicalStarts, 98)
    assert.equal(lstatSync(directory).mode & 0o777, 0o700)
    assert.equal(lstatSync(resolve(directory, 'report.json')).mode & 0o777, 0o600)
    assert.throws(() => writer.write('report.json', report))
    symlinkSync(resolve(directory, 'report.json'), resolve(directory, 'symlink.json'))
    assert.throws(() => writer.write('symlink.json', report))
  } finally {
    // This directory was created by this test's UUID above; existing captures are never selected.
    rmSync(directory, { recursive: true })
  }
})

test('absolute cutoff consumes construction delay and never receives a fresh 55-second budget', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), f = fixture(p), timers = timerHarness(54999)
  const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, timed(f, timers))
  const cutoff = assertCutoffTimerCleared(timers)
  assert.equal(cutoff.delay, 1)
  assert.equal(cutoff.at, 55000)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.failure, 'morpho_v2_rlusd_idle_holder_acquisition_deadline')
  assert.equal(capture.acquisitionExpired, true)
  assert.equal(capture.cutoffTimerCleared, true)
  assert.ok(capture.physicalStarts <= 2)
  assert.ok(capture.elapsedMs < 60000)
  const originals = morphoV2RlusdIdleHolderEncodedOriginals(capture)
  const restored = reconstructMorphoV2RlusdIdleHolderOriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
})

test('no remaining acquisition time creates zero physical starts and clears both timers', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), timers = timerHarness(55000)
  let starts = 0
  const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, timed({
    fetcher: async () => { starts++; throw Error('late_native_start') },
  }, timers))
  assert.equal(assertCutoffTimerCleared(timers).delay, 0)
  assert.equal(starts, 0)
  assert.equal(capture.physicalStarts, 0)
  assert.equal(capture.scheduledReads, 0)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.failure, 'morpho_v2_rlusd_idle_holder_acquisition_deadline')
  assert.equal(capture.receipt.pendingSettlements, 0)
  const originals = morphoV2RlusdIdleHolderEncodedOriginals(capture)
  assert.equal(originals.rows.length, 0)
  assert.equal(reconstructMorphoV2RlusdIdleHolderOriginalControl(originals.summary, [], false).receipt.physicalStarts, 0)
})

test('pending original body is aborted at the absolute cutoff and cannot become accepted', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), timers = timerHarness(54997)
  let bodyEntered, bodyAborted = false, bodyCancelled = false
  const entered = new Promise((resolve) => { bodyEntered = resolve })
  const stream = new ReadableStream({
    pull() { return new Promise(() => {}) },
    cancel() { bodyCancelled = true },
  })
  const originalGetReader = stream.getReader.bind(stream)
  stream.getReader = () => { const reader = originalGetReader(); bodyEntered(); return reader }
  const capturePromise = captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, timed({ fetcher: async (_url, options) => {
    options.signal.addEventListener('abort', () => { bodyAborted = true }, { once: true })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
  } }, timers))
  await entered
  timers.advance(3)
  const capture = await capturePromise
  assertCutoffTimerCleared(timers)
  assert.equal(bodyAborted, true)
  assert.equal(bodyCancelled, true)
  assert.equal(capture.physicalStarts, 1)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.failure, 'morpho_v2_rlusd_idle_holder_acquisition_deadline')
  assert.equal(capture.receipt.pendingSettlements, 0)
  assert.ok(capture.receipt.ledger.every((row) => row.accepted === false && row.status === 'failed'))
  assert.ok(capture.elapsedMs < 60000)
  const originals = morphoV2RlusdIdleHolderEncodedOriginals(capture)
  const restored = reconstructMorphoV2RlusdIdleHolderOriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
})

test('complete 98-start path and native failure both clear every original and cutoff timer', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory()
  for (const failAt of [null, 41]) {
    const f = fixture(p, { failAt }), timers = timerHarness()
    const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, timed(f, timers))
    assertCutoffTimerCleared(timers)
    assert.equal(capture.cutoffTimerCleared, true)
    assert.equal(capture.completeNativeAcquisition, failAt === null)
    assert.equal(capture.qualifiedNativeJoin, failAt === null)
    if (failAt === null) {
      assert.equal(capture.physicalStarts, 98)
      assert.equal(capture.points[1].probeSharesRaw, FRESH_S)
      assert.equal(capture.points[1].actualHistoricalOwnerSharesRaw, '0')
      assert.equal(capture.points[1].historicalOwnedEntitlementAssetRaw, null)
    }
  }
})

test('cutoff timer arm failure still finishes and clears the immutable controller timer', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), timers = timerHarness(0, 2)
  const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, timed(fixture(p), timers))
  assert.equal(capture.physicalStarts, 0)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.cutoffTimerCleared, true)
  assert.equal(timers.armed.length, 1)
  assert.ok(timers.cleared.includes(timers.armed[0].id))
  assert.equal(timers.active.size, 0)
})

test('absolute-cutoff partial originals are retained and replayed inside the 60-second outer window', async () => {
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory(), timers = timerHarness(54999)
  const capture = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, timed(fixture(p), timers))
  const directory = resolve(ROOT, 'data/research/venue-signals/morpho-v2-rlusd-idle-holder-capture-v1-unit-partial-' + randomUUID())
  const writer = createMorphoV2RlusdIdleHolderWriter(directory, ['local-never-retained-secret-' + randomUUID()], {
    clock: timers.monotonic, started: 0,
  })
  try {
    for (const artifact of morphoV2RlusdIdleHolderFixedArtifacts(p)) writer.write(artifact.name, artifact.value)
    const originals = morphoV2RlusdIdleHolderEncodedOriginals(capture)
    for (const row of originals.rows) writer.write(row.name, row.value)
    writer.write('control-summary.json', originals.summary)
    const report = morphoV2RlusdIdleHolderReport(capture, p); writer.write('report.json', report)
    writer.verifyRetained()
    const terminal = seal({ schema: 'morpho_v2_rlusd_idle_holder_terminal_v1', reportSha256: report.sha256,
      completeNativeAcquisition: false, qualifiedNativeJoin: false, failure: capture.failure,
      currentSource: capture.currentSource, physicalStarts: capture.physicalStarts, pendingSettlements: 0,
      retainedRows: originals.rows.length,
      preTerminalRetentionCheckedAtUtc: new Date(timers.now()).toISOString(), retentionClockStage: 'before_terminal_write', elapsedMs: timers.monotonic(),
      acquisitionDeadlineElapsedMs: 55000, retentionReserveMs: 5000,
      files: writer.refs.map(({ dev, ino, ...ref }) => ref), ...MORPHO_V2_RLUSD_IDLE_HOLDER_FLAGS })
    writer.write('terminal.json', terminal, true); writer.verifyRetained()
    const inspected = inspectMorphoV2RlusdIdleHolderRetainedHistory(directory)
    assert.equal(inspected.status, 'retained_partial_control_only')
    assert.equal(inspected.originalControlVerified, false)
    assert.equal(inspected.qualifiedNativeJoin, false)
    assert.equal(inspected.physicalStarts, capture.physicalStarts)
    assert.ok(inspected.physicalStarts > 0)
    assert.equal(inspected.report.cutoffTimerCleared, true)
    assert.ok(timers.monotonic() <= 60000)
    timers.advance(5001)
    assert.throws(() => writer.write('late.json', { noAuthority: true }))
  } finally { rmSync(directory, { recursive: true }) }
})

test('original controller rechecks early wakes and keeps all paired host dispatches at least250ms apart', async () => {
  const p=prepareMorphoV2RlusdIdleHolderIdleHistory(), f=fixture(p), timers=timerHarness()
  const starts=new Map(hosts.map((host)=>[host,[]]))
  const capture=await captureMorphoV2RlusdIdleHolderIdleHistory(p,origins,timed({...f,
    fetcher:async(url,options)=>{starts.get(new URL(url).hostname).push(timers.monotonic());return f.fetcher(url,options)},
  },{...timers,pace:async(ms)=>timers.advance(Math.max(1,Math.min(ms,7)))}))
  assert.equal(capture.completeNativeAcquisition,true)
  assert.equal(capture.physicalStarts,98)
  for(const values of starts.values())for(let i=1;i<values.length;i++)assert.ok(values[i]-values[i-1]>=250)
  assert.equal(capture.nativeTransport.pendingBodies,0)
  assert.equal(capture.nativeTransport.allNativeBodiesSettled,true)
  assertCutoffTimerCleared(timers)
})

test('awaits body cancellation settlement before a dispatch leaves the active native set', async () => {
  let clock=0, releaseCancel, canceled
  const cancellationEntered=new Promise((r)=>{canceled=r})
  const body=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){canceled();return new Promise((r)=>{releaseCancel=r})}})
  const transport=createMorphoV2RlusdIdleHolderNativeTransport(origins,{clock:()=>clock,deadline:100,
    fetcher:async()=>new Response(body,{status:200})})
  const response=await transport.fetcher(origins[0].url,{method:'POST',body:'{}'})
  const reader=response.body.getReader(); const pending=reader.read().catch(()=>null)
  transport.stop();await cancellationEntered
  assert.equal(transport.summary().pendingBodies,1)
  let settled=false;const finish=transport.settle().then(()=>{settled=true})
  await Promise.resolve();assert.equal(settled,false)
  releaseCancel();await pending;await finish
  assert.equal(transport.summary().pendingBodies,0)
})

test('abort before HTTP response arrival cancels the later body and pre-reader header failures cancel their native bodies', async () => {
  let resolveResponse, cancelCalls=0, clock=0
  const transport=createMorphoV2RlusdIdleHolderNativeTransport(origins,{clock:()=>clock,deadline:100,
    fetcher:()=>new Promise((r)=>{resolveResponse=r})})
  const pending=transport.fetcher(origins[0].url,{method:'POST',body:'{}'}).catch(()=>null)
  transport.stop();assert.equal(transport.summary().pendingBodies,1)
  resolveResponse(new Response(new ReadableStream({cancel(){cancelCalls++}}),{status:200}))
  await pending;await transport.settle()
  assert.equal(cancelCalls,1);assert.equal(transport.summary().pendingBodies,0)
  const rejected=createMorphoV2RlusdIdleHolderNativeTransport(origins,{clock:()=>clock,deadline:100,
    fetcher:async()=>new Response(new ReadableStream({cancel(){cancelCalls++}}),{status:200,headers:{'content-length':'65537'}})})
  await assert.rejects(rejected.fetcher(origins[0].url,{method:'POST',body:'{}'}))
  await rejected.settle();assert.equal(cancelCalls,2);assert.equal(rejected.summary().pendingBodies,0)
})

test('selected prepared anchor objects use nested canonical sources through all98 physical starts', async () => {
  const p=prepareMorphoV2RlusdIdleHolderIdleHistory(),f=fixture(p)
  assert.ok(p.plan.anchors.every((anchor)=>!Object.hasOwn(anchor,'blockNumber') && anchor.source.blockNumber))
  const capture=await captureMorphoV2RlusdIdleHolderIdleHistory(p,origins,f)
  assert.equal(capture.completeNativeAcquisition,true)
  assert.equal(capture.physicalStarts,98)
  assert.equal(f.calls(),98)
  assert.deepEqual(capture.points.slice(1).map((x)=>x.source),p.plan.anchors.map((x)=>x.source))
})

async function finalRetentionFixture() {
  const prepared=prepareMorphoV2RlusdIdleHolderIdleHistory(),timers=timerHarness()
  const capture=await captureMorphoV2RlusdIdleHolderIdleHistory(prepared,origins,timed(fixture(prepared),timers))
  assert.equal(capture.completeNativeAcquisition,true)
  const directory=resolve(ROOT,'data/research/venue-signals/morpho-v2-rlusd-idle-holder-capture-v1-final-unit-'+randomUUID())
  const writer=createMorphoV2RlusdIdleHolderWriter(directory,[],{clock:timers.monotonic,started:0})
  for(const row of morphoV2RlusdIdleHolderFixedArtifacts(prepared))writer.write(row.name,row.value)
  const originals=morphoV2RlusdIdleHolderEncodedOriginals(capture)
  for(const row of originals.rows)writer.write(row.name,row.value)
  writer.write('control-summary.json',originals.summary)
  const report=morphoV2RlusdIdleHolderReport(capture,prepared);writer.write('report.json',report)
  writer.write('terminal.json',seal({schema:'morpho_v2_rlusd_idle_holder_terminal_v1',pairIndex:58,
    reportSha256:report.sha256,completeNativeAcquisition:true,qualifiedNativeJoin:true,
    currentSource:capture.currentSource,physicalStarts:98,pendingSettlements:0,
    preTerminalRetentionCheckedAtUtc:new Date(timers.now()).toISOString(),retentionClockStage:'before_terminal_write',
    elapsedMs:timers.monotonic(),files:writer.refs.map(({dev,ino,...ref})=>ref),...MORPHO_V2_RLUSD_IDLE_HOLDER_FLAGS}),true)
  return {prepared,capture,timers,directory,writer}
}

test('final completion stamp is sampled after terminal readback and source pin verification',async()=>{
  const f=await finalRetentionFixture()
  try {
    const before=f.timers.monotonic()
    const delayed={verifyRetained(){f.writer.verifyRetained();f.timers.advance(2)}}
    const value=finalizeMorphoV2RlusdIdleHolderRetention(delayed,f.prepared,f.capture,{clock:f.timers.monotonic,now:f.timers.now,started:0})
    assert.equal(value.postRetentionElapsedMs,before+2)
    assert.equal(value.postRetentionCompletedAtUtc,new Date(f.timers.now()).toISOString())
    assert.equal(value.retentionCompletionClockStage,'after_terminal_readback_and_source_pin_checks')
  }finally{rmSync(f.directory,{recursive:true})}
})

test('final readback that crosses the30-minute source-age boundary rejects final acceptance',async()=>{
  const f=await finalRetentionFixture()
  try {
    let finalWall=Date.parse(f.capture.currentSource.blockTime)+1799999
    const delayed={verifyRetained(){f.writer.verifyRetained();finalWall+=2}}
    assert.throws(()=>finalizeMorphoV2RlusdIdleHolderRetention(delayed,f.prepared,f.capture,
      {clock:f.timers.monotonic,now:()=>finalWall,started:0}),/final_retention_source_age/)
    assert.equal(lstatSync(resolve(f.directory,'terminal.json')).mode&0o777,0o600)
  }finally{rmSync(f.directory,{recursive:true})}
})

test('final readback that crosses the60-second outer boundary rejects final acceptance',async()=>{
  const f=await finalRetentionFixture()
  try {
    f.timers.advance(59999-f.timers.monotonic())
    const delayed={verifyRetained(){f.writer.verifyRetained();f.timers.advance(2)}}
    assert.throws(()=>finalizeMorphoV2RlusdIdleHolderRetention(delayed,f.prepared,f.capture,
      {clock:f.timers.monotonic,now:f.timers.now,started:0}),/final_retention_deadline_or_reserve/)
    assert.equal(lstatSync(resolve(f.directory,'terminal.json')).nlink,1)
  }finally{rmSync(f.directory,{recursive:true})}
})

test('unverified owner hypothesis is resolved by30 original reads; zero stock stops before any preview or history',async()=>{
  const p=prepareMorphoV2RlusdIdleHolderIdleHistory(),f=fixture(p,{zeroStock:true})
  assert.equal(p.plan.ownerHypothesis.status,'unverified_root_provided_lead')
  assert.equal(p.plan.ownerHypothesis.positiveStockClaim,false)
  const capture=await captureMorphoV2RlusdIdleHolderIdleHistory(p,origins,f)
  assert.equal(capture.physicalStarts,30);assert.equal(capture.freshCurrentSharesRaw,'0')
  assert.equal(capture.freshOwnerCodeStatus,'no_code');assert.equal(capture.failure,'morpho_v2_rlusd_idle_holder_fresh_current_stock_zero')
  assert.equal(capture.points.length,0);assert.equal(capture.pointStatuses.length,3)
  assert.equal(capture.pointStatuses[0].roles.find((x)=>x.key.endsWith(':actual_owner_shares')).pairedValue,'0')
  assert.ok(capture.pointStatuses.slice(1).every((x)=>x.eligibleFixedStockEndpoint===false&&x.roles.every((r)=>r.physicalIds.length===0)))
  assert.equal(f.requests.filter((x)=>x.method==='eth_call'&&decodeFunctionData({abi:MORPHO_V2_RLUSD_IDLE_HOLDER_ABI,data:x.params[0].data}).functionName==='previewRedeem').length,0)
  const originals=morphoV2RlusdIdleHolderEncodedOriginals(capture)
  const restored=reconstructMorphoV2RlusdIdleHolderOriginalControl(originals.summary,originals.rows.map((x)=>x.value),false)
  assert.deepEqual(restored.receipt,capture.receipt);assert.deepEqual(restored.settlements,capture.settlements)
})

test('coded owner with positive S stops after30 reads and preserves code/stock facts without an Ea claim',async()=>{
  const p=prepareMorphoV2RlusdIdleHolderIdleHistory(),f=fixture(p,{ownerHasCode:true})
  const capture=await captureMorphoV2RlusdIdleHolderIdleHistory(p,origins,f)
  assert.equal(capture.physicalStarts,30);assert.equal(capture.freshCurrentSharesRaw,FRESH_S)
  assert.equal(capture.freshOwnerCodeStatus,'code_present');assert.equal(capture.failure,'morpho_v2_rlusd_idle_holder_fresh_owner_has_code')
  assert.equal(capture.points.length,0);assert.equal(capture.qualifiedNativeJoin,false)
  assert.equal(capture.pointStatuses[0].roles.find((x)=>x.key.endsWith(':owner_code')).pairedValue.runtimeByteLength,2)
  assert.equal(capture.nativeTransport.pendingBodies,0);assert.equal(capture.receipt.pendingSettlements,0)
})

test('native18/18 cash and full fresh S previews join all98 reads without1e18/Q/ratio substitutions',async()=>{
  const p=prepareMorphoV2RlusdIdleHolderIdleHistory(),f=fixture(p)
  const capture=await captureMorphoV2RlusdIdleHolderIdleHistory(p,origins,f)
  assert.equal(capture.completeNativeAcquisition,true);assert.equal(capture.physicalStarts,98)
  const previews=f.requests.filter((x)=>x.method==='eth_call').map((x)=>decodeFunctionData({abi:MORPHO_V2_RLUSD_IDLE_HOLDER_ABI,data:x.params[0].data})).filter((x)=>x.functionName==='previewRedeem')
  assert.equal(previews.length,6);assert.ok(previews.every((x)=>String(x.args[0])===FRESH_S))
  assert.notEqual(FRESH_S,'1000000000000000000');assert.notEqual(FRESH_S,'500000000000000000')
  assert.equal(capture.points[0].freshCurrentFullEaAssetRaw,'3000000000000000000')
  assert.equal(capture.points[1].actualHistoricalOwnerSharesRaw,'0')
  assert.equal(capture.points[1].historicalOwnedEntitlementAssetRaw,null)
  assert.ok(capture.points.every((x)=>x.nativeAssetDecimals===18&&x.nativeShareDecimals===18&&x.cashAssetDecimals===18&&x.probeEaAssetDecimals===18))
  assert.equal(p.plan.futureQAssetRaw,null);assert.equal(capture.sourceImplementationEquivalence,false)
})

test('zero native current cash and historical full-S Ea remain measured outcomes; impossible historical S>TS is censored',async()=>{
  const p=prepareMorphoV2RlusdIdleHolderIdleHistory()
  const zero=await captureMorphoV2RlusdIdleHolderIdleHistory(p,origins,fixture(p,{zeroCurrentCash:true,zeroEa:true}))
  assert.equal(zero.qualifiedNativeJoin,true);assert.equal(zero.points[0].CAssetRaw,'0')
  assert.equal(zero.points[0].panelOutcome,'measured_zero_cash');assert.equal(zero.points[1].probeEaAssetRaw,'0')
  assert.equal(zero.points[1].panelOutcome,'measured_zero_entitlement')
  const invalid=await captureMorphoV2RlusdIdleHolderIdleHistory(p,origins,fixture(p,{impossibleStock:true}))
  assert.equal(invalid.completeNativeAcquisition,true);assert.equal(invalid.qualifiedNativeJoin,false)
  assert.equal(invalid.points[1].totalSupplySharesRaw,'0')
  assert.ok(invalid.pointStatuses[1].censorReasons.includes('probe_stock_exceeds_native_supply'))
  assert.equal(invalid.points[1].probeEaAssetRaw,'1800000000000000000')
})


test('native header declared and streamed byte 262145 fail and settle body cancellation; nonheaders stay 64 KiB', async () => {
  const headerRole = { key: 'fresh_finalized', method: 'eth_getBlockByNumber', role: 'native_header' }
  for (const declared of [true, false]) {
    let canceled = 0, emitted = false
    const body = new ReadableStream({ pull(controller) {
      if (!emitted) { emitted = true; controller.enqueue(new Uint8Array(262145)) }
    }, cancel() { canceled++ } }, { highWaterMark: 0 })
    const transport = createMorphoV2RlusdIdleHolderNativeTransport(origins, { clock: () => 0, deadline: 100,
      fetcher: async () => new Response(body, { headers: declared ? { 'content-length': '262145' } : {} }) })
    const options = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1,
      method: 'eth_getBlockByNumber', params: ['finalized', false] }), nativeHeaderRole: headerRole }
    if (declared) await assert.rejects(transport.fetcher(origins[0].url, options), /declared_body_bound/)
    else { const response = await transport.fetcher(origins[0].url, options)
      await assert.rejects(response.text(), /transport_body_bound/) }
    await transport.settle()
    assert.equal(canceled, 1); assert.equal(transport.summary().pendingBodies, 0)
  }
  const p = prepareMorphoV2RlusdIdleHolderIdleHistory()
  const failed = await captureMorphoV2RlusdIdleHolderIdleHistory(p, origins, fixture(p, { headerBytes: 262145 }))
  assert.equal(failed.completeNativeAcquisition, false)
  assert.equal(failed.nativeTransport.allNativeBodiesSettled, true)
})


test('writer rejects nested Base64 credential escapes before creating a private artifact', () => {
  const directory = resolve(ROOT, 'data/research/venue-signals/morpho-v2-rlusd-idle-holder-capture-v1-privacy-' + randomUUID())
  const secret = 'writerescapedfixturecredential'
  const writer = createMorphoV2RlusdIdleHolderWriter(directory, [secret])
  try {
    const escaped = [...secret].map((c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    const inner = Buffer.from(JSON.stringify({ [escaped]: 'innocent' })).toString('base64')
    const outer = Buffer.from(JSON.stringify({ rawBodyBase64: inner })).toString('base64')
    assert.throws(() => writer.write('secret.json', { rawBodyBase64: outer }), /credential_echo/)
    assert.throws(() => lstatSync(resolve(directory, 'secret.json')), /ENOENT/)
    assert.equal(writer.used(), 0); assert.equal(writer.refs.length, 0)
  } finally { rmSync(directory, { recursive: true }) }
})


test('writer rejects escaped Base64 suffix keys with x: credential alignment and nested escape layers before any file exists', () => {
  const directory = resolve(ROOT, 'data/research/venue-signals/morpho-v2-rlusd-idle-holder-capture-v1-privacy-key-' + randomUUID())
  const secret = 'writerescapedbase64suffixfixturecredential', slash = String.fromCharCode(92)
  const writer = createMorphoV2RlusdIdleHolderWriter(directory, [secret])
  try {
    for (const key of [
      'rawBodyBase' + slash + 'u0036' + '4',
      'rawBodyBase' + slash.repeat(2) + 'u0036' + '4',
      'rawBodyBase' + slash + 'u005c' + 'u0036' + '4',
      'rawBodyBase' + slash + 'u005c' + 'u005c' + 'u0036' + '4',
    ]) {
      const inner = Buffer.from(JSON.stringify({ result: 'x:' + secret })).toString('base64')
      let outer = Buffer.from(JSON.stringify({ [key]: inner })).toString('base64')
      for (let layers = 1; layers <= 3; layers++) {
        assert.throws(() => writer.write('escaped-key.json', { rawBodyBase64: outer }), /credential_echo/)
        assert.throws(() => lstatSync(resolve(directory, 'escaped-key.json')), /ENOENT/)
        assert.equal(writer.used(), 0); assert.equal(writer.refs.length, 0)
        outer = Buffer.from(JSON.stringify({ rawBodyBase64: outer })).toString('base64')
      }
    }
  } finally { rmSync(directory, { recursive: true }) }
})
