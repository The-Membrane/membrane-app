/** Local original-controller fixtures and closed native-censor inputs. No RPC is acquired. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  MORPHO_V2_IDLE_HEADER_BACKFILL_ABI, MORPHO_V2_IDLE_HEADER_BACKFILL_POLICY,
  MORPHO_V2_IDLE_HEADER_BACKFILL_FLAGS, MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK,
  prepareMorphoV2IdleHeaderBackfillIdleHistory, captureMorphoV2IdleHeaderBackfillIdleHistory,
  morphoV2IdleHeaderBackfillStorageBudgetProof, morphoV2IdleHeaderBackfillResponseCap,
  validateMorphoV2IdleHeaderBackfillDescriptor, createMorphoV2IdleHeaderBackfillControl,
  createMorphoV2IdleHeaderBackfillNativeTransport, morphoV2IdleHeaderBackfillEncodedOriginals,
  reconstructMorphoV2IdleHeaderBackfillOriginalControl, encodeHeaderBackfillNativeRow,
  decodeHeaderBackfillNativeRow, assertMorphoV2IdleHeaderBackfillPrivacy, assertMorphoV2IdleHeaderBackfillRawPrivacy,
  morphoV2IdleHeaderBackfillFixedArtifacts, createMorphoV2IdleHeaderBackfillWriter,
  morphoV2IdleHeaderBackfillReport, inspectMorphoV2IdleHeaderBackfillRetainedHistory,
  finalizeMorphoV2IdleHeaderBackfillRetention, runMorphoV2IdleHeaderBackfillIdleHistory,
} from '../../scripts/research/morpho-v2-idle-history-header-backfill-v1.mjs'
const ROOT = fileURLToPath(new URL('../../', import.meta.url)), ZERO = '0x' + '0'.repeat(40)
const sha = (x) => createHash('sha256').update(x).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const hosts = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const origins = hosts.map((host) => ({ host, url: 'https://' + host + '/local-header-backfill-test-fixture' }))
const DESCRIPTOR_PIN = Object.freeze({
  path: '/private/tmp/morpho-v2-idle-parent-payloads-22b85f4d-e6df-470a-a5c6-5ac8f1493020/failed-slots.json',
  bytes: 6973, fileSha256: '19ec5426fb74aa946e2f2f2b168a5e38840d3d6aa96c296bb9f70666a609f9e4',
})
const FRESH_S = '352805058661206444'
const nativeReply = (name, value) => encodeFunctionResult({ abi: MORPHO_V2_IDLE_HEADER_BACKFILL_ABI, functionName: name, result: value })
const prepare = (pairIndex = 10) => prepareMorphoV2IdleHeaderBackfillIdleHistory(pairIndex, DESCRIPTOR_PIN)
const cli = (command, pair = 10) => [command, '--pair=' + pair, '--descriptor=' + DESCRIPTOR_PIN.path,
  '--descriptor-sha=' + DESCRIPTOR_PIN.fileSha256]
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
  const cutoffs = timers.armed.filter((x) => x.name === 'stopAtMorphoV2IdleHeaderBackfillAcquisitionDeadline')
  assert.equal(cutoffs.length, 1)
  assert.ok(timers.cleared.includes(cutoffs[0].id))
  assert.equal(timers.active.size, 0)
  return cutoffs[0]
}

function fixture(prepared, { drift = false, zeroStock = false, zeroEa = false, impossibleStock = false, incorrectHistoricalCash = false,
  wrongHeader = false, failAt = null, headerPadding = 0, nonheaderPadding = 0 } = {}) {
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
        const { functionName, args } = decodeFunctionData({ abi: MORPHO_V2_IDLE_HEADER_BACKFILL_ABI, data: r.params[0].data })
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
    // Synthetic filler exercises byte admission; it is not an acquired native historical value.
    if (r.method === 'eth_getBlockByNumber' && headerPadding) result.syntheticFixturePadding = 'x'.repeat(headerPadding)
    const envelope = { jsonrpc: '2.0', id: r.id, result }
    if (r.method !== 'eth_getBlockByNumber' && nonheaderPadding) envelope.syntheticFixturePadding = 'x'.repeat(nonheaderPadding)
    return new Response(JSON.stringify(envelope), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return { requests, freshSource, fetcher, monotonic: () => elapsed,
    now: () => Date.parse('2026-10-10T05:10:00.000Z') + elapsed,
    pace: async (ms) => { elapsed += ms }, calls: () => calls }
}


test('ready=false, missing pins, duplicate slots and nonfailed slots cannot authorize preparation', () => {
  const descriptor = JSON.parse(readFileSync(DESCRIPTOR_PIN.path))
  assert.throws(() => validateMorphoV2IdleHeaderBackfillDescriptor({ ...descriptor, ready: false }, 10))
  const missing = structuredClone(descriptor); delete missing.slots[0].files['report.json']
  assert.throws(() => validateMorphoV2IdleHeaderBackfillDescriptor(missing, 10))
  const duplicate = structuredClone(descriptor); duplicate.slots.push(duplicate.slots[0])
  assert.throws(() => validateMorphoV2IdleHeaderBackfillDescriptor(duplicate, 10))
  assert.throws(() => prepareMorphoV2IdleHeaderBackfillIdleHistory(10))
  assert.throws(() => prepare(58))
  assert.throws(() => prepareMorphoV2IdleHeaderBackfillIdleHistory(10, { ...DESCRIPTOR_PIN, fileSha256: '0'.repeat(64) }))
})
test('all five parent-pinned originals bind last failed canonical headers and shared source commitments', () => {
  for (const pair of [10,15,24,33,34]) {
    const p = prepare(pair)
    assert.equal(p.descriptor.pairIndex, pair)
    assert.match(p.descriptor.failedRole, /^anchor_[01]:header_before$/)
    assert.equal(p.descriptor.originalThrownReasonRetained, false)
    assert.equal(p.descriptor.underlyingProviderCauseConfirmed, false)
    assert.equal(p.descriptor.automaticRetry, false)
    assert.equal(p.plan.sharedCompanionManifestPin.fileSha256, '833372762bb8f59a0e3e5d37fed01069eaa80ffa21c9106c2c011ab73a37d830')
  }
})
test('closed header role and original method jointly select256KiB; every nonheader remains64KiB', () => {
  const header = { method:'eth_getBlockByNumber', params:['0xabc',false] }
  assert.equal(morphoV2IdleHeaderBackfillResponseCap(header,'anchor_0:header_before'),262144)
  assert.equal(morphoV2IdleHeaderBackfillResponseCap({method:'eth_getBlockByNumber',params:['finalized',false]},'fresh_finalized'),262144)
  assert.equal(morphoV2IdleHeaderBackfillResponseCap({method:'eth_call',params:[]},'current:fixed_stock_preview'),65536)
  assert.equal(morphoV2IdleHeaderBackfillResponseCap({method:'eth_getCode',params:[]},'anchor_1:vault_code'),65536)
  for (const [request, role] of [[header,'current:idle_cash'],[header,'anchor_2:header_before'],
    [{method:'eth_getCode',params:[]},'current:header_before'],
    [{method:'eth_getBlockByNumber',params:['0xabc',true]},'anchor_0:header_after']])
    assert.throws(() => morphoV2IdleHeaderBackfillResponseCap(request,role))
})
test('zero-RPC plan derives98 starts and encoded worst case below6MiB without source duplication', async () => {
  const before = globalThis.fetch
  globalThis.fetch = () => { throw Error('no_native_fetch_allowed') }
  try {
    for (const command of ['--verify','--dry-plan']) {
      const result = await runMorphoV2IdleHeaderBackfillIdleHistory(cli(command))
      assert.equal(result.proof.derivedWorstStarts,98)
      assert.ok(result.proof.maximumLogicalBytes < 6*1024*1024)
      assert.equal(result.policy.file,1048576); assert.equal(result.policy.response,65536)
      assert.equal(result.policy.headerResponse,262144)
      assert.equal(result.policy.acquisitionDeadline,55000); assert.equal(result.policy.retentionReserve,5000)
    }
  } finally { globalThis.fetch = before }
  assert.equal(morphoV2IdleHeaderBackfillFixedArtifacts(prepare()).length,2)
})
test('100KiB synthetic native-format headers retain full bodies through98 starts and lossless replay', async () => {
  const p=prepare(), timers=timerHarness(), f=fixture(p,{headerPadding:100000})
  const capture=await captureMorphoV2IdleHeaderBackfillIdleHistory(p,origins,timed(f,timers))
  assert.equal(f.calls(),98);assert.equal(capture.completeNativeAcquisition,true);assert.equal(capture.qualifiedNativeJoin,true)
  assertCutoffTimerCleared(timers)
  const headers=capture.receipt.ledger.filter((x)=>x.request.method==='eth_getBlockByNumber')
  assert.equal(headers.length,14);assert.ok(headers.every((x)=>x.bodyBytes>65536&&x.bodyBytes<=262144))
  const originals=morphoV2IdleHeaderBackfillEncodedOriginals(capture)
  const restored=reconstructMorphoV2IdleHeaderBackfillOriginalControl(originals.summary,originals.rows.map((x)=>x.value))
  assert.deepEqual(restored.receipt,capture.receipt);assert.deepEqual(restored.requests,capture.requests)
  assert.deepEqual(restored.settlements,capture.settlements)
  assert.ok(originals.rows.every((x)=>x.value.row.request.key===x.value.row.observation.nativeRole))
})
test('above256KiB header is partial with settled body and never widens any other role', async () => {
  const p=prepare(),timers=timerHarness(),f=fixture(p,{headerPadding:262144})
  const capture=await captureMorphoV2IdleHeaderBackfillIdleHistory(p,origins,timed(f,timers))
  assert.equal(capture.completeNativeAcquisition,false);assert.equal(capture.qualifiedNativeJoin,false)
  assert.equal(capture.physicalStarts,1);assert.equal(capture.receipt.pendingSettlements,0)
  assert.equal(capture.nativeTransport.pendingBodies,0);assertCutoffTimerCleared(timers)
  const originals=morphoV2IdleHeaderBackfillEncodedOriginals(capture)
  const restored=reconstructMorphoV2IdleHeaderBackfillOriginalControl(originals.summary,originals.rows.map((x)=>x.value),false)
  assert.deepEqual(restored.receipt,capture.receipt)
})
test('a64KiB-plus nonheader response fails after finalized headers without further dispatch', async () => {
  const p=prepare(),timers=timerHarness(),f=fixture(p,{nonheaderPadding:65536})
  const capture=await captureMorphoV2IdleHeaderBackfillIdleHistory(p,origins,timed(f,timers))
  assert.equal(capture.completeNativeAcquisition,false);assert.equal(capture.physicalStarts,3)
  assert.equal(capture.receipt.ledger.at(-1).nativeRole,'current:chain')
  assert.equal(capture.receipt.pendingSettlements,0);assertCutoffTimerCleared(timers)
})
test('altered native role or resealed request-to-role mismatch cannot pass lossless storage', async () => {
  const p=prepare(),timers=timerHarness(),capture=await captureMorphoV2IdleHeaderBackfillIdleHistory(p,origins,timed(fixture(p,{headerPadding:70000}),timers))
  const originals=morphoV2IdleHeaderBackfillEncodedOriginals(capture),first=originals.rows[0]
  const restored=decodeHeaderBackfillNativeRow(first.value,first.context)
  restored.observation.nativeRole='current:idle_cash';restored.settlement=seal({...restored.settlement,observation:structuredClone(restored.observation)})
  assert.throws(()=>encodeHeaderBackfillNativeRow(restored,first.context))
  const another=decodeHeaderBackfillNativeRow(first.value,first.context)
  another.request.key='anchor_0:header_after'
  assert.throws(()=>encodeHeaderBackfillNativeRow(another,first.context))
})
test('credential scan covers the entire widened retained raw body, including escaped trailing content', () => {
  const secret='header-tail-private-credential',text=JSON.stringify({padding:'x'.repeat(70000),tail:secret})
  assert.throws(()=>assertMorphoV2IdleHeaderBackfillPrivacy({rawBodyBase64:Buffer.from(text).toString('base64')},[secret]))
  assert.equal(assertMorphoV2IdleHeaderBackfillPrivacy({rawBodyBase64:Buffer.from(JSON.stringify({padding:'x'.repeat(70000)})).toString('base64')},[secret]),true)
})
test('current stock change stops before historical reads; full-S historical probes never use Q', async () => {
  const p=prepare(),timers=timerHarness(),f=fixture(p,{zeroStock:true})
  const partial=await captureMorphoV2IdleHeaderBackfillIdleHistory(p,origins,timed(f,timers))
  assert.equal(partial.completeNativeAcquisition,false);assert.equal(partial.qualifiedNativeJoin,false)
  assert.ok(!partial.receipt.ledger.some((x)=>x.nativeRole.startsWith('anchor_')))
  const t=timerHarness(),g=fixture(p),full=await captureMorphoV2IdleHeaderBackfillIdleHistory(p,origins,timed(g,t))
  for(const row of full.receipt.ledger.filter((x)=>x.nativeRole.endsWith(':fixed_stock_preview'))) {
    const decoded=decodeFunctionData({abi:MORPHO_V2_IDLE_HEADER_BACKFILL_ABI,data:row.request.params[0].data})
    assert.equal(String(decoded.args[0]),FRESH_S);assert.notEqual(String(decoded.args[0]),'500000')
  }
})
test('large aggregate header originals cross3MiB once as honest partial and remain below6MiB', async () => {
  const p=prepare(),timers=timerHarness(),f=fixture(p,{headerPadding:240000})
  const capture=await captureMorphoV2IdleHeaderBackfillIdleHistory(p,origins,timed(f,timers))
  assert.equal(capture.completeNativeAcquisition,false);assert.equal(capture.qualifiedNativeJoin,false)
  assert.equal(capture.receipt.pendingSettlements,0)
  const originals=morphoV2IdleHeaderBackfillEncodedOriginals(capture)
  assert.ok(originals.rawBytes>3*1024*1024);assert.ok(originals.rawBytes<=3*1024*1024+262144)
  const total=originals.rows.reduce((n,x)=>n+Buffer.byteLength(JSON.stringify(x.value)+'\n'),0)
  assert.ok(total<morphoV2IdleHeaderBackfillStorageBudgetProof(p).maximumLogicalBytes)
  assert.deepEqual(reconstructMorphoV2IdleHeaderBackfillOriginalControl(originals.summary,originals.rows.map((x)=>x.value),false).receipt,capture.receipt)
})

test('no remaining acquisition time creates zero physical starts and clears both timers', async () => {
  const p = prepare(), timers = timerHarness(55000)
  let starts = 0
  const capture = await captureMorphoV2IdleHeaderBackfillIdleHistory(p, origins, timed({
    fetcher: async () => { starts++; throw Error('late_native_start') },
  }, timers))
  assert.equal(assertCutoffTimerCleared(timers).delay, 0)
  assert.equal(starts, 0)
  assert.equal(capture.physicalStarts, 0)
  assert.equal(capture.scheduledReads, 0)
  assert.equal(capture.completeNativeAcquisition, false)
  assert.equal(capture.qualifiedNativeJoin, false)
  assert.equal(capture.failure, 'morpho_v2_idle_header_backfill_acquisition_deadline')
  assert.equal(capture.receipt.pendingSettlements, 0)
  const originals = morphoV2IdleHeaderBackfillEncodedOriginals(capture)
  assert.equal(originals.rows.length, 0)
  assert.equal(reconstructMorphoV2IdleHeaderBackfillOriginalControl(originals.summary, [], false).receipt.physicalStarts, 0)
})


test('pending original body is aborted at the absolute cutoff and cannot become accepted', async () => {
  const p = prepare(), timers = timerHarness(54997)
  let bodyEntered, bodyAborted = false, bodyCancelled = false
  const entered = new Promise((resolve) => { bodyEntered = resolve })
  const stream = new ReadableStream({
    pull() { return new Promise(() => {}) },
    cancel() { bodyCancelled = true },
  })
  const originalGetReader = stream.getReader.bind(stream)
  stream.getReader = () => { const reader = originalGetReader(); bodyEntered(); return reader }
  const capturePromise = captureMorphoV2IdleHeaderBackfillIdleHistory(p, origins, timed({ fetcher: async (_url, options) => {
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
  assert.equal(capture.failure, 'morpho_v2_idle_header_backfill_acquisition_deadline')
  assert.equal(capture.receipt.pendingSettlements, 0)
  assert.ok(capture.receipt.ledger.every((row) => row.accepted === false && row.status === 'failed'))
  assert.ok(capture.elapsedMs < 60000)
  const originals = morphoV2IdleHeaderBackfillEncodedOriginals(capture)
  const restored = reconstructMorphoV2IdleHeaderBackfillOriginalControl(originals.summary, originals.rows.map((x) => x.value), false)
  assert.equal(JSON.stringify(restored.receipt), JSON.stringify(capture.receipt))
  assert.equal(JSON.stringify(restored.settlements), JSON.stringify(capture.settlements))
})


test('exclusive private retention replays new-schema100KiB headers and refuses added files or changed bytes',async()=>{
  const prepared=prepare(),timers=timerHarness(),capture=await captureMorphoV2IdleHeaderBackfillIdleHistory(prepared,origins,timed(fixture(prepared,{headerPadding:100000}),timers))
  const directory=resolve(ROOT,'data/research/venue-signals/morpho-v2-idle-history-header-backfill-v1-unit-'+randomUUID())
  const writer=createMorphoV2IdleHeaderBackfillWriter(directory,[],{clock:timers.monotonic,started:0})
  try {
    for(const fixed of morphoV2IdleHeaderBackfillFixedArtifacts(prepared))writer.write(fixed.name,fixed.value)
    const originals=morphoV2IdleHeaderBackfillEncodedOriginals(capture)
    for(const row of originals.rows)writer.write(row.name,row.value)
    writer.write('control-summary.json',originals.summary)
    const report=morphoV2IdleHeaderBackfillReport(capture,prepared);writer.write('report.json',report)
    writer.write('terminal.json',seal({schema:'morpho_v2_idle_history_header_backfill_terminal_v1',pairIndex:10,
      descriptorPin:DESCRIPTOR_PIN,reportSha256:report.sha256,completeNativeAcquisition:true,qualifiedNativeJoin:true,
      currentSource:capture.currentSource,physicalStarts:98,pendingSettlements:0,elapsedMs:timers.monotonic(),
      files:writer.refs.map(({dev,ino,...ref})=>ref),...MORPHO_V2_IDLE_HEADER_BACKFILL_FLAGS}),true)
    assert.equal(lstatSync(directory).mode&0o777,0o700)
    assert.ok(writer.refs.every((x)=>lstatSync(resolve(directory,x.file)).mode%512===0o600))
    assert.ok(writer.used()<=6*1024*1024)
    const replay=inspectMorphoV2IdleHeaderBackfillRetainedHistory(directory)
    assert.equal(replay.originalControlVerified,true);assert.equal(replay.physicalStarts,98)
    assert.equal(replay.report.responseBytePolicy.header,262144)
    assert.equal(replay.report.automaticRetry,false)
    assert.throws(()=>writer.write('report.json',report))
    const extra=resolve(directory,'unlisted-unit-only.json')
    writeFileSync(extra,'{}\n',{flag:'wx',mode:0o600})
    try {assert.throws(()=>inspectMorphoV2IdleHeaderBackfillRetainedHistory(directory),/retained_closed_inventory/)}
    finally {rmSync(extra)}
    const reportPath=resolve(directory,'report.json'),originalBytes=readFileSync(reportPath),changed=Buffer.from(originalBytes)
    // Same length and valid JSON whitespace: only the committed original file digest changes.
    changed[changed.length-1]=0x20;writeFileSync(reportPath,changed)
    try {assert.throws(()=>inspectMorphoV2IdleHeaderBackfillRetainedHistory(directory),/retained_pin/)}
    finally {writeFileSync(reportPath,originalBytes)}
    assert.equal(finalizeMorphoV2IdleHeaderBackfillRetention(writer,prepared,capture,{clock:timers.monotonic,now:timers.now,started:0}).retentionCompletionClockStage,'after_terminal_readback_and_source_pin_checks')
  } finally {rmSync(directory,{recursive:true,force:true})}
})

test('exact256KiB synthetic canonical-header response passes transport, controller and lossless codec together',async()=>{
  const timers=timerHarness(),request={jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:['finalized',false]}
  const value={jsonrpc:'2.0',id:1,result:{hash:'0x'+'ab'.repeat(32),number:'0xabc',timestamp:'0x1',syntheticPadding:''}}
  value.result.syntheticPadding='x'.repeat(262144-Buffer.byteLength(JSON.stringify(value)))
  const bytes=Buffer.from(JSON.stringify(value));assert.equal(bytes.length,262144)
  const transport=createMorphoV2IdleHeaderBackfillNativeTransport(origins,{clock:timers.monotonic,deadline:55000,
    fetcher:async()=>new Response(bytes,{status:200,headers:{'content-length':String(bytes.length)}})})
  const control=createMorphoV2IdleHeaderBackfillControl(origins,{...timers,fetcher:transport.fetcher})
  control.beginStage('exact_header_bound')
  const response=await control.fetcher(origins[0].url,{method:'POST',redirect:'error',body:JSON.stringify(request),nativeRole:'fresh_finalized'})
  assert.equal(Buffer.byteLength(await response.text()),262144)
  const receipt=await control.finish();await transport.settle()
  assert.equal(receipt.ledger[0].accepted,true);assert.equal(receipt.ledger[0].bodyBytes,262144)
  assert.equal(receipt.pendingSettlements,0);assert.equal(transport.summary().pendingBodies,0);assert.equal(timers.active.size,0)
  const namespace='historical-owner-native-exact-bound',observation=receipt.ledger[0]
  const original={namespace,physicalId:1,request:{controlNamespace:namespace,physicalId:1,rpcId:1,key:'fresh_finalized',host:hosts[0],
    requestBodyBase64:Buffer.from(JSON.stringify(request)).toString('base64'),requestBodySha256:sha(JSON.stringify(request))},
    observation,settlement:control.settlementReceipts[0],...Object.fromEntries(Object.entries(MORPHO_V2_IDLE_HEADER_BACKFILL_FLAGS).slice(0,12))}
  const context={namespace,physicalId:1,source:null,rowJsonSha256:sha(JSON.stringify(original)),
    observationJsonSha256:sha(JSON.stringify(observation)),settlementJsonSha256:sha(JSON.stringify(original.settlement))}
  const encoded=encodeHeaderBackfillNativeRow(original,context)
  assert.deepEqual(decodeHeaderBackfillNativeRow(encoded,context),original)
})
test('valid measured zero full-S entitlement remains a native endpoint rather than a censor',async()=>{
  const p=prepare(),timers=timerHarness(),capture=await captureMorphoV2IdleHeaderBackfillIdleHistory(p,origins,timed(fixture(p,{zeroEa:true}),timers))
  assert.equal(capture.completeNativeAcquisition,true);assert.equal(capture.qualifiedNativeJoin,true)
  const point=capture.points.find((x)=>x.label==='anchor_0'),status=capture.pointStatuses.find((x)=>x.label==='anchor_0')
  assert.equal(point.probeEaAssetRaw,'0');assert.equal(status.status,'measured_zero_entitlement')
  assert.equal(status.eligibleFixedStockEndpoint,true);assert.equal(status.historicalOwnedEntitlementAssetRaw,null)
})

test('restored privacy second pass rejects nested textual unicode/hex escapes and nested JSON slash escapes',()=>{
  const secret='nested/private/token'
  const unicode=[...secret].map((x)=>'\\u'+x.codePointAt(0).toString(16).padStart(4,'0')).join('')
  const hex=[...secret].map((x)=>'\\x'+x.codePointAt(0).toString(16).padStart(2,'0')).join('')
  const nestedJson=JSON.stringify({level:JSON.stringify({message:secret}).replaceAll('/','\\/')})
  for(const value of [{sourceText:unicode},{sourceText:hex},{sourceText:nestedJson}]) {
    // This asserts the concrete former defect, rather than assuming the first pass already rejects.
    assert.equal(assertMorphoV2IdleHeaderBackfillRawPrivacy(value,[secret]),true)
    assert.throws(()=>assertMorphoV2IdleHeaderBackfillPrivacy(value,[secret]),/credential_echo/)
  }
})


test('raw Base64 body receives unicode/hex and nested JSON slash privacy checks',()=>{
  const secret='raw/private/test-token'
  const unicode=[...secret].map((x)=>'\\u'+x.codePointAt(0).toString(16).padStart(4,'0')).join('')
  const hex=[...secret].map((x)=>'\\x'+x.codePointAt(0).toString(16).padStart(2,'0')).join('')
  const nestedJson=JSON.stringify({level:JSON.stringify({message:secret}).replaceAll('/','\\/')})
  for(const message of [unicode,hex,nestedJson]) {
    const value={rawBodyBase64:Buffer.from(JSON.stringify({message})).toString('base64')}
    assert.equal(assertMorphoV2IdleHeaderBackfillRawPrivacy(value,[secret]),true)
    assert.throws(()=>assertMorphoV2IdleHeaderBackfillPrivacy(value,[secret]),/credential_echo/)
  }
})
