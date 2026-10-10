import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { encodeFunctionResult, decodeFunctionData, encodeFunctionData } from 'viem'
import {
  captureFluidCapacityProngs,
  replayFluidCapacityProngs,
  FLUID_CAPACITY_ABI,
  FLUID_RESOLVER_ABI,
  writeFluidCapacityProof,
} from '../../scripts/research/carry-fluid-capacity-prongs.mjs'
const subject = {
    routeKey: 'USDC → Fluid USD Coin [USDC]',
    destination: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
  },
  liquidity = '0x52aa899454998be5b000ad077a46bbe360f4e497',
  source = {
    chainId: 1,
    blockNumber: 26000000,
    blockHash: '0x' + 'a'.repeat(64),
    blockTime: '2026-10-01T00:00:00.000Z',
    finalized: true,
  },
  origins = [
    { host: 'eth-mainnet.g.alchemy.com', url: 'https://eth-mainnet.g.alchemy.com/key-never-saved' },
    { host: 'rpc.ankr.com', url: 'https://rpc.ankr.com/key-never-saved' },
  ]
const head = {
    number: '0x' + source.blockNumber.toString(16),
    hash: source.blockHash,
    timestamp: '0x' + (Date.parse(source.blockTime) / 1000).toString(16),
  },
  zero = '0x' + '0'.repeat(40)
const supply = {
  modeWithInterest: true,
  supply: 1000n,
  withdrawalLimit: 800n,
  lastUpdateTimestamp: 1n,
  expandPercent: 1000n,
  expandDuration: 86400n,
  baseWithdrawalLimit: 800n,
  withdrawableUntilLimit: 200n,
  withdrawable: 150n,
  decayEndTimestamp: 2n,
  decayAmount: 0n,
}
const f = FLUID_RESOLVER_ABI.find((f) => f.name === 'getUserSupplyData')
function zeroValue(c) {
  if (c.type === 'tuple') return Object.fromEntries(c.components.map((k) => [k.name, zeroValue(k)]))
  return c.type === 'address' ? zero : 0n
}
const overall = zeroValue(f.outputs[1])
function stub({ mutate, redirect = false, oversize = false, hang = false } = {}) {
  return async (url, init) => {
    const p = JSON.parse(init.body)
    assert.equal(init.redirect, 'error')
    if (hang) return new Promise(() => {})
    let result
    if (p.method === 'eth_chainId') result = '0x1'
    if (p.method === 'eth_getBlockByNumber') result = head
    if (p.method === 'eth_getCode') result = '0x60016000'
    if (p.method === 'eth_call') {
      assert.deepEqual(p.params[1], { blockHash: source.blockHash, requireCanonical: true })
      const { functionName, args } = decodeFunctionData({
        abi: FLUID_CAPACITY_ABI,
        data: p.params[0].data,
      })
      let value
      if (functionName === 'asset') value = subject.asset
      if (functionName === 'decimals') value = 6
      if (functionName === 'getData')
        value = [liquidity, zero, zero, zero, zero, false, 1000n, 1000000000000n, 1000000000000n]
      if (functionName === 'LIQUIDITY') value = liquidity
      if (functionName === 'getUserSupplyData') {
        assert.deepEqual(
          args.map((x) => x.toLowerCase()),
          [subject.destination, subject.asset],
        )
        value = [supply, overall]
      }
      if (functionName === 'balanceOf') {
        assert.equal(args[0].toLowerCase(), liquidity)
        value = 100n
      }
      result = encodeFunctionResult({ abi: FLUID_CAPACITY_ABI, functionName, result: value })
    }
    if (mutate) result = mutate({ p, url, result })
    return new Response(
      oversize ? 'x'.repeat(128 * 1024 + 1) : JSON.stringify({ jsonrpc: '2.0', id: p.id, result }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
}
let receipt
await test('actual writer allows exact citation metadata and rejects all other payload URLs', async () => {
  const dir = mkdtempSync('/private/tmp/fluid-capacity-writer-')
  try {
    const proof = await captureFluidCapacityProngs(subject, origins, { source, fetcher: stub() })
    const before = structuredClone(proof),
      file = dir + '/valid.json'
    const result = writeFluidCapacityProof(file, proof)
    assert.equal(result.bytes, Buffer.byteLength(readFileSync(file)))
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), proof)
    assert.deepEqual(proof, before)
    const bad = structuredClone(proof)
    bad.traces[0].rpcUrl = 'https://eth-mainnet.g.alchemy.com/private-provider-key'
    assert.throws(() => writeFluidCapacityProof(dir + '/bad.json', bad), /proof_url_rejected/)
    assert.equal(existsSync(dir + '/bad.json'), false)
    const misplaced = structuredClone(proof)
    misplaced.traces[0].reference = proof.sourceEvidence.candidateSourceReferences.resolverAbi
    assert.throws(
      () => writeFluidCapacityProof(dir + '/misplaced.json', misplaced),
      /proof_url_rejected/,
    )
    const forged = structuredClone(proof)
    forged.sourceEvidence.candidateSourceReferences.resolverAbi =
      'https://eth-mainnet.g.alchemy.com/private-provider-key'
    assert.throws(
      () => writeFluidCapacityProof(dir + '/forged.json', forged),
      /source_citations_invalid/,
    )
  } finally {
    rmSync(dir, { recursive: true })
  }
})
await test('complete28-request old-header capture independently replays C/S/W and preserves full public ABI wire', async () => {
  receipt = await captureFluidCapacityProngs(subject, origins, { source, fetcher: stub() })
  assert.equal(receipt.budget.physicalRequestStarts, 28)
  assert.equal(receipt.prongs.prongs.sharedLiquidityCashRaw, '100')
  assert.equal(receipt.prongs.origins[0].limitParameters.expandDuration, '86400')
  assert.deepEqual(replayFluidCapacityProngs(receipt, subject, source), receipt.prongs)
  assert.ok(!JSON.stringify(receipt).includes('key-never-saved'))
  assert.equal(receipt.prongs.executableMaximumRaw, null)
})
await test('canonical exact verified ABI input encoding is unchanged', () => {
  assert.equal(
    encodeFunctionData({
      abi: FLUID_RESOLVER_ABI,
      functionName: 'getUserSupplyData',
      args: [subject.destination, subject.asset],
    }).slice(0, 10),
    '0x' +
      encodeFunctionData({
        abi: FLUID_CAPACITY_ABI,
        functionName: 'getUserSupplyData',
        args: [subject.destination, subject.asset],
      }).slice(2, 10),
  )
})
for (const kind of ['cash', 'code', 'header', 'asset', 'decimals'])
  await test(`two-origin ${kind} disagreement rejects`, async () => {
    await assert.rejects(
      captureFluidCapacityProngs(subject, origins, {
        source,
        fetcher: stub({
          mutate: ({ p, url, result }) => {
            if (!url.includes('rpc.ankr.com')) return result
            if (kind === 'code' && p.method === 'eth_getCode') return '0x6002'
            if (kind === 'header' && p.method === 'eth_getBlockByNumber')
              return { ...head, hash: '0x' + 'b'.repeat(64) }
            if (p.method === 'eth_call') {
              const { functionName } = decodeFunctionData({
                abi: FLUID_CAPACITY_ABI,
                data: p.params[0].data,
              })
              if (
                (kind === 'cash' && functionName === 'balanceOf') ||
                (kind === 'asset' && functionName === 'asset') ||
                (kind === 'decimals' && functionName === 'decimals')
              )
                return encodeFunctionResult({
                  abi: FLUID_CAPACITY_ABI,
                  functionName,
                  result: kind === 'asset' ? zero : kind === 'decimals' ? 18 : 101n,
                })
            }
            return result
          },
        }),
      }),
    )
  })
await test('receipt seal, exact request/native identity and source pin mutations reject', () => {
  for (const mutate of [
    (r) => {
      r.source.blockHash = '0x' + 'b'.repeat(64)
    },
    (r) => {
      r.traces.find((t) => t.request.method === 'eth_call').request.params[1].requireCanonical =
        false
    },
    (r) => {
      r.prongs.holderExecutableExit = true
    },
  ]) {
    const r = structuredClone(receipt)
    mutate(r)
    assert.throws(() => replayFluidCapacityProngs(r, subject, source))
  }
})
await test('oversize streaming payload fails safely', async () => {
  await assert.rejects(
    captureFluidCapacityProngs(subject, origins, { source, fetcher: stub({ oversize: true }) }),
  )
})
await test('uncooperative transport is bounded by overall deadline plus cleanup', async () => {
  const started = Date.now()
  await assert.rejects(
    captureFluidCapacityProngs(subject, origins, {
      source,
      fetcher: stub({ hang: true }),
      deadlineMs: 1000,
    }),
  )
  assert.ok(Date.now() - started < 1600)
})
await test('primitive malformed source and canonical-host aliases reject before RPC', async () => {
  let starts = 0
  const fetcher = async () => {
    starts++
    throw Error('must-not-run')
  }
  for (const s of [
    { ...source, blockHash: [source.blockHash] },
    { ...source, blockTime: [source.blockTime] },
    { ...source, blockNumber: [source.blockNumber] },
  ])
    await assert.rejects(captureFluidCapacityProngs(subject, origins, { source: s, fetcher }))
  await assert.rejects(
    captureFluidCapacityProngs(
      subject,
      [
        origins[0],
        { host: 'eth-mainnet.g.alchemy.com.', url: 'https://eth-mainnet.g.alchemy.com./other' },
      ],
      { source, fetcher },
    ),
  )
  assert.equal(starts, 0)
})
await test('failed endpoints retain bounded sanitized raw traces and physical starts', async () => {
  try {
    await captureFluidCapacityProngs(subject, origins, {
      source,
      fetcher: async (_url, init) => {
        const p = JSON.parse(init.body)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: p.id,
            error: { code: -32603, message: 'https://never-save-secret' },
          }),
          { status: 200 },
        )
      },
    })
    assert.fail('must fail')
  } catch (error) {
    assert.equal(error.failedReceipt.status, 'unavailable')
    assert.equal(error.failedReceipt.budget.physicalRequestStarts, 2)
    assert.equal(error.failedReceipt.traces.length, 2)
    assert.ok(!JSON.stringify(error.failedReceipt).includes('never-save-secret'))
  }
})
await test('current finalized capture and inclusive30min replay expiry retain original source clock', async () => {
  const offset = Date.parse(source.blockTime) + 1740000 - Date.now()
  const now = () => Date.now() + offset
  const r = await captureFluidCapacityProngs(subject, origins, { fetcher: stub(), now })
  assert.equal(r.mode, 'current_finalized')
  assert.equal(r.source.blockTime, source.blockTime)
  assert.deepEqual(replayFluidCapacityProngs(r, subject, source), r.prongs)
  const boundary = structuredClone(r)
  delete boundary.sha256
  boundary.capturedAt = new Date(Date.parse(source.blockTime) + 1800000).toISOString()
  assert.deepEqual(replayFluidCapacityProngs(boundary, subject, source), r.prongs)
  boundary.capturedAt = new Date(Date.parse(source.blockTime) + 1800001).toISOString()
  assert.throws(() => replayFluidCapacityProngs(boundary, subject, source))
})
await test('redirected responses fail; source/subject malformed and foreign native subjects fail before RPC', async () => {
  await assert.rejects(
    captureFluidCapacityProngs(subject, origins, {
      source,
      fetcher: async () => {
        const r = new Response('{}')
        Object.defineProperty(r, 'redirected', { value: true })
        return r
      },
    }),
  )
  let starts = 0
  await assert.rejects(
    captureFluidCapacityProngs({ ...subject, destination: zero }, origins, {
      source,
      fetcher: async () => {
        starts++
        throw Error('forbidden')
      },
    }),
  )
  assert.equal(starts, 0)
})
await test('trace starts respect50ms spacing and never overlap more than2 perhost', () => {
  for (const host of receipt.origins) {
    const traces = receipt.traces.filter((t) => t.host === host)
    for (let i = 1; i < traces.length; i++) {
      assert.ok(Date.parse(traces[i].startedAt) - Date.parse(traces[i - 1].startedAt) >= 49)
      assert.ok(Date.parse(traces[i].startedAt) >= Date.parse(traces[i - 1].completedAt))
    }
  }
})
await test('replay independently rejects a re-sealed wrong native read or promoted prongs', () => {
  for (const mutate of [
    (r) => {
      r.traces.find((t) => t.phase === 'cash').request.params[0].to = zero
    },
    (r) => {
      r.prongs.sourceEquivalence = 'verified'
    },
    (r) => {
      r.origins[1] = r.origins[0]
    },
  ]) {
    const r = structuredClone(receipt)
    mutate(r)
    delete r.sha256
    assert.throws(() => replayFluidCapacityProngs(r, subject, source))
  }
})
for (const mutation of [
  'call_duration',
  'call_after_deadline',
  'call_before_capture',
  'noncanonical_clock',
  'count_over_budget',
  'changed_timeout',
  'changed_spacing',
  'phase_order',
  'header_enclosure',
  'request_id',
])
  await test(`replay rejects forged ${mutation} with seal removed`, () => {
    const r = structuredClone(receipt)
    delete r.sha256
    const call = r.traces.find((t) => t.phase === 'cash')
    if (mutation === 'call_duration')
      call.completedAt = new Date(Date.parse(call.startedAt) + 8251).toISOString()
    if (mutation === 'call_after_deadline')
      call.startedAt = new Date(Date.parse(r.startedAt) + r.budget.deadlineMs).toISOString()
    if (mutation === 'call_before_capture')
      call.startedAt = new Date(Date.parse(r.startedAt) - 1).toISOString()
    if (mutation === 'noncanonical_clock') call.startedAt = [call.startedAt]
    if (mutation === 'count_over_budget') r.budget.maxRequests = 27
    if (mutation === 'changed_timeout') r.budget.rpcTimeoutMs = 9000
    if (mutation === 'changed_spacing') r.budget.minStartSpacingMs = 0
    if (mutation === 'phase_order') {
      const finalized = r.traces.find((t) => t.phase === 'finalized')
      finalized.completedAt = r.capturedAt
    }
    if (mutation === 'header_enclosure') {
      const header = r.traces.find((t) => t.phase === 'header_after' && t.host === call.host)
      call.completedAt = new Date(Date.parse(header.startedAt) + 1).toISOString()
    }
    if (mutation === 'request_id') {
      call.request.id = 100
      call.response.id = 100
    }
    assert.throws(() => replayFluidCapacityProngs(r, subject, source))
  })
await test('equal-height finalized hash/time conflict fails capture and replay; higher historical ceilings remain valid', async () => {
  for (const field of ['hash', 'timestamp']) {
    const changed = {
      ...head,
      [field]:
        field === 'hash'
          ? '0x' + 'b'.repeat(64)
          : '0x' + (BigInt(head.timestamp) + 1n).toString(16),
    }
    await assert.rejects(
      captureFluidCapacityProngs(subject, origins, {
        source,
        fetcher: stub({
          mutate: ({ p, result }) =>
            p.method === 'eth_getBlockByNumber' && p.params[0] === 'finalized' ? changed : result,
        }),
      }),
      /finalized_header_conflict/,
    )
    const r = structuredClone(receipt)
    delete r.sha256
    for (const t of r.traces.filter((t) => t.phase === 'finalized')) t.response.result = changed
    assert.throws(() => replayFluidCapacityProngs(r, subject, source), /finalized_header_conflict/)
  }
  const higher = {
    ...head,
    number: '0x' + (BigInt(head.number) + 1n).toString(16),
    hash: '0x' + 'b'.repeat(64),
    timestamp: '0x' + (BigInt(head.timestamp) + 12n).toString(16),
  }
  const r = await captureFluidCapacityProngs(subject, origins, {
    source,
    fetcher: stub({
      mutate: ({ p, result }) =>
        p.method === 'eth_getBlockByNumber' && p.params[0] === 'finalized' ? higher : result,
    }),
  })
  assert.equal(r.prongs.source.blockHash, source.blockHash)
})
await test('unapproved distinct hosts cannot self-issue a two-origin prong receipt', () => {
  const r = structuredClone(receipt)
  delete r.sha256
  const replaced = r.origins[1]
  r.origins[1] = 'foreign.example'
  for (const t of r.traces) if (t.host === replaced) t.host = 'foreign.example'
  assert.throws(() => replayFluidCapacityProngs(r, subject, source), /receipt_invalid/)
})
