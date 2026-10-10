// Research-only, opt-in v2 slot execution. Never called by recorder-tick.sh.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from '@neondatabase/serverless'
import {
  attemptStartNameV1,
  boundIssueNameV2,
  buildAttemptStartV1,
  buildBoundIssueV2,
  readRow,
  sourceRows,
} from './scrvusd-exit-forecast-issue.mjs'
import {
  createPgNowAsOfStore,
  createPgNowAttemptStore,
  createPgNowScheduleStore,
} from './scrvusd-now-schedule-db.mjs'
import { HORIZONS_SECONDS, verifyNowSchedule } from './scrvusd-now-schedule.mjs'
import { RESERVE_BYTES } from './scrvusd-fixed-holder-exit.mjs'
import { ATTEMPT_START_OUT, BOUND_ISSUE_OUT } from './scrvusd-bound-paths.mjs'

export const START_OUT = ATTEMPT_START_OUT
export const ISSUE_OUT = BOUND_ISSUE_OUT
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const execFileAsync = promisify(execFile)

export function acceptsSourceStageResult(stage, status) {
  if (stage === 'holder') return ['success', 'revert', 'provider_error'].includes(status)
  return (
    {
      quote: 'recorded',
      attestation: 'attested',
      duration: 'issued',
    }[stage] === status
  )
}

function withinSlot(slot, value) {
  const time = Date.parse(value)
  return (
    Number.isFinite(time) &&
    time >= Date.parse(slot.scheduledAtUtc) &&
    time < Date.parse(slot.closesAtUtc)
  )
}

function immutableWrite(path, receipt, { stat = statfsSync } = {}) {
  const bytes = `${JSON.stringify(receipt)}\n`
  let ancestor = dirname(path)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('disk_reserve')
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  if (!readFileSync(path).equals(Buffer.from(bytes)))
    throw new Error('Exact immutable receipt readback mismatch')
  return sha(bytes)
}

export async function runDefaultSourceStages() {
  const stages = [
    ['quote', 'curve-prospective-quote.mjs', ['--run']],
    ['attestation', 'scrvusd-target-code-attestation.mjs', ['--run']],
    ['holder', 'scrvusd-fixed-holder-exit.mjs', ['--observe', '--rpc-index', '1']],
    ['duration', 'scrvusd-holder-duration.mjs', ['--run']],
  ]
  for (const [stage, module, args] of stages) {
    let output
    try {
      output = await execFileAsync(
        process.execPath,
        [resolve('scripts/research', module), ...args],
        {
          cwd: resolve('.'),
          maxBuffer: 256 * 1024,
          timeout: 12 * 60 * 1000,
        },
      )
    } catch (error) {
      const reason =
        stage === 'quote' && /"reason":"disk_reserve"/.test(error.stderr ?? '')
          ? 'disk_reserve'
          : 'process_failure'
      return { status: 'failed', reason, stage }
    }
    let result
    try {
      result = JSON.parse(output.stdout.trim())
    } catch {
      return { status: 'failed', reason: 'process_failure', stage }
    }
    if (!acceptsSourceStageResult(stage, result.status))
      return { status: 'abstained', reason: 'source_unavailable', stage }
  }
  // Flow context is optional; historical flow absence stays absent in the v2 issue.
  try {
    await execFileAsync(
      process.execPath,
      [resolve('scripts/research/scrvusd-holder-flow-context.mjs'), '--run'],
      {
        cwd: resolve('.'),
        maxBuffer: 256 * 1024,
        timeout: 90_000,
      },
    )
  } catch {
    /* No backfill: sourceRows will omit unavailable as-of flow. */
  }
  return { status: 'ready' }
}

export async function runNowSlot({
  manifestSha256,
  slotId,
  scheduleStore,
  attemptStore,
  asOfStore,
  collectSources = runDefaultSourceStages,
  getSourceRows = sourceRows,
  now = () => new Date(),
  startOut = START_OUT,
  issueOut = ISSUE_OUT,
  stat = statfsSync,
} = {}) {
  if (
    !scheduleStore?.readManifestWitness ||
    !attemptStore?.startArm ||
    !attemptStore?.readRun ||
    !attemptStore?.confirmStarts ||
    !attemptStore?.resultArm ||
    !attemptStore?.confirmRun ||
    !asOfStore?.startSource ||
    !asOfStore?.witnessRun
  )
    throw new Error('Audited schedule and attempt stores required')
  const publicationProof = await scheduleStore.readManifestWitness(manifestSha256)
  const manifest = verifyNowSchedule(publicationProof.manifest)
  if (
    publicationProof.prospectiveScheduleConfirmed !== true ||
    publicationProof.historicalPublicationAvailabilityCertified !== true ||
    publicationProof.evidenceClass !== 'db_witnessed_manifest' ||
    manifest.sha256 !== manifestSha256 ||
    !Number.isFinite(Date.parse(publicationProof.manifestVisibleAtUtc)) ||
    Date.parse(publicationProof.manifestVisibleAtUtc) <
      Date.parse(publicationProof.confirmedAtUtc) ||
    Date.parse(publicationProof.manifestVisibleAtUtc) >
      Date.parse(manifest.startAtUtc) - 2 * 3600 * 1000 ||
    !/^[1-9][0-9]*$/.test(publicationProof.witnessXid ?? '') ||
    publicationProof.witnessXid === publicationProof.publisherXid ||
    publicationProof.witnessXid === publicationProof.confirmerXid
  )
    throw new Error('Witnessed future manifest required')
  const slot = manifest.slots.find((candidate) => candidate.slotId === slotId)
  if (!slot || !withinSlot(slot, now().toISOString())) throw new Error('Missed or future slot')
  const prior = await attemptStore.readRun({ manifestSha256, slotId })
  const freshDbSlot =
    prior?.manifestSha256 === manifestSha256 &&
    prior?.slotId === slotId &&
    prior?.runCoverageConfirmed === false &&
    prior?.startConfirmedAtUtc == null &&
    prior?.startConfirmerXid == null &&
    prior?.sourceCaptureFloorUtc == null &&
    prior?.captureFloorXid == null &&
    prior?.runConfirmedAtUtc == null &&
    prior?.runConfirmerXid == null &&
    Array.isArray(prior?.arms) &&
    prior.arms.length === HORIZONS_SECONDS.length &&
    prior.arms.every(
      (arm, index) =>
        arm?.horizonSeconds === HORIZONS_SECONDS[index] &&
        arm?.status === 'start_missing' &&
        arm?.startPayload == null &&
        arm?.issuePayload == null &&
        arm?.resultAtUtc == null,
    )
  const localSlotFiles = existsSync(startOut)
    ? readdirSync(startOut).filter((name) => name.startsWith(`${slotId}-`))
    : []
  if (!freshDbSlot || localSlotFiles.length)
    throw new Error('Incomplete/nonresumable slot: existing DB state or local start receipt')

  const starts = new Map()
  for (const horizonSeconds of HORIZONS_SECONDS) {
    const startReceipt = buildAttemptStartV1({
      manifest,
      slotId,
      horizonSeconds,
      recordedAtUtc: now().toISOString(),
    })
    const filename = attemptStartNameV1(startReceipt)
    const physicalSha256 = immutableWrite(join(startOut, filename), startReceipt, { stat })
    await attemptStore.startArm({ manifest, slotId, horizonSeconds, startReceipt, physicalSha256 })
    starts.set(horizonSeconds, { filename, issue: startReceipt, physicalSha256 })
  }
  // The adapter uses separate transactions and reads the committed floor back.
  // Any partial START leaves this slot unconfirmed and collects no sources.
  const started = await attemptStore.confirmStarts({ manifestSha256, slotId })
  const floor = Date.parse(started.sourceCaptureFloorUtc)
  if (
    !Number.isFinite(floor) ||
    floor < Date.parse(slot.scheduledAtUtc) ||
    floor >= Date.parse(slot.closesAtUtc) ||
    started.arms?.length !== HORIZONS_SECONDS.length ||
    started.arms.some(
      (arm, i) =>
        arm.horizonSeconds !== HORIZONS_SECONDS[i] ||
        arm.status !== 'result_missing' ||
        arm.startLogicalSha256 !== starts.get(arm.horizonSeconds)?.issue.sha256 ||
        arm.startPhysicalSha256 !== starts.get(arm.horizonSeconds)?.physicalSha256,
    )
  )
    throw new Error('Four committed starts and capture floor not verified')
  if (now().getTime() < floor) throw new Error('Local clock precedes committed capture floor')
  const nonceSha256 = sha(randomUUID())
  const sourceStart = await asOfStore.startSource({ manifestSha256, slotId, nonceSha256 })
  const sourceStartMs = Date.parse(sourceStart?.sourceStartAtUtc)
  if (
    sourceStart?.manifestSha256 !== manifestSha256 ||
    sourceStart?.slotId !== slotId ||
    sourceStart?.nonceSha256 !== nonceSha256 ||
    sourceStart?.captureFloorAtUtc !== started.sourceCaptureFloorUtc ||
    !/^[1-9][0-9]*$/.test(sourceStart?.captureFloorXid ?? '') ||
    !/^[1-9][0-9]*$/.test(sourceStart?.sourceStartXid ?? '') ||
    sourceStart.sourceStartXid === sourceStart.captureFloorXid ||
    sourceStart?.sourceCollectionIndependentlyTimed !== false ||
    !Number.isFinite(sourceStartMs) ||
    sourceStartMs < floor ||
    !withinSlot(slot, sourceStart.sourceStartAtUtc) ||
    now().getTime() < sourceStartMs
  )
    throw new Error('Committed source-start receipt absent or late')

  let sourceStage
  try {
    sourceStage = await collectSources({
      slot,
      floorUtc: started.sourceCaptureFloorUtc,
      sourceStartUtc: sourceStart.sourceStartAtUtc,
      nonceSha256,
    })
  } catch {
    sourceStage = { status: 'failed', reason: 'process_failure' }
  }
  if (!['ready', 'failed', 'abstained'].includes(sourceStage?.status))
    sourceStage = { status: 'failed', reason: 'process_failure' }
  const results = []
  let earliestIssuedTargetMs = Infinity
  for (const horizonSeconds of HORIZONS_SECONDS) {
    if (!withinSlot(slot, now().toISOString()))
      throw new Error('Slot closed before all results committed; run remains unconfirmed')
    let status = sourceStage.status === 'ready' ? 'issued' : sourceStage.status
    let reason = sourceStage.status === 'ready' ? 'issued' : sourceStage.reason
    let issueReceipt = null
    let issuePhysicalSha256 = null
    if (status === 'issued') {
      try {
        const issuedAtUtc = now().toISOString()
        const rows = getSourceRows({ issuedAtUtc, now })
        if (!rows) {
          status = 'abstained'
          reason = 'source_unavailable'
        } else {
          const captureStarts = [
            rows.latestCheckpoint?.checkpoint?.captureStartUtc,
            rows.holderRow?.issue?.captureStartUtc,
            ...(rows.attestationRow ? [rows.attestationRow.issue.captureStartUtc] : []),
          ]
          if (
            captureStarts.some(
              (time) => !Number.isFinite(Date.parse(time)) || Date.parse(time) < sourceStartMs,
            ) ||
            !Number.isFinite(Date.parse(rows.durationRow?.issue?.issuedAtUtc)) ||
            Date.parse(rows.durationRow.issue.issuedAtUtc) < sourceStartMs ||
            (rows.flowRow &&
              (!Number.isFinite(Date.parse(rows.flowRow.issue.issuedAtUtc)) ||
                Date.parse(rows.flowRow.issue.issuedAtUtc) < sourceStartMs))
          )
            throw new Error('Source predates committed source start')
          issueReceipt = buildBoundIssueV2({
            ...rows,
            manifest,
            publicationProof,
            slotId,
            attemptStartRow: starts.get(horizonSeconds),
            horizonSeconds,
            issuedAtUtc,
          })
          const filename = boundIssueNameV2(issueReceipt)
          issuePhysicalSha256 = immutableWrite(join(issueOut, filename), issueReceipt, { stat })
          earliestIssuedTargetMs = Math.min(
            earliestIssuedTargetMs,
            Date.parse(issueReceipt.targetUtc),
          )
        }
      } catch (error) {
        status = 'failed'
        reason = error.message === 'disk_reserve' ? 'disk_reserve' : 'verification_failure'
        issueReceipt = null
        issuePhysicalSha256 = null
      }
    }
    if (
      ![
        'issued',
        'source_unavailable',
        'rpc_failure',
        'disk_reserve',
        'verification_failure',
        'clock_or_slot_failure',
        'process_failure',
        'other',
      ].includes(reason)
    )
      reason = 'other'
    results.push(
      await attemptStore.resultArm({
        manifestSha256,
        slotId,
        horizonSeconds,
        status,
        reason,
        issueReceipt,
        issuePhysicalSha256,
      }),
    )
  }
  if (!withinSlot(slot, now().toISOString())) throw new Error('Slot closed before run confirmation')
  const run = await attemptStore.confirmRun({ manifestSha256, slotId })
  if (!run.runCoverageConfirmed) throw new Error('Committed four-result readback absent')
  const witness = await asOfStore.witnessRun({ manifestSha256, slotId })
  if (
    witness?.manifestSha256 !== manifestSha256 ||
    witness?.slotId !== slotId ||
    witness?.nonceSha256 !== nonceSha256 ||
    witness?.sourceStartAtUtc !== sourceStart.sourceStartAtUtc ||
    witness?.sourceStartXid !== sourceStart.sourceStartXid ||
    !/^[1-9][0-9]*$/.test(witness?.runConfirmerXid ?? '') ||
    !/^[1-9][0-9]*$/.test(witness?.witnessXid ?? '') ||
    witness.witnessXid === witness.runConfirmerXid ||
    witness.witnessXid === witness.sourceStartXid ||
    witness?.historicalAvailabilityCertifiedForRun !== true ||
    !Number.isFinite(Date.parse(witness?.runVisibleAtUtc)) ||
    Date.parse(witness.runVisibleAtUtc) < Date.parse(sourceStart.sourceStartAtUtc) ||
    (Number.isFinite(earliestIssuedTargetMs) &&
      Date.parse(witness.runVisibleAtUtc) >= earliestIssuedTargetMs)
  )
    throw new Error('Committed run-visibility witness absent or late')
  return {
    status: 'research_only',
    slotId,
    results,
    runCoverageConfirmed: true,
    runVisibleAtUtc: witness.runVisibleAtUtc,
    historicalAvailabilityCertifiedForRun: true,
    calibratedForecastEligible: false,
  }
}

// Explicit finalization recovery. This path never creates starts, captures
// sources, or records results. A partial slot stays an operational gap.
export async function recoverNowSlotFinalization({
  manifestSha256,
  slotId,
  scheduleStore,
  attemptStore,
  asOfStore,
  now = () => new Date(),
  startOut = START_OUT,
  issueOut = ISSUE_OUT,
} = {}) {
  if (
    !scheduleStore?.readManifestWitness ||
    !attemptStore?.readRun ||
    !attemptStore?.confirmRun ||
    !asOfStore?.readSourceStart ||
    !asOfStore?.readRunWitness ||
    !asOfStore?.witnessRun
  )
    throw new Error('Audited recovery stores required')
  const publication = await scheduleStore.readManifestWitness(manifestSha256)
  const manifest = verifyNowSchedule(publication?.manifest)
  const slot = manifest.slots.find((candidate) => candidate.slotId === slotId)
  if (
    !slot ||
    publication?.manifestSha256 !== manifestSha256 ||
    publication?.prospectiveScheduleConfirmed !== true ||
    publication?.historicalPublicationAvailabilityCertified !== true ||
    publication?.evidenceClass !== 'db_witnessed_manifest' ||
    !Number.isFinite(Date.parse(publication.manifestVisibleAtUtc)) ||
    Date.parse(publication.manifestVisibleAtUtc) > Date.parse(manifest.startAtUtc) - 2 * 3600_000
  )
    throw new Error('Witnessed future manifest required for recovery')

  const run = await attemptStore.readRun({ manifestSha256, slotId })
  const sourceStart = await asOfStore.readSourceStart({ manifestSha256, slotId })
  const arms = run?.arms
  if (
    run?.manifestSha256 !== manifestSha256 ||
    run?.slotId !== slotId ||
    !Array.isArray(arms) ||
    arms.length !== HORIZONS_SECONDS.length ||
    !run.startConfirmedAtUtc ||
    !run.startConfirmerXid ||
    !run.sourceCaptureFloorUtc ||
    !run.captureFloorXid ||
    sourceStart?.manifestSha256 !== manifestSha256 ||
    sourceStart?.slotId !== slotId ||
    sourceStart?.captureFloorAtUtc !== run.sourceCaptureFloorUtc ||
    sourceStart?.captureFloorXid !== run.captureFloorXid ||
    sourceStart?.sourceCollectionIndependentlyTimed !== false ||
    !/^[0-9a-f]{64}$/.test(sourceStart?.nonceSha256 ?? '') ||
    !/^[1-9][0-9]*$/.test(sourceStart?.sourceStartXid ?? '') ||
    Date.parse(sourceStart.sourceStartAtUtc) < Date.parse(run.sourceCaptureFloorUtc) ||
    !withinSlot(slot, sourceStart.sourceStartAtUtc)
  )
    throw new Error(
      'Incomplete/nonrecoverable slot: committed source start or capture floor absent',
    )

  let earliestIssuedTargetMs = Infinity
  for (const [index, arm] of arms.entries()) {
    if (
      arm?.horizonSeconds !== HORIZONS_SECONDS[index] ||
      !['db_reported_issued_unverified', 'abstained', 'failed', 'unknown'].includes(arm.status) ||
      !arm.startPayload ||
      !arm.startLogicalSha256 ||
      !arm.startPhysicalSha256 ||
      !arm.startedAtUtc ||
      !arm.startXid ||
      !arm.resultAtUtc ||
      !arm.resultXid ||
      Date.parse(arm.resultAtUtc) < Date.parse(sourceStart.sourceStartAtUtc) ||
      !withinSlot(slot, arm.resultAtUtc)
    )
      throw new Error('Incomplete/nonrecoverable slot: four exact committed results required')
    const start = JSON.parse(arm.startPayload)
    const expectedStart = buildAttemptStartV1({
      manifest,
      slotId,
      horizonSeconds: arm.horizonSeconds,
      recordedAtUtc: start.recordedAtUtc,
    })
    const retainedStart = readRow(startOut, attemptStartNameV1(start))
    if (
      JSON.stringify(start) !== JSON.stringify(expectedStart) ||
      JSON.stringify(retainedStart.issue) !== arm.startPayload ||
      retainedStart.physicalSha256 !== arm.startPhysicalSha256 ||
      start.sha256 !== arm.startLogicalSha256
    )
      throw new Error('Exact retained start receipt differs from committed arm')
    if (arm.status === 'db_reported_issued_unverified') {
      if (!arm.issuePayload || !arm.issueLogicalSha256 || !arm.issuePhysicalSha256)
        throw new Error('Issued arm lacks committed exact issue bytes')
      const issue = JSON.parse(arm.issuePayload)
      const retainedIssue = readRow(issueOut, boundIssueNameV2(issue))
      const targetMs = Date.parse(issue.targetUtc)
      const issuedMs = Date.parse(issue.issuedAtUtc)
      if (
        JSON.stringify(retainedIssue.issue) !== arm.issuePayload ||
        retainedIssue.physicalSha256 !== arm.issuePhysicalSha256 ||
        issue.sha256 !== arm.issueLogicalSha256 ||
        issue.scheduleBinding?.manifestSha256 !== manifestSha256 ||
        issue.scheduleBinding?.slotId !== slotId ||
        issue.scheduleBinding?.horizonSeconds !== arm.horizonSeconds ||
        issue.scheduleBinding?.attemptStart?.logicalSha256 !== start.sha256 ||
        issue.scheduleBinding?.attemptStart?.physicalSha256 !== arm.startPhysicalSha256 ||
        !Number.isFinite(issuedMs) ||
        new Date(issuedMs).toISOString() !== issue.issuedAtUtc ||
        issuedMs < Date.parse(sourceStart.sourceStartAtUtc) ||
        new Date(issuedMs + arm.horizonSeconds * 1000).toISOString() !== issue.targetUtc ||
        !Number.isFinite(targetMs)
      )
        throw new Error('Exact retained issue receipt differs from committed arm')
      earliestIssuedTargetMs = Math.min(earliestIssuedTargetMs, targetMs)
    } else if (
      arm.issuePayload != null ||
      arm.issueLogicalSha256 != null ||
      arm.issuePhysicalSha256 != null
    ) {
      throw new Error('Non-issued arm unexpectedly binds issue bytes')
    }
  }

  const alreadyWitnessed = await asOfStore.readRunWitness({ manifestSha256, slotId })
  if (
    alreadyWitnessed &&
    (!run.runCoverageConfirmed || !run.runConfirmedAtUtc || !run.runConfirmerXid)
  )
    throw new Error('Witness exists without exact committed run confirmation')
  if (!alreadyWitnessed && now().getTime() >= earliestIssuedTargetMs)
    throw new Error('Recovery missed earliest issued target')
  if (!run.runCoverageConfirmed) {
    if (run.runConfirmedAtUtc || run.runConfirmerXid)
      throw new Error('Partial run confirmation is not recoverable')
    if (!withinSlot(slot, now().toISOString()))
      throw new Error('Recovery missed slot or earliest issued target')
    const confirmed = await attemptStore.confirmRun({ manifestSha256, slotId })
    if (
      !confirmed.runCoverageConfirmed ||
      !confirmed.runConfirmedAtUtc ||
      !confirmed.runConfirmerXid ||
      JSON.stringify(confirmed.arms) !== JSON.stringify(arms)
    )
      throw new Error('Committed four-result readback absent after recovery confirmation')
    run.runConfirmedAtUtc = confirmed.runConfirmedAtUtc
    run.runConfirmerXid = confirmed.runConfirmerXid
  }
  if (Date.parse(run.runConfirmedAtUtc) >= earliestIssuedTargetMs)
    throw new Error('Run confirmation missed earliest issued target')
  const witness = alreadyWitnessed ?? (await asOfStore.witnessRun({ manifestSha256, slotId }))
  if (
    witness?.manifestSha256 !== manifestSha256 ||
    witness?.slotId !== slotId ||
    witness?.nonceSha256 !== sourceStart.nonceSha256 ||
    witness?.sourceStartAtUtc !== sourceStart.sourceStartAtUtc ||
    witness?.sourceStartXid !== sourceStart.sourceStartXid ||
    witness?.runConfirmerXid !== run.runConfirmerXid ||
    witness?.historicalAvailabilityCertifiedForRun !== true ||
    !/^[1-9][0-9]*$/.test(witness?.witnessXid ?? '') ||
    witness.witnessXid === witness.runConfirmerXid ||
    witness.witnessXid === witness.sourceStartXid ||
    !Number.isFinite(Date.parse(witness?.runVisibleAtUtc)) ||
    Date.parse(witness.runVisibleAtUtc) < Date.parse(run.runConfirmedAtUtc) ||
    Date.parse(witness.runVisibleAtUtc) >= earliestIssuedTargetMs
  )
    throw new Error('Committed run-visibility witness absent or late')
  return {
    status: 'research_only',
    slotId,
    results: arms,
    runCoverageConfirmed: true,
    runVisibleAtUtc: witness.runVisibleAtUtc,
    historicalAvailabilityCertifiedForRun: true,
    calibratedForecastEligible: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const recover = process.argv[2] === '--recover-finalization'
  const [manifestSha256, slotId] = process.argv.slice(recover ? 3 : 2)
  const url = process.env.SCRVUSD_SCHEDULE_PUBLISHER_DATABASE_URL
  if (
    !/^[0-9a-f]{64}$/.test(manifestSha256 ?? '') ||
    !/^[0-9a-f]{64}$/.test(slotId ?? '') ||
    !url
  ) {
    console.error(
      'Usage: SCRVUSD_SCHEDULE_PUBLISHER_DATABASE_URL=... node scripts/research/scrvusd-now-slot-runner.mjs [--recover-finalization] <manifest-sha> <slot-id>',
    )
    process.exitCode = 1
  } else {
    const pool = new Pool({ connectionString: url })
    ;(recover ? recoverNowSlotFinalization : runNowSlot)({
      manifestSha256,
      slotId,
      scheduleStore: createPgNowScheduleStore(pool),
      attemptStore: createPgNowAttemptStore(pool),
      asOfStore: createPgNowAsOfStore(pool),
    })
      .then((result) => console.log(JSON.stringify(result)))
      .catch(() => {
        console.error('Research slot failed or remains unconfirmed')
        process.exitCode = 1
      })
      .finally(() => pool.end())
  }
}
