import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  toEventSelector,
  toHex,
} from 'viem'
import {
  ABS_SELECTOR,
  CAP_ABI,
  CHUNK_BLOCKS,
  REL_SELECTOR,
  SELECTOR_TOPICS,
  SUBMIT,
  TOPIC0,
  classify,
  collect,
  decodeCapCall,
  decodeSubmit,
  proposals,
  ranges,
  summary,
} from './morpho-v2-cap-submit-census.mjs'

const vault = '0x1111111111111111111111111111111111111111'
const txHash = `0x${'a'.repeat(64)}`
const blockHash = `0x${'b'.repeat(64)}`
const idData = '0x1234'
const allocationId = keccak256(idData)
const absData = encodeFunctionData({
  abi: CAP_ABI,
  functionName: 'increaseAbsoluteCap',
  args: [idData, 100n],
})
const relData = encodeFunctionData({
  abi: CAP_ABI,
  functionName: 'increaseRelativeCap',
  args: [idData, 10n ** 18n],
})

function rawSubmit(data = absData, block = 11, index = 0, executableAt = 22_600n) {
  const selector = data.slice(0, 10)
  return {
    address: vault,
    blockNumber: toHex(block),
    blockHash,
    transactionIndex: '0x0',
    transactionHash: txHash,
    logIndex: toHex(index),
    topics: encodeEventTopics({ abi: [SUBMIT], eventName: 'Submit', args: { selector } }),
    data: encodeAbiParameters([{ type: 'bytes' }, { type: 'uint256' }], [data, executableAt]),
  }
}

function event(data = absData, index = 0, executableAt = 22_600n) {
  return decodeSubmit(rawSubmit(data, 11, index, executableAt), 1000)
}

function fakeClient({ supply = 1n, oldCap = 0n, abdicated = false } = {}) {
  return {
    async readContract({ functionName, blockNumber }) {
      assert.equal(blockNumber, 10n)
      if (functionName === 'totalSupply') return supply
      if (functionName === 'abdicated') return abdicated
      return oldCap
    },
  }
}

test('official topics and bounded inclusive ranges', () => {
  assert.equal(toEventSelector(SUBMIT).toLowerCase(), TOPIC0)
  assert.equal(ABS_SELECTOR, '0xf6f98fd5')
  assert.equal(REL_SELECTOR, '0x2438525b')
  assert.deepEqual(
    SELECTOR_TOPICS,
    [ABS_SELECTOR, REL_SELECTOR].map((x) => `0x${x.slice(2).padEnd(64, '0')}`),
  )
  assert.deepEqual(ranges(10, 20, 4), [
    { fromBlock: 10, toBlock: 13 },
    { fromBlock: 14, toBlock: 17 },
    { fromBlock: 18, toBlock: 20 },
  ])
  assert.throws(() => ranges(10, 20, CHUNK_BLOCKS + 1), /Invalid bounded/)
})

test('exact calldata decoding rejects noncanonical trailing data and clusters selector pair', () => {
  const decoded = decodeCapCall(event())
  assert.deepEqual(decoded, { kind: 'absolute', allocationId, idData, proposedCap: '100' })
  assert.equal(decodeCapCall(event(`${absData}00`)), null)
  const arbitrary = rawSubmit(ABS_SELECTOR)
  const retained = decodeSubmit(arbitrary, 1000)
  assert.equal(retained.data, ABS_SELECTOR)
  assert.equal(decodeCapCall(retained), null)
  const a = event(absData, 0),
    b = event(relData, 1)
  assert.deepEqual(
    proposals(
      [a, b],
      [
        { class: 'eligible', allocationId, leadSeconds: 21_600 },
        { class: 'eligible', allocationId, leadSeconds: 21_600 },
      ],
    )[0].rawEventIndexes,
    [0, 1],
  )
  assert.equal(
    proposals(
      [a, b],
      [
        { class: 'eligible', allocationId },
        { class: 'non-increasing', allocationId },
      ],
    )[0].class,
    'mixed-eligible',
  )
})

test('pre-submit eligibility distinguishes short lead, abdicated, no-op, unfunded and mint', async () => {
  const noLogs = async () => []
  const pause = async () => {}
  assert.equal(
    (await classify(event(absData, 0, 1000n), fakeClient(), noLogs, 0, pause)).class,
    'short-lead',
  )
  assert.equal(
    (await classify(event(), fakeClient({ abdicated: true }), noLogs, 0, pause)).class,
    'abdicated',
  )
  assert.equal(
    (await classify(event(), fakeClient({ oldCap: 100n }), noLogs, 0, pause)).class,
    'non-increasing',
  )
  assert.equal(
    (await classify(event(), fakeClient({ supply: 0n }), noLogs, 0, pause)).class,
    'unfunded',
  )
  const transfer = {
    blockNumber: '0xb',
    blockHash,
    transactionIndex: '0x0',
    logIndex: '0x0',
    topics: [
      toEventSelector('Transfer(address,address,uint256)'),
      `0x${'0'.repeat(64)}`,
      `0x${'0'.repeat(24)}${'2'.repeat(40)}`,
    ],
    data: toHex(2n, { size: 32 }),
  }
  const minted = await classify(
    event(absData, 1),
    fakeClient({ supply: 0n }),
    async () => [transfer],
    0,
    pause,
  )
  assert.equal(minted.class, 'eligible')
  assert.equal(minted.preState.supplyAtSubmit, '2')
  const ambiguous = await classify(
    event(absData, 1),
    fakeClient(),
    async () => [{ ...transfer, topics: [toEventSelector('Abdicate(bytes4)')] }],
    0,
    pause,
  )
  assert.equal(ambiguous.class, 'ambiguous')
  assert.equal(
    (
      await classify(
        event(absData, 1),
        fakeClient({ oldCap: 100n }),
        async () => [
          {
            ...transfer,
            topics: [toEventSelector('DecreaseAbsoluteCap(address,bytes32,bytes,uint256)')],
          },
        ],
        0,
        pause,
      )
    ).class,
    'ambiguous',
  )
})

test('global topic-filtered pagination, immutable cohort intersection and checkpoint resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-submit-test-'))
  const out = join(dir, 'cap.json')
  const calls = []
  let fail = true
  const client = {
    ...fakeClient(),
    async getChainId() {
      return 1
    },
    async getBlock() {
      return { hash: blockHash, timestamp: 1000n }
    },
  }
  const rpcRead = async (method, [filter]) => {
    assert.equal(method, 'eth_getLogs')
    if (!filter.address) {
      calls.push([filter.fromBlock, filter.toBlock])
      assert.deepEqual(filter.topics, [TOPIC0, SELECTOR_TOPICS])
      if (filter.fromBlock === '0xc' && fail) throw new Error('secret-url')
      return filter.fromBlock === '0xa' ? [rawSubmit()] : []
    }
    return []
  }
  try {
    await assert.rejects(
      collect({
        client,
        rpcRead,
        out,
        vaults: new Set([vault]),
        from: 10,
        to: 13,
        chunkBlocks: 2,
        retries: 0,
        pause: async () => {},
      }),
      /RPC read failed/,
    )
    let saved = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(saved.coverage.throughBlock, 11)
    assert.equal(saved.rawEvents.length, 1)
    fail = false
    saved = await collect({
      client,
      rpcRead,
      out,
      vaults: new Set([vault]),
      from: 10,
      to: 13,
      chunkBlocks: 2,
      retries: 0,
      pause: async () => {},
    })
    assert.deepEqual(calls, [
      ['0xa', '0xb'],
      ['0xc', '0xd'],
      ['0xc', '0xd'],
    ])
    assert.equal(saved.status, 'complete')
    assert.equal(saved.coverage.complete, true)
    const rawPath = `${out}.raw.json`
    const rawBytes = readFileSync(rawPath)
    assert.equal(saved.rawArtifactSha256, createHash('sha256').update(rawBytes).digest('hex'))
    await collect({
      client,
      rpcRead,
      out,
      vaults: new Set([vault]),
      from: 10,
      to: 13,
      chunkBlocks: 2,
      retries: 0,
      pause: async () => {},
    })
    assert.deepEqual(readFileSync(rawPath), rawBytes)
    writeFileSync(rawPath, '{}')
    await assert.rejects(
      collect({
        client,
        rpcRead,
        out,
        vaults: new Set([vault]),
        from: 10,
        to: 13,
        chunkBlocks: 2,
        retries: 0,
        pause: async () => {},
      }),
      /Frozen raw snapshot mismatch/,
    )
    assert.equal(saved.summary.eligibleProposalCount, 1)
    assert.equal(saved.summary.followThroughPermitted, false)
    assert.equal(
      summary([event()], [{ class: 'eligible' }], [{ class: 'eligible', timestamp: 1000 }])
        .preregisteredMinimum,
      20,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('independence counts earliest same-vault proposal in each fixed seven-day window', () => {
  const day = 24 * 3600
  const grouped = [
    { vault, timestamp: 1000, block: 1, qualifyingLegCount: 1, class: 'eligible' },
    { vault, timestamp: 1000 + 6 * day, block: 2, qualifyingLegCount: 1, class: 'eligible' },
    { vault, timestamp: 1000 + 8 * day, block: 3, qualifyingLegCount: 1, class: 'eligible' },
    {
      vault: '0x2222222222222222222222222222222222222222',
      timestamp: 1000,
      block: 4,
      qualifyingLegCount: 1,
      class: 'eligible',
    },
  ]
  const counted = summary([], [], grouped)
  assert.equal(counted.eligibleProposalCount, 4)
  assert.equal(counted.independentEligibleCount, 3)
  assert.deepEqual(counted.independentEligibleProposalIndexes, [0, 3, 2])
  assert.equal(counted.followThroughPermitted, false)
})
