import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { keccak256 } from 'viem'
import { buildScore, readScoreAttestations, replayScore } from './scrvusd-exit-forecast-score.mjs'
import { outcomeProtocol, readRow } from './scrvusd-exit-forecast-issue.mjs'
import { sourceIdentity } from './curve-prospective-quote.mjs'
import {
  STUDY_V2,
  finalizeBoundScoreWithPgV2,
  requireBoundScoreVisibilityWithPgV2,
  scoreBoundIssueWithPgV2,
  verifyBoundScoresWithPgV2,
} from './scrvusd-bound-exit-forecast-score.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const h = (char) => char.repeat(64)
const start = 1_780_000_000
const iso = (seconds) => new Date((start + seconds) * 1000).toISOString()
const holder = `0x${'1'.repeat(40)}`
const qAssetsRaw = '1000'
const route = 'direct_erc4626_withdraw_crvusd_from_scrvusd'
const block = (offset, index) => ({
  number: 100 + index,
  hash: `0x${index.toString(16).padStart(64, '0')}`,
  timestamp: start + offset,
})
const name = (b) => `${String(b.number).padStart(12, '0')}-${b.hash.slice(2)}.json`
const ref = (row, content) => ({
  filename: row.filename,
  logicalSha256: content.sha256,
  physicalSha256: row.physicalSha256,
})

function quote(offset, index, captured = offset + 10) {
  const b = block(offset, index)
  const checkpoint = { block: b, captureEndUtc: iso(captured), sha256: h('a') }
  return { filename: name(b), checkpoint, physicalSha256: h('b') }
}

function probe(
  quoteRow,
  status = 'success',
  captured = quoteRow.checkpoint.block.timestamp - start + 20,
  balance = '2000',
) {
  const issue = {
    checkpoint: { block: quoteRow.checkpoint.block },
    captureEndUtc: iso(captured),
    holder,
    rawCrvUsd: qAssetsRaw,
    result: {
      status,
      maxWithdrawAssetsRaw: status === 'success' ? '2000' : '2000',
      balanceSharesRaw: balance,
      previewSharesRaw: '1000',
    },
    sha256: h('c'),
  }
  return { filename: quoteRow.filename, issue, physicalSha256: h('d') }
}

function attestation(quoteRow, { targetChar = '2', targetCode = '0x6000600055', captured } = {}) {
  const b = quoteRow.checkpoint.block
  const target = `0x${targetChar.repeat(40)}`
  const vaultRuntime = `0x363d3d373d3d3d363d73${target.slice(2)}5af43d82803e903d91602b57fd5bf3`
  const end = captured ?? b.timestamp - start + 12
  const receipt = seal({
    study: 'scrvusd-target-code-attestation-v1',
    kind: 'prospective-code-identity',
    source: sourceIdentity(),
    checkpoint: {
      filename: quoteRow.filename,
      logicalSha256: quoteRow.checkpoint.sha256,
      physicalSha256: quoteRow.physicalSha256,
      captureEndUtc: quoteRow.checkpoint.captureEndUtc,
    },
    block: b,
    captureStartUtc: iso(end - 1),
    captureEndUtc: iso(end),
    status: 'attested',
    route: 'exact_eip1167_runtime',
    vaultRuntime,
    vaultCodeHash: keccak256(vaultRuntime),
    target,
    targetCode,
    targetCodeHash: keccak256(targetCode),
  })
  return {
    filename: quoteRow.filename,
    issue: receipt,
    physicalSha256: sha(`${JSON.stringify(receipt)}\n`),
  }
}

function bindAnchor(input, anchorRow) {
  const { sha256: _oldSeal, ...payload } = input.issueRow.issue
  input.issueRow.issue = seal({
    ...payload,
    source: {
      ...payload.source,
      targetCodeAttestation: ref(anchorRow, anchorRow.issue),
    },
  })
  input.attestationRows = [anchorRow]
}

function fixture(horizon = 7200) {
  const anchor = quote(0, 0, 10)
  const anchorHolder = probe(anchor, 'success', 20)
  const issuedAtUtc = iso(30)
  const protocol = outcomeProtocol(issuedAtUtc, horizon)
  const issue = seal({
    study: 'scrvusd-now-origin-exit-forecast-issue-v1',
    issuedAtUtc,
    targetUtc: protocol.targetUtc,
    horizonSeconds: horizon,
    outcomeProtocol: protocol,
    anchorBlock: anchor.checkpoint.block,
    holder,
    qAssetsRaw,
    route,
    source: {
      quoteCheckpoint: ref(anchor, anchor.checkpoint),
      holderProbe: ref(anchorHolder, anchorHolder.issue),
    },
    currentExecutableAbility: { status: 'sampled_success', balanceSharesRaw: '2000' },
    futureForecast: { status: 'unavailable' },
  })
  return {
    issueRow: { filename: 'issue.json', issue, physicalSha256: h('e') },
    checkpoints: [anchor],
    holderRows: [anchorHolder],
    scoredAtUtc: protocol.checkpointSelection.captureDeadlineUtc,
  }
}

test('v2 outcome replay requires explicit study dispatch and preserves sealed evidence', () => {
  const input = fixture()
  const { sha256: _oldSeal, ...unsigned } = input.issueRow.issue
  input.issueRow.issue = seal({
    ...unsigned,
    study: 'scrvusd-now-origin-exit-forecast-issue-v2',
  })
  assert.throws(() => buildScore(input), /Invalid or altered NOW-origin issue/)
  const score = buildScore({
    ...input,
    issueStudy: 'scrvusd-now-origin-exit-forecast-issue-v2',
    scoreStudy: STUDY_V2,
  })
  assert.equal(score.study, STUDY_V2)
  assert.equal(score.pointOutcome.status, 'missing_quote_checkpoint')
  assert.deepEqual(
    replayScore({
      saved: score,
      ...input,
      issueStudy: 'scrvusd-now-origin-exit-forecast-issue-v2',
      scoreStudy: STUDY_V2,
    }),
    {
      additionalEligibleEvidence: {
        quotes: 0,
        holders: 0,
        attestations: 0,
        invalidAttestationBlocks: 0,
      },
      wouldChangeResult: false,
    },
  )
})

test('v2 durable score APIs fail closed without PostgreSQL pool', async () => {
  await assert.rejects(scoreBoundIssueWithPgV2({ issueFilename: 'x.json' }), /PostgreSQL pool/)
  await assert.rejects(verifyBoundScoresWithPgV2({}), /PostgreSQL pool/)
})

function finalizationFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bound-score-finalize-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const issueOut = join(root, 'issues')
  const out = join(root, 'scores')
  mkdirSync(issueOut)
  mkdirSync(out)
  const issueFilename = 'exact-arm.json'
  const issue = seal({
    study: 'scrvusd-now-origin-exit-forecast-issue-v2',
    scheduleBinding: { manifestSha256: h('a'), slotId: 'slot-one' },
    horizonSeconds: 3600,
  })
  const issueBytes = `${JSON.stringify(issue)}\n`
  writeFileSync(join(issueOut, issueFilename), issueBytes)
  const score = seal({
    study: STUDY_V2,
    issue: {
      filename: issueFilename,
      logicalSha256: issue.sha256,
      physicalSha256: sha(issueBytes),
    },
  })
  const scoreBytes = `${JSON.stringify(score)}\n`
  writeFileSync(join(out, issueFilename), scoreBytes)
  const receipt = {
    issueLogicalSha256: issue.sha256,
    issuePhysicalSha256: sha(issueBytes),
    scoreFilename: issueFilename,
    scoreLogicalSha256: score.sha256,
    scorePhysicalSha256: sha(scoreBytes),
    scorePayload: JSON.stringify(score),
    scoreVisibleAtUtc: null,
    witnessXid: null,
  }
  return { out, issueOut, issueFilename, score, receipt }
}

test('public v2 score admission requires exact committed visibility, with a target-only recovery state', async (t) => {
  const fixture = finalizationFixture(t)
  const issueRow = readRow(fixture.issueOut, fixture.issueFilename)
  const scoreRow = readRow(fixture.out, fixture.issueFilename)
  let receipt = null
  const options = {
    asOfStore: { readScoreWitness: async () => receipt },
    issueRow,
    scoreRow,
  }
  await assert.rejects(
    requireBoundScoreVisibilityWithPgV2(options),
    /visibility witness unavailable/,
  )
  assert.equal(
    await requireBoundScoreVisibilityWithPgV2({ ...options, allowUnwitnessed: true }),
    null,
  )
  receipt = fixture.receipt
  await assert.rejects(
    requireBoundScoreVisibilityWithPgV2(options),
    /visibility witness unavailable/,
  )
  receipt = { ...receipt, scorePhysicalSha256: h('f') }
  await assert.rejects(
    requireBoundScoreVisibilityWithPgV2({ ...options, allowUnwitnessed: true }),
    /differs from exact local score/,
  )
  receipt = { ...fixture.receipt, scoreVisibleAtUtc: iso(9000), witnessXid: '2' }
  assert.equal(await requireBoundScoreVisibilityWithPgV2(options), receipt)
})

test('v2 finalization replays before recording, then reconciles a pending DB receipt on retry', async (t) => {
  const fixture = finalizationFixture(t)
  const events = []
  let persisted = null
  let failWitness = true
  const asOfStore = {
    async readScoreWitness() {
      events.push('read')
      return persisted
    },
    async recordScore() {
      events.push('record')
      persisted = fixture.receipt
      return persisted
    },
    async witnessScore() {
      events.push('witness')
      if (failWitness) throw new Error('simulated witness crash')
      persisted = { ...persisted, scoreVisibleAtUtc: iso(9000), witnessXid: '2' }
      return persisted
    },
  }
  const options = {
    pool: {},
    ...fixture,
    asOfStore,
    verifyScores: async ({ allowUnwitnessedFilename }) => {
      assert.equal(allowUnwitnessedFilename, fixture.issueFilename)
      events.push('replay')
    },
  }
  await assert.rejects(finalizeBoundScoreWithPgV2(options), /simulated witness crash/)
  assert.deepEqual(events, ['replay', 'read', 'record', 'witness'])
  failWitness = false
  events.length = 0
  const recovered = await finalizeBoundScoreWithPgV2(options)
  assert.equal(recovered.status, 'scored')
  assert.equal(recovered.forecastEligible, false)
  assert.deepEqual(events, ['replay', 'read', 'witness'])
  events.length = 0
  const retry = await finalizeBoundScoreWithPgV2(options)
  assert.equal(retry.status, 'already_scored')
  assert.deepEqual(events, ['replay', 'read'])
})

test('v2 finalization rejects failed replay and mismatched persisted score before any write', async (t) => {
  const fixture = finalizationFixture(t)
  const events = []
  const asOfStore = {
    async readScoreWitness() {
      events.push('read')
      return { ...fixture.receipt, scorePhysicalSha256: h('f') }
    },
    async recordScore() {
      events.push('record')
    },
    async witnessScore() {
      events.push('witness')
    },
  }
  const options = { pool: {}, ...fixture, asOfStore }
  await assert.rejects(
    finalizeBoundScoreWithPgV2({
      ...options,
      verifyScores: async () => {
        throw new Error('replay failed')
      },
    }),
    /replay failed/,
  )
  assert.deepEqual(events, [])
  await assert.rejects(
    finalizeBoundScoreWithPgV2({ ...options, verifyScores: async () => events.push('replay') }),
    /differs from exact local score/,
  )
  assert.deepEqual(events, ['replay', 'read'])
})

test('v2 sealed score rejects a later eligible point-changing sample', () => {
  const input = fixture()
  const { sha256: _oldSeal, ...unsigned } = input.issueRow.issue
  input.issueRow.issue = seal({
    ...unsigned,
    study: 'scrvusd-now-origin-exit-forecast-issue-v2',
  })
  const dispatch = {
    issueStudy: 'scrvusd-now-origin-exit-forecast-issue-v2',
    scoreStudy: STUDY_V2,
  }
  const saved = buildScore({ ...input, ...dispatch })
  const later = quote(7200 + 30, 1)
  input.checkpoints.push(later)
  input.holderRows.push(probe(later, 'success'))
  assert.throws(
    () => replayScore({ saved, ...input, ...dispatch }),
    /contested by additional eligible evidence/,
  )
})

test('nearest verified quote wins before inspecting exact-block holder, even when farther succeeds', () => {
  const input = fixture()
  const near = quote(7200 + 30, 1)
  const far = quote(7200 + 100, 2)
  input.checkpoints.push(near, far)
  input.holderRows.push(probe(near, 'provider_error'), probe(far, 'success'))
  const score = buildScore(input)
  assert.equal(score.pointOutcome.status, 'provider_ambiguity')
  assert.equal(score.pointOutcome.block.number, near.checkpoint.block.number)
  assert.equal(score.pointOutcome.targetOffsetSeconds, 0)
  assert.equal(score.pointOutcome.sampledAtUtc, iso(7230))
  assert.equal(score.pointOutcome.holder, holder)
  assert.equal(score.pointOutcome.qAssetsRaw, qAssetsRaw)
  assert.equal(score.pointOutcome.route, route)
  assert.equal(score.trajectory.status, 'right_censored_ambiguous')
})

test('tie chooses earlier block, and a missing exact-block holder stays missing', () => {
  const input = fixture()
  input.checkpoints.push(quote(7200, 1), quote(7260, 2))
  input.holderRows.push(probe(input.checkpoints[2], 'success'))
  const score = buildScore(input)
  assert.equal(score.selectedQuote.filename, input.checkpoints[1].filename)
  assert.equal(score.pointOutcome.status, 'missing')
  assert.equal(score.pointOutcome.holderProbe, null)
})

test('no target quote is missing capture, not failed exit; finality frontier is explicit', () => {
  const score = buildScore(fixture())
  assert.equal(score.pointOutcome.status, 'missing_quote_checkpoint')
  assert.equal(score.trajectory.status, 'unavailable_missing_capture')
  assert.equal(score.sourceFrontier.status, 'verified_through_checkpoint')
  assert.equal(score.finality, 'source_checkpoints_verified_as_finalized_at_capture')
})

test('deadline is target plus ninety minutes; late evidence is excluded at any score time', () => {
  const input = fixture(3600)
  const onTime = quote(3630, 1, 3635)
  const late = quote(3640, 2, 30 + 3600 + 5401)
  input.checkpoints.push(onTime, late)
  input.holderRows.push(probe(onTime, 'revert', 3640), probe(late, 'success', 30 + 3600 + 5401))
  const score = buildScore({ ...input, scoredAtUtc: iso(30 + 3600 + 5400) })
  assert.equal(score.pointOutcome.status, 'revert')
  assert.equal(score.pointOutcome.block.number, onTime.checkpoint.block.number)
  assert.equal(score.evidenceCutoffUtc, iso(30 + 3600 + 5400))
  assert.deepEqual(
    buildScore({ ...input, scoredAtUtc: iso(3600 + 100000) }).pointOutcome,
    score.pointOutcome,
  )
  assert.throws(() => buildScore({ ...input, scoredAtUtc: iso(3600) }), /deadline/)
})

test('late holder probe does not replace exact-block missingness', () => {
  const input = fixture()
  const selected = quote(7230, 1)
  input.checkpoints.push(selected)
  input.holderRows.push(probe(selected, 'success', 30 + 7200 + 5401))
  assert.equal(buildScore(input).pointOutcome.status, 'missing')
})

test('a receipt persisted after sealing cannot rewrite an earlier scored outcome', () => {
  const input = fixture(3600)
  const first = quote(3670, 2, 3680)
  input.checkpoints.push(first)
  input.holderRows.push(probe(first, 'revert', 3690))
  const saved = buildScore(input)
  assert.equal(saved.pointOutcome.status, 'revert')

  // This receipt claims capture before the deadline but becomes visible only
  // after the score was sealed. It is nearer the target and says success.
  const latePersisted = quote(3630, 1, 3640)
  const expanded = {
    ...input,
    checkpoints: [input.checkpoints[0], latePersisted, first],
    holderRows: [input.holderRows[0], probe(latePersisted, 'success', 3650), input.holderRows[1]],
  }
  assert.equal(buildScore(expanded).pointOutcome.status, 'success')
  assert.throws(
    () => replayScore({ saved, ...expanded }),
    /contested by additional eligible evidence/,
  )
  const replay = replayScore({ saved, ...expanded, allowContested: true })
  assert.equal(replay.wouldChangeResult, true)
  assert.deepEqual(replay.additionalEligibleEvidence, {
    quotes: 1,
    holders: 1,
    attestations: 0,
    invalidAttestationBlocks: 0,
  })
  assert.deepEqual(saved.pointOutcome, buildScore(input).pointOutcome)
  assert.throws(
    () =>
      replayScore({
        saved,
        ...expanded,
        checkpoints: expanded.checkpoints.slice(0, 2),
        allowContested: true,
      }),
    /Sealed quote evidence is unavailable/,
  )
})

test('additional eligible evidence outside the selected path is reported without contesting outcome', () => {
  const input = fixture(3600)
  const selected = quote(3630, 1, 3640)
  input.checkpoints.push(selected)
  input.holderRows.push(probe(selected, 'success', 3650))
  const saved = buildScore(input)
  const farther = quote(5000, 2, 5010)
  const replay = replayScore({
    saved,
    ...input,
    checkpoints: [...input.checkpoints, farther],
  })
  assert.equal(replay.wouldChangeResult, false)
  assert.equal(replay.additionalEligibleEvidence.quotes, 1)
})

test('a newly present eligible code attestation cannot silently revise sampled identity', () => {
  const input = fixture()
  const selected = quote(7230, 1)
  input.checkpoints.push(selected)
  input.holderRows.push(probe(selected))
  bindAnchor(input, attestation(input.checkpoints[0]))
  const saved = buildScore(input)
  assert.equal(saved.sampledCodeIdentity.status, 'unknown')
  const expanded = { ...input, attestationRows: [...input.attestationRows, attestation(selected)] }
  assert.equal(buildScore(expanded).sampledCodeIdentity.status, 'sampled_match_only')
  assert.throws(
    () => replayScore({ saved, ...expanded }),
    /contested by additional eligible evidence/,
  )
  const replay = replayScore({ saved, ...expanded, allowContested: true })
  assert.equal(replay.wouldChangeResult, true)
  assert.equal(replay.additionalEligibleEvidence.attestations, 1)
})

test('first loss, sampled recovery, gap, and attrition remain distinct from point result', () => {
  const input = fixture(18_000)
  const success = quote(3600, 1)
  const loss = quote(7200, 2)
  const recovery = quote(10_800, 3)
  const selected = quote(18_030, 4)
  input.checkpoints.push(success, loss, recovery, selected)
  input.holderRows.push(probe(success), probe(loss, 'revert'), probe(recovery), probe(selected))
  const score = buildScore(input)
  assert.equal(score.pointOutcome.status, 'success')
  assert.equal(score.trajectory.status, 'first_loss_with_recovery_followup_censored')
  assert.equal(score.trajectory.postRecoveryCensor.reason, 'quote_sampling_gap')
  assert.equal(score.trajectory.firstLoss.intervalStartBlock, success.checkpoint.block.number)
  assert.equal(score.trajectory.firstLoss.intervalEndBlock, loss.checkpoint.block.number)
  assert.equal(score.trajectory.firstLoss.intervalStartUtc, iso(3600))
  assert.equal(score.trajectory.firstLoss.intervalEndUtc, iso(7200))
  assert.equal(score.trajectory.firstLoss.intervalStartKind, 'post_issue_clean_success_sample')
  assert.equal(score.trajectory.firstLoss.secondsFromIssueAtStart, 3570)
  assert.equal(score.trajectory.firstLoss.secondsFromIssueAtEnd, 7170)
  assert.deepEqual(score.trajectory.adjacentQuoteGaps, [
    {
      fromBlock: recovery.checkpoint.block.number,
      toBlock: selected.checkpoint.block.number,
      seconds: 7230,
    },
  ])
  const gapInput = fixture(18_000)
  gapInput.checkpoints.push(quote(18_030, 1))
  gapInput.holderRows.push(probe(gapInput.checkpoints[1], 'revert'))
  const gapScore = buildScore(gapInput)
  assert.equal(gapScore.pointOutcome.status, 'revert')
  assert.equal(gapScore.trajectory.status, 'right_censored_ambiguous')
  assert.equal(gapScore.trajectory.censor.reason, 'quote_sampling_gap')
  assert.equal(gapScore.trajectory.adjacentQuoteGaps.length, 1)
  const attritionInput = fixture()
  attritionInput.checkpoints.push(quote(3600, 1), quote(7230, 2))
  attritionInput.holderRows.push(
    probe(attritionInput.checkpoints[1]),
    probe(attritionInput.checkpoints[2], 'revert', 7250, '1500'),
  )
  const attrition = buildScore(attritionInput)
  assert.equal(attrition.pointOutcome.status, 'revert')
  assert.equal(attrition.trajectory.censor.reason, 'share_attrition_or_insufficient_shares')
})

test('first loss from an older successful anchor has a signed NOW-origin start', () => {
  const input = fixture(3600)
  const loss = quote(3630, 1)
  input.checkpoints.push(loss)
  input.holderRows.push(probe(loss, 'revert'))
  const firstLoss = buildScore(input).trajectory.firstLoss
  assert.equal(firstLoss.intervalStartUtc, iso(0))
  assert.equal(firstLoss.intervalEndUtc, iso(3630))
  assert.equal(firstLoss.intervalStartKind, 'pre_issue_anchor_sample')
  assert.match(firstLoss.caveat, /not a positive survival lower bound/)
  assert.equal(firstLoss.secondsFromIssueAtStart, -30)
  assert.equal(firstLoss.secondsFromIssueAtEnd, 3600)
  assert.equal('lowerSeconds' in firstLoss, false)
  assert.equal('upperSeconds' in firstLoss, false)
})

test('a raw success after first loss is not recovery with share attrition or inconsistent diagnostics', () => {
  for (const { kind, expectedReason } of [
    { kind: 'attrition', expectedReason: 'share_attrition_or_insufficient_shares' },
    { kind: 'inadequate_max', expectedReason: 'inconsistent_success_diagnostics' },
  ]) {
    const input = fixture(18_000)
    const loss = quote(3600, 1)
    const rawSuccess = quote(7200, 2)
    const selected = quote(18_030, 3)
    const candidate = probe(rawSuccess, 'success', 7220, kind === 'attrition' ? '1500' : '2000')
    if (kind === 'inadequate_max') candidate.issue.result.maxWithdrawAssetsRaw = '500'
    input.checkpoints.push(loss, rawSuccess, selected)
    input.holderRows.push(probe(loss, 'revert'), candidate, probe(selected))
    const score = buildScore(input)
    assert.equal(score.pointOutcome.status, 'success')
    assert.equal(score.trajectory.status, 'first_loss_with_later_unverified_success')
    assert.equal(score.trajectory.firstLoss.intervalEndBlock, loss.checkpoint.block.number)
    assert.equal(score.trajectory.recovery, null)
    assert.equal(
      score.trajectory.laterSampledSuccess.block.number,
      rawSuccess.checkpoint.block.number,
    )
    assert.equal(score.trajectory.postLossCensor.reason, expectedReason)
  }
})

test('a post-loss quote gap or missing holder prevents a later success from claiming recovery', () => {
  for (const { kind, middleOffset, expectedReason } of [
    { kind: 'gap', middleOffset: 14_400, expectedReason: 'quote_sampling_gap' },
    { kind: 'missing', middleOffset: 7200, expectedReason: 'missing_holder_observation' },
  ]) {
    const input = fixture(18_000)
    const loss = quote(3600, 1)
    const middle = quote(middleOffset, 2)
    const selected = quote(18_030, 3)
    input.checkpoints.push(loss, middle, selected)
    input.holderRows.push(probe(loss, 'revert'), probe(selected))
    if (kind === 'gap') input.holderRows.push(probe(middle))
    const score = buildScore(input)
    assert.equal(score.pointOutcome.status, 'success')
    assert.equal(score.trajectory.status, 'first_loss_with_later_unverified_success')
    assert.equal(score.trajectory.firstLoss.intervalEndBlock, loss.checkpoint.block.number)
    assert.equal(score.trajectory.recovery, null)
    assert.equal(score.trajectory.postLossCensor.reason, expectedReason)
    assert.equal(
      score.trajectory.laterSampledSuccess.block.number,
      kind === 'gap' ? middle.checkpoint.block.number : selected.checkpoint.block.number,
    )
  }
})

test('comparable loss, recovery, and relapse cycles retain the earliest first-loss bound', () => {
  const input = fixture(18_000)
  const firstLoss = quote(3600, 1)
  const firstRecovery = quote(7200, 2)
  const firstRelapse = quote(10_800, 3)
  const secondRecovery = quote(14_400, 4)
  const secondRelapse = quote(18_030, 5)
  input.checkpoints.push(firstLoss, firstRecovery, firstRelapse, secondRecovery, secondRelapse)
  input.holderRows.push(
    probe(firstLoss, 'revert'),
    probe(firstRecovery),
    probe(firstRelapse, 'revert'),
    probe(secondRecovery),
    probe(secondRelapse, 'revert'),
  )
  const score = buildScore(input)
  const { trajectory } = score
  assert.equal(score.pointOutcome.status, 'revert')
  assert.equal(trajectory.status, 'first_loss_with_later_sampled_recovery_and_relapse')
  assert.equal(trajectory.firstLoss.intervalStartBlock, input.issueRow.issue.anchorBlock.number)
  assert.equal(trajectory.firstLoss.intervalEndBlock, firstLoss.checkpoint.block.number)
  assert.equal(trajectory.recovery.block.number, firstRecovery.checkpoint.block.number)
  assert.deepEqual(
    trajectory.relapses.map((interval) => [interval.intervalStartBlock, interval.intervalEndBlock]),
    [
      [firstRecovery.checkpoint.block.number, firstRelapse.checkpoint.block.number],
      [secondRecovery.checkpoint.block.number, secondRelapse.checkpoint.block.number],
    ],
  )
  assert.deepEqual(
    trajectory.subsequentRecoveries.map((item) => item.block.number),
    [secondRecovery.checkpoint.block.number],
  )
  assert.equal(
    trajectory.preFirstLossLastCleanSuccessBlock.number,
    input.issueRow.issue.anchorBlock.number,
  )
  assert.equal(
    trajectory.latestCleanSampledSuccessBlock.number,
    secondRecovery.checkpoint.block.number,
  )
  assert.equal(trajectory.latestComparableStatus, 'sampled_revert')
  assert.equal(trajectory.postRecoveryCensor, null)
})

test('a post-recovery gap or ambiguous probe censors relapse instead of hiding it', () => {
  for (const { kind, middleOffset, expectedReason } of [
    { kind: 'gap', middleOffset: 15_000, expectedReason: 'quote_sampling_gap' },
    { kind: 'provider', middleOffset: 10_800, expectedReason: 'provider_ambiguity' },
  ]) {
    const input = fixture(18_000)
    const loss = quote(3600, 1)
    const recovery = quote(7200, 2)
    const ambiguous = quote(middleOffset, 3)
    const selected = quote(18_030, 4)
    input.checkpoints.push(loss, recovery, ambiguous, selected)
    input.holderRows.push(
      probe(loss, 'revert'),
      probe(recovery),
      probe(ambiguous, kind === 'provider' ? 'provider_error' : 'revert'),
      probe(selected, 'revert'),
    )
    const score = buildScore(input)
    const { trajectory } = score
    assert.equal(score.pointOutcome.status, 'revert')
    assert.equal(trajectory.status, 'first_loss_with_recovery_followup_censored')
    assert.equal(trajectory.firstLoss.intervalEndBlock, loss.checkpoint.block.number)
    assert.equal(trajectory.recovery.block.number, recovery.checkpoint.block.number)
    assert.deepEqual(trajectory.relapses, [])
    assert.equal(trajectory.postRecoveryCensor.reason, expectedReason)
    assert.equal(trajectory.postRecoveryCensor.atBlock.number, ambiguous.checkpoint.block.number)
    assert.equal(
      trajectory.postRecoveryCensor.lastCleanSuccessBlock.number,
      recovery.checkpoint.block.number,
    )
    assert.equal(trajectory.latestComparableStatus, 'sampled_success')
  }
})

test('a pre-issue block captured late cannot become a trajectory loss', () => {
  const input = fixture(3600)
  const stale = quote(20, 1, 40)
  const target = quote(3630, 2)
  input.checkpoints.push(stale, target)
  input.holderRows.push(probe(stale, 'revert', 45), probe(target, 'success'))
  const score = buildScore(input)
  assert.equal(score.pointOutcome.status, 'success')
  assert.equal(score.interveningSamples.length, 1)
  assert.equal(score.interveningSamples[0].block.number, target.checkpoint.block.number)
  assert.equal(score.trajectory.firstLoss, null)
  assert.equal(score.trajectory.status, 'right_censored_at_last_sampled_success')
})

test('rejects mismatched holder or size at an intervening source block', () => {
  const input = fixture()
  const middle = quote(3600, 1)
  const target = quote(7230, 2)
  input.checkpoints.push(middle, target)
  const wrong = probe(middle)
  wrong.issue.holder = `0x${'2'.repeat(40)}`
  input.holderRows.push(wrong, probe(target))
  assert.throws(() => buildScore(input), /Intervening holder\/q/)
  wrong.issue.holder = holder
  wrong.issue.rawCrvUsd = '999'
  assert.throws(() => buildScore(input), /Intervening holder\/q/)
})

test('issue seal, source bind, and changed scoring protocol reject tampering', () => {
  const input = fixture()
  input.issueRow.issue.holder = `0x${'2'.repeat(40)}`
  assert.throws(() => buildScore(input), /altered/)
  const changed = fixture()
  changed.issueRow.issue = seal({
    ...Object.fromEntries(
      Object.entries(changed.issueRow.issue).filter(([key]) => key !== 'sha256'),
    ),
    outcomeProtocol: {
      ...changed.issueRow.issue.outcomeProtocol,
      checkpointSelection: {
        ...changed.issueRow.issue.outcomeProtocol.checkpointSelection,
        windowSeconds: 3600,
      },
    },
  })
  assert.throws(() => buildScore(changed), /altered/)
  const source = fixture()
  source.checkpoints[0].physicalSha256 = h('f')
  assert.throws(() => buildScore(source), /anchor source/)
})

test('code identity is unknown without issue-bound anchor or a complete sampled set', () => {
  const input = fixture()
  const target = quote(7230, 1)
  input.checkpoints.push(target)
  input.holderRows.push(probe(target))
  const noAnchor = buildScore(input)
  assert.equal(noAnchor.sampledCodeIdentity.status, 'unknown')
  assert.equal(noAnchor.sampledCodeIdentity.reason, 'unattested_issue_anchor')
  const anchorAttestation = attestation(input.checkpoints[0])
  bindAnchor(input, anchorAttestation)
  const missing = buildScore(input)
  assert.equal(missing.sampledCodeIdentity.status, 'unknown')
  assert.equal(missing.sampledCodeIdentity.reason, 'missing_or_late_sample_attestation')
  assert.equal(missing.pointOutcome.status, 'success')
  assert.deepEqual(
    missing.sampledCodeIdentity.anchor,
    ref(anchorAttestation, anchorAttestation.issue),
  )
})

test('all exact-block sampled code identities match only at discrete samples', () => {
  const input = fixture()
  const middle = quote(3600, 1)
  const target = quote(7230, 2)
  input.checkpoints.push(middle, target)
  input.holderRows.push(probe(middle), probe(target))
  const anchorAttestation = attestation(input.checkpoints[0])
  bindAnchor(input, anchorAttestation)
  input.attestationRows.push(attestation(middle), attestation(target))
  const score = buildScore(input)
  assert.equal(score.sampledCodeIdentity.status, 'sampled_match_only')
  assert.equal(score.sampledCodeIdentity.samples.length, 2)
  assert.equal(score.sampledCodeIdentity.continuity, 'unverified')
  assert.equal(score.sampledCodeIdentity.causalAttribution, 'unavailable')
  assert.equal(score.pointOutcome.status, 'success')
})

test('sampled code mismatch is changed while point result remains an exit result', () => {
  const input = fixture()
  const target = quote(7230, 1)
  input.checkpoints.push(target)
  input.holderRows.push(probe(target, 'revert'))
  bindAnchor(input, attestation(input.checkpoints[0]))
  input.attestationRows.push(attestation(target, { targetChar: '3' }))
  const score = buildScore(input)
  assert.equal(score.sampledCodeIdentity.status, 'changed')
  assert.equal(score.pointOutcome.status, 'revert')
  assert.equal(score.sampledCodeIdentity.pointOutcomeUnaffected, true)
})

test('observed sampled mismatch takes precedence over another missing attestation', () => {
  const input = fixture()
  const middle = quote(3600, 1)
  const target = quote(7230, 2)
  input.checkpoints.push(middle, target)
  input.holderRows.push(probe(middle), probe(target))
  bindAnchor(input, attestation(input.checkpoints[0]))
  input.attestationRows.push(attestation(middle, { targetChar: '3' }))
  const score = buildScore(input)
  assert.equal(score.sampledCodeIdentity.status, 'changed')
  assert.equal(score.sampledCodeIdentity.reason, 'sampled_code_identity_mismatch')
  assert.equal(score.sampledCodeIdentity.samples[1].attestation, null)
  assert.equal(score.pointOutcome.status, 'success')
})

test('late and invalid optional samples stay unknown without masking point exit', () => {
  const input = fixture()
  const target = quote(7230, 1)
  input.checkpoints.push(target)
  input.holderRows.push(probe(target))
  bindAnchor(input, attestation(input.checkpoints[0]))
  const deadline = 30 + 7200 + 5400
  input.attestationRows.push(attestation(target, { captured: deadline + 1 }))
  const late = buildScore({ ...input, scoredAtUtc: iso(deadline + 2) })
  assert.equal(late.sampledCodeIdentity.status, 'unknown')
  assert.equal(late.sampledCodeIdentity.reason, 'missing_or_late_sample_attestation')
  input.attestationRows[1].physicalSha256 = h('f')
  const invalidPhysical = buildScore({ ...input, scoredAtUtc: iso(deadline + 2) })
  assert.equal(invalidPhysical.sampledCodeIdentity.status, 'unknown')
  assert.equal(invalidPhysical.sampledCodeIdentity.reason, 'invalid_sample_attestation')
  assert.equal(invalidPhysical.pointOutcome.status, 'success')
  input.attestationRows[1] = attestation(target, { captured: deadline + 1 })
  input.attestationRows[1].issue.targetCodeHash = `0x${h('f')}`
  input.attestationRows[1].physicalSha256 = sha(
    `${JSON.stringify(input.attestationRows[1].issue)}\n`,
  )
  const invalidLogical = buildScore({ ...input, scoredAtUtc: iso(deadline + 2) })
  assert.equal(invalidLogical.sampledCodeIdentity.reason, 'invalid_sample_attestation')
  assert.equal(invalidLogical.pointOutcome.status, 'success')
  input.attestationRows[0].physicalSha256 = h('f')
  assert.throws(
    () => buildScore({ ...input, scoredAtUtc: iso(deadline + 2) }),
    /Issue-bound anchor attestation is invalid/,
  )
})

test('optional reader ignores malformed attestations outside the selected quote path', () => {
  const input = fixture()
  const selected = quote(7230, 1)
  const unselected = quote(7250, 2)
  input.checkpoints.push(selected, unselected)
  input.holderRows.push(probe(selected))
  bindAnchor(input, attestation(input.checkpoints[0]))
  const selectedRow = attestation(selected)
  const temp = mkdtempSync(join(tmpdir(), 'exit-code-scope-'))
  try {
    for (const row of [input.attestationRows[0], selectedRow])
      writeFileSync(join(temp, row.filename), `${JSON.stringify(row.issue)}\n`)
    writeFileSync(join(temp, unselected.filename), '{broken json}\n')
    const loaded = readScoreAttestations({
      issue: input.issueRow.issue,
      checkpoints: input.checkpoints,
      out: temp,
      nowUtc: input.scoredAtUtc,
    })
    assert.deepEqual(loaded.invalidAttestationBlocks, [])
    assert.deepEqual(
      loaded.attestationRows.map((row) => row.filename),
      [input.checkpoints[0].filename, selected.filename],
    )
    writeFileSync(join(temp, selected.filename), '{broken json}\n')
    const invalidSelected = readScoreAttestations({
      issue: input.issueRow.issue,
      checkpoints: input.checkpoints,
      out: temp,
      nowUtc: input.scoredAtUtc,
    })
    assert.deepEqual(invalidSelected.invalidAttestationBlocks, [selected.checkpoint.block.number])
    assert.deepEqual(invalidSelected.invalidAttestationFiles, [
      {
        blockNumber: selected.checkpoint.block.number,
        filename: selected.filename,
        physicalSha256: sha('{broken json}\n'),
      },
    ])
    const score = buildScore({ ...input, ...invalidSelected })
    assert.equal(score.pointOutcome.status, 'success')
    assert.equal(score.sampledCodeIdentity.reason, 'invalid_sample_attestation')
    assert.equal(
      replayScore({ saved: score, ...input, ...invalidSelected }).wouldChangeResult,
      false,
    )

    unlinkSync(join(temp, selected.filename))
    const removed = readScoreAttestations({
      issue: input.issueRow.issue,
      checkpoints: input.checkpoints,
      out: temp,
      nowUtc: input.scoredAtUtc,
    })
    assert.throws(
      () => replayScore({ saved: score, ...input, ...removed }),
      /Sealed invalid attestation evidence is unavailable or changed/,
    )

    writeFileSync(join(temp, selected.filename), '{different broken json}\n')
    const replaced = readScoreAttestations({
      issue: input.issueRow.issue,
      checkpoints: input.checkpoints,
      out: temp,
      nowUtc: input.scoredAtUtc,
    })
    assert.throws(
      () => replayScore({ saved: score, ...input, ...replaced }),
      /Sealed invalid attestation evidence is unavailable or changed/,
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
