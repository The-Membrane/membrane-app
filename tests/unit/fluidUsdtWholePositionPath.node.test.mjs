import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAbi, encodeFunctionResult, decodeFunctionData } from 'viem'
import {
  ABI as QUOTE_ABI,
  CONTRACTS,
} from '../../scripts/research/fluid-usdt-historical-conversion-capture.mjs'
import {
  FLUID_WHOLE_POSITION_PATH_POLICY,
  prepareFluidWholePositionPathPlan,
  fluidWholePositionPathReadPlan,
  captureFluidWholePositionPath,
  replayFluidWholePositionPath,
  writeFluidWholePositionPath,
} from '../../scripts/research/fluid-usdt-whole-position-path-capture.mjs'

let globalAttempts = 0
const nativeFetch = globalThis.fetch
globalThis.fetch = async () => {
  globalAttempts++
  throw Error('offline_global_fetch_trap')
}
test.after(() => {
  globalThis.fetch = nativeFetch
})
const plan = prepareFluidWholePositionPathPlan()
const ABI = parseAbi([
  'function withdraw(uint256 assets,address receiver,address owner) returns(uint256 shares)',
  'function redeem(uint256 shares,address receiver,address owner) returns(uint256 assets)',
])
const NOW = Date.parse('2026-10-07T20:00:00.000Z')
const providers = () => [
  { url: 'https://eth-mainnet.g.alchemy.com/v2/unit-test-only-private-path' },
  { url: 'https://rpc.ankr.com/eth/unit-test-only-private-path' },
]
const reseal = (value) => {
  const { sha256, ...body } = value
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}

// Synthetic responses exercise transport and replay only; they are not research observations.
function transport(mutate) {
  const calls = [],
    active = new Map(),
    maxActive = new Map()
  let ticks = 0
  const fetchImpl = async (url, options) => {
    const host = new URL(url).hostname
    active.set(host, (active.get(host) ?? 0) + 1)
    maxActive.set(host, Math.max(maxActive.get(host) ?? 0, active.get(host)))
    try {
      const request = JSON.parse(options.body)
      const index =
        request.method === 'eth_getBlockByNumber'
          ? plan.anchors.findIndex(
              (anchor) =>
                request.params[0] === '0x' + BigInt(anchor.source.blockNumber).toString(16),
            )
          : plan.anchors.findIndex(
              (anchor) => request.params[1].blockHash === anchor.source.blockHash,
            )
      assert.ok(index >= 0)
      const anchor = plan.anchors[index]
      const specs = fluidWholePositionPathReadPlan(plan, index)
      let spec = specs.find(
        (candidate) =>
          candidate.method === request.method &&
          JSON.stringify(candidate.params) === JSON.stringify(request.params),
      )
      if (request.method === 'eth_getBlockByNumber') {
        const sameSourceHeaders = calls.filter(
          (call) =>
            call.host === host &&
            call.index === index &&
            call.request.method === 'eth_getBlockByNumber',
        ).length
        spec = specs[sameSourceHeaders === 0 ? 0 : 5]
      }
      assert.ok(spec)
      calls.push({ host, index, key: spec.key, request, options })
      assert.equal(options.redirect, 'error')
      let result
      if (request.method === 'eth_getBlockByNumber')
        result = {
          number: request.params[0],
          hash: anchor.source.blockHash,
          timestamp: '0x' + (BigInt(Date.parse(anchor.source.blockTime)) / 1000n).toString(16),
          transactions: [],
          extraNativeHeaderField: 'not_retained',
        }
      else if (spec.key === 'quote_exact_full_position')
        result = encodeFunctionResult({
          abi: QUOTE_ABI,
          functionName: 'quoteExactInputSingle',
          result: [BigInt(anchor.fullPositionEntitlementRaw) + 10n, 1n << 96n, 1, 50000n],
        })
      else
        result = encodeFunctionResult({
          abi: ABI,
          functionName: spec.key === 'redeem_full_position' ? 'redeem' : 'withdraw',
          result:
            spec.key === 'redeem_full_position'
              ? BigInt(anchor.fullPositionEntitlementRaw)
              : spec.key === 'withdraw_exact_small'
                ? 9675903522082192n
                : BigInt(anchor.holderSharesRaw),
        })
      let envelope = { jsonrpc: '2.0', id: request.id, result }
      if (mutate)
        envelope =
          (await mutate({ host, index, key: spec.key, request, options, envelope, anchor })) ??
          envelope
      return new Response(JSON.stringify(envelope))
    } finally {
      active.set(host, active.get(host) - 1)
    }
  }
  return { calls, maxActive, fetchImpl, now: () => NOW + ticks++ }
}
async function fixture(mutate) {
  const fake = transport(mutate)
  const value = await captureFluidWholePositionPath(plan, providers(), fake)
  return { ...fake, value, replay: replayFluidWholePositionPath(value, plan) }
}
const valid = await fixture()

test('actual pinned evidence prepares 24 canonical read-only calls with exact native full shares and E, zero RPC', () => {
  assert.equal(globalAttempts, 0)
  assert.deepEqual(
    plan.anchors.map((anchor) => anchor.fullPositionEntitlementRaw),
    ['1014574', '1014581'],
  )
  assert.equal(FLUID_WHOLE_POSITION_PATH_POLICY.maxRequests, 24)
  assert.equal(FLUID_WHOLE_POSITION_PATH_POLICY.rpcTimeoutMs, 8000)
  assert.equal(FLUID_WHOLE_POSITION_PATH_POLICY.retries, 0)
  for (let index = 0; index < 2; index++) {
    const anchor = plan.anchors[index],
      specs = fluidWholePositionPathReadPlan(plan, index)
    assert.deepEqual(
      specs.map((spec) => spec.key),
      [
        'header_before',
        'withdraw_exact_small',
        'withdraw_full_position',
        'redeem_full_position',
        'quote_exact_full_position',
        'header_after',
      ],
    )
    for (const spec of specs.slice(1, 5))
      assert.deepEqual(spec.params[1], {
        blockHash: anchor.source.blockHash,
        requireCanonical: true,
      })
    for (const [step, amount] of [
      [1, '10145'],
      [2, anchor.fullPositionEntitlementRaw],
      [3, anchor.holderSharesRaw],
    ]) {
      const decoded = decodeFunctionData({ abi: ABI, data: specs[step].params[0].data })
      assert.equal(decoded.args[0].toString(), amount)
      assert.equal(decoded.args[1].toLowerCase(), plan.subject.owner)
      assert.equal(decoded.args[2].toLowerCase(), plan.subject.owner)
      assert.equal(specs[step].params[0].from, plan.subject.owner)
      assert.equal(specs[step].params[0].to, plan.subject.destination)
    }
    const quote = decodeFunctionData({ abi: QUOTE_ABI, data: specs[4].params[0].data }).args[0]
    assert.equal(quote.amountIn.toString(), anchor.fullPositionEntitlementRaw)
    assert.equal(quote.tokenIn.toLowerCase(), CONTRACTS.usdc)
    assert.equal(quote.tokenOut.toLowerCase(), CONTRACTS.usdt)
    assert.equal(quote.fee, 100)
    assert.equal(quote.sqrtPriceLimitX96, 0n)
    assert.equal(specs[4].params[0].to, CONTRACTS.quoter)
    assert.equal(anchor.quoteTemplateEvidence.length, 2)
  }
})

test('bounded fixture retains native raw returns, independent redemption equality and both header enclosures', () => {
  assert.equal(valid.calls.length, 24)
  assert.equal(valid.value.physicalStarts, 24)
  assert.deepEqual([...valid.maxActive.values()], [1, 1])
  assert.ok(Buffer.byteLength(JSON.stringify(valid.value)) + 1 < 65536)
  assert.doesNotMatch(
    JSON.stringify(valid.value),
    /https?:\/\/|unit-test-only-private-path|not_retained/,
  )
  for (const point of valid.replay.points) {
    assert.equal(point.exactSmallWithdrawal.status, 'two_origin_simulation_success')
    assert.equal(point.wholePositionWithdrawal.status, 'two_origin_simulation_success')
    assert.equal(point.wholePositionRedemption.returnedAssetsRaw, point.fullPositionEntitlementRaw)
    assert.equal(point.wholePositionRedemption.entitlementMatchesPinnedFullPosition, true)
    assert.equal(point.wholePositionConversion.inputRaw, point.fullPositionEntitlementRaw)
    assert.equal(point.wholePositionConversion.status, 'conditional_exact_size_quote')
    assert.equal(point.nativeRecipientDelivery, 'unassessed_simulation_only')
    assert.equal(point.minedUsdtPayment, 'unassessed')
  }
  assert.equal(valid.replay.historicalOnly, true)
  assert.equal(valid.replay.minedPayout, false)
  assert.equal(valid.replay.sourceImplementationEquivalence, false)
})

test('strict same-origin EVM revert is retained as a negative native prong without payment promotion', async () => {
  const result = await fixture(({ key, request }) =>
    key === 'withdraw_full_position'
      ? {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: 3, message: 'execution reverted', data: '0xdeadbeef' },
        }
      : undefined,
  )
  assert.equal(result.calls.length, 24)
  for (const point of result.replay.points) {
    assert.equal(point.wholePositionWithdrawal.status, 'two_origin_evm_revert')
    assert.equal(point.wholePositionWithdrawal.revertData, '0xdeadbeef')
    assert.equal(point.wholePositionConversion.status, 'conditional_exact_size_quote')
    assert.equal(point.finalSwapExecution, 'unassessed')
  }
})

test('RPC quota/network errors and misleading code 3 never become EVM reverts or leak private messages', async () => {
  for (const error of [
    { code: -32005, message: 'quota exceeded https://private.example/key', data: '0x' },
    { code: 3, message: 'network quota error https://private.example/key', data: '0x' },
    {
      code: -32000,
      message: 'execution reverted: secret text https://private.example/key',
      data: '0x',
    },
  ]) {
    const fake = transport(({ key, request }) =>
      key === 'withdraw_exact_small' ? { jsonrpc: '2.0', id: request.id, error } : undefined,
    )
    await assert.rejects(captureFluidWholePositionPath(plan, providers(), fake), (failure) => {
      assert.equal(failure.message, 'fluid_whole_position_capture_failed')
      assert.doesNotMatch(failure.message, /private|https|quota/)
      return true
    })
    const startsAtFailure = fake.calls.length
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fake.calls.length, startsAtFailure)
    assert.ok(startsAtFailure <= 6)
  }
})

test('mutating caller providers during fetch cannot replace the private source/owner/URL snapshots', async () => {
  const callerProviders = providers()
  const fake = transport(() => {
    callerProviders[0].url = 'https://unsupported.example/secret'
    assert.throws(() => {
      plan.anchors[0].source.blockHash = plan.anchors[1].source.blockHash
    }, TypeError)
  })
  const result = await captureFluidWholePositionPath(plan, callerProviders, fake)
  assert.equal(fake.calls.length, 24)
  assert.deepEqual(
    result.origins.map((origin) => origin.host),
    plan.originHosts,
  )
  assert.equal(result.plan.anchors[0].source.blockHash, plan.anchors[0].source.blockHash)
})

test('redeem raw assets that differ from independent E are preserved and explicitly unqualified', async () => {
  const result = await fixture(({ key, envelope, anchor }) =>
    key === 'redeem_full_position'
      ? {
          ...envelope,
          result: encodeFunctionResult({
            abi: ABI,
            functionName: 'redeem',
            result: BigInt(anchor.fullPositionEntitlementRaw) - 1n,
          }),
        }
      : undefined,
  )
  for (const point of result.replay.points) {
    assert.equal(point.wholePositionRedemption.entitlementMatchesPinnedFullPosition, false)
    assert.equal(
      point.wholePositionRedemption.status,
      'returned_assets_do_not_match_pinned_entitlement',
    )
    assert.equal(
      BigInt(point.wholePositionRedemption.returnedAssetsRaw),
      BigInt(point.fullPositionEntitlementRaw) - 1n,
    )
  }
})

test('both origins must agree canonical native and quote outputs before a prong can qualify', async () => {
  const result = await fixture(({ host, key, envelope, anchor }) =>
    host === plan.originHosts[0] && key === 'quote_exact_full_position'
      ? {
          ...envelope,
          result: encodeFunctionResult({
            abi: QUOTE_ABI,
            functionName: 'quoteExactInputSingle',
            result: [BigInt(anchor.fullPositionEntitlementRaw) + 11n, 1n << 96n, 1, 50000n],
          }),
        }
      : undefined,
  )
  for (const point of result.replay.points) {
    assert.equal(point.wholePositionConversion.status, 'two_origin_disagreement')
    assert.equal(point.wholePositionConversion.twoOriginAgreement, false)
    assert.equal(point.wholePositionConversion.quotedUsdtOutRaw, undefined)
  }
})

test('hostile source, owner, Q, calldata and repeated-origin receipts reject after self-resealing', () => {
  for (const mutate of [
    (value) => {
      value.plan.subject.owner = '0x' + '0'.repeat(40)
    },
    (value) => {
      value.plan.anchors[0].fullPositionEntitlementRaw = '10000000000'
    },
    (value) => {
      value.origins[0].observations[0].traces[1].request.params[0].from = '0x' + '0'.repeat(40)
    },
    (value) => {
      value.origins[0].observations[0].traces[2].request.params[1].requireCanonical = false
    },
    (value) => {
      value.origins[0].observations[0].traces[3].request.params[0].data =
        value.origins[0].observations[0].traces[2].request.params[0].data
    },
    (value) => {
      value.origins[0].host = value.origins[1].host
    },
    (value) => {
      value.origins[0].observations[0].traces[5].response.result.hash =
        value.plan.anchors[1].source.blockHash
    },
  ]) {
    const value = structuredClone(valid.value)
    mutate(value)
    assert.throws(() => replayFluidWholePositionPath(reseal(value), plan), /fluid_whole_position_/)
  }
  assert.throws(
    () => replayFluidWholePositionPath(valid.value, structuredClone(plan)),
    /independently_prepared_plan_required/,
  )
})

test('native canonical result widths, shares bounds and matching source headers are required', async () => {
  for (const mutate of [
    ({ key, envelope }) =>
      key === 'withdraw_exact_small' ? { ...envelope, result: envelope.result + '00' } : undefined,
    ({ key, envelope, anchor }) =>
      key === 'withdraw_full_position'
        ? {
            ...envelope,
            result: encodeFunctionResult({
              abi: ABI,
              functionName: 'withdraw',
              result: BigInt(anchor.holderSharesRaw) + 1n,
            }),
          }
        : undefined,
    ({ key, envelope }) =>
      key === 'header_after'
        ? { ...envelope, result: { ...envelope.result, timestamp: '0x0' } }
        : undefined,
  ]) {
    const fake = transport(mutate)
    await assert.rejects(
      captureFluidWholePositionPath(plan, providers(), fake),
      /fluid_whole_position_capture_failed/,
    )
  }
})

test('only the approved HTTPS distinct host pair can launch; original issue-time clocks launch zero calls', async () => {
  for (const callerProviders of [
    [{ url: 'http://rpc.ankr.com' }, providers()[0]],
    [providers()[0], providers()[0]],
    [{ url: 'https://unsupported.example/key' }, providers()[0]],
  ]) {
    const fake = transport()
    await assert.rejects(
      captureFluidWholePositionPath(plan, callerProviders, fake),
      /fluid_whole_position_/,
    )
    assert.equal(fake.calls.length, 0)
  }
  const fake = transport()
  await assert.rejects(
    captureFluidWholePositionPath(plan, providers(), {
      ...fake,
      now: () => Date.parse(plan.originalIssueAnchors[0].issuedAtUtc),
    }),
    /new_acquisition_clock/,
  )
  assert.equal(fake.calls.length, 0)
})

test('response bounds and transport failures abort without a sealed artifact or subsequent launch', async () => {
  const fake = transport(({ envelope }) => ({
    ...envelope,
    result: { ...envelope.result, oversized: 'x'.repeat(65536) },
  }))
  await assert.rejects(
    captureFluidWholePositionPath(plan, providers(), fake),
    /fluid_whole_position_capture_failed/,
  )
  const starts = fake.calls.length
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.calls.length, starts)
  let transportCalls = 0
  await assert.rejects(
    captureFluidWholePositionPath(plan, providers(), {
      now: () => NOW,
      fetchImpl: async () => {
        transportCalls++
        throw Error('https://private.example/secret')
      },
    }),
    (failure) => failure.message === 'fluid_whole_position_capture_failed',
  )
  assert.equal(transportCalls, 2)
})

test('native 8-second timeout aborts both origins and no later call starts', async () => {
  let calls = 0,
    aborted = 0
  await assert.rejects(
    captureFluidWholePositionPath(plan, providers(), {
      now: () => NOW,
      fetchImpl: async (_url, { signal }) => {
        calls++
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted++
              reject(Error('aborted'))
            },
            { once: true },
          ),
        )
      },
    }),
    /fluid_whole_position_capture_failed/,
  )
  assert.equal(calls, 2)
  assert.equal(aborted, 2)
})

test('artifact output is exclusive with no symlink following and exact preserved bytes', () => {
  const directory = mkdtempSync('/private/tmp/fluid-whole-position-unit-')
  try {
    const target = resolve(directory, 'synthetic-only.json'),
      link = resolve(directory, 'symlink.json')
    writeFluidWholePositionPath(target, valid.value, plan)
    const original = readFileSync(target)
    assert.throws(() => writeFluidWholePositionPath(target, valid.value, plan), /EEXIST/)
    symlinkSync(target, link)
    assert.throws(() => writeFluidWholePositionPath(link, valid.value, plan), /EEXIST|ELOOP/)
    assert.deepEqual(readFileSync(target), original)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  assert.equal(globalAttempts, 0)
})
