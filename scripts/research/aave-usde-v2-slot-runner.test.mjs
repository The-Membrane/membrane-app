import test from 'node:test'
import assert from 'node:assert/strict'
import { createPgV2SlotStore, runAaveUsdeV2Slot } from './aave-usde-v2-slot-runner.mjs'

const manifestSha = 'a'.repeat(64)
const slotId = 'aave-v3-usde:2026-09-29T12:00:00.000Z'
const prior = '11111111-1111-4111-8111-111111111111'
const inserted = '22222222-2222-4222-8222-222222222222'
const state = {
  block: 26_000_000n,
  instantUsd: 10_000_000,
  coolingUsd: null,
  strandedUsd: null,
  params: {
    read_block_pinned: true,
    read_block_finalized: true,
    read_block_number: '26000000',
    read_block_hash: `0x${'a'.repeat(64)}`,
  },
}

function fixture(overrides = {}) {
  const calls = []
  const store = {
    async start() {
      calls.push('start_committed')
    },
    async predecessor() {
      calls.push('predecessor')
      return prior
    },
    async success(_manifest, _slot, _state, predecessor) {
      calls.push('atomic_success')
      assert.equal(predecessor, prior)
      return inserted
    },
    async finish(_manifest, _slot, status, reason) {
      calls.push(`finish:${status}`)
      assert.ok(reason)
    },
    ...overrides,
  }
  const read = async () => {
    calls.push('rpc_read')
    return state
  }
  return { calls, store, read }
}

test('committed start precedes RPC, predecessor and atomic success', async () => {
  const f = fixture()
  const result = await runAaveUsdeV2Slot({ manifestSha, slotId, store: f.store, read: f.read })
  assert.deepEqual(f.calls, ['start_committed', 'rpc_read', 'predecessor', 'atomic_success'])
  assert.deepEqual(result, { status: 'success', snapshotId: inserted, slotId })
})

test('uncommitted start cannot trigger RPC', async () => {
  let rejectStart
  const f = fixture({
    start: () =>
      new Promise((_resolve, reject) => {
        rejectStart = reject
      }),
  })
  const pending = runAaveUsdeV2Slot({ manifestSha, slotId, store: f.store, read: f.read })
  await Promise.resolve()
  assert.deepEqual(f.calls, [])
  rejectStart(new Error('commit failed'))
  await assert.rejects(pending, /commit failed/)
  assert.deepEqual(f.calls, [])
})

for (const label of ['duplicate', 'closed', 'unconfirmed']) {
  test(`${label} start rejection never reads or writes a terminal`, async () => {
    const f = fixture({
      start: async () => {
        throw new Error(label)
      },
    })
    await assert.rejects(
      runAaveUsdeV2Slot({ manifestSha, slotId, store: f.store, read: f.read }),
      new RegExp(label),
    )
    assert.deepEqual(f.calls, [])
  })
}

test('RPC failure produces non-success terminal and surfaces failure', async () => {
  const f = fixture()
  await assert.rejects(
    runAaveUsdeV2Slot({
      manifestSha,
      slotId,
      store: f.store,
      read: async () => {
        f.calls.push('rpc_read')
        throw new Error('rpc timeout')
      },
    }),
    /rpc timeout/,
  )
  assert.deepEqual(f.calls, ['start_committed', 'rpc_read', 'finish:read_failure'])
})

test('partial source cannot be called successful', async () => {
  const f = fixture()
  await assert.rejects(
    runAaveUsdeV2Slot({
      manifestSha,
      slotId,
      store: f.store,
      read: async () => ({ ...state, instantUsd: null }),
    }),
    /incomplete_finalized_usde_read/,
  )
  assert.deepEqual(f.calls, ['start_committed', 'finish:read_failure'])
})

test('atomic rejection produces insert_failure, never a success result', async () => {
  const f = fixture({
    success: async () => {
      f.calls.push('atomic_rejected')
      throw new Error('skipped_recent')
    },
  })
  await assert.rejects(
    runAaveUsdeV2Slot({ manifestSha, slotId, store: f.store, read: f.read }),
    /skipped_recent/,
  )
  assert.deepEqual(f.calls, [
    'start_committed',
    'rpc_read',
    'predecessor',
    'atomic_rejected',
    'finish:insert_failure',
  ])
})

test('terminal write rejection reports both failures', async () => {
  const f = fixture({
    finish: async () => {
      throw new Error('database offline')
    },
  })
  await assert.rejects(
    runAaveUsdeV2Slot({
      manifestSha,
      slotId,
      store: f.store,
      read: async () => {
        throw new Error('rpc timeout')
      },
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  )
})

test('invalid identity is rejected before any dependency call', async () => {
  const f = fixture()
  await assert.rejects(
    runAaveUsdeV2Slot({ manifestSha: 'bad', slotId, store: f.store, read: f.read }),
    /invalid_v2_slot_identity/,
  )
  assert.deepEqual(f.calls, [])
})

test('predecessor read uses the narrow database function', async () => {
  const statements = []
  const store = createPgV2SlotStore(async (strings) => {
    statements.push(strings.join('?'))
    return [{ id: prior }]
  })
  assert.equal(await store.predecessor(), prior)
  assert.match(statements[0], /public\.aave_usde_v2_atomic_predecessor\(\)/)
  assert.doesNotMatch(statements[0], /FROM public\.venue_snapshots/)
})
