import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  UMBRELLA_SUBJECT,
  buildUmbrellaEpisodes,
  umbrellaBoardSubjects,
} from './holder-exit-umbrella-episodes.mjs'

const UMBRELLA_GHO_ROUTE = UMBRELLA_SUBJECT.route_key
const UMBRELLA_STKGHO = UMBRELLA_SUBJECT.destination
const ORIGINAL_GHO = UMBRELLA_SUBJECT.asset
const VERIFIED_STKGHO_IMPLEMENTATION = '0x75e8ac0c063b6966e2a9954adedf39bde9370197'
const SHARES_RAW = '1000000000000000000'
const STUDY = 'carry_local_umbrella_gho_holder_v1'
const transition = (parent, measurement) => {
  if (measurement.outcome === 'regime_changed') return 'regime_change_censored'
  if (!measurement.holderEoa || BigInt(measurement.holderSharesRaw) < BigInt(SHARES_RAW))
    return 'holder_attrition'
  if (measurement.outcome === 'success')
    return parent.measurement.outcome === 'success' ? 'still_callable' : 'simulated_call_recovery'
  if (measurement.outcome === 'evm_revert')
    return parent.measurement.outcome === 'success' ? 'became_reverting' : 'still_reverting'
  return 'unassessed'
}
const hash = (value) => createHash('sha256').update(value).digest('hex')
const seal = (row) => {
  const { sha256: _old, ...payload } = row
  return { ...payload, sha256: hash(JSON.stringify(payload)) }
}
const BASELINE_MS = Date.parse('2026-10-04T00:00:00.000Z')
const ISSUE_AT = '2026-10-04T00:10:00.000Z'
const NOW = Date.parse('2026-10-04T01:30:00.000Z')
const subject = UMBRELLA_SUBJECT
const subjectKey = `${subject.route_key}\0${subject.destination}\0${subject.asset}`
const manifest = { subjects: [subject] }
const block = {
  number: 100,
  hash: `0x${'a'.repeat(64)}`,
  parentHash: `0x${'b'.repeat(64)}`,
  timestamp: BASELINE_MS / 1_000,
}
const rawCode = {
  holderCodeStatus: 'no_code',
  holderCodeHex: '0x',
  holderCodeHash: null,
}

function issue(sequence = 1, outcome = 'evm_revert', raw = false) {
  const horizons = sequence === 1 ? [1, 24, 48, 168] : [1, 24, 48, 168, 348, 360, 384, 432]
  return seal({
    sequence,
    study: STUDY,
    kind: 'issue',
    routeKey: UMBRELLA_GHO_ROUTE,
    destination: UMBRELLA_STKGHO,
    holder: `0x${String(sequence).padStart(40, '0')}`,
    sharesRaw: SHARES_RAW,
    issuedAtUtc: ISSUE_AT,
    baseline: block,
    measurement: {
      outcome,
      implementation: VERIFIED_STKGHO_IMPLEMENTATION,
      codeHash: `0x${'c'.repeat(64)}`,
      asset: ORIGINAL_GHO,
      holderEoa: true,
      holderSharesRaw: SHARES_RAW,
      gate: outcome === 'success' ? 'window_open' : 'waiting',
      windowOpen: outcome === 'success',
      ghoRaw: outcome === 'success' ? '999999999999999999' : null,
      ...(raw ? rawCode : {}),
    },
    targets: horizons.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(BASELINE_MS + horizonHours * 3_600_000).toISOString(),
      deadlineUtc: new Date(BASELINE_MS + (horizonHours + 2) * 3_600_000).toISOString(),
    })),
  })
}

function score(parent, outcome = 'evm_revert', options = {}) {
  const horizonHours = options.horizonHours ?? 1
  const target = parent.targets.find((row) => row.horizonHours === horizonHours)
  const targetMs = Date.parse(target.targetAtUtc)
  const targetBlock = {
    number: 110,
    hash: `0x${'d'.repeat(64)}`,
    parentHash: `0x${'e'.repeat(64)}`,
    timestamp: targetMs / 1_000 + 12,
  }
  const parentBlock = {
    number: 109,
    hash: targetBlock.parentHash,
    parentHash: `0x${'f'.repeat(64)}`,
    timestamp: targetMs / 1_000 - 1,
  }
  const measurement =
    outcome === 'regime_changed'
      ? { outcome, implementation: `0x${'9'.repeat(40)}`, codeHash: `0x${'9'.repeat(64)}` }
      : {
          outcome,
          implementation: VERIFIED_STKGHO_IMPLEMENTATION,
          codeHash: parent.measurement.codeHash,
          asset: ORIGINAL_GHO,
          holderEoa: options.holderEoa ?? true,
          holderSharesRaw: options.holderSharesRaw ?? SHARES_RAW,
          gate: options.gate ?? (outcome === 'success' ? 'window_open' : 'waiting'),
          windowOpen: outcome === 'success',
          ghoRaw: outcome === 'success' ? '999999999999999999' : null,
          ...(options.raw
            ? options.holderEoa === false
              ? {
                  holderCodeStatus: 'contract_code',
                  holderCodeHex: null,
                  holderCodeHash: `0x${'8'.repeat(64)}`,
                }
              : rawCode
            : {}),
        }
  return seal({
    sequence: options.sequence ?? 1,
    study: STUDY,
    kind: 'score',
    issueSequence: parent.sequence,
    issueSha256: parent.sha256,
    horizonHours,
    scoredAtUtc: new Date(targetMs + 5 * 60_000).toISOString(),
    status: 'measured',
    targetBlock,
    parentBlock,
    measurement,
    transition: transition(parent, measurement),
  })
}

function missed(parent, horizonHours = 1) {
  const target = parent.targets.find((row) => row.horizonHours === horizonHours)
  return seal({
    sequence: 1,
    study: STUDY,
    kind: 'score',
    issueSequence: parent.sequence,
    issueSha256: parent.sha256,
    horizonHours,
    scoredAtUtc: new Date(Date.parse(target.deadlineUtc) + 1_000).toISOString(),
    status: 'missed_deadline',
    deadlineFinalizedBlock: {
      ...block,
      number: block.number + 1,
      hash: `0x${'c'.repeat(64)}`,
      parentHash: block.hash,
      timestamp: Math.floor((Date.parse(target.deadlineUtc) + 1_000) / 1_000),
    },
    targetBlock: null,
    parentBlock: null,
    measurement: null,
    transition: 'missing',
  })
}

function run(issues = [], scores = [], options = {}) {
  return buildUmbrellaEpisodes({
    manifest: options.manifest ?? manifest,
    ledger: { issues, scores, attempts: options.attempts ?? [] },
    featuresBySubject: options.featuresBySubject ?? new Map(),
    selectAsOfFeatures:
      options.selectAsOfFeatures ?? (() => ({ featureRefs: [], featureAbstentions: {} })),
    nowMs: options.nowMs ?? NOW,
  })
}

test('one frozen 25/67 subject; original four and later eight baseline-clock horizons', () => {
  assert.equal(umbrellaBoardSubjects(manifest).size, 1)
  const old = issue(1)
  const newer = issue(4, 'success', true)
  const result = run(
    [old, newer],
    [score(old), score(newer, 'success', { sequence: 6, raw: true })],
  )
  assert.equal(result.board.get(subjectKey), subject)
  assert.equal(result.episodes.length, 12)
  assert.deepEqual(
    result.episodes.slice(0, 4).map((row) => row.plannedHorizonHours),
    [1, 24, 48, 168],
  )
  assert.deepEqual(
    result.episodes.slice(4).map((row) => row.plannedHorizonHours),
    [1, 24, 48, 168, 348, 360, 384, 432],
  )
  const row = result.episodes[4]
  assert.equal(row.qRaw, SHARES_RAW)
  assert.equal(row.qUnit, 'stkGHO_shares')
  assert.equal(row.stageScope, 'direct_umbrella_redeem_eth_call')
  assert.equal(row.targetClockBasis, 'baseline_block_timestamp_plan')
  assert.equal(row.leadAtIssueMinutes, 50)
  assert.equal(row.issueClusterSha256, newer.sha256)
  assert.equal(row.holderCommitment, hash(`${UMBRELLA_STKGHO}:${newer.holder}`))
  assert.equal(row.fullRoutePaidProofSha256, null)
  assert.equal(row.forecastEligible, false)
  assert.equal(row.analysisPrimaryForCell, false)
})

test('issue and score local clocks gate feature join, rows, proof counts and raw score fields', () => {
  const parent = issue(4, 'success', true)
  const scored = score(parent, 'success', { sequence: 6, raw: true })
  const selected = []
  const at = (nowMs, scoreRows = [scored]) =>
    run([parent], scoreRows, {
      nowMs,
      selectAsOfFeatures: (_features, _subject, joinedIssue) => {
        selected.push(joinedIssue.sequence)
        return { featureRefs: [], featureAbstentions: {} }
      },
    })
  const beforeIssue = at(Date.parse(ISSUE_AT) - 1)
  assert.equal(beforeIssue.episodes.length, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).issues, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).rawAttestedIssueHolderCodeProofs, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.deepEqual(selected, [])

  const atIssue = at(Date.parse(ISSUE_AT))
  assert.equal(atIssue.episodes.length, 8)
  assert.equal(atIssue.diagnostics.get(subjectKey).issues, 1)
  assert.equal(atIssue.diagnostics.get(subjectKey).scoredTargets, 0)
  assert.equal(atIssue.episodes[0].outcome.status, 'pending')
  const beforeScore = at(Date.parse(scored.scoredAtUtc) - 1)
  assert.equal(beforeScore.episodes[0].scoreSha256, null)
  assert.equal(beforeScore.episodes[0].observedAtUtc, null)
  assert.equal(beforeScore.episodes[0].scoreHolderCodeEvidence, 'not_observed')
  assert.equal(beforeScore.episodes[0].rawHolderCodeAttestedCell, false)
  assert.equal(beforeScore.episodes[0].rawScoreStatus, null)
  assert.equal(beforeScore.episodes[0].rawScoreOutcome, null)
  assert.equal(beforeScore.episodes[0].rawTransition, null)
  assert.equal(beforeScore.diagnostics.get(subjectKey).measuredTargets, 0)
  assert.equal(beforeScore.diagnostics.get(subjectKey).rawAttestedCells, 0)
  const atScore = at(Date.parse(scored.scoredAtUtc))
  assert.equal(atScore.episodes[0].outcome.status, 'simulated_callable')
  assert.equal(atScore.episodes[0].scoreSha256, scored.sha256)
  assert.equal(atScore.episodes[0].rawScoreOutcome, 'success')
  assert.equal(atScore.diagnostics.get(subjectKey).measuredTargets, 1)
  assert.equal(atScore.diagnostics.get(subjectKey).rawAttestedCells, 1)
  assert.equal(atScore.episodes[0].issueClock, 'local_operator_clock_unwitnessed')
  assert.equal(atScore.episodes[0].forecastEligible, false)
  assert.throws(
    () => at(Date.parse(ISSUE_AT) - 1, [seal({ ...scored, scoredAtUtc: 'invalid' })]),
    /clock_invalid/,
  )
})

test('Umbrella attempt and missed-score diagnostics appear when their local clocks finish', () => {
  const parent = issue(4, 'success', true)
  const missedScore = missed(parent)
  const futureWitness = structuredClone(missedScore)
  futureWitness.deadlineFinalizedBlock.timestamp =
    Math.floor(Date.parse(missedScore.scoredAtUtc) / 1_000) + 1
  assert.throws(
    () =>
      run([parent], [seal(futureWitness)], {
        nowMs: Date.parse(ISSUE_AT) - 1,
      }),
    /score_missed_invalid/,
  )
  const attempt = seal({
    sequence: 1,
    previousSha256: null,
    study: STUDY,
    kind: 'attempt',
    mode: 'score',
    startedAtUtc: new Date(Date.parse(ISSUE_AT) - 60_000).toISOString(),
    finishedAtUtc: new Date(Date.parse(ISSUE_AT) + 60_000).toISOString(),
    slot: Math.floor((Date.parse(ISSUE_AT) - 60_000) / (30 * 60_000)),
    status: 'nothing_due',
    recordSequence: null,
    recordSha256: null,
    failure: null,
  })
  const beforeAttempt = run([parent], [], {
    nowMs: Date.parse(ISSUE_AT),
    attempts: [attempt],
  })
  assert.equal(beforeAttempt.diagnostics.get(subjectKey).attempts, 0)
  const afterAttempt = run([parent], [], {
    nowMs: Date.parse(attempt.finishedAtUtc),
    attempts: [attempt],
  })
  assert.equal(afterAttempt.diagnostics.get(subjectKey).attempts, 1)
  assert.throws(
    () => run([parent], [], { attempts: [{ ...attempt, status: 'failed' }] }),
    /attempt_chain_invalid/,
  )
  assert.throws(
    () => run([parent], [], { attempts: [seal({ ...attempt, status: 'fabricated' })] }),
    /attempt_invalid/,
  )
  assert.throws(
    () => run([parent], [], { attempts: [seal({ ...attempt, slot: attempt.slot + 1 })] }),
    /attempt_invalid/,
  )
  assert.throws(
    () => run([parent], [], { attempts: [seal({ ...attempt, sequence: 2 })] }),
    /attempt_chain_invalid/,
  )
  assert.throws(
    () => run([parent], [], { attempts: [seal({ ...attempt, previousSha256: 'f'.repeat(64) })] }),
    /attempt_chain_invalid/,
  )
  assert.throws(
    () =>
      run([parent], [], {
        attempts: [
          seal({ ...attempt, status: 'issued', recordSequence: 1, recordSha256: 'f'.repeat(64) }),
        ],
      }),
    /attempt_link_invalid/,
  )
  const beforeScore = run([parent], [missedScore], {
    nowMs: Date.parse(missedScore.scoredAtUtc) - 1,
  })
  assert.equal(beforeScore.episodes[0].outcome.status, 'missing')
  assert.equal(beforeScore.diagnostics.get(subjectKey).missedDeadlineTargets, 0)
  const atScore = run([parent], [missedScore], {
    nowMs: Date.parse(missedScore.scoredAtUtc),
  })
  assert.equal(atScore.episodes[0].outcome.status, 'censored')
  assert.equal(atScore.diagnostics.get(subjectKey).missedDeadlineTargets, 1)
})

test('frozen V1 constants and transition labels match the source reader', () => {
  const readerUrl = new URL('./carry-local-umbrella-gho-holder.mjs', import.meta.url).href
  const contractUrl = new URL('../../lib/carry/umbrellaGhoExit.ts', import.meta.url).href
  const script = `
    const reader = await import(${JSON.stringify(readerUrl)});
    const contractModule = await import(${JSON.stringify(contractUrl)});
    const contract = contractModule.default ?? contractModule;
    const q = reader.SHARES_RAW;
    const ok = {holderEoa:true, holderSharesRaw:q};
    const a = {measurement:{outcome:'success'}};
    const b = {measurement:{outcome:'evm_revert'}};
    const classify = (issue, outcome, extra={}) => reader.classifyTransition(issue,{...ok,outcome,...extra});
    console.log(JSON.stringify({
      subject:{route_key:contract.UMBRELLA_GHO_ROUTE,destination:contract.UMBRELLA_STKGHO,asset:contract.ORIGINAL_GHO},
      implementation:contract.VERIFIED_STKGHO_IMPLEMENTATION,
      study:reader.STUDY,
      sharesRaw:q,
      horizons:reader.HORIZONS_HOURS,
      transitions:[
        classify(a,'success'),classify(a,'evm_revert'),classify(b,'success'),
        classify(b,'evm_revert'),classify(a,'not_attempted',{holderSharesRaw:'0'}),
        classify(a,'regime_changed'),classify(a,'not_attempted')
      ]
    }));
  `
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 32 * 1024,
    },
  )
  assert.equal(child.status, 0, child.stderr)
  const source = JSON.parse(child.stdout)
  assert.deepEqual(source.subject, subject)
  assert.equal(source.implementation, VERIFIED_STKGHO_IMPLEMENTATION)
  assert.equal(source.study, STUDY)
  assert.equal(source.sharesRaw, SHARES_RAW)
  assert.deepEqual(
    source.horizons,
    issue(4).targets.map((row) => row.horizonHours),
  )
  assert.deepEqual(source.transitions, [
    'still_callable',
    'became_reverting',
    'simulated_call_recovery',
    'still_reverting',
    'holder_attrition',
    'regime_change_censored',
    'unassessed',
  ])
})

test('legacy issue and score proof remains visible but outside the raw-attested subset', () => {
  const old = issue(1)
  const newer = issue(4, 'success', true)
  const result = run(
    [old, newer],
    [score(old), score(newer, 'success', { sequence: 6, raw: true })],
  )
  const legacy = result.episodes[0]
  const attested = result.episodes[4]
  assert.equal(legacy.issueHolderCodeEvidence, 'legacy_unattested')
  assert.equal(legacy.scoreHolderCodeEvidence, 'legacy_unattested')
  assert.equal(legacy.rawHolderCodeAttestedCell, false)
  assert.equal(attested.issueHolderCodeEvidence, 'no_code')
  assert.equal(attested.scoreHolderCodeEvidence, 'no_code')
  assert.equal(attested.rawHolderCodeAttestedCell, true)
  assert.deepEqual(result.diagnostics.get(subjectKey), {
    issues: 2,
    scoredTargets: 2,
    measuredTargets: 2,
    missedDeadlineTargets: 0,
    attempts: 0,
    legacyIssueHolderCodeProofs: 1,
    legacyScoreHolderCodeProofs: 1,
    rawAttestedIssueHolderCodeProofs: 1,
    rawAttestedMeasuredScoreHolderCodeProofs: 1,
    rawAttestedCells: 1,
  })
  const forged = issue(4)
  assert.throws(() => run([forged]), /holder_code_proof_missing/)
  const forgedScore = score(issue(4, 'success', true), 'success', { sequence: 6 })
  assert.throws(() => run([issue(4, 'success', true)], [forgedScore]), /holder_code_proof_missing/)
})

test('covered reverts remain inconclusive and cannot become a recovery cohort', () => {
  const parent = issue(4, 'evm_revert', true)
  const reverted = run([parent], [score(parent, 'evm_revert', { sequence: 6, raw: true })])
    .episodes[0]
  assert.equal(reverted.baseline, 'inconclusive')
  assert.equal(reverted.baselineReason, 'revert_cause_unknown')
  assert.deepEqual(reverted.outcome, {
    status: 'not_at_risk',
    reason: 'baseline_revert_cause_unknown',
  })
  assert.equal(reverted.rawBaselineGate, 'waiting')
  assert.equal(reverted.rawScoreGate, 'waiting')
  assert.equal(reverted.rawTransition, 'still_reverting')
  const recoveredRaw = run([parent], [score(parent, 'success', { sequence: 6, raw: true })])
    .episodes[0]
  assert.equal(recoveredRaw.outcome.status, 'not_at_risk')
  assert.equal(recoveredRaw.rawTransition, 'simulated_call_recovery')
  const callableParent = issue(4, 'success', true)
  const callable = run(
    [callableParent],
    [score(callableParent, 'success', { sequence: 6, raw: true })],
  ).episodes[0]
  assert.equal(callable.outcome.status, 'simulated_callable')
  assert.equal(callable.rawTransition, 'still_callable')
  assert.equal(callable.rawScoreGhoRaw, '999999999999999999')
  assert.equal(callable.fullRoutePaidProofSha256, null)
  assert.equal(callable.forecastEligible, false)
  const becameReverting = run(
    [callableParent],
    [score(callableParent, 'evm_revert', { sequence: 6, raw: true })],
  ).episodes[0]
  assert.deepEqual(becameReverting.outcome, {
    status: 'inconclusive',
    reason: 'revert_cause_unknown',
  })
  assert.equal(becameReverting.rawTransition, 'became_reverting')
})

test('attrition, origin ineligibility, regime change, missed deadline, pending and missing differ', () => {
  const parent = issue(4, 'success', true)
  const attrition = run(
    [parent],
    [score(parent, 'not_attempted', { sequence: 6, raw: true, holderSharesRaw: '0' })],
  ).episodes[0]
  assert.deepEqual(attrition.outcome, { status: 'censored', reason: 'holder_attrition' })
  assert.equal(attrition.rawTransition, 'holder_attrition')
  const origin = run(
    [parent],
    [
      score(parent, 'not_attempted', {
        sequence: 6,
        holderEoa: false,
        raw: true,
      }),
    ],
  ).episodes[0]
  // A contract holder's raw proof status must agree with holderEoa.
  assert.equal(origin.outcome.reason, 'holder_origin_ineligible')
  const unassessed = run([parent], [score(parent, 'not_attempted', { sequence: 6, raw: true })])
    .episodes[0]
  assert.deepEqual(unassessed.outcome, {
    status: 'inconclusive',
    reason: 'simulation_not_attempted',
  })
  assert.equal(unassessed.rawTransition, 'unassessed')
  const changed = run([parent], [score(parent, 'regime_changed', { sequence: 6 })]).episodes[0]
  assert.deepEqual(changed.outcome, { status: 'censored', reason: 'regime_changed' })
  assert.equal(changed.scoreHolderCodeEvidence, 'not_observed')
  const missedScore = missed(parent)
  assert.deepEqual(
    run([parent], [missedScore], { nowMs: Date.parse(missedScore.scoredAtUtc) }).episodes[0]
      .outcome,
    {
      status: 'censored',
      reason: 'capture_window_missed',
    },
  )
  assert.equal(run([parent]).episodes[0].outcome.status, 'pending')
  assert.deepEqual(
    run([parent], [], { nowMs: Date.parse(parent.targets[0].deadlineUtc) + 1 }).episodes[0].outcome,
    { status: 'missing', reason: 'no_verified_score_after_deadline' },
  )
})

test('features join against baseline block and issue time; score and route forgeries fail', () => {
  const parent = issue(1)
  const seen = []
  const features = [{ kind: 'aggregate_cash', receiptSha256: hash('cash') }]
  const result = run([parent], [score(parent)], {
    featuresBySubject: new Map([[subjectKey, features]]),
    selectAsOfFeatures: (rows, joinedSubject, joinedIssue, baseline) => {
      seen.push({ rows, joinedSubject, joinedIssue, baseline })
      return { featureRefs: rows, featureAbstentions: { late_completion: 1 } }
    },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].joinedSubject, subject)
  assert.equal(seen[0].joinedIssue, parent)
  assert.deepEqual(seen[0].baseline.baseline, {
    targetBlock: '100',
    targetHash: block.hash,
    targetBlockAt: '2026-10-04T00:00:00.000Z',
  })
  assert.equal(result.episodes[0].featureRefs, features)
  assert.equal(result.episodes[0].featureAbstentions.late_completion, 1)
  const badSha = score(parent)
  badSha.issueSha256 = hash('other')
  assert.throws(() => run([parent], [seal(badSha)]), /orphan_score/)
  const badClock = issue(1)
  badClock.targets[0].targetAtUtc = new Date(BASELINE_MS + 61 * 60_000).toISOString()
  assert.throws(() => run([seal(badClock)]), /target_invalid/)
  const badAmount = issue(1)
  badAmount.sharesRaw = '2'
  assert.throws(() => run([seal(badAmount)]), /issue_identity_invalid/)
  const tampered = issue(1)
  tampered.measurement.gate = 'window_open'
  assert.throws(() => run([tampered]), /issue_duplicate_or_unsealed/)
  const badSubject = { subjects: [{ ...subject, asset: `0x${'9'.repeat(40)}` }] }
  assert.throws(() => run([], [], { manifest: badSubject }), /frozen_subject_invalid/)
})
