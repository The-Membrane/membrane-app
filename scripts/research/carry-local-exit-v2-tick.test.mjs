import assert from 'node:assert/strict'
import test from 'node:test'

import { syntheticVerifiedMeasurementFixture } from '../lib/carry-exit-v2-verified-measurement-fixture.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import {
  configuredLocalExitV2RpcUrls,
  configuredLocalExitV2RpcUrlsWithVerification,
  createLocalCarryExitV2Adapters,
  localExitV2RpcTransport,
  runLocalCarryExitV2Tick,
} from './carry-local-exit-v2-tick.mjs'

const context = {
  plan: { targetAtUtc: '2026-10-07T11:00:00.000Z' },
  issue: {
    payload: {
      baselineBlock: '100',
      baselineHash: `0x${'a'.repeat(64)}`,
    },
  },
  row: {
    routeKey: 'route',
    destination: `0x${'1'.repeat(40)}`,
    asset: `0x${'2'.repeat(40)}`,
    holder: `0x${'3'.repeat(40)}`,
    assetsRaw: '1000000',
  },
}

test('source adapters dispatch exact local identities without SQL or batch identifiers', async () => {
  const calls = []
  const primary = {
    url: 'https://one.example/rpc',
    provider: 'https://one.example',
    request: async () => 'result',
    send: async (envelope) => ({ ...envelope, result: '0x' }),
  }
  const secondary = {
    url: 'https://two.example/rpc',
    provider: 'https://two.example',
    send: async (envelope) => ({ ...envelope, result: '0x' }),
  }
  const adapters = createLocalCarryExitV2Adapters({
    primary,
    secondary,
    select: async (input) => {
      calls.push(['select', input])
      return { targetBlock: '101' }
    },
    measure: async (input) => {
      calls.push(['measure', input])
      return { status: 'verified', callEvidenceDoc: { schema: 'fixture' } }
    },
    classifiers: {
      morpho: (input) => input,
      direct: (input) => input,
      sync_vault: (input) => input,
    },
  })
  const target = await adapters.sync_vault.chooseTarget(context)
  await adapters.sync_vault.measure(context, target)
  const classified = await adapters.sync_vault.classify({ value: 1 })
  assert.deepEqual(classified, { value: 1 })
  assert.equal(calls[0][1].baselineBlock, '100')
  assert.equal(calls[0][1].targetAt, context.plan.targetAtUtc)
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(calls[1][1]).filter(([key]) =>
        ['routeKey', 'destination', 'asset', 'holder', 'assetsRaw'].includes(key),
      ),
    ),
    context.row,
  )
  assert.equal('batchId' in calls[0][1], false)
  assert.equal('caseId' in calls[1][1], false)
})

test('the local sync-vault adapter reuses the existing verified classifier', async () => {
  const fixture = syntheticVerifiedMeasurementFixture()
  const verified = await measureCarryExitV2Verified(fixture.input)
  const target = fixture.input.target
  const transport = {
    provider: 'fixture',
    request: async () => null,
    send: async () => null,
  }
  const adapters = createLocalCarryExitV2Adapters({
    primary: { ...transport, url: 'https://one.example/rpc' },
    secondary: { ...transport, url: 'https://two.example/rpc' },
  })
  const core = {
    horizonH: 1,
    targetAt: '2026-09-30T00:00:00.000001Z',
    deadlineAt: '2026-09-30T02:00:00.000001Z',
    predecessorH: 0,
    predecessorStatus: 'success',
  }
  const result = await adapters.sync_vault.classify({
    core,
    target,
    verified,
    row: {
      routeKey: fixture.input.routeKey,
      destination: fixture.input.destination,
      asset: fixture.input.asset,
      holder: fixture.input.holder,
      assetsRaw: fixture.input.assetsRaw,
    },
    capturedAt: '2026-09-30T00:00:30.000Z',
  })
  assert.equal(result.status, 'success')
  assert.equal(result.holderCoverageRaw, '2000000')
  assert.equal(result.requiredCoverageRaw, '1200000')
  assert.equal(result.actualConsumedRaw, '1000000')
})

test('tick remains a typed local abstention when two RPC origins are unavailable', async () => {
  const result = await runLocalCarryExitV2Tick({
    urls: [],
    readback: () => ({ counts: {}, independentWitness: false }),
    score: async ({ adapters }) => ({
      counts: { source_adapter_unavailable: Object.keys(adapters).length === 0 ? 1 : 0 },
      forecastValidated: false,
    }),
  })
  assert.equal(result.rpcStatus, 'unavailable')
  assert.equal(result.databaseUsed, false)
  assert.equal(result.sqlBatchIdsUsed, false)
  assert.equal(result.independentTimestamp, false)
  assert.equal(result.independentWitness, false)
  assert.equal(result.forecastValidated, false)
  assert.deepEqual(result.score.counts, { source_adapter_unavailable: 1 })
})

test('RPC configuration and transport are bounded and preserve JSON-RPC envelopes', async () => {
  assert.deepEqual(
    configuredLocalExitV2RpcUrls('https://one.example/rpc, https://two.example/rpc'),
    ['https://one.example/rpc', 'https://two.example/rpc'],
  )
  assert.throws(() => configuredLocalExitV2RpcUrls(''))
  assert.throws(() => configuredLocalExitV2RpcUrls('https://one.example,https://one.example'))
  const requests = []
  const optionsSeen = []
  const transport = localExitV2RpcTransport('https://one.example/rpc', async (_url, options) => {
    const envelope = JSON.parse(options.body)
    optionsSeen.push(options)
    requests.push(envelope)
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: envelope.id, result: envelope.method }),
      { status: 200 },
    )
  })
  assert.equal(await transport.request('eth_chainId', []), 'eth_chainId')
  assert.deepEqual(requests[0], { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
  assert.equal(optionsSeen[0].redirect, 'error')
})

test('CLI RPC configuration adds a distinct verification origin', () => {
  assert.deepEqual(
    configuredLocalExitV2RpcUrlsWithVerification({
      urls: 'https://one.example/rpc',
    }),
    ['https://one.example/rpc', 'https://eth.drpc.org'],
  )
  assert.deepEqual(
    configuredLocalExitV2RpcUrlsWithVerification({
      urls: 'https://one.example/rpc,https://raw-secondary.example/rpc',
      verificationUrl: 'https://two.example/verify',
    }),
    ['https://one.example/rpc', 'https://two.example/verify', 'https://raw-secondary.example/rpc'],
  )
  assert.deepEqual(
    configuredLocalExitV2RpcUrlsWithVerification({
      urls: 'https://one.example/rpc',
      verificationUrl: 'https://one.example/verify',
    }),
    ['https://one.example/rpc'],
  )
})

test('same-host origins cannot be presented as independent replay', () => {
  const base = {
    provider: 'fixture',
    request: async () => null,
    send: async () => null,
  }
  assert.throws(
    () =>
      createLocalCarryExitV2Adapters({
        primary: { ...base, url: 'https://rpc.example/a' },
        secondary: { ...base, url: 'https://rpc.example/b' },
      }),
    /independent_origins_required/,
  )
})
