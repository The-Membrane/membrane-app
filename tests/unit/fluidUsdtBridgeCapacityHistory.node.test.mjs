import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { encodeFunctionResult, encodeFunctionData } from 'viem'
import {
  FLUID_CAPACITY_ABI,
  replayFluidCapacityProngs,
} from '../../scripts/research/carry-fluid-capacity-prongs.mjs'
import {
  FLUID_BRIDGE_CAPACITY_HISTORY_POLICY,
  FLUID_BRIDGE_CAPACITY_ABI,
  prepareFluidBridgeCapacityHistoryPlan,
  captureFluidBridgeCapacityHistory,
  replayFluidBridgeCapacityHistory,
  writeFluidBridgeCapacityHistory,
} from '../../scripts/research/fluid-usdt-bridge-capacity-history-capture.mjs'

globalThis.fetch = async () => {
  throw Error('offline_global_fetch_trap')
}
const NOW = Date.parse('2026-10-07T20:00:00.000Z')
const word = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const reseal = (value) => {
  const { sha256, ...body } = value
  return { ...body, sha256: sha(JSON.stringify(body)) }
}
const providers = [
  { url: 'https://eth-mainnet.g.alchemy.com/v2/offline-test-only' },
  { url: 'https://rpc.ankr.com/eth/offline-test-only' },
]
// Reference bytecode is an independently pinned public source fixture. All state/transport is synthetic.
const liteCode = gunzipSync(
  Buffer.from(
    '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',
    'base64',
  ),
).toString('utf8')
const proxyCode =
  '0x6080604052600a600c565b005b60186014601a565b6050565b565b5f604b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc546001600160a01b031690565b905090565b365f5f375f5f365f845af43d5f5f3e8080156069573d5ff35b3d5ffdfea26469706673582212200e0db27ba70ca09353e9dbb5aee8d4fce56c243ca738ba70318cca95a4a3de0064736f6c63430008220033'
assert.equal(sha(liteCode), '58c2f22b1a690e9f2b7ad367da9ba6293ad14bce7393bab16a4fdb39184e03f2')

function zero(output, asset) {
  if (output.type === 'tuple')
    return Object.fromEntries(output.components.map((c) => [c.name, zero(c, asset)]))
  if (output.type === 'address') return asset
  if (output.type === 'bool') return false
  return 0n
}
function fakeTransport(plan, { unknown = false, mutate, responseMutate } = {}) {
  const calls = [],
    active = new Map(),
    maxActive = new Map()
  let ticks = 0
  const now = () => NOW + ticks++ * 60
  const fetchImpl = async (url, options) => {
    const host = new URL(url).hostname,
      request = JSON.parse(options.body)
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.equal(options.signal instanceof AbortSignal, true)
    active.set(host, (active.get(host) ?? 0) + 1)
    maxActive.set(host, Math.max(active.get(host), maxActive.get(host) ?? 0))
    try {
      calls.push({ host, request })
      let anchor = plan.anchors.find((a) => a.source.blockHash === request.params.at(-1)?.blockHash)
      if (request.method === 'eth_getStorageAt')
        anchor = plan.anchors.find(
          (a) => BigInt(request.params[2]).toString() === a.source.blockNumber,
        )
      if (request.method === 'eth_getBlockByNumber' && request.params[0] !== 'finalized')
        anchor = plan.anchors.find(
          (a) => BigInt(request.params[0]).toString() === a.source.blockNumber,
        )
      let result
      if (request.method === 'eth_chainId') result = '0x1'
      else if (request.method === 'eth_getBlockByNumber') {
        if (request.params[0] === 'finalized')
          result = {
            number: '0x' + (BigInt(plan.anchors[1].source.blockNumber) + 1000n).toString(16),
            hash: '0x' + 'a'.repeat(64),
            timestamp:
              '0x' + BigInt(Date.parse(plan.anchors[1].source.blockTime) / 1000 + 100).toString(16),
          }
        else
          result = {
            number: '0x' + BigInt(anchor.source.blockNumber).toString(16),
            hash: anchor.source.blockHash,
            timestamp: '0x' + BigInt(Date.parse(anchor.source.blockTime) / 1000).toString(16),
          }
        result.transactions = ['must-not-retain']
      } else if (request.method === 'eth_getStorageAt') {
        assert.equal(request.params[1], plan.implementationSlot)
        assert.equal(request.params[1].length, 66)
        result = '0x' + plan.mechanismReference.implementation.slice(2).padStart(64, '0')
      } else if (request.method === 'eth_getCode') {
        result =
          request.params[0] === plan.subject.destination
            ? proxyCode
            : request.params[0] === plan.mechanismReference.implementation
              ? unknown
                ? '0x6001600055'
                : liteCode
              : '0x60006000'
      } else if (request.method === 'eth_call') {
        assert.ok(anchor)
        const [call, pin] = request.params
        assert.deepEqual(Object.keys(call).sort(), ['data', 'to'])
        assert.deepEqual(pin, { blockHash: anchor.source.blockHash, requireCanonical: true })
        const selector = call.data.slice(0, 10)
        const wrapper = call.to === plan.subject.destination
        if (selector === '0x95dbb1e5')
          result = encodeFunctionResult({
            abi: FLUID_BRIDGE_CAPACITY_ABI,
            functionName: 'getFUSDC',
            result: plan.mechanismReference.expectedFUSDC,
          })
        else if (selector === '0x0631d806') result = word(20)
        else if (selector === '0x5398d2c2') result = word(0)
        else if (selector === '0xe8b276f9') result = word(2000000)
        else if (selector === '0x70a08231')
          result = word(wrapper ? anchor.holderSharesRaw : 3000000)
        else if (selector === '0xce96cb77') result = word(wrapper ? 1000000 : 2500000)
        else if (selector === '0x4cdad506') {
          assert.equal(call.data.slice(10), word(anchor.holderSharesRaw).slice(2))
          result = word(anchor.fullPositionEntitlementRaw)
        } else if (selector === '0x38d52e0f')
          result = encodeFunctionResult({
            abi: FLUID_CAPACITY_ABI,
            functionName: 'asset',
            result: plan.subject.asset,
          })
        else if (selector === '0x313ce567') result = word(6)
        else {
          const target = ['getData', 'LIQUIDITY', 'getUserSupplyData'].find(
            (functionName) =>
              encodeFunctionData({
                abi: FLUID_CAPACITY_ABI,
                functionName,
                args:
                  functionName === 'getUserSupplyData'
                    ? [plan.protocolSubject.destination, plan.subject.asset]
                    : [],
              }) === call.data,
          )
          assert.ok(target, 'exact retained protocol ABI getter')
          if (target === 'getData')
            result = encodeFunctionResult({
              abi: FLUID_CAPACITY_ABI,
              functionName: target,
              result: [
                plan.protocolBank,
                plan.subject.asset,
                plan.subject.asset,
                plan.subject.asset,
                plan.subject.asset,
                false,
                10000000n,
                1000000000000n,
                1000000000000n,
              ],
            })
          else if (target === 'LIQUIDITY')
            result = encodeFunctionResult({
              abi: FLUID_CAPACITY_ABI,
              functionName: target,
              result: plan.protocolBank,
            })
          else {
            const entry = FLUID_CAPACITY_ABI.find((e) => e.name === target)
            const supply = zero(entry.outputs[0], plan.subject.asset),
              overall = zero(entry.outputs[1], plan.subject.asset)
            Object.assign(supply, {
              modeWithInterest: true,
              supply: 10000000n,
              withdrawalLimit: 9000000n,
              withdrawableUntilLimit: 1000000n,
              withdrawable: 500000n,
              lastUpdateTimestamp: BigInt(Date.parse(anchor.source.blockTime) / 1000),
              baseWithdrawalLimit: 9000000n,
            })
            result = encodeFunctionResult({
              abi: FLUID_CAPACITY_ABI,
              functionName: target,
              result: [supply, overall],
            })
          }
        }
      } else assert.fail('unexpected RPC method')
      const response = { jsonrpc: '2.0', id: request.id, result }
      responseMutate?.({ response, request, anchor, host })
      mutate?.({ request, anchor, plan })
      await Promise.resolve()
      return new Response(JSON.stringify(response), { status: 200 })
    } finally {
      active.set(host, active.get(host) - 1)
    }
  }
  return { now, fetchImpl, calls, maxActive }
}
let cachedPlan
const getPlan = () => (cachedPlan ??= prepareFluidBridgeCapacityHistoryPlan())
let positiveFixture
async function fixture(options) {
  if (options === undefined && positiveFixture) return positiveFixture
  const plan = getPlan(),
    transport = fakeTransport(plan, options)
  const value = await captureFluidBridgeCapacityHistory(plan, providers, transport)
  const result = { plan, transport, value }
  if (options === undefined) positiveFixture = result
  return result
}

test('zero RPC preparation preserves old issue/full E/full path pins and exact 32-byte proxy slot', () => {
  const plan = getPlan()
  assert.deepEqual(
    plan.anchors.map((a) => a.source.blockNumber),
    ['26101887', '26102143'],
  )
  assert.deepEqual(
    plan.anchors.map((a) => a.fullPositionEntitlementRaw),
    ['1014574', '1014581'],
  )
  assert.equal(
    plan.implementationSlot,
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  )
  assert.equal(
    plan.fullPathInput.fileSha256,
    'ae7d24e26a5303b638bfdc23f961333ded0c2521f5c4da7af1e394c3138bcb6b',
  )
  assert.equal(
    plan.originalIssueAnchors[0].fileSha256,
    'ed9879f7bd271fac0b39fc140bf87839dc04995374ea97e034f022952fa71356',
  )
  assert.equal(
    plan.priorInputEvidence[0].fileSha256,
    '6a1526fdcb4ee3d85ccaa5a6d72e4d23ec32d5cffb73c36cec909ac35160ee52',
  )
  assert.equal(plan.policy.maxRequests, 112)
  assert.equal(plan.policy.reserveBytes, 128 * 1024 * 1024)
  assert.equal(plan.policy.maxInFlightPerHost, 1)
  assert.equal(plan.policy.retries, 0)
  assert.equal(plan.sourceImplementationEquivalence, false)
})

test('112 synthetic getter reads bind reviewed wrapper but leave underlying source equivalence and global C unassessed', async () => {
  const { plan, transport, value } = await fixture()
  const result = replayFluidBridgeCapacityHistory(value, plan)
  assert.equal(transport.calls.length, 112)
  assert.equal(value.physicalStarts, 112)
  assert.equal(
    value.wrapperOrigins.flatMap((o) => o.observations.flatMap((a) => a.traces)).length,
    56,
  )
  assert.deepEqual(
    value.protocolCaptures.map((c) => c.budget.physicalRequestStarts),
    [28, 28],
  )
  assert.deepEqual([...transport.maxActive.values()], [1, 1])
  assert.equal(
    result.points.every((p) => p.wrapperSourceBinding === 'reviewed_lite_runtime_bound'),
    true,
  )
  assert.equal(
    result.points.every((p) => p.proxySourceEquivalence === 'reviewed_proxy_runtime_bound'),
    true,
  )
  assert.equal(
    result.points.every((p) => p.underlyingSourceEquivalence === 'unverified_at_captured_runtime'),
    true,
  )
  assert.equal(result.points[0].underlyingProtocolProngs.sharedLiquidityCashRaw, '3000000')
  assert.equal(result.points[0].underlyingProtocolProngs.withdrawableUntilLimitRaw, '1000000')
  assert.equal(result.points[0].idleMeaning, 'fUSDC_claim_not_immediate_bank_cash')
  assert.equal(
    result.points[0].liteMaxWithdrawMeaning,
    'incomplete_view_omits_underlying_bank_cash_and_limit',
  )
  assert.equal(result.sourceImplementationEquivalence, false)
  assert.equal(result.globalCapacityRaw, null)
  assert.equal(result.minedPayout, false)
  assert.equal(result.forecastValidated, false)
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes('offline-test-only'), false)
  assert.equal(serialized.includes('must-not-retain'), false)
  assert.equal(serialized.includes('eth_send'), false)
  assert.equal(serialized.includes('"latest"'), false)
  assert.equal(
    Buffer.byteLength(serialized) < FLUID_BRIDGE_CAPACITY_HISTORY_POLICY.maxArtifactBytes,
    true,
  )
})

test('unexpected historical implementation retains native bytes as typed unknown and closes protocol launches', async () => {
  const { plan, transport, value } = await fixture({ unknown: true })
  const result = replayFluidBridgeCapacityHistory(value, plan)
  assert.equal(transport.calls.length, 56)
  assert.deepEqual(value.protocolCaptures, [])
  assert.equal(
    value.wrapperOrigins[0].observations[0].traces.find((t) => t.key === 'implementation_code')
      .response.result,
    '0x6001600055',
  )
  assert.equal(
    result.points.every((p) => p.wrapperSourceBinding === 'unknown_historical_implementation'),
    true,
  )
  assert.equal(
    result.points.every((p) => p.underlyingProtocolProngs === null),
    true,
  )
  assert.equal(result.forecastValidated, false)
})

test('unknown implementation with getFUSDC revert retains qualified raw revert and bounds shortened plan', async () => {
  const { plan, transport, value } = await fixture({
    unknown: true,
    responseMutate: ({ response, request }) => {
      if (request.method === 'eth_call' && request.params[0].data === '0x95dbb1e5') {
        delete response.result
        response.error = { code: 3, message: 'execution reverted', data: '0xdeadbeef' }
      }
    },
  })
  const result = replayFluidBridgeCapacityHistory(value, plan)
  assert.equal(transport.calls.length, 48)
  assert.equal(result.points[0].observedFUSDC, null)
  assert.equal(result.points[0].abiStatuses.fusdc_max_withdraw_bridge, 'not_read')
})

for (const mode of [
  'plan',
  'old_hash',
  'storage_tag',
  'slot',
  'canonical',
  'owner',
  'shares',
  'full_e',
  'preview_argument',
  'code',
  'proxy_code',
  'fusdc',
  'rpc_extra',
  'trace_extra',
  'id',
  'clock',
  'availability',
  'host',
  'count',
  'protocol_source',
  'protocol_cash',
  'protocol_roundtrip',
  'protocol_extra',
  'protocol_runtime_join',
]) {
  test(`replay rejects resealed ${mode} alteration`, async () => {
    const { plan, value } = await fixture()
    const changed = structuredClone(value),
      observation = changed.wrapperOrigins[0].observations[0]
    const find = (key) => observation.traces.find((t) => t.key === key)
    if (mode === 'plan') changed.plan.anchors[0].fullPositionEntitlementRaw = '10145'
    if (mode === 'old_hash') observation.source.blockHash = '0x' + '0'.repeat(64)
    if (mode === 'storage_tag') find('implementation_slot').request.params[2] = 'latest'
    if (mode === 'slot') find('implementation_slot').request.params[1] += '1'
    if (mode === 'canonical') find('withdrawal_fee_bps').request.params[1].requireCanonical = false
    if (mode === 'owner')
      find('holder_balance').request.params[0].data = '0x70a08231' + '0'.repeat(64)
    if (mode === 'shares') find('holder_balance').response.result = word(10145)
    if (mode === 'full_e') find('full_preview_redeem_net_fee').response.result = word(10145)
    if (mode === 'preview_argument')
      find('full_preview_redeem_net_fee').request.params[0].data =
        '0x4cdad506' + word(10145).slice(2)
    if (mode === 'code') find('implementation_code').response.result = '0x60006000'
    if (mode === 'proxy_code') find('bridge_proxy_code').response.result = '0x60006000'
    if (mode === 'fusdc') find('get_fusdc').response.result = word(0)
    if (mode === 'rpc_extra') find('withdrawal_fee_bps').response.extra = 'forbidden'
    if (mode === 'trace_extra') find('withdrawal_fee_bps').privateRpcUrl = 'forbidden'
    if (mode === 'id') find('withdrawal_fee_bps').request.id = find('get_fusdc').request.id
    if (mode === 'clock')
      find('withdrawal_fee_bps').completedAtUtc = new Date(
        Date.parse(find('withdrawal_fee_bps').startedAtUtc) + 8001,
      ).toISOString()
    if (mode === 'availability') changed.availableAtUtc = plan.anchors[0].source.blockTime
    if (mode === 'host') changed.wrapperOrigins[1].host = changed.wrapperOrigins[0].host
    if (mode === 'count') changed.physicalStarts += 1
    if (mode === 'protocol_source')
      changed.protocolCaptures[0].source.blockHash = plan.anchors[1].source.blockHash
    if (mode === 'protocol_cash') {
      const r = changed.protocolCaptures[0]
      r.traces.find((t) => t.phase === 'cash').response.result = word(1)
      changed.protocolCaptures[0] = reseal(r)
    }
    if (mode === 'protocol_roundtrip') {
      const r = changed.protocolCaptures[0]
      for (const t of r.traces.filter((t) => t.phase === 'cash'))
        t.response.result += '0'.repeat(64)
      changed.protocolCaptures[0] = reseal(r)
    }
    if (mode === 'protocol_extra') {
      const r = changed.protocolCaptures[0]
      r.privateRpcUrl = 'forbidden'
      changed.protocolCaptures[0] = reseal(r)
    }
    if (mode === 'protocol_runtime_join') {
      const r = changed.protocolCaptures[0]
      for (const t of r.traces.filter(
        (t) => t.phase === 'code:' + plan.protocolSubject.destination,
      ))
        t.response.result = '0x6001600055'
      const bare = structuredClone(r)
      delete bare.sha256
      delete bare.prongs
      r.prongs = replayFluidCapacityProngs(bare, plan.protocolSubject, {
        ...plan.anchors[0].source,
        blockNumber: Number(plan.anchors[0].source.blockNumber),
        finalized: true,
      })
      changed.protocolCaptures[0] = reseal(r)
    }
    assert.throws(() => replayFluidBridgeCapacityHistory(reseal(changed), plan))
  })
}

test('private snapshots defeat plan and configured URL mutation during transport callbacks', async () => {
  const plan = getPlan(),
    configured = structuredClone(providers)
  let mutated = false
  const transport = fakeTransport(plan, {
    unknown: true,
    mutate: () => {
      if (!mutated) {
        mutated = true
        configured[0].url = 'https://unapproved.example'
      }
    },
  })
  const value = await captureFluidBridgeCapacityHistory(plan, configured, transport)
  assert.equal(
    transport.calls.every((c) => plan.originHosts.includes(c.host)),
    true,
  )
  assert.equal(Object.isFrozen(value.wrapperOrigins[0].observations[0].traces), true)
  await assert.rejects(
    captureFluidBridgeCapacityHistory(structuredClone(plan), providers, transport),
    /independently_prepared_plan_required/,
  )
})

test('bad origins stop before transport; failures are sanitized, cancel peer launches, and never retry', async () => {
  const plan = getPlan()
  let starts = 0
  const fetchImpl = async () => {
    starts++
    throw Error('private-key-must-not-leak')
  }
  await assert.rejects(
    captureFluidBridgeCapacityHistory(plan, [{ url: 'https://wrong.example' }, providers[1]], {
      fetchImpl,
      now: () => NOW,
    }),
    /configured_origin/,
  )
  assert.equal(starts, 0)
  await assert.rejects(
    captureFluidBridgeCapacityHistory(plan, providers, { fetchImpl, now: () => NOW }),
    (error) => error.message === 'fluid_bridge_capacity_capture_failed',
  )
  assert.ok(starts <= 2)
})

test('response byte cap closes the reader and redirects and arbitrary RPC errors are rejected', async () => {
  const plan = getPlan()
  let canceled = 0
  const huge = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(65537))
        },
        cancel() {
          canceled++
        },
      }),
    )
  await assert.rejects(
    captureFluidBridgeCapacityHistory(plan, providers, {
      fetchImpl: async () => huge(),
      now: () => NOW,
    }),
    /capture_failed/,
  )
  assert.equal(canceled, 2)
  await assert.rejects(
    captureFluidBridgeCapacityHistory(plan, providers, {
      fetchImpl: async (_, options) => {
        const request = JSON.parse(options.body)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32005, message: 'private-secret' },
          }),
        )
      },
      now: () => NOW,
    }),
    /capture_failed/,
  )
  await assert.rejects(
    captureFluidBridgeCapacityHistory(plan, providers, {
      fetchImpl: async () => {
        const r = new Response('{}')
        Object.defineProperty(r, 'redirected', { value: true })
        return r
      },
      now: () => NOW,
    }),
    /capture_failed/,
  )
})

test('exclusive output is mode 0600 and never overwrites files or symlinks', async () => {
  const { plan, value } = await fixture({ unknown: true })
  const directory = mkdtempSync('/private/tmp/fluid-bridge-capacity-test-')
  try {
    const output = resolve(directory, 'native.json')
    writeFluidBridgeCapacityHistory(output, value, plan)
    assert.equal(statSync(output).mode & 0o777, 0o600)
    assert.deepEqual(
      replayFluidBridgeCapacityHistory(JSON.parse(readFileSync(output, 'utf8')), plan),
      replayFluidBridgeCapacityHistory(value, plan),
    )
    assert.throws(() => writeFluidBridgeCapacityHistory(output, value, plan), /EEXIST/)
    const link = resolve(directory, 'link.json')
    symlinkSync(output, link)
    assert.throws(() => writeFluidBridgeCapacityHistory(link, value, plan))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('fixed old full path file rejects caller recomputation', () => {
  const plan = getPlan(),
    directory = mkdtempSync('/private/tmp/fluid-bridge-capacity-pin-test-')
  try {
    const paths = new Set([
      plan.fullPathInput.path,
      ...plan.priorInputEvidence.map((i) => i.path),
      ...plan.originalIssueAnchors.map(
        (a) =>
          'data/research/venue-signals/carry-fluid-bridge-usdt-holder-v1/issues/' + a.issueFile,
      ),
    ])
    for (const path of paths) {
      mkdirSync(resolve(directory, path, '..'), { recursive: true })
      writeFileSync(resolve(directory, path), readFileSync(path))
    }
    const fullPath = resolve(directory, plan.fullPathInput.path),
      raw = JSON.parse(readFileSync(fullPath, 'utf8'))
    raw.availableAtUtc = '2026-10-07T19:44:28.743Z'
    writeFileSync(fullPath, JSON.stringify(reseal(raw)) + '\n')
    assert.throws(
      () => prepareFluidBridgeCapacityHistoryPlan({ root: directory }),
      /external_path_file_pin/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('default CLI prepares with no RPC; invalid mode produces only generic sanitized error', () => {
  const script = resolve('scripts/research/fluid-usdt-bridge-capacity-history-capture.mjs')
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=384', '--import', 'tsx', script],
    { encoding: 'utf8', timeout: 30000 },
  )
  assert.equal(result.status, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.equal(value.status, 'prepared_no_rpc')
  assert.equal(value.maximumPhysicalStarts, 112)
  const invalid = spawnSync(
    process.execPath,
    ['--max-old-space-size=384', '--import', 'tsx', script, '--wrong-mode'],
    { encoding: 'utf8', timeout: 30000 },
  )
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stderr.trim(), 'fluid_bridge_capacity_capture_failed')
})
