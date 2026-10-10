import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { encodeFunctionData, encodeFunctionResult, decodeFunctionData } from 'viem'
import {
  prepareFluidBridgeUsdcHypotheticalHistoryPlan as prepare,
  captureFluidBridgeUsdcHypotheticalHistory as capture,
  inspectFluidBridgeUsdcHypotheticalHistory as replay,
  replayFluidBridgeUsdcHypotheticalHistory as authoritativeReplay,
  parseFluidUsdcHypotheticalJson,
  createFluidUsdcHypotheticalCaptureControl as control,
  fluidUsdcHypotheticalWrapperRequests as wrapperRequests,
  FLUID_USDC_HYPOTHETICAL_POLICY,
} from '../../scripts/research/fluid-bridge-usdc-hypothetical-history-capture.mjs'
import { FLUID_CAPACITY_ABI } from '../../scripts/research/carry-fluid-capacity-prongs.mjs'
import { FLUID_BRIDGE_CAPACITY_ABI } from '../../scripts/research/fluid-usdt-bridge-capacity-history-capture.mjs'

globalThis.fetch = async () => {
  throw Error('offline_global_fetch_trap')
}
const plan = prepare()
const native = JSON.parse(readFileSync(plan.retainedNativeProvenance.input.path, 'utf8'))
const origins = plan.originHosts.map((host) => ({
  host,
  url: 'https://' + host + '/secret-test-key-never-recorded',
}))
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const sha = (v) => createHash('sha256').update(v).digest('hex')
const reseal = (v) => {
  const { sha256, ...body } = v
  return { ...body, sha256: sha(JSON.stringify(body)) }
}
const header = (s) => ({
  number: '0x' + s.blockNumber.toString(16),
  hash: s.blockHash,
  timestamp: '0x' + (Date.parse(s.blockTime) / 1000).toString(16),
})
function harness(mutate, capturePlan = plan) {
  const plan = capturePlan
  let elapsed = 0
  const realStart = performance.now()
  const physical = []
  const fetcher = async (url, init) => {
    const r = JSON.parse(init.body)
    physical.push(r)
    const source =
      plan.anchors.find(
        (a) =>
          r.params?.[0] === '0x' + a.source.blockNumber.toString(16) ||
          r.params?.at(-1)?.blockHash === a.source.blockHash,
      )?.source ?? plan.anchors.at(-1).source
    let result
    if (r.method === 'eth_chainId') result = '0x1'
    else if (r.method === 'eth_getBlockByNumber') result = header(source)
    else if (r.method === 'eth_getStorageAt')
      result = '0x' + '0'.repeat(24) + plan.runtimePins.implementation.slice(2)
    else if (r.method === 'eth_getCode') {
      const row =
        native.wrapperOrigins[0].observations[0].traces.find(
          (t) => t.request.method === r.method && t.request.params[0] === r.params[0],
        ) ??
        native.protocolCaptures[0].traces.find(
          (t) => t.request.method === r.method && t.request.params[0] === r.params[0],
        )
      assert.ok(row, 'retained public runtime fixture')
      result = row.response.result
    } else if (r.method === 'eth_call') {
      const isWrapper = r.params[0].to === plan.subject.destination
      if (isWrapper) {
        const { functionName } = decodeFunctionData({
          abi: FLUID_BRIDGE_CAPACITY_ABI,
          data: r.params[0].data,
        })
        const values = {
          getFUSDC: plan.protocolSubject.destination,
          getWithdrawalFeeBPS: 5n,
          isWithdrawalsPaused: false,
          getIdleBalance: 100n,
          previewRedeem:
            1014574n +
            BigInt(plan.anchors.findIndex((a) => a.source.blockHash === source.blockHash)),
        }
        result = encodeFunctionResult({
          abi: FLUID_BRIDGE_CAPACITY_ABI,
          functionName,
          result: values[functionName],
        })
      } else if (
        r.params[0].data ===
        encodeFunctionData({
          abi: FLUID_BRIDGE_CAPACITY_ABI,
          functionName: 'maxWithdraw',
          args: [plan.subject.destination],
        })
      ) {
        result = encodeFunctionResult({
          abi: FLUID_BRIDGE_CAPACITY_ABI,
          functionName: 'maxWithdraw',
          result: 2000000n,
        })
      } else {
        const row = native.protocolCaptures[0].traces.find(
          (t) =>
            t.request.method === 'eth_call' &&
            t.request.params[0].to === r.params[0].to &&
            t.request.params[0].data === r.params[0].data,
        )
        assert.ok(row, 'retained ABI fixture')
        result = row.response.result
      }
    }
    const altered = mutate?.({
      r,
      result,
      source,
      advance: (ms) => {
        elapsed += ms
      },
      number: physical.length,
    })
    if (altered !== undefined) result = altered
    elapsed += 1
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }), { status: 200 })
  }
  return {
    physical,
    options: {
      fetcher,
      now: () => NOW + elapsed + Math.floor(performance.now() - realStart),
      monotonic: () => elapsed,
      pace: async (ms) => {
        elapsed += ms
      },
      setTimer: () => 0,
      clearTimer: () => {},
      freeBytes: () => 1024 ** 3,
    },
  }
}
let successful
test('private plan authenticates four daily bridge anchors and preserves original USDT transport provenance', () => {
  assert.deepEqual(
    plan.anchors.map((a) => a.cashIndex),
    [115, 116, 117, 118],
  )
  assert.deepEqual(
    plan.anchors.map((a) => a.source.blockNumber),
    [26079396, 26086569, 26093737, 26100913],
  )
  assert.equal(plan.subject.sharesRaw, '967573479322309282')
  assert.equal(plan.owner, null)
  assert.equal(plan.originalTransportRetagged, false)
  assert.equal(
    plan.retainedNativeProvenance.schema,
    'fluid_usdt_bridge_capacity_history_capture_v1',
  )
  assert.equal(Object.isFrozen(plan.runtimePins.underlyingIdentities), true)
  assert.throws(
    () => wrapperRequests(structuredClone(plan), plan.anchors[0].source),
    /private_prepared_plan/,
  )
})
test('selects four older authenticated anchors without changing default plan or runtime/budget pins', () => {
  const indices = [111, 112, 113, 114]
  const selected = prepare({ cashIndices: indices })
  assert.deepEqual(
    selected.anchors.map((a) => a.cashIndex),
    indices,
  )
  assert.ok(
    selected.anchors.every(
      (a, n) =>
        n === 0 ||
        (a.source.blockNumber > selected.anchors[n - 1].source.blockNumber &&
          Date.parse(a.source.blockTime) > Date.parse(selected.anchors[n - 1].source.blockTime)),
    ),
  )
  assert.deepEqual(selected.runtimePins, plan.runtimePins)
  assert.deepEqual(selected.policy, plan.policy)
  assert.deepEqual(selected.subject, plan.subject)
  assert.deepEqual(prepare({ cashIndices: [115, 116, 117, 118] }), plan)
  indices[0] = 112
  assert.deepEqual(
    selected.anchors.map((a) => a.cashIndex),
    [111, 112, 113, 114],
  )
  assert.equal(Object.isFrozen(selected.anchors), true)
  assert.equal(wrapperRequests(selected, selected.anchors[0].source).length, 12)
  assert.throws(
    () => wrapperRequests(structuredClone(selected), selected.anchors[0].source),
    /private_prepared_plan/,
  )
})
test('rejects malformed/type/prototype/sparse anchor indices before any evidence read', () => {
  const sparse = [111, 112, 113, 114]
  delete sparse[1]
  const inherited = [111, 112, 113, 114]
  Object.setPrototypeOf(inherited, null)
  const extra = [111, 112, 113, 114]
  extra.extra = true
  const accessor = [111, 112, 113, 114]
  Object.defineProperty(accessor, '1', {
    get() {
      throw Error('must_not_invoke_index_getter')
    },
  })
  const invalid = [
    [111, 111, 113, 114],
    [114, 113, 112, 111],
    [111, 112, 114, 115],
    [-1, 0, 1, 2],
    [117, 118, 119, 120],
    [111, 112, 113, 114.5],
    ['111', 112, 113, 114],
    { 0: 111, 1: 112, 2: 113, 3: 114, length: 4 },
    null,
    undefined,
    sparse,
    inherited,
    extra,
    accessor,
  ]
  for (const cashIndices of invalid)
    assert.throws(
      () => prepare({ root: '/private/tmp/absent-anchor-selection-evidence-root', cashIndices }),
      /anchor_selection_invalid/,
    )
  for (const key of ['headers', 'cash', 'runtimePins', 'providerUrls'])
    assert.throws(
      () => prepare({ root: '/private/tmp/absent-anchor-selection-evidence-root', [key]: [] }),
      /anchor_selection_invalid/,
    )
  assert.throws(
    () => prepare(Object.create({ cashIndices: [111, 112, 113, 114] })),
    /anchor_selection_invalid/,
  )
  assert.throws(
    () => prepare({ root: null, cashIndices: [111, 112, 113, 114] }),
    /anchor_selection_invalid/,
  )
})
test('complete fake transport records208 exact physical starts, full-S Ea and five prongs without owner or conversion', async () => {
  const h = harness()
  successful = await capture(plan, origins, h.options)
  assert.equal(successful.accepted, false)
  assert.equal(successful.replay, null)
  assert.throws(() => authoritativeReplay(successful.receipt, plan), /original_capture_authority/)
  assert.equal(successful.receipt.physicalStarts, 208)
  assert.equal(successful.inspection.points.length, 4)
  assert.equal(successful.inspection.points[3].fullNetEaRaw, '1014577')
  assert.equal(successful.inspection.points[0].nativeProngs.bridgeFunding, '2000000')
  assert.deepEqual(replay(successful.receipt, plan), successful.inspection)
  assert.equal(h.physical.length, 208)
  assert.ok(!JSON.stringify(successful.receipt).includes('secret-test-key'))
  for (const row of successful.receipt.ledger) {
    const text = Buffer.from(row.rawBodyBase64, 'base64').toString('utf8')
    assert.equal(sha(Buffer.from(text)), row.bodySha256)
    if (row.stage.startsWith('wrapper')) {
      assert.notEqual(row.request.method, 'eth_sendTransaction')
      if (row.request.method === 'eth_call') {
        const data = row.request.params[0].data
        assert.notEqual(
          data.slice(0, 10),
          encodeFunctionData({
            abi: FLUID_BRIDGE_CAPACITY_ABI,
            functionName: 'balanceOf',
            args: ['0x' + '1'.repeat(40)],
          }).slice(0, 10),
        )
        assert.notEqual(data.slice(0, 10), '0x38ed1739')
      }
    }
  }
  assert.equal(successful.receipt.pendingSettlements, 0)
  assert.equal(successful.receipt.execution, 'unassessed')
})
test('replay rejects changed hypotheticalS, schema, lifecycle budget and raw-body joins even after reseal', () => {
  assert.ok(successful)
  for (const mutate of [
    (v) => {
      v.plan.subject.sharesRaw = '1'
    },
    (v) => {
      v.schema = 'old_usdt_schema'
    },
    (v) => {
      v.physicalStarts = 209
    },
    (v) => {
      v.ledger[0].accepted = false
    },
    (v) => {
      v.ledger[0].rawBodyBase64 = Buffer.from('{}').toString('base64')
    },
  ]) {
    const v = structuredClone(successful.receipt)
    mutate(v)
    assert.throws(() => replay(reseal(v), plan))
  }
})
for (const fault of ['header', 'runtime', 'fee', 'pause'])
  test('rejects native ' + fault + ' without weakening acceptance', async () => {
    const h = harness(({ r, result }) => {
      if (fault === 'header' && r.method === 'eth_getBlockByNumber' && r.params[0] !== 'finalized')
        return { ...result, hash: '0x' + 'a'.repeat(64) }
      if (fault === 'runtime' && r.method === 'eth_getCode') return '0x6000'
      if (r.method === 'eth_call' && r.params[0].to === plan.subject.destination) {
        const { functionName } = decodeFunctionData({
          abi: FLUID_BRIDGE_CAPACITY_ABI,
          data: r.params[0].data,
        })
        if (fault === 'fee' && functionName === 'getWithdrawalFeeBPS')
          return encodeFunctionResult({ abi: FLUID_BRIDGE_CAPACITY_ABI, functionName, result: 6n })
        if (fault === 'pause' && functionName === 'isWithdrawalsPaused')
          return encodeFunctionResult({
            abi: FLUID_BRIDGE_CAPACITY_ABI,
            functionName,
            result: true,
          })
      }
    })
    const v = await capture(plan, origins, h.options)
    assert.equal(v.accepted, false)
    assert.equal(v.replay, null)
  })
test('late pacing checks deadline before physical launch and prevents further starts', async () => {
  let ms = 0,
    calls = 0
  const c = control(origins, {
    now: () => NOW + ms,
    monotonic: () => ms,
    fetcher: async (_url, init) => {
      calls++
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' }),
      )
    },
    pace: async () => {
      ms = 120001
    },
    setTimer: () => 0,
    clearTimer: () => {},
  })
  c.beginStage('test')
  const opts = {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  }
  await c.fetcher(origins[0].url, opts)
  await assert.rejects(c.fetcher(origins[0].url, opts), /start_budget/)
  await assert.rejects(c.fetcher(origins[1].url, opts), /closed/)
  const r = await c.finish()
  assert.equal(calls, 1)
  assert.equal(r.physicalStarts, 1)
})
test('fractional early wake uses ceil delays and rechecks spacing before launch', async () => {
  let ms = 0.25,
    calls = 0
  const delays = []
  const c = control(origins, {
    now: () => NOW + Math.floor(ms),
    monotonic: () => ms,
    fetcher: async (_url, init) => {
      calls++
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' }),
      )
    },
    pace: async (delay) => {
      delays.push(delay)
      ms += delays.length === 1 ? 249.5 : 0.5
    },
    setTimer: () => 0,
    clearTimer: () => {},
  })
  c.beginStage('test')
  const opts = {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  }
  await c.fetcher(origins[0].url, opts)
  await c.fetcher(origins[0].url, opts)
  const result = await c.finish()
  assert.deepEqual(delays, [250, 1])
  assert.equal(calls, 2)
  assert.equal(result.ledger[1].startedElapsedMs - result.ledger[0].startedElapsedMs, 250)
})
test('finish tracks a delayed pacer and closes physical starts before it resumes', async () => {
  let ms = 0,
    calls = 0,
    resumePace
  const timers = []
  const c = control(origins, {
    now: () => NOW + ms,
    monotonic: () => ms,
    fetcher: async (_url, init) => {
      calls++
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' }),
      )
    },
    pace: () =>
      new Promise((r) => {
        resumePace = r
      }),
    setTimer: (callback, delay) => {
      const timer = { callback, delay }
      timers.push(timer)
      return timer
    },
    clearTimer: () => {},
  })
  c.beginStage('first')
  const opts = {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  }
  await c.fetcher(origins[0].url, opts)
  const paced = c.fetcher(origins[0].url, opts)
  const rejected = assert.rejects(paced, /start_budget/)
  assert.throws(() => c.beginStage('cannot_skip_pacer'), /stage_pending/)
  const finishing = c.finish()
  timers.find((t) => t.delay === 250).callback()
  const snapshot = await finishing,
    frozenText = JSON.stringify(snapshot)
  assert.equal(snapshot.pendingSettlements, 1)
  assert.equal(snapshot.physicalStarts, 1)
  ms = 250
  resumePace()
  await rejected
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(snapshot), frozenText)
})
test('already-aborted and pacing-aborted upstream signals never launch physical reads', async () => {
  let ms = 0,
    calls = 0
  const aborter = new AbortController()
  const c = control(origins, {
    now: () => NOW + ms,
    monotonic: () => ms,
    fetcher: async (_url, init) => {
      calls++
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' }),
      )
    },
    pace: async (delay) => {
      ms += delay
      aborter.abort()
    },
    setTimer: () => 0,
    clearTimer: () => {},
  })
  c.beginStage('test')
  const opts = {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  }
  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(c.fetcher(origins[0].url, { ...opts, signal: preAborted.signal }), /aborted/)
  assert.equal(calls, 0)
  await c.fetcher(origins[0].url, opts)
  await assert.rejects(
    c.fetcher(origins[0].url, { ...opts, signal: aborter.signal }),
    /upstream_aborted/,
  )
  assert.equal(calls, 1)
  assert.equal((await c.finish()).physicalStarts, 1)
})
test('late successful physical bytes are retained separately and never accepted', async () => {
  let ms = 0
  const c = control(origins, {
    now: () => NOW + ms,
    monotonic: () => ms,
    fetcher: async (_u, init) => {
      ms = 8001
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' }),
      )
    },
    pace: async (n) => {
      ms += n
    },
    setTimer: () => 0,
    clearTimer: () => {},
  })
  c.beginStage('test')
  await assert.rejects(
    c.fetcher(origins[0].url, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }),
  )
  const r = await c.finish()
  assert.equal(r.ledger[0].status, 'late_success')
  assert.equal(r.ledger[0].accepted, false)
  assert.ok(r.ledger[0].rawBodyBase64)
  assert.equal(c.settlementReceipts[0].captureAcceptance, false)
  await assert.rejects(c.fetcher(origins[1].url, { body: '{}' }), /closed/)
})
test('abort-ignoring pending transport cannot start more reads; eventual body has a separate sealed receipt', async () => {
  let ms = 0,
    resolveFetch
  const timers = []
  const c = control(origins, {
    now: () => NOW + ms,
    monotonic: () => ms,
    fetcher: () =>
      new Promise((r) => {
        resolveFetch = r
      }),
    pace: async (n) => {
      ms += n
    },
    setTimer: (callback, delay) => {
      const t = { callback, delay, active: true }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      if (t) t.active = false
    },
  })
  c.beginStage('test')
  const physical = c.fetcher(origins[0].url, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  })
  ms = 8000
  timers.find((t) => t.delay === 8000).callback()
  await assert.rejects(physical)
  const finishing = c.finish()
  timers.find((t) => t.delay === 250).callback()
  const snapshot = await finishing,
    before = JSON.stringify(snapshot)
  assert.equal(snapshot.pendingSettlements, 1)
  await assert.rejects(c.fetcher(origins[1].url, { body: '{}' }), /closed/)
  ms = 8500
  resolveFetch(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })))
  await new Promise((r) => setImmediate(r))
  assert.equal(JSON.stringify(snapshot), before)
  assert.equal(c.settlementReceipts.length, 1)
  assert.equal(c.settlementReceipts[0].observation.status, 'late_success')
  assert.equal(c.settlementReceipts[0].observation.accepted, false)
  assert.ok(c.settlementReceipts[0].observation.rawBodyBase64)
  assert.equal(Object.isFrozen(c.settlementReceipts[0]), true)
})
test('failed provider bytes are hashed and sanitized without body/key retention', async () => {
  const c = control(origins, {
    fetcher: async () => new Response('secret-provider-message', { status: 503 }),
    setTimer: () => 0,
    clearTimer: () => {},
  })
  c.beginStage('test')
  await assert.rejects(
    c.fetcher(origins[0].url, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }),
  )
  const r = await c.finish()
  assert.equal(r.ledger[0].rawBodyBase64, null)
  assert.equal(r.ledger[0].bodySha256, sha('secret-provider-message'))
  assert.ok(!JSON.stringify(r).includes('secret-provider-message'))
})
test('rejects response caps, wrong configured origins, reserve and cloned plan before acquisition', async () => {
  const c = control(origins, {
    fetcher: async () => new Response('x'.repeat(65537)),
    setTimer: () => 0,
    clearTimer: () => {},
  })
  c.beginStage('test')
  await assert.rejects(
    c.fetcher(origins[0].url, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }),
  )
  assert.equal((await c.finish()).ledger[0].rawBodyBase64, null)
  assert.throws(() => control([origins[0], origins[0]]), /origins/)
  await assert.rejects(capture(structuredClone(plan), origins), /private_prepared_plan/)
  await assert.rejects(capture(plan, origins, { freeBytes: () => 0 }), /reserve/)
  assert.equal(FLUID_USDC_HYPOTHETICAL_POLICY.maxRequests, 208)
})

test('full S is positive canonical private plan data and encoded independently of requested amounts', async () => {
  const options = { sharesRaw: '1000000000000000000000000' }
  const bound = prepare(options)
  options.sharesRaw = '1'
  assert.equal(bound.subject.sharesRaw, '1000000000000000000000000')
  for (const anchor of bound.anchors) {
    const request = wrapperRequests(bound, anchor.source).find((r) => r.key === 'full_net_ea')
    assert.equal(
      decodeFunctionData({ abi: FLUID_BRIDGE_CAPACITY_ABI, data: request.params[0].data }).args[0],
      1000000000000000000000000n,
    )
  }
  const h = harness(undefined, bound),
    result = await capture(bound, origins, h.options)
  assert.equal(result.accepted, false)
  assert.equal(result.inspection.points[0].hypotheticalSharesRaw, bound.subject.sharesRaw)
  assert.equal(result.receipt.owner, null)
  assert.equal(result.receipt.historicalOwnership, false)
  assert.throws(() => authoritativeReplay(result.receipt, bound), /original_capture_authority/)
  for (const sharesRaw of ['0', '01', '-1', 1, null, (1n << 256n).toString()])
    assert.throws(() => prepare({ sharesRaw }), /anchor_selection_invalid/)
  let reads = 0
  assert.throws(
    () =>
      prepare(
        Object.defineProperty({}, 'sharesRaw', {
          enumerable: true,
          get() {
            reads++
            return '1'
          },
        }),
      ),
    /anchor_selection_invalid/,
  )
  assert.equal(reads, 0)
})
test('exact archived original authority survives and cannot rebind S or reseal counterfeit bodies', () => {
  const original = JSON.parse(
    readFileSync(
      'data/research/venue-signals/fluid-usdc-bridge-joint-history-evidence-2026-10-08/originals/20-native-historical-capture.json',
      'utf8',
    ),
  )
  assert.equal(authoritativeReplay(original, plan).authoritativeNativeCapture, true)
  assert.throws(() => authoritativeReplay(original, prepare({ sharesRaw: '1' })))
  const fake = structuredClone(original)
  fake.availableAtUtc = new Date(Date.parse(fake.availableAtUtc) + 1).toISOString()
  assert.throws(() => authoritativeReplay(reseal(fake), plan), /original_capture_authority/)
  assert.throws(
    () => parseFluidUsdcHypotheticalJson('{"result":1,"result":2}'),
    /duplicate_json_key/,
  )
})

test('protected replay snapshots own data and rejects cycles or accessors without invocation', () => {
  let calls = 0
  const original = JSON.parse(
    readFileSync(
      'data/research/venue-signals/fluid-usdc-bridge-joint-history-evidence-2026-10-08/originals/20-native-historical-capture.json',
      'utf8',
    ),
  )
  const cycle = structuredClone(original)
  cycle.loop = cycle
  assert.throws(() => authoritativeReplay(cycle, plan), /receipt_plain_data/)
  Object.defineProperty(original, 'sha256', {
    enumerable: true,
    get() {
      calls++
      return 'f39e070e3d031d3ae1e2f872ca9293f942e79a5d3441350f3d9959a475677bc5'
    },
  })
  assert.throws(() => authoritativeReplay(original, plan), /receipt_accessor/)
  assert.equal(calls, 0)
})
