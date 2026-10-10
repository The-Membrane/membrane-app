import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyScheduleAttempts,
  createPgCashScheduleStore,
  validatePersistedSchedule,
} from './aave-usde-cash-schedule-db.mjs'
import { createCashSchedule } from './aave-usde-cash-schedule.mjs'

const plannedAt = '2026-09-28T00:00:00.000Z'
const startAt = '2026-09-28T03:00:00.000Z'
const endAt = '2026-09-28T04:00:00.000Z'
const persistedAt = '2026-09-28T00:01:00.000Z'
const confirmedAt = '2026-09-28T00:02:00.000Z'
const auditAt = '2026-09-28T05:00:00.000Z'
const manifest = createCashSchedule({ plannedAt, startAt, endAt, cadenceSeconds: 3600 })
const manifestRow = {
  manifest_sha256: manifest.sha256,
  payload: JSON.stringify(manifest),
  planned_at: plannedAt,
  start_at: startAt,
  end_at: endAt,
  cadence_seconds: 3600,
  persisted_at: persistedAt,
  publisher_xid: '100',
  confirmed_at: confirmedAt,
  confirmer_xid: '101',
}
const auditGrant = new Proxy({}, { get: () => true })

test('persisted manifest must match exact payload, metadata and pre-slot time', () => {
  assert.equal(
    validatePersistedSchedule(manifestRow, manifest.sha256).manifest.sha256,
    manifest.sha256,
  )
  assert.throws(
    () => validatePersistedSchedule({ ...manifestRow, payload: '{' }, manifest.sha256),
    /invalid/,
  )
  assert.throws(
    () => validatePersistedSchedule({ ...manifestRow, end_at: startAt }, manifest.sha256),
    /metadata/,
  )
  assert.throws(
    () => validatePersistedSchedule({ ...manifestRow, persisted_at: startAt }, manifest.sha256),
    /before its first slot/,
  )
  assert.throws(
    () => validatePersistedSchedule({ ...manifestRow, confirmed_at: null }, manifest.sha256),
    /lacks post-commit confirmation/,
  )
  assert.throws(
    () => validatePersistedSchedule({ ...manifestRow, confirmer_xid: '100' }, manifest.sha256),
    /Invalid pre-slot/,
  )
})

test('unbound receipts stay research-only; partial and competing bindings fail', () => {
  const base = {
    run_id: '00000000-0000-4000-8000-000000000001',
    amount_usd: '1000000',
    horizon_seconds: 28800,
    phase: 'start',
    status: 'scheduled',
    reason: null,
    issue_id: null,
    recorded_at: '2026-09-28T03:15:00.000Z',
    manifest_sha256: null,
    slot_id: null,
  }
  const classified = classifyScheduleAttempts(manifest, [base])
  assert.equal(classified.unboundRunCount, 1)
  assert.equal(classified.unboundArmCount, 1)
  assert.deepEqual(classified.bound, [])
  assert.throws(
    () =>
      classifyScheduleAttempts(manifest, [
        { ...base, manifest_sha256: manifest.sha256, slot_id: null },
      ]),
    /binding/,
  )
  assert.throws(
    () =>
      classifyScheduleAttempts(manifest, [
        { ...base, manifest_sha256: 'other', slot_id: manifest.slots[0].slotId },
      ]),
    /binding/,
  )
})

function poolFor(resolver) {
  const calls = []
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('WITH role_state')) return { rows: [auditGrant] }
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      return resolver(sql, params)
    },
    release() {
      calls.push({ sql: 'release' })
    },
  }
  return { pool: { connect: async () => client }, calls }
}

test('future publication uses DB time, separate commit confirmation and exact readback', async () => {
  const { pool, calls } = poolFor((sql, params) => {
    if (sql.includes('clock_timestamp')) return { rows: [{ now: plannedAt }] }
    if (sql.includes('publish_aave_usde_cash_manifest')) {
      const sent = JSON.parse(params[0])
      assert.equal(sent.startAt, startAt)
      assert.equal(JSON.parse(params[1]).sha256, undefined)
      return {
        rows: [{ manifest_sha256: sent.sha256, inserted: true, persisted_at: persistedAt }],
      }
    }
    if (sql.includes('confirm_aave_usde_cash_manifest'))
      return {
        rows: [{ manifest_sha256: manifest.sha256, confirmed_at: confirmedAt, inserted: true }],
      }
    if (sql.includes('FROM public.aave_usde_cash_schedules')) return { rows: [manifestRow] }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const result = await createPgCashScheduleStore(pool).publishFuture({ startAt, endAt })
  assert.equal(result.manifest.sha256, manifest.sha256)
  assert.equal(result.inserted, true)
  assert.ok(calls.some((call) => call.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE'))
  assert.ok(calls.some((call) => call.sql === 'COMMIT'))
  assert.ok(calls.some((call) => call.sql.includes('FROM public.aave_usde_cash_schedules')))
  assert.ok(calls.some((call) => call.sql.includes('confirm_aave_usde_cash_manifest')))
  const publish = calls.findIndex((call) =>
    call.sql.includes('FROM public.publish_aave_usde_cash_manifest'),
  )
  const commitAfterPublish = calls.findIndex((call, i) => i > publish && call.sql === 'COMMIT')
  const confirm = calls.findIndex((call) =>
    call.sql.includes('FROM public.confirm_aave_usde_cash_manifest'),
  )
  assert.ok(publish < commitAfterPublish && commitAfterPublish < confirm)
  assert.equal(calls.at(-1).sql, 'release')
})

test('offline audit reads exact persisted manifest, all attempts and linked issues in one snapshot', async () => {
  const { pool, calls } = poolFor((sql) => {
    if (sql.includes('FROM public.aave_usde_cash_schedules')) return { rows: [manifestRow] }
    if (sql.includes('transaction_timestamp')) return { rows: [{ as_of: auditAt }] }
    if (sql.includes('FROM public.aave_usde_cash_issue_attempts')) return { rows: [] }
    if (sql.includes('FROM public.aave_usde_cash_issues')) return { rows: [] }
    if (sql.includes('FROM public.aave_usde_cash_issue_run_confirmations')) return { rows: [] }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const result = await createPgCashScheduleStore(pool).auditPersisted(manifest.sha256)
  assert.equal(result.coverage.missedInvocationCount, 1)
  assert.equal(result.unboundResearchOnly.runCount, 0)
  assert.equal(result.query, 'single_unpaginated_repeatable_read_snapshot')
  assert.ok(calls.some((call) => call.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  const begin = calls.findIndex((call) => call.sql.startsWith('BEGIN'))
  const asOf = calls.findIndex((call) => call.sql.includes('transaction_timestamp'))
  const manifestRead = calls.findIndex((call) =>
    call.sql.includes('FROM public.aave_usde_cash_schedules'),
  )
  assert.ok(begin < asOf && asOf < manifestRead)
  assert.ok(calls.some((call) => call.sql.includes('slot_id=ANY($2::text[])')))
  assert.ok(calls.some((call) => call.sql.includes('WHERE id=ANY($1::uuid[])')))
  assert.ok(calls.some((call) => call.sql === 'COMMIT'))
})

test('audit asOf at snapshot start does not invent a missed just-closed slot', async () => {
  const beforeClose = '2026-09-28T03:59:59.999Z'
  const { pool } = poolFor((sql) => {
    if (sql.includes('transaction_timestamp')) return { rows: [{ as_of: beforeClose }] }
    if (sql.includes('FROM public.aave_usde_cash_schedules')) return { rows: [manifestRow] }
    if (sql.includes('FROM public.aave_usde_cash_issue_attempts')) return { rows: [] }
    if (sql.includes('FROM public.aave_usde_cash_issues')) return { rows: [] }
    if (sql.includes('FROM public.aave_usde_cash_issue_run_confirmations')) return { rows: [] }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const result = await createPgCashScheduleStore(pool).auditPersisted(manifest.sha256)
  assert.equal(result.asOf, beforeClose)
  assert.equal(result.coverage.dueSlotCount, 0)
  assert.equal(result.coverage.missedInvocationCount, 0)
})

test('audit rejects any receipt timestamp later than snapshot asOf', async () => {
  const snapshotAt = '2026-09-28T03:15:00.000Z'
  const { pool } = poolFor((sql) => {
    if (sql.includes('transaction_timestamp')) return { rows: [{ as_of: snapshotAt }] }
    if (sql.includes('FROM public.aave_usde_cash_schedules')) return { rows: [manifestRow] }
    if (sql.includes('FROM public.aave_usde_cash_issue_attempts'))
      return {
        rows: [
          {
            run_id: '00000000-0000-4000-8000-000000000001',
            recorded_at: '2026-09-28T03:16:00.000Z',
            manifest_sha256: null,
            slot_id: null,
          },
        ],
      }
    throw new Error(`Unexpected query: ${sql}`)
  })
  await assert.rejects(
    createPgCashScheduleStore(pool).auditPersisted(manifest.sha256),
    /follows audit snapshot time/,
  )
})

test('issuance cannot select an unconfirmed manifest slot', async () => {
  const unconfirmedRow = { ...manifestRow, confirmed_at: null, confirmer_xid: null }
  const { pool, calls } = poolFor((sql) => {
    if (sql.includes('FROM public.aave_usde_cash_schedules')) return { rows: [unconfirmedRow] }
    throw new Error(`Unexpected query: ${sql}`)
  })
  await assert.rejects(
    createPgCashScheduleStore(pool).loadCurrentSlot(manifest.sha256),
    /lacks post-commit confirmation/,
  )
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'))
})

test('incomplete attempt result rolls back audit instead of claiming coverage', async () => {
  const { pool, calls } = poolFor((sql) => {
    if (sql.includes('FROM public.aave_usde_cash_schedules')) return { rows: [manifestRow] }
    if (sql.includes('transaction_timestamp')) return { rows: [{ as_of: auditAt }] }
    if (sql.includes('FROM public.aave_usde_cash_issue_attempts')) return { rows: null }
    throw new Error(`Unexpected query: ${sql}`)
  })
  await assert.rejects(createPgCashScheduleStore(pool).auditPersisted(manifest.sha256), /Complete/)
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'))
})

test('bound issued arm resolves linked immutable issue in the same snapshot', async () => {
  const runId = '00000000-0000-4000-8000-000000000005'
  const issueId = '00000000-0000-4000-8000-000000000006'
  const attempts = manifest.slots[0].arms.flatMap((arm) => {
    const base = {
      run_id: runId,
      amount_usd: String(arm.amountUsd),
      horizon_seconds: arm.horizonSeconds,
      manifest_sha256: manifest.sha256,
      slot_id: manifest.slots[0].slotId,
    }
    const isIssued = arm.amountUsd === 1_000_000 && arm.horizonSeconds === 28_800
    return [
      {
        ...base,
        phase: 'start',
        status: 'scheduled',
        reason: null,
        issue_id: null,
        publisher_xid: '101',
        recorded_at: '2026-09-28T03:10:00.000Z',
      },
      {
        ...base,
        phase: 'result',
        status: isIssued ? 'issued' : 'abstained',
        reason: isIssued ? null : 'no_observed_source',
        issue_id: isIssued ? issueId : null,
        publisher_xid: '102',
        recorded_at: '2026-09-28T03:12:00.000Z',
      },
    ]
  })
  const issue = {
    id: issueId,
    amount_usd: '1000000',
    horizon_seconds: 28800,
    issued_at: '2026-09-28T03:10:00.000Z',
    persisted_at: '2026-09-28T03:11:00.000Z',
    target_at: '2026-09-28T11:10:00.000Z',
  }
  const { pool } = poolFor((sql, params) => {
    if (sql.includes('FROM public.aave_usde_cash_schedules')) return { rows: [manifestRow] }
    if (sql.includes('transaction_timestamp')) return { rows: [{ as_of: auditAt }] }
    if (sql.includes('FROM public.aave_usde_cash_issue_attempts')) return { rows: attempts }
    if (sql.includes('FROM public.aave_usde_cash_issues')) {
      assert.deepEqual(params[0], [issueId])
      return { rows: [issue] }
    }
    if (sql.includes('FROM public.aave_usde_cash_issue_run_confirmations'))
      return {
        rows: [
          {
            run_id: runId,
            manifest_sha256: manifest.sha256,
            slot_id: manifest.slots[0].slotId,
            confirmed_at: '2026-09-28T03:13:00.000Z',
            confirmer_xid: '103',
            result_xid: '102',
          },
        ],
      }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const audited = await createPgCashScheduleStore(pool).auditPersisted(manifest.sha256)
  assert.equal(audited.coverage.armCounts.issued, 1)
  assert.equal(audited.coverage.armCounts.abstained, 8)
  assert.equal(audited.coverage.prospectiveIssuedArmCount, 1)

  const unconfirmed = poolFor((sql) => {
    if (sql.includes('transaction_timestamp')) return { rows: [{ as_of: auditAt }] }
    if (sql.includes('FROM public.aave_usde_cash_schedules')) return { rows: [manifestRow] }
    if (sql.includes('FROM public.aave_usde_cash_issue_attempts')) return { rows: attempts }
    if (sql.includes('FROM public.aave_usde_cash_issues')) return { rows: [issue] }
    if (sql.includes('FROM public.aave_usde_cash_issue_run_confirmations')) return { rows: [] }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const operational = await createPgCashScheduleStore(unconfirmed.pool).auditPersisted(
    manifest.sha256,
  )
  assert.equal(operational.coverage.armCounts.issued, 1)
  assert.equal(operational.coverage.prospectiveIssuedArmCount, 0)

  const missing = poolFor((sql) => {
    if (sql.includes('FROM public.aave_usde_cash_schedules')) return { rows: [manifestRow] }
    if (sql.includes('transaction_timestamp')) return { rows: [{ as_of: auditAt }] }
    if (sql.includes('FROM public.aave_usde_cash_issue_attempts')) return { rows: attempts }
    if (sql.includes('FROM public.aave_usde_cash_issues')) return { rows: [] }
    if (sql.includes('FROM public.aave_usde_cash_issue_run_confirmations')) return { rows: [] }
    throw new Error(`Unexpected query: ${sql}`)
  })
  await assert.rejects(
    createPgCashScheduleStore(missing.pool).auditPersisted(manifest.sha256),
    /lacks linked persisted issue/,
  )
})
