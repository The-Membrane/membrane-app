import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFunctionData, parseAbi } from 'viem'
import {
  selectAnchorGrid,
  planProtocolHistory,
  protocolAdapter,
  firstFluidRequests,
  loadProtocolHistoryPlan,
  captureProtocolCapacityPair,
  replayProtocolCapacityPair,
  selectProtocolSource,
} from '../../scripts/research/carry-protocol-capacity-history.mjs'
const subject = {
  route_key: 'USDC → Fluid USD Coin [USDC]',
  destination: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
}
const stamp = (i) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 86400000).toISOString()
const record = (i, state = 'observed') => ({
  collectionMode: 'retrospective',
  chainId: 1,
  block: String(100 + i),
  blockHash: '0x' + String(i + 1).padStart(64, '0'),
  sha256: String(i + 1).padStart(64, '0'),
  anchorAt: stamp(i),
  blockAt: stamp(i),
  firstLocalReceiptAt: stamp(4),
  rows: [
    {
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: 6,
      state,
      reason: state === 'no_code' ? 'not_deployed' : null,
    },
  ],
})
const witness = { manifestSha256: 'a'.repeat(64), headSha256: 'b'.repeat(64) }
const plan = (records) =>
  planProtocolHistory([subject], selectAnchorGrid({ records }), witness, stamp(5))
test('historical clocks and receipt cutoff remain separate; current rows do not replace anchors', () => {
  const p = plan([record(0), { ...record(3), collectionMode: 'current' }, record(1)])
  assert.equal(p.anchors.length, 2)
  assert.equal(p.anchors[0].source.blockTime, stamp(0))
  assert.equal(p.anchors[0].firstLocalReceiptAt, stamp(4))
  assert.equal(p.knowledgeCutoffAt, stamp(5))
  assert.equal(p.semantics.holderExecutableExit, false)
})
test('leading deployment gaps and interior missing states remain on the grid', () => {
  const p = plan([record(0, 'no_code'), record(1), record(2, 'no_code'), record(3)])
  assert.deepEqual(
    p.subjects[0].observations.map((r) => r.state),
    ['no_code', 'observed', 'no_code', 'observed'],
  )
  assert.throws(() => firstFluidRequests(p), /contiguous_pair_missing/)
})
test('known adjacent pair builds8 exact native C/resolver S-W EIP1898 calls', () => {
  const p = plan([record(0), record(1)]),
    r = firstFluidRequests(p)
  assert.equal(r.stateRequests.length, 8)
  assert.equal(r.sourceElapsedSeconds, 86400)
  const abi = parseAbi([
    'function balanceOf(address) view returns(uint256)',
    'function getUserSupplyData(address,address) view',
  ])
  for (const q of r.stateRequests) {
    assert.equal(q.params[1].requireCanonical, true)
    const d = decodeFunctionData({ abi, data: q.params[0].data })
    if (q.fact === 'C') {
      assert.equal(q.params[0].to, subject.asset)
      assert.equal(d.args[0].toLowerCase(), '0x52aa899454998be5b000ad077a46bbe360f4e497')
    } else {
      assert.equal(d.args[0].toLowerCase(), subject.destination)
      assert.equal(d.args[1].toLowerCase(), subject.asset)
    }
  }
})
test('foreign protocol route cannot acquire Fluid adapter by destination alone', () => {
  assert.equal(protocolAdapter({ ...subject, route_key: 'foreign' }).id, null)
  assert.equal(protocolAdapter({ ...subject, asset: '0x' + 'f'.repeat(40) }).id, null)
})
test('unknown adapters retain genuine missing capacity facts', () => {
  const p = planProtocolHistory(
    [{ ...subject, route_key: 'foreign' }],
    [
      {
        ...selectAnchorGrid({ records: [record(0)] })[0],
        rows: [{ ...record(0).rows[0], routeKey: 'foreign' }],
      },
    ],
    witness,
    stamp(5),
  )
  assert.equal(p.subjects[0].adapter.status, 'protocol_adapter_not_implemented')
  assert.equal(p.subjects[0].observations[0].C, null)
})
test('mixed native decimals and foreign observed assets reject', () => {
  for (const change of [
    (r) => (r.rows[0].assetDecimals = 18),
    (r) => (r.rows[0].asset = '0x' + 'f'.repeat(40)),
  ]) {
    const records = [record(0), record(1)]
    change(records[1])
    assert.throws(() => plan(records), /mixed_native_units|native_identity/)
  }
})
test('grid source chronology, canonical hash and knowledge cutoff reject malformed plans', () => {
  for (const change of [
    (r) => (r.blockHash = 'bad'),
    (r) => (r.block = '1e2'),
    (r) => (r.blockAt = stamp(2)),
  ]) {
    const r = record(0)
    change(r)
    assert.throws(() => plan([r]), /anchor/)
  }
  assert.throws(
    () =>
      planProtocolHistory([subject], selectAnchorGrid({ records: [record(0)] }), witness, stamp(1)),
    /knowledge_cutoff/,
  )
})
test('saved verified120-anchor plan contains67 core subjects and distinct supplemental scope without network', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = () => {
    throw Error('network_disabled')
  }
  try {
    const p = await loadProtocolHistoryPlan()
    assert.equal(p.core.anchors.length, 120)
    assert.equal(p.core.subjects.length, 67)
    assert.equal(new Set(p.core.subjects.map((s) => s.routeKey)).size, 25)
    assert.equal(p.supplemental.subjects.length, 1)
    assert.equal(p.supplemental.witness.scope, 'supplemental_separate')
    assert.equal(p.core.subjects.filter((s) => s.adapter.id).length, 3)
    assert.equal(p.core.flowArchives[0].capacityFactsPresent, false)
  } finally {
    globalThis.fetch = previous
  }
})

const origins = [
  { host: 'eth-mainnet.g.alchemy.com', url: 'https://eth-mainnet.g.alchemy.com/test' },
  { host: 'rpc.ankr.com', url: 'https://rpc.ankr.com/test' },
]
function mockCollector(clock, options = {}) {
  return async (subject, origins, policy) => {
    options.policies?.push(policy)
    const startedAt = new Date(clock.value).toISOString()
    clock.value += 1000
    if (options.fail) throw Error('private_error_must_not_persist')
    const target = policy.source.blockNumber === 101
    return {
      sha256: (target ? 'd' : 'c').repeat(64),
      subject,
      source: policy.source,
      startedAt,
      capturedAt: new Date(clock.value).toISOString(),
      budget: { physicalRequestStarts: 28 },
      prongs: {
        sharedLiquidityCashRaw: target ? '70' : '100',
        resolverSupplyRaw: target ? '220' : '200',
        expandedWithdrawalLimitRaw: target ? '30' : '50',
      },
      origins: [
        {
          identities: [{ address: '0x' + 'a'.repeat(40), codeHash: '0x' + 'b'.repeat(64) }],
          limitParameters: {
            lastUpdateTimestamp: '1',
            expandPercent: '2000',
            expandDuration: '86400',
            baseWithdrawalLimitRaw: '50',
            decayEndTimestamp: '0',
            reportedDecayAmountRaw: '0',
          },
        },
      ],
    }
  }
}
const mockReplay = (receipt, subject, source) => {
  assert.deepEqual(receipt.subject, subject)
  assert.deepEqual(receipt.source, source)
  return { ...subject, source, prongs: receipt.prongs, origins: receipt.origins }
}
async function pairFixture(options = {}) {
  const p = plan([record(0), record(1)]),
    clock = { value: Date.parse(stamp(5)) }
  const receipt = await captureProtocolCapacityPair(
    p,
    0,
    [selectProtocolSource(p, stamp(0)), selectProtocolSource(p, stamp(1))],
    origins,
    {
      capture: mockCollector(clock, options),
      now: () => clock.value,
      wait: async (ms) => {
        clock.value += ms
      },
    },
  )
  return { p, receipt }
}
test('pair capture spends56physicalstarts under one64/60s budget with remaining limits', async () => {
  const policies = [],
    { p, receipt } = await pairFixture({ policies })
  assert.equal(receipt.physicalRequestStarts, 56)
  assert.deepEqual(
    policies.map((p) => p.maxRequests),
    [64, 36],
  )
  assert.deepEqual(
    policies.map((p) => p.deadlineMs),
    [60000, 58950],
  )
  const value = await replayProtocolCapacityPair(receipt, p, mockReplay)
  assert.deepEqual(value.signedNativeDeltas, { C: '-30', S: '20', W: '-20' })
  assert.equal(value.elapsedSeconds, 86400)
  assert.equal(value.regime.proxyImplementationContinuity, 'unknown_not_read')
  assert.equal(value.holderExecutableExit, false)
  assert.equal(value.executableMaximumRaw, null)
})
test('capture rejects a foreign selfdeclared source before starting collector', async () => {
  const p = plan([record(0), record(1)]),
    sources = [selectProtocolSource(p, stamp(0)), selectProtocolSource(p, stamp(1))]
  sources[1].blockHash = '0x' + 'f'.repeat(64)
  let calls = 0
  await assert.rejects(
    () =>
      captureProtocolCapacityPair(p, 0, sources, origins, {
        capture: () => {
          calls++
        },
      }),
    /capture_source_not_pinned/,
  )
  assert.equal(calls, 0)
})
test('failed endpoint preserves attrition and stops rather than inventing request accounting', async () => {
  const { p, receipt } = await pairFixture({ fail: true })
  assert.equal(receipt.outcomes.length, 1)
  assert.equal(receipt.outcomes[0].status, 'censored')
  assert.ok(!JSON.stringify(receipt).includes('private_error'))
  assert.equal(
    (await replayProtocolCapacityPair(receipt, p, mockReplay)).status,
    'censored_protocol_capacity_history_pair',
  )
})
test('resealed receipt accounting cannot hide physical starts or foreign native units', async () => {
  const { p, receipt } = await pairFixture()
  const { createHash } = await import('node:crypto')
  for (const change of [
    (r) => (r.physicalRequestStarts = 55),
    (r) => (r.subject.asset = '0x' + 'f'.repeat(40)),
    (r) => (r.subject.assetDecimals = 18),
    (r) => (r.outcomes[1].receipt.source.blockTime = stamp(2)),
  ]) {
    const copy = structuredClone(receipt)
    change(copy)
    delete copy.sha256
    copy.sha256 = createHash('sha256').update(JSON.stringify(copy)).digest('hex')
    await assert.rejects(() => replayProtocolCapacityPair(copy, p, mockReplay), /pair_/)
  }
})
test('saved verified flow endpoints provide a3.023h protocol-history candidate with partialcompetition disclosure', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = () => {
    throw Error('network_disabled')
  }
  try {
    const { core } = await loadProtocolHistoryPlan()
    const start = selectProtocolSource(core, 'flow-start'),
      end = selectProtocolSource(core, 'flow-end')
    assert.equal((Date.parse(end.blockTime) - Date.parse(start.blockTime)) / 1000, 10884)
    assert.equal(core.flowArchives[0].sharedBankCompetition, false)
    assert.equal(core.flowArchives[0].depositIsCashReplenishment, false)
  } finally {
    globalThis.fetch = previous
  }
})

test('actual Fluid collector ABI/rawtrace replay composes both independently pinned historical endpoints offline', async () => {
  const {
    captureFluidCapacityProngs,
    replayFluidCapacityProngs,
    FLUID_CAPACITY_ABI,
    FLUID_RESOLVER_ABI,
  } = await import('../../scripts/research/carry-fluid-capacity-prongs.mjs')
  const { encodeFunctionResult } = await import('viem')
  const p = plan([record(0), record(1)]),
    sources = [selectProtocolSource(p, stamp(0)), selectProtocolSource(p, stamp(1))],
    zero = '0x' + '0'.repeat(40),
    liquidity = '0x52aa899454998be5b000ad077a46bbe360f4e497'
  const resolver = FLUID_RESOLVER_ABI.find((f) => f.name === 'getUserSupplyData')
  const zeros = (c) =>
    c.type === 'tuple'
      ? Object.fromEntries(c.components.map((k) => [k.name, zeros(k)]))
      : c.type === 'address'
        ? zero
        : c.type === 'bool'
          ? false
          : 0n
  const capture = (subject, origins, options) =>
    captureFluidCapacityProngs(subject, origins, {
      ...options,
      fetcher: async (url, init) => {
        const req = JSON.parse(init.body),
          source = options.source
        let result
        if (req.method === 'eth_chainId') result = '0x1'
        if (req.method === 'eth_getBlockByNumber')
          result = {
            number: '0x' + source.blockNumber.toString(16),
            hash: source.blockHash,
            timestamp: '0x' + (Date.parse(source.blockTime) / 1000).toString(16),
          }
        if (req.method === 'eth_getCode') result = '0x60016000'
        if (req.method === 'eth_call') {
          const d = decodeFunctionData({ abi: FLUID_CAPACITY_ABI, data: req.params[0].data })
          let value
          if (d.functionName === 'asset') value = subject.asset
          if (d.functionName === 'decimals') value = 6
          if (d.functionName === 'LIQUIDITY') value = liquidity
          if (d.functionName === 'getData')
            value = [
              liquidity,
              zero,
              zero,
              zero,
              zero,
              false,
              1000n,
              1000000000000n,
              1000000000000n,
            ]
          if (d.functionName === 'balanceOf') value = source.blockNumber === 100 ? 100n : 70n
          if (d.functionName === 'getUserSupplyData')
            value = [
              {
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
              },
              zeros(resolver.outputs[1]),
            ]
          result = encodeFunctionResult({
            abi: FLUID_CAPACITY_ABI,
            functionName: d.functionName,
            result: value,
          })
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
      },
    })
  const receipt = await captureProtocolCapacityPair(p, 0, sources, origins, { capture })
  assert.equal(receipt.physicalRequestStarts, 56)
  for (const host of origins.map((o) => o.host)) {
    const last = receipt.outcomes[0].receipt.traces.filter((t) => t.host === host).at(-1)
    const first = receipt.outcomes[1].receipt.traces.find((t) => t.host === host)
    assert.ok(Date.parse(first.startedAt) - Date.parse(last.completedAt) >= 50)
  }
  const value = await replayProtocolCapacityPair(receipt, p, replayFluidCapacityProngs)
  assert.deepEqual(value.signedNativeDeltas, { C: '-30', S: '0', W: '0' })
  assert.equal(value.regime.stableParameters, true)
  assert.equal(value.regime.sourceEquivalence, 'unverified_at_captured_runtime')
  assert.equal(value.regime.proxyImplementationContinuity, 'unknown_not_read')
})
