import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
} from 'viem'
import {
  ABI,
  CONTROLLER,
  END_BLOCK,
  TOPICS,
  decodeLifecycle,
  digest,
  loadCheckpoint,
  run,
  validateCheckpoint,
} from './aave-payload-lifecycle-collector.mjs'

const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const CREATOR = '0x1111111111111111111111111111111111111111'
const TARGET = '0x2222222222222222222222222222222222222222'
const action = {
  target: TARGET,
  withDelegateCall: false,
  accessLevel: 1,
  value: 0n,
  signature: 'execute()',
  callData: '0x',
}
const createdAbi = ABI.find((item) => item.name === 'PayloadCreated')
const creation = (block, txIndex, logIndex) => ({
  address: CONTROLLER,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: H(block),
  transactionHash: H(100 + logIndex),
  transactionIndex: `0x${txIndex.toString(16)}`,
  logIndex: `0x${logIndex.toString(16)}`,
  removed: false,
  topics: encodeEventTopics({
    abi: ABI,
    eventName: 'PayloadCreated',
    args: { payloadId: 0n, creator: CREATOR, maximumAccessLevelRequired: 1 },
  }),
  data: encodeAbiParameters(
    createdAbi.inputs.filter((input) => !input.indexed),
    [[action]],
  ),
})
const simple = (kind, block, txIndex, logIndex) => ({
  address: CONTROLLER,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: H(block),
  transactionHash: H(100 + logIndex),
  transactionIndex: `0x${txIndex.toString(16)}`,
  logIndex: `0x${logIndex.toString(16)}`,
  removed: false,
  topics: encodeEventTopics({ abi: ABI, eventName: kind }),
  data: encodeAbiParameters([{ name: 'payloadId', type: 'uint40' }], [0n]),
})
function fixture({
  missing = false,
  badChain = false,
  firstOffset = 1,
  payloadsCount = 1,
  omittedKind = null,
  failFinal = false,
} = {}) {
  const first = END_BLOCK - (omittedKind ? 2 : firstOffset)
  const actual =
    omittedKind === 'PayloadQueued'
      ? [creation(first, 0, 0), simple('PayloadQueued', END_BLOCK, 0, 0)]
      : omittedKind === 'PayloadCancelled'
        ? [creation(first, 0, 0), simple('PayloadCancelled', END_BLOCK, 0, 0)]
        : omittedKind === 'PayloadExecuted'
          ? [
              creation(first, 0, 0),
              simple('PayloadQueued', END_BLOCK - 1, 0, 0),
              simple('PayloadExecuted', END_BLOCK, 0, 0),
            ]
          : [
              creation(first, 0, 0),
              simple('PayloadQueued', first, 1, 1),
              simple('PayloadCancelled', END_BLOCK, 0, 0),
            ]
  const raw = actual.filter(
    (log) =>
      !omittedKind ||
      !(
        log.topics[0] ===
        TOPICS[
          ['PayloadCreated', 'PayloadQueued', 'PayloadCancelled', 'PayloadExecuted'].indexOf(
            omittedKind,
          )
        ]
      ),
  )
  let calls = 0
  let fail = missing
  let reorgBlock = null
  const client = {
    async getBlock({ blockNumber }) {
      const block = Number(blockNumber)
      return {
        number: BigInt(block),
        hash: H(block === reorgBlock ? block + 1 : block),
        timestamp: BigInt(block),
      }
    },
    async request({ method, params }) {
      calls++
      if (method === 'eth_chainId') return badChain ? '0x89' : '0x1'
      if (method === 'eth_getCode') {
        const block = Number(BigInt(params[1].blockHash))
        return block >= first ? '0x6001' : '0x'
      }
      if (method === 'eth_getStorageAt') return H(0)
      if (method === 'eth_getLogs') {
        assert.deepEqual(params[0].topics, [TOPICS])
        const low = Number(BigInt(params[0].fromBlock)),
          high = Number(BigInt(params[0].toBlock))
        return raw.filter(
          (log) =>
            Number(BigInt(log.blockNumber)) >= low && Number(BigInt(log.blockNumber)) <= high,
        )
      }
      if (method === 'eth_call') {
        const call = decodeFunctionData({ abi: ABI, data: params[0].data })
        if (call.functionName === 'getPayloadsCount')
          return encodeFunctionResult({
            abi: ABI,
            functionName: 'getPayloadsCount',
            result: BigInt(payloadsCount),
          })
        if (fail) throw new Error('mock secret RPC URL')
        const block = Number(BigInt(params[1].blockHash))
        if (failFinal && block === END_BLOCK) throw new Error('mock final RPC secret')
        const truth = actual.filter((log) => Number(BigInt(log.blockNumber)) <= block)
        const last = truth.at(-1)
        const state =
          last?.topics[0] === TOPICS[3]
            ? 3
            : last?.topics[0] === TOPICS[2]
              ? 4
              : last?.topics[0] === TOPICS[1]
                ? 2
                : 1
        const queued = actual.find((log) => log.topics[0] === TOPICS[1])
        return encodeFunctionResult({
          abi: ABI,
          functionName: 'getPayloadById',
          result: {
            creator: CREATOR,
            maximumAccessLevelRequired: 1,
            state,
            createdAt: first,
            queuedAt:
              queued && Number(BigInt(queued.blockNumber)) <= block
                ? Number(BigInt(queued.blockNumber))
                : 0,
            executedAt: state === 3 ? END_BLOCK : 0,
            cancelledAt: state === 4 ? END_BLOCK : 0,
            expirationTime: first + 35 * 86400,
            delay: 86400,
            gracePeriod: 7 * 86400,
            actions: [action],
          },
        })
      }
      throw new Error('Unexpected method ' + method)
    },
  }
  return {
    client,
    first,
    get calls() {
      return calls
    },
    allowReads() {
      fail = false
    },
    allowFinalReads() {
      failFinal = false
    },
    denyFinalReads() {
      failFinal = true
    },
    reorgAt(block) {
      reorgBlock = block
    },
  }
}

test('four official event topics are unique and creation keeps ordered raw actions', () => {
  assert.equal(new Set(TOPICS).size, 4)
  const f = fixture()
  const log = decodeLifecycle(creation(f.first, 0, 0), f.first, END_BLOCK, {
    block: f.first,
    hash: H(f.first),
    timestamp: f.first,
  })
  assert.equal(log.kind, 'PayloadCreated')
  assert.equal(log.payloadId, '0')
  assert.deepEqual(log.actions, [{ ...action, value: '0' }])
  for (const kind of ['PayloadQueued', 'PayloadCancelled', 'PayloadExecuted']) {
    assert.equal(
      decodeLifecycle(simple(kind, f.first, 1, 1), f.first, END_BLOCK, {
        block: f.first,
        hash: H(f.first),
        timestamp: f.first,
      }).kind,
      kind,
    )
  }
  assert.throws(() =>
    decodeLifecycle({ ...creation(f.first, 0, 0), topics: [H(999)] }, f.first, END_BLOCK, {
      block: f.first,
      hash: H(f.first),
      timestamp: f.first,
    }),
  )
})

test('resume rejects canonical boundary drift before another log request', async () => {
  const f = fixture({ firstOffset: 2_001 })
  const out = join(mkdtempSync(join(tmpdir(), 'payload-reorg-')), 'checkpoint.json')
  await run({ out, client: f.client, maxCodeSteps: 50, checkDisk: () => {} })
  const before = await run({ out, client: f.client, maxNewChunks: 1, checkDisk: () => {} })
  assert.equal(before.status, 'partial')
  assert.equal(before.nextBlock, END_BLOCK - 1)
  f.reorgAt(END_BLOCK - 2)
  await assert.rejects(
    run({ out, client: f.client, maxNewChunks: 1, checkDisk: () => {} }),
    /Resume canonical boundary changed/,
  )
  assert.equal(loadCheckpoint(out).nextBlock, END_BLOCK - 1)
})

test('disk guard is before chain-id RPC and refuses all writes', async () => {
  const f = fixture()
  const out = join(mkdtempSync(join(tmpdir(), 'payload-guard-')), 'checkpoint.json')
  await assert.rejects(
    run({
      out,
      client: f.client,
      maxCodeSteps: 1,
      checkDisk: () => {
        throw new Error('Disk reserve below 2.5 GiB')
      },
    }),
    /Disk reserve/,
  )
  assert.equal(f.calls, 0)
})

test('disk drop between RPC calls stops the active stage before the next request', async () => {
  const f = fixture()
  const out = join(mkdtempSync(join(tmpdir(), 'payload-midguard-')), 'checkpoint.json')
  let checks = 0
  await assert.rejects(
    run({
      out,
      client: f.client,
      maxCodeSteps: 1,
      checkDisk: () => {
        if (++checks > 3) throw new Error('Disk reserve below 2.5 GiB')
      },
    }),
    /Disk reserve/,
  )
  assert.equal(f.calls, 1) // chain ID only; the code probe's request was stopped
  assert.equal(existsSync(out), false)
})

test('disk drop during snapshots is not swallowed as a provider missing-read', async () => {
  const f = fixture()
  const out = join(mkdtempSync(join(tmpdir(), 'payload-snapshotguard-')), 'checkpoint.json')
  await run({ out, client: f.client, maxCodeSteps: 50, checkDisk: () => {} })
  const priorFrontier = loadCheckpoint(out).nextBlock
  const request = f.client.request.bind(f.client)
  let low = false
  f.client.request = async (args) => {
    const value = await request(args)
    if (args.method === 'eth_call') low = true
    return value
  }
  await assert.rejects(
    run({
      out,
      client: f.client,
      maxNewChunks: 1,
      checkDisk: () => {
        if (low) throw new Error('Disk reserve below 2.5 GiB')
      },
    }),
    /Disk reserve guard/,
  )
  assert.equal(loadCheckpoint(out).nextBlock, priorFrontier)
})

test('frozen-end payload counter must agree with the complete creation sequence', async () => {
  const f = fixture({ payloadsCount: 2 })
  const out = join(mkdtempSync(join(tmpdir(), 'payload-count-')), 'checkpoint.json')
  await run({ out, client: f.client, maxCodeSteps: 50, checkDisk: () => {} })
  await assert.rejects(
    run({ out, client: f.client, maxNewChunks: 1, checkDisk: () => {} }),
    /Pinned end payload count differs from created logs/,
  )
  assert.equal(loadCheckpoint(out).status, 'partial')
})

test('wrong chain refuses archive work', async () => {
  const f = fixture({ badChain: true })
  const out = join(mkdtempSync(join(tmpdir(), 'payload-chain-')), 'checkpoint.json')
  await assert.rejects(
    run({ out, client: f.client, maxCodeSteps: 1, checkDisk: () => {} }),
    /Ethereum mainnet/,
  )
  assert.equal(f.calls, 1)
})

test('resumable complete scan preserves same-block close semantics and all events', async () => {
  const f = fixture()
  const out = join(mkdtempSync(join(tmpdir(), 'payload-full-')), 'checkpoint.json')
  let result = await run({ out, client: f.client, maxCodeSteps: 3, checkDisk: () => {} })
  assert.equal(result.nextBlock, null)
  result = await run({ out, client: f.client, maxCodeSteps: 50, checkDisk: () => {} })
  assert.equal(result.deploymentBlock, f.first)
  result = await run({
    out,
    client: f.client,
    maxNewChunks: 1,
    maxFinalReads: 1,
    checkDisk: () => {},
  })
  assert.equal(result.status, 'complete')
  assert.equal(result.logCount, 3)
  assert.equal(result.payloadCount, 1)
  assert.equal(result.snapshotCount, 2)
  assert.equal(result.finalSnapshotCount, 1)
  const saved = loadCheckpoint(out)
  const [created, queued] = saved.chunks[0].logs
  assert.equal(created.block, queued.block)
  assert.equal(saved.chunks[0].snapshots[0].state, 2)
  assert.equal(saved.chunks[0].snapshots[0].blockCloseOnly, true)
  assert.equal(saved.chunks[0].snapshots[0].capIntent, 'unknown')
  assert.equal(saved.chunks[0].snapshots[1].state, 4)
  assert.deepEqual(validateCheckpoint(JSON.parse(readFileSync(out, 'utf8'))), saved)
})

test('missing pinned getter is explicit and retryable, never negative cap intent', async () => {
  const f = fixture({ missing: true })
  const out = join(mkdtempSync(join(tmpdir(), 'payload-retry-')), 'checkpoint.json')
  await run({ out, client: f.client, maxCodeSteps: 50, checkDisk: () => {} })
  let result = await run({ out, client: f.client, maxNewChunks: 1, checkDisk: () => {} })
  assert.equal(result.status, 'partial')
  assert.equal(result.missingReads, 2)
  const stored = JSON.stringify(loadCheckpoint(out))
  assert.ok(!stored.includes('mock secret'))
  f.allowReads()
  result = await run({
    out,
    client: f.client,
    maxRetries: 2,
    maxFinalReads: 1,
    checkDisk: () => {},
  })
  assert.equal(result.status, 'complete')
  assert.equal(result.missingReads, 0)
})

for (const omittedKind of ['PayloadQueued', 'PayloadCancelled', 'PayloadExecuted']) {
  test(`final pinned state detects omitted ${omittedKind} log`, async () => {
    const f = fixture({ omittedKind })
    const out = join(mkdtempSync(join(tmpdir(), 'payload-omitted-')), 'checkpoint.json')
    await run({ out, client: f.client, maxCodeSteps: 50, checkDisk: () => {} })
    const scanned = await run({ out, client: f.client, maxNewChunks: 1, checkDisk: () => {} })
    assert.equal(scanned.status, 'partial')
    assert.equal(scanned.endPayloadsCount, 1)
    await assert.rejects(
      run({ out, client: f.client, maxFinalReads: 1, checkDisk: () => {} }),
      /Final pinned getter\/lifecycle mismatch/,
    )
    assert.equal(loadCheckpoint(out).status, 'partial')
    assert.equal(loadCheckpoint(out).finalSnapshots.length, 0)
  })
}

test('interrupted final getter reads resume without hiding missingness', async () => {
  const f = fixture()
  const out = join(mkdtempSync(join(tmpdir(), 'payload-final-retry-')), 'checkpoint.json')
  await run({ out, client: f.client, maxCodeSteps: 50, checkDisk: () => {} })
  await run({ out, client: f.client, maxNewChunks: 1, checkDisk: () => {} })
  f.denyFinalReads()
  let result = await run({ out, client: f.client, maxFinalReads: 1, checkDisk: () => {} })
  assert.equal(result.status, 'partial')
  assert.equal(result.finalSnapshotCount, 1)
  assert.equal(result.finalMissingReads, 1)
  assert.ok(!JSON.stringify(loadCheckpoint(out)).includes('mock final RPC secret'))
  f.allowFinalReads()
  result = await run({ out, client: f.client, maxFinalReads: 1, checkDisk: () => {} })
  assert.equal(result.status, 'complete')
  assert.equal(result.finalMissingReads, 0)
})

test('SHA seal, order, metadata, and unique log coordinates are checked', async () => {
  const f = fixture()
  const out = join(mkdtempSync(join(tmpdir(), 'payload-corrupt-')), 'checkpoint.json')
  await run({ out, client: f.client, maxCodeSteps: 50, checkDisk: () => {} })
  await run({ out, client: f.client, maxNewChunks: 1, checkDisk: () => {} })
  const raw = JSON.parse(readFileSync(out, 'utf8'))
  const mutate = (fn) => {
    const copy = structuredClone(raw)
    fn(copy.payload)
    copy.payload.chunks[0].logsSha256 = digest(copy.payload.chunks[0].logs)
    copy.payload.chunks[0].snapshotsSha256 = digest(copy.payload.chunks[0].snapshots)
    copy.sha256 = digest(copy.payload)
    return copy
  }
  assert.throws(() => validateCheckpoint({ ...raw, sha256: '0'.repeat(64) }), /SHA/)
  assert.throws(
    () =>
      validateCheckpoint(
        mutate((p) => {
          p.chunks[0].logs[1].logIndex = 0
        }),
      ),
    /order|Duplicate/,
  )
  assert.throws(
    () =>
      validateCheckpoint(
        mutate((p) => {
          p.chunks[0].logs[0].blockHash = H(7)
        }),
      ),
    /metadata|mismatch/,
  )
  assert.throws(
    () =>
      validateCheckpoint(
        mutate((p) => {
          p.chunks[0].snapshots[0].actions = []
        }),
      ),
    /Snapshot/,
  )
  assert.throws(
    () =>
      validateCheckpoint(
        mutate((p) => {
          for (const log of p.chunks[0].logs) log.payloadId = '1'
          for (const snap of p.chunks[0].snapshots) snap.payloadId = '1'
        }),
      ),
    /Missing created payload ID/,
  )
  assert.throws(
    () =>
      validateCheckpoint(
        mutate((p) => {
          p.chunks[0].logs[1].kind = 'PayloadExecuted'
          p.chunks[0].logs.pop()
          p.chunks[0].snapshots[0].state = 3
          p.chunks[0].snapshots[0].queuedAt = 0
          p.chunks[0].snapshots[0].executedAt = f.first
          p.chunks[0].snapshots.pop()
        }),
      ),
    /Invalid lifecycle transition/,
  )
})
