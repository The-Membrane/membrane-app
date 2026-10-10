// Session-based persistence/read boundary for the USDe prospective schedule.
// The manifest publisher and bound attempt functions are installed separately.
import {
  CASH_PUBLISHER_AUDIT_SQL,
  publisherAuditPass,
} from '../apply-aave-usde-cash-publisher-ddl.mjs'
import {
  auditCashSchedule,
  createCashSchedule,
  verifyCashSchedule,
} from './aave-usde-cash-schedule.mjs'

const SHA = /^[0-9a-f]{64}$/
const time = (value) => {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(millis)) throw new Error('Invalid database timestamp')
  return millis
}
const iso = (value) => new Date(time(value)).toISOString()
const unsignedJson = (manifest) => {
  const { sha256, ...body } = manifest
  return JSON.stringify(body)
}

export function validatePersistedSchedule(row, requestedSha, { requireConfirmation = true } = {}) {
  if (!SHA.test(requestedSha) || !row || row.manifest_sha256 !== requestedSha)
    throw new Error('Exact persisted schedule not found')
  if (typeof row.payload !== 'string') throw new Error('Persisted schedule payload must be TEXT')
  let manifest
  try {
    manifest = JSON.parse(row.payload)
  } catch {
    throw new Error('Persisted schedule payload is invalid')
  }
  verifyCashSchedule(manifest)
  if (row.payload !== JSON.stringify(manifest))
    throw new Error('Persisted schedule TEXT is not canonical')
  if (
    manifest.sha256 !== requestedSha ||
    iso(row.planned_at) !== manifest.plannedAt ||
    iso(row.start_at) !== manifest.startAt ||
    iso(row.end_at) !== manifest.endAt ||
    Number(row.cadence_seconds) !== manifest.cadenceSeconds
  )
    throw new Error('Persisted schedule metadata differs from sealed payload')
  const persistedAt = iso(row.persisted_at)
  if (time(persistedAt) < time(manifest.plannedAt) || time(persistedAt) >= time(manifest.startAt))
    throw new Error('Schedule not persisted before its first slot')
  if (row.publisher_xid == null) throw new Error('Schedule publisher transaction ID missing')
  if (row.confirmed_at == null || row.confirmer_xid == null) {
    if (requireConfirmation) throw new Error('Schedule lacks post-commit confirmation')
    if (row.confirmed_at != null || row.confirmer_xid != null)
      throw new Error('Partial schedule post-commit confirmation')
    return { manifest, persistedAt, manifestConfirmation: null }
  }
  const confirmedAt = iso(row.confirmed_at)
  if (
    time(confirmedAt) < time(persistedAt) ||
    time(confirmedAt) > time(manifest.startAt) - 2 * 3600 * 1000 ||
    String(row.confirmer_xid) === String(row.publisher_xid)
  )
    throw new Error('Invalid pre-slot post-commit schedule confirmation')
  return {
    manifest,
    persistedAt,
    manifestConfirmation: {
      manifestSha256: manifest.sha256,
      confirmedAt,
      publisherXid: String(row.publisher_xid),
      confirmerXid: String(row.confirmer_xid),
    },
  }
}

export function classifyScheduleAttempts(manifest, rows) {
  if (!Array.isArray(rows)) throw new Error('Complete schedule attempt query required')
  const slots = new Set(manifest.slots.map((slot) => slot.slotId))
  const bound = []
  const unbound = []
  for (const row of rows) {
    const inWindow =
      time(row.recorded_at) >= time(manifest.startAt) &&
      time(row.recorded_at) < time(manifest.endAt)
    const matchesManifest = row.manifest_sha256 === manifest.sha256
    const matchesSlot = slots.has(row.slot_id)
    if (matchesManifest && matchesSlot) {
      bound.push({
        runId: row.run_id,
        amountUsd: Number(row.amount_usd),
        horizonSeconds: Number(row.horizon_seconds),
        phase: row.phase,
        status: row.status,
        reason: row.reason,
        issueId: row.issue_id,
        publisherXid: row.publisher_xid == null ? null : String(row.publisher_xid),
        recordedAt: iso(row.recorded_at),
        manifestSha256: row.manifest_sha256,
        slotId: row.slot_id,
      })
    } else if (row.manifest_sha256 == null && row.slot_id == null && inWindow) {
      unbound.push({ runId: row.run_id, recordedAt: iso(row.recorded_at) })
    } else {
      // Partial bindings or a second manifest using one of these slots make
      // the cohort ambiguous; the publisher should reject overlapping plans.
      throw new Error('Conflicting or partial schedule attempt binding')
    }
  }
  return {
    bound,
    unboundArmCount: unbound.length,
    unboundRunCount: new Set(unbound.map((row) => row.runId)).size,
  }
}

export function createPgCashScheduleStore(pool) {
  if (typeof pool?.connect !== 'function')
    throw new Error('Session-capable PostgreSQL pool required')

  async function withSession(readOnly, fn) {
    const client = await pool.connect()
    let began = false
    try {
      const audit = await client.query(CASH_PUBLISHER_AUDIT_SQL)
      if (!publisherAuditPass(audit.rows[0])) throw new Error('Cash publisher role audit failed')
      await client.query(
        readOnly
          ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
          : 'BEGIN ISOLATION LEVEL SERIALIZABLE',
      )
      began = true
      const result = await fn(client)
      await client.query('COMMIT')
      began = false
      return result
    } catch (error) {
      if (began) await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async function readManifest(client, manifestSha256, options) {
    if (!SHA.test(manifestSha256)) throw new Error('Canonical manifest SHA required')
    const result = await client.query(
      `SELECT s.manifest_sha256, s.payload, s.planned_at, s.start_at, s.end_at,
              s.cadence_seconds, s.persisted_at, s.publisher_xid,
              c.confirmed_at, c.confirmer_xid
         FROM public.aave_usde_cash_schedules s
         LEFT JOIN public.aave_usde_cash_schedule_confirmations c
           ON c.manifest_sha256=s.manifest_sha256
        WHERE s.manifest_sha256=$1::text`,
      [manifestSha256],
    )
    if (result.rows.length !== 1) throw new Error('Exact persisted schedule not found')
    return validatePersistedSchedule(result.rows[0], manifestSha256, options)
  }

  return {
    async publishFuture({ startAt, endAt }) {
      const published = await withSession(false, async (client) => {
        const clock = await client.query('SELECT clock_timestamp() AS now')
        const plannedAt = iso(clock.rows[0]?.now)
        const manifest = createCashSchedule({ plannedAt, startAt, endAt, cadenceSeconds: 3600 })
        const result = await client.query(
          `SELECT manifest_sha256, inserted, persisted_at
             FROM public.publish_aave_usde_cash_manifest($1::text, $2::text)`,
          [JSON.stringify(manifest), unsignedJson(manifest)],
        )
        const ack = result.rows[0]
        if (
          result.rows.length !== 1 ||
          ack.manifest_sha256 !== manifest.sha256 ||
          typeof ack.inserted !== 'boolean' ||
          time(ack.persisted_at) < time(manifest.plannedAt) ||
          time(ack.persisted_at) >= time(manifest.startAt)
        )
          throw new Error('Invalid schedule publication acknowledgment')
        return { manifest, inserted: ack.inserted, persistedAt: iso(ack.persisted_at) }
      })
      // This is a NEW transaction after the manifest COMMIT. Its read of the
      // manifest proves that COMMIT preceded the confirmation's DB clock.
      const confirmation = await withSession(false, async (client) => {
        const result = await client.query(
          `SELECT manifest_sha256, confirmed_at, inserted
             FROM public.confirm_aave_usde_cash_manifest($1::text)`,
          [published.manifest.sha256],
        )
        const row = result.rows[0]
        if (
          result.rows.length !== 1 ||
          row.manifest_sha256 !== published.manifest.sha256 ||
          typeof row.inserted !== 'boolean' ||
          time(row.confirmed_at) > time(published.manifest.startAt) - 2 * 3600 * 1000
        )
          throw new Error('Invalid schedule post-commit confirmation acknowledgment')
        return { inserted: row.inserted, confirmedAt: iso(row.confirmed_at) }
      })
      const verified = await withSession(true, (client) =>
        readManifest(client, published.manifest.sha256),
      )
      if (
        JSON.stringify(verified.manifest) !== JSON.stringify(published.manifest) ||
        verified.persistedAt !== published.persistedAt ||
        verified.manifestConfirmation.confirmedAt !== confirmation.confirmedAt
      )
        throw new Error('Committed schedule readback differs from publication acknowledgment')
      return { ...published, confirmedAt: confirmation.confirmedAt }
    },

    async loadCurrentSlot(manifestSha256) {
      return withSession(true, async (client) => {
        const { manifest, persistedAt, manifestConfirmation } = await readManifest(
          client,
          manifestSha256,
        )
        const clock = await client.query('SELECT clock_timestamp() AS now')
        const asOf = iso(clock.rows[0]?.now)
        const slot = manifest.slots.find(
          (candidate) =>
            time(candidate.scheduledAt) <= time(asOf) && time(asOf) < time(candidate.closesAt),
        )
        if (!slot) throw new Error('No currently open persisted schedule slot')
        return { manifest, persistedAt, manifestConfirmation, slotId: slot.slotId, asOf }
      })
    },

    async auditPersisted(manifestSha256) {
      return withSession(true, async (client) => {
        // The first statement establishes the repeatable-read snapshot.
        // A later wall clock could cross a slot close while that snapshot
        // still hides a receipt committed between the two instants.
        const clock = await client.query('SELECT transaction_timestamp() AS as_of')
        const asOf = iso(clock.rows[0]?.as_of)
        const { manifest, persistedAt, manifestConfirmation } = await readManifest(
          client,
          manifestSha256,
          { requireConfirmation: false },
        )
        // One unpaginated query in the same repeatable-read snapshot. Include
        // every manifest-bound row (even malformed/out-of-window), rows using
        // these slot IDs under another manifest, and unbound rows in-window.
        const evidence = await client.query(
          `SELECT run_id::text, amount_usd::text, horizon_seconds, phase, status,
                  reason, issue_id::text, recorded_at, manifest_sha256, slot_id,
                  publisher_xid::text
             FROM public.aave_usde_cash_issue_attempts
            WHERE manifest_sha256=$1::text OR slot_id=ANY($2::text[])
               OR (manifest_sha256 IS NULL AND recorded_at >= $3::timestamptz
                   AND recorded_at < $4::timestamptz)
            ORDER BY id`,
          [
            manifest.sha256,
            manifest.slots.map((slot) => slot.slotId),
            manifest.startAt,
            manifest.endAt,
          ],
        )
        if (!Array.isArray(evidence.rows))
          throw new Error('Complete schedule attempt query required')
        if (evidence.rows.some((row) => time(row.recorded_at) > time(asOf)))
          throw new Error('Schedule receipt follows audit snapshot time')
        const classified = classifyScheduleAttempts(manifest, evidence.rows)
        const issueIds = [
          ...new Set(
            classified.bound
              .filter((row) => ['issued', 'duplicate'].includes(row.status))
              .map((row) => row.issueId),
          ),
        ]
        const issues = await client.query(
          `SELECT id::text, amount_usd::text, horizon_seconds, issued_at,
                  persisted_at, target_at, payload_sha256
             FROM public.aave_usde_cash_issues
            WHERE id=ANY($1::uuid[])
            ORDER BY id`,
          [issueIds],
        )
        if (!Array.isArray(issues.rows)) throw new Error('Complete linked issue query required')
        const confirmations = await client.query(
          `SELECT run_id::text, manifest_sha256, slot_id, confirmed_at,
                  confirmer_xid::text, result_xid::text
             FROM public.aave_usde_cash_issue_run_confirmations
            WHERE manifest_sha256=$1::text
            ORDER BY run_id`,
          [manifest.sha256],
        )
        if (!Array.isArray(confirmations.rows))
          throw new Error('Complete issue-run confirmation query required')
        const coverage = auditCashSchedule(manifest, classified.bound, {
          asOf,
          manifestConfirmation,
          issueReceipts: issues.rows,
          issueRunConfirmations: confirmations.rows,
        })
        return {
          manifestSha256: manifest.sha256,
          persistedAt,
          manifestConfirmation,
          asOf,
          query: 'single_unpaginated_repeatable_read_snapshot',
          unboundResearchOnly: {
            runCount: classified.unboundRunCount,
            armReceiptCount: classified.unboundArmCount,
          },
          coverage,
        }
      })
    },
  }
}
