import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createCashSchedule } from './aave-usde-cash-schedule.mjs'
import {
  formatFailure,
  parseMode,
  publisherUrl,
  runCashLedger,
  selectUsdeConfig,
  summarizeResult,
} from './run-aave-usde-cash-ledger.mjs'

const configUrl = new URL('../../tools/venue-recorder.config.json', import.meta.url)
const configText = await readFile(configUrl, 'utf8')
const dedicatedUrl = 'postgresql://cash_publisher:fake@db.example.test/study'
const manifest = createCashSchedule({
  plannedAt: '2026-09-28T00:00:00.000Z',
  startAt: '2026-09-28T03:00:00.000Z',
  endAt: '2026-09-28T04:00:00.000Z',
  cadenceSeconds: 3600,
})

test('mode and dedicated publisher URL fail closed', () => {
  assert.equal(parseMode(['--issue', manifest.sha256]), 'issue')
  assert.equal(parseMode(['--score']), 'score')
  assert.equal(parseMode(['--audit-schedule', manifest.sha256]), 'audit-schedule')
  assert.equal(
    parseMode(['--publish-schedule', manifest.startAt, manifest.endAt]),
    'publish-schedule',
  )
  for (const args of [[], ['--issue'], ['--issue', '--score'], ['issue'], ['--live']])
    assert.throws(() => parseMode(args), /invalid_schedule_command/)
  assert.throws(() => publisherUrl({ DATABASE_URL: dedicatedUrl }), /required/)
  assert.throws(
    () => publisherUrl({ CASH_PUBLISHER_DATABASE_URL: dedicatedUrl, DATABASE_URL: dedicatedUrl }),
    /must_be_distinct/,
  )
  assert.throws(
    () =>
      publisherUrl({
        CASH_PUBLISHER_DATABASE_URL: dedicatedUrl,
        DATABASE_URL_UNPOOLED: dedicatedUrl,
      }),
    /must_be_distinct/,
  )
  assert.throws(
    () =>
      publisherUrl({
        CASH_PUBLISHER_DATABASE_URL: dedicatedUrl,
        DATABASE_URL: `${dedicatedUrl}?sslmode=require`,
      }),
    /must_be_distinct/,
  )
  for (const value of ['https://example.test/db', 'postgres://', 'garbage'])
    assert.throws(() => publisherUrl({ CASH_PUBLISHER_DATABASE_URL: value }), /invalid/)
  assert.equal(publisherUrl({ CASH_PUBLISHER_DATABASE_URL: dedicatedUrl }), dedicatedUrl)
})

test('config is the one enabled on-chain-verified USDe venue', () => {
  const document = JSON.parse(configText)
  assert.equal(selectUsdeConfig(document).name, 'aave-v3-usde')
  assert.throws(() => selectUsdeConfig({ venues: {} }), /ineligible/)
  const changed = structuredClone(document)
  changed.venues.find((v) => v.name === 'aave-v3-usde').enabled = false
  assert.throws(() => selectUsdeConfig(changed), /ineligible/)
  const duplicate = structuredClone(document)
  duplicate.venues.push(structuredClone(selectUsdeConfig(document)))
  assert.throws(() => selectUsdeConfig(duplicate), /ineligible/)
  const wrong = structuredClone(document)
  wrong.venues.find((v) => v.name === 'aave-v3-usde').underlying =
    '0x0000000000000000000000000000000000000000'
  assert.throws(() => selectUsdeConfig(wrong), /ineligible/)
})

function mockDeps(overrides = {}) {
  const calls = []
  const pool = { end: async () => calls.push('end') }
  const deps = {
    args: ['--issue', manifest.sha256],
    env: { CASH_PUBLISHER_DATABASE_URL: dedicatedUrl },
    readConfig: async () => configText,
    freeBytes: () => 2 * 1024 ** 3,
    makePool: (url) => {
      assert.equal(url, dedicatedUrl)
      calls.push('pool')
      return pool
    },
    makeStore: (received) => {
      assert.equal(received, pool)
      calls.push('store')
      return { marker: 'audited_by_adapter' }
    },
    makeScheduleStore: (received) => {
      assert.equal(received, pool)
      calls.push('schedule-store')
      return {
        loadCurrentSlot: async (sha) => {
          assert.equal(sha, manifest.sha256)
          calls.push('load-slot')
          return { manifest, slotId: manifest.slots[0].slotId }
        },
        publishFuture: async ({ startAt, endAt }) => {
          assert.equal(startAt, manifest.startAt)
          assert.equal(endAt, manifest.endAt)
          calls.push('publish')
          return {
            manifest,
            inserted: true,
            persistedAt: '2026-09-28T00:01:00.000Z',
            confirmedAt: '2026-09-28T00:02:00.000Z',
          }
        },
        auditPersisted: async (sha) => {
          assert.equal(sha, manifest.sha256)
          calls.push('audit')
          return { manifestSha256: sha, coverage: { missedInvocationCount: 1 } }
        },
      }
    },
    issue: async ({ store, config, schedule }) => {
      assert.equal(store.marker, 'audited_by_adapter')
      assert.equal(config.name, 'aave-v3-usde')
      assert.equal(schedule.manifest.sha256, manifest.sha256)
      assert.equal(schedule.slotId, manifest.slots[0].slotId)
      calls.push('issue')
      return {
        runId: 'run-1',
        status: 'stale_source',
        cohortEligible: true,
        issuedAt: '2026-09-28T00:00:00.000Z',
        issues: [],
      }
    },
    score: async ({ store }) => {
      assert.equal(store.marker, 'audited_by_adapter')
      calls.push('score')
      return { scanAt: '2026-09-28T00:00:00.000Z', results: [] }
    },
    ...overrides,
  }
  return { deps, calls }
}

test('issue and score use the ledger adapter with no side path', async () => {
  const issue = mockDeps()
  const result = await runCashLedger(issue.deps)
  assert.deepEqual(issue.calls, ['pool', 'schedule-store', 'store', 'load-slot', 'issue', 'end'])
  assert.equal(result.manifestSha256, manifest.sha256)
  assert.equal(result.cohortEligible, true)
  assert.equal(result.arms.length, 9)
  assert.ok(result.arms.every((arm) => arm.status === 'abstained' && arm.reason === 'stale_source'))
  const score = mockDeps({ args: ['--score'] })
  const scored = await runCashLedger(score.deps)
  assert.deepEqual(score.calls, ['pool', 'store', 'score', 'end'])
  assert.deepEqual(scored.results, [])
  const scoreAfterConfigChange = mockDeps({
    args: ['--score'],
    readConfig: async () => {
      throw new Error('Venue config changed after issue')
    },
  })
  await runCashLedger(scoreAfterConfigChange.deps)
  assert.deepEqual(scoreAfterConfigChange.calls, ['pool', 'store', 'score', 'end'])
})

test('validation and disk reserve reject before opening a pool', async () => {
  const cases = [
    { args: ['--issue'] },
    { env: { DATABASE_URL: dedicatedUrl } },
    { readConfig: async () => '{' },
    { freeBytes: () => 1024 ** 3 - 1 },
    { freeBytes: () => Number.NaN },
  ]
  for (const overrides of cases) {
    const { deps, calls } = mockDeps(overrides)
    await assert.rejects(runCashLedger(deps))
    assert.deepEqual(calls, [])
  }
})

test('disk check targets the repository volume, independent of process cwd', async () => {
  let measuredPath = null
  const { deps, calls } = mockDeps({
    freeBytes: undefined,
    statfs: (path) => {
      measuredPath = path
      return { bavail: 2 * 1024 ** 3, bsize: 1 }
    },
  })
  await runCashLedger(deps)
  assert.equal(measuredPath, fileURLToPath(new URL('../../', import.meta.url)))
  assert.deepEqual(calls, ['pool', 'schedule-store', 'store', 'load-slot', 'issue', 'end'])
})

test('pool closes and process failure formatting omits provider details', async () => {
  const secret = 'postgresql://cash_publisher:secret@db.example.test/study'
  const { deps, calls } = mockDeps({
    issue: async () => {
      throw new Error(secret)
    },
  })
  await assert.rejects(runCashLedger(deps), /secret/)
  assert.deepEqual(calls, ['pool', 'schedule-store', 'store', 'load-slot', 'end'])
  const safeFailure = formatFailure('issue', new Error(secret))
  assert.equal(safeFailure.reason, 'operation_failed')
  assert.ok(safeFailure.arms.every((arm) => arm.status === 'receipt_unknown'))
  assert.equal(JSON.stringify(safeFailure).includes(secret), false)
  let preflightError
  try {
    parseMode([])
  } catch (error) {
    preflightError = error
  }
  const preflight = formatFailure('issue', preflightError)
  assert.ok(preflight.arms.every((arm) => arm.status === 'not_started'))
  const output = summarizeResult('score', {
    scanAt: '2026-09-28T00:00:00.000Z',
    results: [{ issueId: 'id-1', status: 'failed', reason: 'score_transaction_failed' }],
  })
  assert.equal(output.results[0].reason, 'score_transaction_failed')
})

test('bound issue rejects an unbound ledger acknowledgement', async () => {
  const { deps, calls } = mockDeps({
    issue: async () => ({
      status: 'processed',
      cohortEligible: false,
      issues: Array.from({ length: 9 }, () => ({ inserted: true, id: 'fake' })),
    }),
  })
  await assert.rejects(runCashLedger(deps), /did not confirm cohort eligibility/)
  assert.equal(calls.at(-1), 'end')
})

test('missing persisted manifest prevents the issue transaction', async () => {
  const { deps, calls } = mockDeps({
    makeScheduleStore: () => ({
      loadCurrentSlot: async () => {
        throw new Error('Exact persisted schedule not found')
      },
    }),
  })
  await assert.rejects(runCashLedger(deps), /Exact persisted schedule not found/)
  assert.deepEqual(calls, ['pool', 'store', 'end'])
})

test('schedule publication is dry-run unless explicit apply is present', async () => {
  const dry = mockDeps({
    args: ['--publish-schedule', manifest.startAt, manifest.endAt],
    env: {},
    localNow: () => manifest.plannedAt,
  })
  const planned = await runCashLedger(dry.deps)
  assert.equal(planned.status, 'draft_unpublished')
  assert.equal(planned.slotCount, 1)
  assert.deepEqual(dry.calls, [])

  const live = mockDeps({
    args: ['--publish-schedule', manifest.startAt, manifest.endAt, '--apply'],
  })
  const published = await runCashLedger(live.deps)
  assert.equal(published.manifestSha256, manifest.sha256)
  assert.equal(published.confirmedAt, '2026-09-28T00:02:00.000Z')
  assert.deepEqual(live.calls, ['pool', 'schedule-store', 'publish', 'end'])
})

test('schedule audit uses persisted read adapter and returns missed slots', async () => {
  const { deps, calls } = mockDeps({
    args: ['--audit-schedule', manifest.sha256],
    readConfig: async () => {
      throw new Error('Current venue config is irrelevant to persisted audit')
    },
  })
  const result = await runCashLedger(deps)
  assert.equal(result.coverage.missedInvocationCount, 1)
  assert.deepEqual(calls, ['pool', 'schedule-store', 'audit', 'end'])
})

test('processed grid preserves duplicate cell identity in JSON status', () => {
  const result = summarizeResult('issue', {
    runId: 'run-2',
    status: 'processed',
    issuedAt: '2026-09-28T00:00:00.000Z',
    cohortEligible: true,
    confirmedAt: '2026-09-28T00:00:30.000Z',
    issues: Array.from({ length: 9 }, (_, i) => ({
      id: `issue-${i}`,
      inserted: i !== 4,
    })),
  })
  assert.equal(result.arms.length, 9)
  assert.equal(result.confirmedAt, '2026-09-28T00:00:30.000Z')
  assert.deepEqual(result.arms[4], {
    amountUsd: 10_000_000,
    horizonSeconds: 86_400,
    status: 'duplicate',
    issueId: 'issue-4',
  })
  assert.throws(
    () => summarizeResult('issue', { status: 'processed', issues: [] }),
    /incomplete_issue_grid_result/,
  )
})
