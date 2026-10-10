import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { MORPHO_NATIVE_HEADER_RESPONSE_POLICY } from '../../scripts/research/morpho-probe-raw-body-storage.mjs'
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult } from 'viem'
import {
  prepareUsd3HypotheticalHistoryPlan as prepare,
  captureUsd3HypotheticalHistory as capture,
  inspectUsd3HypotheticalHistory as replay,
  replayUsd3HypotheticalHistory as authoritativeReplay,
  configuredUsd3HypotheticalOrigins as configured,
  createUsd3HypotheticalCaptureControl as control,
  usd3HypotheticalRequests as requests,
  parseUsd3HypotheticalJson as parse,
  USD3_HYPOTHETICAL_ABI as abi,
  USD3_HYPOTHETICAL_POLICY as policy,
  main,
} from '../../scripts/research/usd3-hypothetical-history-capture.mjs'

globalThis.fetch = async () => {
  throw Error('offline_global_fetch_trap')
}
const plan = prepare(),
  NOW = Date.parse('2026-10-08T12:00:00.000Z')
const origins = plan.originHosts.map((host) => ({
  host,
  url: 'https://' + host + '/private-test-secret',
}))
const sha = (x) => createHash('sha256').update(x).digest('hex')
const reseal = (v) => {
  const { sha256, ...body } = v
  return { ...body, sha256: sha(JSON.stringify(body)) }
}
const block = (s) => ({
  number: '0x' + s.blockNumber.toString(16),
  hash: s.blockHash,
  timestamp: '0x' + (Date.parse(s.blockTime) / 1000).toString(16),
})

function harness(p = plan, mutate) {
  let elapsed = 0
  const physical = [],
    timers = new Map()
  let nextTimer = 0
  const fetcher = async (url, init) => {
    const r = JSON.parse(init.body),
      host = new URL(url).hostname
    physical.push({ host, r, at: elapsed })
    const a =
      p.anchors.find(
        (a) =>
          r.params?.[0] === '0x' + a.source.blockNumber.toString(16) ||
          r.params?.at(-1)?.blockHash === a.source.blockHash,
      ) ?? p.anchors[0]
    let result
    if (r.method === 'eth_chainId') result = '0x1'
    else if (r.method === 'eth_getBlockByNumber') result = block(a.source)
    else if (r.method === 'eth_getStorageAt')
      result = '0x' + '0'.repeat(24) + p.runtimePins.implementation.slice(2)
    else if (r.method === 'eth_getCode') result = '0x6001600055'
    else {
      const { functionName, args } = decodeFunctionData({ abi, data: r.params[0].data })
      const values = {
        tokenizedStrategyAddress: p.runtimePins.delegate,
        asset: p.subject.asset,
        decimals: 6,
        previewRedeem: BigInt(p.subject.sharesRaw) + 17n,
        availableWithdrawLimit: 12000000n,
        isShutdown: false,
        nav: 1000017n,
        totalAssets: 80000000n,
        balanceOf: BigInt(a.authenticatedIdleUsdcRaw),
      }
      if (functionName === 'previewRedeem') assert.equal(args[0].toString(), p.subject.sharesRaw)
      if (functionName === 'availableWithdrawLimit')
        assert.equal(args[0].toLowerCase(), p.withdrawalLimitSubject)
      result = encodeFunctionResult({ abi, functionName, result: values[functionName] })
    }
    const envelope = { jsonrpc: '2.0', id: r.id, result }
    const alteration = mutate?.({ r, host, envelope, anchor: a, number: physical.length })
    elapsed += 1
    return new Response(
      typeof alteration === 'string' ? alteration : JSON.stringify(alteration ?? envelope),
      { status: 200 },
    )
  }
  return {
    physical,
    timers,
    advance: (n) => {
      elapsed += n
    },
    options: {
      fetcher,
      now: () => NOW + Math.floor(elapsed),
      monotonic: () => elapsed,
      pace: async (ms) => {
        elapsed += ms
      },
      setTimer: (fn, ms) => {
        const id = ++nextTimer
        timers.set(id, { fn, ms })
        return id
      },
      clearTimer: (id) => timers.delete(id),
      freeBytes: () => 1024 ** 3,
    },
  }
}
async function original(p = plan, mutate) {
  const h = harness(p, mutate)
  return { h, result: await capture(p, origins, h.options) }
}

test('plan authenticates the exact USD3 cash route and copies a positive independent fixed S', () => {
  assert.deepEqual(
    plan.anchors.map((a) => a.cashIndex),
    [115, 116, 117, 118],
  )
  assert.equal(plan.subject.routeKey, 'USDC → USD3 [USDC]')
  assert.equal(plan.subject.sharesRaw, '1000000')
  assert.equal(plan.subject.shareDecimals, 6)
  assert.equal(plan.owner, null)
  assert.equal(plan.historicalOwnership, false)
  assert.equal(
    plan.cashCompactSha256,
    '2942d212217408f7bbe401abef40d9adbeed0ae5fe35d088f8a1f22f7b5ea89d',
  )
  const input = { cashIndices: [111, 112, 113, 114], sharesRaw: '7' },
    selected = prepare(input)
  input.cashIndices[0] = 9
  input.sharesRaw = '900'
  assert.equal(selected.anchors[0].cashIndex, 111)
  assert.equal(selected.subject.sharesRaw, '7')
  assert.equal(Object.isFrozen(selected.anchors[0].source), true)
  assert.throws(
    () => requests(structuredClone(selected), selected.anchors[0].source),
    /private_prepared_plan/,
  )
  assert.throws(() => prepare({ requestedQ: '1000000' }), /selection_options/)
  assert.throws(() => main(['--capture']), /cli_mode/)
})
test('selection rejects accessor, sparse, hidden, duplicate and nonconsecutive inputs before evidence reads', () => {
  let touched = false
  assert.throws(
    () =>
      prepare({
        get root() {
          touched = true
          return '/absent'
        },
      }),
    /plain_accessors/,
  )
  assert.equal(touched, false)
  const bad = [
    [115, , 117, 118],
    [115, 116, 116, 118],
    [115, 116, 118, 119],
    [117, 118, 119, 120],
    [1, 2, 3],
    ['1', 2, 3, 4],
  ]
  for (const cashIndices of bad) assert.throws(() => prepare({ root: '/absent', cashIndices }))
  const arr = [1, 2, 3, 4]
  Object.defineProperty(arr, 'hidden', { value: 1 })
  assert.throws(() => prepare({ cashIndices: arr }), /plain_sparse/)
  for (const sharesRaw of ['0', '-1', '01', 1, '', (1n << 256n).toString()])
    assert.throws(() => prepare({ sharesRaw }), /shares/)
})
test('essential 17 requests use hash pins, explicit zero-address withdrawal subject and no owner/execution reads', () => {
  const specs = requests(plan, plan.anchors[0].source)
  assert.equal(specs.length, 17)
  assert.equal(policy.maxRequests, 138)
  assert.equal(specs.filter((s) => s.method === 'eth_getCode').length, 4)
  for (const s of specs.filter((s) => !s.key.startsWith('header')))
    assert.deepEqual(s.params.at(-1), {
      blockHash: plan.anchors[0].source.blockHash,
      requireCanonical: true,
    })
  const decoded = specs
    .filter((s) => s.method === 'eth_call')
    .map((s) => decodeFunctionData({ abi, data: s.params[0].data }))
  assert.deepEqual(decoded.find((d) => d.functionName === 'availableWithdrawLimit').args, [
    plan.withdrawalLimitSubject,
  ])
  assert.equal(
    decoded.some((d) => ['maxWithdraw', 'balanceOfOwner', 'redeem'].includes(d.functionName)),
    false,
  )
})
test('structural mock receipt replays all 138 physical starts and keeps S independent of an unobserved Q', async () => {
  const { h, result } = await original()
  assert.equal(result.structurallyAccepted, true)
  assert.equal(h.physical.length, 138)
  assert.equal(result.receipt.terminalCommitments.length, 138)
  assert.deepEqual(replay(result.receipt, plan), result.structuralReplay)
  assert.equal(JSON.stringify(result.receipt).includes('private-test-secret'), false)
  for (const p of result.structuralReplay.points) {
    assert.equal(p.nativeEaRaw, '1000017')
    assert.equal(p.hypotheticalSharesRaw, '1000000')
    assert.equal(p.withdrawalLimitSubject, plan.withdrawalLimitSubject)
    assert.equal(p.ownerCommitmentQualification, false)
    assert.equal(p.conditionalReferenceAddressQuote, true)
    assert.equal(p.idleUsdcIsTotalFundingUpperBound, false)
    assert.equal(p.sourceImplementationEquivalence, false)
    assert.equal(p.runtimeIdentities.length, 4)
    assert.equal(p.acquiredAtUtc, result.structuralReplay.availableAtUtc)
    assert.equal(Object.hasOwn(p, 'requestedQ'), false)
  }
  const alternate = prepare({ sharesRaw: '123' }),
    other = await original(alternate)
  assert.equal(other.result.structurallyAccepted, true)
  assert.equal(other.result.structuralReplay.points[0].nativeEaRaw, '140')
})
test('bound reference address and full shares are copied into all native observations without historical ownership', async () => {
  const subject = '0x1234567890123456789012345678901234567890'
  const input = { sharesRaw: '2345678', withdrawalLimitSubject: subject }
  const bound = prepare(input)
  input.sharesRaw = '999'
  input.withdrawalLimitSubject = plan.subject.destination
  assert.equal(bound.subject.sharesRaw, '2345678')
  assert.equal(bound.withdrawalLimitSubject, subject)
  assert.equal(Object.isFrozen(bound), true)
  assert.equal(bound.owner, null)
  assert.equal(bound.historicalOwnership, false)
  assert.throws(() => prepare({ owner: subject }), /selection_options/)
  assert.throws(() => prepare({ source: bound.anchors[0].source }), /selection_options/)
  assert.throws(
    () => requests(structuredClone(bound), bound.anchors[0].source),
    /private_prepared_plan/,
  )
  const { h, result } = await original(bound)
  assert.equal(result.structurallyAccepted, true)
  assert.equal(result.accepted, false)
  const limits = h.physical.filter(
    ({ r }) =>
      r.method === 'eth_call' &&
      decodeFunctionData({ abi, data: r.params[0].data }).functionName === 'availableWithdrawLimit',
  )
  assert.equal(limits.length, 8)
  assert.deepEqual([...new Set(limits.map((r) => r.host))].sort(), [...plan.originHosts].sort())
  assert.equal(new Set(limits.map(({ r }) => r.params[1].blockHash)).size, 4)
  for (const { r } of limits)
    assert.deepEqual(decodeFunctionData({ abi, data: r.params[0].data }).args, [subject])
  for (const point of result.structuralReplay.points) {
    assert.equal(point.hypotheticalSharesRaw, '2345678')
    assert.equal(point.nativeEaRaw, '2345695')
    assert.equal(point.withdrawalLimitSubject, subject)
    assert.equal(point.conditionalReferenceAddressQuote, true)
    assert.equal(point.ownerCommitmentQualification, false)
  }
  assert.equal(result.structuralReplay.owner, null)
  assert.equal(result.structuralReplay.historicalOwnership, false)
  assert.throws(
    () => authoritativeReplay(result.receipt, bound),
    /original_capture_authority_required/,
  )
})
test('optional address validates canonical nonzero own data before evidence reads, preserving the exact default plan', () => {
  assert.equal(
    sha(JSON.stringify(prepare())),
    '5d5ecf4b5b5d8a70fa356154eab23fb512ace6503877b259da95fe281257f60b',
  )
  assert.deepEqual(prepare(), plan)
  for (const withdrawalLimitSubject of [
    plan.withdrawalLimitSubject,
    null,
    1,
    '',
    '0xABCDEFabcdefabcdefabcdefabcdefabcdefabcd',
    '0x1234',
    '1'.repeat(40),
  ])
    assert.throws(
      () => prepare({ root: '/absent', withdrawalLimitSubject }),
      /withdrawal_limit_subject/,
    )
  let touched = false
  assert.throws(
    () =>
      prepare({
        get withdrawalLimitSubject() {
          touched = true
          return plan.subject.destination
        },
      }),
    /plain_accessors/,
  )
  assert.equal(touched, false)
})
test('inventoried zero-reference original cannot acquire bound subject or S authority through complete resealing', () => {
  const original = JSON.parse(
    readFileSync(
      new URL(
        '../../data/research/venue-signals/usd3-joint-native-history-evidence-2026-10-08/native-originals/01-native-historical-capture.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  assert.equal(authoritativeReplay(original, plan).authoritativeNativeCapture, true)
  const bound = prepare({
    sharesRaw: '2345678',
    withdrawalLimitSubject: '0x1234567890123456789012345678901234567890',
  })
  assert.throws(() => authoritativeReplay(original, bound), /seal_or_plan/)
  const rewritten = structuredClone(original)
  rewritten.plan = structuredClone(bound)
  rewritten.planSha256 = sha(JSON.stringify(bound))
  for (const row of rewritten.ledger) {
    if (row.request.method !== 'eth_call') continue
    const { functionName } = decodeFunctionData({ abi, data: row.request.params[0].data })
    if (!['previewRedeem', 'availableWithdrawLimit'].includes(functionName)) continue
    row.request.params[0].data = encodeFunctionData({
      abi,
      functionName,
      args:
        functionName === 'previewRedeem'
          ? [BigInt(bound.subject.sharesRaw)]
          : [bound.withdrawalLimitSubject],
    })
    if (functionName !== 'previewRedeem') continue
    const envelope = JSON.parse(Buffer.from(row.rawBodyBase64, 'base64').toString())
    envelope.result = encodeFunctionResult({ abi, functionName, result: 2345695n })
    const bytes = Buffer.from(JSON.stringify(envelope))
    row.rawBodyBase64 = bytes.toString('base64')
    row.bodyBytes = bytes.length
    row.bodySha256 = sha(bytes)
  }
  rewritten.terminalCommitments = rewritten.ledger.map((row) => ({
    physicalId: row.physicalId,
    rowSha256: sha(JSON.stringify(row)),
  }))
  const counterfeit = reseal(rewritten),
    inspection = replay(counterfeit, bound)
  assert.equal(inspection.authoritativeNativeCapture, false)
  assert.ok(
    inspection.points.every(
      (p) =>
        p.withdrawalLimitSubject === bound.withdrawalLimitSubject &&
        p.hypotheticalSharesRaw === bound.subject.sharesRaw,
    ),
  )
  assert.throws(
    () => authoritativeReplay(counterfeit, bound),
    /original_capture_authority_required/,
  )
  assert.throws(() => authoritativeReplay(counterfeit, plan), /seal_or_plan/)
})
test('independently inventoried native original replays but fully rewritten native funding quotes fail authority', () => {
  const value = JSON.parse(
    readFileSync(
      new URL(
        '../../data/research/venue-signals/usd3-joint-native-history-evidence-2026-10-08/native-originals/01-native-historical-capture.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const approved = authoritativeReplay(value, plan)
  assert.equal(approved.authoritativeNativeCapture, true)
  assert.equal(approved.points.length, 4)
  assert.ok(
    approved.points.every(
      (point) =>
        point.idleUsdcDiagnosticRaw === '0' && BigInt(point.availableWithdrawLimitRaw) > 0n,
    ),
  )
  for (const row of value.ledger) {
    if (
      row.request.method !== 'eth_call' ||
      decodeFunctionData({ abi, data: row.request.params[0].data }).functionName !==
        'availableWithdrawLimit'
    )
      continue
    const envelope = JSON.parse(Buffer.from(row.rawBodyBase64, 'base64').toString())
    envelope.result = encodeFunctionResult({
      abi,
      functionName: 'availableWithdrawLimit',
      result: BigInt(envelope.result) + 1n,
    })
    const bytes = Buffer.from(JSON.stringify(envelope))
    row.rawBodyBase64 = bytes.toString('base64')
    row.bodyBytes = bytes.length
    row.bodySha256 = sha(bytes)
  }
  value.terminalCommitments = value.ledger.map((row) => ({
    physicalId: row.physicalId,
    rowSha256: sha(JSON.stringify(row)),
  }))
  const changed = reseal(value)
  assert.equal(replay(changed, plan).authoritativeNativeCapture, false)
  assert.throws(() => authoritativeReplay(changed, plan), /original_capture_authority_required/)
})
test('injected captures and completely resealed two-origin quotes cannot mint native authority', async () => {
  const { result } = await original()
  assert.equal(result.accepted, false)
  assert.equal(result.replay, null)
  assert.equal(result.structuralReplay.authoritativeNativeCapture, false)
  assert.throws(
    () => authoritativeReplay(result.receipt, plan),
    /original_capture_authority_required/,
  )
  const rewritten = structuredClone(result.receipt)
  for (const row of rewritten.ledger) {
    if (
      row.request.method !== 'eth_call' ||
      decodeFunctionData({ abi, data: row.request.params[0].data }).functionName !== 'previewRedeem'
    )
      continue
    const envelope = JSON.parse(Buffer.from(row.rawBodyBase64, 'base64').toString())
    envelope.result = encodeFunctionResult({ abi, functionName: 'previewRedeem', result: 9990001n })
    const bytes = Buffer.from(JSON.stringify(envelope))
    row.rawBodyBase64 = bytes.toString('base64')
    row.bodyBytes = bytes.length
    row.bodySha256 = sha(bytes)
  }
  rewritten.terminalCommitments = rewritten.ledger.map((row) => ({
    physicalId: row.physicalId,
    rowSha256: sha(JSON.stringify(row)),
  }))
  const fullyResealed = reseal(rewritten)
  const inspection = replay(fullyResealed, plan)
  assert.ok(inspection.points.every((point) => point.nativeEaRaw === '9990001'))
  assert.equal(inspection.authoritativeNativeCapture, false)
  assert.throws(
    () => authoritativeReplay(fullyResealed, plan),
    /original_capture_authority_required/,
  )
})
test('raw native unsupported getter errors survive and censor the reference quote without inventing zero', async () => {
  const { result } = await original(plan, ({ r }) =>
    r.method === 'eth_call' &&
    decodeFunctionData({ abi, data: r.params[0].data }).functionName === 'availableWithdrawLimit'
      ? {
          jsonrpc: '2.0',
          id: r.id,
          error: { code: -32000, message: 'execution reverted', data: '0x' },
        }
      : undefined,
  )
  assert.equal(result.structurallyAccepted, true)
  assert.ok(
    result.structuralReplay.points.every(
      (p) =>
        p.availableWithdrawLimitRaw === null &&
        p.nativeQuoteStatus === 'censored_native_withdrawal_limit_unavailable',
    ),
  )
  assert.ok(
    result.receipt.ledger.some((r) =>
      Buffer.from(r.rawBodyBase64, 'base64').toString().includes('execution reverted'),
    ),
  )
})
test('injected dependencies cannot delete themselves during a registered-origin capture to gain authority', async () => {
  const registered = await configured()
  let h
  h = harness(plan, ({ number }) => {
    if (number === 138) for (const key of Object.keys(h.options)) delete h.options[key]
  })
  const result = await capture(plan, registered, h.options)
  assert.equal(Object.keys(h.options).length, 0)
  assert.equal(result.structurallyAccepted, true)
  assert.equal(result.accepted, false)
  assert.equal(result.replay, null)
  assert.throws(
    () => authoritativeReplay(result.receipt, plan),
    /original_capture_authority_required/,
  )
})
test('JSON duplicate keys at every depth, escaped keys and malformed canonical ABI fail closed', async () => {
  for (const text of ['{"id":1,"id":2}', '{"x":{"a":1,"\\u0061":2}}', '[{"a":1,"a":2}]'])
    assert.throws(() => parse(text), /duplicate_json_key/)
  for (const text of ['{"x":1} trailing', '{"x":01}', '[1,]', '"unterminated'])
    assert.throws(() => parse(text))
  const { result } = await original(plan, ({ r }) =>
    r.method === 'eth_chainId' ? '{"jsonrpc":"2.0","id":1,"id":1,"result":"0x1"}' : undefined,
  )
  assert.equal(result.structurallyAccepted, false)
  for (const [name, word] of [
    ['decimals', '0x06'],
    ['isShutdown', '0x' + '0'.repeat(63) + '2'],
    ['asset', '0x' + 'f'.repeat(24) + plan.subject.asset.slice(2)],
  ]) {
    const { result: broken } = await original(plan, ({ r, envelope }) =>
      r.method === 'eth_call' &&
      decodeFunctionData({ abi, data: r.params[0].data }).functionName === name
        ? { ...envelope, result: word }
        : undefined,
    )
    assert.equal(broken.structurallyAccepted, false, name)
  }
})
test('wrong implementation, block hash, bytecode or per-origin native quote cannot be projected', async () => {
  for (const alter of [
    ({ r, envelope }) =>
      r.method === 'eth_getStorageAt' ? { ...envelope, result: '0x' + '0'.repeat(64) } : undefined,
    ({ r, envelope }) =>
      r.method === 'eth_getBlockByNumber'
        ? { ...envelope, result: { ...envelope.result, hash: '0x' + '1'.repeat(64) } }
        : undefined,
    ({ r, envelope, host }) =>
      r.method === 'eth_getCode' && host === origins[1].host
        ? { ...envelope, result: '0x6002' }
        : undefined,
    ({ r, envelope, host }) =>
      r.method === 'eth_call' &&
      host === origins[1].host &&
      decodeFunctionData({ abi, data: r.params[0].data }).functionName === 'previewRedeem'
        ? { ...envelope, result: '0x' + '0'.repeat(63) + '1' }
        : undefined,
  ])
    assert.equal((await original(plan, alter)).result.structurallyAccepted, false)
})
test('replayer distrusts resealed mutations, duplicate/missing anchor and terminal evidence; IDs join irrespective of array order', async () => {
  const { result } = await original()
  const reordered = structuredClone(result.receipt)
  reordered.ledger.reverse()
  reordered.terminalCommitments.reverse()
  assert.deepEqual(replay(reseal(reordered), plan).points, result.structuralReplay.points)
  for (const change of [
    (v) => {
      v.origins[0].anchors[1] = v.origins[0].anchors[0]
    },
    (v) => {
      v.origins[0].anchors.pop()
    },
    (v) => {
      v.plan.subject.sharesRaw = '2000000'
    },
    (v) => {
      v.plan.withdrawalLimitSubject = plan.subject.destination
    },
    (v) => {
      v.ledger[0].rawBodyBase64 = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"0x2"}').toString(
        'base64',
      )
    },
    (v) => {
      v.terminalCommitments[0] = v.terminalCommitments[1]
    },
    (v) => {
      v.ledger[0].accepted = false
    },
  ]) {
    const v = structuredClone(result.receipt)
    change(v)
    assert.throws(() => replay(reseal(v), plan))
  }
})
test('physical ledger precedes fetch and pacing uses ceiling with monotonic early-wakeup recheck', async () => {
  let at = 0.1,
    physical = 0,
    c
  const waits = []
  const options = {
    now: () => NOW + Math.floor(at),
    monotonic: () => at,
    pace: async (ms) => {
      waits.push(ms)
      at += waits.length === 1 ? ms - 0.5 : ms
    },
    setTimer: () => 1,
    clearTimer: () => {},
    fetcher: async (_, init) => {
      physical++
      if (physical === 1) {
        const state = await c.finish()
        assert.equal(state.physicalStarts, 1)
        assert.equal(state.ledger[0].status, 'pending')
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' }),
      )
    },
  }
  c = control(origins, options)
  c.beginStage('chain')
  const init = {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  }
  await assert.rejects(c.fetcher(origins[0].url, init))
  assert.equal(physical, 1)
  await assert.rejects(c.fetcher(origins[0].url, init), /closed/)
  // A separate live controller verifies ceil/recheck without finishing inside its fetch.
  physical = 0
  const d = control(origins, {
    ...options,
    fetcher: async (_, init) => {
      physical++
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' }),
      )
    },
  })
  d.beginStage('chain')
  await d.fetcher(origins[0].url, init)
  at += 0.3
  await d.fetcher(origins[0].url, init)
  const final = await d.finish()
  assert.ok(waits[0] === 250 && waits.length >= 2)
  assert.ok(final.ledger[1].startedElapsedMs - final.ledger[0].startedElapsedMs >= 250)
})
test('read timeout aborts and bounds finish drain, seals late settlement without changing receipt', async () => {
  const h = harness()
  let resolveFetch,
    aborted = false
  const c = control(origins, {
    ...h.options,
    fetcher: async (_, init) => {
      init.signal.addEventListener('abort', () => {
        aborted = true
      })
      return await new Promise((r) => {
        resolveFetch = r
      })
    },
  })
  c.beginStage('chain')
  const pending = c.fetcher(origins[0].url, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  })
  const caught = assert.rejects(pending, /read_timeout/)
  const timeout = [...h.timers.values()].find((t) => t.ms === 8000)
  assert.ok(timeout)
  h.advance(8000)
  timeout.fn()
  await caught
  const finishing = c.finish()
  const grace = [...h.timers.values()].find((t) => t.ms === 250)
  assert.ok(grace)
  h.advance(250)
  grace.fn()
  const final = await finishing,
    before = JSON.stringify(final)
  assert.equal(aborted, true)
  assert.equal(final.physicalStarts, 1)
  assert.ok(final.pendingSettlements > 0)
  resolveFetch(new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}'))
  // Await the public settlement asynchronously, without real timers or network.
  for (let n = 0; n < 20 && c.settlementReceipts.length === 0; n++) await Promise.resolve()
  assert.equal(c.settlementReceipts.length, 1)
  assert.equal(c.settlementReceipts[0].physicalId, 1)
  assert.equal(c.settlementReceipts[0].observation.accepted, false)
  assert.equal(JSON.stringify(final), before)
  await assert.rejects(c.fetcher(origins[0].url, { body: '{}' }), /closed/)
})
test('stream bytes, reserve and scheduled pacing cancellation are actual controls', async () => {
  const h = harness(),
    c = control(origins, { ...h.options, fetcher: async () => new Response(new Uint8Array(65537)) })
  c.beginStage('chain')
  await assert.rejects(
    c.fetcher(origins[0].url, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }),
  )
  assert.equal((await c.finish()).ledger[0].bodyBytes, 65537)
  await assert.rejects(capture(plan, origins, { ...h.options, freeBytes: () => 0 }), /reserve/)
  const p = harness()
  let releasePace
  const d = control(origins, {
    ...p.options,
    pace: async () =>
      await new Promise((r) => {
        releasePace = r
      }),
  })
  d.beginStage('chain')
  const init = {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  }
  await d.fetcher(origins[0].url, init)
  const scheduled = d.fetcher(origins[0].url, init),
    rejected = assert.rejects(scheduled)
  const finish = d.finish(),
    grace = [...p.timers.values()].find((t) => t.ms === 250)
  assert.ok(grace)
  grace.fn()
  const sealed = await finish
  assert.equal(sealed.physicalStarts, 1)
  p.advance(251)
  releasePace()
  await rejected
  assert.equal(p.physical.length, 1)
})


test('shared controller opts named headers into 256 KiB while legacy headers and nonheaders remain 64 KiB', async () => {
  const header = { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['finalized', false] }
  const role = { key: 'fresh_finalized', method: header.method, role: 'native_header' }
  for (const [opted, request, bytes, succeeds] of [
    [true, header, 262144, true], [true, header, 262145, false],
    [false, header, 65537, false],
    [true, { ...header, method: 'eth_chainId', params: [] }, 65537, false],
  ]) {
    const h = harness(), text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })
    const c = control(origins, { ...h.options,
      ...(opted ? { headerResponsePolicy: MORPHO_NATIVE_HEADER_RESPONSE_POLICY } : {}),
      fetcher: async () => new Response(text + ' '.repeat(bytes - Buffer.byteLength(text))) })
    c.beginStage('policy')
    const options = { body: JSON.stringify(request),
      ...(opted && request.method === header.method ? { nativeHeaderRole: role } : {}) }
    try {
      if (succeeds) { const response = await c.fetcher(origins[0].url, options); assert.equal(Buffer.byteLength(await response.text()), bytes) }
      else await assert.rejects(c.fetcher(origins[0].url, options))
    } finally { const receipt = await c.finish(); assert.equal(receipt.pendingSettlements, 0) }
  }
})
