import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
} from 'viem'
import { ABI, CONTROLLER } from './aave-payload-lifecycle-collector.mjs'
import { readJournal, run } from './aave-governance-queue-watch.mjs'
const runMock = (options) => run({ ...options, checkDisk: () => {} })

const h = (n) => `0x${n.toString(16).padStart(64, '0')}`
const creator = '0x1111111111111111111111111111111111111111'
const action = {
  target: '0x2222222222222222222222222222222222222222',
  withDelegateCall: false,
  accessLevel: 1,
  value: 0n,
  signature: 'execute()',
  callData: '0x',
}
function fixture() {
  let finalized = 101,
    failLogs = false,
    drift = false,
    requests = 0,
    blockReads = [],
    delay = 300,
    createdCountDelta = 0,
    stateAtFrontier = 2
  const log = {
    address: CONTROLLER,
    blockNumber: '0x64',
    blockHash: h(100),
    transactionHash: h(500),
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
    topics: encodeEventTopics({ abi: ABI, eventName: 'PayloadQueued' }),
    data: encodeAbiParameters([{ name: 'payloadId', type: 'uint40' }], [7n]),
  }
  const client = {
    async getBlock({ blockNumber, blockTag }) {
      const n = blockTag === 'finalized' ? finalized : Number(blockNumber)
      blockReads.push(n)
      return { number: BigInt(n), hash: h(drift && n === 101 ? 999 : n), timestamp: BigInt(n * 10) }
    },
    async request({ method, params }) {
      requests++
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getCode') return '0x6001'
      if (method === 'eth_getStorageAt') return h(0)
      if (method === 'eth_getLogs') {
        if (failLogs) throw new Error('private RPC URL')
        const q = params[0]
        return Number(BigInt(q.fromBlock)) <= 100 && Number(BigInt(q.toBlock)) >= 100 ? [log] : []
      }
      if (method === 'eth_call') {
        const functionName = decodeFunctionData({ abi: ABI, data: params[0].data }).functionName
        if (functionName === 'getPayloadsCount')
          return encodeFunctionResult({
            abi: ABI,
            functionName,
            result: BigInt(params[1].blockHash === h(99) ? 8 : 8 + createdCountDelta),
          })
        assert.equal(functionName, 'getPayloadById')
        return encodeFunctionResult({
          abi: ABI,
          functionName: 'getPayloadById',
          result: {
            creator,
            maximumAccessLevelRequired: 1,
            state: params[1].blockHash === h(100) ? 2 : stateAtFrontier,
            createdAt: 900,
            queuedAt: 1000,
            executedAt: 0,
            cancelledAt: 0,
            expirationTime: 2000,
            delay,
            gracePeriod: 600,
            actions: [action],
          },
        })
      }
      throw new Error(`Unexpected ${method}`)
    },
  }
  return {
    client,
    setFinalized: (n) => {
      finalized = n
    },
    fail: () => {
      failLogs = true
    },
    recover: () => {
      failLogs = false
    },
    setDelay: (value) => {
      delay = value
    },
    setCountDelta: (value) => {
      createdCountDelta = value
    },
    setFrontierState: (value) => {
      stateAtFrontier = value
    },
    drift: () => {
      drift = true
    },
    get requests() {
      return requests
    },
    get blockReads() {
      return blockReads
    },
  }
}

function reseal(entry) {
  const record = { ...entry }
  delete record.sha256
  return { ...record, sha256: createHash('sha256').update(JSON.stringify(record)).digest('hex') }
}

test('prospective receipt pins event, code, getter, observation time and earliest permission', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-queue-')), 'ledger.jsonl')
  const r = await runMock({
    path,
    client: f.client,
    fromBlock: 100,
    maxBlocks: 2,
    now: () => '2026-09-28T01:00:00.000Z',
  })
  assert.equal(r.status, 'complete')
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].firstObservedAt, '2026-09-28T01:00:00.000Z')
  assert.equal(r.receiptVersion, 2)
  assert.equal(r.localFeatureAvailableAt, '2026-09-28T01:00:00.000Z')
  assert.equal(r.snapshots[0].earliestExecutableAt, 1301)
  assert.equal(r.snapshots[0].lifecycle, 'queued')
  assert.equal(r.snapshots[0].executionEligibility, 'unclassified_code_unattested')
  assert.equal(r.frontierSnapshots.length, 1)
  assert.equal(r.snapshots[0].capIntent, 'unknown')
  assert.equal(r.snapshots[0].reserveImpact, 'unclassified')
  assert.equal(r.snapshots[0].blockCloseOnly, true)
  assert.match(r.snapshots[0].controllerCodeSha256, /^[a-f0-9]{64}$/)
  assert.equal(readJournal(path).nextBlock, 102)
})

test('local feature availability is captured only after the final canonical recheck', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-clock-order-')), 'ledger.jsonl')
  let calls = 0
  const r = await runMock({
    path,
    client: f.client,
    fromBlock: 100,
    maxBlocks: 2,
    now: () => {
      calls++
      if (calls === 2) assert.deepEqual(f.blockReads.slice(-2), [100, 101])
      return calls === 1 ? '2026-09-28T01:00:00.000Z' : '2026-09-28T01:00:01.000Z'
    },
  })
  assert.equal(r.status, 'complete')
  assert.equal(calls, 2)
  assert.equal(r.localFeatureAvailableAt, '2026-09-28T01:00:01.000Z')
  assert.equal(readJournal(path).entries[0].localFeatureAvailableAt, r.localFeatureAvailableAt)
})

test('invalid or regressing completion clocks seal only failure receipts', async () => {
  for (const completion of ['not-a-time', '2026-09-28T00:59:59.999Z']) {
    const f = fixture(),
      path = join(mkdtempSync(join(tmpdir(), 'aave-clock-invalid-')), 'ledger.jsonl')
    let calls = 0
    const r = await runMock({
      path,
      client: f.client,
      fromBlock: 100,
      maxBlocks: 2,
      now: () => {
        calls++
        return calls === 1
          ? '2026-09-28T01:00:00.000Z'
          : calls === 2
            ? completion
            : '2026-09-28T01:00:02.000Z'
      },
    })
    assert.equal(r.status, 'provider_failure')
    assert.equal(r.failedStage, 'feature_availability_clock')
    assert.equal(r.events, undefined)
    assert.equal(r.localFeatureAvailableAt, undefined)
    assert.equal(readJournal(path).nextBlock, 100)
  }
})

test('readJournal rejects resealed completion-clock tampering and legacy clockless receipts', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-clock-tamper-')), 'ledger.jsonl')
  await runMock({
    path,
    client: f.client,
    fromBlock: 100,
    maxBlocks: 2,
    now: () => '2026-09-28T01:00:00.000Z',
  })
  const original = JSON.parse(readFileSync(path, 'utf8'))
  for (const clock of [undefined, 'NaN', '2026-09-28T00:59:59.999Z']) {
    const edited = { ...original, localFeatureAvailableAt: clock }
    writeFileSync(path, `${JSON.stringify(reseal(edited))}\n`)
    assert.throws(() => readJournal(path), /local feature clock invalid/)
  }
  const legacy = { ...original }
  delete legacy.receiptVersion
  delete legacy.localFeatureAvailableAt
  writeFileSync(path, `${JSON.stringify(reseal(legacy))}\n`)
  assert.throws(() => readJournal(path), /local feature clock invalid/)
  const earlyEvent = {
    ...original,
    events: [{ ...original.events[0], firstObservedAt: '2020-01-01T00:00:00.000Z' }],
  }
  writeFileSync(path, `${JSON.stringify(reseal(earlyEvent))}\n`)
  assert.throws(() => readJournal(path), /invalid event coordinate/)
  const contradictory = {
    ...original,
    snapshots: [{ ...original.snapshots[0], blockHash: h(999) }],
  }
  writeFileSync(path, `${JSON.stringify(reseal(contradictory))}\n`)
  assert.throws(() => readJournal(path), /Event-block snapshot differs from pinned event/)
})

test('zero delay remains queued at the exact threshold', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-eligible-')), 'ledger.jsonl')
  f.setDelay(0)
  const r = await runMock({ path, client: f.client, fromBlock: 100, maxBlocks: 2 })
  assert.equal(r.snapshots[0].earliestExecutableAt, 1001)
  assert.equal(r.snapshots[0].lifecycle, 'queued')
  assert.equal(r.snapshots[0].state, 2)
  assert.equal(r.snapshots[0].executedAt, 0)
  assert.equal(r.frontierSnapshots[0].referenceThresholdPassed, true)
  assert.equal(r.frontierSnapshots[0].lifecycle, 'queued')
  assert.equal(r.frontierSnapshots[0].executionEligibility, 'unclassified_code_unattested')
})

test('pinned payload counter mismatch prevents frontier advance', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-count-')), 'ledger.jsonl')
  f.setCountDelta(1)
  const r = await runMock({ path, client: f.client, fromBlock: 100, maxBlocks: 2 })
  assert.equal(r.status, 'provider_failure')
  assert.equal(r.failedStage, 'creation_reconcile')
  assert.equal(readJournal(path).nextBlock, 100)
})

test('silent close is rechecked at frontier and no longer carried as queued', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-silent-')), 'ledger.jsonl')
  f.setFrontierState(5)
  const first = await runMock({ path, client: f.client, fromBlock: 100, maxBlocks: 2 })
  assert.equal(first.frontierSnapshots[0].lifecycle, 'expired')
  f.setFinalized(102)
  const second = await runMock({ path, client: f.client, maxBlocks: 1 })
  assert.equal(second.status, 'complete')
  assert.equal(second.frontierSnapshots.length, 0)
})

test('disk floor stops before first RPC and write', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-disk-')), 'ledger.jsonl')
  await assert.rejects(
    run({
      path,
      client: f.client,
      fromBlock: 100,
      checkDisk: () => {
        throw new Error('Disk reserve below 2.5 GiB')
      },
    }),
    /Disk reserve/,
  )
  assert.equal(f.requests, 0)
  assert.equal(readJournal(path).entries.length, 0)
})

test('provider failure creates sealed gap receipt and retry advances exactly once', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-gap-')), 'ledger.jsonl')
  f.fail()
  const failed = await runMock({
    path,
    client: f.client,
    fromBlock: 100,
    maxBlocks: 2,
    now: () => '2026-09-28T01:00:00.000Z',
  })
  assert.equal(failed.status, 'provider_failure')
  assert.equal(failed.failedStage, 'logs')
  assert.ok(!readFileSync(path, 'utf8').includes('private RPC URL'))
  assert.equal(readJournal(path).nextBlock, 100)
  f.recover()
  const good = await runMock({ path, client: f.client, fromBlock: 100, maxBlocks: 2 })
  assert.equal(good.status, 'complete')
  assert.equal(readJournal(path).entries.length, 2)
  assert.equal(readJournal(path).nextBlock, 102)
})

test('failure receipts require a valid local failure clock and never contain feature clocks', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-failure-clock-')), 'ledger.jsonl')
  f.fail()
  const failed = await runMock({
    path,
    client: f.client,
    fromBlock: 100,
    maxBlocks: 2,
    now: () => '2026-09-28T01:00:00.000Z',
  })
  assert.equal(failed.status, 'provider_failure')
  const original = JSON.parse(readFileSync(path, 'utf8'))
  for (const failedAt of [undefined, 'not-a-time']) {
    writeFileSync(path, `${JSON.stringify(reseal({ ...original, failedAt }))}\n`)
    assert.throws(() => readJournal(path), /Failure receipt invalid/)
  }
  writeFileSync(
    path,
    `${JSON.stringify(reseal({ ...original, localFeatureAvailableAt: original.failedAt }))}\n`,
  )
  assert.throws(() => readJournal(path), /Failure receipt invalid/)
  writeFileSync(
    path,
    `${JSON.stringify(reseal({ ...original, firstObservedAt: original.failedAt }))}\n`,
  )
  assert.throws(() => readJournal(path), /Failure receipt invalid/)
})

test('canonical boundary drift is explicit and never advances frontier', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-reorg-')), 'ledger.jsonl')
  await runMock({ path, client: f.client, fromBlock: 100, maxBlocks: 2 })
  f.setFinalized(102)
  f.drift()
  const conflict = await runMock({ path, client: f.client, maxBlocks: 1 })
  assert.equal(conflict.status, 'canonical_conflict')
  assert.equal(readJournal(path).nextBlock, 102)
})

test('tampering and overlapping range are rejected before RPC', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-tamper-')), 'ledger.jsonl')
  await runMock({ path, client: f.client, fromBlock: 100, maxBlocks: 2 })
  const calls = f.requests
  await assert.rejects(runMock({ path, client: f.client, fromBlock: 100 }), /frontier/)
  assert.equal(f.requests, calls)
  const raw = readFileSync(path, 'utf8').replace('queued', 'eligible')
  writeFileSync(path, raw)
  assert.throws(() => readJournal(path), /chain mismatch/)
})

test('source identity mismatch is rejected even if a record is rehashed', async () => {
  const f = fixture(),
    path = join(mkdtempSync(join(tmpdir(), 'aave-source-')), 'ledger.jsonl')
  await runMock({ path, client: f.client, fromBlock: 100, maxBlocks: 2 })
  const entry = JSON.parse(readFileSync(path, 'utf8'))
  entry.source.controller = '0x3333333333333333333333333333333333333333'
  const record = { ...entry }
  delete record.sha256
  entry.sha256 = createHash('sha256').update(JSON.stringify(record)).digest('hex')
  writeFileSync(path, `${JSON.stringify(entry)}\n`)
  assert.throws(() => readJournal(path), /source identity mismatch/)
})
