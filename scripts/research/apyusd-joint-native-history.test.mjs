import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { encodeFunctionData, encodeFunctionResult, keccak256, toFunctionSelector } from 'viem'
import {
  ABI,
  createPlan,
  createRpcClients,
  executePlan,
  replay,
  grossVaultWithdrawForEscrow,
  POLICY,
  SEMANTICS,
} from './apyusd-joint-native-history.mjs'
import { ASSET, RECEIPT, VAULT, pin } from './carry-public-apyusd-exit-common.mjs'

const sha = (s) => createHash('sha256').update(s).digest('hex')
const clock = '2026-10-07T23:00:00.000Z'
const urls = [
  'https://eth-mainnet.g.alchemy.com/v2/offline-fixture',
  'https://rpc.ankr.com/eth/offline-fixture',
]
const timing = { nowUtc: () => clock, monotonicNow: () => 0 }
let prepared
const plan = () => (prepared ??= createPlan())
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const response = (result, id) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 })
const requestFetch = (handler) => async (url, options) => {
  assert.equal(options.redirect, 'error')
  assert.ok(options.signal instanceof AbortSignal)
  const request = JSON.parse(options.body)
  return response(await handler(request, url, options), request.id)
}

// Genuine captured runtime bytes qualify identity; native state below is synthetic test data.
const fixtureBytes = readFileSync(
  new URL(
    '../../data/research/venue-signals/apyusd-runtime-fixture-2026-10-08T00-09.json',
    import.meta.url,
  ),
)
assert.equal(sha(fixtureBytes), '8a9ef42a5da92f0fc5ab27af6448acd202e5113dcba6cd97e1047e7163bf9a04')
const fixture = JSON.parse(fixtureBytes)
const { bodySha256, ...fixtureBody } = fixture
assert.equal(sha(JSON.stringify(fixtureBody)), bodySha256)
assert.equal(bodySha256, 'a87967982a4e8e946aec4ffeeea6e3b7de7d2ac63c5feddfcc4d449da4b12b15')
assert.equal(fixture.blockNumber, 26100913)
assert.equal(fixture.sourceAt, '2026-10-01T23:59:59.000Z')
assert.equal(fixture.physicalCalls, 14)
assert.equal(fixture.hosts.length, 2)
const codes = new Map()
for (const host of fixture.hosts) {
  const codeRows = host.traces.filter((row) => row.request.method === 'eth_getCode')
  assert.equal(codeRows.length, 4)
  for (const target of fixture.targets) {
    const row = codeRows.find((row) => row.request.params[0] === target.address)
    assert.deepEqual(row.request.params[1], pin(fixture.blockHash))
    assert.equal(JSON.parse(row.rawBody).result, row.result)
    assert.equal(keccak256(row.result), target.keccak256)
    if (codes.has(target.address)) assert.equal(codes.get(target.address), row.result)
    codes.set(target.address, row.result)
  }
}
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const encoded = (functionName, result) => encodeFunctionResult({ abi: ABI, functionName, result })
function nativeFixtureFetch(p, transform = (result) => result) {
  const anchors = new Map(p.anchors.map((anchor) => [anchor.blockHash, anchor]))
  return requestFetch(async (request, url) => {
    const { method, params } = request
    let result
    if (method === 'eth_chainId') result = '0x1'
    else if (method === 'eth_getBlockByNumber') {
      const anchor = p.anchors.find((anchor) => BigInt(anchor.blockNumber) === BigInt(params[0]))
      assert.ok(anchor)
      result = {
        hash: anchor.blockHash,
        number: params[0],
        timestamp: `0x${(BigInt(Date.parse(anchor.blockAtUtc)) / 1000n).toString(16)}`,
        parentHash: fixture.hosts[0].traces[1].result.parentHash,
      }
    } else {
      const anchor = anchors.get(params.at(-1).blockHash)
      assert.ok(anchor)
      assert.deepEqual(params.at(-1), pin(anchor.blockHash))
      if (method === 'eth_getCode') {
        assert.ok(codes.has(params[0]))
        result = codes.get(params[0])
      } else if (method === 'eth_getStorageAt') {
        assert.equal(
          params[1],
          '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
        )
        result = word(params[0] === VAULT ? fixture.targets[2].address : fixture.targets[3].address)
      } else {
        assert.equal(method, 'eth_call')
        const { to, data } = params[0]
        if (data === '0x38d52e0f') result = word(ASSET)
        else if (data === toFunctionSelector('receipt()')) result = word(RECEIPT)
        else if (data === '0x313ce567') result = word(18)
        else if (
          to === ASSET &&
          data === encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [VAULT] })
        )
          result = encoded('balanceOf', BigInt(anchor.oldVaultCashRaw))
        else if (
          to === ASSET &&
          data === encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [RECEIPT] })
        )
          result = encoded('balanceOf', 1000n)
        else if (to === VAULT && data === toFunctionSelector('unlockingFee()'))
          result = encoded('unlockingFee', anchor.index === 118 ? 1n : 2n)
        else if (to === RECEIPT && data === toFunctionSelector('feeCurve()'))
          result = encoded('feeCurve', [1n, 10n, 1, 100, 2n])
        else if ((to === VAULT || to === RECEIPT) && data === toFunctionSelector('paused()'))
          result = encoded('paused', false)
        else assert.fail('unexpected fixture call')
      }
    }
    return transform(result, request, url)
  })
}
let successfulCapture
async function fullCapture() {
  return (successfulCapture ??= (async () => {
    const p = await plan()
    assert.equal(p.anchors[0].blockHash, fixture.blockHash)
    const pair = createRpcClients(urls, { fetchImpl: nativeFixtureFetch(p) })
    return executePlan(p, pair, { ...timing, nowUtc: () => '2026-10-08T00:10:00.000Z' })
  })())
}

// Transport fixtures never contact URLs: every client has an injected fetch.
test('qualified old single-provider witnesses select latest contiguous hashes offline', async () => {
  const p = await plan()
  assert.deepEqual(p.policy.pilotIndexes, [118, 119])
  assert.equal(p.anchors[0].blockNumber, '26100913')
  assert.equal(
    p.anchors[0].blockHash,
    '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
  )
  assert.equal(p.anchors[1].blockNumber, '26108081')
  assert.equal(p.priorCashProvenance, 'sealed_single_provider_cash_receipts')
  assert.equal(p.priorHistoryAvailableAtUtc, '2026-10-05T10:57:37.472Z')
  assert.equal(POLICY.maxRequests, 2 * 2 * (1 + 2 + 10 + 6))
  assert.equal(p.semantics.fullHolderEntitlement.valueRaw, null)
  assert.ok(Object.isFrozen(p.anchors[0]))
})
test('vault fee rounds up on escrow basis while receipt claim fee remains separate', () => {
  assert.deepEqual(grossVaultWithdrawForEscrow('1', '1'), {
    receiptEscrowRaw: '1',
    vaultFeeRaw: '1',
    grossVaultWithdrawRaw: '2',
  })
  assert.deepEqual(grossVaultWithdrawForEscrow('1000', '10000000000000000'), {
    receiptEscrowRaw: '1000',
    vaultFeeRaw: '10',
    grossVaultWithdrawRaw: '1010',
  })
  assert.equal(grossVaultWithdrawForEscrow('1000', '0').vaultFeeRaw, '0')
  assert.throws(() => grossVaultWithdrawForEscrow('-1', '1'), /fee_input/)
  assert.throws(
    () => grossVaultWithdrawForEscrow(String(2n ** 256n - 1n), String(10n ** 18n)),
    /fee_overflow/,
  )
  assert.equal(
    SEMANTICS.receiptFeeStage.qualification,
    'fee_curve_getter_only_no_age_or_claim_quote_in_this_capture',
  )
})
test('any daily interval is consecutive and invalid interval indexes fail offline', async () => {
  const first = await createPlan({ intervalEndIndex: 1 })
  assert.deepEqual(first.policy.pilotIndexes, [0, 1])
  assert.equal(first.anchors.length, 2)
  assert.ok(BigInt(first.anchors[1].blockNumber) > BigInt(first.anchors[0].blockNumber))
  assert.equal(first.policy.maxRequests, 76)
  for (const intervalEndIndex of [0, 120, -1, 1.5, '119', NaN])
    await assert.rejects(createPlan({ intervalEndIndex }), /interval_index/)
})
test('self sealed plan, cloned clients and forged provider names have no authority', async () => {
  const pair = createRpcClients(urls, {
    fetchImpl: requestFetch(async () => {
      assert.fail('no fetch should start')
    }),
  })
  await assert.rejects(
    executePlan(structuredClone(await plan()), pair, timing),
    /prepared_plan_required/,
  )
  await assert.rejects(
    executePlan(await plan(), structuredClone(pair), timing),
    /trusted_independent_clients/,
  )
  await assert.rejects(
    executePlan(
      await plan(),
      pair.map((o) => ({ ...o, request() {} })),
      timing,
    ),
    /trusted_independent_clients/,
  )
})
test('factory rejects different providers, HTTP, credentials, redirects and port-bearing URLs', () => {
  for (const url of [
    'https://other.example/eth',
    'http://eth-mainnet.g.alchemy.com/eth',
    'https://user:secret@eth-mainnet.g.alchemy.com/eth',
    'https://eth-mainnet.g.alchemy.com:444/eth',
    'https://eth-mainnet.g.alchemy.com/eth#redirect',
  ])
    assert.throws(() => createRpcClients([url, urls[1]]), /client_url/)
})
test('execution stops on chain mismatch without retry or trailing reads', async () => {
  let starts = 0
  const pair = createRpcClients(urls, {
    fetchImpl: requestFetch(async () => {
      starts++
      return '0xa'
    }),
  })
  await assert.rejects(executePlan(await plan(), pair, timing), /joint_chain/)
  assert.equal(starts, 1)
})
test('malformed envelopes and redirects stop before any trailing request', async () => {
  for (const result of [
    { jsonrpc: '2.0', id: 2, result: '0x1' },
    { jsonrpc: '2.0', id: 1, result: '0x1', extra: true },
    { jsonrpc: '2.0', id: 1, error: { code: -32000 } },
  ]) {
    let starts = 0
    const pair = createRpcClients(urls, {
      fetchImpl: async () => {
        starts++
        return new Response(JSON.stringify(result))
      },
    })
    await assert.rejects(executePlan(await plan(), pair, timing), /request_failed/)
    assert.equal(starts, 1)
  }
  let starts = 0,
    signal
  const pair = createRpcClients(urls, {
    fetchImpl: async (_url, options) => {
      starts++
      signal = options.signal
      return { ok: true, redirected: true, body: new Response('{}').body }
    },
  })
  await assert.rejects(executePlan(await plan(), pair, timing), /request_failed/)
  assert.equal(starts, 1)
  assert.ok(signal.aborted)
})
test('changed anchor header stops before runtime or fee reads', async () => {
  let starts = 0
  const pair = createRpcClients(urls, {
    fetchImpl: requestFetch(async ({ method }) => {
      starts++
      if (method === 'eth_chainId') return '0x1'
      assert.equal(method, 'eth_getBlockByNumber')
      return {
        hash: `0x${'0'.repeat(64)}`,
        parentHash: `0x${'1'.repeat(64)}`,
        number: '0x1',
        timestamp: '0x1',
      }
    }),
  })
  await assert.rejects(executePlan(await plan(), pair, timing), /header_changed/)
  assert.equal(starts, 2)
})
test('oversized streamed body is cancelled before JSON parse and physical fetch is aborted', async () => {
  let signal,
    reads = 0,
    cancelled = false
  const pair = createRpcClients(urls, {
    fetchImpl: async (_url, options) => {
      signal = options.signal
      return {
        ok: true,
        redirected: false,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              async read() {
                reads++
                return { done: false, value: new Uint8Array(POLICY.maxResponseBytes + 1).fill(123) }
              },
              async cancel() {
                cancelled = true
              },
            }
          },
        },
      }
    },
  })
  await assert.rejects(executePlan(await plan(), pair, timing), (error) => {
    assert.match(error.message, /request_failed/)
    assert.equal(error.captureDiagnostics.physicalStarts, 1)
    assert.equal(error.captureDiagnostics.totalResponseBytes, POLICY.maxResponseBytes + 1)
    return true
  })
  assert.equal(reads, 1)
  assert.ok(cancelled)
  assert.ok(signal.aborted)
})
test('declared oversized length is rejected without reading body', async () => {
  let reads = 0,
    signal
  const pair = createRpcClients(urls, {
    fetchImpl: async (_url, options) => {
      signal = options.signal
      return {
        ok: true,
        redirected: false,
        headers: new Headers({ 'content-length': String(POLICY.maxResponseBytes + 1) }),
        body: {
          getReader() {
            reads++
            throw Error('must not read')
          },
        },
      }
    },
  })
  await assert.rejects(executePlan(await plan(), pair, timing), /request_failed/)
  assert.equal(reads, 0)
  assert.ok(signal.aborted)
})
test('post-fetch global deadline aborts even a transport that returns successfully', async () => {
  let mono = 0,
    signal,
    starts = 0
  const pair = createRpcClients(urls, {
    fetchImpl: async (_url, options) => {
      starts++
      signal = options.signal
      mono = POLICY.maxRunMs
      return response('0x1', JSON.parse(options.body).id)
    },
  })
  await assert.rejects(
    executePlan(await plan(), pair, { nowUtc: () => clock, monotonicNow: () => mono }),
    /request_failed/,
  )
  assert.equal(starts, 1)
  assert.ok(signal.aborted)
})
test('genuine runtime identities complete exactly 76 synthetic native reads and replay', async () => {
  const raw = await fullCapture(),
    p = await plan()
  assert.equal(raw.physicalStarts, 76)
  assert.equal(raw.transcript.length, 76)
  for (const originIndex of [0, 1]) {
    const rows = raw.transcript.filter((row) => row.originIndex === originIndex)
    assert.equal(rows.length, 38)
    assert.equal(rows.filter((row) => row.method === 'eth_getCode').length, 8)
    assert.equal(rows.filter((row) => row.method === 'eth_call').length, 20)
    assert.equal(rows.filter((row) => row.method === 'eth_getBlockByNumber').length, 4)
  }
  const result = await replay(raw, p)
  assert.deepEqual(result.points, raw.points)
  assert.equal(result.points.length, 2)
  assert.equal(result.points[0].regime.status, 'first_observed_terms')
  assert.equal(result.points[1].regime.status, 'regime_change')
  for (const [index, point] of result.points.entries()) {
    assert.equal(point.vaultCashRaw, p.anchors[index].oldVaultCashRaw)
    assert.equal(point.receiptCashRaw, '1000')
    assert.equal(point.fullHolderEntitlement.valueRaw, null)
    assert.equal(point.fullHolderEntitlement.status, 'unverified_callable_source_semantics')
    assert.equal(point.stockSemantics, 'two_cash_stocks_not_gross_flows')
    assert.equal(point.regime.transitionDuration, index ? 'unknown_between_anchors' : 'unknown')
    assert.equal(
      grossVaultWithdrawForEscrow(point.receiptCashRaw, point.unlockingFeeWad)
        .grossVaultWithdrawRaw,
      '1001',
    )
  }
  assert.equal(
    result.semantics.receiptFeeStage.qualification,
    'fee_curve_getter_only_no_age_or_claim_quote_in_this_capture',
  )
  assert.equal(
    raw.totalResponseBytes,
    raw.transcript.reduce((sum, row) => sum + row.bodyBytes, 0),
  )
  assert.ok(Object.isFrozen(raw.transcript[0]))
})
test('replay rejects changed seals, runtime, headers, source cash, fee facts and timeline', async () => {
  const original = await fullCapture(),
    p = await plan()
  const mutateBody = (raw, predicate, result) => {
    const row = raw.transcript.find(predicate),
      body = JSON.parse(row.bodyText)
    body.result = typeof result === 'function' ? result(body.result) : result
    raw.totalResponseBytes -= row.bodyBytes
    row.bodyText = JSON.stringify(body)
    row.bodyBytes = Buffer.byteLength(row.bodyText)
    raw.totalResponseBytes += row.bodyBytes
  }
  const cases = [
    [
      (raw) => {
        raw.availableAtUtc = clock
      },
      /seal_or_plan/,
    ],
    [
      (raw) => mutateBody(raw, (row) => row.method === 'eth_getCode', '0x00'),
      /implementation_identity_invalid/,
    ],
    [
      (raw) =>
        mutateBody(
          raw,
          (row) => row.method === 'eth_getBlockByNumber',
          (header) => ({ ...header, hash: `0x${'0'.repeat(64)}` }),
        ),
      /header_changed/,
    ],
    [
      (raw) =>
        mutateBody(
          raw,
          (row) =>
            row.method === 'eth_call' &&
            row.params[0].data ===
              encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [VAULT] }),
          word(1),
        ),
      /old_cash_changed/,
    ],
    [
      (raw) => {
        raw.points[0].unlockingFeeWad = '999'
      },
      /replayed_facts/,
    ],
    [
      (raw) => {
        raw.transcript[0].endedElapsedMs = -1
      },
      /replay_clock_or_deadline/,
    ],
  ]
  for (const [index, [mutate, expected]] of cases.entries()) {
    let raw = structuredClone(original)
    mutate(raw)
    if (index > 0) {
      const { sha256: _oldSeal, ...body } = raw
      raw = seal(body)
    }
    await assert.rejects(replay(raw, p), expected)
  }
})
test('two origins disagreeing on native fees stop the paired capture', async () => {
  const p = await plan()
  const pair = createRpcClients(urls, {
    fetchImpl: nativeFixtureFetch(p, (result, request, url) => {
      if (
        url === urls[1] &&
        request.method === 'eth_call' &&
        request.params[0].data === toFunctionSelector('unlockingFee()')
      )
        return word(999)
      return result
    }),
  })
  await assert.rejects(executePlan(p, pair, timing), (error) => {
    assert.match(error.message, /two_origin_disagreement/)
    assert.equal(error.captureDiagnostics.physicalStarts, 38)
    return true
  })
})
test('remaining run budget physically aborts a hanging fetch', async () => {
  let calls = 0,
    aborted = false
  const pair = createRpcClients(urls, {
    fetchImpl: async (_url, options) =>
      new Promise((_, reject) => {
        calls++
        options.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(Error('fixture_abort'))
          },
          { once: true },
        )
      }),
  })
  let monoCalls = 0
  await assert.rejects(
    executePlan(await plan(), pair, {
      nowUtc: () => clock,
      monotonicNow: () => (monoCalls++ === 0 ? 0 : POLICY.maxRunMs - 5),
    }),
    /request_failed/,
  )
  assert.equal(calls, 1)
  assert.ok(aborted)
})
