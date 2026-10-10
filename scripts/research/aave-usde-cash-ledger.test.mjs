import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  createPgCashLedgerStore,
  issueFixedGrid,
  scoreDueIssues,
  sourceRowSet,
} from './aave-usde-cash-ledger.mjs'
import { createCashSchedule } from './aave-usde-cash-schedule.mjs'

const config = {
  name: 'aave-v3-usde',
  enabled: true,
  kind: 'atoken-liquidity',
  address: '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF',
  underlying: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
  decimals: 18,
}
const base = Date.parse('2026-09-28T00:00:00Z')
const at = (hours) => new Date(base + hours * 3_600_000).toISOString()
const sample = (i, cashMillions = 20) => {
  const hours = i * 4
  return {
    id: `sample-${i}`,
    venue: 'aave-v3-usde',
    chain: 'ethereum',
    source: 'observed',
    recorder_atomic_v1: true,
    block: String(100 + i),
    observed_at: at(hours),
    created_at: at(hours),
    instant_usd: String(cashMillions * 1_000_000),
    params: {
      kind: 'atoken-liquidity',
      read_block_finalized: true,
      read_block_pinned: true,
      read_block_number: String(100 + i),
      read_block_hash: `0x${(100 + i).toString(16).padStart(64, '0')}`,
      read_block_time: (base + hours * 3_600_000 - 600_000) / 1000,
      aToken: config.address,
      underlying: config.underlying,
      underlyingOnchain: config.underlying,
      underlyingIdentity: 'match',
      decimalsIdentity: 'match',
      decimals: 18,
      underlyingDecimalsOnchain: 18,
      reads: { underlyingAsset: true, underlyingDecimals: true, underlyingBalance: true },
      underlyingBalance: (BigInt(cashMillions * 1_000_000) * 10n ** 18n).toString(),
      priceAssumptionUsd: 1,
    },
  }
}
const history = () => [24, 23, 22, 21, 20, 19, 18].map((cash, i) => sample(i, cash))
const future = () => [15, 14, 13, 12, 11, 9, 7].map((cash, i) => sample(i + 7, cash))
const seal = (body) => ({
  ...body,
  sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
})
const passingPublisherAudit = {
  direct_login_role: true,
  ordinary_role: true,
  no_create: true,
  schema_usage: true,
  no_direct_protected_write: true,
  can_read_evidence: true,
  not_table_owner_member: true,
  not_function_owner_member: true,
  exclusive_function_acl: true,
  can_issue: true,
  can_score: true,
  can_start: true,
  can_finish: true,
  can_record_score_attempt: true,
  can_publish_manifest: true,
  can_start_bound: true,
  can_finish_bound: true,
  can_confirm_manifest: true,
  can_confirm_issue_run: true,
}

function memoryStore({
  rows = history(),
  now = at(24),
  complete = true,
  persistLagMs = 1_000,
  failIssueInsert = false,
  failConfirm = false,
} = {}) {
  const issues = new Map()
  const scores = new Map()
  let serial = 0
  const state = {
    rows,
    now,
    complete,
    persistLagMs,
    failIssueInsert,
    failConfirm,
    issues,
    scores,
    reads: [],
    issueAttempts: [],
    confirmations: [],
    scoreAttempts: [],
  }
  const store = {
    async withTransaction(fn) {
      return fn({
        startIssueRun: async (runId, binding) => {
          for (const amountUsd of [1_000_000, 10_000_000, 50_000_000]) {
            for (const horizonSeconds of [8 * 3600, 24 * 3600, 7 * 24 * 3600]) {
              state.issueAttempts.push({
                runId,
                amountUsd,
                horizonSeconds,
                phase: 'start',
                status: 'scheduled',
                binding,
              })
            }
          }
        },
        finishIssueRun: async (runId, outcomes, binding) => {
          for (const outcome of outcomes)
            state.issueAttempts.push({ runId, phase: 'result', binding, ...outcome })
        },
        confirmIssueRun: async (runId, binding) => {
          if (state.failConfirm) throw new Error('confirm failed')
          state.confirmations.push({ runId, binding, confirmedAt: state.now })
          return { confirmed: true, confirmedAt: state.now }
        },
        serverNow: async () => state.now,
        readObservedThrough: async (asOf, since) => {
          state.reads.push(asOf)
          return {
            complete: state.complete,
            rows: state.rows.filter(
              (row) =>
                Date.parse(row.observed_at) <= Date.parse(asOf) &&
                Date.parse(row.created_at) <= Date.parse(asOf) &&
                Date.parse(row.observed_at) >= Date.parse(since),
            ),
          }
        },
        insertIssue: async (row) => {
          if (state.failIssueInsert) throw new Error('insert failed')
          const key = `${row.study}/${row.anchorId}/${row.amountUsd}/${row.horizonSeconds}`
          const old = issues.get(key)
          if (old)
            return {
              inserted: false,
              id: old.id,
              persistedAt: old.persistedAt,
              payloadMatchesCandidate: old.payloadSha256 === row.payloadSha256,
            }
          const stored = {
            id: `issue-${++serial}`,
            payload: row.payload,
            targetAt: row.targetAt,
            payloadSha256: row.payloadSha256,
            persistedAt: new Date(Date.parse(state.now) + state.persistLagMs).toISOString(),
            sourceRowIds: row.sourceRowIds,
            sourceRowSetSha256: row.sourceRowSetSha256,
          }
          issues.set(key, stored)
          return { inserted: true, id: stored.id, persistedAt: stored.persistedAt }
        },
        listDueUnscoredIssues: async (asOf, limit) =>
          [...issues.values()]
            .filter((row) => Date.parse(row.targetAt) <= Date.parse(asOf) && !scores.has(row.id))
            .sort((a, b) => {
              const last = (id) =>
                state.scoreAttempts.findLast((attempt) => attempt.issueId === id)?.id ?? -1
              return (
                last(a.id) - last(b.id) ||
                Date.parse(a.targetAt) - Date.parse(b.targetAt) ||
                a.id.localeCompare(b.id)
              )
            })
            .slice(0, limit),
        recordScoreAttempt: async (issueId, status, reason) => {
          state.scoreAttempts.push({ id: state.scoreAttempts.length + 1, issueId, status, reason })
        },
        getScore: async (issueId) => scores.get(issueId) ?? null,
        insertScore: async (row) => {
          const old = scores.get(row.issueId)
          if (old)
            return {
              inserted: false,
              id: old.id,
              persistedAt: old.persistedAt,
              payloadMatchesCandidate: old.payload.sha256 === row.payloadSha256,
            }
          const stored = {
            id: `score-${++serial}`,
            persistedAt: new Date(Date.parse(state.now) + state.persistLagMs).toISOString(),
            payload: row.payload,
            sourceRowIds: row.sourceRowIds,
            sourceRowSetSha256: row.sourceRowSetSha256,
          }
          scores.set(row.issueId, stored)
          return { inserted: true, id: stored.id, persistedAt: stored.persistedAt }
        },
      })
    },
  }
  return { store, state }
}

test('issues all fixed cells once using server time and seals the complete pre-outcome row set', async () => {
  const { store, state } = memoryStore({ rows: [...history(), ...future()] })
  const first = await issueFixedGrid({ store, config })
  assert.equal(first.status, 'processed')
  assert.equal(first.cohortEligible, false)
  assert.equal(first.issues.length, 9)
  assert.equal(first.issues.filter((x) => x.inserted).length, 9)
  assert.deepEqual(
    [...state.issues.values()][0].sourceRowIds,
    history().map((row) => row.id),
  )
  assert.deepEqual(state.reads, [at(24)])
  assert.equal(
    [...state.issues.values()].every(
      (row) => Date.parse(row.persistedAt) < Date.parse(row.payload.targetAt),
    ),
    true,
  )
  const repeat = await issueFixedGrid({ store, config })
  assert.equal(repeat.issues.filter((x) => x.inserted).length, 0)
  assert.equal(state.issues.size, 9)
  state.now = at(24 + 1 / 60)
  const laterDuplicate = await issueFixedGrid({ store, config })
  assert.equal(
    laterDuplicate.issues.every((x) => x.payloadMatchesCandidate === false),
    true,
  )
  assert.equal(state.issues.size, 9)
  assert.equal(state.issueAttempts.filter((x) => x.phase === 'start').length, 27)
  assert.equal(
    state.issueAttempts.filter((x) => x.phase === 'result' && x.status === 'issued').length,
    9,
  )
  assert.equal(
    state.issueAttempts.filter((x) => x.phase === 'result' && x.status === 'duplicate').length,
    18,
  )
})

test('sealed schedule binding enters cohort; bad slots reject before an attempt starts', async () => {
  const manifest = createCashSchedule({
    plannedAt: at(0),
    startAt: at(24),
    endAt: at(25),
    cadenceSeconds: 3600,
  })
  const { store, state } = memoryStore()
  const schedule = { manifest, slotId: manifest.slots[0].slotId }
  const result = await issueFixedGrid({ store, config, schedule })
  assert.equal(result.cohortEligible, true)
  assert.equal(state.confirmations.length, 1)
  assert.equal(state.issueAttempts.length, 18)
  assert.equal(
    state.issueAttempts.every((row) => row.binding?.manifestSha256 === manifest.sha256),
    true,
  )
  assert.equal(
    state.issueAttempts.every((row) => row.binding?.slotId === schedule.slotId),
    true,
  )
  const bad = memoryStore()
  await assert.rejects(
    () => issueFixedGrid({ store: bad.store, config, schedule: { manifest, slotId: 'bad' } }),
    /absent from sealed schedule/,
  )
  assert.equal(bad.state.issueAttempts.length, 0)
})

test('failed post-commit confirmation preserves issued results but cannot claim cohort eligibility', async () => {
  const manifest = createCashSchedule({
    plannedAt: at(0),
    startAt: at(24),
    endAt: at(25),
    cadenceSeconds: 3600,
  })
  const { store, state } = memoryStore({ failConfirm: true })
  await assert.rejects(
    () =>
      issueFixedGrid({ store, config, schedule: { manifest, slotId: manifest.slots[0].slotId } }),
    /confirm failed/,
  )
  assert.equal(state.issueAttempts.filter((row) => row.phase === 'start').length, 9)
  assert.equal(
    state.issueAttempts.filter((row) => row.phase === 'result' && row.status === 'issued').length,
    9,
  )
  assert.equal(state.issueAttempts.filter((row) => row.status === 'failed').length, 0)
  assert.equal(state.confirmations.length, 0)
})

test('late or backdated persistence and incomplete source queries fail closed', async () => {
  const late = memoryStore({ persistLagMs: 61_000 })
  await assert.rejects(() => issueFixedGrid({ store: late.store, config }), /Delayed/)
  const backward = memoryStore({ persistLagMs: -1 })
  await assert.rejects(() => issueFixedGrid({ store: backward.store, config }), /Delayed/)
  const partial = memoryStore({ complete: false })
  await assert.rejects(() => issueFixedGrid({ store: partial.store, config }), /Complete observed/)
  assert.equal(partial.state.issues.size, 0)
})

test('stale source cannot be retroactively issued', async () => {
  const { store, state } = memoryStore({ now: at(25) })
  const result = await issueFixedGrid({ store, config })
  assert.equal(result.status, 'stale_source')
  assert.equal(state.issues.size, 0)
  assert.equal(
    state.issueAttempts.filter((x) => x.status === 'abstained' && x.reason === 'stale_source')
      .length,
    9,
  )
})

test('no observed source is counted as nine abstained arms', async () => {
  const { store, state } = memoryStore({ rows: [] })
  const result = await issueFixedGrid({ store, config })
  assert.equal(result.status, 'no_observed_source')
  assert.equal(state.issues.size, 0)
  assert.equal(state.issueAttempts.filter((x) => x.phase === 'start').length, 9)
  assert.equal(
    state.issueAttempts.filter((x) => x.status === 'abstained' && x.reason === 'no_observed_source')
      .length,
    9,
  )
})

test('failed grid still has nine committed denominator arms and terminal failure receipts', async () => {
  const { store, state } = memoryStore({ failIssueInsert: true })
  await assert.rejects(() => issueFixedGrid({ store, config }), /insert failed/)
  const starts = state.issueAttempts.filter((x) => x.phase === 'start')
  const results = state.issueAttempts.filter((x) => x.phase === 'result')
  assert.equal(starts.length, 9)
  assert.equal(results.length, 9)
  assert.equal(new Set(starts.map((x) => x.runId)).size, 1)
  assert.equal(
    results.every((x) => x.status === 'failed' && x.reason === 'issue_grid_transaction_failed'),
    true,
  )
})

test('late processor scores timely source once and retains at-risk versus preexisting shortage', async () => {
  const { store, state } = memoryStore()
  await issueFixedGrid({ store, config })
  state.rows = [...history(), ...future()]
  state.now = at(60)
  const result = await scoreDueIssues({ store })
  assert.equal(result.results.length, 6) // 8h and 24h cells are due; 7d remains pending.
  assert.equal(result.results.filter((x) => x.status === 'observed').length, 6)
  const atRisk = [...state.scores.values()].find(
    (x) => x.payload.riskSet === 'at_risk' && x.payload.targetLagSeconds === 0,
  )
  assert.ok(atRisk)
  assert.equal(atRisk.payload.onsetEligible, true)
  assert.ok(atRisk.payload.scoreDelayBeyondTargetWindowSeconds > 0)
  const alreadyBelow = [...state.scores.values()].find(
    (x) => x.payload.riskSet === 'preexisting_shortage',
  )
  assert.ok(alreadyBelow)
  assert.equal(alreadyBelow.payload.onsetEligible, false)
  assert.deepEqual(alreadyBelow.payload.scenarioPredictions, { persistence: null, linear: null })
  assert.equal(atRisk.sourceRowIds.includes('sample-12'), true)
  const again = await scoreDueIssues({ store })
  assert.equal(again.results.length, 0)
  assert.equal(state.scores.size, 6)
})

test('pending scores wait for target window; missing outcomes become censored', async () => {
  const { store, state } = memoryStore()
  await issueFixedGrid({ store, config })
  state.now = at(32)
  const pending = await scoreDueIssues({ store })
  assert.equal(pending.results.length, 3)
  assert.equal(
    pending.results.every((row) => row.status === 'pending'),
    true,
  )
  assert.equal(state.scores.size, 0)
  state.now = at(41)
  const missing = await scoreDueIssues({ store })
  assert.equal(missing.results.length, 3)
  assert.equal(
    missing.results.every((row) => row.status === 'censored'),
    true,
  )
  assert.equal(state.scores.size, 3)
})

test('score refuses incomplete source query and forged post-target issue persistence', async () => {
  const { store, state } = memoryStore()
  await issueFixedGrid({ store, config })
  state.now = at(60)
  state.complete = false
  const incomplete = await scoreDueIssues({ store })
  assert.equal(incomplete.results.length, 6)
  assert.equal(
    incomplete.results.every((x) => x.status === 'failed'),
    true,
  )
  assert.equal(state.scores.size, 0)
  assert.equal(state.scoreAttempts.filter((x) => x.status === 'failed').length, 6)
  state.complete = true
  const first = [...state.issues.values()][0]
  first.persistedAt = first.payload.targetAt
  const forged = await scoreDueIssues({ store })
  assert.equal(forged.results.filter((x) => x.status === 'failed').length, 1)
  assert.equal(forged.results.filter((x) => x.status === 'censored').length, 5)
})

test('more than 25 permanently bad oldest issues cannot starve a later valid due issue', async () => {
  const { store, state } = memoryStore()
  await issueFixedGrid({ store, config })
  const valid = [...state.issues.values()][0]
  state.issues.clear()
  for (let index = 0; index < 26; index++) {
    state.issues.set(`bad-${index}`, {
      ...valid,
      id: `bad-${String(index).padStart(2, '0')}`,
      payloadSha256: 'corrupt',
    })
  }
  state.issues.set('good', { ...valid, id: 'good-later' })
  state.rows = [...history(), ...future()]
  state.now = at(60)
  const first = await scoreDueIssues({ store })
  assert.equal(first.results.length, 25)
  assert.equal(
    first.results.every((row) => row.status === 'failed'),
    true,
  )
  const second = await scoreDueIssues({ store })
  assert.equal(second.results.length, 25)
  assert.equal(
    second.results.some((row) => row.issueId === 'good-later' && row.status === 'observed'),
    true,
  )
  assert.equal(state.scores.has('good-later'), true)
  assert.equal(state.scoreAttempts.filter((row) => row.status === 'failed').length > 25, true)
})

test('invalid JSON in the oldest persisted issue records failure and does not block later due scoring', async () => {
  const { store, state } = memoryStore()
  await issueFixedGrid({ store, config })
  const valid = [...state.issues.values()][0]
  state.issues.clear()
  state.issues.set('poison', { ...valid, id: 'a-poison', payload: '{invalid json' })
  state.issues.set('good', { ...valid, id: 'z-good' })
  state.rows = [...history(), ...future()]
  state.now = at(60)
  const result = await scoreDueIssues({ store })
  assert.equal(result.results.length, 2)
  assert.deepEqual(
    result.results.map((row) => row.status),
    ['failed', 'observed'],
  )
  assert.equal(
    state.scoreAttempts.some((row) => row.issueId === 'a-poison' && row.status === 'failed'),
    true,
  )
  assert.equal(state.scores.has('z-good'), true)
})

test('source row seal changes when an interior row or balance changes', () => {
  const rows = history()
  assert.notEqual(sourceRowSet(rows).sha256, sourceRowSet(rows.slice(1)).sha256)
  assert.notEqual(
    sourceRowSet(rows).sha256,
    sourceRowSet([...rows.slice(0, -1), sample(6, 1)]).sha256,
  )
  assert.throws(() => sourceRowSet([...rows, rows[0]]), /Duplicate source row id/)
})

test('SQL adapter uses serializable session, bounded due scan, and reloads TEXT payload', async () => {
  const statements = []
  let released = false
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          statements.push({ sql, args })
          if (sql.includes('WITH role_state')) return { rows: [passingPublisherAudit] }
          if (sql.includes('FROM aave_usde_cash_issues i'))
            return {
              rows: [
                {
                  id: 'issue-1',
                  payload: JSON.stringify({ z: 1, a: 2 }),
                  payload_sha256: 'hash',
                  persisted_at: at(24),
                },
              ],
            }
          if (sql.includes('FROM venue_snapshots')) return { rows: history() }
          if (sql.includes('clock_timestamp() AS now')) return { rows: [{ now: at(24) }] }
          return { rows: [] }
        },
        release() {
          released = true
        },
      }
    },
  }
  const store = createPgCashLedgerStore(pool)
  const result = await store.withTransaction(async (tx) => ({
    now: await tx.serverNow(),
    source: await tx.readObservedThrough(at(24), at(-6)),
    due: await tx.listDueUnscoredIssues(at(48), 25),
  }))
  assert.equal(result.source.complete, true)
  assert.equal(result.due[0].payload, JSON.stringify({ z: 1, a: 2 }))
  assert.equal(result.due[0].payloadSha256, 'hash')
  assert.match(statements[0].sql, /WITH role_state/)
  assert.match(statements[1].sql, /BEGIN ISOLATION LEVEL SERIALIZABLE/)
  assert.match(
    statements.find((row) => row.sql.includes('FROM venue_snapshots')).sql,
    /source = 'observed'/,
  )
  assert.deepEqual(
    statements.find((row) => row.sql.includes('FROM aave_usde_cash_issues i')).args,
    ['aave-v3-usde-prospective-sampled-cash-v1', at(48), 25],
  )
  assert.match(
    statements.find((row) => row.sql.includes('FROM aave_usde_cash_issues i')).sql,
    /ORDER BY attempt\.last_attempt_id NULLS FIRST, i\.target_at, i\.id LIMIT \$3/,
  )
  assert.equal(statements.at(-1).sql, 'COMMIT')
  assert.equal(released, true)
})

test('SQL adapter rejects an unaudited role before beginning a transaction', async () => {
  const statements = []
  let released = false
  const store = createPgCashLedgerStore({
    async connect() {
      return {
        async query(sql) {
          statements.push(sql)
          return { rows: [{ ordinary_role: false }] }
        },
        release() {
          released = true
        },
      }
    },
  })
  await assert.rejects(() => store.withTransaction(() => true), /publisher role audit failed/)
  assert.equal(statements.length, 1)
  assert.match(statements[0], /WITH role_state/)
  assert.equal(released, true)
})

test('SQL adapter publishes cash and attempt receipts only through restricted functions', async () => {
  const statements = []
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          statements.push({ sql, args })
          if (sql.includes('WITH role_state')) return { rows: [passingPublisherAudit] }
          if (sql.includes('publish_aave_usde_cash_issue_start'))
            return { rows: [{ inserted: true }] }
          if (sql.includes('publish_aave_usde_cash_issue_result'))
            return { rows: [{ inserted: true }] }
          if (sql.includes('publish_aave_usde_cash_score_attempt'))
            return { rows: [{ attempt_id: '1' }] }
          if (sql.includes('publish_aave_usde_cash_issue('))
            return { rows: [{ id: 'issue-id', inserted: true, persisted_at: at(24) }] }
          if (sql.includes('publish_aave_usde_cash_score('))
            return { rows: [{ id: 'score-id', inserted: true, persisted_at: at(60) }] }
          return { rows: [] }
        },
        release() {},
      }
    },
  }
  const store = createPgCashLedgerStore(pool)
  const issuePayload = seal({ study: 'study', issuedAt: at(24), targetAt: at(32) })
  const scorePayload = seal({ study: 'study', scoredAt: at(60), status: 'observed' })
  await store.withTransaction(async (tx) => {
    await tx.startIssueRun('run-id')
    const issue = await tx.insertIssue({
      study: 'study',
      anchorId: 'anchor-id',
      amountUsd: 1_000_000,
      horizonSeconds: 28_800,
      issuedAt: at(24),
      targetAt: at(32),
      payload: issuePayload,
      payloadSha256: issuePayload.sha256,
      sourceRowIds: ['anchor-id'],
      sourceRowSetSha256: 'source-sha',
    })
    assert.equal(issue.inserted, true)
    await tx.finishIssueRun(
      'run-id',
      [1_000_000, 10_000_000, 50_000_000].flatMap((amountUsd) =>
        [28_800, 86_400, 604_800].map((horizonSeconds) => ({
          amountUsd,
          horizonSeconds,
          status: 'abstained',
          reason: 'test',
        })),
      ),
    )
    const score = await tx.insertScore({
      issueId: 'issue-id',
      scoredAt: at(60),
      payload: scorePayload,
      payloadSha256: scorePayload.sha256,
      sourceRowIds: ['future-id'],
      sourceRowSetSha256: 'future-sha',
    })
    assert.equal(score.inserted, true)
    await tx.recordScoreAttempt('issue-id', 'scored', null)
  })
  assert.equal(
    statements.filter((row) =>
      row.sql.startsWith('SELECT public.publish_aave_usde_cash_issue_start'),
    ).length,
    9,
  )
  assert.equal(
    statements.filter((row) =>
      row.sql.startsWith('SELECT public.publish_aave_usde_cash_issue_result'),
    ).length,
    9,
  )
  assert.equal(
    statements.some((row) => /INSERT INTO aave_usde_cash/.test(row.sql)),
    false,
  )
  const issueCall = statements.find((row) =>
    /FROM public\.publish_aave_usde_cash_issue\(/.test(row.sql),
  )
  assert.equal(issueCall.args[1], JSON.stringify(issuePayload))
  assert.equal(
    issueCall.args[2],
    JSON.stringify({ study: 'study', issuedAt: at(24), targetAt: at(32) }),
  )
})

test('SQL adapter passes sealed slot binding to every restricted attempt publication', async () => {
  const statements = []
  const store = createPgCashLedgerStore({
    async connect() {
      return {
        async query(sql, args) {
          statements.push({ sql, args })
          if (sql.includes('WITH role_state')) return { rows: [passingPublisherAudit] }
          if (sql.includes('publish_aave_usde_cash_issue_start'))
            return { rows: [{ inserted: true }] }
          if (sql.includes('publish_aave_usde_cash_issue_result'))
            return { rows: [{ inserted: true }] }
          if (sql.includes('confirm_aave_usde_cash_issue_run'))
            return { rows: [{ run_id: runId, confirmed_at: at(24), inserted: true }] }
          return { rows: [] }
        },
        release() {},
      }
    },
  })
  const binding = { manifestSha256: 'manifest-sha', slotId: 'slot-id' }
  const runId = '11111111-1111-4111-8111-111111111111'
  await store.withTransaction(async (tx) => {
    await tx.startIssueRun(runId, binding)
    await tx.finishIssueRun(
      runId,
      [1_000_000, 10_000_000, 50_000_000].flatMap((amountUsd) =>
        [28_800, 86_400, 604_800].map((horizonSeconds) => ({
          amountUsd,
          horizonSeconds,
          status: 'abstained',
          reason: 'test',
        })),
      ),
      binding,
    )
  })
  const confirmation = await store.withTransaction((tx) => tx.confirmIssueRun(runId, binding))
  assert.equal(confirmation.confirmed, true)
  assert.equal(
    statements.filter((row) => row.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length,
    2,
  )
  assert.equal(statements.filter((row) => row.sql === 'COMMIT').length, 2)
  const starts = statements.filter((row) =>
    row.sql.startsWith('SELECT public.publish_aave_usde_cash_issue_start'),
  )
  const results = statements.filter((row) =>
    row.sql.startsWith('SELECT public.publish_aave_usde_cash_issue_result'),
  )
  assert.equal(starts.length, 9)
  assert.equal(results.length, 9)
  assert.ok(
    starts.every(
      (row) => row.args.length === 5 && row.args[3] === 'manifest-sha' && row.args[4] === 'slot-id',
    ),
  )
  assert.ok(
    results.every(
      (row) => row.args.length === 8 && row.args[6] === 'manifest-sha' && row.args[7] === 'slot-id',
    ),
  )
  assert.deepEqual(
    statements.find((row) => row.sql.includes('FROM public.confirm_aave_usde_cash_issue_run')).args,
    [runId, 'manifest-sha', 'slot-id'],
  )
})
