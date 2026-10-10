import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SOURCE } from './aave-governance-queue-watch.mjs'
import {
  projectVerifiedGovernanceJournal,
  readFactualGovernanceNotices,
} from './aave-governance-factual-notices.mjs'

const h = (n) => `0x${n.toString(16).padStart(64, '0')}`
const firstTime = '2026-09-28T01:00:01.000Z'
const secondTime = '2026-09-28T02:00:01.000Z'
const snapshot = (block, lifecycle = 'queued', changes = {}) => ({
  payloadId: 7,
  block,
  blockHash: h(block),
  timestamp: block * 10,
  blockCloseOnly: true,
  lifecycle,
  queuedAt: 1000,
  delay: 300,
  earliestExecutableAt: 1301,
  earliestExecutableAtBasis: 'reference_code_unattested',
  executionEligibility: 'unclassified_code_unattested',
  reserveImpact: 'unclassified',
  capIntent: 'unknown',
  ...changes,
})
const event = {
  kind: 'PayloadQueued',
  payloadId: '7',
  block: 100,
  blockHash: h(100),
  timestamp: 1000,
  txHash: h(500),
  txIndex: 0,
  logIndex: 0,
  firstObservedAt: '2026-09-28T01:00:00.000Z',
}
const complete = (from, to, time, changes = {}) => ({
  source: SOURCE,
  status: 'complete',
  receiptVersion: 2,
  from,
  to,
  firstObservedAt: time.replace('01.000Z', '00.000Z'),
  localFeatureAvailableAt: time,
  fromHash: h(from),
  toHash: h(to),
  fromCodeSha256: 'a'.repeat(64),
  toCodeSha256: 'a'.repeat(64),
  fromPayloadsCount: 8,
  toPayloadsCount: 8,
  events: [],
  snapshots: [],
  frontierSnapshots: [snapshot(to)],
  openSetCoverage: 'observed_payloads_only',
  ...changes,
})
const first = complete(100, 101, firstTime, {
  events: [event],
  snapshots: [snapshot(100)],
  firstObservedAt: event.firstObservedAt,
})
const second = complete(102, 103, secondTime, {
  frontierSnapshots: [snapshot(103, 'executed')],
})
const seal = (record, previousSha256 = null) => {
  const value = { ...record, previousSha256 }
  return { ...value, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
}

test('repeated frontier snapshots yield one factual candidate with first feature time', () => {
  const result = projectVerifiedGovernanceJournal({ entries: [first, second] })
  assert.equal(result.candidates.length, 1)
  const notice = result.candidates[0]
  assert.equal(notice.payloadId, '7')
  assert.equal(notice.firstLocalFeatureAvailableAt, firstTime)
  assert.equal(notice.firstQueuedLocalFeatureAvailableAt, firstTime)
  assert.equal(notice.latestLocalFeatureAvailableAt, secondTime)
  assert.equal(notice.latestObservedState.lifecycle, 'executed')
  assert.equal(notice.latestObservedState.blockHash, h(103))
  assert.deepEqual(notice.sourceEvents, [
    {
      kind: event.kind,
      block: event.block,
      blockHash: event.blockHash,
      timestamp: event.timestamp,
      txHash: event.txHash,
      txIndex: event.txIndex,
      logIndex: event.logIndex,
    },
  ])
  assert.equal(notice.queuedAt, 1000)
  assert.equal(notice.earliestExecutableAt, 1301)
  assert.equal(notice.earliestExecutableAtBasis, 'reference_code_unattested')
  assert.equal(notice.executionEligibility, 'unclassified_code_unattested')
  assert.equal(notice.reserveImpact, 'unclassified')
  assert.equal(notice.exitImpact, 'unclassified')
  assert.equal(notice.notificationEnabled, false)
  assert.equal(result.coverage.status, 'observed_payloads_only')
  assert.equal(result.coverage.globalQuietClaimEligible, false)
  assert.equal(result.notificationEnabled, false)
})

test('queue timing starts at first local queued feature, not earlier creation observation', () => {
  const created = complete(100, 101, firstTime, {
    frontierSnapshots: [snapshot(101, 'created', { queuedAt: 0, earliestExecutableAt: null })],
  })
  const queued = complete(102, 103, secondTime)
  const atCreation = projectVerifiedGovernanceJournal({ entries: [created] }).candidates[0]
  assert.equal(atCreation.firstLocalFeatureAvailableAt, firstTime)
  assert.equal(atCreation.firstQueuedLocalFeatureAvailableAt, null)
  assert.equal(atCreation.earliestExecutableAt, null)
  const afterQueue = projectVerifiedGovernanceJournal({ entries: [created, queued] }).candidates[0]
  assert.equal(afterQueue.firstLocalFeatureAvailableAt, firstTime)
  assert.equal(afterQueue.firstQueuedLocalFeatureAvailableAt, secondTime)
  assert.equal(afterQueue.earliestExecutableAt, 1301)
})

test('empty and failed journals expose unavailable coverage, never quiet', () => {
  const empty = projectVerifiedGovernanceJournal({ entries: [] })
  assert.deepEqual(empty.candidates, [])
  assert.equal(empty.coverage.status, 'unavailable')
  assert.equal(empty.coverage.reason, 'empty_journal')
  const failed = projectVerifiedGovernanceJournal({
    entries: [
      first,
      {
        status: 'provider_failure',
        from: 102,
        to: 103,
      },
    ],
  })
  assert.equal(failed.candidates.length, 1)
  assert.equal(failed.coverage.status, 'unavailable')
  assert.equal(failed.coverage.reason, 'provider_failure')
  assert.equal(failed.coverage.globalQuietClaimEligible, false)
})

test('projection rejects clock, chain-state, queue-timing, and event chronology inconsistencies', () => {
  const bad = [
    [first, { ...second, localFeatureAvailableAt: '2026-09-28T00:59:59.000Z' }],
    [
      first,
      {
        ...second,
        frontierSnapshots: [
          snapshot(103, 'created', {
            queuedAt: 0,
            earliestExecutableAt: null,
          }),
        ],
      },
    ],
    [
      first,
      {
        ...second,
        frontierSnapshots: [snapshot(103, 'queued', { queuedAt: 999, earliestExecutableAt: 1300 })],
      },
    ],
    [{ ...first, frontierSnapshots: [snapshot(101, 'queued', { earliestExecutableAt: 1300 })] }],
    [{ ...first, snapshots: [], frontierSnapshots: [] }],
    [
      {
        ...first,
        frontierSnapshots: [snapshot(101, 'queued', { timestamp: 1000 })],
        snapshots: [snapshot(101, 'queued', { timestamp: 1001 })],
      },
    ],
  ]
  for (const entries of bad) assert.throws(() => projectVerifiedGovernanceJournal({ entries }))
})

test('reader verifies SHA-chained journal before projection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aave-factual-notices-'))
  const path = join(dir, 'journal.jsonl')
  try {
    const sealed = seal(first)
    writeFileSync(path, `${JSON.stringify(sealed)}\n`)
    const result = readFactualGovernanceNotices(path)
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0].firstLocalFeatureAvailableAt, firstTime)
    writeFileSync(path, `${JSON.stringify({ ...sealed, to: 102 })}\n`)
    assert.throws(() => readFactualGovernanceNotices(path), /Journal chain mismatch/)
    const contradictory = seal({
      ...first,
      snapshots: [snapshot(100, 'queued', { blockHash: h(999) })],
    })
    writeFileSync(path, `${JSON.stringify(contradictory)}\n`)
    assert.throws(() => readFactualGovernanceNotices(path), /pinned (snapshot|event)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
