// Read-only inspection of the dormant v2 PostgreSQL ledgers. No source or
// prospective claim follows from self-authored database rows.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  auditHourlyCoverage,
  buildHourlyCoverageManifest,
  snapshotRowSha256,
} from './aave-usde-first-breach-coverage.mjs'
import {
  classifyFirstBreachSchedule,
  verifyFirstBreachSchedule,
} from './aave-usde-first-breach-schedule.mjs'
import { verifyFirstBreachIssue } from './aave-usde-first-breach.mjs'
import { normalizeSample } from './aave-usde-prospective-cash.mjs'
import { replayAaveUsdeV2Score } from './aave-usde-v2-score-replay.mjs'

const SHA = /^[0-9a-f]{64}$/
const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const fail = (message) => {
  throw new Error(message)
}
const iso = (value, name) => {
  const d = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(d.getTime())) fail(`Invalid ${name}`)
  return d.toISOString()
}
const millis = (value, name) => Date.parse(iso(value, name))
const integer = (value, name) => {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) fail(`Invalid ${name}`)
  return n
}
const xid = (value, name) => {
  if (!/^\d+$/.test(String(value))) fail(`Invalid ${name}`)
  return BigInt(value)
}
const rows = async (client, sql, params = []) => {
  const result = await client.query(sql, params)
  if (!Array.isArray(result?.rows)) fail('Incomplete database query result')
  return result.rows
}
const single = (list, name) => {
  if (list.length !== 1) fail(`Expected one ${name}; found ${list.length}`)
  return list[0]
}
const key = (r) => `${r.slot_id}/${r.amount_usd}/${r.horizon_seconds}`
const numericText = (value, name) => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) fail(`Invalid ${name}`)
  return n
}
// Explicit DB -> JS projection fixes object field order and timestamp/numeric
// types before the pure auditor hashes JSON.stringify(row).
export function projectSnapshot(r) {
  if (!r || !r.id || !r.params || Array.isArray(r.params)) fail('Malformed snapshot row')
  const params = typeof r.params === 'string' ? JSON.parse(r.params) : r.params
  return {
    id: String(r.id),
    venue: r.venue,
    chain: r.chain,
    block: String(r.block),
    instant_usd: numericText(r.instant_usd, 'instant_usd'),
    cooling_usd: numericText(r.cooling_usd, 'cooling_usd'),
    stranded_usd: numericText(r.stranded_usd, 'stranded_usd'),
    params,
    source: r.source,
    observed_at: iso(r.observed_at, 'observed_at'),
    created_at: iso(r.created_at, 'created_at'),
    recorder_atomic_v1: r.recorder_atomic_v1 === true,
  }
}

const snapshotColumns = `s.id,s.venue,s.chain,s.block::text AS block,
  s.instant_usd::text AS instant_usd,s.cooling_usd::text AS cooling_usd,
  s.stranded_usd::text AS stranded_usd,s.params,s.source,s.observed_at,
  s.created_at,s.recorder_atomic_v1`

export function classifyRequestedIssueCompleteness({
  scheduleAudit,
  coverageAudit,
  requestedScoreReplay,
  plannedCells,
  issueStarts,
  issueTerminals,
  issuedTerminals,
  scores,
  expectedCoverageSlots,
  recorderStarts,
  recorderTerminals,
  collisions,
  anomalies,
}) {
  return scheduleAudit &&
    coverageAudit &&
    requestedScoreReplay?.classification === 'match' &&
    requestedScoreReplay.replayedStatus === 'observed' &&
    scheduleAudit.counts.scheduled === 0 &&
    scheduleAudit.counts.missing === 0 &&
    coverageAudit.counts.pending === 0 &&
    coverageAudit.counts.missing === 0 &&
    coverageAudit.counts.censored === 0 &&
    coverageAudit.hourlyCoverageFromCallerReceipts === true &&
    issueStarts === plannedCells &&
    issueTerminals === plannedCells &&
    scores === issuedTerminals &&
    recorderStarts === expectedCoverageSlots &&
    recorderTerminals === expectedCoverageSlots &&
    collisions === 0 &&
    anomalies.length === 0
    ? 'requested_issue_complete_in_database_only'
    : 'incomplete_or_anomalous'
}

export async function auditAaveUsdeV2Ledger({ pool, scheduleSha256, manifestSha256, issueSha256 }) {
  if (![scheduleSha256, manifestSha256, issueSha256].every((s) => SHA.test(s)))
    fail('Exact schedule, manifest and issued SHA required')
  if (!pool || typeof pool.connect !== 'function') fail('Session-capable pool required')
  const client = await pool.connect()
  let inTransaction = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    inTransaction = true
    const asOf = iso(
      single(await rows(client, 'SELECT clock_timestamp() AS as_of'), 'server clock').as_of,
      'server as-of',
    )
    const schedule = single(
      await rows(
        client,
        `SELECT s.*,c.confirmed_at,c.confirmer_xid FROM public.aave_usde_v2_issue_schedules s
       LEFT JOIN public.aave_usde_v2_schedule_confirmations c ON c.sha256=s.sha256
       WHERE s.sha256=$1`,
        [scheduleSha256],
      ),
      'issue schedule',
    )
    const coverage = single(
      await rows(
        client,
        `SELECT m.*,c.confirmed_at,c.confirmer_xid FROM public.aave_usde_v2_coverage_manifests m
       LEFT JOIN public.aave_usde_v2_coverage_confirmations c ON c.sha256=m.sha256
       WHERE m.sha256=$1`,
        [manifestSha256],
      ),
      'coverage manifest',
    )
    const [
      issueStarts,
      issueTerminals,
      collisions,
      scores,
      coverageSlots,
      recorderStarts,
      recorderTerminals,
      successSnapshots,
      allSnapshots,
    ] = await (async () => {
      const statements = [
        () =>
          rows(
            client,
            'SELECT * FROM public.aave_usde_v2_issue_starts WHERE schedule_sha256=$1 ORDER BY slot_id,amount_usd,horizon_seconds',
            [scheduleSha256],
          ),
        () =>
          rows(
            client,
            'SELECT * FROM public.aave_usde_v2_issue_terminals WHERE schedule_sha256=$1 ORDER BY slot_id,amount_usd,horizon_seconds',
            [scheduleSha256],
          ),
        () =>
          rows(
            client,
            'SELECT * FROM public.aave_usde_v2_issue_collisions WHERE schedule_sha256=$1 ORDER BY id',
            [scheduleSha256],
          ),
        () =>
          rows(
            client,
            `SELECT sc.* FROM public.aave_usde_v2_score_receipts sc JOIN public.aave_usde_v2_issue_terminals t ON t.issue_sha256=sc.issue_sha256 WHERE t.schedule_sha256=$1 ORDER BY sc.issue_sha256`,
            [scheduleSha256],
          ),
        () =>
          rows(
            client,
            'SELECT * FROM public.aave_usde_v2_coverage_slots WHERE manifest_sha256=$1 ORDER BY slot_at',
            [manifestSha256],
          ),
        () =>
          rows(
            client,
            `SELECT st.* FROM public.aave_usde_v2_recorder_starts st JOIN public.aave_usde_v2_coverage_slots cs ON cs.slot_id=st.slot_id WHERE cs.manifest_sha256=$1 ORDER BY cs.slot_at`,
            [manifestSha256],
          ),
        () =>
          rows(
            client,
            `SELECT t.* FROM public.aave_usde_v2_recorder_terminals t JOIN public.aave_usde_v2_coverage_slots cs ON cs.slot_id=t.slot_id WHERE cs.manifest_sha256=$1 ORDER BY cs.slot_at`,
            [manifestSha256],
          ),
        () =>
          rows(
            client,
            `SELECT ${snapshotColumns} FROM public.venue_snapshots s JOIN public.aave_usde_v2_recorder_terminals t ON t.snapshot_id=s.id JOIN public.aave_usde_v2_coverage_slots cs ON cs.slot_id=t.slot_id WHERE cs.manifest_sha256=$1 ORDER BY s.observed_at,s.id`,
            [manifestSha256],
          ),
        () =>
          rows(
            client,
            `SELECT ${snapshotColumns} FROM public.venue_snapshots s WHERE s.venue='aave-v3-usde' AND s.chain='ethereum' AND s.observed_at >= $1::timestamptz - interval '10 minutes' AND s.observed_at < $2 ORDER BY s.observed_at,s.id`,
            [coverage.start_at, coverage.end_at],
          ),
      ]
      const result = []
      for (const statement of statements) result.push(await statement())
      return result
    })()
    await client.query('COMMIT')
    inTransaction = false

    if (schedule.sha256 !== scheduleSha256 || hash(schedule.payload) !== scheduleSha256)
      fail('Stored schedule physical SHA mismatch')
    const { manifest: scheduleJson } = verifyFirstBreachSchedule(schedule.payload, scheduleSha256)
    if (coverage.sha256 !== manifestSha256 || hash(coverage.payload) !== manifestSha256)
      fail('Stored coverage physical SHA mismatch')
    const coverageJson = JSON.parse(coverage.payload)
    if (
      coverage.schedule_sha256 !== scheduleSha256 ||
      coverageJson.issueSchedulePhysicalSha256 !== scheduleSha256
    )
      fail('Coverage schedule binding mismatch')
    if (buildHourlyCoverageManifest(coverageJson) !== coverage.payload)
      fail('Stored coverage differs from canonical bytes')
    const anomalies = []
    const check = (ok, reason) => {
      if (!ok) anomalies.push(reason)
    }
    for (const [record, json, label, first] of [
      [schedule, scheduleJson, 'schedule', 'plannedAt'],
      [coverage, coverageJson, 'coverage', 'declaredAt'],
    ]) {
      check(
        iso(record[first === 'plannedAt' ? 'planned_at' : 'declared_at'], label) === json[first],
        `${label}_clock_mismatch`,
      )
      check(
        iso(record.start_at, label) === json.startAt &&
          iso(record.end_at, label) === json.endExclusiveAt,
        `${label}_window_mismatch`,
      )
      check(
        record.confirmed_at != null &&
          millis(record.persisted_at, label) <= millis(record.confirmed_at, label) &&
          millis(record.confirmed_at, label) < millis(record.start_at, label),
        `${label}_confirmation_clock`,
      )
      check(
        record.confirmer_xid != null &&
          xid(record.publisher_xid, label) !==
            xid(record.confirmer_xid ?? record.publisher_xid, label),
        `${label}_confirmation_xid`,
      )
    }
    const expectedSlots = new Map(coverageJson.slots.map((s) => [s.id, s.at]))
    check(coverageSlots.length === expectedSlots.size, 'coverage_slot_count')
    for (const s of coverageSlots)
      check(
        expectedSlots.get(s.slot_id) === iso(s.slot_at, 'coverage slot'),
        `coverage_slot_membership:${s.slot_id}`,
      )
    const planned = new Map(
      scheduleJson.slots.flatMap((slot) =>
        slot.arms.map((arm) => [`${slot.slotId}/${arm.amountUsd}/${arm.horizonSeconds}`, slot]),
      ),
    )
    const startsByKey = new Map()
    for (const start of issueStarts) {
      const k = key(start)
      check(planned.has(k) && !startsByKey.has(k), `issue_start_membership:${k}`)
      startsByKey.set(k, start)
      check(
        millis(start.started_at, 'issue start') >=
          millis(planned.get(k)?.scheduledAt ?? schedule.start_at, 'slot') &&
          millis(start.started_at, 'issue start') <
            millis(planned.get(k)?.closesAt ?? schedule.end_at, 'slot end') &&
          xid(start.starter_xid, 'start xid') !==
            xid(schedule.confirmer_xid ?? start.starter_xid, 'confirmation xid'),
        `issue_start_order:${k}`,
      )
    }
    const terminalsByKey = new Map()
    const attempts = []
    for (const t of issueTerminals) {
      const k = key(t)
      check(
        planned.has(k) && startsByKey.has(k) && !terminalsByKey.has(k),
        `issue_terminal_membership:${k}`,
      )
      terminalsByKey.set(k, t)
      check(
        startsByKey.has(k) &&
          millis(t.recorded_at, 'issue terminal') >=
            millis(startsByKey.get(k)?.started_at ?? t.recorded_at, 'issue start') &&
          xid(t.terminal_xid, 'terminal xid') !==
            xid(startsByKey.get(k)?.starter_xid ?? t.terminal_xid, 'start xid'),
        `issue_terminal_order:${k}`,
      )
      const slot = planned.get(k)
      const onTime =
        slot &&
        millis(t.recorded_at, 'terminal') >= millis(slot.scheduledAt, 'slot') &&
        millis(t.recorded_at, 'terminal') < millis(slot.closesAt, 'slot')
      check(Boolean(t.timely) === Boolean(onTime), `issue_timely_mismatch:${k}`)
      if (!onTime || !startsByKey.has(k) || !slot) continue
      let issue = null
      if (t.status === 'issued') {
        check(
          typeof t.payload === 'string' && hash(t.payload) === t.physical_sha256,
          `issue_physical_sha:${k}`,
        )
        try {
          issue = JSON.parse(t.payload)
          verifyFirstBreachIssue(issue)
          check(
            issue.sha256 === t.issue_sha256 && issue.anchor?.id === t.anchor_id,
            `issue_identity:${k}`,
          )
        } catch {
          check(false, `issue_payload_invalid:${k}`)
          continue
        }
      }
      attempts.push({
        issueSchedulePhysicalSha256: scheduleSha256,
        slotId: t.slot_id,
        amountUsd: integer(t.amount_usd, 'amount'),
        horizonSeconds: integer(t.horizon_seconds, 'horizon'),
        status: t.status,
        reason: t.reason,
        recordedAt: iso(t.recorded_at, 'recorded'),
        issue,
      })
    }
    for (const c of collisions)
      check(
        terminalsByKey.get(key(c))?.issue_sha256 === c.issue_sha256,
        `collision_binding:${key(c)}`,
      )
    const requested = issueTerminals.find((t) => t.issue_sha256 === issueSha256)
    if (!requested || requested.status !== 'issued') fail('Requested issued SHA absent')
    const issue = JSON.parse(requested.payload)
    verifyFirstBreachIssue(issue)
    check(
      issue.sha256 === issueSha256 && hash(requested.payload) === requested.physical_sha256,
      'requested_issue_seal',
    )
    const requestedSlot = planned.get(key(requested))
    const requestedOnTime = Boolean(
      requestedSlot &&
      startsByKey.has(key(requested)) &&
      millis(requested.recorded_at, 'requested terminal') >=
        millis(requestedSlot.scheduledAt, 'requested slot') &&
      millis(requested.recorded_at, 'requested terminal') <
        millis(requestedSlot.closesAt, 'requested slot'),
    )
    check(requestedOnTime, 'requested_issue_late_or_unstarted')
    const requestedKey = key(requested)
    let requestedIssueDbBound =
      requestedOnTime &&
      !anomalies.some(
        (a) =>
          a.endsWith(`:${requestedKey}`) &&
          /^(issue_start_|issue_terminal_|issue_timely_|issue_physical_|issue_identity:)/.test(a),
      ) &&
      !anomalies.includes('requested_issue_seal')
    for (const score of scores) {
      check(
        hash(score.payload) === score.physical_sha256,
        `score_physical_sha:${score.issue_sha256}`,
      )
      try {
        const parsed = JSON.parse(score.payload)
        const { sha256, ...scoreBody } = parsed
        check(
          sha256 === score.score_sha256 &&
            hash(JSON.stringify(scoreBody)) === sha256 &&
            parsed.issueSha256 === score.issue_sha256 &&
            parsed.status === score.status &&
            iso(score.source_as_of, 'score source as-of') === parsed.sourceAsOf &&
            iso(score.scored_at, 'score time') === parsed.scoredAt,
          `score_identity:${score.issue_sha256}`,
        )
        const parent = issueTerminals.find((t) => t.issue_sha256 === score.issue_sha256)
        check(
          Boolean(parent) &&
            xid(score.scorer_xid, 'score xid') !== xid(parent.terminal_xid, 'issue xid') &&
            millis(score.persisted_at, 'score persisted') >=
              millis(parent.recorded_at, 'issue recorded') &&
            millis(score.persisted_at, 'score persisted') >=
              millis(score.scored_at, 'score time') &&
            millis(score.persisted_at, 'score persisted') >=
              millis(score.source_as_of, 'score source as-of'),
          `score_order:${score.issue_sha256}`,
        )
      } catch {
        check(false, `score_payload_invalid:${score.issue_sha256}`)
      }
    }
    const startBySlot = new Map(recorderStarts.map((s) => [s.slot_id, s]))
    const successById = new Map(successSnapshots.map((r) => [r.id, projectSnapshot(r)]))
    const all = allSnapshots.map(projectSnapshot)
    const anchorRow = all.find((r) => r.id === issue.anchor.id)
    let anchorBound = false
    try {
      const anchorSample = normalizeSample(anchorRow)
      anchorBound =
        anchorSample.recorderAtomicV1 === true &&
        anchorSample.createdAt <= millis(issue.issuedAt, 'issue time') / 1000 &&
        isDeepStrictEqual(anchorSample, issue.anchor)
    } catch {
      // Keep the failed physical anchor binding visible as a database anomaly.
    }
    check(anchorBound, 'requested_anchor_snapshot_mismatch')
    requestedIssueDbBound &&= anchorBound
    const issueTimeMs = millis(issue.issuedAt, 'issue time')
    const anchorObservedMs = issue.anchor.firstLocalObservedAt * 1000
    const competingAnchor = all.some(
      (r) =>
        r.id !== issue.anchor.id &&
        r.source === 'observed' &&
        millis(r.created_at, 'candidate created') <= issueTimeMs &&
        millis(r.observed_at, 'candidate observed') <= issueTimeMs &&
        millis(r.observed_at, 'candidate observed') >= anchorObservedMs,
    )
    check(!competingAnchor, 'requested_anchor_not_latest')
    requestedIssueDbBound &&= !competingAnchor
    const coverageStartMs = millis(coverage.start_at, 'coverage start')
    const inWindowRows = all.filter((r) => millis(r.observed_at, 'coverage row') >= coverageStartMs)
    const coverageRows = inWindowRows.filter((r) => r.source === 'observed')
    const allIds = new Set(all.map((r) => r.id))
    const receipts = []
    for (const t of recorderTerminals) {
      const st = startBySlot.get(t.slot_id)
      check(
        Boolean(st) && expectedSlots.has(t.slot_id),
        `recorder_terminal_membership:${t.slot_id}`,
      )
      if (!st) continue
      check(
        xid(t.terminal_xid, 'recorder xid') !== xid(st.starter_xid, 'recorder start xid') &&
          millis(t.completed_at, 'completed') >= millis(st.started_at, 'started'),
        `recorder_terminal_order:${t.slot_id}`,
      )
      const row = t.snapshot_id && successById.get(t.snapshot_id)
      if (t.status === 'success')
        check(Boolean(row && allIds.has(t.snapshot_id)), `success_snapshot_missing:${t.slot_id}`)
      receipts.push({
        slotId: t.slot_id,
        status: t.status,
        attemptedAt: iso(t.completed_at, 'completed'),
        snapshotId: t.snapshot_id,
        snapshotRowSha256: row ? snapshotRowSha256(row) : null,
      })
    }
    for (const st of recorderStarts) {
      check(expectedSlots.has(st.slot_id), `recorder_start_membership:${st.slot_id}`)
      const slotAt = expectedSlots.get(st.slot_id)
      if (slotAt)
        check(
          millis(st.started_at, 'recorder start') >= millis(slotAt, 'recorder slot') &&
            millis(st.started_at, 'recorder start') < millis(slotAt, 'recorder slot') + 3_600_000,
          `recorder_start_clock:${st.slot_id}`,
        )
    }
    const confirmed = !anomalies.some((a) =>
      /^(schedule|coverage)_(confirmation|clock|window)/.test(a),
    )
    let scheduleAudit = null
    let coverageAudit = null
    try {
      if (!confirmed) fail('unconfirmed_schedule_or_coverage')
      scheduleAudit = classifyFirstBreachSchedule({
        scheduleBytes: schedule.payload,
        expectedPhysicalSha256: scheduleSha256,
        asOf,
        attempts,
      })
    } catch (error) {
      anomalies.push(`pure_schedule:${error.message}`)
    }
    try {
      if (
        !confirmed ||
        !requestedIssueDbBound ||
        anomalies.some((a) => a.startsWith('coverage_slot_'))
      )
        fail('unconfirmed_or_unbound_requested_issue_or_coverage')
      coverageAudit = auditHourlyCoverage({
        manifestBytes: coverage.payload,
        expectedManifestPhysicalSha256: manifestSha256,
        issueScheduleBytes: schedule.payload,
        expectedIssueSchedulePhysicalSha256: scheduleSha256,
        issue,
        receipts,
        snapshotRows: coverageRows,
        asOf,
      })
    } catch (error) {
      anomalies.push(`pure_coverage:${error.message}`)
    }
    const requestedScore = scores.find((s) => s.issue_sha256 === issueSha256)
    let requestedScoreReplay = null
    if (
      requestedScore &&
      requestedIssueDbBound &&
      coverageAudit &&
      !anomalies.some((a) => a.startsWith('score_') && a.endsWith(`:${issueSha256}`))
    ) {
      try {
        const anchorMs = issue.anchor.firstLocalObservedAt * 1000
        const closesMs = millis(issue.targetAt, 'issue target') + 8 * 3_600_000
        requestedScoreReplay = replayAaveUsdeV2Score({
          issue,
          storedScorePayload: requestedScore.payload,
          observedRows: all.filter((r) => {
            const observedMs = millis(r.observed_at, 'score row')
            return observedMs > anchorMs && observedMs <= closesMs
          }),
        })
        if (requestedScoreReplay.classification !== 'match')
          anomalies.push(`score_replay_${requestedScoreReplay.classification}:${issueSha256}`)
      } catch (error) {
        anomalies.push(`score_replay_error:${error.message}`)
      }
    }
    return {
      asOf,
      scheduleSha256,
      manifestSha256,
      issueSha256,
      databaseQuery: 'one_repeatable_read_read_only_snapshot_unpaginated',
      databaseConsistency: anomalies.length ? 'anomalies' : 'caller_consistent_only',
      requestedIssueCompleteness: classifyRequestedIssueCompleteness({
        scheduleAudit,
        coverageAudit,
        requestedScoreReplay,
        plannedCells: planned.size,
        issueStarts: issueStarts.length,
        issueTerminals: issueTerminals.length,
        issuedTerminals: issueTerminals.filter((t) => t.status === 'issued').length,
        scores: scores.length,
        expectedCoverageSlots: expectedSlots.size,
        recorderStarts: recorderStarts.length,
        recorderTerminals: recorderTerminals.length,
        collisions: collisions.length,
        anomalies,
      }),
      anomalies,
      inventory: {
        plannedCells: planned.size,
        starts: issueStarts.length,
        terminals: issueTerminals.length,
        unstartedCells: planned.size - issueStarts.length,
        unfinishedCells: issueStarts.length - issueTerminals.length,
        lateTerminals: issueTerminals.filter((t) => t.timely !== true).length,
        failedTerminals: issueTerminals.filter((t) => t.status === 'failed').length,
        abstainedTerminals: issueTerminals.filter((t) => t.status === 'abstained').length,
        collisions: collisions.length,
        scores: scores.length,
        coverageSlots: coverageSlots.length,
        recorderStarts: recorderStarts.length,
        recorderTerminals: recorderTerminals.length,
        unstartedCoverageSlots: expectedSlots.size - recorderStarts.length,
        unfinishedRecorderSlots: recorderStarts.length - recorderTerminals.length,
        observedSnapshotsInWindow: coverageRows.length,
        atomicSnapshotsInWindow: coverageRows.filter((r) => r.recorder_atomic_v1).length,
        otherSourceSnapshotIds: inWindowRows
          .filter((r) => r.source !== 'observed')
          .map((r) => r.id),
        unmarkedSnapshotIds: coverageRows.filter((r) => !r.recorder_atomic_v1).map((r) => r.id),
        unassignedSnapshotIds: coverageRows
          .filter((r) => !recorderTerminals.some((t) => t.snapshot_id === r.id))
          .map((r) => r.id),
      },
      scheduleAudit,
      coverageAudit,
      requestedScoreReplay,
      sourceCompleteness: 'unverified',
      prospectiveEligible: false,
    }
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
