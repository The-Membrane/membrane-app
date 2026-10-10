import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAbiItem, toEventHash } from 'viem'
import {
  loadMorphoFlowSubjects,
  planRange,
  classifyFlowEvent,
  normalizeFlowLogs,
  collectFlowInterval,
  captureSubjects,
  orderSubjectsByCursor,
  summarizeCursorFreshness,
  compareCombinedLogs,
  safeFailureCode,
} from './record-carry-morpho-v2-flows.mjs'

const vault = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const h = (n) => `0x${n.toString(16).padStart(64, '0')}`
const subject = { vault, asset, manifestSha256: 'a'.repeat(64) }
const cursor = { last_block: '100', last_hash: h(100) }
const finalized = { number: 104n, hash: h(104) }
const topics = {
  deposit: toEventHash(
    parseAbiItem(
      'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
    ),
  ),
  withdraw: toEventHash(
    parseAbiItem(
      'event Withdraw(address indexed sender,address indexed receiver,address indexed onBehalf,uint256 assets,uint256 shares)',
    ),
  ),
  force: toEventHash(
    parseAbiItem(
      'event ForceDeallocate(address indexed sender,address adapter,uint256 assets,address indexed onBehalf,bytes32[] ids,uint256 penaltyAssets)',
    ),
  ),
}
const log = (kind, block = 101n, receiver = vault, tx = h(500)) => ({
  address: vault,
  blockNumber: block,
  blockHash: h(Number(block)),
  transactionHash: tx,
  transactionIndex: 2,
  logIndex: kind === 'deposit' ? 4 : 5,
  topics: [topics[kind]],
  data: '0x1234',
  args: { sender: asset, onBehalf: asset, receiver, assets: 123n, shares: 456n },
})
function client({ logs = [[], [], [], []], failAt = null, changedEnd = false } = {}) {
  let logCall = 0,
    endCalls = 0
  return {
    getChainId: async () => 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === 'finalized')
        return { number: 104n, hash: h(104), timestamp: BigInt(Math.floor(Date.now() / 1000)) }
      if (failAt === blockNumber) throw new Error('rpc_failure')
      if (blockNumber === 104n) endCalls++
      return {
        number: blockNumber,
        hash: changedEnd && blockNumber === 104n && endCalls > 1 ? h(999) : h(Number(blockNumber)),
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      }
    },
    getLogs: async () => logs[logCall++],
  }
}

test('exact manifest maps 49 factory vaults to the displayed route subjects without duplicate contracts', async () => {
  const subjects = await loadMorphoFlowSubjects()
  assert.equal(subjects.length, 49)
  assert.equal(new Set(subjects.map((x) => x.vault)).size, 49)
  assert.ok(subjects.every((x) => x.routeKeys.length > 0))
  assert.ok(subjects.every((x) => x.routeKeys.every((key) => key.includes('→ VaultV2 ['))))
  assert.ok(subjects.every((x) => x.manifestSha256 === subjects[0].manifestSha256))
})

test('range starts exactly after cursor, caps at 512, and requires a hash', () => {
  assert.deepEqual(planRange(cursor, 104n), { fromBlock: 101n, toBlock: 104n, priorHash: h(100) })
  assert.equal(planRange(cursor, 100n), null)
  assert.equal(planRange(cursor, 99n), null)
  assert.equal(planRange(cursor, 9999n).toBlock, 612n)
  assert.throws(() => planRange({ ...cursor, last_hash: '0x0' }, 102n))
})

test('withdraw to the vault remains raw but is internal; other receiver is unreconciled', () => {
  assert.equal(classifyFlowEvent('withdraw', vault, vault, true), 'internal_force_deallocate')
  assert.equal(classifyFlowEvent('withdraw', vault, vault, false), 'internal_vault_receiver')
  assert.equal(classifyFlowEvent('withdraw', asset, vault, true), 'external_receiver_unreconciled')
  const rows = normalizeFlowLogs(
    vault,
    [log('deposit')],
    [log('withdraw')],
    [log('force')],
    101n,
    104n,
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[1].assets_raw, '123')
  assert.equal(rows[1].shares_raw, '456')
  assert.equal(rows[1].owner, asset)
  assert.equal(rows[1].receiver, vault)
  assert.equal(rows[1].flow_class, 'internal_force_deallocate')
  assert.equal(rows[1].transaction_hash, h(500))
  assert.equal(rows[1].log_index, 5)
  assert.throws(
    () => normalizeFlowLogs(vault, [log('deposit'), log('deposit')], [], [], 101n, 104n),
    /duplicate_flow_log/,
  )
})

test('quiet interval has a full finalized range receipt and zero events', async () => {
  const payload = await collectFlowInterval(client(), subject, cursor, finalized)
  assert.equal(payload.fromBlock, '101')
  assert.equal(payload.toBlock, '104')
  assert.equal(payload.priorHash, h(100))
  assert.equal(payload.toHash, h(104))
  assert.equal(payload.finalizedHeadBlock, '104')
  assert.equal(payload.finalizedHeadHash, h(104))
  assert.match(payload.combinedSetSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(payload.events, [])
  assert.match(payload.payloadSha256, /^[0-9a-f]{64}$/)
  const replay = await collectFlowInterval(client(), subject, cursor, finalized)
  assert.deepEqual(replay, payload)
})

test('backlog receipt retains the sampled finalized head beyond its bounded end', async () => {
  const payload = await collectFlowInterval(client(), subject, cursor, {
    number: 9999n,
    hash: h(9999),
  })
  assert.equal(payload.toBlock, '612')
  assert.equal(payload.toHash, h(612))
  assert.equal(payload.finalizedHeadBlock, '9999')
  assert.equal(payload.finalizedHeadHash, h(9999))
})

test('hash disagreement and partial RPC failure reject before persistence', async () => {
  await assert.rejects(
    collectFlowInterval(client({ changedEnd: true }), subject, cursor, finalized),
    /range_hash_changed/,
  )
  await assert.rejects(
    collectFlowInterval(client({ failAt: 100n }), subject, cursor, finalized),
    /rpc_failure/,
  )
  await assert.rejects(
    collectFlowInterval(client(), subject, cursor, { number: 104n, hash: h(999) }),
    /finalized_head_hash_changed/,
  )
})

test('combined-topic query detects a missing individual stream', async () => {
  const deposit = log('deposit')
  assert.throws(() => compareCombinedLogs([deposit], [], [], []), /combined_topic_disagreement/)
  assert.match(compareCombinedLogs([deposit], [], [], [deposit]), /^[0-9a-f]{64}$/)
  await assert.rejects(
    collectFlowInterval(client({ logs: [[deposit], [], [], []] }), subject, cursor, finalized),
    /combined_topic_disagreement/,
  )
})

test('CLI failure output never includes a credentialed RPC error', () => {
  const leaked = new Error('https://user:supersecret@rpc.example/failure')
  assert.equal(safeFailureCode(leaked), 'morpho_flow_recorder_failed')
  assert.equal(
    safeFailureCode(new Error('morpho_flow_prior_hash_changed')),
    'morpho_flow_prior_hash_changed',
  )
})

test('capture never calls persistence after a missing range response', async () => {
  const subjects = Array.from({ length: 49 }, (_, i) => ({
    ...subject,
    vault: `0x${(i + 1).toString(16).padStart(40, '0')}`,
  }))
  const rows = subjects.map((s) => ({ vault: s.vault, last_block: '100', last_hash: h(100) }))
  const calls = []
  const sql = (strings) => {
    calls.push(strings.join(''))
    return Promise.resolve(rows)
  }
  await assert.rejects(captureSubjects(sql, client({ failAt: 100n }), subjects), /rpc_failure/)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /SELECT vault, last_block/)
})

test('oldest cursors take priority after a timed run and freshness reports lag', () => {
  const early = { vault: `0x${'a'.repeat(40)}` }
  const late = { vault: `0x${'b'.repeat(40)}` }
  const cursors = new Map([
    [early.vault, { last_block: '200', last_hash: h(200) }],
    [late.vault, { last_block: '100', last_hash: h(100) }],
  ])
  assert.deepEqual(orderSubjectsByCursor([early, late], cursors), [late, early])
  assert.deepEqual(summarizeCursorFreshness(cursors, [early, late], 220n), {
    cursorFreshness: 'lagging', caughtUp: 0, staleSubjectCount: 2,
    maxLagBlocks: '120', totalLagBlocks: '140',
  })
})

test('bounded capture persists consecutive ranges and reports remaining lag', async () => {
  const subjects = Array.from({ length: 49 }, (_, i) => ({
    ...subject, vault: `0x${(i + 1).toString(16).padStart(40, '0')}`,
  }))
  const rows = subjects.map((s) => ({ vault: s.vault, last_block: '100', last_hash: h(100) }))
  const saved = []
  const sql = (strings, encoded) => {
    if (strings.join('').includes('SELECT vault')) return Promise.resolve(rows)
    saved.push(JSON.parse(encoded))
    return Promise.resolve([{ inserted: true }])
  }
  const fakeClient = {
    getChainId: async () => 1,
    getBlock: async ({ blockTag, blockNumber }) =>
      blockTag === 'finalized'
        ? { number: 1140n, hash: h(1140), timestamp: BigInt(Math.floor(Date.now() / 1000)) }
        : { number: blockNumber, hash: h(Number(blockNumber)),
            timestamp: BigInt(Math.floor(Date.now() / 1000)) },
    getLogs: async () => [],
  }
  const result = await captureSubjects(sql, fakeClient, subjects, Date.now(), {
    maxIntervalsPerSubject: 2, timeBudgetMs: 60_000,
  })
  assert.equal(result.recorded, 98)
  assert.equal(result.maxLagBlocks, '16')
  assert.equal(result.staleSubjectCount, 49)
  assert.equal(result.cursorFreshness, 'lagging')
  for (const s of subjects) {
    const intervals = saved.filter((row) => row.vault === s.vault)
    assert.deepEqual(intervals.map((row) => [row.fromBlock, row.toBlock]),
      [['101', '612'], ['613', '1124']])
  }
})
