import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import { collectRouteRange, routeFor, sha } from './routeFlow.mjs'
import { localRouteFlowStore } from './localRouteFlowStore.mjs'

const h = (c) => `0x${c.repeat(64)}`
const a = (c) => `0x${c.repeat(40)}`
const curveVenue = {
  name: 'sUSDe',
  enabled: true,
  underlying: a('1'),
  depthMarkets: [
    {
      enabled: true,
      kind: 'curve-stableswap',
      address: a('2'),
      token0: a('3'),
      token1: a('4'),
      exitFrom: a('4'),
    },
  ],
}
const psmVenue = {
  name: 'sUSDS',
  enabled: true,
  underlying: a('5'),
  depthMarkets: [
    {
      enabled: true,
      kind: 'psm-buffer',
      address: a('6'),
      buffer: a('7'),
      bufferToken: a('8'),
      exitFrom: a('5'),
    },
  ],
}
const curveEvent = parseAbiItem(
  'event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)',
)
const buyEvent = parseAbiItem('event BuyGem(address indexed owner, uint256 value, uint256 fee)')

function fakeClient(venue, { swap = false, wrongIdentity = false } = {}) {
  const route = routeFor(venue)
  const logs = []
  if (swap) {
    const event = route[0].kind === 'curve-stableswap' ? curveEvent : buyEvent
    const args =
      route[0].kind === 'curve-stableswap'
        ? { buyer: a('9'), sold_id: 1n, tokens_sold: 5n, bought_id: 0n, tokens_bought: 4n }
        : { owner: a('9'), value: 4n, fee: 0n }
    const inputs = event.inputs.filter((input) => !input.indexed)
    logs.push({
      address: route[0].address,
      blockNumber: 101n,
      blockHash: h('b'),
      transactionHash: h('c'),
      logIndex: 1,
      removed: false,
      topics: encodeEventTopics({ abi: [event], eventName: event.name, args }),
      data: encodeAbiParameters(
        inputs,
        inputs.map((input) => args[input.name]),
      ),
    })
  }
  return {
    async getChainId() {
      return 1
    },
    async getBlock({ blockNumber, blockTag }) {
      const n = blockTag ? 102n : blockNumber
      return {
        number: n,
        hash: n === 100n ? h('a') : n === 101n ? h('b') : h('d'),
        timestamp: 1000n + n,
      }
    },
    async readContract({ address, functionName, args, blockNumber }) {
      const market = route[0]
      if (functionName === 'coins')
        return wrongIdentity ? a('f') : args[0] === 0n ? market.token0 : market.token1
      if (functionName === 'balances') return blockNumber === 100n ? 100n : 96n
      if (functionName === 'pocket') return wrongIdentity ? a('f') : market.pocket
      if (functionName === 'gem') return market.gem
      if (functionName === 'balanceOf') return blockNumber === 100n ? 100n : 96n
      if (functionName === 'decimals') return 6n
      throw new Error(`unexpected ${address} ${functionName}`)
    },
    async getLogs({ event }) {
      return logs.filter(
        (log) =>
          log.topics[0].toLowerCase() ===
          encodeEventTopics({ abi: [event], eventName: event.name })[0].toLowerCase(),
      )
    },
  }
}

test('configured route is exact and unsupported AMMs abstain', () => {
  assert.equal(routeFor(curveVenue)[0].outputIndex, 0)
  assert.equal(routeFor(psmVenue)[0].pocket, a('7'))
  assert.throws(
    () =>
      routeFor({
        ...curveVenue,
        depthMarkets: [{ ...curveVenue.depthMarkets[0], kind: 'uniswap-v3' }],
      }),
    /unsupported_amm/,
  )
})

test('Curve exit swap is counted in output units, separately from observed inventory delta', async () => {
  const client = fakeClient(curveVenue, { swap: true })
  const range = await collectRouteRange({
    client,
    venue: curveVenue,
    from: 101n,
    to: 101n,
    finalized: await client.getBlock({ blockTag: 'finalized' }),
  })
  assert.equal(range.events.length, 1)
  assert.equal(range.events[0].direction, 'toward_exit')
  assert.equal(range.events[0].outputRaw, '4')
  assert.equal(BigInt(range.after[0].inventoryRaw) - BigInt(range.before[0].inventoryRaw), -4n)
  assert.equal(range.limits.futureFlow, 'unavailable')
})

test('PSM BuyGem is a shared leg and a mismatched Pocket prevents sealing', async () => {
  const client = fakeClient(psmVenue, { swap: true })
  const range = await collectRouteRange({
    client,
    venue: psmVenue,
    from: 101n,
    to: 101n,
    finalized: await client.getBlock({ blockTag: 'finalized' }),
  })
  assert.equal(range.events[0].direction, 'buyGem')
  assert.equal(range.events[0].scope, 'shared_psm_buy_sell_gem_leg')
  assert.equal(range.events[0].outputRaw, '4')
  assert.equal(range.events[0].inputRaw, null)
  const wrong = fakeClient(psmVenue, { wrongIdentity: true })
  const wrongFinalized = await wrong.getBlock({ blockTag: 'finalized' })
  await assert.rejects(
    () =>
      collectRouteRange({
        client: wrong,
        venue: psmVenue,
        from: 101n,
        to: 101n,
        finalized: wrongFinalized,
      }),
    /identity_mismatch/,
  )
})

test('resealing mutated PSM projection or event header relation fails replay', async () => {
  for (const mutation of [
    (event) => {
      event.direction = 'sellGem'
    },
    (event) => {
      event.outputRaw = '4000000'
    },
    (event) => {
      event.blockTime = 0
    },
    (event) => {
      event.blockHash = h('e')
    },
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'route-flow-raw-test-'))
    try {
      const store = localRouteFlowStore({
        root,
        stat: () => ({ bavail: 10_000_000n, bsize: 4096n }),
      })
      const client = fakeClient(psmVenue, { swap: true })
      const range = await collectRouteRange({
        client,
        venue: psmVenue,
        from: 101n,
        to: 101n,
        finalized: await client.getBlock({ blockTag: 'finalized' }),
      })
      store.append(psmVenue, range)
      const path = join(root, 'sUSDS', '000000000001.json')
      const record = JSON.parse(readFileSync(path, 'utf8'))
      mutation(record.events[0])
      record.eventSetHash = sha(record.events)
      const { sha256: _old, ...body } = record
      writeFileSync(path, `${JSON.stringify({ ...body, sha256: sha(body) })}\n`)
      assert.throws(() => store.read(psmVenue), /route_flow_invalid_event/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('local ledger replays exact route and rejects a coverage gap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'route-flow-test-'))
  try {
    const store = localRouteFlowStore({ root, stat: () => ({ bavail: 10_000_000n, bsize: 4096n }) })
    const client = fakeClient(curveVenue)
    const finalized = await client.getBlock({ blockTag: 'finalized' })
    const first = await collectRouteRange({
      client,
      venue: curveVenue,
      from: 101n,
      to: 101n,
      finalized,
    })
    store.append(curveVenue, first)
    assert.equal(store.read(curveVenue).length, 1)
    const gap = {
      ...first,
      fromBlock: '103',
      toBlock: '103',
      anchor: { ...first.anchor, number: '102' },
      end: { ...first.end, number: '103' },
      finalized: { ...first.finalized, number: '103' },
    }
    assert.throws(() => store.append(curveVenue, gap), /gap_or_inventory_discontinuity/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
