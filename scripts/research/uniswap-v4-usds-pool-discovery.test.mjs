import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from 'viem'
import { collect, MAX_BLOCKS, verify } from './uniswap-v4-usds-pool-discovery.mjs'

const MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90'
const USDS = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const ABI = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
])
const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const temp = () => mkdtempSync(join(tmpdir(), 'v4-discovery-'))
const stat = () => ({ bavail: 1_000_000, bsize: 4096 })
const sha = (r) => createHash('sha256').update(JSON.stringify(r)).digest('hex')
const poolKey = parseAbiParameters('address, address, uint24, int24, address')
const fee = 500,
  tickSpacing = 10,
  hooks = `0x${'00'.repeat(20)}`
const [currency0, currency1] = [USDS, USDC].sort()
const id = keccak256(encodeAbiParameters(poolKey, [currency0, currency1, fee, tickSpacing, hooks]))
const event = () => ({
  address: MANAGER,
  blockNumber: '0x65',
  blockHash: H(101),
  transactionHash: H(300),
  transactionIndex: '0x0',
  logIndex: '0x1',
  removed: false,
  topics: encodeEventTopics({
    abi: ABI,
    eventName: 'Initialize',
    args: { id, currency0, currency1 },
  }),
  data: encodeAbiParameters(parseAbiParameters('uint24,int24,address,uint160,int24'), [
    fee,
    tickSpacing,
    hooks,
    79228162514264337593543950336n,
    0,
  ]),
})
function rpc({ quiet = false, wrongId = false, drift = false, truncated = false } = {}) {
  const calls = []
  const client = {
    async request({ method, params }) {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized') return { number: '0xc8', hash: H(200), timestamp: '0x64' }
        const n = Number(BigInt(params[0]))
        const repeated = calls.filter(
          (c) => c.method === method && c.params[0] === params[0],
        ).length
        return {
          number: params[0],
          hash: drift && n === 101 && repeated > 1 ? H(999) : H(n),
          timestamp: '0x64',
        }
      }
      if (method === 'eth_getLogs') {
        const filter = params[0]
        if (truncated) return Array.from({ length: 1000 }, () => event())
        if (
          !quiet &&
          filter.topics[2] === event().topics[2] &&
          filter.topics[3] === event().topics[3]
        ) {
          const log = event()
          if (wrongId) log.topics[1] = H(999)
          return [log]
        }
        return []
      }
      throw new Error(`Unexpected ${method}`)
    },
  }
  return { client, calls }
}

test('bounded candidate receipt replays exact PoolId and five pair filters', async () => {
  const out = temp(),
    { client, calls } = rpc()
  const result = await collect({ client, fromBlock: 100, toBlock: 101, out, stat })
  assert.equal(result.candidates, 1)
  assert.deepEqual(verify({ out }), {
    status: 'present',
    receipts: 1,
    candidates: 1,
    coverage: {
      classification: 'contiguous',
      fromBlock: 100,
      toBlock: 101,
      gaps: [],
      overlaps: [],
      ranges: [{ fromBlock: 100, toBlock: 101 }],
    },
  })
  const r = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(r.candidates[0].poolId, id.toLowerCase())
  assert.equal(r.candidates[0].fee, fee)
  assert.equal(r.chunks.length, 5)
  assert.equal(calls.filter((c) => c.method === 'eth_getLogs').length, 5)
  assert.match(r.caveat, /no route, TVL, liquidity, depth/)
  await assert.rejects(collect({ client, fromBlock: 100, toBlock: 101, out, stat }))
})
test('quiet ranges retain headers and all five explicit pair queries', async () => {
  const out = temp(),
    { client } = rpc({ quiet: true })
  const r = await collect({ client, fromBlock: 100, toBlock: 165, out, stat })
  assert.equal(r.candidates, 0)
  const saved = JSON.parse(readFileSync(r.path, 'utf8'))
  assert.equal(saved.chunks.length, 10)
  assert.deepEqual(verify({ out }), {
    status: 'present',
    receipts: 1,
    candidates: 0,
    coverage: {
      classification: 'contiguous',
      fromBlock: 100,
      toBlock: 165,
      gaps: [],
      overlaps: [],
      ranges: [{ fromBlock: 100, toBlock: 165 }],
    },
  })
})
test('missing and empty receipt directories are not a verified zero-candidate scan', () => {
  const empty = temp()
  assert.deepEqual(verify({ out: join(empty, 'absent') }), {
    status: 'absent',
    receipts: 0,
    candidates: null,
    coverage: null,
  })
  assert.deepEqual(verify({ out: empty }), {
    status: 'empty',
    receipts: 0,
    candidates: null,
    coverage: null,
  })
})
test('exploratory receipts disclose contiguous, gapped, and overlapping coverage', async () => {
  const out = temp(),
    { client } = rpc({ quiet: true })
  await collect({ client, fromBlock: 100, toBlock: 101, out, stat })
  await collect({ client, fromBlock: 102, toBlock: 103, out, stat })
  assert.equal(verify({ out }).coverage.classification, 'contiguous')
  await collect({ client, fromBlock: 106, toBlock: 107, out, stat })
  assert.deepEqual(verify({ out }).coverage.gaps, [{ fromBlock: 104, toBlock: 105 }])
  assert.equal(verify({ out }).coverage.classification, 'gapped')
  await collect({ client, fromBlock: 107, toBlock: 108, out, stat })
  assert.deepEqual(verify({ out }).coverage.overlaps, [{ fromBlock: 107, toBlock: 107 }])
  assert.equal(verify({ out }).coverage.classification, 'gapped-and-overlapping')
})
test('rejects wrong PoolId, hash drift, potentially truncated pages and reserve breach', async () => {
  for (const option of [{ wrongId: true }, { drift: true }, { truncated: true }]) {
    const out = temp(),
      { client } = rpc(option)
    await assert.rejects(collect({ client, fromBlock: 100, toBlock: 101, out, stat }))
    assert.equal(readdirSync(out).length, 0)
  }
  const { client } = rpc()
  await assert.rejects(
    collect({
      client,
      fromBlock: 100,
      toBlock: 101,
      out: temp(),
      stat: () => ({ bavail: 1, bsize: 4096 }),
    }),
    /Disk reserve/,
  )
})
test('rejects unbounded ranges before RPC', async () => {
  const { client, calls } = rpc()
  await assert.rejects(
    collect({ client, fromBlock: 100, toBlock: 100 + MAX_BLOCKS, out: temp(), stat }),
  )
  assert.equal(calls.length, 0)
})
test('offline replay rejects PoolKey tamper even with recomputed receipt hash', async () => {
  const out = temp(),
    { client } = rpc()
  const result = await collect({ client, fromBlock: 100, toBlock: 101, out, stat })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  saved.chunks[0].logs[0].topics[1] = H(999)
  const { sha256: _old, ...plain } = saved
  saved.sha256 = sha(plain)
  writeFileSync(result.path, `${JSON.stringify(saved)}\n`)
  assert.throws(() => verify({ out }))
})
