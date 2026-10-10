import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters } from 'viem'
import { AAVE_CORE_POOL_CONFIGURATOR } from './aave-direct-configurator-intent.mjs'
import { SOURCE } from './aave-governance-queue-watch.mjs'
import { projectAaveGovernanceIntentJournal } from './aave-governance-intent-projection.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const at = '2026-09-28T06:00:02.000Z'
const direct = {
  target: AAVE_CORE_POOL_CONFIGURATOR.toLowerCase(),
  withDelegateCall: false,
  accessLevel: 1,
  value: '0',
  signature: 'setBorrowCap(address,uint256)',
  callData: encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    ['0x1111111111111111111111111111111111111111', 100n],
  ),
}
const opaque = { ...direct, target: '0x2222222222222222222222222222222222222222' }

function event(kind, id, block, logIndex, actions) {
  return {
    kind,
    block,
    blockHash: hash(block),
    timestamp: block * 10,
    txHash: hash(block * 100 + logIndex),
    txIndex: 0,
    logIndex,
    payloadId: String(id),
    firstObservedAt: at,
    ...(actions ? { actions } : {}),
  }
}

function snapshot(id, block, lifecycle, actions) {
  return {
    payloadId: String(id),
    block,
    blockHash: hash(block),
    blockCloseOnly: true,
    lifecycle,
    actions,
  }
}

function complete({ from, to = from, startCount = 0, events = [], snapshots = [] }) {
  return {
    source: SOURCE,
    status: 'complete',
    receiptVersion: 2,
    from,
    to,
    firstObservedAt: at,
    localFeatureAvailableAt: '2026-09-28T06:00:05.000Z',
    fromHash: hash(from),
    toHash: hash(to),
    fromCodeSha256: 'a'.repeat(64),
    toCodeSha256: 'a'.repeat(64),
    fromPayloadsCount: startCount,
    toPayloadsCount: startCount + events.filter((e) => e.kind === 'PayloadCreated').length,
    events,
    snapshots,
    frontierSnapshots: [],
    openSetCoverage: 'observed_payloads_only',
  }
}

function journal(records) {
  const path = join(mkdtempSync(join(tmpdir(), 'aave-intent-')), 'receipt.jsonl')
  let previousSha256 = null
  const sealed = records.map((record) => {
    const value = { ...record, previousSha256 }
    const result = { ...value, sha256: digest(value) }
    previousSha256 = result.sha256
    return result
  })
  writeFileSync(path, `${sealed.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  return path
}

test('Created direct action is a candidate only at receipt completion time', () => {
  const created = event('PayloadCreated', 0, 100, 0, [direct])
  const rows = projectAaveGovernanceIntentJournal(
    journal([
      complete({
        from: 100,
        events: [created],
        snapshots: [snapshot(0, 100, 'created', [direct])],
      }),
    ]),
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'candidate')
  assert.equal(rows[0].localFeatureAvailableAt, '2026-09-28T06:00:05.000Z')
  assert.equal(rows[0].actions[0].intent.kind, 'borrow_cap')
  assert.equal(rows[0].actions[0].intent.direction, 'unknown')
  assert.equal(rows[0].alertEligible, false)
  assert.equal(rows[0].executableExitCapacity, 'not_inferred')
  assert.equal(JSON.stringify(rows).includes('firstObservedAt'), false)
})

test('Opaque and mixed ordered actions remain unknown, preserving syntax candidates', () => {
  for (const actions of [[opaque], [direct, opaque]]) {
    const rows = projectAaveGovernanceIntentJournal(
      journal([
        complete({
          from: 100,
          events: [event('PayloadCreated', 0, 100, 0, actions)],
          snapshots: [snapshot(0, 100, 'created', actions)],
        }),
      ]),
    )
    assert.equal(rows[0].status, 'unknown')
    assert.equal(rows[0].actions.at(-1).intent.status, 'unknown')
    if (actions.length === 2) assert.equal(rows[0].actions[0].intent.status, 'candidate')
  }
})

test('Queued candidate requires earlier observed Created and exact ordered getter actions', () => {
  const created = event('PayloadCreated', 0, 100, 0, [direct, opaque])
  const queued = event('PayloadQueued', 0, 101, 0)
  const records = [
    complete({
      from: 100,
      events: [created],
      snapshots: [snapshot(0, 100, 'created', [direct, opaque])],
    }),
    complete({
      from: 101,
      startCount: 1,
      events: [queued],
      snapshots: [snapshot(0, 101, 'queued', [direct, opaque])],
    }),
  ]
  const rows = projectAaveGovernanceIntentJournal(journal(records))
  assert.equal(rows[1].lifecycle, 'queued')
  assert.equal(rows[1].status, 'unknown') // Mixed actions are not a clean direct intent.
  assert.equal(rows[1].actions[0].intent.status, 'candidate')
  records[1].snapshots = [snapshot(0, 101, 'queued', [opaque, direct])]
  const mismatch = projectAaveGovernanceIntentJournal(journal(records))
  assert.equal(mismatch[1].reason, 'queued_actions_mismatch_created')
})

test('Queued single direct action is candidate with queue-block observation and no direction', () => {
  const rows = projectAaveGovernanceIntentJournal(
    journal([
      complete({
        from: 100,
        events: [event('PayloadCreated', 0, 100, 0, [direct])],
        snapshots: [snapshot(0, 100, 'created', [direct])],
      }),
      complete({
        from: 101,
        startCount: 1,
        events: [event('PayloadQueued', 0, 101, 0)],
        snapshots: [snapshot(0, 101, 'queued', [direct])],
      }),
    ]),
  )
  assert.equal(rows[1].status, 'candidate')
  assert.equal(rows[1].actions[0].intent.direction, 'unknown')
  assert.equal(rows[1].blockHash, hash(101))
})

test('Missing Created payload never becomes queued intent', () => {
  const rows = projectAaveGovernanceIntentJournal(
    journal([
      complete({
        from: 100,
        events: [event('PayloadQueued', 7, 100, 0)],
        snapshots: [snapshot(7, 100, 'queued', [direct])],
      }),
    ]),
  )
  assert.equal(rows[0].reason, 'created_payload_not_observed')
})

test('Created/getter mismatch cannot become a later queued candidate', () => {
  const rows = projectAaveGovernanceIntentJournal(
    journal([
      complete({
        from: 100,
        events: [event('PayloadCreated', 0, 100, 0, [direct])],
        snapshots: [snapshot(0, 100, 'created', [opaque])],
      }),
      complete({
        from: 101,
        startCount: 1,
        events: [event('PayloadQueued', 0, 101, 0)],
        snapshots: [snapshot(0, 101, 'queued', [direct])],
      }),
    ]),
  )
  assert.equal(rows[0].reason, 'created_actions_mismatch_getter')
  assert.equal(rows[1].reason, 'created_payload_not_observed')
})

test('Same-block terminal transition is unknown despite direct actions and getter state', () => {
  const created = event('PayloadCreated', 0, 100, 0, [direct])
  const queued = event('PayloadQueued', 0, 100, 1)
  const executed = event('PayloadExecuted', 0, 100, 2)
  const rows = projectAaveGovernanceIntentJournal(
    journal([
      complete({
        from: 100,
        events: [created, queued, executed],
        snapshots: [snapshot(0, 100, 'executed', [direct])],
      }),
    ]),
  )
  assert.equal(rows[0].reason, 'same_block_terminal_transition')
  assert.equal(rows[1].reason, 'same_block_terminal_transition')
})

test('Later cancellation inside one receipt cannot become a candidate at feature availability', () => {
  const rows = projectAaveGovernanceIntentJournal(
    journal([
      complete({
        from: 100,
        to: 101,
        events: [
          event('PayloadCreated', 0, 100, 0, [direct]),
          event('PayloadCancelled', 0, 101, 0),
        ],
        snapshots: [snapshot(0, 100, 'created', [direct])],
      }),
    ]),
  )
  assert.equal(rows[0].reason, 'terminal_before_feature_available')
  assert.equal(rows[0].alertEligible, false)
})

test('Created superseded by queue in one receipt is not active, but queue can be a candidate', () => {
  const rows = projectAaveGovernanceIntentJournal(
    journal([
      complete({
        from: 100,
        to: 101,
        events: [event('PayloadCreated', 0, 100, 0, [direct]), event('PayloadQueued', 0, 101, 0)],
        snapshots: [snapshot(0, 100, 'created', [direct]), snapshot(0, 101, 'queued', [direct])],
      }),
    ]),
  )
  assert.equal(rows[0].reason, 'superseded_by_queue_before_feature_available')
  assert.equal(rows[1].status, 'candidate')
})

test('Legacy, canonical conflict and corrupt receipts fail closed; retryable failure is ignored', () => {
  const good = complete({
    from: 100,
    events: [event('PayloadCreated', 0, 100, 0, [direct])],
    snapshots: [snapshot(0, 100, 'created', [direct])],
  })
  assert.throws(
    () => projectAaveGovernanceIntentJournal(journal([{ ...good, receiptVersion: 1 }])),
    /clock invalid/,
  )
  const failure = { source: SOURCE, from: 101, to: 101, status: 'provider_failure', failedAt: at }
  const recovered = complete({ from: 101, startCount: 1 })
  assert.equal(projectAaveGovernanceIntentJournal(journal([good, failure, recovered])).length, 1)
  assert.throws(
    () => projectAaveGovernanceIntentJournal(journal([failure])),
    /No verified complete/,
  )
  assert.throws(
    () =>
      projectAaveGovernanceIntentJournal(
        journal([good, { ...failure, status: 'canonical_conflict' }]),
      ),
    /canonical conflict/,
  )
  const path = journal([good])
  writeFileSync(path, 'not a sealed journal\n')
  assert.throws(() => projectAaveGovernanceIntentJournal(path))
})

test('Feature clock regression across complete receipts fails closed', () => {
  const created = complete({
    from: 100,
    events: [event('PayloadCreated', 0, 100, 0, [direct])],
    snapshots: [snapshot(0, 100, 'created', [direct])],
  })
  const queued = {
    ...complete({
      from: 101,
      startCount: 1,
      events: [event('PayloadQueued', 0, 101, 0)],
      snapshots: [snapshot(0, 101, 'queued', [direct])],
    }),
    localFeatureAvailableAt: '2026-09-28T06:00:03.000Z',
  }
  assert.throws(
    () => projectAaveGovernanceIntentJournal(journal([created, queued])),
    /feature clock regressed/,
  )
})
