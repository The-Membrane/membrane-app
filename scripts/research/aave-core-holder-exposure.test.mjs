import assert from 'node:assert/strict'
import test from 'node:test'
import { MARKETS, POOL } from './aave-core-forward-panel.mjs'
import {
  PAGE_SIZE,
  collect,
  outputPath,
  parseFirstPage,
  plan,
} from './aave-core-holder-exposure.mjs'

const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`
const pages = () =>
  MARKETS.map(() => ({
    items: Array.from({ length: PAGE_SIZE }, (_, i) => ({
      address: { hash: A(i + 1) },
      value: String(1000 - i),
    })),
    next_page_params: { items_count: PAGE_SIZE },
  }))
const output = 'data/research/venue-signals/exposure-test.json'

function fixture({
  changedBlock = false,
  wrongReserve = false,
  viemEmptyCodeUndefined = false,
  malformedRawHolderCode = false,
  badChain = false,
  badPage = false,
  missingImplementation = false,
  missingImplementationCode = false,
} = {}) {
  const calls = []
  const body = pages()
  if (badPage) body[0].items.pop()
  let blockCalls = 0
  const fetchPage = async (url) => {
    calls.push(`fetch:${url}`)
    const i = MARKETS.findIndex((m) => url.includes(m.aToken))
    return { status: 200, url, body: body[i] }
  }
  const client = {
    async request({ method, params }) {
      calls.push(method)
      assert.deepEqual(params.at(-1), { blockHash: H(1), requireCanonical: true })
      if (method === 'eth_getStorageAt') {
        assert.match(params[1], /^0x[0-9a-f]{64}$/)
        return missingImplementation ? H(0) : H(200)
      }
      if (method === 'eth_getCode') {
        if (params[0] === A(200)) return missingImplementationCode ? '0x' : '0x6000'
        if (params[0] === A(1) && malformedRawHolderCode) return '0x0'
        return '0x'
      }
      throw new Error('Unexpected RPC request')
    },
    async getChainId() {
      calls.push('chain')
      return badChain ? 10 : 1
    },
    async getBlock(args) {
      calls.push('block')
      blockCalls++
      assert.ok(args.blockTag === 'finalized' || args.blockNumber === 9000n)
      return {
        number: 9000n,
        hash: H(changedBlock && blockCalls === 2 ? 2 : 1),
        timestamp: 1_700_000_000n,
      }
    },
    async getCode({ address, blockNumber }) {
      assert.equal(blockNumber, 9000n)
      calls.push('code')
      if (viemEmptyCodeUndefined && address.toLowerCase() === A(1).toLowerCase()) return undefined
      return [POOL, ...MARKETS.flatMap((m) => [m.base, m.aToken])].some(
        (x) => x.toLowerCase() === address.toLowerCase(),
      )
        ? '0x6000'
        : '0x'
    },
    async readContract({ address, functionName, args, blockNumber }) {
      assert.equal(blockNumber, 9000n)
      calls.push(functionName)
      if (functionName === 'getReserveData') {
        const market = MARKETS.find((m) => m.base.toLowerCase() === args[0].toLowerCase())
        return {
          aTokenAddress: wrongReserve ? A(999) : market.aToken,
          configuration: { data: 6n << 48n },
        }
      }
      if (functionName === 'decimals') return 6n
      if (functionName === 'totalSupply') return 1_000_000_000n
      if (functionName === 'balanceOf') {
        if (MARKETS.some((m) => m.base.toLowerCase() === address.toLowerCase())) return 500_000_000n
        return BigInt(1000 - Number(BigInt(args[0])))
      }
      throw new Error('Unexpected function')
    },
  }
  return { client, fetchPage, calls }
}

test('dry plan does not read the network or write', () => {
  assert.equal(plan().status, 'dry-only')
  assert.equal(outputPath(output).endsWith('/data/research/venue-signals/exposure-test.json'), true)
  assert.throws(() => outputPath('/tmp/out.json'), /under data\/research/)
})

test('first page rejects short, duplicate and nonmonotonic candidates', () => {
  const [body] = pages()
  assert.equal(parseFirstPage(body).length, 50)
  assert.throws(() => parseFirstPage({ ...body, items: body.items.slice(0, 49) }), /truncated/)
  assert.throws(
    () => parseFirstPage({ ...body, items: [body.items[0], ...body.items.slice(0, 49)] }),
    /duplicate/,
  )
  const inverted = structuredClone(body)
  inverted.items[1].value = '2000'
  assert.throws(() => parseFirstPage(inverted), /Nonmonotonic/)
})

test('snapshot verifies both lists at one finalized block and ranks pinned balances', async () => {
  const { client, fetchPage, calls } = fixture()
  let clock = 1_700_000_100_000
  const result = await collect({
    client,
    fetchPage,
    out: output,
    checkDisk: () => {},
    now: () => ++clock,
  })
  assert.equal(result.payload.block, 9000)
  assert.equal(result.payload.firstKnownAtMs, result.payload.capturedAtMs)
  assert.equal(result.payload.markets.length, 2)
  assert.equal(result.payload.markets[0].holders.length, 50)
  assert.equal(result.payload.markets[0].holders[0].balanceRaw, '999')
  assert.equal(result.payload.markets[0].holders[0].codeKind, 'no-code')
  assert.equal(result.payload.markets[0].largestSampledClaimOverCashPpm, '1')
  assert.equal(result.payload.poolImplementation, A(200))
  assert.equal(result.payload.markets[0].aTokenImplementation, A(200))
  assert.equal(result.payload.markets[0].hypotheticalCashShocks[1].amountRaw, '50000000000000')
  assert.equal(result.payload.markets[0].hypotheticalCashShocks[1].largestSampledClaimCovers, false)
  assert.equal(calls.filter((x) => x === 'code').length, 5)
  assert.equal(calls.filter((x) => x === 'eth_getCode').length, 103)
  assert.equal(calls.at(-1), 'block')
})

test('raw pinned 0x identifies no deployed code even when viem returns undefined', async () => {
  const { client, fetchPage, calls } = fixture({ viemEmptyCodeUndefined: true })
  const result = await collect({
    client,
    fetchPage,
    out: output,
    checkDisk: () => {},
    now: () => 1_700_000_100_000,
  })
  assert.equal(result.payload.markets[0].holders[0].codeKind, 'no-code')
  assert.equal(calls.filter((method) => method === 'eth_getCode').length, 103)
})

test('skewed or nonmonotonic local clocks cannot create artificial lead time', async () => {
  for (const clockValues of [
    [0, 1_700_000_100_000, 1_700_000_100_001],
    [1_700_000_100_001, 1_700_000_100_000, 1_700_000_100_002],
    [1_699_999_999_000, 1_699_999_999_001, 1_699_999_999_002],
    [1_700_003_600_000, 1_700_003_600_001, 1_700_003_600_002],
    [1_700_000_100_000, 1_700_000_100_001, 1_700_000_700_001],
  ]) {
    const { client, fetchPage } = fixture()
    let index = 0
    await assert.rejects(
      collect({
        client,
        fetchPage,
        out: output,
        checkDisk: () => {},
        now: () => clockValues[index++],
      }),
      /clock/,
    )
  }
})

test('wrong chain, page, reserve, holder code, or reorg fails closed', async () => {
  for (const opt of [
    { badChain: true },
    { badPage: true },
    { wrongReserve: true },
    { malformedRawHolderCode: true },
    { missingImplementation: true },
    { missingImplementationCode: true },
    { changedBlock: true },
  ]) {
    const { client, fetchPage } = fixture(opt)
    await assert.rejects(
      collect({
        client,
        fetchPage,
        out: output,
        checkDisk: () => {},
        now: () => 1_700_000_100_000,
      }),
    )
  }
})

test('disk guard failure aborts before the first live read', async () => {
  const { client, fetchPage, calls } = fixture()
  await assert.rejects(
    collect({
      client,
      fetchPage,
      out: output,
      checkDisk: () => {
        throw new Error('low disk')
      },
    }),
    /low disk/,
  )
  assert.deepEqual(calls, [])
})
