import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FLUID_FULL_POSITION_POLICY,
  prepareFluidFullPositionHistoryPlan,
  captureFluidFullPositionHistory,
  replayFluidFullPositionHistory,
} from '../../scripts/research/fluid-usdt-full-position-history-capture.mjs'

const nativeFetch = globalThis.fetch
globalThis.fetch = async () => {
  throw Error('offline_global_fetch_trap')
}

const NOW = Date.parse('2026-10-07T18:00:00.000Z')
const asWord = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0')
const providers = [
  { url: 'https://eth-mainnet.g.alchemy.com/v2/offline-test-only' },
  { url: 'https://rpc.ankr.com/eth/offline-test-only' },
]
const reseal = (value) => {
  const { sha256, ...body } = value
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}

// Synthetic transport responses are unit controls, never saved research observations.
function fakeTransport(plan, mutate) {
  const calls = []
  const active = new Map()
  const maxActive = new Map()
  let ticks = 0
  const fetchImpl = async (url, options) => {
    const host = new URL(url).hostname
    active.set(host, (active.get(host) ?? 0) + 1)
    maxActive.set(host, Math.max(maxActive.get(host) ?? 0, active.get(host)))
    try {
      const request = JSON.parse(options.body)
      calls.push({ host, request })
      const anchor =
        request.method === 'eth_getBlockByNumber'
          ? plan.anchors.find(
              (row) => BigInt(request.params[0]).toString() === row.source.blockNumber,
            )
          : plan.anchors.find((row) => row.source.blockHash === request.params[1].blockHash)
      assert.ok(anchor)
      let result
      if (request.method === 'eth_getBlockByNumber') {
        result = {
          number: '0x' + BigInt(anchor.source.blockNumber).toString(16),
          hash: anchor.source.blockHash,
          timestamp: '0x' + BigInt(Date.parse(anchor.source.blockTime) / 1000).toString(16),
          transactions: ['omitted-header-field'],
        }
      } else {
        const selector = request.params[0].data.slice(0, 10)
        if (selector === '0x38d52e0f') result = '0x' + plan.subject.asset.slice(2).padStart(64, '0')
        else if (selector === '0x313ce567') result = asWord(6)
        else if (selector === '0x70a08231') result = asWord(anchor.originalHolderSharesRaw)
        else if (selector === '0x4cdad506') {
          assert.equal(
            request.params[0].data.slice(10),
            asWord(anchor.originalHolderSharesRaw).slice(2),
          )
          result = asWord(anchor === plan.anchors[0] ? 1234567 : 1234587)
        } else assert.fail('unexpected native method')
      }
      mutate?.({ request, anchor, plan })
      await Promise.resolve()
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
      })
    } finally {
      active.set(host, active.get(host) - 1)
    }
  }
  return { fetchImpl, now: () => NOW + ticks++, calls, maxActive }
}
async function fixture() {
  const plan = prepareFluidFullPositionHistoryPlan()
  const transport = fakeTransport(plan)
  const value = await captureFluidFullPositionHistory(plan, providers, transport)
  return { plan, transport, value }
}

test('fixed saved receipt anchors prepare with zero RPC and cannot silently change', () => {
  const plan = prepareFluidFullPositionHistoryPlan()
  assert.equal(plan.anchors[0].source.blockNumber, '26101887')
  assert.equal(plan.anchors[1].source.blockNumber, '26102143')
  assert.equal(plan.subject.shareDecimalsFromOriginalIssues, 18)
  assert.equal(plan.newlyObservedFinalizedHead, false)
  assert.equal(FLUID_FULL_POSITION_POLICY.maxRequests, 24)
  assert.equal(FLUID_FULL_POSITION_POLICY.maxArtifactBytes, 65536)
  assert.equal(FLUID_FULL_POSITION_POLICY.reserveBytes, 128 * 1024 * 1024)
  const root = mkdtempSync('/private/tmp/fluid-full-position-test-')
  try {
    const folder = resolve(
      root,
      'data/research/venue-signals/carry-fluid-bridge-usdt-holder-v1/issues',
    )
    mkdirSync(folder, { recursive: true })
    for (const anchor of plan.anchors)
      writeFileSync(
        resolve(folder, anchor.issueFile),
        readFileSync(
          resolve(
            'data/research/venue-signals/carry-fluid-bridge-usdt-holder-v1/issues',
            anchor.issueFile,
          ),
        ),
      )
    writeFileSync(resolve(folder, plan.anchors[0].issueFile), '{}')
    assert.throws(() => prepareFluidFullPositionHistoryPlan({ root }), /original_issue_hashes/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('24 mocked native reads derive full balance→preview, preserve clocks, and retain no URLs or full headers', async () => {
  const { plan, transport, value } = await fixture()
  const replay = replayFluidFullPositionHistory(value, plan)
  assert.equal(transport.calls.length, 24)
  assert.equal(value.physicalStarts, 24)
  assert.deepEqual([...transport.maxActive.values()], [1, 1])
  assert.equal(Buffer.byteLength(JSON.stringify(value)) + 1 < 65536, true)
  assert.deepEqual(
    replay.points.map((point) => point.fullPositionEntitlementRaw),
    ['1234567', '1234587'],
  )
  assert.deepEqual(
    replay.points.map((point) => point.holderSharesRaw),
    plan.anchors.map((anchor) => anchor.originalHolderSharesRaw),
  )
  assert.equal(replay.availableAtUtc, value.availableAtUtc)
  assert.equal(Date.parse(replay.availableAtUtc) >= NOW, true)
  assert.equal(replay.execution, 'unassessed')
  assert.equal(replay.minedPayout, false)
  assert.equal(replay.sourceImplementationEquivalence, false)
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes('offline-test-only'), false)
  assert.equal(serialized.includes('https://'), false)
  assert.equal(serialized.includes('transactions'), false)
  assert.equal(
    transport.calls.some((call) => call.request.params.includes('latest')),
    false,
  )
})

for (const mode of [
  'source',
  'canonical',
  'owner',
  'full_balance',
  'preview_amount',
  'asset',
  'units',
  'clock',
  'availability',
  'host',
  'id',
  'extra',
]) {
  test(`replay rejects ${mode} tampering even after a candidate recomputes its checksum`, async () => {
    const { plan, value } = await fixture()
    const changed = structuredClone(value)
    const observation = changed.origins[0].observations[0]
    const traces = observation.traces
    if (mode === 'source') observation.source.blockHash = `0x${'0'.repeat(64)}`
    if (mode === 'canonical') traces[4].request.params[1].requireCanonical = false
    if (mode === 'owner') traces[3].request.params[0].data = '0x70a08231' + '0'.repeat(64)
    if (mode === 'full_balance') traces[3].response.result = asWord(10145)
    if (mode === 'preview_amount')
      traces[4].request.params[0].data = '0x4cdad506' + asWord(10145).slice(2)
    if (mode === 'asset') traces[1].response.result = asWord(0)
    if (mode === 'units') traces[2].response.result = asWord(18)
    if (mode === 'clock')
      traces[4].completedAtUtc = new Date(Date.parse(traces[4].startedAtUtc) + 8001).toISOString()
    if (mode === 'availability') changed.availableAtUtc = plan.anchors[0].issuedAtUtc
    if (mode === 'host') changed.origins[1].host = changed.origins[0].host
    if (mode === 'id') traces[4].request.id = traces[3].request.id
    if (mode === 'extra') traces[4].privateRpcUrl = 'redacted-but-forbidden-extra-field'
    assert.throws(() => replayFluidFullPositionHistory(reseal(changed), plan))
  })
}

test('capture privately snapshots the fixed plan and configured URLs before callbacks', async () => {
  const plan = structuredClone(prepareFluidFullPositionHistoryPlan())
  const configured = structuredClone(providers)
  let mutated = false
  const transport = fakeTransport(prepareFluidFullPositionHistoryPlan(), () => {
    if (!mutated) {
      mutated = true
      plan.subject.owner = `0x${'0'.repeat(40)}`
      plan.anchors[0].source.blockHash = `0x${'0'.repeat(64)}`
      configured[0].url = 'https://unapproved.example'
    }
  })
  const value = await captureFluidFullPositionHistory(plan, configured, transport)
  const original = prepareFluidFullPositionHistoryPlan()
  assert.deepEqual(value.plan, original)
  assert.equal(
    transport.calls.every((call) => original.originHosts.includes(call.host)),
    true,
  )
  assert.equal(Object.isFrozen(value.origins[0].observations[0].traces), true)
})

test('bad configured hosts fail before any transport call and RPC errors do not retry', async () => {
  const plan = prepareFluidFullPositionHistoryPlan()
  let starts = 0
  const options = {
    now: () => NOW,
    fetchImpl: async () => {
      starts += 1
      return new Response('{}', { status: 500 })
    },
  }
  await assert.rejects(
    captureFluidFullPositionHistory(
      plan,
      [{ url: 'https://wrong.example' }, providers[1]],
      options,
    ),
    /configured_origin/,
  )
  assert.equal(starts, 0)
  await assert.rejects(captureFluidFullPositionHistory(plan, providers, options), /rpc_http/)
  assert.equal(starts <= 2, true)
})

test('native fetch rejects redirects before any unapproved transport hop', async () => {
  let escaped = 0
  const server = createServer((request, response) => {
    if (request.url === '/approved') {
      response.writeHead(302, { Location: '/unapproved' })
      response.end()
    } else {
      escaped += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const localUrl = `http://127.0.0.1:${server.address().port}/approved`
    await assert.rejects(
      captureFluidFullPositionHistory(prepareFluidFullPositionHistoryPlan(), providers, {
        now: () => NOW,
        // Only this injected test transport reaches loopback. Global external fetch stays trapped.
        fetchImpl: (_url, options) => nativeFetch(localUrl, options),
      }),
    )
    assert.equal(escaped, 0)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
