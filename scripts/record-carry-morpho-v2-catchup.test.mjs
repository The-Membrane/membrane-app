import test from 'node:test'
import assert from 'node:assert/strict'

import {
  captureSubjects,
  summarizeCursorFreshness,
} from './record-carry-morpho-v2-flows.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const vaults = Array.from({ length: 49 }, (_, i) =>
  `0x${(i + 1).toString(16).padStart(40, '0')}`,
)
const subjects = vaults.map((vault) => ({
  vault,
  asset: `0x${'2'.repeat(40)}`,
  manifestSha256: 'a'.repeat(64),
}))

function harness({ start = 100n, head = 1683n, failAtWrite = null } = {}) {
  const cursors = new Map(vaults.map((vault) => [vault, {
    vault,
    last_block: start.toString(),
    last_hash: hash(start),
  }]))
  const receipts = []
  let writes = 0
  const sql = (strings, ...values) => {
    if (strings.join('').includes('SELECT vault, last_block'))
      return Promise.resolve([...cursors.values()].map((cursor) => ({ ...cursor })))
    const payload = JSON.parse(values[0])
    writes++
    if (writes === failAtWrite) return Promise.reject(new Error('database_failure'))
    const cursor = cursors.get(payload.vault)
    assert.equal(payload.fromBlock, (BigInt(cursor.last_block) + 1n).toString())
    assert.equal(payload.priorHash, cursor.last_hash)
    assert.ok(BigInt(payload.toBlock) - BigInt(payload.fromBlock) < 512n)
    cursor.last_block = payload.toBlock
    cursor.last_hash = payload.toHash
    receipts.push(payload)
    return Promise.resolve([{ inserted: true }])
  }
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      const number = blockTag === 'finalized' ? head : blockNumber
      return {
        number,
        hash: hash(number),
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      }
    },
    getLogs: async () => [],
  }
  return { sql, client, cursors, receipts }
}

test('four bounded passes close a 1,583-block backlog for all 49 vaults', async () => {
  const { sql, client, cursors, receipts } = harness()
  const result = await captureSubjects(sql, client, subjects)
  assert.equal(result.recorded, 49 * 4)
  assert.equal(result.cursorFreshness, 'aligned')
  assert.equal(result.caughtUp, 49)
  assert.equal(result.staleSubjectCount, 0)
  assert.equal(result.maxLagBlocks, '0')
  assert.equal(result.budgetExhausted, false)
  assert.equal(receipts.length, 49 * 4)
  assert.ok([...cursors.values()].every((cursor) => cursor.last_block === '1683'))
  assert.deepEqual(
    receipts.filter((r) => r.vault === vaults[0]).map((r) => [r.fromBlock, r.toBlock]),
    [['101', '612'], ['613', '1124'], ['1125', '1636'], ['1637', '1683']],
  )
})

test('a one-pass limit reports lag despite successful quiet receipts', async () => {
  const { sql, client } = harness()
  const result = await captureSubjects(sql, client, subjects, Date.now(), {
    maxIntervalsPerSubject: 1,
  })
  assert.equal(result.recorded, 49)
  assert.equal(result.eventCount, 0)
  assert.equal(result.cursorFreshness, 'lagging')
  assert.equal(result.caughtUp, 0)
  assert.equal(result.staleSubjectCount, 49)
  assert.equal(result.maxLagBlocks, '1071')
  assert.equal(result.totalLagBlocks, String(49 * 1071))
})

test('time budget stops before starting another interval and exposes partial lag', async () => {
  const { sql, client, receipts } = harness()
  let ticks = 0
  const result = await captureSubjects(sql, client, subjects, Date.now(), {
    timeBudgetMs: 8,
    clock: () => ticks++,
  })
  assert.equal(result.recorded, 7)
  assert.equal(result.budgetExhausted, true)
  assert.equal(result.cursorFreshness, 'lagging')
  assert.equal(receipts.length, 7)
  assert.equal(result.staleSubjectCount, 49)
})

test('database failure leaves a missing interval unsealed for a later run', async () => {
  const { sql, client, cursors, receipts } = harness({ failAtWrite: 2 })
  await assert.rejects(captureSubjects(sql, client, subjects), /database_failure/)
  assert.equal(receipts.length, 1)
  assert.equal(cursors.get(vaults[0]).last_block, '612')
  assert.equal(cursors.get(vaults[1]).last_block, '100')
})

test('cursor freshness validates every subject rather than counting zero events', () => {
  const cursors = new Map(vaults.map((vault) => [vault, {
    last_block: '100', last_hash: hash(100),
  }]))
  assert.equal(summarizeCursorFreshness(cursors, subjects, 100n).cursorFreshness, 'aligned')
  cursors.get(vaults[0]).last_hash = '0x0'
  assert.throws(() => summarizeCursorFreshness(cursors, subjects, 100n), /invalid_morpho_flow_cursor/)
})
