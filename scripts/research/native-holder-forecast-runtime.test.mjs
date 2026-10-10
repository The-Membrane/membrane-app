import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createObservedFetch,
  LIMITS,
  loadSubjects,
  writeRuntimeArtifact,
} from './native-holder-forecast-runtime.mjs'
const URLs = ['https://eth-mainnet.g.alchemy.com/test-secret', 'https://rpc.ankr.com/test-secret']
const body = (id = 1, method = 'eth_chainId') =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: [] })
const response = (id = 1, result = '0x1') =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
const limits = { ...LIMITS, spacingMs: 0, deadlineMs: 1000, rpcMs: 100, cleanupMs: 10 }
const fetch = (o, u = URLs[0], id = 1, method) =>
  o.fetch(u, { method: 'POST', body: body(id, method) })
test('fixed public locators retain their own native units; no historical locator is current authority', () => {
  const seeds = loadSubjects()
  assert.deepEqual(
    seeds.map((s) => [s.kind, s.decimals, s.requestedRaw]),
    [
      ['susds', 18, '1000000000000000000'],
      ['comet', 6, '1000000'],
    ],
  )
  assert.ok(seeds.every((s) => s.locatorIsCurrentAuthority === false))
  assert.equal(loadSubjects('stusds')[0].decimals, 18)
  assert.throws(() => loadSubjects('foreign'))
})
test('approved immutable endpoint snapshot; caller URL mutations do not redirect requests', async () => {
  const urls = [...URLs],
    called = []
  const o = createObservedFetch(urls, {
    limits,
    fetcher: async (u) => {
      called.push(u)
      return response()
    },
  })
  urls[0] = 'https://foreign.example/key'
  await fetch(o)
  assert.deepEqual(called, [URLs[0]])
  assert.equal((await o.finish()).physicalStarts, 1)
  assert.ok(!JSON.stringify(o.traces).includes('test-secret'))
})
test('exact approved pair and readonly methods; foreign endpoint rejects before physical start', async () => {
  assert.throws(() => createObservedFetch(['https://foreign.example/a', URLs[1]]))
  const o = createObservedFetch(URLs, { limits, fetcher: async () => response() })
  await assert.rejects(fetch(o, 'https://foreign.example/x'))
  assert.equal((await o.finish()).physicalStarts, 0)
  const p = createObservedFetch(URLs, { limits, fetcher: async () => response() })
  await assert.rejects(fetch(p, URLs[0], 1, 'eth_sendRawTransaction'))
  assert.equal((await p.finish()).physicalStarts, 0)
})
test('one per-host inflight plus completion-to-next spacing', async () => {
  let active = 0,
    max = 0,
    firstEnd = 0,
    secondStart = 0
  const o = createObservedFetch(URLs, {
    limits: { ...limits, spacingMs: 50 },
    fetcher: async (u, i) => {
      const id = JSON.parse(i.body).id
      active++
      max = Math.max(max, active)
      if (id === 2) secondStart = Date.now()
      await new Promise((r) => setTimeout(r, 10))
      active--
      if (id === 1) firstEnd = Date.now()
      return response(id)
    },
  })
  await Promise.all([fetch(o, URLs[0], 1), fetch(o, URLs[0], 2)])
  await o.finish()
  assert.equal(max, 1)
  assert.ok(secondStart - firstEnd >= 49)
})
test('physical cap closes queued starts, count includes every actual attempt', async () => {
  const o = createObservedFetch(URLs, {
    limits: { ...limits, requests: 2 },
    fetcher: async (u, i) => response(JSON.parse(i.body).id),
  })
  await fetch(o, URLs[0], 1)
  await fetch(o, URLs[1], 2)
  await assert.rejects(fetch(o, URLs[0], 3))
  const n = await o.finish()
  assert.equal(n.physicalStarts, 2)
  assert.equal(n.stopReason, 'physical_request_limit')
})
test('stream ingress bounded before parse; redirects explicitly disabled', async () => {
  let redirect
  const o = createObservedFetch(URLs, {
    limits: { ...limits, responseBytes: 64 },
    fetcher: async (u, i) => {
      redirect = i.redirect
      return new Response('x'.repeat(65))
    },
  })
  await assert.rejects(fetch(o))
  assert.equal(redirect, 'error')
  assert.equal((await o.finish()).stopReason, 'rpc_response_limit')
})
test('HTTP failure and RPC-ID mismatch close run without leaking private messages', async () => {
  for (const factory of [
    () => new Response('https://private/key', { status: 500 }),
    () => response(999),
  ]) {
    const o = createObservedFetch(URLs, { limits, fetcher: async () => factory() })
    await assert.rejects(fetch(o))
    await assert.rejects(fetch(o, URLs[1]))
    await o.finish()
    assert.equal(o.traces.length, 1)
    assert.ok(!JSON.stringify(o.traces).includes('private/key'))
  }
})
test('unsettled abort closes global run and already queued starts cannot escape', async () => {
  const o = createObservedFetch(URLs, {
    limits: { ...limits, rpcMs: 10, cleanupMs: 5 },
    fetcher: () => new Promise(() => {}),
  })
  const first = fetch(o)
  const second = fetch(o, URLs[0], 2)
  await assert.rejects(first)
  await assert.rejects(second)
  const n = await o.finish()
  assert.equal(n.physicalStarts, 1)
  assert.equal(n.stopReason, 'rpc_abort_unsettled')
  assert.equal(n.allSettled, false)
})
test('deadline stops physical requests including queues, without replacing source clocks', async () => {
  const o = createObservedFetch(URLs, {
    limits: { ...limits, deadlineMs: 10 },
    fetcher: async () => response(),
  })
  await new Promise((r) => setTimeout(r, 15))
  await assert.rejects(fetch(o))
  assert.equal((await o.finish()).physicalStarts, 0)
})
test('actual EVM revert remains bounded public stage evidence; transport error closes', async () => {
  const o = createObservedFetch(URLs, {
    limits,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: 3, message: 'private https://provider/key', data: '0x1234' },
        }),
      ),
  })
  const r = await fetch(o)
  assert.equal((await r.json()).error.code, 3)
  const n = await o.finish()
  assert.equal(n.stopReason, null)
  assert.deepEqual(o.traces[0].response.error, { code: 3, data: '0x1234' })
  assert.ok(!JSON.stringify(o.traces).includes('provider/key'))
})
test('exclusive artifact writer applies output/reserve/privacy guards, cleans only its own failed inode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-observer-'))
  const roomy = () => ({ bavail: 2000000000n, bsize: 1n })
  try {
    const saved = writeRuntimeArtifact(
      { status: 'test' },
      { directory, fs: { ...awaitlessFs(), statfsSync: roomy } },
    )
    assert.equal(readFileSync(saved.path, 'utf8'), '\u007b\n  "status": "test"\n}\n')
    assert.throws(() => writeRuntimeArtifact({ url: 'https://private/key' }, { directory }))
    assert.throws(() =>
      writeRuntimeArtifact({ x: 'a'.repeat(LIMITS.artifactBytes) }, { directory }),
    )
    const before = readdirSync(directory)
    assert.throws(() =>
      writeRuntimeArtifact(
        { x: 1 },
        { directory, fs: { ...awaitlessFs(), statfsSync: () => ({ bavail: 1n, bsize: 1n }) } },
      ),
    )
    assert.deepEqual(readdirSync(directory), before)
    const fs = awaitlessFs()
    assert.throws(() =>
      writeRuntimeArtifact(
        { x: 1 },
        {
          directory,
          fs: {
            ...fs,
            statfsSync: roomy,
            writeFileSync(fd) {
              fs.writeFileSync(fd, 'partial')
              throw Error('injected')
            },
          },
        },
      ),
    )
    assert.deepEqual(readdirSync(directory), before)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
import * as fs from 'node:fs'
function awaitlessFs() {
  return fs
}

import { nativeWireProof } from './native-holder-forecast-runtime.mjs'
import { parseAbi, encodeFunctionData, encodeFunctionResult } from 'viem'
import * as viem from 'viem'
function wireFixture(kind) {
  const seed = loadSubjects(kind)[0],
    hash = '0x' + 'a'.repeat(64)
  const source = { block: '1', blockHash: hash, observedAt: '2026-10-07T00:00:00.000Z' }
  const abi = parseAbi([
    'function withdraw(uint256 assets,address receiver,address owner) returns (uint256 shares)',
    'function withdraw(address asset,uint256 amount)',
    'function balanceOf(address owner) view returns (uint256)',
    'function previewRedeem(uint256 shares) view returns (uint256)',
  ])
  const traces = []
  for (const host of ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']) {
    const request = (fn, args, result, from) => ({
      host,
      request: {
        method: 'eth_call',
        params: [
          {
            to: seed.destination,
            ...(from ? { from } : {}),
            data: encodeFunctionData({ abi, functionName: fn, args }),
          },
          { blockHash: hash, requireCanonical: true },
        ],
      },
      response: { result: encodeFunctionResult({ abi, functionName: fn, result }) },
    })
    traces.push(request('balanceOf', [seed.owner], 5n * 10n ** BigInt(seed.decimals)))
    if (kind !== 'comet')
      traces.push(
        request(
          'previewRedeem',
          [5n * 10n ** BigInt(seed.decimals)],
          6n * 10n ** BigInt(seed.decimals),
        ),
      )
    traces.push(
      kind === 'comet'
        ? {
            host,
            request: {
              method: 'eth_call',
              params: [
                {
                  to: seed.destination,
                  from: seed.owner,
                  data: encodeFunctionData({
                    abi,
                    functionName: 'withdraw',
                    args: [seed.asset, BigInt(seed.requestedRaw)],
                  }),
                },
                { blockHash: hash, requireCanonical: true },
              ],
            },
            response: { result: '0x' },
          }
        : request('withdraw', [BigInt(seed.requestedRaw), seed.owner, seed.owner], 1n, seed.owner),
    )
    const header = {
      host,
      request: { method: 'eth_getBlockByNumber', params: ['0x1', false] },
      response: {
        result: {
          number: '0x1',
          hash,
          timestamp: '0x' + (BigInt(Date.parse(source.observedAt)) / 1000n).toString(16),
        },
      },
    }
    const first = traces.findIndex((t) => t.host === host)
    traces.splice(first, 0, header)
    traces.push(structuredClone(header))
  }
  traces.forEach((t, i) => {
    t.physicalRequest = i + 1
    t.startedAtUtc = new Date(Date.parse(source.observedAt) + i * 10).toISOString()
    t.completedAtUtc = new Date(Date.parse(source.observedAt) + i * 10 + 5).toISOString()
    t.settled = true
  })
  return {
    seed,
    source,
    traces,
    capacity: {
      quote: {
        entitlementRaw: String(BigInt(kind === 'comet' ? 5 : 6) * 10n ** BigInt(seed.decimals)),
      },
    },
  }
}
test('native wire decodes full owner entitlement and exact caller/Q for USDS18 and Comet6', () => {
  for (const kind of ['susds', 'comet']) {
    const f = wireFixture(kind)
    const p = nativeWireProof(
      f.seed,
      f.source,
      f.traces,
      viem,
      ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
      f.capacity,
    )
    assert.equal(p.length, 2)
    assert.ok(p.every((o) => o.fullEntitlementRaw === f.capacity.quote.entitlementRaw))
    const wrong = structuredClone(f)
    wrong.capacity.quote.entitlementRaw = '1'
    assert.throws(() =>
      nativeWireProof(
        wrong.seed,
        wrong.source,
        wrong.traces,
        viem,
        ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
        wrong.capacity,
      ),
    )
  }
})
test('native wire rejects caller/Q/pin/holder-balance-owner mutation independently', () => {
  for (const mutation of ['from', 'Q', 'pin', 'balanceOwner']) {
    const f = wireFixture('susds'),
      call = f.traces.find((t) => t.request.method === 'eth_call' && t.request.params[0].from)
    if (mutation === 'from') call.request.params[0].from = '0x' + '1'.repeat(40)
    if (mutation === 'Q')
      call.request.params[0].data =
        call.request.params[0].data.slice(0, 10) +
        '0'.repeat(63) +
        '2' +
        call.request.params[0].data.slice(74)
    if (mutation === 'pin') call.request.params[1] = 'latest'
    if (mutation === 'balanceOwner')
      f.traces.find(
        (t) =>
          t.request.method === 'eth_call' && t.request.params[0].data.slice(0, 10) === '0x70a08231',
      ).request.params[0].data = '0x70a08231' + '0'.repeat(24) + '1'.repeat(40)
    assert.throws(
      () =>
        nativeWireProof(
          f.seed,
          f.source,
          f.traces,
          viem,
          ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
          f.capacity,
        ),
      mutation,
    )
  }
})

import { requireWireEnclosure } from './native-holder-forecast-runtime.mjs'
test('native enclosure rejects headers all-before/all-after/reordered and mutated clocks', () => {
  for (const mutation of ['all_before', 'all_after', 'reordered', 'clock', 'array_clock']) {
    const f = wireFixture('susds')
    if (mutation === 'all_before' || mutation === 'all_after') {
      for (const t of f.traces) {
        const isHeader = t.request.method === 'eth_getBlockByNumber'
        const ms = isHeader === (mutation === 'all_before') ? 0 : 2000
        t.startedAtUtc = new Date(Date.parse(f.source.observedAt) + ms).toISOString()
        t.completedAtUtc = new Date(Date.parse(f.source.observedAt) + ms + 1).toISOString()
      }
    }
    if (mutation === 'reordered') [f.traces[0], f.traces[1]] = [f.traces[1], f.traces[0]]
    if (mutation === 'clock') f.traces[1].completedAtUtc = f.source.observedAt
    if (mutation === 'array_clock') f.traces[1].startedAtUtc = [f.traces[1].startedAtUtc]
    assert.throws(
      () =>
        nativeWireProof(
          f.seed,
          f.source,
          f.traces,
          viem,
          ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
          f.capacity,
        ),
      mutation,
    )
  }
})
test('cash numeric pin requires the same source header and actual before/state/after enclosure', () => {
  const f = wireFixture('comet'),
    host = 'eth-mainnet.g.alchemy.com',
    states = f.traces.filter((t) => t.host === host && t.request.method === 'eth_call')
  for (const t of states) t.request.params[1] = '0x1'
  assert.ok(requireWireEnclosure(f.traces, host, f.source, states, { numericCashPin: true }))
  const t = states[0]
  t.request.params[1] = '0x2'
  assert.throws(() =>
    requireWireEnclosure(f.traces, host, f.source, states, { numericCashPin: true }),
  )
  t.request.params[1] = '0x1'
  const after = f.traces.findLast(
    (x) => x.host === host && x.request.method === 'eth_getBlockByNumber',
  )
  after.startedAtUtc = f.source.observedAt
  after.completedAtUtc = f.source.observedAt
  assert.throws(() =>
    requireWireEnclosure(f.traces, host, f.source, states, { numericCashPin: true }),
  )
})

import { execFileSync, spawnSync } from 'node:child_process'
import { safeHttpFacts } from './native-holder-forecast-runtime.mjs'
test('safe actual HTTP diagnostics preserve status/cache/error codes without untrusted messages', () => {
  assert.deepEqual(
    safeHttpFacts({
      status: 503,
      cacheControl: 'private, no-store, injected=https://secret/key',
      body: { error: 'route_forecast_evidence_unavailable', details: 'https://private/key' },
    }),
    {
      httpStatus: 503,
      cacheControlTokens: ['private', 'no-store'],
      errorCode: 'route_forecast_evidence_unavailable',
    },
  )
  assert.equal(
    safeHttpFacts({ status: 500, body: { error: 'https://private/key' } }).errorCode,
    null,
  )
})
test(
  'actual default handler in normal local Next mode accepts both real native questions with zero fetch',
  { timeout: 30000 },
  () => {
    const source = `
 let attempts=0;globalThis.fetch=async()=>{attempts++;throw Error('offline_network_forbidden')};
 const observer=await import('./scripts/research/native-holder-forecast-runtime.mjs');await observer.preflight();
 const modules=await observer.loadRuntimeModules(),handler=modules.forecast;
 const results=[];
 for(const seed of observer.loadSubjects()){
  let status=200,body;const headers={};
  await handler({method:'GET',query:{routeKey:seed.routeKey,destination:seed.destination,amountUnits:'1',horizonHours:'24',includeLiveCurrent:'0'},headers:{},socket:{remoteAddress:'127.0.0.1'}},{setHeader(k,v){headers[k.toLowerCase()]=v;return this},status(n){status=n;return this},json(v){body=v;return this}});
  const current=body?.sampledCashPaths?.current;
  const bound=modules.wb.withBoundSampledCashCurrentMetadata({routeKey:seed.routeKey,destination:seed.destination,assetAddress:seed.asset,assetDecimals:seed.decimals,cashRaw:current?.cashRaw,block:current?.block,blockHash:current?.blockHash,observedAt:current?.blockAt},current);
  if(!bound||typeof modules.card.ExitPressureCard!=='function'||typeof modules.cap.selectedHolderExitCapacity!=='function')throw Error('actual_exports_not_bound');
  results.push({kind:seed.kind,status,cacheControl:headers['cache-control'],error:typeof body?.error==='string'?body.error:null,asset:current?.asset,decimals:current?.assetDecimals,block:current?.block,blockHash:current?.blockHash,requestRaw:body?.conditionalSampledCashPathProjection?.request?.requestedRaw});
 }
 console.log(JSON.stringify({attempts,results}));`
    const text = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '--max-old-space-size=384' },
        encoding: 'utf8',
        timeout: 25000,
        maxBuffer: 65536,
      },
    )
    const actual = JSON.parse(text.trim())
    assert.equal(actual.attempts, 0)
    assert.equal(actual.results.length, 2)
    for (const r of actual.results) {
      const seed = loadSubjects(r.kind)[0]
      assert.equal(r.status, 200)
      assert.equal(r.cacheControl, 'no-store')
      assert.equal(r.error, null)
      assert.equal(r.asset, seed.asset)
      assert.equal(r.decimals, seed.decimals)
      assert.match(r.block, /^[1-9][0-9]*$/)
      assert.match(r.blockHash, /^0x[0-9a-f]{64}$/)
      if (r.requestRaw !== undefined) assert.equal(r.requestRaw, seed.requestedRaw)
    }
  },
)
test('CLI rejects wrong Next runtime mode before importing handlers or starting network', () => {
  const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=384' }
  delete env.NODE_ENV
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/research/native-holder-forecast-runtime.mjs', '--check-only'],
    { env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 },
  )
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stderr.trim()).code, 'next_development_mode_required')
})

test('actual SDK chainId request omits params; original wire body remains unchanged', async () => {
  const { createPublicClient, http } = await import('viem')
  let wire
  const observer = createObservedFetch(URLs, {
    limits,
    fetcher: async (_url, init) => {
      wire = init.body
      const q = JSON.parse(wire)
      return response(q.id)
    },
  })
  const client = createPublicClient({
    transport: http(URLs[0], { retryCount: 0, fetchFn: observer.fetch }),
  })
  assert.equal(await client.getChainId(), 1)
  assert.equal(Object.hasOwn(JSON.parse(wire), 'params'), false)
  assert.equal(Object.hasOwn(observer.traces[0].request, 'params'), false)
  const { createHash } = await import('node:crypto')
  assert.equal(
    observer.traces[0].requestBodySha256,
    createHash('sha256').update(wire).digest('hex'),
  )
  assert.equal((await observer.finish()).physicalStarts, 1)
  for (const q of [
    { method: 'eth_chainId', params: ['0x1'] },
    { method: 'eth_call' },
    { method: 'eth_chainId', params: null },
  ]) {
    const rejected = createObservedFetch(URLs, {
      limits,
      fetcher: async () => {
        assert.fail('malformed request reached transport')
      },
    })
    await assert.rejects(
      rejected.fetch(URLs[0], {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...q }),
      }),
      { safeCode: 'readonly_rpc_request' },
    )
    assert.equal((await rejected.finish()).physicalStarts, 0)
  }
})

test(
  'default live reader reaches observed bounded transport after actual preflight imports; no RPC',
  { timeout: 30000 },
  () => {
    const code = `
  let escaped=0;globalThis.fetch=async()=>{escaped++;throw Error('outside_observer_forbidden')};
  const o=await import('./scripts/research/native-holder-forecast-runtime.mjs');
  const prepared=await o.preflight(undefined,{importHandlers:false});let downstream=0;
  const observer=o.createObservedFetch(prepared.urls,{fetcher:async()=>{downstream++;throw Error('offline_transport_stop')}});globalThis.fetch=observer.fetch;
  const {readConfiguredLiveCurrentCash}=await import('./scripts/research/carry-live-current-cash.mjs');
  const seed=o.loadSubjects('susds')[0];const result=await readConfiguredLiveCurrentCash({routeKey:seed.routeKey,destination:seed.destination});
  const network=await observer.finish();console.log(JSON.stringify({escaped,downstream,network,status:result.status,methods:observer.traces.map(t=>t.request.method)}));`
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '--max-old-space-size=384' },
        encoding: 'utf8',
        timeout: 25000,
        maxBuffer: 65536,
      },
    )
    const result = JSON.parse(output.trim())
    assert.equal(result.escaped, 0)
    assert.ok(result.downstream >= 1)
    assert.equal(result.network.physicalStarts, result.downstream)
    assert.ok(result.network.physicalStarts <= 80)
    assert.equal(result.network.allSettled, true)
    assert.equal(result.status, 'unavailable')
    assert.ok(result.methods.includes('eth_chainId'))
  },
)

test('failure diagnostics retain only stage/name/repository frames', async () => {
  const { safeFailureFacts } = await import('./native-holder-forecast-runtime.mjs')
  const error = {
    name: 'TypeError',
    stack:
      'secret https://private/key\n at f (/Users/EBmic/membrane-app/components/Carry/ForecastWorkbench.tsx:27:6)\n at https://private/key:42:1',
  }
  assert.deepEqual(safeFailureFacts(error, 'current_metadata'), {
    stage: 'current_metadata',
    errorName: 'TypeError',
    frames: [{ file: 'components/Carry/ForecastWorkbench.tsx', line: 27, column: 6 }],
  })
  assert.ok(!JSON.stringify(safeFailureFacts(error, 'current_metadata')).includes('private'))
})

test('closed observer rejects delayed SDK attempts after networking finishes', async () => {
  const { createPublicClient, http } = await import('viem')
  let downstream = 0
  const observer = createObservedFetch(URLs, {
    limits,
    fetcher: async (_url, init) => {
      downstream++
      return response(JSON.parse(init.body).id)
    },
  })
  const client = createPublicClient({
    transport: http(URLs[0], { retryCount: 0, fetchFn: observer.fetch }),
  })
  assert.equal(await client.getChainId(), 1)
  await observer.finish()
  await assert.rejects(client.getChainId())
  assert.equal(downstream, 1)
  assert.equal(observer.traces.length, 1)
})
