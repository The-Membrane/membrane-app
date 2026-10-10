import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { recordLocalCarryExitV2Readbacks } from './localCarryExitV2Witness.mjs'
import {
  appendLocalCarryExitV2Record,
  CARRY_EXIT_V2_HORIZONS,
  CARRY_EXIT_V2_PREDECESSOR,
  verifyLocalCarryExitV2Ledger,
} from './localCarryExitV2Store.mjs'

const destination = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const holder = `0x${'3'.repeat(40)}`
const blockHash = `0x${'4'.repeat(64)}`
const issuedAt = '2026-10-07T10:00:00.000Z'

function rootFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'carry-exit-v2-witness-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'ledger')
}

function appendIssue(root) {
  const issuedMs = Date.parse(issuedAt)
  return appendLocalCarryExitV2Record(
    'issue',
    {
      issueId: 'local:morpho:episode-1:q:0',
      routeKey: 'USDC → VaultV2 [USDC]',
      destination,
      asset,
      decimals: 6,
      assetsRaw: '1000000',
      baselineStatus: 'success',
      baselineBlock: '123',
      baselineHash: blockHash,
      baselineBlockAtUtc: '2026-10-07T09:59:00.000Z',
      issuedAtUtc: issuedAt,
      proofEnvelope: { schema: 'fixture' },
      issueEnvelope: {
        schema: 'fixture',
        source: 'morpho',
        sourcePlan: { holder },
      },
      plan: CARRY_EXIT_V2_HORIZONS.map((horizonH) => ({
        horizonH,
        predecessorH: CARRY_EXIT_V2_PREDECESSOR[horizonH],
        conditionalRecovery: false,
        targetAtUtc: new Date(issuedMs + horizonH * 3_600_000).toISOString(),
        deadlineAtUtc: new Date(issuedMs + (horizonH + 2) * 3_600_000).toISOString(),
      })),
    },
    { root, now: issuedMs, minFreeBytes: 0 },
  )
}

test('reopens the durable ledger and records only a same-Mac local witness before H1', (t) => {
  const root = rootFor(t)
  const issue = appendIssue(root)
  let reads = 0
  const result = recordLocalCarryExitV2Readbacks({
    root,
    now: () => new Date('2026-10-07T10:05:00.000Z'),
    minFreeBytes: 0,
    verify: (options) => {
      reads += 1
      return verifyLocalCarryExitV2Ledger(options)
    },
  })
  assert.equal(reads >= 2, true)
  assert.deepEqual(result.counts, { witnessed_local_only: 1 })
  const state = verifyLocalCarryExitV2Ledger({ root })
  const readback = state.readbacks.get(issue.payload.issueId)
  assert.equal(readback.payload.issueSha256, issue.sha256)
  assert.equal(readback.payload.readbackProof.issueSha256, issue.sha256)
  assert.equal(readback.payload.readbackProof.provenance, 'same_machine_ledger_reopen')
  assert.equal(readback.payload.readbackProof.independentProcess, false)
  assert.equal(readback.payload.readbackProof.independentClock, false)
  assert.equal(readback.payload.readbackProof.independentServer, false)
  assert.equal(readback.payload.readbackProof.rollbackProof, false)
  assert.equal(result.independentTimestamp, false)
  assert.equal(result.independentWitness, false)
  assert.equal(result.forecastValidated, false)
})

test('late readback is retained as an honest gap and cannot be appended', (t) => {
  const root = rootFor(t)
  appendIssue(root)
  const result = recordLocalCarryExitV2Readbacks({
    root,
    now: () => new Date('2026-10-07T11:00:00.000Z'),
    minFreeBytes: 0,
  })
  assert.deepEqual(result.counts, { h1_elapsed: 1 })
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).readbacks.size, 0)
})

test('a changed issue SHA between scan and reopen is never witnessed', (t) => {
  const root = rootFor(t)
  const issue = appendIssue(root)
  const state = verifyLocalCarryExitV2Ledger({ root })
  let reads = 0
  let writes = 0
  const result = recordLocalCarryExitV2Readbacks({
    root,
    now: () => new Date('2026-10-07T10:05:00.000Z'),
    verify: () => {
      reads += 1
      if (reads === 1) return state
      return {
        ...state,
        issues: new Map([[issue.payload.issueId, { ...issue, sha256: 'f'.repeat(64) }]]),
      }
    },
    append: () => {
      writes += 1
    },
  })
  assert.deepEqual(result.counts, { issue_changed_on_reopen: 1 })
  assert.equal(writes, 0)
})

test('an already witnessed issue is idempotent on the next pass', (t) => {
  const root = rootFor(t)
  appendIssue(root)
  const options = {
    root,
    now: () => new Date('2026-10-07T10:05:00.000Z'),
    minFreeBytes: 0,
  }
  recordLocalCarryExitV2Readbacks(options)
  const again = recordLocalCarryExitV2Readbacks(options)
  assert.equal(again.scanned, 0)
  assert.deepEqual(again.records, [])
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).readbacks.size, 1)
})

test('expired unwitnessed issues cannot starve a newer issue that is still before H1', () => {
  const expired = Array.from({ length: 65 }, (_, index) => {
    const issueId = `expired:${index}`
    return [
      issueId,
      {
        sequence: index + 1,
        sha256: String(index + 1).padStart(64, '0'),
        recordedAtUtc: '2026-10-07T08:00:00.000Z',
        payload: {
          issueId,
          issuedAtUtc: '2026-10-07T08:00:00.000Z',
          plan: [{ targetAtUtc: '2026-10-07T09:00:00.000Z' }],
        },
      },
    ]
  })
  const fresh = {
    sequence: 66,
    sha256: 'f'.repeat(64),
    recordedAtUtc: '2026-10-07T10:00:00.000Z',
    payload: {
      issueId: 'fresh',
      issuedAtUtc: '2026-10-07T10:00:00.000Z',
      plan: [{ targetAtUtc: '2026-10-07T11:00:00.000Z' }],
    },
  }
  const state = {
    issues: new Map([...expired, ['fresh', fresh]]),
    readbacks: new Map(),
    head: { sequence: 66, lastSha256: fresh.sha256 },
  }
  const appended = []
  const result = recordLocalCarryExitV2Readbacks({
    limit: 1,
    now: () => new Date('2026-10-07T10:05:00.000Z'),
    verify: () => state,
    append: (kind, payload) => {
      appended.push([kind, payload])
      return { kind, payload }
    },
  })
  assert.equal(result.expiredUnwitnessed, 65)
  assert.equal(result.eligibleScanned, 1)
  assert.deepEqual(result.counts, { h1_elapsed: 65, witnessed_local_only: 1 })
  assert.equal(appended[0][1].issueId, 'fresh')
})

test('a ledger reopen that crosses H1 cannot be backdated with the earlier clock sample', (t) => {
  const root = rootFor(t)
  appendIssue(root)
  const clocks = [new Date('2026-10-07T10:59:59.999Z'), new Date('2026-10-07T11:00:01.000Z')]
  let writes = 0
  const result = recordLocalCarryExitV2Readbacks({
    root,
    now: () => clocks.shift() ?? new Date('2026-10-07T11:00:01.000Z'),
    append: () => {
      writes += 1
    },
  })
  assert.deepEqual(result.counts, { h1_elapsed: 1 })
  assert.equal(writes, 0)
})
