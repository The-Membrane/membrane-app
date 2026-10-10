import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics } from 'viem'
import {
  ABI,
  chunks,
  collect,
  configuredPools,
  decodeRampLog,
  normalizeEvents,
  summarize,
  validateResume,
} from './curve-ramp-event-census.mjs'

const A = '0x390f3595bCa2Df7d23783dFd126427CCeb997BF4'
const B = '0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E'
const pools = [
  { address: A, name: 'USDT' },
  { address: B, name: 'USDC' },
]
const tx = (digit) => `0x${digit.repeat(64)}`
function log(address, type, block, index) {
  const isRamp = type === 'RampA'
  const args = isRamp ? [500n, 2000n, 1_000n, 2_000n] : [500n, 1_000n]
  return {
    address,
    blockNumber: BigInt(block),
    logIndex: BigInt(index),
    transactionHash: tx(isRamp ? 'a' : 'b'),
    topics: encodeEventTopics({ abi: ABI, eventName: type }),
    data: encodeAbiParameters(Array(args.length).fill({ type: 'uint256' }), args),
  }
}

test('bounded, inclusive chunk pagination', () => {
  assert.deepEqual(chunks(10, 20, 4), [
    { fromBlock: 10, toBlock: 13 },
    { fromBlock: 14, toBlock: 17 },
    { fromBlock: 18, toBlock: 20 },
  ])
  assert.throws(() => chunks(10, 20, 50_001), /Invalid bounded/)
  assert.throws(() => chunks(20, 10, 4), /Invalid bounded/)
})

test('two configured pools and deployed ABI decoder preserve exact event args', () => {
  assert.deepEqual(
    configuredPools([
      { name: 'scrvUSD', enabled: true, depthMarkets: pools.map((p) => ({ ...p, enabled: true })) },
    ]),
    pools,
  )
  const ramp = decodeRampLog(log(A, 'RampA', 11, 2), 3_000, A)
  assert.deepEqual(ramp, {
    pool: A,
    type: 'RampA',
    block: 11,
    logIndex: 2,
    txHash: tx('a'),
    timestamp: 3_000,
    args: { old_A: '500', new_A: '2000', initial_time: '1000', future_time: '2000' },
  })
  assert.deepEqual(decodeRampLog(log(B, 'StopRampA', 12, 0), 3_100, B).args, {
    A: '500',
    t: '1000',
  })
  assert.throws(() => decodeRampLog(log(A, 'RampA', 11, 2), 3_000, B), /Pool mismatch/)
})

test('deduplication and per-pool summary are deterministic', () => {
  const one = decodeRampLog(log(A, 'RampA', 11, 2), 3_000, A)
  const two = decodeRampLog(log(B, 'StopRampA', 12, 0), 3_100, B)
  assert.deepEqual(normalizeEvents([two, one, one]), [one, two])
  assert.deepEqual(summarize([one, two], pools), {
    total: 2,
    byPool: { [A]: { RampA: 1, StopRampA: 0 }, [B]: { RampA: 0, StopRampA: 1 } },
  })
  assert.throws(() => normalizeEvents([one, { ...one, timestamp: 4_000 }]), /Conflicting duplicate/)
})

test('partial artifact resumes after a failed pool read without skipping its chunk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curve-ramp-census-test-'))
  const out = join(dir, 'census.json')
  const calls = []
  let fail = true
  const client = {
    async getLogs({ address, fromBlock, toBlock }) {
      calls.push([address, Number(fromBlock), Number(toBlock)])
      if (fail && Number(fromBlock) === 12 && address === B) throw new Error('temporary RPC error')
      if (address === A && Number(fromBlock) === 10) return [log(A, 'RampA', 10, 0)]
      if (address === B && Number(fromBlock) === 12) return [log(B, 'StopRampA', 12, 1)]
      return []
    },
    async getBlock({ blockNumber }) {
      return { timestamp: BigInt(3_000 + Number(blockNumber)) }
    },
  }
  try {
    await assert.rejects(
      collect({ client, pools, from: 10, to: 13, chunkBlocks: 2, out }),
      /temporary RPC error/,
    )
    assert.equal(JSON.parse(readFileSync(out)).nextChunk, 1)
    fail = false
    const result = await collect({ client, pools, from: 10, to: 13, chunkBlocks: 2, out })
    assert.equal(result.status, 'complete')
    assert.equal(result.nextChunk, 2)
    assert.equal(result.summary.total, 2)
    assert.equal(calls.filter((x) => x[1] === 10).length, 2, 'first chunk was not reread')
    assert.throws(() => validateResume(result, { ...result, from: 9 }), /does not match/)
    assert.throws(
      () => validateResume({ ...result, nextChunk: 1, status: 'partial' }, result),
      /outside completed chunks/,
    )
    assert.throws(
      () => validateResume({ ...result, summary: { total: 3 } }, result),
      /summary mismatch/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
