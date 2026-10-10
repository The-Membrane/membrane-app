import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  locateCapacityHistoryCandidates,
  captureCapacityHistoryPair,
  replayCapacityHistoryPair,
} from '../../scripts/research/carry-holder-capacity-history.mjs'
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const origins = [
  { host: 'eth-mainnet.g.alchemy.com', url: 'https://eth-mainnet.g.alchemy.com/test' },
  { host: 'rpc.ankr.com', url: 'https://rpc.ankr.com/test' },
]
const now = Date.parse('2026-10-08T12:00:00.000Z'),
  candidates = locateCapacityHistoryCandidates()
const candidate = candidates.find((c) => c.id === '0:1:1')
const seal = (r) => {
  delete r.sha256
  r.sha256 = createHash('sha256').update(JSON.stringify(r)).digest('hex')
  return r
}
function mock(c = candidate, change = () => {}) {
  return async (url, init) => {
    const req = JSON.parse(init.body)
    let result
    const endpoint = ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(req.method)
      ? ['baseline', 'target'].find((n) => req.params.at(-1).blockHash === c[n].source.blockHash)
      : ['baseline', 'target'].find(
          (n) => req.params[0] === `0x${c[n].source.blockNumber.toString(16)}`,
        )
    if (req.method === 'eth_chainId') result = '0x1'
    else if (req.method === 'eth_getCode')
      result =
        req.params[0] === c.owner ? '0x' : req.params[0] === c.destination ? '0x6000' : '0x6001'
    else if (req.method === 'eth_getStorageAt') result = '0x' + '0'.repeat(24) + 'a'.repeat(40)
    else if (req.params[0] === 'finalized')
      result = {
        number: '0x19bfcc0',
        hash: `0x${'f'.repeat(64)}`,
        timestamp: `0x${Math.floor(now / 1000 - 60).toString(16)}`,
      }
    else if (req.method === 'eth_getBlockByNumber') {
      const s = c[endpoint].source
      result = {
        number: `0x${s.blockNumber.toString(16)}`,
        hash: s.blockHash,
        timestamp: `0x${Math.floor(Date.parse(s.blockTime) / 1000).toString(16)}`,
      }
    } else {
      const d = decodeFunctionData({ abi: ABI, data: req.params[0].data }),
        p = c[endpoint].summary
      let value
      if (d.functionName === 'asset') value = c.asset
      if (d.functionName === 'decimals') value = c.assetDecimals
      if (d.functionName === 'balanceOf') value = BigInt(p.sharesRaw)
      if (d.functionName === 'previewRedeem') {
        assert.equal(d.args[0].toString(), p.sharesRaw)
        value = BigInt(p.claimAssetsRaw)
      }
      if (d.functionName === 'maxWithdraw') value = BigInt(p.maxWithdrawRaw)
      if (d.functionName === 'withdraw') {
        assert.deepEqual(
          d.args.map((v, i) => (i === 0 ? String(v) : String(v).toLowerCase())),
          [p.claimAssetsRaw, c.owner, c.owner],
        )
        value = BigInt(p.sharesRaw)
      }
      result = encodeFunctionResult({ abi: ABI, functionName: d.functionName, result: value })
    }
    const response = { jsonrpc: '2.0', id: req.id, result }
    change(response, req, url, endpoint)
    return { ok: true, text: async () => JSON.stringify(response) }
  }
}
let baselineCapture
async function capture(c = candidate, options = {}) {
  if (c === candidate && Object.keys(options).length === 0) {
    baselineCapture ??= captureCapacityHistoryPair(c, origins, { now: () => now, fetcher: mock(c) })
    return structuredClone(await baselineCapture)
  }
  return captureCapacityHistoryPair(c, origins, { now: () => now, fetcher: mock(c), ...options })
}
test('old verified summaries locate136 cases/42 stable positions, all42 flat M/E; none are raw getter proofs', () => {
  assert.equal(candidates.length, 136)
  const pairs = candidates.filter((c) => c.locatorStatus === 'same_shares_candidate')
  assert.equal(pairs.length, 42)
  assert.deepEqual(
    [0, 1, 2].map((i) => pairs.filter((c) => c.routeIndex === i).length),
    [17, 15, 10],
  )
  assert.ok(
    pairs.every(
      (c) =>
        c.summaryOnly &&
        c.oldRequestedQProof === 'not_revalidated' &&
        c.oldSummaryNormalizedChange.numeratorRaw === '0',
    ),
  )
  assert.ok(candidates.some((c) => c.locatorStatus === 'missing_score'))
})
test('48 physical starts revalidate exact old sources/units/getters; genuine receipt cutoff remains now', async () => {
  const receipt = await capture(),
    r = replayCapacityHistoryPair(receipt, candidates)
  assert.equal(receipt.budget.physicalRequestStarts, 48)
  assert.equal(receipt.traces.length, 48)
  assert.equal(r.status, 'verified_historical_holder_getter_pair')
  assert.equal(r.baseline.source.blockTime, candidate.baseline.source.blockTime)
  assert.equal(r.target.source.blockTime, candidate.target.source.blockTime)
  assert.equal(r.capturedAt, new Date(now).toISOString())
  assert.equal(r.knowledgeCutoff, r.capturedAt)
  assert.equal(r.baseline.entitlementMethod, 'preview_redeem_full_position')
  assert.equal(r.baseline.quotedLimitMethod, 'max_withdraw_owner')
  assert.equal(r.normalizedChange.numeratorRaw, '0')
  assert.equal(r.successfulRequestedRawLowerBound, null)
  assert.equal(r.holderExecutableExit, false)
  assert.equal(r.implementationSourceAttested, false)
  assert.equal(r.actualElapsedSeconds, 4728)
  assert.ok(
    receipt.traces
      .filter((t) => t.request.method === 'eth_call')
      .every(
        (t) =>
          t.request.params[1].requireCanonical === true &&
          t.request.params[0].from === candidate.owner,
      ),
  )
})
test('USDC/USDT/GHO native identity and exact raw units independently replay', async () => {
  for (let i = 0; i < 3; i++) {
    const c = candidates.find(
        (c) => c.routeIndex === i && c.locatorStatus === 'same_shares_candidate',
      ),
      r = replayCapacityHistoryPair(await capture(c), candidates)
    assert.equal(r.status, 'verified_historical_holder_getter_pair')
    assert.equal(r.assetDecimals, [6, 6, 18][i])
    assert.equal(r.owner, c.owner)
  }
})
test('optional full-entitlement simulation uses56 starts and separate exact raw two-origin source-call evidence', async () => {
  const receipt = await capture(candidate, { simulateFullEntitlement: true }),
    r = replayCapacityHistoryPair(receipt, candidates)
  assert.equal(receipt.budget.physicalRequestStarts, 56)
  assert.equal(r.fullEntitlementSourceSimulationsVerified, true)
  assert.equal(r.baseline.fullEntitlementSimulation.requestedRaw, r.baseline.entitlementRaw)
  assert.equal(r.target.fullEntitlementSimulation.sharesBurnedRaw, r.sharesRaw)
  assert.equal(r.successfulRequestedRawLowerBound, null)
  assert.equal(r.holderExecutableExit, false)
})
for (const [name, mutate] of Object.entries({
  hash: (r) =>
    (r.traces.find((t) => t.phase === 'baseline:header_before').response.result.hash =
      `0x${'a'.repeat(64)}`),
  retimedHeader: (r) =>
    (r.traces.find((t) => t.phase === 'target:header_after').response.result.timestamp = '0x123'),
  chain: (r) => (r.traces.find((t) => t.phase === 'chain').response.result = '0x2'),
  ceiling: (r) => (r.traces.find((t) => t.phase === 'finalized').response.result.number = '0x1'),
  owner: (r) =>
    (r.traces.find((t) => t.phase === 'baseline:balance').request.params[0].from =
      `0x${'a'.repeat(40)}`),
  noncanonicalBlock: (r) =>
    delete r.traces.find((t) => t.phase === 'target:max').request.params[1].requireCanonical,
  wrongPreviewShares: (r) => {
    const t = r.traces.find((t) => t.phase === 'target:entitlement')
    t.request.params[0].data = t.request.params[0].data.slice(0, -64) + '0'.repeat(63) + '1'
  },
  mixedUnits: (r) =>
    (r.traces.find((t) => t.phase === 'baseline:asset_decimals').response.result =
      encodeFunctionResult({ abi: ABI, functionName: 'decimals', result: 18 })),
  responseId: (r) => (r.traces[0].response.id = 100),
  duplicate: (r) => {
    r.traces.push(structuredClone(r.traces[0]))
    r.budget.physicalRequestStarts++
  },
  futureTrace: (r) => (r.traces[0].startedAt = new Date(now + 1000).toISOString()),
  lateStart: (r) => (r.traces[0].startedAt = new Date(now + 60000).toISOString()),
  fakeSummary: (r) => (r.candidate.baseline.summary.claimAssetsRaw = '2'),
  unknownLocator: (r) => (r.candidate.id = '0:999:1'),
  unknownPhase: (r) => (r.traces[0].phase = 'other'),
  invalidResult: (r) => (r.traces.find((t) => t.phase === 'target:balance').response.result = {}),
  trailingResult: (r) =>
    (r.traces.find((t) => t.phase === 'target:balance').response.result += '00'),
}))
  test(`${name} is censored after raw replay even with a recomputed receipt seal`, async () => {
    const r = await capture()
    mutate(r)
    seal(r)
    assert.equal(
      replayCapacityHistoryPair(r, candidates).status,
      'censored_historical_holder_getter_pair',
    )
  })
test('first capture failure is preserved without fabricated getter/preview evidence', async () => {
  const r = await capture(candidate, {
    fetcher: mock(candidate, (res, req) => {
      if (
        req.method === 'eth_call' &&
        decodeFunctionData({ abi: ABI, data: req.params[0].data }).functionName === 'balanceOf'
      ) {
        delete res.result
        res.error = { code: -32000, data: '0x' }
      }
    }),
  })
  assert.ok(r.traces.some((t) => t.response?.error))
  assert.equal(r.traces.filter((t) => t.phase.endsWith('entitlement')).length, 0)
  assert.equal(
    replayCapacityHistoryPair(r, candidates).status,
    'censored_historical_holder_getter_pair',
  )
})
test('both max getter reverts preserve E/headers but censor normalized getter movement', async () => {
  const receipt = await capture(candidate, {
    fetcher: mock(candidate, (res, req) => {
      if (
        req.method === 'eth_call' &&
        decodeFunctionData({ abi: ABI, data: req.params[0].data }).functionName === 'maxWithdraw'
      ) {
        delete res.result
        res.error = { code: 3, data: '0x' }
      }
    }),
  })
  const r = replayCapacityHistoryPair(receipt, candidates)
  assert.equal(r.reason, 'max_getter_unavailable')
  assert.equal(r.baseline.entitlementRaw, candidate.baseline.summary.claimAssetsRaw)
  assert.equal(r.normalizedChange, null)
})
test('full simulation disagreement leaves independently agreed E/M history intact', async () => {
  const receipt = await capture(candidate, {
    simulateFullEntitlement: true,
    fetcher: mock(candidate, (res, req, url) => {
      if (
        url.includes('ankr') &&
        req.method === 'eth_call' &&
        decodeFunctionData({ abi: ABI, data: req.params[0].data }).functionName === 'withdraw'
      ) {
        delete res.result
        res.error = { code: 3, data: '0x' }
      }
    }),
  })
  const r = replayCapacityHistoryPair(receipt, candidates)
  assert.equal(r.status, 'verified_historical_holder_getter_pair')
  assert.equal(r.fullEntitlementSourceSimulationsVerified, false)
  assert.equal(r.target.fullEntitlementSimulation.status, 'origin_disagreement')
})
test('independent getter contradiction is retained instead of silently rewriting old summaries', async () => {
  const receipt = await capture(candidate, {
    fetcher: mock(candidate, (res, req) => {
      if (
        req.method === 'eth_call' &&
        decodeFunctionData({ abi: ABI, data: req.params[0].data }).functionName === 'maxWithdraw'
      )
        res.result = encodeFunctionResult({ abi: ABI, functionName: 'maxWithdraw', result: 1n })
    }),
  })
  const r = replayCapacityHistoryPair(receipt, candidates)
  assert.equal(r.status, 'verified_historical_holder_getter_pair')
  assert.ok(r.summaryComparison.every((s) => s.maxWithdrawMatch === false))
  assert.equal(r.target.quotedMaxWithdrawRaw, '1')
})
test('invalid budgets/origins/attrition cannot launch requests', async () => {
  let starts = 0
  const fetcher = async () => {
    starts++
    throw Error('never')
  }
  for (const options of [{ maxRequests: 65 }, { deadlineMs: 90000 }])
    await assert.rejects(
      captureCapacityHistoryPair(candidate, origins, { ...options, fetcher }),
      /budget_invalid/,
    )
  await assert.rejects(
    captureCapacityHistoryPair(candidate, [origins[0], origins[0]], { fetcher }),
    /origins_invalid/,
  )
  await assert.rejects(
    captureCapacityHistoryPair(
      candidates.find((c) => c.locatorStatus === 'missing_score'),
      origins,
      { fetcher },
    ),
    /candidate_not_complete/,
  )
  assert.equal(starts, 0)
})

test('a self-labeled healthy origin cannot send requests to a foreign endpoint', async () => {
  let starts = 0
  await assert.rejects(
    captureCapacityHistoryPair(
      candidate,
      [{ host: origins[0].host, url: 'https://foreign.example' }, origins[1]],
      {
        fetcher: async () => {
          starts++
        },
      },
    ),
    /origins_invalid/,
  )
  assert.equal(starts, 0)
})
test('capture clones locator input and no new physical starts occur after the global deadline', async () => {
  let clock = now,
    starts = 0
  const receipt = await captureCapacityHistoryPair(candidate, origins, {
    now: () => clock,
    deadlineMs: 1000,
    fetcher: async () => {
      starts++
      clock = now + 1001
      throw Error('offline')
    },
  })
  assert.equal(starts, 1)
  assert.equal(receipt.budget.physicalRequestStarts, 1)
  assert.equal(
    replayCapacityHistoryPair(receipt, candidates).status,
    'censored_historical_holder_getter_pair',
  )
  receipt.candidate.owner = 'changed'
  assert.notEqual(candidate.owner, 'changed')
})

test('rational getter change stays signed and exact; all E/M raw values remain exported', async () => {
  const receipt = await capture(candidate, {
    fetcher: mock(candidate, (res, req, _url, endpoint) => {
      if (
        req.method === 'eth_call' &&
        decodeFunctionData({ abi: ABI, data: req.params[0].data }).functionName === 'maxWithdraw' &&
        endpoint === 'target'
      )
        res.result = encodeFunctionResult({ abi: ABI, functionName: 'maxWithdraw', result: 1n })
    }),
  })
  const r = replayCapacityHistoryPair(receipt, candidates)
  assert.equal(r.status, 'verified_historical_holder_getter_pair')
  assert.ok(r.normalizedChange.numeratorRaw.startsWith('-'))
  assert.equal(
    r.normalizedChange.denominatorRaw,
    (BigInt(r.baseline.entitlementRaw) * BigInt(r.target.entitlementRaw)).toString(),
  )
  assert.equal(r.target.quotedMaxWithdrawRaw, '1')
  assert.equal(r.baseline.quotedMaxWithdrawRaw, candidate.baseline.summary.maxWithdrawRaw)
})
test('zero entitlement and independently observed changed shares cannot enter normalized movement', async () => {
  const zero = await capture(candidate, {
    fetcher: mock(candidate, (res, req) => {
      if (
        req.method === 'eth_call' &&
        decodeFunctionData({ abi: ABI, data: req.params[0].data }).functionName === 'previewRedeem'
      )
        res.result = encodeFunctionResult({ abi: ABI, functionName: 'previewRedeem', result: 0n })
    }),
  })
  const r = replayCapacityHistoryPair(zero, candidates)
  assert.equal(r.reason, 'zero_entitlement')
  assert.equal(r.normalizedChange, null)
  const changed = await capture(candidate, {
    fetcher: mock(candidate, (res, req, _url, endpoint) => {
      if (
        req.method === 'eth_call' &&
        decodeFunctionData({ abi: ABI, data: req.params[0].data }).functionName === 'balanceOf' &&
        endpoint === 'target'
      )
        res.result = encodeFunctionResult({ abi: ABI, functionName: 'balanceOf', result: 1n })
    }),
  })
  assert.equal(
    replayCapacityHistoryPair(changed, candidates).status,
    'censored_historical_holder_getter_pair',
  )
})

test('optional successful eth_call with an unverified contract origin cannot establish full source withdrawal evidence', async () => {
  const receipt = await capture(candidate, {
    simulateFullEntitlement: true,
    fetcher: mock(candidate, (res, req) => {
      if (req.method === 'eth_getCode') res.result = '0x1234'
    }),
  })
  const r = replayCapacityHistoryPair(receipt, candidates)
  assert.equal(r.status, 'verified_historical_holder_getter_pair')
  assert.equal(r.fullEntitlementSourceSimulationsVerified, false)
})

test('same nonzero historical runtime/implementation identities are raw-attested while source semantics remain separate', async () => {
  const receipt = await capture(),
    r = replayCapacityHistoryPair(receipt, candidates)
  assert.equal(r.mechanismContinuity, 'same_observed_eip1967_identity')
  assert.equal(r.sameObservedContractIdentity, true)
  assert.match(r.baseline.mechanismIdentity.implementationCodeHash, /^0x[0-9a-f]{64}$/)
  assert.equal(r.implementationSourceAttested, false)
})
test('zero/custom slot remains unknown despite equal getters; changed implementation cannot be labeled same mechanism', async () => {
  const zero = await capture(candidate, {
    fetcher: mock(candidate, (res, req) => {
      if (req.method === 'eth_getStorageAt') res.result = '0x' + '0'.repeat(64)
    }),
  })
  const z = replayCapacityHistoryPair(zero, candidates)
  assert.equal(z.status, 'verified_historical_holder_getter_pair')
  assert.equal(z.mechanismContinuity, 'unknown')
  assert.equal(z.sameObservedContractIdentity, false)
  assert.equal(z.baseline.mechanismIdentity.implementationCodeHash, null)
  const changed = await capture(candidate, {
    fetcher: mock(candidate, (res, req, _url, endpoint) => {
      if (req.method === 'eth_getStorageAt' && endpoint === 'target')
        res.result = '0x' + '0'.repeat(24) + 'c'.repeat(40)
    }),
  })
  const r = replayCapacityHistoryPair(changed, candidates)
  assert.equal(r.mechanismContinuity, 'changed')
  assert.equal(r.sameObservedContractIdentity, false)
})

test('missing vault runtime or malformed storage data cannot masquerade as historical contract identity', async () => {
  for (const kind of ['empty_runtime', 'short_slot']) {
    const receipt = await capture(candidate, {
      fetcher: mock(candidate, (res, req) => {
        if (
          kind === 'empty_runtime' &&
          req.method === 'eth_getCode' &&
          req.params[0] === candidate.destination
        )
          res.result = '0x'
        if (kind === 'short_slot' && req.method === 'eth_getStorageAt') res.result = '0x1234'
      }),
    })
    assert.equal(
      replayCapacityHistoryPair(receipt, candidates).status,
      'censored_historical_holder_getter_pair',
    )
  }
})

test('declared request budget binds physical starts even when below the hard64 ceiling', async () => {
  const receipt = await capture()
  receipt.budget.maxRequests = 36
  seal(receipt)
  assert.equal(replayCapacityHistoryPair(receipt, candidates).reason, 'budget_binding')
})
test('endpoint header ordering binds state reads, not only their source hash', async () => {
  for (const direction of ['before', 'after']) {
    const receipt = await capture()
    receipt.capturedAt = new Date(now + 20).toISOString()
    if (direction === 'before')
      receipt.traces.find((t) => t.phase === 'baseline:header_before').completedAt = new Date(
        now + 1,
      ).toISOString()
    else
      receipt.traces.find((t) => t.phase === 'baseline:asset').completedAt = new Date(
        now + 1,
      ).toISOString()
    seal(receipt)
    assert.equal(replayCapacityHistoryPair(receipt, candidates).reason, 'endpoint_order')
  }
})
test('RPC completion permits only the declared250ms cleanup grace, then rejects the next millisecond', async () => {
  for (const ms of [8250, 8251]) {
    const receipt = await capture()
    const getter = receipt.traces.find((t) => t.phase === 'baseline:asset')
    getter.completedAt = new Date(now + ms).toISOString()
    const after = receipt.traces.find(
      (t) => t.origin === getter.origin && t.phase === 'baseline:header_after',
    )
    after.startedAt = new Date(now + ms).toISOString()
    after.completedAt = after.startedAt
    receipt.capturedAt = new Date(now + ms).toISOString()
    seal(receipt)
    const r = replayCapacityHistoryPair(receipt, candidates)
    assert.equal(
      r.status,
      ms === 8250
        ? 'verified_historical_holder_getter_pair'
        : 'censored_historical_holder_getter_pair',
    )
  }
})
test('capture completion is limited to60seconds plus explicit250ms cleanup', async () => {
  for (const ms of [60250, 60251]) {
    const receipt = await capture()
    receipt.capturedAt = new Date(now + ms).toISOString()
    seal(receipt)
    assert.equal(
      replayCapacityHistoryPair(receipt, candidates).status,
      ms === 60250
        ? 'verified_historical_holder_getter_pair'
        : 'censored_historical_holder_getter_pair',
    )
  }
})
test('derived preview and implementation reads cannot start before their input trace completes', async () => {
  const receipt = await capture()
  receipt.capturedAt = new Date(now + 10).toISOString()
  const balance = receipt.traces.find((t) => t.phase === 'baseline:balance')
  balance.completedAt = new Date(now + 1).toISOString()
  const after = receipt.traces.find(
    (t) => t.origin === balance.origin && t.phase === 'baseline:header_after',
  )
  after.startedAt = new Date(now + 2).toISOString()
  after.completedAt = after.startedAt
  seal(receipt)
  assert.equal(replayCapacityHistoryPair(receipt, candidates).reason, 'getter_dependency_order')
})
test('native transport disables redirects and rejects foreign final URL without storing its secret path', async () => {
  let attempts = 0
  const receipt = await capture(candidate, {
    fetcher: async (_url, init) => {
      attempts++
      assert.equal(init.redirect, 'error')
      return {
        ok: true,
        url: 'https://foreign.example/private-secret',
        text: async () => {
          throw Error('must not read')
        },
      }
    },
  })
  assert.ok(attempts > 0)
  assert.ok(receipt.traces.every((t) => t.transport === 'transport_unavailable'))
  assert.equal(JSON.stringify(receipt).includes('private-secret'), false)
  assert.equal(
    replayCapacityHistoryPair(receipt, candidates).status,
    'censored_historical_holder_getter_pair',
  )
})
test('stream cap aborts before oversized buffering/text and cancels raw body readers', async () => {
  let textCalls = 0,
    cancels = 0,
    aborts = 0
  const receipt = await capture(candidate, {
    fetcher: async (_url, init) => {
      let reads = 0
      init.signal.addEventListener('abort', () => aborts++)
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () =>
              reads++ === 0
                ? { done: false, value: new Uint8Array(128 * 1024 + 1) }
                : { done: true },
            cancel: async () => cancels++,
            releaseLock: () => {},
          }),
        },
        text: async () => {
          textCalls++
          return 'never'
        },
      }
    },
  })
  assert.equal(textCalls, 0)
  assert.ok(cancels > 0 && aborts > 0)
  assert.ok(receipt.traces.some((trace) => trace.transport === 'response_oversize'))
  assert.equal(
    replayCapacityHistoryPair(receipt, candidates).status,
    'censored_historical_holder_getter_pair',
  )
})
test('valid streamed JSON responses work without text fallback', async () => {
  const transport = mock(candidate)
  let textCalls = 0
  const receipt = await capture(candidate, {
    fetcher: async (url, init) => {
      const reply = await transport(url, init)
      const bytes = new TextEncoder().encode(await reply.text())
      let offset = 0
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (offset >= bytes.length) return { done: true }
              const value = bytes.slice(offset, offset + 17)
              offset += 17
              return { done: false, value }
            },
            cancel: async () => {},
            releaseLock: () => {},
          }),
        },
        text: async () => {
          textCalls++
          return 'never'
        },
      }
    },
  })
  assert.equal(textCalls, 0)
  assert.equal(
    replayCapacityHistoryPair(receipt, candidates).status,
    'verified_historical_holder_getter_pair',
  )
})
test('capture admits at most2 outstanding requests per origin and spaces their starts', async () => {
  const active = new Map(),
    max = new Map(),
    times = new Map(),
    transport = mock(candidate)
  const receipt = await capture(candidate, {
    fetcher: async (url, init) => {
      const host = new URL(url).hostname
      active.set(host, (active.get(host) || 0) + 1)
      max.set(host, Math.max(max.get(host) || 0, active.get(host)))
      const starts = times.get(host) || []
      starts.push(performance.now())
      times.set(host, starts)
      await new Promise((r) => setTimeout(r, 70))
      const reply = await transport(url, init)
      active.set(host, active.get(host) - 1)
      return reply
    },
  })
  assert.equal(receipt.budget.physicalRequestStarts, 48)
  for (const host of origins.map((o) => o.host)) {
    assert.ok(max.get(host) <= 2)
    const starts = times.get(host)
    assert.ok(starts.slice(1).every((t, i) => t - starts[i] >= 50))
  }
  assert.equal(
    replayCapacityHistoryPair(receipt, candidates).status,
    'verified_historical_holder_getter_pair',
  )
})

test('returned origin mutation cannot alter trusted two-origin policy', async () => {
  const receipt = await capture()
  receipt.origins[1] = receipt.origins[0]
  receipt.traces = receipt.traces.filter((trace) => trace.origin === receipt.origins[0])
  receipt.traces.forEach((trace, index) => {
    trace.request.id = index + 1
    if (trace.response) trace.response.id = index + 1
  })
  receipt.budget.physicalRequestStarts = receipt.traces.length
  assert.equal(
    replayCapacityHistoryPair(seal(receipt), candidates).status,
    'censored_historical_holder_getter_pair',
  )
  const next = await capture(candidate, { fetcher: mock(candidate) })
  assert.deepEqual(
    next.origins,
    origins.map((origin) => origin.host),
  )
  assert.equal(
    replayCapacityHistoryPair(next, candidates).status,
    'verified_historical_holder_getter_pair',
  )
})
