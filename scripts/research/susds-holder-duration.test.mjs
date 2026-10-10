import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asOfRiskSet,
  buildIssue,
  riskSetBoundsAtHorizon,
  scoreIssue,
  STUDY,
} from './susds-holder-duration.mjs'

const BASE = 1_790_000_000
const holder = `0x${'1'.repeat(40)}`
const plan = {
  status: 'selected',
  holder,
  rawUsds: '1000',
  sha256: 'a'.repeat(64),
  checkpoint: { block: { number: 99 } },
}
const planPhysicalSha256 = 'b'.repeat(64)
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`

function data(states, { shares = [], gap = 600, capture = [] } = {}) {
  const checkpoints = []
  const exitRows = []
  states.forEach((state, index) => {
    const number = 100 + index
    const block = { number, hash: hash(number), timestamp: BASE + index * gap }
    const filename = `${String(number).padStart(12, '0')}-${block.hash.slice(2)}.json`
    checkpoints.push({
      filename,
      physicalSha256: `c${String(index).padStart(63, '0')}`,
      checkpoint: {
        block,
        sha256: `d${String(index).padStart(63, '0')}`,
        captureEndUtc: capture[index]?.checkpoint ?? iso(block.timestamp + 2),
      },
    })
    if (state === 'missing') return
    const issue = {
      checkpoint: { block },
      captureEndUtc: capture[index]?.exit ?? iso(block.timestamp + 4),
      plan: { logicalSha256: plan.sha256, physicalSha256: planPhysicalSha256 },
      holder,
      rawUsds: plan.rawUsds,
      codeRelation: state === 'changed' ? 'changed_since_plan_anchor' : 'same_as_plan_anchor',
      sha256: `e${String(index).padStart(63, '0')}`,
      result: {
        status: state === 'changed' ? 'success' : state,
        balanceSharesRaw: shares[index] ?? '2000',
        previewSharesRaw: '100',
      },
    }
    exitRows.push({ filename, physicalSha256: `f${String(index).padStart(63, '0')}`, issue })
  })
  return { checkpoints, exitRows }
}

function issue(observed, index = 0) {
  const exit = observed.exitRows.find((row) => row.issue.checkpoint.block.number === 100 + index)
  return buildIssue({
    plan,
    planPhysicalSha256,
    ...observed,
    atBlock: 100 + index,
    issuedAtUtc: iso(Date.parse(exit.issue.captureEndUtc) / 1000 + 1),
  })
}

function score(saved, observed, index) {
  return scoreIssue({
    issue: saved,
    plan,
    ...observed,
    throughBlock: 100 + index,
    scoredAtUtc: iso(BASE + index * 600 + 5),
  })
}

test('two prospective successes preserve one ongoing episode and do not imply a forecast', () => {
  const observed = data(['success', 'success'])
  const first = issue(observed)
  const second = issue(observed, 1)
  assert.equal(first.study, STUDY)
  assert.equal(first.baseline.episodes[0].observedLowerSeconds, 0)
  assert.equal(second.baseline.episodes[0].observedLowerSeconds, 600)
  assert.equal(second.baseline.counts.ongoingRightCensors, 1)
  assert.equal(second.baseline.counts.firstLossIntervals, 0)
  assert.equal(second.priorSource.exitIssues.length, 1)
  assert.equal(score(first, observed, 1).observed.observedSeconds, 600)
  assert.equal(riskSetBoundsAtHorizon(second.baseline, 1200).horizonOrigin, 'episode_start')
  assert.equal(riskSetBoundsAtHorizon(second.baseline, 1200).ambiguous, 1)
})

test('later clean revert forms first-loss interval; recovery starts a new episode', () => {
  const observed = data(['success', 'success', 'revert', 'success'])
  const saved = issue(observed)
  const loss = score(saved, observed, 2)
  assert.equal(loss.observed.firstLoss.lowerSeconds, 600)
  assert.equal(loss.observed.firstLoss.upperSeconds, 1200)
  assert.equal(score(saved, observed, 3).observed.recovery.block, 103)
  const risk = asOfRiskSet({ plan, ...observed, throughBlock: 103, issuedAtUtc: iso(BASE + 1805) })
  assert.deepEqual(risk.counts, {
    firstLossIntervals: 1,
    ongoingRightCensors: 1,
    ambiguousCensors: 0,
  })
  assert.equal(risk.episodes[1].startBlock, 103)
  assert.equal(riskSetBoundsAtHorizon(risk, 1200).definitelyFailed, 1)
})

test('provider ambiguity, code change, missing sample, and share loss censor before later revert', () => {
  for (const [state, reason] of [
    ['provider_ambiguous', 'provider_ambiguity'],
    ['changed', 'implementation_changed'],
    ['missing', 'missing_exit_observation'],
  ]) {
    const observed = data(['success', state, 'revert'])
    const risk = asOfRiskSet({
      plan,
      ...observed,
      throughBlock: 102,
      issuedAtUtc: iso(BASE + 4202),
    })
    assert.equal(risk.episodes[0].outcome, 'censored')
    assert.equal(risk.episodes[0].censorReason, reason)
    assert.equal(risk.counts.firstLossIntervals, 0)
  }
  const attrition = data(['success', 'success', 'revert'], { shares: ['2000', '1999'] })
  assert.equal(issue(attrition, 1).baseline.episodes[0].censorReason, 'share_attrition')
})

test('pending missing sample cannot become a settled score', () => {
  const observed = data(['success', 'missing'])
  assert.throws(() => score(issue(observed), observed, 1), /not yet closed/)
})

test('source first captured after issue time is excluded, even at earlier block', () => {
  const observed = data(['success', 'revert', 'success'])
  const issuedAtUtc = iso(BASE + 1205)
  observed.checkpoints[0].checkpoint.captureEndUtc = iso(BASE + 1300)
  observed.checkpoints[1].checkpoint.captureEndUtc = iso(BASE + 1300)
  observed.exitRows[0].issue.captureEndUtc = iso(BASE + 1301)
  observed.exitRows[1].issue.captureEndUtc = iso(BASE + 1301)
  const saved = buildIssue({ plan, planPhysicalSha256, ...observed, atBlock: 102, issuedAtUtc })
  assert.equal(saved.priorSource.checkpoints.length, 0)
  assert.equal(saved.priorSource.exitIssues.length, 0)
  assert.equal(saved.baseline.episodeCount, 1)
  assert.deepEqual(
    saved,
    buildIssue({
      plan,
      planPhysicalSha256,
      checkpoints: observed.checkpoints.slice(2),
      exitRows: observed.exitRows.slice(2),
      atBlock: 102,
      issuedAtUtc,
    }),
  )
})

test('late issue, later captured checkpoint and unbound plan source fail closed', () => {
  const observed = data(['success', 'success'])
  assert.throws(
    () =>
      buildIssue({
        plan,
        planPhysicalSha256,
        ...observed,
        atBlock: 100,
        issuedAtUtc: iso(BASE + 3605),
      }),
    /late|later checkpoint/,
  )
  const corrupt = structuredClone(observed)
  corrupt.exitRows[0].issue.plan.physicalSha256 = '0'.repeat(64)
  assert.throws(() => issue(corrupt), /Ineligible/)
})
