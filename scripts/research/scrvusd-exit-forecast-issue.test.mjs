import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import {
  attemptStartNameV1,
  boundIssueNameV2,
  buildAttemptStartV1,
  buildBoundIssueV2,
  buildIssue,
  outcomeProtocol,
  verifyBoundIssueV2,
  verifyIssue,
} from './scrvusd-exit-forecast-issue.mjs'
import { sourceIdentity } from './curve-prospective-quote.mjs'
import { readVerifiedAtCheckpoint } from './scrvusd-target-code-attestation.mjs'
import { createNowSchedule, HOLDER } from './scrvusd-now-schedule.mjs'
import {
  validateBoundIssueEvidenceV2,
  verifyBoundIssueFromStoresV2,
  verifyBoundIssueWithPgV2,
} from './scrvusd-bound-issue-verifier.mjs'

const hash = (char) => char.repeat(64)
const block = { number: 26072398, hash: `0x${hash('a')}`, timestamp: 1_780_000_000 }
const start = new Date(block.timestamp * 1000)
const at = (seconds) => new Date(start.getTime() + seconds * 1000).toISOString()

function fixture() {
  const filename = `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
  const holder = {
    sha256: hash('b'),
    checkpoint: { block },
    holder: `0x${'1'.repeat(40)}`,
    rawCrvUsd: '1000000000000000000000',
    captureStartUtc: at(45),
    captureEndUtc: at(50),
    result: {
      status: 'success',
      sharesBurnedRaw: '1000',
      maxWithdrawAssetsRaw: '2000000000000000000000',
      previewSharesRaw: '1000',
      balanceSharesRaw: '2000',
    },
  }
  const holderRow = { filename, issue: holder, physicalSha256: hash('c') }
  const duration = {
    study: 'scrvusd-holder-executable-duration-v2',
    kind: 'prospective-holder-first-loss-baseline',
    sha256: hash('d'),
    issuedAtUtc: at(60),
    holder: holder.holder,
    rawCrvUsd: holder.rawCrvUsd,
    block,
    holderIssue: {
      filename,
      logicalSha256: holder.sha256,
      physicalSha256: holderRow.physicalSha256,
    },
    quote: { filename, logicalSha256: hash('e'), physicalSha256: hash('f') },
    baseline: { status: 'uncalibrated', holderCount: 1, vaultCount: 1, episodes: [] },
  }
  const durationRow = { filename, issue: duration, physicalSha256: hash('0') }
  const flow = {
    study: 'scrvusd-holder-duration-flow-context-v2',
    sha256: hash('9'),
    issuedAtUtc: at(70),
    block,
    durationIssue: {
      filename,
      logicalSha256: duration.sha256,
      physicalSha256: durationRow.physicalSha256,
    },
    historicalSuffix: {
      evidenceCutoffUtc: duration.issuedAtUtc,
      coverage: 'incomplete',
      maximumObservedCompleteWindow: null,
    },
  }
  return {
    durationRow,
    holderRow,
    flowRow: { filename, issue: flow, physicalSha256: hash('8') },
    latestCheckpoint: {
      filename,
      physicalSha256: hash('f'),
      checkpoint: { block, captureStartUtc: at(30), captureEndUtc: at(40), sha256: hash('e') },
    },
    horizonSeconds: 86_400,
    issuedAtUtc: at(80),
  }
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sealed = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const reseal = (issue) => {
  const { sha256: _old, ...body } = issue
  return sealed(body)
}
const rowWithBytes = (filename, issue) => ({
  filename,
  issue,
  physicalSha256: sha(`${JSON.stringify(issue)}\n`),
})
const rowRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.issue.sha256,
  physicalSha256: row.physicalSha256,
})

function boundFixture() {
  const input = fixture()
  const hour = new Date(Math.floor(start.getTime() / 3600_000) * 3600_000)
  const manifest = createNowSchedule({
    plannedAtUtc: new Date(hour.getTime() - 3 * 3600_000).toISOString(),
    startAtUtc: hour.toISOString(),
    endAtUtc: new Date(hour.getTime() + 3600_000).toISOString(),
  })
  const slotId = manifest.slots[0].slotId
  const publicationProof = {
    manifest,
    manifestSha256: manifest.sha256,
    persistedAtUtc: new Date(hour.getTime() - 3 * 3600_000 + 60_000).toISOString(),
    confirmedAtUtc: new Date(hour.getTime() - 3 * 3600_000 + 120_000).toISOString(),
    publisherXid: '101',
    confirmerXid: '102',
  }
  const checkpoint = reseal(input.latestCheckpoint.checkpoint)
  input.latestCheckpoint = {
    filename: input.latestCheckpoint.filename,
    checkpoint,
    physicalSha256: sha(`${JSON.stringify(checkpoint)}\n`),
  }
  const holder = reseal({ ...input.holderRow.issue, holder: HOLDER })
  input.holderRow = rowWithBytes(input.holderRow.filename, holder)
  const duration = reseal({
    ...input.durationRow.issue,
    holder: HOLDER,
    holderIssue: rowRef(input.holderRow),
    quote: {
      filename: input.latestCheckpoint.filename,
      logicalSha256: checkpoint.sha256,
      physicalSha256: input.latestCheckpoint.physicalSha256,
    },
  })
  input.durationRow = rowWithBytes(input.durationRow.filename, duration)
  const flow = reseal({
    ...input.flowRow.issue,
    durationIssue: rowRef(input.durationRow),
  })
  input.flowRow = rowWithBytes(input.flowRow.filename, flow)
  const startIssue = buildAttemptStartV1({
    manifest,
    slotId,
    horizonSeconds: input.horizonSeconds,
    recordedAtUtc: at(0),
  })
  const attemptStartRow = rowWithBytes(attemptStartNameV1(startIssue), startIssue)
  return { ...input, manifest, publicationProof, slotId, attemptStartRow }
}
function attestationRow(input, captureEndUtc = at(75)) {
  const target = `0x${'2'.repeat(40)}`
  const vaultRuntime = `0x363d3d373d3d3d363d73${target.slice(2)}5af43d82803e903d91602b57fd5bf3`
  const targetCode = '0x6000600055'
  const payload = {
    study: 'scrvusd-target-code-attestation-v1',
    kind: 'prospective-code-identity',
    source: sourceIdentity(),
    checkpoint: {
      filename: input.latestCheckpoint.filename,
      logicalSha256: input.latestCheckpoint.checkpoint.sha256,
      physicalSha256: input.latestCheckpoint.physicalSha256,
      captureEndUtc: input.latestCheckpoint.checkpoint.captureEndUtc,
    },
    block,
    captureStartUtc: at(65),
    captureEndUtc,
    status: 'attested',
    route: 'exact_eip1167_runtime',
    vaultRuntime,
    vaultCodeHash: keccak256(vaultRuntime),
    target,
    targetCode,
    targetCodeHash: keccak256(targetCode),
  }
  const issue = { ...payload, sha256: sha(JSON.stringify(payload)) }
  return {
    filename: input.latestCheckpoint.filename,
    issue,
    physicalSha256: sha(`${JSON.stringify(issue)}\n`),
  }
}

test('seals current sampled ability separately from unavailable future forecast at arbitrary horizons', () => {
  for (const horizonSeconds of [90, 7200, 86_400, 604_800]) {
    const input = fixture()
    const issue = buildIssue({ ...input, horizonSeconds })
    assert.equal(issue.horizonSeconds, horizonSeconds)
    assert.equal(
      issue.targetUtc,
      new Date(Date.parse(input.issuedAtUtc) + horizonSeconds * 1000).toISOString(),
    )
    assert.equal(issue.currentExecutableAbility.status, 'sampled_success')
    assert.equal(issue.currentExecutableAbility.blockAgeSecondsAtIssue, 80)
    assert.equal(issue.currentExecutableAbility.captureAgeSecondsAtIssue, 30)
    assert.equal(issue.futureForecast.status, 'unavailable')
    assert.equal(issue.futureForecast.probability, null)
    assert.equal(issue.futureForecast.likelyDurationSeconds, null)
    assert.equal(issue.outcomeProtocol.targetUtc, issue.targetUtc)
    assert.equal(
      issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc,
      new Date(Date.parse(issue.targetUtc) + 5400 * 1000).toISOString(),
    )
    assert.equal(issue.outcomeProtocol.comparability.maxAdjacentVerifiedQuoteGapSeconds, 7200)
    assert.equal(issue.outcomeProtocol.comparability.status, 'unverified')
    assert.equal(issue.outcomeProtocol.comparability.codeAndImplementationIdentityVerified, false)
    assert.equal(issue.outcomeProtocol.comparability.continuousExitAvailability, 'unavailable')
    assert.equal(issue.outcomeProtocol.version, 'scrvusd-now-origin-exit-outcome-v2')
    const codeRule = issue.outcomeProtocol.comparability.codeIdentityRule
    assert.deepEqual(codeRule.compareFields, ['vaultCodeHash', 'target', 'targetCodeHash'])
    assert.equal(
      codeRule.captureDeadlineUtc,
      issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc,
    )
    assert.equal(codeRule.absentAnchor, 'unknown')
    assert.equal(codeRule.missingOrLateSample, 'unknown')
    assert.equal(codeRule.anyFieldMismatch, 'changed')
    assert.equal(codeRule.allSampledFieldsMatch, 'sampled_match_only')
    assert.equal(codeRule.pointOutcomeUnaffectedByCodeStatus, true)
    assert.equal(issue.historicalContext.flowStatus, 'as_of_context')
    assert.equal(issue.source.flowContext.physicalSha256, input.flowRow.physicalSha256)
  }
})

test('short caller-chosen horizon is sealed as below sampling resolution', () => {
  const input = fixture()
  for (const horizonSeconds of [1, 90, 3599]) {
    const issue = buildIssue({ ...input, horizonSeconds })
    assert.equal(issue.outcomeProtocol.horizonResolution, 'below_one_hour_sampling_resolution')
    assert.equal(issue.futureForecast.status, 'unavailable')
    assert.equal(verifyIssue(issue, input), issue)
  }
  assert.equal(
    buildIssue({ ...input, horizonSeconds: 3600 }).outcomeProtocol.horizonResolution,
    'eligible_for_discrete_sample_only',
  )
})

test('outcome selection and comparability rules are replay-bound even after a valid reseal', () => {
  const input = fixture()
  const saved = buildIssue(input)
  assert.deepEqual(saved.outcomeProtocol, outcomeProtocol(input.issuedAtUtc, input.horizonSeconds))
  assert.deepEqual(saved.outcomeProtocol.checkpointSelection.tieBreak, [
    'earlier_block_number',
    'lexicographically_smaller_block_hash',
  ])
  assert.deepEqual(saved.outcomeProtocol.holderProbe.inspectStatuses, [
    'success',
    'revert',
    'provider_error',
    'missing',
  ])
  assert.equal(saved.outcomeProtocol.holderProbe.requireCaptureEndUtcByDeadline, true)
  const { sha256: _oldSeal, ...payload } = saved
  const changed = {
    ...payload,
    outcomeProtocol: {
      ...payload.outcomeProtocol,
      checkpointSelection: {
        ...payload.outcomeProtocol.checkpointSelection,
        windowSeconds: 3600,
      },
    },
  }
  const resealed = {
    ...changed,
    sha256: createHash('sha256').update(JSON.stringify(changed)).digest('hex'),
  }
  assert.throws(() => verifyIssue(resealed, input), /as-of replay/)
  const alteredCodeRule = {
    ...payload,
    outcomeProtocol: {
      ...payload.outcomeProtocol,
      comparability: {
        ...payload.outcomeProtocol.comparability,
        codeIdentityRule: {
          ...payload.outcomeProtocol.comparability.codeIdentityRule,
          missingOrLateSample: 'sampled_match_only',
        },
      },
    },
  }
  assert.throws(
    () =>
      verifyIssue(
        {
          ...alteredCodeRule,
          sha256: sha(JSON.stringify(alteredCodeRule)),
        },
        input,
      ),
    /as-of replay/,
  )
})

test('admits a missing flow companion without inventing quiet flow', () => {
  const issue = buildIssue({ ...fixture(), flowRow: null })
  assert.equal(issue.source.flowContext, null)
  assert.equal(issue.historicalContext.flow, null)
  assert.equal(issue.historicalContext.flowStatus, 'unavailable')
})

test('valid same-block attestation is sealed as current mechanism, with future comparability unverified', () => {
  const input = fixture()
  const row = attestationRow(input)
  const issue = buildIssue({ ...input, attestationRow: row })
  assert.deepEqual(issue.source.targetCodeAttestation, {
    filename: row.filename,
    logicalSha256: row.issue.sha256,
    physicalSha256: row.physicalSha256,
  })
  assert.equal(issue.currentMechanismContext.status, 'same_block_target_code_attested')
  assert.equal(issue.currentMechanismContext.vaultCodeHash, row.issue.vaultCodeHash)
  assert.equal(issue.currentMechanismContext.embeddedTargetCodeHash, row.issue.targetCodeHash)
  assert.equal(issue.currentMechanismContext.crossTimeComparability, 'unverified')
  assert.equal(issue.outcomeProtocol.comparability.status, 'unverified')
  assert.equal(verifyIssue(issue, { ...input, attestationRow: row }), issue)
  assert.throws(() => verifyIssue(issue, input), /as-of replay/)
})

test('future, mismatched, and tampered attestation cannot bind to an issue', () => {
  const input = fixture()
  const row = attestationRow(input)
  assert.throws(
    () => buildIssue({ ...input, attestationRow: attestationRow(input, at(81)) }),
    /Attestation/,
  )
  assert.throws(
    () => buildIssue({ ...input, attestationRow: { ...row, physicalSha256: hash('9') } }),
    /Attestation/,
  )
  const mismatched = {
    ...row,
    issue: { ...row.issue, source: { ...row.issue.source, vault: `0x${'3'.repeat(40)}` } },
  }
  assert.throws(() => buildIssue({ ...input, attestationRow: mismatched }), /Attestation/)
  const wrongBlock = {
    ...row,
    issue: { ...row.issue, block: { ...block, hash: `0x${hash('9')}` } },
  }
  assert.throws(() => buildIssue({ ...input, attestationRow: wrongBlock }), /Attestation/)
  const none = buildIssue(input)
  assert.equal(none.source.targetCodeAttestation, null)
  assert.equal(none.currentMechanismContext.status, 'unverified')
})

test('canonical receipt reader ignores a verified receipt captured after as-of and rejects physical tamper', () => {
  const input = fixture()
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-code-issue-'))
  const row = attestationRow(input)
  const path = join(out, row.filename)
  writeFileSync(path, `${JSON.stringify(row.issue)}\n`)
  const read = (asOfUtc) =>
    readVerifiedAtCheckpoint({
      out,
      checkpoint: input.latestCheckpoint,
      asOfUtc,
      nowUtc: at(90),
    })
  assert.deepEqual(read(at(80)), row)
  assert.equal(read(at(70)), null)
  writeFileSync(path, `${JSON.stringify(row.issue)} \n`)
  assert.throws(() => read(at(80)), /physical bytes/)
})

test('rejects stale/future source and invalid horizons', () => {
  const base = fixture()
  assert.throws(() => buildIssue({ ...base, issuedAtUtc: at(3651) }), /stale/)
  assert.equal(
    buildIssue({ ...base, issuedAtUtc: at(3600) }).currentExecutableAbility.blockAgeSecondsAtIssue,
    3600,
  )
  assert.throws(() => buildIssue({ ...base, issuedAtUtc: at(3601) }), /stale/)
  assert.throws(() => buildIssue({ ...base, issuedAtUtc: at(49) }), /stale/)
  assert.throws(() => buildIssue({ ...base, horizonSeconds: 0 }), /stale/)
  assert.throws(() => buildIssue({ ...base, horizonSeconds: 1.5 }), /stale/)
  assert.throws(() => buildIssue({ ...base, horizonSeconds: 31_536_001 }), /stale/)
  assert.throws(
    () =>
      buildIssue({
        ...base,
        latestCheckpoint: {
          checkpoint: { block: { ...block, number: block.number + 1 }, captureEndUtc: at(65) },
        },
      }),
    /stale/,
  )
  assert.throws(
    () =>
      buildIssue({ ...base, latestCheckpoint: { checkpoint: { block, captureEndUtc: at(81) } } }),
    /stale/,
  )
})

test('rejects holder, duration, physical seal, and flow provenance mismatch', () => {
  const base = fixture()
  assert.throws(
    () => buildIssue({ ...base, holderRow: { ...base.holderRow, physicalSha256: hash('7') } }),
    /stale/,
  )
  assert.throws(
    () =>
      buildIssue({
        ...base,
        durationRow: {
          ...base.durationRow,
          issue: { ...base.durationRow.issue, holder: `0x${'2'.repeat(40)}` },
        },
      }),
    /stale/,
  )
  assert.throws(
    () =>
      buildIssue({
        ...base,
        holderRow: {
          ...base.holderRow,
          issue: {
            ...base.holderRow.issue,
            result: { ...base.holderRow.issue.result, status: 'revert' },
          },
        },
      }),
    /stale/,
  )
  assert.throws(
    () =>
      buildIssue({
        ...base,
        flowRow: { ...base.flowRow, issue: { ...base.flowRow.issue, issuedAtUtc: at(81) } },
      }),
    /Flow context/,
  )
  assert.throws(
    () =>
      buildIssue({
        ...base,
        flowRow: {
          ...base.flowRow,
          issue: {
            ...base.flowRow.issue,
            durationIssue: { ...base.flowRow.issue.durationIssue, physicalSha256: hash('7') },
          },
        },
      }),
    /Flow context/,
  )
})

test('logical tamper and a changed source are rejected on replay', () => {
  const input = fixture()
  const saved = buildIssue(input)
  assert.equal(verifyIssue(saved, input), saved)
  assert.throws(
    () =>
      verifyIssue(
        { ...saved, futureForecast: { ...saved.futureForecast, status: 'research_forecast' } },
        input,
      ),
    /logical seal/,
  )
  assert.throws(() => verifyIssue(saved, { ...input, flowRow: null }), /as-of replay/)
})

test('v2 pure bound issue binds full attempt SHA and remains unconfirmed research evidence', () => {
  const input = boundFixture()
  const first = buildBoundIssueV2(input)
  assert.equal(first.study, 'scrvusd-now-origin-exit-forecast-issue-v2')
  assert.equal(first.evidenceClass, 'local_research_only')
  assert.equal(first.scheduledCoverageStatus, 'unconfirmed')
  assert.equal(first.scheduleBinding.manifestSha256, input.manifest.sha256)
  assert.equal(first.scheduleBinding.slotId, input.slotId)
  assert.equal(first.scheduleBinding.horizonSeconds, input.horizonSeconds)
  assert.deepEqual(first.scheduleBinding.attemptStart, rowRef(input.attemptStartRow))
  assert.equal(first.scheduleBinding.confirmationStatus, 'unconfirmed')
  assert.equal(first.scheduleBinding.evidenceClass, 'local_research_only')
  assert.equal(first.futureForecast.status, 'unavailable')
  assert.ok(boundIssueNameV2(first).includes(input.attemptStartRow.issue.sha256))
  assert.ok(boundIssueNameV2(first).endsWith(`${first.sha256}.json`))
  assert.equal(verifyBoundIssueV2(first, input), first)

  const retryStart = buildAttemptStartV1({
    manifest: input.manifest,
    slotId: input.slotId,
    horizonSeconds: input.horizonSeconds,
    recordedAtUtc: at(1),
  })
  const retry = buildBoundIssueV2({
    ...input,
    attemptStartRow: rowWithBytes(attemptStartNameV1(retryStart), retryStart),
  })
  assert.notEqual(first.sha256, retry.sha256)
  assert.notEqual(boundIssueNameV2(first), boundIssueNameV2(retry))
  const laterSameAttempt = buildBoundIssueV2({ ...input, issuedAtUtc: at(81) })
  assert.notEqual(boundIssueNameV2(first), boundIssueNameV2(laterSameAttempt))
  assert.equal(buildIssue(input).study, 'scrvusd-now-origin-exit-forecast-issue-v1')
})

test('v2 rejects forged bindings, source refs, and resealed payload tampering', () => {
  const input = boundFixture()
  const issue = buildBoundIssueV2(input)
  const changedStart = rowWithBytes(input.attemptStartRow.filename, {
    ...input.attemptStartRow.issue,
    holder: `0x${'2'.repeat(40)}`,
  })
  assert.throws(
    () => buildBoundIssueV2({ ...input, attemptStartRow: changedStart }),
    /Attempt start/,
  )
  assert.throws(
    () =>
      buildBoundIssueV2({
        ...input,
        holderRow: { ...input.holderRow, physicalSha256: hash('1') },
      }),
    /Holder exact/,
  )
  assert.throws(
    () =>
      buildBoundIssueV2({
        ...input,
        publicationProof: { ...input.publicationProof, confirmerXid: '101' },
      }),
    /post-commit/,
  )
  assert.throws(() => buildBoundIssueV2({ ...input, publicationProof: null }), /readback/)
  assert.throws(
    () =>
      buildBoundIssueV2({
        ...input,
        publicationProof: { ...input.publicationProof, manifestSha256: hash('0') },
      }),
    /post-commit/,
  )
  const { sha256: _old, ...body } = issue
  const resealed = sealed({
    ...body,
    scheduleBinding: { ...body.scheduleBinding, confirmationStatus: 'confirmed' },
  })
  assert.throws(() => verifyBoundIssueV2(resealed, input), /replay mismatch/)
})

test('v2 enforces half-open slot and start-before-sources chronology', () => {
  const input = boundFixture()
  const earlyQuote = reseal({
    ...input.latestCheckpoint.checkpoint,
    captureStartUtc: at(-1),
  })
  const earlyQuoteRow = {
    filename: input.latestCheckpoint.filename,
    checkpoint: earlyQuote,
    physicalSha256: sha(`${JSON.stringify(earlyQuote)}\n`),
  }
  const earlyDuration = reseal({
    ...input.durationRow.issue,
    quote: {
      filename: earlyQuoteRow.filename,
      logicalSha256: earlyQuote.sha256,
      physicalSha256: earlyQuoteRow.physicalSha256,
    },
  })
  const earlyDurationRow = rowWithBytes(input.durationRow.filename, earlyDuration)
  const earlyFlow = reseal({
    ...input.flowRow.issue,
    durationIssue: rowRef(earlyDurationRow),
  })
  assert.throws(
    () =>
      buildBoundIssueV2({
        ...input,
        latestCheckpoint: earlyQuoteRow,
        durationRow: earlyDurationRow,
        flowRow: rowWithBytes(input.flowRow.filename, earlyFlow),
      }),
    /source was not collected/,
  )
  const lateStart = buildAttemptStartV1({
    manifest: input.manifest,
    slotId: input.slotId,
    horizonSeconds: input.horizonSeconds,
    recordedAtUtc: at(51),
  })
  assert.throws(
    () =>
      buildBoundIssueV2({
        ...input,
        attemptStartRow: rowWithBytes(attemptStartNameV1(lateStart), lateStart),
      }),
    /source was not collected/,
  )
  assert.throws(
    () =>
      buildAttemptStartV1({
        manifest: input.manifest,
        slotId: input.slotId,
        horizonSeconds: input.horizonSeconds,
        recordedAtUtc: input.manifest.slots[0].closesAtUtc,
      }),
    /half-open/,
  )
  assert.throws(
    () =>
      buildBoundIssueV2({
        ...input,
        issuedAtUtc: input.manifest.slots[0].closesAtUtc,
      }),
    /scheduled source chronology/,
  )
  assert.throws(
    () =>
      buildBoundIssueV2({
        ...input,
        publicationProof: {
          ...input.publicationProof,
          confirmedAtUtc: input.manifest.startAtUtc,
        },
      }),
    /post-commit/,
  )
})

function boundEvidenceFixture() {
  const input = boundFixture()
  const issue = buildBoundIssueV2(input)
  const issueRow = rowWithBytes(boundIssueNameV2(issue), issue)
  const publication = {
    ...input.publicationProof,
    evidenceClass: 'db_confirmed_manifest_only',
    prospectiveScheduleConfirmed: true,
  }
  const manifestVisibility = {
    manifest: input.manifest,
    manifestSha256: input.manifest.sha256,
    persistedAtUtc: publication.persistedAtUtc,
    confirmedAtUtc: publication.confirmedAtUtc,
    publisherXid: publication.publisherXid,
    confirmerXid: publication.confirmerXid,
    manifestVisibleAtUtc: new Date(Date.parse(publication.confirmedAtUtc) + 60_000).toISOString(),
    witnessXid: '406',
    evidenceClass: 'db_witnessed_manifest',
    historicalPublicationAvailabilityCertified: true,
    prospectiveScheduleConfirmed: true,
  }
  const arms = [3600, 7200, 86400, 604800].map((horizonSeconds, index) => {
    const receipt =
      horizonSeconds === input.horizonSeconds
        ? input.attemptStartRow.issue
        : buildAttemptStartV1({
            manifest: input.manifest,
            slotId: input.slotId,
            horizonSeconds,
            recordedAtUtc: at(0),
          })
    return {
      horizonSeconds,
      status:
        horizonSeconds === input.horizonSeconds ? 'db_reported_issued_unverified' : 'abstained',
      startedAtUtc: at(index + 1),
      startXid: String(201 + index),
      startLogicalSha256: receipt.sha256,
      startPhysicalSha256: sha(`${JSON.stringify(receipt)}\n`),
      startPayload: JSON.stringify(receipt),
      resultAtUtc: at(90 + index),
      resultXid: String(301 + index),
      issueLogicalSha256: horizonSeconds === input.horizonSeconds ? issue.sha256 : null,
      issuePhysicalSha256: horizonSeconds === input.horizonSeconds ? issueRow.physicalSha256 : null,
      issuePayload: horizonSeconds === input.horizonSeconds ? JSON.stringify(issue) : null,
    }
  })
  const run = {
    manifestSha256: input.manifest.sha256,
    slotId: input.slotId,
    arms,
    startConfirmedAtUtc: at(10),
    startConfirmerXid: '401',
    sourceCaptureFloorUtc: at(20),
    captureFloorXid: '402',
    runConfirmedAtUtc: at(100),
    runConfirmerXid: '403',
    runCoverageConfirmed: true,
  }
  const sourceStart = {
    manifestSha256: input.manifest.sha256,
    slotId: input.slotId,
    nonceSha256: hash('f'),
    captureFloorAtUtc: run.sourceCaptureFloorUtc,
    captureFloorXid: run.captureFloorXid,
    sourceStartAtUtc: at(25),
    sourceStartXid: '404',
    sourceCollectionIndependentlyTimed: false,
  }
  const runVisibility = {
    manifestSha256: input.manifest.sha256,
    slotId: input.slotId,
    nonceSha256: sourceStart.nonceSha256,
    sourceStartAtUtc: sourceStart.sourceStartAtUtc,
    sourceStartXid: sourceStart.sourceStartXid,
    runConfirmerXid: run.runConfirmerXid,
    runVisibleAtUtc: at(110),
    witnessXid: '405',
    historicalAvailabilityCertifiedForRun: true,
  }
  return { input, issueRow, publication, manifestVisibility, run, sourceStart, runVisibility }
}

test('v2 DB evidence validator links four committed arms and exact issue bytes without forecasting', () => {
  const { input, issueRow, publication, manifestVisibility, run, sourceStart, runVisibility } =
    boundEvidenceFixture()
  const evidence = validateBoundIssueEvidenceV2({
    issueRow,
    attemptStartRow: input.attemptStartRow,
    sources: input,
    publication,
    manifestVisibility,
    run,
    sourceStart,
    runVisibility,
    nowUtc: at(120),
  })
  assert.equal(evidence.scheduledCoverageStatus, 'verified_against_supplied_db_rows')
  assert.equal(
    evidence.captureChronology,
    'self_reported_timestamps_consistent_with_db_source_start',
  )
  assert.equal(evidence.sourceCollectionIndependentlyTimed, false)
  assert.equal(evidence.forecastEligible, false)
  assert.equal(evidence.probability, null)
  assert.equal(evidence.likelyDurationSeconds, null)
})

test('v2 DB evidence validator fails closed on missing proof, source timing, and receipt mismatch', () => {
  const { input, issueRow, publication, manifestVisibility, run, sourceStart, runVisibility } =
    boundEvidenceFixture()
  const check = (changes) =>
    validateBoundIssueEvidenceV2({
      issueRow,
      attemptStartRow: input.attemptStartRow,
      sources: input,
      publication,
      manifestVisibility,
      run,
      sourceStart,
      runVisibility,
      nowUtc: at(120),
      ...changes,
    })
  assert.throws(() => check({ run: { ...run, runCoverageConfirmed: false } }), /run proof/)
  assert.throws(
    () => check({ manifestVisibility: null }),
    /manifest visibility witness missing or mismatched/,
  )
  assert.throws(
    () =>
      check({
        manifestVisibility: { ...manifestVisibility, manifestSha256: hash('0') },
      }),
    /manifest visibility witness missing or mismatched/,
  )
  assert.throws(
    () =>
      check({
        manifestVisibility: { ...manifestVisibility, witnessXid: publication.publisherXid },
      }),
    /transactions overlap/,
  )
  assert.throws(() => check({ run: { ...run, arms: run.arms.slice(1) } }), /run proof/)
  assert.throws(() => check({ sourceStart: null }), /source-start or run-visibility/)
  assert.throws(() => check({ runVisibility: null }), /source-start or run-visibility/)
  assert.throws(
    () => check({ runVisibility: { ...runVisibility, nonceSha256: hash('0') } }),
    /source-start or run-visibility/,
  )
  assert.throws(
    () => check({ runVisibility: { ...runVisibility, runVisibleAtUtc: at(90) } }),
    /missed slot/,
  )
  assert.throws(
    () =>
      check({
        sourceStart: { ...sourceStart, sourceStartAtUtc: at(35) },
        runVisibility: {
          ...runVisibility,
          sourceStartAtUtc: at(35),
        },
      }),
    /Source capture began/,
  )
  assert.throws(
    () => check({ run: { ...run, sourceCaptureFloorUtc: at(31) } }),
    /source-start or run-visibility/,
  )
  assert.throws(
    () => check({ run: { ...run, captureFloorXid: run.startConfirmerXid } }),
    /source-start or run-visibility/,
  )
  assert.throws(
    () => check({ runVisibility: { ...runVisibility, witnessXid: run.runConfirmerXid } }),
    /transactions overlap/,
  )
  assert.throws(
    () =>
      check({
        run: {
          ...run,
          arms: run.arms.map((arm) =>
            arm.horizonSeconds === input.horizonSeconds
              ? { ...arm, issuePayload: `${arm.issuePayload} ` }
              : arm,
          ),
        },
      }),
    /exact payload bytes/,
  )
  assert.throws(
    () => check({ publication: { ...publication, prospectiveScheduleConfirmed: false } }),
    /publication proof/,
  )
})

test('v2 PostgreSQL entry point runs audited adapter and rejects an unaudited pool', async () => {
  const { input, issueRow } = boundEvidenceFixture()
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-bound-v2-'))
  writeFileSync(join(out, issueRow.filename), `${JSON.stringify(issueRow.issue)}\n`)
  writeFileSync(
    join(out, input.attemptStartRow.filename),
    `${JSON.stringify(input.attemptStartRow.issue)}\n`,
  )
  let queried = 0
  const pool = {
    async connect() {
      return {
        async query() {
          queried += 1
          return { rows: [{}] }
        },
        release() {},
      }
    },
  }
  await assert.rejects(
    verifyBoundIssueWithPgV2({
      pool,
      issueOut: out,
      issueFilename: issueRow.filename,
      attemptStartOut: out,
      now: () => new Date(at(120)),
    }),
    /publisher role audit failed/,
  )
  assert.equal(queried, 1)
})

test('v2 supplied-store entry point requires fresh as-of read methods', async () => {
  await assert.rejects(
    verifyBoundIssueFromStoresV2({
      scheduleStore: { readConfirmed() {} },
      attemptStore: { readRun() {} },
      asOfStore: { readSourceStart() {}, readRunWitness() {} },
      issueOut: '/private/tmp/missing-v2-issue',
      attemptStartOut: '/private/tmp/missing-v2-start',
    }),
    /schedule, attempt, and as-of stores required/,
  )
})
