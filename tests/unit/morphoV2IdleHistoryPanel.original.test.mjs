/** Original physical controller tests. All responses are local fixtures; no RPC is acquired. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, encodeFunctionResult, encodeFunctionData } from 'viem'
import {
  finalizeMorphoV2IdlePanelRetention, createMorphoV2IdlePanelNativeTransport, morphoV2IdlePanelChronologicalRows, MORPHO_V2_IDLE_PANEL_STOCK,
  MORPHO_V2_IDLE_PANEL_ABI, MORPHO_V2_IDLE_PANEL_POLICY, MORPHO_V2_IDLE_PANEL_FLAGS, prepareMorphoV2IdlePanelIdleHistory,
  morphoV2IdlePanelPointReadPlan, morphoV2IdlePanelStorageBudgetProof, captureMorphoV2IdlePanelIdleHistory,
  deriveMorphoV2IdlePanelPoint, morphoV2IdlePanelEncodedOriginals, reconstructMorphoV2IdlePanelOriginalControl,
  assertMorphoV2IdlePanelDiskCapacity, morphoV2IdlePanelFixedArtifacts, createMorphoV2IdlePanelWriter,
  morphoV2IdlePanelReport, inspectMorphoV2IdlePanelRetainedHistory, runMorphoV2IdlePanelIdleHistory,
} from '../../scripts/research/morpho-v2-idle-history-panel-v1.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url)), ZERO = '0x' + '0'.repeat(40)
const sha = (x) => createHash('sha256').update(x).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const hosts = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const origins = hosts.map((host) => ({ host, url: 'https://' + host + '/local-pyusd-test-fixture' }))
const FRESH_S = '352805058661206444'
const nativeReply = (name, value) => encodeFunctionResult({ abi: MORPHO_V2_IDLE_PANEL_ABI, functionName: name, result: value })

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
  const cutoffs = timers.armed.filter((x) => x.name === 'stopAtMorphoV2IdlePanelAcquisitionDeadline')
  assert.equal(cutoffs.length, 1)
  assert.ok(timers.cleared.includes(cutoffs[0].id))
  assert.equal(timers.active.size, 0)
  return cutoffs[0]
}

function fixture(prepared, { drift = false, zeroStock = false, zeroEa = false, impossibleStock = false, incorrectHistoricalCash = false,
  wrongHeader = false, failAt = null } = {}) {
  const discovery = JSON.parse(prepared.inputs.find((x) => x.pin.path === prepared.plan.discoveryPath).bytes)
  const codeOf = (address) => {
    const row = discovery.control.ledger.find((r) => r.request.method === 'eth_getCode' && r.request.params[0] === address)
    assert.ok(row?.rawBodyBase64)
    return JSON.parse(Buffer.from(row.rawBodyBase64, 'base64')).result
  }
  const codes = { [prepared.plan.subject.vault]: codeOf(prepared.plan.subject.vault),
    [prepared.plan.subject.asset]: codeOf(prepared.plan.subject.asset), [prepared.plan.subject.owner]: '0x' }
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
        const { functionName, args } = decodeFunctionData({ abi: MORPHO_V2_IDLE_PANEL_ABI, data: r.params[0].data })
        let value
        if (functionName === 'asset') value = prepared.plan.subject.asset
        else if (functionName === 'decimals') value = r.params[0].to === prepared.plan.subject.asset ? 6 : 18
        else if (functionName === 'liquidityAdapter') value = drift && index === 1 ? '0x' + '11'.repeat(20) : ZERO
        else if (functionName === 'liquidityData') value = drift && index === 1 ? '0x01' : '0x'
        else if (functionName === 'totalAssets') value = 100000000000000n
        else if (functionName === 'totalSupply') value = impossibleStock && index === 1 ? 0n : 100000000000000000000000000n
        else if (functionName === 'balanceOf') {
          if (r.params[0].to === prepared.plan.subject.asset) {
            assert.equal(args[0].toLowerCase(), prepared.plan.subject.vault)
            value = index === 0 ? 40000000000000n : BigInt(prepared.plan.anchors[index - 1].expectedCashRaw)
            if (incorrectHistoricalCash && index === 1) value++
          } else {
            assert.equal(r.params[0].to, prepared.plan.subject.vault)
            assert.equal(args[0].toLowerCase(), prepared.plan.subject.owner)
            value = zeroStock && index === 0 ? 0n : index === 0 ? BigInt(FRESH_S) : index === 1 ? 0n : 100n
          }
        } else {
          assert.equal(functionName, 'previewRedeem')
          assert.equal(String(args[0]), FRESH_S)
          value = zeroEa && index === 1 ? 0n : zeroStock ? 0n : index === 0 ? 713973n : index === 1 ? 711000n : 711500n
        }
        result = nativeReply(functionName, value)
      }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return { requests, freshSource, fetcher, monotonic: () => elapsed,
    now: () => Date.parse('2026-10-10T05:10:00.000Z') + elapsed,
    pace: async (ms) => { elapsed += ms }, calls: () => calls }
}

test('closed dry plan performs no fetch and derives 98 starts under all original limits', async () => {
  const prepared = prepareMorphoV2IdlePanelIdleHistory(), before = globalThis.fetch
  globalThis.fetch = () => { throw Error('zero_RPC_control') }
  try {
    const value = await runMorphoV2IdlePanelIdleHistory(['--dry-plan'])
    assert.equal(value.status, 'closed_plan_no_RPC')
    assert.equal(value.proof.derivedWorstStarts, 98)
  } finally { globalThis.fetch = before }
  const proof = morphoV2IdlePanelStorageBudgetProof(prepared)
  assert.ok(proof.fixedSerializedBytes <= 2 * 1024 * 1024)
  assert.ok(proof.maximumLogicalBytes <= 10 * 1024 * 1024)
  assert.ok(proof.maximumAllocationExtra <= 3 * 1024 * 1024)
  assert.ok(proof.maximumFiles <= 131)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.pre, 269 * 1024 * 1024)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.reserve, 256 * 1024 * 1024)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.deadline, 60000)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.acquisitionDeadline, 55000)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.retentionReserve, 5000)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.stage, 12000)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.timeout, 8000)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.spacing, 250)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.workers, 1)
  assert.equal(MORPHO_V2_IDLE_PANEL_POLICY.retries, 0)
  assert.throws(() => assertMorphoV2IdlePanelDiskCapacity(BigInt(MORPHO_V2_IDLE_PANEL_POLICY.pre - 1), 0, false, true))
})

test('actual original controller joins S, full Ea and C with distinct units at all three points', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), f = fixture(p)
  const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, true)
  assert.equal(capture.qualifiedNativeJoin, true)
  assert.equal(capture.physicalStarts, 98)
  assert.equal(f.calls(), 98)
  assert.equal(capture.receipt.pendingSettlements, 0)
  assert.equal(capture.freshCurrentSharesRaw, FRESH_S)
  const [current, first, second] = capture.points
  assert.equal(current.freshCurrentFullEaAssetRaw, '713973')
  assert.equal(current.actualOwnerSharesRaw, FRESH_S)
  assert.equal(current.probeShareDecimals, 18)
  assert.equal(current.probeEaAssetDecimals, 6)
  assert.equal(current.cashAssetDecimals, 6)
  assert.equal(first.CAssetRaw, '27925379416535')
  assert.equal(second.CAssetRaw, '0')
  assert.equal(first.totalAssetsRaw, '100000000000000')
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
  const originals = morphoV2IdlePanelEncodedOriginals(capture)
  const restored = reconstructMorphoV2IdlePanelOriginalControl(originals.summary, originals.rows.map((x) => x.value))
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
  const mutated = structuredClone(originals.rows.map((x) => x.value))
  mutated[0].row.observation.rawBodyBase64 = Buffer.from('{"error":"replaced"}').toString('base64')
  assert.throws(() => reconstructMorphoV2IdlePanelOriginalControl(originals.summary, mutated))
  const badSource = structuredClone(originals.summary); badSource.source.blockHash = '0x' + 'de'.repeat(32)
  assert.throws(() => reconstructMorphoV2IdlePanelOriginalControl(badSource, originals.rows.map((x) => x.value)))
  for (const flag of ['holderExecutableExit', 'executionAuthority', 'forecastAuthority', 'forecastEligibility',
    'sourceImplementationEquivalence', 'calibrated', 'calibratedProbability', 'coveragePromotion']) assert.equal(capture[flag], false)
  assert.equal(capture.competingMRaw, null)
})

test('a configuration difference retains paired native facts and declines qualification', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), f = fixture(p, { drift: true })
  const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, true)
  assert.equal(capture.physicalStarts, 98)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.ok(capture.points[1].qualificationReasons.includes('idle_regime_differed'))
  assert.equal(capture.points[1].liquidityData, '0x01')
  assert.equal(capture.points[1].LLTVStatus, 'unmeasured')
  assert.equal(capture.points[1].probeEaAssetRaw, '711000')
  assert.equal(capture.points[2].qualifiedNativeJoin, true)
})

test('zero fresh stock and changed historical cash cannot qualify the historical hint', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory()
  for (const options of [{ zeroStock: true }, { incorrectHistoricalCash: true }]) {
    const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, fixture(p, options))
    assert.equal(capture.completeNativeAcquisition, !options.zeroStock)
    assert.equal(capture.qualifiedNativeJoin, false)
    assert.ok(capture.points.some((x) => x.qualificationReasons.length > 0))
  }
})

test('native provider failure preserves bounded partial original control without qualification', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), f = fixture(p, { failAt: 41 })
  const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.ok(capture.physicalStarts <= 41)
  assert.equal(capture.points.length, 1)
  const originals = morphoV2IdlePanelEncodedOriginals(capture)
  const restored = reconstructMorphoV2IdlePanelOriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
  assert.throws(() => reconstructMorphoV2IdlePanelOriginalControl(originals.summary, originals.rows.map((x) => x.value), true))
})

test('canonical source disagreement cannot qualify a native point', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), f = fixture(p, { wrongHeader: true })
  const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, f)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.points.length, 0)
  assert.ok(capture.physicalStarts <= 34)
  const originals = morphoV2IdlePanelEncodedOriginals(capture)
  assert.equal(originals.rows.length, capture.physicalStarts)
  assert.throws(() => reconstructMorphoV2IdlePanelOriginalControl(originals.summary, originals.rows.map((x) => x.value), true))
})

test('historical preview request cannot silently substitute actual historical stock', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), f = fixture(p)
  const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, f)
  const traces = structuredClone(capture.traces)
  for (const trace of traces.filter((x) => x.key === 'anchor_0:fixed_stock_preview'))
    trace.request.params[0].data = encodeFunctionData({ abi: MORPHO_V2_IDLE_PANEL_ABI, functionName: 'previewRedeem', args: [0n] })
  assert.throws(() => deriveMorphoV2IdlePanelPoint(traces, 'anchor_0', p.plan.anchors[0].source,
    FRESH_S, p.expectedRuntimes, p.plan.anchors[0].expectedCashRaw))
  const specs = morphoV2IdlePanelPointReadPlan('anchor_0', p.plan.anchors[0].source, FRESH_S)
  assert.equal(specs.length, 16)
  assert.equal(specs.filter((x) => x.method === 'eth_getBlockByNumber').length, 2)
  assert.equal(specs.filter((x) => x.method === 'eth_getCode').length, 3)
  assert.equal(specs.filter((x) => x.method === 'eth_getLogs').length, 0)
})

test('private immutable writer roundtrips all original rows and refuses overwrite and symlink', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, fixture(p))
  const directory = resolve(ROOT, 'data/research/venue-signals/morpho-v2-idle-history-panel-v1-unit-' + randomUUID())
  const writer = createMorphoV2IdlePanelWriter(directory, ['local-secret-never-in-fixtures-' + randomUUID()])
  try {
    for (const artifact of morphoV2IdlePanelFixedArtifacts(p)) writer.write(artifact.name, artifact.value)
    const originals = morphoV2IdlePanelEncodedOriginals(capture)
    for (const row of originals.rows) writer.write(row.name, row.value)
    writer.write('control-summary.json', originals.summary)
    const report = morphoV2IdlePanelReport(capture, p); writer.write('report.json', report)
    writer.verifyRetained()
    const terminal = seal({ schema: 'morpho_v2_idle_history_panel_terminal_v1', reportSha256: report.sha256,
      pairIndex: 58, completeNativeAcquisition: true, qualifiedNativeJoin: true, failure: null, currentSource: capture.currentSource,
      physicalStarts: capture.physicalStarts, pendingSettlements: 0, retainedRows: originals.rows.length,
      preTerminalRetentionCheckedAtUtc: '2026-10-10T05:10:30.000Z', retentionClockStage: 'before_terminal_write', elapsedMs: 30000,
      acquisitionDeadlineElapsedMs: 55000, retentionReserveMs: 5000,
      files: writer.refs.map(({ dev, ino, ...ref }) => ref), ...MORPHO_V2_IDLE_PANEL_FLAGS })
    writer.write('terminal.json', terminal, true)
    const inspected = inspectMorphoV2IdlePanelRetainedHistory(directory)
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
  const p = prepareMorphoV2IdlePanelIdleHistory(), f = fixture(p), timers = timerHarness(54999)
  const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, timed(f, timers))
  const cutoff = assertCutoffTimerCleared(timers)
  assert.equal(cutoff.delay, 1)
  assert.equal(cutoff.at, 55000)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.failure, 'morpho_v2_idle_panel_acquisition_deadline')
  assert.equal(capture.acquisitionExpired, true)
  assert.equal(capture.cutoffTimerCleared, true)
  assert.ok(capture.physicalStarts <= 2)
  assert.ok(capture.elapsedMs < 60000)
  const originals = morphoV2IdlePanelEncodedOriginals(capture)
  const restored = reconstructMorphoV2IdlePanelOriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.requests), JSON.stringify(capture.requests))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
})

test('no remaining acquisition time creates zero physical starts and clears both timers', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), timers = timerHarness(55000)
  let starts = 0
  const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, timed({
    fetcher: async () => { starts++; throw Error('late_native_start') },
  }, timers))
  assert.equal(assertCutoffTimerCleared(timers).delay, 0)
  assert.equal(starts, 0)
  assert.equal(capture.physicalStarts, 0)
  assert.equal(capture.scheduledReads, 0)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.failure, 'morpho_v2_idle_panel_acquisition_deadline')
  assert.equal(capture.receipt.pendingSettlements, 0)
  const originals = morphoV2IdlePanelEncodedOriginals(capture)
  assert.equal(originals.rows.length, 0)
  assert.equal(reconstructMorphoV2IdlePanelOriginalControl(originals.summary, [], false).receipt.physicalStarts, 0)
})

test('pending original body is aborted at the absolute cutoff and cannot become accepted', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), timers = timerHarness(54997)
  let bodyEntered, bodyAborted = false, bodyCancelled = false
  const entered = new Promise((resolve) => { bodyEntered = resolve })
  const stream = new ReadableStream({
    pull() { return new Promise(() => {}) },
    cancel() { bodyCancelled = true },
  })
  const originalGetReader = stream.getReader.bind(stream)
  stream.getReader = () => { const reader = originalGetReader(); bodyEntered(); return reader }
  const capturePromise = captureMorphoV2IdlePanelIdleHistory(p, origins, timed({ fetcher: async (_url, options) => {
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
  assert.equal(capture.failure, 'morpho_v2_idle_panel_acquisition_deadline')
  assert.equal(capture.receipt.pendingSettlements, 0)
  assert.ok(capture.receipt.ledger.every((row) => row.accepted === false && row.status === 'failed'))
  assert.ok(capture.elapsedMs < 60000)
  const originals = morphoV2IdlePanelEncodedOriginals(capture)
  const restored = reconstructMorphoV2IdlePanelOriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
})

test('complete 98-start path and native failure both clear every original and cutoff timer', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory()
  for (const failAt of [null, 41]) {
    const f = fixture(p, { failAt }), timers = timerHarness()
    const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, timed(f, timers))
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
  const p = prepareMorphoV2IdlePanelIdleHistory(), timers = timerHarness(0, 2)
  const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, timed(fixture(p), timers))
  assert.equal(capture.physicalStarts, 0)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.cutoffTimerCleared, true)
  assert.equal(timers.armed.length, 1)
  assert.ok(timers.cleared.includes(timers.armed[0].id))
  assert.equal(timers.active.size, 0)
})

test('absolute-cutoff partial originals are retained and replayed inside the 60-second outer window', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), timers = timerHarness(54999)
  const capture = await captureMorphoV2IdlePanelIdleHistory(p, origins, timed(fixture(p), timers))
  const directory = resolve(ROOT, 'data/research/venue-signals/morpho-v2-idle-history-panel-v1-unit-partial-' + randomUUID())
  const writer = createMorphoV2IdlePanelWriter(directory, ['local-never-retained-secret-' + randomUUID()], {
    clock: timers.monotonic, started: 0,
  })
  try {
    for (const artifact of morphoV2IdlePanelFixedArtifacts(p)) writer.write(artifact.name, artifact.value)
    const originals = morphoV2IdlePanelEncodedOriginals(capture)
    for (const row of originals.rows) writer.write(row.name, row.value)
    writer.write('control-summary.json', originals.summary)
    const report = morphoV2IdlePanelReport(capture, p); writer.write('report.json', report)
    writer.verifyRetained()
    const terminal = seal({ schema: 'morpho_v2_idle_history_panel_terminal_v1', reportSha256: report.sha256,
      pairIndex: 58, completeNativeAcquisition: false, qualifiedNativeJoin: false, failure: capture.failure,
      currentSource: capture.currentSource, physicalStarts: capture.physicalStarts, pendingSettlements: 0,
      retainedRows: originals.rows.length,
      preTerminalRetentionCheckedAtUtc: new Date(timers.now()).toISOString(), retentionClockStage: 'before_terminal_write', elapsedMs: timers.monotonic(),
      acquisitionDeadlineElapsedMs: 55000, retentionReserveMs: 5000,
      files: writer.refs.map(({ dev, ino, ...ref }) => ref), ...MORPHO_V2_IDLE_PANEL_FLAGS })
    writer.write('terminal.json', terminal, true); writer.verifyRetained()
    const inspected = inspectMorphoV2IdlePanelRetainedHistory(directory)
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

test('calendar commits120 ordered cash endpoints, strict40/40/40 splits and59 new jobs before Ea acquisition', () => {
  const p = prepareMorphoV2IdlePanelIdleHistory()
  assert.equal(p.plan.panelPoints.length, 120)
  assert.equal(p.plan.anchors[0].panelIndex, 116)
  assert.equal(p.plan.anchors[1].panelIndex, 117)
  assert.equal(p.plan.anchors[1].expectedCashRaw, '0')
  assert.deepEqual(p.plan.splits.map((x) => [x.firstIndex, x.lastIndex]), [[0,39],[40,79],[80,119]])
  assert.deepEqual(p.plan.collectionOrder, [58, ...Array.from({length:58}, (_,i)=>i)])
  assert.equal(p.plan.existingNativePairIndex, 59)
  assert.equal(p.plan.priorInspection.untouchedHoldoutClaim, false)
  assert.throws(() => prepareMorphoV2IdlePanelIdleHistory(60))
  const fixed = morphoV2IdlePanelFixedArtifacts(p)
  assert.deepEqual(fixed.map((x) => x.name), ['plan.json','provenance.json'])
  assert.equal(fixed[1].value.duplicatedSourceCompanions, false)
})

test('zero cash and zero full-S entitlement are measured native targets; zeroTS is explicitly censored', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory()
  const zero = await captureMorphoV2IdlePanelIdleHistory(p, origins, fixture(p,{zeroEa:true}))
  assert.equal(zero.completeNativeAcquisition,true)
  assert.equal(zero.qualifiedNativeJoin,true)
  assert.equal(zero.points[1].probeEaAssetRaw,'0')
  assert.equal(zero.points[1].panelOutcome,'measured_zero_entitlement')
  assert.equal(zero.points[2].CAssetRaw,'0')
  assert.equal(zero.pointStatuses[2].status,'measured_zero_cash')
  const impossible = await captureMorphoV2IdlePanelIdleHistory(p, origins, fixture(p,{impossibleStock:true}))
  assert.equal(impossible.points[1].totalSupplySharesRaw,'0')
  assert.equal(impossible.points[1].probeEaAssetRaw,'711000')
  assert.equal(impossible.points[1].stockFeasibleWithinNativeSupply,false)
  assert.ok(impossible.pointStatuses[1].censorReasons.includes('probe_stock_exceeds_native_supply'))
})

test('changed fresh stock preserves current native facts and both planned historical censors without following changed S', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), f = fixture(p,{zeroStock:true})
  const capture = await captureMorphoV2IdlePanelIdleHistory(p,origins,f)
  assert.equal(capture.physicalStarts,34)
  assert.equal(capture.freshCurrentSharesRaw,'0')
  assert.equal(capture.points[0].probeSharesRaw,FRESH_S)
  assert.equal(capture.points[0].freshCurrentFullEaAssetRaw,null)
  assert.equal(capture.completeNativeAcquisition,false)
  assert.equal(capture.failure,'morpho_v2_idle_panel_frozen_current_stock_changed')
  assert.deepEqual(capture.pointStatuses.slice(1).map((x)=>x.panelIndex),[116,117])
  assert.ok(capture.pointStatuses.slice(1).every((x)=>x.eligibleFixedStockEndpoint===false && x.censorReasons.length===1))
})

test('exact H24 endpoints and strict earlier donors preserve cold starts and missing labels', async () => {
  const p = prepareMorphoV2IdlePanelIdleHistory(), capture = await captureMorphoV2IdlePanelIdleHistory(p,origins,fixture(p))
  const rows = morphoV2IdlePanelChronologicalRows(p,capture.points)
  assert.equal(rows[0].targetPanelIndex,117)
  assert.equal(rows[0].actualTargetDeltaMs,86400000)
  assert.equal(rows[0].endpointCapacityAssetRaw,'0')
  assert.ok(rows.every((x)=>x.coldStart && x.strictlyEarlierDonorIntervals.length===0))
  assert.equal(rows[1].labelStatus,'exact_H24_native_endpoint_unavailable')
  const last=prepareMorphoV2IdlePanelIdleHistory(59)
  assert.equal(morphoV2IdlePanelChronologicalRows(last,[])[1].labelStatus,'exact_H24_target_not_in_catalog')
  const changed=structuredClone(p); changed.plan.panelPoints[117][3]='2026-10-01T00:00:00.000Z'
  const shifted=morphoV2IdlePanelChronologicalRows(changed,capture.points)
  assert.equal(shifted[0].targetPanelIndex,null)
  assert.equal(shifted[0].actualTargetDeltaMs,null)
  assert.equal(shifted[0].labelStatus,'exact_H24_target_not_in_catalog')
})

test('original controller rechecks early wakes and keeps all paired host dispatches at least250ms apart', async () => {
  const p=prepareMorphoV2IdlePanelIdleHistory(), f=fixture(p), timers=timerHarness()
  const starts=new Map(hosts.map((host)=>[host,[]]))
  const capture=await captureMorphoV2IdlePanelIdleHistory(p,origins,timed({...f,
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
  const transport=createMorphoV2IdlePanelNativeTransport(origins,{clock:()=>clock,deadline:100,
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
  const transport=createMorphoV2IdlePanelNativeTransport(origins,{clock:()=>clock,deadline:100,
    fetcher:()=>new Promise((r)=>{resolveResponse=r})})
  const pending=transport.fetcher(origins[0].url,{method:'POST',body:'{}'}).catch(()=>null)
  transport.stop();assert.equal(transport.summary().pendingBodies,1)
  resolveResponse(new Response(new ReadableStream({cancel(){cancelCalls++}}),{status:200}))
  await pending;await transport.settle()
  assert.equal(cancelCalls,1);assert.equal(transport.summary().pendingBodies,0)
  const rejected=createMorphoV2IdlePanelNativeTransport(origins,{clock:()=>clock,deadline:100,
    fetcher:async()=>new Response(new ReadableStream({cancel(){cancelCalls++}}),{status:200,headers:{'content-length':'65537'}})})
  await assert.rejects(rejected.fetcher(origins[0].url,{method:'POST',body:'{}'}))
  await rejected.settle();assert.equal(cancelCalls,2);assert.equal(rejected.summary().pendingBodies,0)
})

test('selected prepared anchor objects use nested canonical sources through all98 physical starts', async () => {
  const p=prepareMorphoV2IdlePanelIdleHistory(58),f=fixture(p)
  assert.ok(p.plan.anchors.every((anchor)=>!Object.hasOwn(anchor,'blockNumber') && anchor.source.blockNumber))
  const capture=await captureMorphoV2IdlePanelIdleHistory(p,origins,f)
  assert.equal(capture.completeNativeAcquisition,true)
  assert.equal(capture.physicalStarts,98)
  assert.equal(f.calls(),98)
  assert.deepEqual(capture.points.slice(1).map((x)=>x.source),p.plan.anchors.map((x)=>x.source))
})

async function finalRetentionFixture() {
  const prepared=prepareMorphoV2IdlePanelIdleHistory(),timers=timerHarness()
  const capture=await captureMorphoV2IdlePanelIdleHistory(prepared,origins,timed(fixture(prepared),timers))
  assert.equal(capture.completeNativeAcquisition,true)
  const directory=resolve(ROOT,'data/research/venue-signals/morpho-v2-idle-history-panel-v1-final-unit-'+randomUUID())
  const writer=createMorphoV2IdlePanelWriter(directory,[],{clock:timers.monotonic,started:0})
  for(const row of morphoV2IdlePanelFixedArtifacts(prepared))writer.write(row.name,row.value)
  const originals=morphoV2IdlePanelEncodedOriginals(capture)
  for(const row of originals.rows)writer.write(row.name,row.value)
  writer.write('control-summary.json',originals.summary)
  const report=morphoV2IdlePanelReport(capture,prepared);writer.write('report.json',report)
  writer.write('terminal.json',seal({schema:'morpho_v2_idle_history_panel_terminal_v1',pairIndex:58,
    reportSha256:report.sha256,completeNativeAcquisition:true,qualifiedNativeJoin:true,
    currentSource:capture.currentSource,physicalStarts:98,pendingSettlements:0,
    preTerminalRetentionCheckedAtUtc:new Date(timers.now()).toISOString(),retentionClockStage:'before_terminal_write',
    elapsedMs:timers.monotonic(),files:writer.refs.map(({dev,ino,...ref})=>ref),...MORPHO_V2_IDLE_PANEL_FLAGS}),true)
  return {prepared,capture,timers,directory,writer}
}

test('final completion stamp is sampled after terminal readback and source pin verification',async()=>{
  const f=await finalRetentionFixture()
  try {
    const before=f.timers.monotonic()
    const delayed={verifyRetained(){f.writer.verifyRetained();f.timers.advance(2)}}
    const value=finalizeMorphoV2IdlePanelRetention(delayed,f.prepared,f.capture,{clock:f.timers.monotonic,now:f.timers.now,started:0})
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
    assert.throws(()=>finalizeMorphoV2IdlePanelRetention(delayed,f.prepared,f.capture,
      {clock:f.timers.monotonic,now:()=>finalWall,started:0}),/final_retention_source_age/)
    assert.equal(lstatSync(resolve(f.directory,'terminal.json')).mode&0o777,0o600)
  }finally{rmSync(f.directory,{recursive:true})}
})

test('final readback that crosses the60-second outer boundary rejects final acceptance',async()=>{
  const f=await finalRetentionFixture()
  try {
    f.timers.advance(59999-f.timers.monotonic())
    const delayed={verifyRetained(){f.writer.verifyRetained();f.timers.advance(2)}}
    assert.throws(()=>finalizeMorphoV2IdlePanelRetention(delayed,f.prepared,f.capture,
      {clock:f.timers.monotonic,now:f.timers.now,started:0}),/final_retention_deadline_or_reserve/)
    assert.equal(lstatSync(resolve(f.directory,'terminal.json')).nlink,1)
  }finally{rmSync(f.directory,{recursive:true})}
})
