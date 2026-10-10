// DB publication and readback only. No attempt/issue coverage is asserted here.
import {
  SCRVUSD_SCHEDULE_AUDIT_SQL,
  SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL,
  SCRVUSD_SCHEDULE_ASOF_AUDIT_SQL,
  scheduleAuditPass,
  scheduleAttemptAuditPass,
  scheduleAsOfAuditPass,
} from '../apply-scrvusd-now-schedule-ddl.mjs'
import {
  createNowSchedule,
  verifyNowSchedule,
  HOLDER,
  Q_ASSETS_RAW,
  ROUTE,
} from './scrvusd-now-schedule.mjs'
import { createHash } from 'node:crypto'
import {
  boundIssueNameV2,
  buildAttemptStartV1,
  BOUND_STUDY_V2,
  readRow,
} from './scrvusd-exit-forecast-issue.mjs'
import { BOUND_ISSUE_OUT, BOUND_SCORE_OUT } from './scrvusd-bound-paths.mjs'

const SHA = /^[0-9a-f]{64}$/
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const ARMS = [3600, 7200, 86400, 604800]
const millis = (value) => {
  const time = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error('Invalid database timestamp')
  return time
}
const iso = (value) => new Date(millis(value)).toISOString()
const unsignedJson = ({ sha256: _sha256, ...body }) => JSON.stringify(body)
const canonicalUtc = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value

export function verifyPersistedNowSchedule(row, requestedSha) {
  if (!SHA.test(requestedSha ?? '') || !row || row.manifest_sha256 !== requestedSha)
    throw new Error('Exact persisted manifest absent')
  if (typeof row.payload !== 'string') throw new Error('Manifest payload must be TEXT')
  let manifest
  try {
    manifest = JSON.parse(row.payload)
  } catch {
    throw new Error('Manifest payload JSON invalid')
  }
  verifyNowSchedule(manifest)
  if (
    row.payload !== JSON.stringify(manifest) ||
    manifest.sha256 !== requestedSha ||
    iso(row.planned_at) !== manifest.plannedAtUtc ||
    iso(row.start_at) !== manifest.startAtUtc ||
    iso(row.end_at) !== manifest.endAtUtc
  )
    throw new Error('Persisted manifest differs from canonical payload')
  const persistedAtUtc = iso(row.persisted_at)
  const confirmedAtUtc = iso(row.confirmed_at)
  if (
    row.publisher_xid == null ||
    row.confirmer_xid == null ||
    String(row.publisher_xid) === String(row.confirmer_xid) ||
    millis(persistedAtUtc) < millis(manifest.plannedAtUtc) ||
    millis(confirmedAtUtc) < millis(persistedAtUtc) ||
    millis(confirmedAtUtc) > millis(manifest.startAtUtc) - 2 * 3600 * 1000
  )
    throw new Error('Manifest lacks valid pre-slot post-commit confirmation')
  return {
    manifest,
    manifestSha256: requestedSha,
    persistedAtUtc,
    confirmedAtUtc,
    publisherXid: String(row.publisher_xid),
    confirmerXid: String(row.confirmer_xid),
    evidenceClass: 'db_confirmed_manifest_only',
    prospectiveScheduleConfirmed: true,
    runCoverageConfirmed: false,
    calibratedForecastEligible: false,
  }
}

export function verifyManifestVisibility(row, requestedSha) {
  const confirmed = verifyPersistedNowSchedule(row, requestedSha)
  const manifestVisibleAtUtc = iso(row.manifest_visible_at)
  const witnessXid = String(row.witness_xid)
  if (
    !/^[1-9][0-9]*$/.test(witnessXid) ||
    witnessXid === confirmed.publisherXid ||
    witnessXid === confirmed.confirmerXid ||
    millis(manifestVisibleAtUtc) < millis(confirmed.confirmedAtUtc) ||
    millis(manifestVisibleAtUtc) > millis(confirmed.manifest.startAtUtc) - 2 * 3600 * 1000
  )
    throw new Error('Committed manifest visibility witness invalid')
  return {
    ...confirmed,
    manifestVisibleAtUtc,
    witnessXid,
    evidenceClass: 'db_witnessed_manifest',
    historicalPublicationAvailabilityCertified: true,
  }
}

export function createPgNowScheduleStore(pool) {
  if (typeof pool?.connect !== 'function')
    throw new Error('Session-capable PostgreSQL pool required')

  async function withSession(readOnly, fn) {
    const client = await pool.connect()
    let began = false
    try {
      const audit = await client.query(SCRVUSD_SCHEDULE_AUDIT_SQL)
      if (!scheduleAuditPass(audit.rows?.[0]))
        throw new Error('scrvUSD schedule publisher role audit failed')
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

  async function readConfirmed(client, sha256) {
    if (!SHA.test(sha256 ?? '')) throw new Error('Canonical manifest SHA required')
    const result = await client.query(
      `SELECT m.manifest_sha256,m.payload,m.planned_at,m.start_at,m.end_at,
              m.persisted_at,m.publisher_xid,c.confirmed_at,c.confirmer_xid
         FROM public.scrvusd_now_manifests m
         JOIN public.scrvusd_now_manifest_confirmations c
           ON c.manifest_sha256=m.manifest_sha256
        WHERE m.manifest_sha256=$1::text`,
      [sha256],
    )
    if (result.rows.length !== 1) throw new Error('Exact confirmed manifest absent')
    return verifyPersistedNowSchedule(result.rows[0], sha256)
  }

  async function readWitness(client, sha256) {
    if (!SHA.test(sha256 ?? '')) throw new Error('Canonical manifest SHA required')
    const result = await client.query(
      `SELECT m.manifest_sha256,m.payload,m.planned_at,m.start_at,m.end_at,
              m.persisted_at,m.publisher_xid,c.confirmed_at,c.confirmer_xid,
              v.manifest_visible_at,v.witness_xid
         FROM public.scrvusd_now_manifest_visibility v
         JOIN public.scrvusd_now_manifests m USING(manifest_sha256)
         JOIN public.scrvusd_now_manifest_confirmations c USING(manifest_sha256)
        WHERE v.manifest_sha256=$1::text`,
      [sha256],
    )
    if (result.rows.length !== 1) throw new Error('Exact witnessed manifest absent')
    return verifyManifestVisibility(result.rows[0], sha256)
  }

  async function witnessManifest(sha256) {
    if (!SHA.test(sha256 ?? '')) throw new Error('Canonical manifest SHA required')
    const ack = await withSession(false, async (client) => {
      const result = await client.query(
        'SELECT manifest_visible_at,witness_xid FROM public.witness_scrvusd_now_manifest($1::text)',
        [sha256],
      )
      if (result.rows?.length !== 1) throw new Error('Exact manifest witness acknowledgment absent')
      return result.rows[0]
    })
    const verified = await withSession(true, (client) => readWitness(client, sha256))
    if (
      verified.manifestVisibleAtUtc !== iso(ack.manifest_visible_at) ||
      verified.witnessXid !== String(ack.witness_xid)
    )
      throw new Error('Committed manifest witness differs from acknowledgment')
    return verified
  }

  return {
    async readConfirmed(sha256) {
      return withSession(true, (client) => readConfirmed(client, sha256))
    },

    async readManifestWitness(sha256) {
      return withSession(true, (client) => readWitness(client, sha256))
    },

    witnessManifest,

    async reconcileFuture(sha256) {
      if (!SHA.test(sha256 ?? '')) throw new Error('Canonical manifest SHA required')
      try {
        await withSession(true, (client) => readConfirmed(client, sha256))
      } catch (error) {
        if (error.message !== 'Exact confirmed manifest absent') throw error
        await withSession(false, async (client) => {
          const result = await client.query(
            'SELECT manifest_sha256,confirmed_at,inserted FROM public.confirm_scrvusd_now_manifest($1::text)',
            [sha256],
          )
          if (result.rows?.length !== 1 || result.rows[0].manifest_sha256 !== sha256)
            throw new Error('Exact manifest confirmation reconciliation failed')
        })
        await withSession(true, (client) => readConfirmed(client, sha256))
      }
      return witnessManifest(sha256)
    },

    async publishFuture({ startAtUtc, endAtUtc }) {
      // The server clock is the only source of the proposed plan time.
      const published = await withSession(false, async (client) => {
        const clock = await client.query('SELECT pg_catalog.clock_timestamp() AS now')
        const plannedAtUtc = iso(clock.rows?.[0]?.now)
        const manifest = createNowSchedule({ plannedAtUtc, startAtUtc, endAtUtc })
        const result = await client.query(
          `SELECT manifest_sha256,inserted,persisted_at
             FROM public.publish_scrvusd_now_manifest($1::text,$2::text)`,
          [JSON.stringify(manifest), unsignedJson(manifest)],
        )
        const row = result.rows?.[0]
        if (
          result.rows.length !== 1 ||
          row.manifest_sha256 !== manifest.sha256 ||
          row.inserted !== true ||
          millis(row.persisted_at) < millis(manifest.plannedAtUtc) ||
          millis(row.persisted_at) > millis(manifest.startAtUtc) - 2 * 3600 * 1000
        )
          throw new Error('Invalid manifest publication acknowledgment')
        return { manifest, persistedAtUtc: iso(row.persisted_at) }
      })
      try {
        // A fresh transaction reading the committed row proves visibility before
        // the confirmation timestamp. Confirmation itself commits separately.
        const confirmation = await withSession(false, async (client) => {
          const result = await client.query(
            `SELECT manifest_sha256,confirmed_at,inserted
             FROM public.confirm_scrvusd_now_manifest($1::text)`,
            [published.manifest.sha256],
          )
          const row = result.rows?.[0]
          if (
            result.rows.length !== 1 ||
            row.manifest_sha256 !== published.manifest.sha256 ||
            row.inserted !== true ||
            millis(row.confirmed_at) > millis(published.manifest.startAtUtc) - 2 * 3600 * 1000
          )
            throw new Error('Invalid post-commit confirmation acknowledgment')
          return iso(row.confirmed_at)
        })
        const verified = await withSession(true, (client) =>
          readConfirmed(client, published.manifest.sha256),
        )
        if (
          JSON.stringify(verified.manifest) !== JSON.stringify(published.manifest) ||
          verified.persistedAtUtc !== published.persistedAtUtc ||
          verified.confirmedAtUtc !== confirmation
        )
          throw new Error('Committed manifest readback differs from publication')
        return await witnessManifest(published.manifest.sha256)
      } catch (error) {
        // A committed publish can survive a lost confirmation or witness reply.
        // Give the caller the exact immutable key for audited reconciliation.
        error.manifestSha256 = published.manifest.sha256
        throw error
      }
    },
  }
}

// This adapter checks exact local bytes and the dedicated DB role. DB rows
// remain operational reports until a separate source verifier authenticates
// the v2 issue and all capture timestamps against confirmed start visibility.
export function createPgNowAttemptStore(pool) {
  if (typeof pool?.connect !== 'function')
    throw new Error('Session-capable PostgreSQL pool required')
  async function transaction(readOnly, fn) {
    const client = await pool.connect()
    let began = false
    try {
      const base = await client.query(SCRVUSD_SCHEDULE_AUDIT_SQL)
      const attempts = await client.query(SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL)
      if (!scheduleAuditPass(base.rows?.[0]) || !scheduleAttemptAuditPass(attempts.rows?.[0]))
        throw new Error('scrvUSD attempt publisher role audit failed')
      await client.query(
        readOnly
          ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
          : 'BEGIN ISOLATION LEVEL SERIALIZABLE',
      )
      began = true
      const output = await fn(client)
      await client.query('COMMIT')
      began = false
      return output
    } catch (error) {
      if (began) await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  const exact = (result, name) => {
    if (result.rows?.length !== 1) throw new Error(`Exact ${name} acknowledgment absent`)
    return result.rows[0]
  }
  return {
    async startArm({ manifest, slotId, horizonSeconds, startReceipt, physicalSha256 }) {
      const schedule = verifyNowSchedule(manifest)
      const expected = buildAttemptStartV1({
        manifest: schedule,
        slotId,
        horizonSeconds,
        recordedAtUtc: startReceipt?.recordedAtUtc,
      })
      const payload = JSON.stringify(expected)
      if (payload !== JSON.stringify(startReceipt) || physicalSha256 !== hash(`${payload}\n`))
        throw new Error('Exact canonical attempt-start bytes required')
      const row = await transaction(false, async (client) =>
        exact(
          await client.query(
            `SELECT started_at,start_xid FROM public.start_scrvusd_now_arm(
          $1::text,$2::text,$3::integer,$4::text,$5::text,$6::timestamptz,$7::text)`,
            [
              schedule.sha256,
              slotId,
              horizonSeconds,
              expected.sha256,
              physicalSha256,
              expected.recordedAtUtc,
              payload,
            ],
          ),
          'start',
        ),
      )
      return {
        manifestSha256: schedule.sha256,
        slotId,
        horizonSeconds,
        startLogicalSha256: expected.sha256,
        startPhysicalSha256: physicalSha256,
        startedAtUtc: iso(row.started_at),
        startXid: String(row.start_xid),
        status: 'start_committed_result_missing',
      }
    },
    async confirmStarts({ manifestSha256, slotId }) {
      if (!SHA.test(manifestSha256) || !SHA.test(slotId))
        throw new Error('Exact schedule slot required')
      const row = await transaction(false, async (client) =>
        exact(
          await client.query(
            `SELECT confirmed_at,confirmer_xid FROM public.confirm_scrvusd_now_starts($1::text,$2::text)`,
            [manifestSha256, slotId],
          ),
          'four-start confirmation',
        ),
      )
      // The capture floor reads the committed four-start confirmation in a
      // separate transaction, then another read proves that floor committed.
      const floor = await transaction(false, async (client) =>
        exact(
          await client.query(
            `SELECT visible_at,visibility_xid FROM public.mark_scrvusd_now_capture_floor($1::text,$2::text)`,
            [manifestSha256, slotId],
          ),
          'post-confirm capture floor',
        ),
      )
      const readback = await this.readRun({ manifestSha256, slotId })
      if (
        readback.startConfirmedAtUtc !== iso(row.confirmed_at) ||
        readback.sourceCaptureFloorUtc !== iso(floor.visible_at)
      )
        throw new Error('Committed start/floor readback mismatch')
      return readback
    },
    async resultArm({
      manifestSha256,
      slotId,
      horizonSeconds,
      status,
      reason,
      issueReceipt,
      issuePhysicalSha256,
    }) {
      if (
        !SHA.test(manifestSha256) ||
        !SHA.test(slotId) ||
        !ARMS.includes(horizonSeconds) ||
        !['issued', 'abstained', 'failed', 'unknown'].includes(status)
      )
        throw new Error('Exact fixed schedule arm required')
      let logical = null
      let physical = null
      let issuedAtUtc = null
      let issuePayload = null
      if (status === 'issued') {
        const bytes = JSON.stringify(issueReceipt)
        const { sha256: _sha256, ...unsigned } = issueReceipt ?? {}
        if (
          issueReceipt?.study !== BOUND_STUDY_V2 ||
          issueReceipt?.scheduleBinding?.manifestSha256 !== manifestSha256 ||
          issueReceipt?.scheduleBinding?.slotId !== slotId ||
          issueReceipt?.scheduleBinding?.horizonSeconds !== horizonSeconds ||
          issueReceipt?.horizonSeconds !== horizonSeconds ||
          issueReceipt?.holder !== HOLDER ||
          issueReceipt?.qAssetsRaw !== Q_ASSETS_RAW ||
          issueReceipt?.route !== ROUTE ||
          !SHA.test(issueReceipt?.sha256) ||
          issueReceipt.sha256 !== hash(JSON.stringify(unsigned)) ||
          issuePhysicalSha256 !== hash(`${bytes}\n`)
        )
          throw new Error('Issued result lacks exact sealed v2 local bytes')
        logical = issueReceipt.sha256
        physical = issuePhysicalSha256
        issuePayload = bytes
        issuedAtUtc = iso(issueReceipt.issuedAtUtc)
        if (reason !== 'issued') throw new Error('Issued result reason must be issued')
      } else if (issueReceipt != null || issuePhysicalSha256 != null || reason === 'issued') {
        throw new Error('Non-issued result cannot bind issue bytes')
      }
      const row = await transaction(false, async (client) =>
        exact(
          await client.query(
            `SELECT result_at,result_xid FROM public.result_scrvusd_now_arm(
          $1::text,$2::text,$3::integer,$4::text,$5::text,$6::text,$7::text,$8::timestamptz,$9::text)`,
            [
              manifestSha256,
              slotId,
              horizonSeconds,
              status,
              reason,
              logical,
              physical,
              issuedAtUtc,
              issuePayload,
            ],
          ),
          'result',
        ),
      )
      return {
        manifestSha256,
        slotId,
        horizonSeconds,
        status: status === 'issued' ? 'db_reported_issued_unverified' : status,
        resultAtUtc: iso(row.result_at),
        resultXid: String(row.result_xid),
      }
    },
    async confirmRun({ manifestSha256, slotId }) {
      if (!SHA.test(manifestSha256) || !SHA.test(slotId))
        throw new Error('Exact schedule slot required')
      const row = await transaction(false, async (client) =>
        exact(
          await client.query(
            `SELECT confirmed_at,confirmer_xid FROM public.confirm_scrvusd_now_run($1::text,$2::text)`,
            [manifestSha256, slotId],
          ),
          'run confirmation',
        ),
      )
      const readback = await this.readRun({ manifestSha256, slotId })
      if (readback.runConfirmedAtUtc !== iso(row.confirmed_at))
        throw new Error('Committed run confirmation readback mismatch')
      return readback
    },
    async readRun({ manifestSha256, slotId }) {
      if (!SHA.test(manifestSha256) || !SHA.test(slotId))
        throw new Error('Exact schedule slot required')
      return transaction(true, async (client) => {
        const rows = await client.query(
          `SELECT a.horizon_seconds,a.start_logical_sha256,a.start_physical_sha256,
                  a.start_payload,a.local_recorded_at,a.started_at,a.start_xid,
                  r.status,r.reason,r.issue_logical_sha256,r.issue_physical_sha256,
                  r.issue_payload,r.local_issued_at,r.result_at,r.result_xid
             FROM public.scrvusd_now_arm_starts a
        LEFT JOIN public.scrvusd_now_arm_results r USING(manifest_sha256,slot_id,horizon_seconds)
            WHERE a.manifest_sha256=$1::text AND a.slot_id=$2::text
            ORDER BY a.horizon_seconds`,
          [manifestSha256, slotId],
        )
        const confirms = await client.query(
          `SELECT m.payload,s.confirmed_at AS start_confirmed_at,s.confirmer_xid AS start_confirmer_xid,
                  f.visible_at AS capture_floor_at,f.visibility_xid AS capture_floor_xid,
                  c.confirmed_at AS run_confirmed_at,c.confirmer_xid AS run_confirmer_xid
             FROM public.scrvusd_now_manifests m
        LEFT JOIN public.scrvusd_now_start_confirmations s
               ON s.manifest_sha256=m.manifest_sha256 AND s.slot_id=$2::text
        LEFT JOIN public.scrvusd_now_capture_floors f
               ON f.manifest_sha256=m.manifest_sha256 AND f.slot_id=$2::text
        LEFT JOIN public.scrvusd_now_run_confirmations c
               ON c.manifest_sha256=m.manifest_sha256 AND c.slot_id=$2::text
            WHERE m.manifest_sha256=$1::text`,
          [manifestSha256, slotId],
        )
        if (confirms.rows?.length !== 1) throw new Error('Exact manifest absent')
        const persistedManifest = verifyNowSchedule(JSON.parse(confirms.rows[0].payload))
        if (
          persistedManifest.sha256 !== manifestSha256 ||
          !persistedManifest.slots.some((slot) => slot.slotId === slotId)
        )
          throw new Error('Exact slot absent from committed manifest')
        const starts = new Map()
        for (const row of rows.rows ?? []) {
          if (!ARMS.includes(row.horizon_seconds) || starts.has(row.horizon_seconds))
            throw new Error('Duplicate or alien arm in DB readback')
          const payload = JSON.parse(row.start_payload)
          const { sha256: _startSha256, ...unsignedStart } = payload
          if (
            payload.sha256 !== row.start_logical_sha256 ||
            hash(JSON.stringify(unsignedStart)) !== row.start_logical_sha256 ||
            hash(`${row.start_payload}\n`) !== row.start_physical_sha256 ||
            payload.manifestSha256 !== manifestSha256 ||
            payload.slotId !== slotId ||
            payload.horizonSeconds !== row.horizon_seconds
          )
            throw new Error('Committed start payload mismatch')
          if (row.status === 'issued') {
            const issued = JSON.parse(row.issue_payload)
            const { sha256: _sha256, ...unsigned } = issued
            if (
              issued.study !== BOUND_STUDY_V2 ||
              issued.sha256 !== row.issue_logical_sha256 ||
              hash(JSON.stringify(unsigned)) !== row.issue_logical_sha256 ||
              hash(`${row.issue_payload}\n`) !== row.issue_physical_sha256 ||
              issued.scheduleBinding?.manifestSha256 !== manifestSha256 ||
              issued.scheduleBinding?.slotId !== slotId ||
              issued.scheduleBinding?.horizonSeconds !== row.horizon_seconds ||
              issued.horizonSeconds !== row.horizon_seconds ||
              issued.holder !== HOLDER ||
              issued.qAssetsRaw !== Q_ASSETS_RAW ||
              issued.route !== ROUTE ||
              issued.scheduleBinding?.attemptStart?.logicalSha256 !== row.start_logical_sha256 ||
              issued.scheduleBinding?.attemptStart?.physicalSha256 !== row.start_physical_sha256
            )
              throw new Error('Committed issue payload or start binding mismatch')
          }
          starts.set(row.horizon_seconds, {
            horizonSeconds: row.horizon_seconds,
            status:
              row.status == null
                ? 'result_missing'
                : row.status === 'issued'
                  ? 'db_reported_issued_unverified'
                  : row.status,
            startedAtUtc: iso(row.started_at),
            startXid: row.start_xid == null ? null : String(row.start_xid),
            startPayload: row.start_payload,
            resultAtUtc: row.result_at && iso(row.result_at),
            resultXid: row.result_xid == null ? null : String(row.result_xid),
            startLogicalSha256: row.start_logical_sha256,
            startPhysicalSha256: row.start_physical_sha256,
            issueLogicalSha256: row.issue_logical_sha256,
            issuePhysicalSha256: row.issue_physical_sha256,
            issuePayload: row.issue_payload,
          })
        }
        const confirmation = confirms.rows[0]
        const arms = ARMS.map(
          (horizonSeconds) =>
            starts.get(horizonSeconds) ?? { horizonSeconds, status: 'start_missing' },
        )
        return {
          manifestSha256,
          slotId,
          arms,
          startConfirmedAtUtc:
            confirmation.start_confirmed_at && iso(confirmation.start_confirmed_at),
          startConfirmerXid:
            confirmation.start_confirmer_xid == null
              ? null
              : String(confirmation.start_confirmer_xid),
          sourceCaptureFloorUtc:
            confirmation.capture_floor_at && iso(confirmation.capture_floor_at),
          captureFloorXid:
            confirmation.capture_floor_xid == null ? null : String(confirmation.capture_floor_xid),
          runConfirmedAtUtc: confirmation.run_confirmed_at && iso(confirmation.run_confirmed_at),
          runConfirmerXid:
            confirmation.run_confirmer_xid == null ? null : String(confirmation.run_confirmer_xid),
          runCoverageConfirmed:
            Boolean(confirmation.run_confirmed_at) &&
            arms.every((arm) => arm.status !== 'start_missing' && arm.status !== 'result_missing'),
          calibratedForecastEligible: false,
          evidenceClass: 'db_operational_attempt_report_only',
        }
      })
    },
  }
}

// Additive historical-availability receipts. No caller should promote an old
// v2 issue or score until its separate visibility witness is freshly read.
export function createPgNowAsOfStore(pool) {
  if (typeof pool?.connect !== 'function')
    throw new Error('Session-capable PostgreSQL pool required')
  async function transaction(readOnly, fn) {
    const client = await pool.connect()
    let began = false
    try {
      const base = await client.query(SCRVUSD_SCHEDULE_AUDIT_SQL)
      const attempts = await client.query(SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL)
      const asof = await client.query(SCRVUSD_SCHEDULE_ASOF_AUDIT_SQL)
      if (
        !scheduleAuditPass(base.rows?.[0]) ||
        !scheduleAttemptAuditPass(attempts.rows?.[0]) ||
        !scheduleAsOfAuditPass(asof.rows?.[0])
      )
        throw new Error('scrvUSD as-of publisher role audit failed')
      await client.query(
        readOnly
          ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
          : 'BEGIN ISOLATION LEVEL SERIALIZABLE',
      )
      began = true
      const value = await fn(client)
      await client.query('COMMIT')
      began = false
      return value
    } catch (error) {
      if (began) await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  const slot = (manifestSha256, slotId) => {
    if (!SHA.test(manifestSha256) || !SHA.test(slotId))
      throw new Error('Exact schedule slot required')
  }
  const arm = (manifestSha256, slotId, horizonSeconds) => {
    slot(manifestSha256, slotId)
    if (!ARMS.includes(horizonSeconds)) throw new Error('Exact fixed schedule arm required')
  }
  const one = (query, kind) => {
    if (query.rows?.length !== 1) throw new Error(`Exact ${kind} acknowledgment absent`)
    return query.rows[0]
  }
  return {
    async listPublishedSlotCensus({ asOfUtc }) {
      if (!canonicalUtc(asOfUtc)) throw new Error('Canonical asOfUtc required')
      return transaction(true, async (client) => {
        const result = await client.query(
          `SELECT m.manifest_sha256,m.payload,m.planned_at,m.start_at,m.end_at,
                  m.persisted_at,m.publisher_xid,c.confirmed_at,c.confirmer_xid,
                  mv.manifest_visible_at,mv.witness_xid AS manifest_witness_xid,
                  slot.value->>'slotId' AS slot_id,
                  slot.value->>'scheduledAtUtc' AS scheduled_at_utc,
                  slot.value->>'closesAtUtc' AS closes_at_utc,
                  (SELECT pg_catalog.count(*) FROM public.scrvusd_now_arm_starts a
                    WHERE a.manifest_sha256=m.manifest_sha256
                      AND a.slot_id=slot.value->>'slotId'
                      AND a.started_at <= $1::timestamptz) AS started_count,
                  (SELECT pg_catalog.count(*) FROM public.scrvusd_now_arm_results r
                    WHERE r.manifest_sha256=m.manifest_sha256
                      AND r.slot_id=slot.value->>'slotId'
                      AND r.result_at <= $1::timestamptz) AS result_count,
                  sc.confirmed_at AS starts_confirmed_at,
                  f.visible_at AS capture_floor_at,
                  ss.source_start_at,
                  rc.confirmed_at AS run_confirmed_at,
                  rv.run_visible_at
             FROM public.scrvusd_now_manifests m
       CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(m.payload::jsonb->'slots') slot(value)
        LEFT JOIN public.scrvusd_now_manifest_confirmations c
               ON c.manifest_sha256=m.manifest_sha256
              AND c.confirmed_at <= $1::timestamptz
        LEFT JOIN public.scrvusd_now_manifest_visibility mv
               ON mv.manifest_sha256=m.manifest_sha256
              AND mv.manifest_visible_at <= $1::timestamptz
        LEFT JOIN public.scrvusd_now_start_confirmations sc
               ON sc.manifest_sha256=m.manifest_sha256
              AND sc.slot_id=slot.value->>'slotId'
              AND sc.confirmed_at <= $1::timestamptz
        LEFT JOIN public.scrvusd_now_capture_floors f
               ON f.manifest_sha256=m.manifest_sha256
              AND f.slot_id=slot.value->>'slotId'
              AND f.visible_at <= $1::timestamptz
        LEFT JOIN public.scrvusd_now_source_starts ss
               ON ss.manifest_sha256=m.manifest_sha256
              AND ss.slot_id=slot.value->>'slotId'
              AND ss.source_start_at <= $1::timestamptz
        LEFT JOIN public.scrvusd_now_run_confirmations rc
               ON rc.manifest_sha256=m.manifest_sha256
              AND rc.slot_id=slot.value->>'slotId'
              AND rc.confirmed_at <= $1::timestamptz
        LEFT JOIN public.scrvusd_now_run_visibility rv
               ON rv.manifest_sha256=m.manifest_sha256
              AND rv.slot_id=slot.value->>'slotId'
              AND rv.run_visible_at <= $1::timestamptz
            WHERE m.persisted_at <= $1::timestamptz
              AND (slot.value->>'scheduledAtUtc')::timestamptz <= $1::timestamptz
            ORDER BY m.manifest_sha256,slot_id`,
          [asOfUtc],
        )
        const slots = []
        const seenSlots = new Set()
        for (const row of result.rows ?? []) {
          const manifest = verifyNowSchedule(JSON.parse(row.payload))
          const slot = manifest.slots.find((item) => item.slotId === row.slot_id)
          const confirmed = row.confirmed_at != null
          const manifestWitnessed = row.manifest_visible_at != null
          const startedArms = Number(row.started_count)
          const reportedResults = Number(row.result_count)
          if (
            manifest.sha256 !== row.manifest_sha256 ||
            row.payload !== JSON.stringify(manifest) ||
            !slot ||
            slot.scheduledAtUtc !== row.scheduled_at_utc ||
            slot.closesAtUtc !== row.closes_at_utc ||
            seenSlots.has(row.slot_id) ||
            iso(row.planned_at) !== manifest.plannedAtUtc ||
            iso(row.start_at) !== manifest.startAtUtc ||
            iso(row.end_at) !== manifest.endAtUtc ||
            millis(row.persisted_at) < millis(manifest.plannedAtUtc) ||
            millis(row.persisted_at) > millis(asOfUtc) ||
            millis(slot.scheduledAtUtc) > millis(asOfUtc) ||
            !/^[1-9][0-9]*$/.test(String(row.publisher_xid)) ||
            !Number.isInteger(startedArms) ||
            startedArms < 0 ||
            startedArms > ARMS.length ||
            !Number.isInteger(reportedResults) ||
            reportedResults < 0 ||
            reportedResults > startedArms ||
            (confirmed && millis(row.confirmed_at) > millis(asOfUtc)) ||
            (manifestWitnessed &&
              (!confirmed ||
                millis(row.manifest_visible_at) > millis(asOfUtc) ||
                row.manifest_witness_xid == null)) ||
            (!manifestWitnessed && row.manifest_witness_xid != null) ||
            (!confirmed &&
              (row.confirmer_xid != null ||
                startedArms !== 0 ||
                reportedResults !== 0 ||
                row.starts_confirmed_at != null ||
                row.capture_floor_at != null ||
                row.source_start_at != null ||
                row.run_confirmed_at != null ||
                row.run_visible_at != null)) ||
            (row.starts_confirmed_at != null && startedArms !== ARMS.length) ||
            (reportedResults > 0 &&
              (row.starts_confirmed_at == null ||
                row.capture_floor_at == null ||
                row.source_start_at == null)) ||
            (row.capture_floor_at != null && row.starts_confirmed_at == null) ||
            (row.capture_floor_at != null &&
              millis(row.capture_floor_at) < millis(row.starts_confirmed_at)) ||
            (row.source_start_at != null && row.capture_floor_at == null) ||
            (row.source_start_at != null &&
              millis(row.source_start_at) < millis(row.capture_floor_at)) ||
            (row.run_confirmed_at != null && reportedResults !== ARMS.length) ||
            (row.run_confirmed_at != null &&
              millis(row.run_confirmed_at) < millis(row.source_start_at)) ||
            (row.run_visible_at != null &&
              (!manifestWitnessed ||
                row.run_confirmed_at == null ||
                reportedResults !== ARMS.length ||
                millis(row.run_visible_at) < millis(row.run_confirmed_at)))
          )
            throw new Error('Malformed or duplicate as-of published slot census row')
          if (confirmed)
            verifyPersistedNowSchedule(
              {
                ...row,
                confirmed_at: row.confirmed_at,
                confirmer_xid: row.confirmer_xid,
              },
              manifest.sha256,
            )
          if (manifestWitnessed)
            verifyManifestVisibility(
              { ...row, witness_xid: row.manifest_witness_xid },
              manifest.sha256,
            )
          seenSlots.add(row.slot_id)
          const attempted = startedArms > 0
          const witnessed = row.run_visible_at != null
          slots.push({
            manifestSha256: manifest.sha256,
            slotId: row.slot_id,
            scheduledAtUtc: slot.scheduledAtUtc,
            closesAtUtc: slot.closesAtUtc,
            publicationStatus: manifestWitnessed
              ? 'witnessed_by_cutoff'
              : confirmed
                ? 'confirmed_timestamp_only'
                : 'unconfirmed_at_cutoff',
            status: !confirmed
              ? 'publication_unconfirmed'
              : witnessed
                ? 'witnessed'
                : attempted
                  ? 'partial'
                  : millis(slot.closesAtUtc) <= millis(asOfUtc)
                    ? 'missed'
                    : 'open_not_attempted',
            startedArms,
            reportedResults,
            runVisibleAtUtc: witnessed ? iso(row.run_visible_at) : null,
            manifestVisibleAtUtc: manifestWitnessed ? iso(row.manifest_visible_at) : null,
            historicalPublicationAvailabilityCertified: manifestWitnessed,
            operationalStatusHistoricalAvailabilityCertified: false,
            operationalStatusSemantics: 'retrospective_database_timestamps',
          })
        }
        const certifiedSlots = slots.filter(
          (slot) => slot.historicalPublicationAvailabilityCertified,
        )
        const unwitnessedOperationalGaps = slots.filter(
          (slot) => !slot.historicalPublicationAvailabilityCertified,
        )
        return {
          asOfUtc,
          slots,
          certifiedSlots,
          unwitnessedOperationalGaps,
          counts: {
            scheduledByCutoff: slots.length,
            witnessedManifestScheduledByCutoff: certifiedSlots.length,
            unwitnessedManifestOperationalGaps: unwitnessedOperationalGaps.length,
            confirmedTimestampByCutoff: slots.filter(
              (slot) => slot.publicationStatus !== 'unconfirmed_at_cutoff',
            ).length,
            attempted: slots.filter((slot) => slot.startedArms > 0).length,
            witnessed: slots.filter((slot) => slot.status === 'witnessed').length,
            missed: slots.filter((slot) => slot.status === 'missed').length,
            partial: slots.filter((slot) => slot.status === 'partial').length,
            openNotAttempted: slots.filter((slot) => slot.status === 'open_not_attempted').length,
            publicationUnconfirmed: slots.filter(
              (slot) => slot.status === 'publication_unconfirmed',
            ).length,
          },
          historicalPublicationAvailabilityCertified: false,
          operationalStatusHistoricalAvailabilityCertified: false,
          operationalStatusSemantics: 'retrospective_database_timestamps',
          chronologicalBacktestEligible: false,
        }
      })
    },
    async listWitnessedCohort({ asOfUtc }) {
      if (!canonicalUtc(asOfUtc)) throw new Error('Canonical asOfUtc required')
      return transaction(true, async (client) => {
        const runsQuery = await client.query(
          `SELECT v.manifest_sha256,v.slot_id,v.run_visible_at,v.witness_xid,
                  c.confirmed_at,c.confirmer_xid,s.source_start_at,s.source_start_xid,
                  s.nonce_sha256,m.payload AS manifest_payload
             FROM public.scrvusd_now_run_visibility v
        LEFT JOIN public.scrvusd_now_run_confirmations c USING(manifest_sha256,slot_id)
        LEFT JOIN public.scrvusd_now_source_starts s USING(manifest_sha256,slot_id)
        LEFT JOIN public.scrvusd_now_manifests m USING(manifest_sha256)
            WHERE v.run_visible_at <= $1::timestamptz
            ORDER BY v.manifest_sha256,v.slot_id`,
          [asOfUtc],
        )
        const armsQuery = await client.query(
          `SELECT r.manifest_sha256,r.slot_id,r.horizon_seconds,r.status,r.reason,
                  r.issue_logical_sha256,r.issue_physical_sha256,r.issue_payload,
                  r.local_issued_at,r.result_at,r.result_xid
             FROM public.scrvusd_now_run_visibility v
             JOIN public.scrvusd_now_arm_results r USING(manifest_sha256,slot_id)
            WHERE v.run_visible_at <= $1::timestamptz
            ORDER BY r.manifest_sha256,r.slot_id,r.horizon_seconds`,
          [asOfUtc],
        )
        const scoresQuery = await client.query(
          `SELECT s.manifest_sha256,s.slot_id,s.horizon_seconds,
                  s.issue_logical_sha256,s.issue_physical_sha256,s.score_filename,
                  s.score_logical_sha256,s.score_physical_sha256,s.score_payload,
                  s.score_recorded_at,s.score_xid,w.score_visible_at,w.witness_xid
             FROM public.scrvusd_now_run_visibility v
             JOIN public.scrvusd_now_score_visibility w USING(manifest_sha256,slot_id)
             JOIN public.scrvusd_now_scores s USING(manifest_sha256,slot_id,horizon_seconds)
            WHERE v.run_visible_at <= $1::timestamptz
              AND w.score_visible_at <= $1::timestamptz
            ORDER BY s.manifest_sha256,s.slot_id,s.horizon_seconds`,
          [asOfUtc],
        )
        const key = (row) => `${row.manifest_sha256}:${row.slot_id}`
        const runs = new Map()
        for (const row of runsQuery.rows ?? []) {
          const id = key(row)
          const manifest = verifyNowSchedule(JSON.parse(row.manifest_payload))
          if (
            runs.has(id) ||
            !SHA.test(row.manifest_sha256 ?? '') ||
            !SHA.test(row.slot_id ?? '') ||
            manifest.sha256 !== row.manifest_sha256 ||
            !manifest.slots.some((item) => item.slotId === row.slot_id) ||
            !SHA.test(row.nonce_sha256 ?? '') ||
            !/^[1-9][0-9]*$/.test(String(row.witness_xid)) ||
            !/^[1-9][0-9]*$/.test(String(row.confirmer_xid)) ||
            !/^[1-9][0-9]*$/.test(String(row.source_start_xid)) ||
            millis(row.run_visible_at) > millis(asOfUtc) ||
            millis(row.source_start_at) > millis(row.confirmed_at) ||
            millis(row.run_visible_at) < millis(row.confirmed_at) ||
            millis(row.run_visible_at) < millis(row.source_start_at) ||
            String(row.witness_xid) === String(row.confirmer_xid) ||
            String(row.witness_xid) === String(row.source_start_xid)
          )
            throw new Error('Malformed or duplicate witnessed v2 run')
          runs.set(id, {
            manifestSha256: row.manifest_sha256,
            slotId: row.slot_id,
            runVisibleAtUtc: iso(row.run_visible_at),
            runConfirmedAtUtc: iso(row.confirmed_at),
            sourceStartAtUtc: iso(row.source_start_at),
            witnessXid: String(row.witness_xid),
            arms: new Map(),
          })
        }
        const issueShas = new Set()
        for (const row of armsQuery.rows ?? []) {
          const run = runs.get(key(row))
          const horizonSeconds = Number(row.horizon_seconds)
          if (
            !run ||
            !ARMS.includes(horizonSeconds) ||
            run.arms.has(horizonSeconds) ||
            !['issued', 'abstained', 'failed', 'unknown'].includes(row.status) ||
            ![
              'issued',
              'source_unavailable',
              'rpc_failure',
              'disk_reserve',
              'verification_failure',
              'clock_or_slot_failure',
              'process_failure',
              'other',
            ].includes(row.reason) ||
            (row.status === 'issued') !== (row.reason === 'issued') ||
            !/^[1-9][0-9]*$/.test(String(row.result_xid)) ||
            millis(row.result_at) < millis(run.sourceStartAtUtc) ||
            millis(row.result_at) > millis(run.runConfirmedAtUtc)
          )
            throw new Error('Malformed or duplicate witnessed v2 arm')
          let issue = null
          if (row.status === 'issued') {
            const body = JSON.parse(row.issue_payload)
            const targetMs = millis(row.local_issued_at) + horizonSeconds * 1000
            if (
              !SHA.test(row.issue_logical_sha256 ?? '') ||
              !SHA.test(row.issue_physical_sha256 ?? '') ||
              issueShas.has(row.issue_logical_sha256) ||
              row.issue_payload !== JSON.stringify(body) ||
              body.sha256 !== row.issue_logical_sha256 ||
              hash(unsignedJson(body)) !== row.issue_logical_sha256 ||
              hash(`${row.issue_payload}\n`) !== row.issue_physical_sha256 ||
              body.study !== BOUND_STUDY_V2 ||
              body.scheduleBinding?.manifestSha256 !== run.manifestSha256 ||
              body.scheduleBinding?.slotId !== run.slotId ||
              body.horizonSeconds !== horizonSeconds ||
              body.holder !== HOLDER ||
              body.qAssetsRaw !== Q_ASSETS_RAW ||
              body.route !== ROUTE ||
              body.issuedAtUtc !== iso(row.local_issued_at) ||
              body.targetUtc !== new Date(targetMs).toISOString() ||
              body.outcomeProtocol?.targetUtc !== body.targetUtc ||
              body.outcomeProtocol?.checkpointSelection?.captureDeadlineUtc !==
                new Date(targetMs + 5400 * 1000).toISOString()
            )
              throw new Error('Malformed witnessed v2 issued payload')
            issueShas.add(row.issue_logical_sha256)
            issue = {
              filename: boundIssueNameV2(body),
              logicalSha256: row.issue_logical_sha256,
              physicalSha256: row.issue_physical_sha256,
              payload: row.issue_payload,
              issuedAtUtc: iso(row.local_issued_at),
            }
          } else if (
            row.issue_logical_sha256 != null ||
            row.issue_physical_sha256 != null ||
            row.issue_payload != null ||
            row.local_issued_at != null
          )
            throw new Error('Non-issued witnessed arm carries issue bytes')
          run.arms.set(horizonSeconds, {
            horizonSeconds,
            status: row.status,
            reason: row.reason,
            resultAtUtc: iso(row.result_at),
            resultXid: String(row.result_xid),
            issue,
            score: null,
          })
        }
        for (const run of runs.values())
          if (run.arms.size !== ARMS.length || ARMS.some((horizon) => !run.arms.has(horizon)))
            throw new Error('Witnessed v2 run lacks exact four-arm denominator')
        for (const run of runs.values())
          for (const arm of run.arms.values())
            if (
              arm.issue &&
              millis(run.runVisibleAtUtc) >=
                millis(arm.issue.issuedAtUtc) + arm.horizonSeconds * 1000
            )
              throw new Error('Witnessed v2 run became visible after issued target')
        const scoreShas = new Set()
        for (const row of scoresQuery.rows ?? []) {
          const run = runs.get(key(row))
          const arm = run?.arms.get(Number(row.horizon_seconds))
          if (!arm || arm.status !== 'issued' || arm.score)
            throw new Error('Malformed or duplicate witnessed v2 score')
          const body = JSON.parse(row.score_payload)
          if (
            !SHA.test(row.score_logical_sha256 ?? '') ||
            !SHA.test(row.score_physical_sha256 ?? '') ||
            scoreShas.has(row.score_logical_sha256) ||
            row.score_payload !== JSON.stringify(body) ||
            body.sha256 !== row.score_logical_sha256 ||
            hash(unsignedJson(body)) !== row.score_logical_sha256 ||
            hash(`${row.score_payload}\n`) !== row.score_physical_sha256 ||
            row.issue_logical_sha256 !== arm.issue.logicalSha256 ||
            row.issue_physical_sha256 !== arm.issue.physicalSha256 ||
            row.score_filename !== arm.issue.filename ||
            body.study !== 'scrvusd-now-origin-exit-forecast-score-v2' ||
            body.issue?.filename !== arm.issue.filename ||
            body.issue?.logicalSha256 !== arm.issue.logicalSha256 ||
            body.issue?.physicalSha256 !== arm.issue.physicalSha256 ||
            body.horizonSeconds !== arm.horizonSeconds ||
            body.targetUtc !==
              new Date(
                Date.parse(arm.issue.issuedAtUtc) + arm.horizonSeconds * 1000,
              ).toISOString() ||
            body.evidenceCutoffUtc !==
              new Date(
                Date.parse(arm.issue.issuedAtUtc) + (arm.horizonSeconds + 5400) * 1000,
              ).toISOString() ||
            body.pointOutcome?.holder !== HOLDER ||
            body.pointOutcome?.qAssetsRaw !== Q_ASSETS_RAW ||
            body.pointOutcome?.route !== ROUTE ||
            ![
              'success',
              'revert',
              'provider_ambiguity',
              'missing',
              'missing_quote_checkpoint',
            ].includes(body.pointOutcome?.status) ||
            !canonicalUtc(body.scoredAtUtc) ||
            millis(body.scoredAtUtc) < millis(body.evidenceCutoffUtc) ||
            !/^[1-9][0-9]*$/.test(String(row.score_xid)) ||
            !/^[1-9][0-9]*$/.test(String(row.witness_xid)) ||
            millis(row.score_visible_at) > millis(asOfUtc) ||
            millis(row.score_visible_at) < millis(row.score_recorded_at) ||
            millis(row.score_recorded_at) < millis(run.runVisibleAtUtc) ||
            String(row.witness_xid) === String(row.score_xid)
          )
            throw new Error('Malformed witnessed v2 score bytes or timing')
          scoreShas.add(row.score_logical_sha256)
          arm.score = {
            filename: row.score_filename,
            logicalSha256: row.score_logical_sha256,
            physicalSha256: row.score_physical_sha256,
            payload: row.score_payload,
            scoreRecordedAtUtc: iso(row.score_recorded_at),
            scoreVisibleAtUtc: iso(row.score_visible_at),
          }
        }
        const cohort = [...runs.values()].map((run) => ({
          ...run,
          arms: ARMS.map((horizon) => run.arms.get(horizon)),
        }))
        return {
          asOfUtc,
          runs: cohort,
          runCount: cohort.length,
          armCount: cohort.length * ARMS.length,
          issuedArmCount: cohort.flatMap((run) => run.arms).filter((arm) => arm.issue).length,
          witnessedScoreCount: cohort.flatMap((run) => run.arms).filter((arm) => arm.score).length,
          chronologicalBacktestEligible: false,
        }
      })
    },
    async startSource({ manifestSha256, slotId, nonceSha256 }) {
      slot(manifestSha256, slotId)
      if (!SHA.test(nonceSha256)) throw new Error('Exact source-start nonce required')
      const ack = await transaction(false, async (client) =>
        one(
          await client.query(
            'SELECT source_start_at,source_start_xid FROM public.start_scrvusd_now_source($1::text,$2::text,$3::text)',
            [manifestSha256, slotId, nonceSha256],
          ),
          'source start',
        ),
      )
      const visible = await this.readSourceStart({ manifestSha256, slotId })
      if (
        visible.nonceSha256 !== nonceSha256 ||
        visible.sourceStartAtUtc !== iso(ack.source_start_at) ||
        visible.sourceStartXid !== String(ack.source_start_xid)
      )
        throw new Error('Committed source start differs from receipt')
      return visible
    },
    async readSourceStart({ manifestSha256, slotId }) {
      slot(manifestSha256, slotId)
      return transaction(true, async (client) => {
        const result = await client.query(
          `SELECT s.nonce_sha256,s.floor_xid,s.source_start_at,s.source_start_xid,
                  f.visible_at AS capture_floor_at,f.visibility_xid AS capture_floor_xid
             FROM public.scrvusd_now_source_starts s
             JOIN public.scrvusd_now_capture_floors f USING(manifest_sha256,slot_id)
            WHERE s.manifest_sha256=$1::text AND s.slot_id=$2::text`,
          [manifestSha256, slotId],
        )
        if (!result.rows?.length) return null
        const row = one(result, 'source start readback')
        if (
          !SHA.test(row.nonce_sha256) ||
          String(row.floor_xid) !== String(row.capture_floor_xid) ||
          millis(row.source_start_at) < millis(row.capture_floor_at) ||
          String(row.source_start_xid) === String(row.floor_xid)
        )
          throw new Error('Committed source start/floor linkage invalid')
        return {
          manifestSha256,
          slotId,
          nonceSha256: row.nonce_sha256,
          sourceStartAtUtc: iso(row.source_start_at),
          sourceStartXid: String(row.source_start_xid),
          captureFloorAtUtc: iso(row.capture_floor_at),
          captureFloorXid: String(row.capture_floor_xid),
          sourceCollectionIndependentlyTimed: false,
        }
      })
    },
    async witnessRun({ manifestSha256, slotId }) {
      slot(manifestSha256, slotId)
      const ack = await transaction(false, async (client) =>
        one(
          await client.query(
            'SELECT run_visible_at,witness_xid FROM public.witness_scrvusd_now_run($1::text,$2::text)',
            [manifestSha256, slotId],
          ),
          'run visibility witness',
        ),
      )
      const visible = await this.readRunWitness({ manifestSha256, slotId })
      if (
        visible?.runVisibleAtUtc !== iso(ack.run_visible_at) ||
        visible?.witnessXid !== String(ack.witness_xid)
      )
        throw new Error('Committed run visibility witness differs from receipt')
      return visible
    },
    async readRunWitness({ manifestSha256, slotId }) {
      slot(manifestSha256, slotId)
      return transaction(true, async (client) => {
        const result = await client.query(
          `SELECT v.run_visible_at,v.witness_xid,c.confirmed_at,c.confirmer_xid,
                  s.source_start_at,s.source_start_xid,s.nonce_sha256
             FROM public.scrvusd_now_run_visibility v
             JOIN public.scrvusd_now_run_confirmations c USING(manifest_sha256,slot_id)
             JOIN public.scrvusd_now_source_starts s USING(manifest_sha256,slot_id)
            WHERE v.manifest_sha256=$1::text AND v.slot_id=$2::text`,
          [manifestSha256, slotId],
        )
        if (!result.rows?.length) return null
        const row = one(result, 'run visibility readback')
        if (
          millis(row.run_visible_at) < millis(row.confirmed_at) ||
          millis(row.run_visible_at) < millis(row.source_start_at) ||
          String(row.witness_xid) === String(row.confirmer_xid) ||
          String(row.witness_xid) === String(row.source_start_xid) ||
          !SHA.test(row.nonce_sha256)
        )
          throw new Error('Committed run visibility sequence invalid')
        return {
          manifestSha256,
          slotId,
          runVisibleAtUtc: iso(row.run_visible_at),
          witnessXid: String(row.witness_xid),
          runConfirmerXid: String(row.confirmer_xid),
          sourceStartAtUtc: iso(row.source_start_at),
          sourceStartXid: String(row.source_start_xid),
          nonceSha256: row.nonce_sha256,
          historicalAvailabilityCertifiedForRun: true,
        }
      })
    },
    async recordScore({
      manifestSha256,
      slotId,
      horizonSeconds,
      issueFilename,
      issueOut = BOUND_ISSUE_OUT,
      scoreOut = BOUND_SCORE_OUT,
    }) {
      arm(manifestSha256, slotId, horizonSeconds)
      if (typeof issueFilename !== 'string' || !/^[0-9a-z-]+\.json$/.test(issueFilename))
        throw new Error('Exact retained v2 issue filename required')
      const issueRow = readRow(issueOut, issueFilename)
      const scoreRow = readRow(scoreOut, issueFilename)
      const issue = issueRow?.issue
      const score = scoreRow?.issue
      const scorePayload = JSON.stringify(score)
      const targetMs = Date.parse(issue?.issuedAtUtc) + horizonSeconds * 1000
      const deadlineMs = targetMs + 5400 * 1000
      if (
        issue?.study !== BOUND_STUDY_V2 ||
        issue?.scheduleBinding?.manifestSha256 !== manifestSha256 ||
        issue?.scheduleBinding?.slotId !== slotId ||
        issue?.horizonSeconds !== horizonSeconds ||
        score?.study !== 'scrvusd-now-origin-exit-forecast-score-v2' ||
        score?.issue?.filename !== issueRow.filename ||
        score?.issue?.logicalSha256 !== issue.sha256 ||
        score?.issue?.physicalSha256 !== issueRow.physicalSha256 ||
        !Number.isFinite(targetMs) ||
        issue?.targetUtc !== new Date(targetMs).toISOString() ||
        issue?.outcomeProtocol?.targetUtc !== issue.targetUtc ||
        issue?.outcomeProtocol?.checkpointSelection?.captureDeadlineUtc !==
          new Date(deadlineMs).toISOString() ||
        score?.targetUtc !== issue.targetUtc ||
        score?.evidenceCutoffUtc !== new Date(deadlineMs).toISOString() ||
        score?.pointOutcome?.holder !== issue.holder ||
        score?.pointOutcome?.qAssetsRaw !== issue.qAssetsRaw ||
        score?.pointOutcome?.route !== issue.route ||
        ![
          'success',
          'revert',
          'provider_ambiguity',
          'missing',
          'missing_quote_checkpoint',
        ].includes(score?.pointOutcome?.status) ||
        !Number.isFinite(Date.parse(score?.scoredAtUtc)) ||
        new Date(score.scoredAtUtc).toISOString() !== score.scoredAtUtc ||
        Date.parse(score.scoredAtUtc) < deadlineMs ||
        scoreRow?.filename !== issueRow.filename ||
        score?.sha256 !== hash(unsignedJson(score)) ||
        scoreRow?.physicalSha256 !== hash(`${scorePayload}\n`)
      )
        throw new Error('Exact retained v2 issue/score bytes required')
      const ack = await transaction(false, async (client) =>
        one(
          await client.query(
            `SELECT score_recorded_at,score_xid FROM public.record_scrvusd_now_score(
              $1::text,$2::text,$3::integer,$4::text,$5::text,$6::text,
              $7::text,$8::text,$9::text)`,
            [
              manifestSha256,
              slotId,
              horizonSeconds,
              issue.sha256,
              issueRow.physicalSha256,
              scoreRow.filename,
              score.sha256,
              scoreRow.physicalSha256,
              scorePayload,
            ],
          ),
          'score recording',
        ),
      )
      const readback = await this.readScoreWitness({ manifestSha256, slotId, horizonSeconds })
      if (
        readback?.scoreRecordedAtUtc !== iso(ack.score_recorded_at) ||
        readback?.scoreXid !== String(ack.score_xid) ||
        readback?.scorePayload !== scorePayload
      )
        throw new Error('Committed score recording differs from exact local bytes')
      return readback
    },
    async witnessScore({ manifestSha256, slotId, horizonSeconds }) {
      arm(manifestSha256, slotId, horizonSeconds)
      const ack = await transaction(false, async (client) =>
        one(
          await client.query(
            'SELECT score_visible_at,witness_xid FROM public.witness_scrvusd_now_score($1::text,$2::text,$3::integer)',
            [manifestSha256, slotId, horizonSeconds],
          ),
          'score visibility witness',
        ),
      )
      const readback = await this.readScoreWitness({ manifestSha256, slotId, horizonSeconds })
      if (
        readback?.scoreVisibleAtUtc !== iso(ack.score_visible_at) ||
        readback?.witnessXid !== String(ack.witness_xid)
      )
        throw new Error('Committed score visibility differs from receipt')
      return readback
    },
    async readScoreWitness({ manifestSha256, slotId, horizonSeconds }) {
      arm(manifestSha256, slotId, horizonSeconds)
      return transaction(true, async (client) => {
        const result = await client.query(
          `SELECT s.issue_logical_sha256,s.issue_physical_sha256,s.score_filename,
                  s.score_logical_sha256,s.score_physical_sha256,s.score_payload,
                  s.score_recorded_at,s.score_xid,v.score_visible_at,v.witness_xid,
                  r.issue_logical_sha256 AS arm_issue_logical_sha256,
                  r.issue_physical_sha256 AS arm_issue_physical_sha256
             FROM public.scrvusd_now_scores s
             JOIN public.scrvusd_now_arm_results r USING(manifest_sha256,slot_id,horizon_seconds)
        LEFT JOIN public.scrvusd_now_score_visibility v USING(manifest_sha256,slot_id,horizon_seconds)
            WHERE s.manifest_sha256=$1::text AND s.slot_id=$2::text
              AND s.horizon_seconds=$3::integer`,
          [manifestSha256, slotId, horizonSeconds],
        )
        if (!result.rows?.length) return null
        const row = one(result, 'score readback')
        const score = JSON.parse(row.score_payload)
        if (
          row.issue_logical_sha256 !== row.arm_issue_logical_sha256 ||
          row.issue_physical_sha256 !== row.arm_issue_physical_sha256 ||
          row.score_logical_sha256 !== hash(unsignedJson(score)) ||
          row.score_physical_sha256 !== hash(`${row.score_payload}\n`) ||
          score.sha256 !== row.score_logical_sha256 ||
          score.study !== 'scrvusd-now-origin-exit-forecast-score-v2' ||
          score.issue?.filename !== row.score_filename ||
          score.issue?.logicalSha256 !== row.issue_logical_sha256 ||
          score.issue?.physicalSha256 !== row.issue_physical_sha256 ||
          score.horizonSeconds !== horizonSeconds ||
          (row.score_visible_at &&
            (millis(row.score_visible_at) < millis(row.score_recorded_at) ||
              String(row.witness_xid) === String(row.score_xid)))
        )
          throw new Error('Committed score bytes or witness sequence invalid')
        return {
          manifestSha256,
          slotId,
          horizonSeconds,
          issueLogicalSha256: row.issue_logical_sha256,
          issuePhysicalSha256: row.issue_physical_sha256,
          scoreFilename: row.score_filename,
          scoreLogicalSha256: row.score_logical_sha256,
          scorePhysicalSha256: row.score_physical_sha256,
          scorePayload: row.score_payload,
          scoreRecordedAtUtc: iso(row.score_recorded_at),
          scoreXid: String(row.score_xid),
          scoreVisibleAtUtc: row.score_visible_at ? iso(row.score_visible_at) : null,
          witnessXid: row.witness_xid == null ? null : String(row.witness_xid),
          historicalAvailabilityCertifiedForScore: Boolean(row.score_visible_at),
        }
      })
    },
  }
}
