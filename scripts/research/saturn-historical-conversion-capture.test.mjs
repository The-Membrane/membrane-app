import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  ABI,
  CONTRACTS as C,
  HOSTS,
  POLICY,
  prepareSaturnConversionPlan,
  validatePlan,
  captureSaturnConversionHistory,
  replaySaturnConversionHistory,
  normalizedSaturnEvidence,
} from './saturn-historical-conversion-capture.mjs'
const seal = (r) => {
  const { sha256, ...body } = r
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}
const header = (s) => ({
  number: '0x' + BigInt(s.blockNumber).toString(16),
  hash: s.blockHash,
  timestamp: '0x' + BigInt(Date.parse(s.blockTime) / 1000).toString(16),
})
const plan = await prepareSaturnConversionPlan(),
  owner = plan.anchors[0].ticket.owner
function stub({
  failClaim = false,
  wrongUnits = false,
  disagree = false,
  bodyOversize = false,
  redirect = false,
  chainFailure = false,
} = {}) {
  const requests = [],
    current = {
      chainId: 1,
      blockNumber: '26150000',
      blockHash: '0x' + 'cd'.repeat(32),
      blockTime: new Date(Math.floor((Date.now() - 1200000) / 1000) * 1000).toISOString(),
    }
  const sources = [...plan.anchors.filter((a) => a.source).map((a) => a.source), current]
  const fetcher = async (url, options) => {
    const p = JSON.parse(options.body)
    requests.push(p)
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal)
    let result, error
    if (p.method === 'eth_chainId') {
      if (chainFailure) error = { code: -32000, message: 'https://private.example/KEY' }
      else result = '0x1'
    } else if (p.method === 'eth_getBlockByNumber') {
      const s =
        p.params[0] === 'finalized'
          ? current
          : sources.find((s) => '0x' + BigInt(s.blockNumber).toString(16) === p.params[0])
      assert.ok(s)
      result = { ...header(s), extraDiagnostic: 'https://private.example/KEY' }
    } else if (p.method === 'eth_getCode') result = '0x60006000'
    else {
      assert.equal(p.params[1].requireCanonical, true)
      assert.ok(sources.some((s) => s.blockHash === p.params[1].blockHash))
      const { functionName: name, args } = decodeFunctionData({ abi: ABI, data: p.params[0].data })
      let value
      if (name === 'coins') value = args[0] === 0n ? C.usdc : C.usdat
      else if (name === 'balances') value = 1000000000000n
      else if (name === 'token0') value = C.ausd
      else if (name === 'token1') value = C.usdc
      else if (name === 'fee') value = 100
      else if (name === 'getPool') value = C.pool
      else if (name === 'liquidity') value = 12345n
      else if (name === 'asset' || name === 'USDAT') value = C.usdat
      else if (name === 'STAKED_USDAT') value = C.vault
      else if (name === 'decimals')
        value = p.params[0].to === C.vault ? 18 : wrongUnits && p.params[0].to === C.usdat ? 18 : 6
      else if (name === 'getWithdrawalQueue') value = C.queue
      else if (name === 'ownerOf') value = owner
      else if (name === 'requests')
        value = [40455201070454723366n, 42103198n, 1790950000n, 1039000n, 3]
      else if (name === 'paused') value = false
      else if (name === 'get_dy') value = args[2] - 100n
      else if (name === 'quoteExactInputSingle')
        value = [
          args[0].amountIn - (disagree && url.includes('ankr') ? 200n : 100n),
          1n,
          2,
          100000n,
        ]
      else if (name === 'claim') {
        assert.equal(p.params[0].from, owner)
        if (failClaim) error = { code: 3, data: '0xdead', message: 'https://private.example/KEY' }
        else value = 42103198n
      } else assert.fail(name)
      if (!error) result = encodeFunctionResult({ abi: ABI, functionName: name, result: value })
    }
    const body = bodyOversize
      ? 'x'.repeat(POLICY.maxResponseBytes + 1)
      : JSON.stringify({ jsonrpc: '2.0', id: p.id, ...(error ? { error } : { result }) })
    const response = new Response(body, { status: 200 })
    if (redirect) Object.defineProperty(response, 'redirected', { value: true })
    return response
  }
  return { fetcher, requests, current }
}
const origins = HOSTS.map((host) => ({ host, url: 'https://' + host + '/not-a-real-key' }))
let receipt, replay
await test('offline plan pins two actual historical headers plus current, exact ticket and two separate sizes', () => {
  assert.equal(plan.usdatInputRaw, '42103198')
  assert.equal(plan.anchors[0].source.blockNumber, '26105350')
  assert.equal(plan.anchors[1].source.blockNumber, '26107302')
  assert.equal(plan.anchors[2].currentFinalized, true)
  assert.equal(validatePlan(plan).expectedStarts, 204)
  assert.equal(POLICY.maxRequests, 224)
  assert.equal(POLICY.deadlineMs, 90000)
})
await test('two-origin raw capture/replay retains genuine source clocks, whole-ticket input and protocol size independently', async () => {
  const s = stub()
  receipt = await captureSaturnConversionHistory(plan, origins, { fetcher: s.fetcher })
  replay = replaySaturnConversionHistory(receipt, plan)
  assert.equal(receipt.physicalStarts, 202)
  assert.equal(s.requests.length, 202)
  assert.equal(replay.points.length, 3)
  assert.ok(replay.points.every((p) => p.status === 'conditional_quote' && p.identityVerified))
  assert.equal(replay.points[0].ausdQuotedRaw, '42102998')
  assert.equal(replay.points[0].protocolQuote.ausdQuotedRaw, '9999999800')
  assert.equal(replay.points[0].ticket.usdatOwedRaw6, '42103198')
  assert.equal(replay.points[0].ticket.amountBasis, 'claim_simulated_net_amount')
  assert.equal(replay.points[0].ticket.status, 3)
  assert.equal(replay.points[0].ticket.vaultPaused, false)
  assert.equal(replay.points[0].ticket.queuePaused, false)
  assert.equal(replay.elapsedSeconds[0], 23544)
  assert.equal(replay.execution, 'unassessed')
  assert.equal(replay.sourceImplementationEquivalence, false)
  assert.equal(JSON.stringify(receipt).includes('private.example'), false)
  assert.equal(JSON.stringify(receipt).includes('not-a-real-key'), false)
  const normalized = normalizedSaturnEvidence(receipt, plan)
  assert.equal(normalized.history.points.length, 2)
  assert.equal(normalized.current.input.usdatInputRaw, '42103198')
  assert.equal(normalized.current.point.source.blockNumber, s.current.blockNumber)
})
await test('agreement detects foreign native units and unequal second-leg results while retaining source gaps', () => {
  for (const type of ['decimals', 'quote']) {
    const r = structuredClone(receipt),
      t = r.traces.find(
        (t) =>
          t.origin === HOSTS[1] &&
          t.anchor === 0 &&
          t.key === (type === 'decimals' ? 'usdatDecimals' : 'ausdQuotedRaw'),
      )
    t.response.result = encodeFunctionResult({
      abi: ABI,
      functionName: type === 'decimals' ? 'decimals' : 'quoteExactInputSingle',
      result: type === 'decimals' ? 18 : [40000000n, 1n, 2, 100000n],
    })
    const p = replaySaturnConversionHistory(seal(r), plan).points[0]
    assert.equal(p.status, 'incomplete')
    assert.equal(p.ausdQuotedRaw, null)
  }
})
await test('reverted claim never discards public exact-size quote or recorded owed, and strips diagnostics', () => {
  const r = structuredClone(receipt)
  for (const t of r.traces.filter((t) => t.key === 'ticketClaim'))
    t.response = { error: { code: 3, data: '0xdead' } }
  const p = replaySaturnConversionHistory(seal(r), plan).points[0]
  assert.equal(p.status, 'conditional_quote')
  assert.equal(p.ticket.claimSimulation, 'evm_revert')
  assert.equal(p.ticket.claimReturnUsdatRaw, null)
  assert.equal(p.ticket.amountBasis, 'recorded_owed_amount_if_delivered')
  assert.equal(p.ticket.usdatOwedRaw6, '42103198')
})
await test('burned current owner/state remain missing without blocking protocol quote', () => {
  const r = structuredClone(receipt)
  for (const t of r.traces.filter(
    (t) => t.anchor === 2 && ['ticketOwner', 'ticketRequest', 'ticketClaim'].includes(t.key),
  ))
    t.response = { error: { code: 3, data: '0x' } }
  const p = replaySaturnConversionHistory(seal(r), plan).points[2]
  assert.equal(p.status, 'conditional_quote')
  assert.equal(p.ticket.owner, null)
  assert.equal(p.ticket.usdatOwedRaw6, null)
  assert.equal(p.protocolQuote.status, 'conditional_quote')
})
await test('replay rejects altered Q/calldata/source, header enclosure, declared budget, clocks and policy alias', () => {
  const bad = []
  let r = structuredClone(receipt)
  r.traces.find((t) => t.key === 'usdcQuotedRaw').request.params[0].data = '0x1234'
  bad.push(r)
  r = structuredClone(receipt)
  r.traces.find((t) => t.key === 'header_after').request.params[0] = 'latest'
  bad.push(r)
  r = structuredClone(receipt)
  r.traces.find((t) => t.key === 'header_before').completedAt = r.traces.find(
    (t) => t.key === 'code_curve',
  ).completedAt
  bad.push(r)
  r = structuredClone(receipt)
  r.physicalStarts = 225
  bad.push(r)
  r = structuredClone(receipt)
  r.traces[0].completedAt = new Date(Date.parse(r.traces[0].startedAt) + 8251).toISOString()
  bad.push(r)
  r = structuredClone(receipt)
  r.capturedAt = new Date(Date.parse(r.startedAt) + 90251).toISOString()
  bad.push(r)
  r = structuredClone(receipt)
  r.origins[1] = r.origins[0]
  bad.push(r)
  r = structuredClone(receipt)
  r.sources[2].blockHash = '0x' + 'ee'.repeat(32)
  bad.push(r)
  r = structuredClone(receipt)
  r.traces[0].transport = 'timeout'
  bad.push(r)
  for (const value of bad) assert.throws(() => replaySaturnConversionHistory(seal(value), plan))
  assert.throws(() =>
    replaySaturnConversionHistory(receipt, { ...plan, usdatInputRaw: '42103199' }),
  )
  assert.equal(HOSTS[1], 'rpc.ankr.com')
})
await test('partial first-leg outage is a gap rather than interpolated/scaled final payout', () => {
  const r = structuredClone(receipt)
  for (const t of r.traces.filter(
    (t) => t.anchor === 1 && ['usdcQuotedRaw', 'ausdQuotedRaw'].includes(t.key),
  ))
    t.response = { error: { code: -32000 } }
  r.traces = r.traces.filter((t) => !(t.anchor === 1 && t.key === 'ausdQuotedRaw'))
  r.traces.forEach((t, i) => (t.request.id = i + 1))
  r.physicalStarts = r.traces.length
  const p = replaySaturnConversionHistory(seal(r), plan).points[1]
  assert.equal(p.status, 'incomplete')
  assert.equal(p.ausdQuotedRaw, null)
  assert.ok(p.missingLegs.includes('usdcQuotedRaw'))
})
await test('queue and vault units bind ticket evidence independently of public conversion quote', () => {
  const r = structuredClone(receipt)
  for (const t of r.traces.filter((t) => t.anchor === 0 && t.key === 'vaultDecimals'))
    t.response.result = encodeFunctionResult({ abi: ABI, functionName: 'decimals', result: 6 })
  const p = replaySaturnConversionHistory(seal(r), plan).points[0]
  assert.equal(p.status, 'conditional_quote')
  assert.equal(p.ticket.identityVerified, false)
  assert.equal(p.ticket.owner, null)
  assert.equal(p.ticket.reportedOwner, owner)
})
await test('capture rejects redirects and oversize streams without preserving secrets', async () => {
  for (const options of [{ redirect: true }, { bodyOversize: true }]) {
    // One anchor and no ticket reduces this transport regression's starts, without changing the frozen capture bounds.
    const small = { ...plan, anchors: [{ ...plan.anchors[0], ticket: undefined }] },
      s = stub(options),
      r = await captureSaturnConversionHistory(small, origins, { fetcher: s.fetcher }),
      p = replaySaturnConversionHistory(r, small).points[0]
    assert.equal(p.status, 'incomplete')
    assert.equal(p.ausdQuotedRaw, null)
    assert.equal(
      r.traces.every((t) => t.response === null),
      true,
    )
  }
})

await test('abort-ignoring work closes capture after bounded settlement grace with no additional starts', async () => {
  let starts = 0
  const active = new Map(),
    fetcher = async (url) => {
      starts++
      const h = new URL(url).hostname
      active.set(h, (active.get(h) ?? 0) + 1)
      return new Promise(() => {})
    }
  const r = await captureSaturnConversionHistory(plan, origins, { fetcher, rpcTimeoutMs: 10 })
  assert.equal(starts, 2)
  assert.equal(r.physicalStarts, 2)
  assert.equal(r.captureClosedReason, 'rpc_abort_unsettled')
  assert.ok([...active.values()].every((n) => n === 1))
  assert.ok(r.traces.every((t) => !t.workSettled && t.transport === 'timeout'))
  assert.equal(replaySaturnConversionHistory(r, plan).completeQuoteCount, 0)
  for (const rpcTimeoutMs of [0, 8001, 1.5, '1'])
    await assert.rejects(captureSaturnConversionHistory(plan, origins, { fetcher, rpcTimeoutMs }))
  assert.equal(starts, 2)
})
await test('optional ticket/claim disagreement retains matching public conversion and recorded owned facts separately', () => {
  let r = structuredClone(receipt)
  r.traces.find(
    (t) => t.anchor === 2 && t.origin === HOSTS[1] && t.key === 'ticketClaim',
  ).response = { error: { code: 3, data: '0x' } }
  let p = replaySaturnConversionHistory(seal(r), plan).points[2]
  assert.equal(p.status, 'conditional_quote')
  assert.deepEqual(p.missingLegs, [])
  assert.equal(p.ticket.owner, owner)
  assert.equal(p.ticket.usdatOwedRaw6, '42103198')
  assert.equal(p.ticket.claimSimulation, 'unassessed')
  assert.equal(p.ticket.claimReturnUsdatRaw, null)
  assert.ok(p.missingFacts.includes('two_origin_claim_simulation'))
  r = structuredClone(receipt)
  r.traces.find(
    (t) => t.anchor === 2 && t.origin === HOSTS[1] && t.key === 'ticketOwner',
  ).response = { error: { code: 3, data: '0x' } }
  p = replaySaturnConversionHistory(seal(r), plan).points[2]
  assert.equal(p.status, 'conditional_quote')
  assert.deepEqual(p.missingLegs, [])
  assert.equal(p.ticket, null)
  assert.equal(p.protocolQuote.status, 'conditional_quote')
  assert.equal(p.originTicketFacts.length, 2)
  r = structuredClone(receipt)
  r.traces.find(
    (t) => t.anchor === 2 && t.origin === HOSTS[1] && t.key === 'code_queue',
  ).response.result = '0x60016001'
  p = replaySaturnConversionHistory(seal(r), plan).points[2]
  assert.equal(p.status, 'conditional_quote')
  assert.equal(p.runtimeCodeHashes.queue, null)
  assert.ok(p.missingFacts.includes('two_origin_code_queue'))
  r = structuredClone(receipt)
  for (const t of r.traces.filter((t) => t.anchor === 2 && t.key === 'protocolUsdcQuotedRaw'))
    t.response = { error: { code: 3, data: '0x' } }
  r.traces = r.traces.filter((t) => !(t.anchor === 2 && t.key === 'protocolAusdQuotedRaw'))
  r.traces.forEach((t, i) => (t.request.id = i + 1))
  r.physicalStarts = r.traces.length
  p = replaySaturnConversionHistory(seal(r), plan).points[2]
  assert.equal(p.status, 'conditional_quote')
  assert.deepEqual(p.missingLegs, [])
  assert.equal(p.protocolQuote.status, 'incomplete')
  assert.ok(p.missingFacts.includes('protocolUsdcQuotedRaw'))
})
await test('contradictory equal-height finalized heads invalidate every source and nested quote/ticket channel', () => {
  const r = structuredClone(receipt),
    t = r.traces.find((t) => t.origin === HOSTS[1] && t.key === 'finalized')
  t.response.result.hash = '0x' + 'ab'.repeat(32)
  r.sources[2] = null
  const replay = replaySaturnConversionHistory(seal(r), plan)
  assert.equal(replay.completeQuoteCount, 0)
  for (const p of replay.points.filter((p) => p.protocolQuote)) {
    assert.equal(p.status, 'incomplete')
    assert.equal(p.protocolQuote.status, 'incomplete')
    assert.equal(p.protocolQuote.ausdQuotedRaw, null)
    assert.equal(p.ticket, null)
  }
})
await test('primitive JSON-RPC quantities reject regex-coercible arrays in scalar and header fields', () => {
  for (const key of ['chain', 'header_before', 'usdcQuotedRaw']) {
    const r = structuredClone(receipt),
      t = r.traces.find((t) => t.key === key)
    if (key === 'header_before') t.response.result.number = [t.response.result.number]
    else t.response.result = [t.response.result]
    assert.throws(() => replaySaturnConversionHistory(seal(r), plan))
  }
})
await test('actual normalized raw replay feeds pure projection with failed claim, while burned current retains only public quotes', async () => {
  const mod = await import('../../lib/carry/saturnHistoricalConversionProjection.ts'),
    build =
      mod.buildSaturnHistoricalConversionProjection ??
      mod.default?.buildSaturnHistoricalConversionProjection
  let r = structuredClone(receipt)
  for (const t of r.traces.filter((t) => t.key === 'ticketClaim'))
    t.response = { error: { code: 3, data: '0xdead' } }
  r = seal(r)
  const normalized = normalizedSaturnEvidence(r, plan),
    input = {
      mode: 'current_conditional',
      routeKey: 'AUSD → Staked USDat [USDat]',
      destination: C.vault,
      owner,
      ticketId: '1670',
      sharesRaw18: '40455201070454723366',
      requestedAusdRaw: '40000000',
      payoutAsset: C.ausd,
      payoutDecimals: 6,
      horizonHours: 24,
      current: normalized.current,
      history: normalized.history,
      asOfMs: Date.parse(r.capturedAt),
    }
  const accept = (kind, sha, e) =>
    sha === r.sha256 && JSON.stringify(e) === JSON.stringify(normalized[kind])
  const p = build(input, accept)
  assert.ok(p)
  assert.equal(p.status, 'conditional_saturn_historical_conversion_projection')
  assert.equal(normalized.history.points.length, 2)
  assert.equal(normalized.history.completeQuoteCount, 2)
  assert.equal(replaySaturnConversionHistory(r, plan).completeQuoteCount, 3)
  assert.deepEqual(normalized.current.point.missingLegs, [])
  assert.ok(normalized.current.point.missingFacts.includes('ticketClaim'))
  for (const t of r.traces.filter(
    (t) => t.anchor === 2 && ['ticketOwner', 'ticketRequest', 'ticketClaim'].includes(t.key),
  ))
    t.response = { error: { code: 3, data: '0x' } }
  r = seal(r)
  const burned = normalizedSaturnEvidence(r, plan)
  assert.equal(burned.current.point.status, 'conditional_quote')
  assert.deepEqual(burned.current.point.missingLegs, [])
  assert.equal(burned.current.point.protocolQuote.status, 'conditional_quote')
  assert.equal(
    build(
      { ...input, current: burned.current, history: burned.history },
      (kind, sha, e) => sha === r.sha256 && JSON.stringify(e) === JSON.stringify(burned[kind]),
    ),
    null,
  )
})
