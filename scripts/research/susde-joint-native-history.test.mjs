import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPlan,
  executePlan,
  replay,
  pinSource,
  sha256,
  ROUTE,
  qualifySavedHistory,
  createBoundedClients,
  requestsFor,
  SOURCE_FILE,
  VAULT_CODE_SHA256,
  QUALIFIED_HISTORY_SHA256,
  ASSET_SOURCE_FILE,
  SILO_SOURCE_FILE,
  ASSET_CODE_SHA256,
  SILO_CODE_SHA256,
  verifyNativeSource,
} from './susde-joint-native-history.mjs'
const seal = (x) => ({ ...x, sha256: sha256(JSON.stringify(x)) })
const reseal = (x) => {
  delete x.sha256
  return seal(x)
}
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const aword = (x) => `0x${x.slice(2).padStart(64, '0')}`
const origins = ['https://a.example', 'https://b.example']
const qualifiedHistory = await qualifySavedHistory()
const realVaultCode = JSON.parse(JSON.parse(readFileSync(SOURCE_FILE)).responseRaw).runtimeBytecode
  .onchainBytecode
const nativeSources = {
  asset: JSON.parse(readFileSync(ASSET_SOURCE_FILE)),
  silo: JSON.parse(readFileSync(SILO_SOURCE_FILE)),
}
const realCode = {
  vault: realVaultCode,
  asset: nativeSources.asset.runtimeBytecode.onchainBytecode,
  silo: nativeSources.silo.runtimeBytecode.onchainBytecode,
}
function fixture() {
  const plan = createPlan({ qualifiedHistory, origins })
  let clockMs = Date.parse('2026-10-07T12:00:00.000Z'),
    calls = 0
  const fetchImpl = async (_url, options) => {
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    calls++
    clockMs += 1
    const { method, params } = JSON.parse(options.body)
    let result
    if (method === 'eth_chainId') result = '0x1'
    else if (method === 'eth_getBlockByNumber') {
      const a = plan.anchors.find((x) => `0x${BigInt(x.blockNumber).toString(16)}` === params[0])
      result = {
        number: params[0],
        hash: a.blockHash,
        timestamp: `0x${BigInt(Date.parse(a.sourceAt) / 1000).toString(16)}`,
      }
    } else if (method === 'eth_getCode')
      result = realCode[Object.keys(ROUTE).find((k) => ROUTE[k] === params[0])]
    else {
      const a = plan.anchors.find((a) => a.blockHash === params[1].blockHash),
        req = requestsFor(a),
        data = params[0].data
      if (data === req[5].params[0].data) result = aword(ROUTE.asset)
      else if (data === req[6].params[0].data) result = aword(ROUTE.silo)
      else if (data === req[7].params[0].data) result = word(604800)
      else if (data === req[8].params[0].data) result = word(a.vaultUsdeRaw)
      else if (data === req[9].params[0].data) result = word(20 + (a.index - 116) * 7)
      else throw Error('unexpected fixture call')
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
  }
  const clients = createBoundedClients({
    urls: origins.map((x) => x + '/private-key'),
    approvedOrigins: origins,
    fetchImpl,
  })
  return {
    plan,
    clients,
    now: () => new Date(clockMs).toISOString(),
    fetchImpl,
    setClock: (n) => {
      clockMs = n
    },
    calls: () => calls,
  }
}
function mutateResult(capture, index, value) {
  const c = structuredClone(capture),
    t = c.hosts[1].traces[0][index]
  t.result = value
  t.rawBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: value })
  return reseal(c)
}
test('actual source runtime and all 120 saved anchors match immutable qualification pins', () => {
  assert.equal(qualifiedHistory.sha256, QUALIFIED_HISTORY_SHA256)
  assert.equal(qualifiedHistory.anchors.length, 120)
  assert.equal(sha256(Buffer.from(realVaultCode.slice(2), 'hex')), VAULT_CODE_SHA256)
  assert.equal(
    pinSource().fileSha256,
    '62c2d60fdb2faa9b04bba1505092a98420dabd0b9f75276fe3ba5de16f26fb9b',
  )
})
test('all three actual source runtimes:88 bounded requests retain qualified stocks without forecasting', async () => {
  const f = fixture(),
    { capture, observation } = await executePlan(f)
  assert.equal(f.calls(), 88)
  assert.equal(f.plan.rpcCallBudget, 88)
  assert.equal(observation.rows[0].sourceAt, '2026-09-29T23:59:59.000Z')
  assert.equal(observation.rows[0].oldAvailableAt, '2026-10-05T10:57:37.472Z')
  assert.equal(observation.changes[0].siloNetUsdeRaw, '7')
  assert.equal(observation.forecastProjection, null)
  assert.equal(observation.assetAuthority, 'literal_verified_source_runtime_pin')
  assert.equal(
    observation.siloAuthority,
    'literal_verified_source_runtime_pin_and_vault_asset_immutable_bindings',
  )
  assert.equal(
    observation.forecastEligibility,
    'qualified_native_channel_observations_ready_for_model_not_a_forecast',
  )
  assert.equal(observation.holderE, 'not_measured')
  assert.equal(observation.queueQ, 'not_measured')
  assert.equal(observation.captureAuthority, 'consistency_only_self_seal_is_not_authentication')
  assert.equal(JSON.stringify(capture).includes('private-key'), false)
  assert.equal(
    replay(capture, { plan: f.plan, captureFileSha256: sha256(JSON.stringify(capture) + '\n') })
      .captureAuthority,
    'external_file_bytes_pin_supplied',
  )
})
test('resealed synthetic vault runtime, cash/chain/source/plan/qualified-history corruption reject', async () => {
  const f = fixture(),
    { capture } = await executePlan(f)
  for (const [i, v] of [
    [0, '0x2'],
    [2, '0x6000'],
    [3, '0x6000'],
    [4, '0x6000'],
    [8, word(999)],
    [9, word(999)],
  ])
    assert.throws(() => replay(mutateResult(capture, i, v), { plan: f.plan }), /susde_joint_/)
  const q = structuredClone(qualifiedHistory)
  q.anchors[116].vaultUsdeRaw = '999'
  reseal(q)
  assert.throws(() => createPlan({ qualifiedHistory: q, origins }), /qualification_pin/)
  for (const change of [
    (p) => {
      p.origins = ['https://a.example', 'https://a.example:443']
    },
    (p) => {
      p.rpcCallBudget++
    },
    (p) => {
      p.indices = [116, 118]
    },
    (p) => {
      p.anchors[0].vaultUsdeRaw = '999'
    },
    (p) => {
      p.sourcePin.bodySha256 = 'a'.repeat(64)
    },
  ]) {
    const p = structuredClone(f.plan)
    change(p)
    reseal(p)
    assert.throws(() => replay(capture, { plan: p }), /susde_joint_/)
    await assert.rejects(executePlan({ ...f, plan: p }), /susde_joint_/)
  }
  assert.throws(
    () => replay(capture, { plan: f.plan, captureFileSha256: 'a'.repeat(64) }),
    /external_capture_pin/,
  )
})
test('offline replay enforces global clock,120s inclusive run bound and raw body pins', async () => {
  const f = fixture(),
    { capture } = await executePlan(f)
  for (const change of [
    (c) => {
      c.hosts[1].traces[0][0].startedAt = c.startedAt
    },
    (c) => {
      c.availableAt = '2026-10-07T12:02:00.001Z'
    },
    (c) => {
      c.hosts[0].traces[0][0].rawBody = ' '.repeat(65537)
    },
    (c) => {
      c.hosts[0].traces[0][0].rawBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2' })
    },
  ]) {
    const c = structuredClone(capture)
    change(c)
    assert.throws(() => replay(reseal(c), { plan: f.plan }), /susde_joint_/)
  }
})
test('untrusted client, redirect, oversize streamed/declared bodies, JSON errors fail closed', async () => {
  const f = fixture()
  await assert.rejects(
    executePlan({ ...f, clients: [{ origin: origins[0], request: async () => {} }, f.clients[1]] }),
    /trusted_clients/,
  )
  for (const response of [
    () => new Response('x'.repeat(65537)),
    () => new Response('{}', { headers: { 'content-length': '65537' } }),
    () => new Response('{bad'),
    () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1 } })),
  ]) {
    const clients = createBoundedClients({
      urls: origins,
      approvedOrigins: origins,
      fetchImpl: async () => response(),
    })
    await assert.rejects(clients[0].request('eth_chainId', []), /susde_joint_/)
  }
  const redirect = createBoundedClients({
    urls: origins,
    approvedOrigins: origins,
    fetchImpl: async () => ({ ok: true, redirected: true }),
  })
  await assert.rejects(redirect[0].request('eth_chainId', []), /rpc_response/)
})
test('physical abort ends hanging fetch and stream; no second inflight request', async () => {
  let aborted = false
  const hanging = async (_url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(Error('aborted'))
        },
        { once: true },
      ),
    )
  const [client] = createBoundedClients({
    urls: origins,
    approvedOrigins: origins,
    fetchImpl: hanging,
  })
  const pending = client.request('eth_chainId', [], { timeoutMs: 20 })
  await assert.rejects(client.request('eth_chainId', [], { timeoutMs: 20 }), /client_budget/)
  await assert.rejects(pending, /rpc_timeout/)
  assert.equal(aborted, true)
  const streamClient = createBoundedClients({
    urls: origins,
    approvedOrigins: origins,
    fetchImpl: async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(Error('abort')), { once: true })
          },
        }),
      ),
  })[0]
  await assert.rejects(streamClient.request('eth_chainId', [], { timeoutMs: 20 }), /rpc_timeout/)
})
test('postrequest elapsed120s overrun rejected before capture sealing', async () => {
  const f = fixture()
  const clients = createBoundedClients({
    urls: origins,
    approvedOrigins: origins,
    fetchImpl: async (...args) => {
      const r = await f.fetchImpl(...args)
      f.setClock(Date.parse('2026-10-07T12:02:00.001Z'))
      return r
    },
  })
  await assert.rejects(executePlan({ ...f, clients }), /run_budget/)
})

test('factory transport and returned array are immutable; original native fetch still runs88calls', async () => {
  const f = fixture(),
    client = f.clients[0],
    original = client.request
  assert.equal(Object.isFrozen(client), true)
  assert.equal(Object.isFrozen(f.clients), true)
  const descriptor = Object.getOwnPropertyDescriptor(client, 'request')
  assert.equal(descriptor.writable, false)
  assert.equal(descriptor.configurable, false)
  assert.throws(() => {
    client.request = async () => ({ rawBody: '{}', result: '0x1' })
  }, TypeError)
  assert.throws(() => {
    f.clients[0] = { origin: origins[0], request: async () => {} }
  }, TypeError)
  assert.equal(client.request, original)
  const { observation } = await executePlan(f)
  assert.equal(f.calls(), 88)
  assert.equal(observation.forecastProjection, null)
})

test('source files and independent reconstruction prove asset/silo runtime and silo immutables', () => {
  const pin = pinSource()
  assert.equal(pin.asset.runtimeSha256, ASSET_CODE_SHA256)
  assert.equal(pin.silo.runtimeSha256, SILO_CODE_SHA256)
  assert.deepEqual(pin.silo.immutableBindings, { stakingVault: ROUTE.vault, usde: ROUTE.asset })
  for (const kind of ['asset', 'silo'])
    assert.equal(
      verifyNativeSource(nativeSources[kind], kind).runtimeSha256,
      sha256(Buffer.from(realCode[kind].slice(2), 'hex')),
    )
  for (const [kind, change, expected] of [
    [
      'silo',
      (s) => {
        s.runtimeBytecode.transformationValues.immutables['8'] = aword(ROUTE.asset)
      },
      /silo_immutable_address_binding/,
    ],
    [
      'silo',
      (s) => {
        s.runtimeBytecode.transformationValues.immutables['11'] = aword(ROUTE.vault)
      },
      /silo_immutable_address_binding/,
    ],
    [
      'silo',
      (s) => {
        s.runtimeBytecode.immutableReferences['8'][0].start++
      },
      /native_transformations/,
    ],
    [
      'silo',
      (s) => {
        s.runtimeBytecode.transformations[0].offset++
      },
      /native_transformations/,
    ],
    [
      'silo',
      (s) => {
        s.sources['contracts/USDeSilo.sol'].content = s.sources[
          'contracts/USDeSilo.sol'
        ].content.replace('_USDE.transfer(to, amount)', '_USDE.transfer(msg.sender, amount)')
      },
      /silo_source_semantics/,
    ],
    [
      'asset',
      (s) => {
        s.runtimeBytecode.onchainBytecode = '0x6000'
      },
      /native_runtime_reconstruction/,
    ],
    [
      'asset',
      (s) => {
        s.runtimeMatch = 'partial_match'
      },
      /native_source_identity/,
    ],
    [
      'asset',
      (s) => {
        s.address = ROUTE.silo
      },
      /native_source_identity/,
    ],
    [
      'asset',
      (s) => {
        s.runtimeBytecode.transformationValues.immutables['2313'] = aword(ROUTE.silo)
      },
      /native_runtime_reconstruction/,
    ],
    [
      'asset',
      (s) => {
        s.sources['contracts/USDe.sol'].content = 'contract Wrong {}'
      },
      /asset_source_semantics/,
    ],
  ]) {
    const source = structuredClone(nativeSources[kind])
    change(source)
    assert.throws(() => verifyNativeSource(source, kind), expected)
  }
  const dir = mkdtempSync(join(tmpdir(), 'susde-native-source-test-'))
  try {
    for (const [kind, file] of [
      ['asset', ASSET_SOURCE_FILE],
      ['silo', SILO_SOURCE_FILE],
    ]) {
      const copy = join(dir, kind + '.json')
      writeFileSync(copy, Buffer.concat([readFileSync(file), Buffer.from(' ')]))
      assert.throws(
        () =>
          pinSource(SOURCE_FILE, {
            asset: ASSET_SOURCE_FILE,
            silo: SILO_SOURCE_FILE,
            [kind]: copy,
          }),
        /native_literal_file_pin/,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('each native runtime is enforced for every origin and anchor independently', async () => {
  const f = fixture(),
    { capture } = await executePlan(f)
  for (let host = 0; host < 2; host++)
    for (let anchor = 0; anchor < 4; anchor++)
      for (const index of [2, 3, 4]) {
        const c = structuredClone(capture),
          t = c.hosts[host].traces[anchor][index]
        t.result = '0x6000'
        t.rawBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: t.result })
        assert.throws(() => replay(reseal(c), { plan: f.plan }), /code_pin/)
      }
})
