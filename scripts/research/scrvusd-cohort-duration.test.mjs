import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asOfRiskSet,
  buildIssue,
  issueLatest,
  riskSetBoundsAtHorizon,
  scoreIssue,
  STUDY,
} from './scrvusd-cohort-duration.mjs'

const BASE = 1_790_600_000
const holderA = `0x${'a'.repeat(40)}`
const holderB = `0x${'b'.repeat(40)}`
const plan = {
  sha256: 'a'.repeat(64),
  physicalSha256: 'b'.repeat(64),
  createdUtc: new Date((BASE - 1200) * 1000).toISOString(),
  checkpoint: { block: { number: 99 } },
  strata: [
    { rawCrvUsd: '1000', holders: [holderA, holderB] },
    { rawCrvUsd: '10000', holders: [holderA] },
  ],
}
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
function member(holder, rawCrvUsd, status = 'success', options = {}) {
  return {
    holder,
    rawCrvUsd,
    status,
    holderCode: options.holderCode ?? '0x',
    balanceSharesRaw: options.balance ?? '20000',
    maxWithdrawAssetsRaw: options.max ?? '30000',
    previewSharesRaw: options.preview ?? '100',
    sharesBurnedRaw: status === 'success' ? '100' : null,
  }
}
const pairMembers = (statuses, options = {}) => [
  member(holderA, '1000', statuses[0], options[0]),
  member(holderB, '1000', statuses[1], options[1]),
  member(holderA, '10000', statuses[2], options[2]),
]
function fixture(states, gap = 600) {
  const checkpoints = []
  const observations = []
  states.forEach((state, index) => {
    const number = 100 + index
    const block = { number, hash: hash(number), timestamp: BASE + index * gap }
    const filename = `${String(number).padStart(12, '0')}-${block.hash.slice(2)}.json`
    const quote = {
      filename,
      physicalSha256: `c${String(index).padStart(63, '0')}`,
      checkpoint: {
        block,
        sha256: `d${String(index).padStart(63, '0')}`,
        captureEndUtc: iso(block.timestamp + 2),
      },
    }
    checkpoints.push(quote)
    if (state === null) return
    observations.push({
      filename,
      physicalSha256: `e${String(index).padStart(63, '0')}`,
      issue: {
        sha256: `f${String(index).padStart(63, '0')}`,
        planSha256: plan.sha256,
        planPhysicalSha256: plan.physicalSha256,
        checkpoint: { block },
        captureStartUtc: iso(block.timestamp + 3),
        captureEndUtc: iso(block.timestamp + 4),
        results: state,
      },
    })
  })
  return { plan, checkpoints, observations }
}
function issue(sources, index = 0, offset = 5) {
  return buildIssue({
    ...sources,
    atBlock: 100 + index,
    issuedAtUtc: iso(BASE + index * 600 + offset),
  })
}
function score(sources, issued, index, offset = 5) {
  return scoreIssue({
    issue: issued,
    ...sources,
    throughBlock: 100 + index,
    scoredAtUtc: iso(BASE + index * 600 + offset),
  })
}

test('issue keeps complete dependent roster and no forecast with zero first losses', () => {
  const sources = fixture([pairMembers(['success', 'success', 'success'])])
  const got = issue(sources)
  assert.equal(got.study, STUDY)
  assert.equal(got.riskSet.pairCount, 3)
  assert.equal(got.riskSet.distinctHolderCount, 2)
  assert.equal(got.riskSet.vaultCount, 1)
  assert.equal(got.riskSet.counts.ongoingRightCensors, 3)
  assert.equal(got.riskSet.counts.firstLossIntervals, 0)
  assert.equal(got.riskSet.forecast.status, 'unavailable')
  assert.equal(got.priorSource.quotes.length, 0)
  assert.equal(got.riskSet.members[2].holder, holderA)
})

test('later clean revert gives interval first loss only to that pair', () => {
  const sources = fixture([
    pairMembers(['success', 'success', 'success']),
    pairMembers(['success', 'revert', 'success']),
  ])
  const first = issue(sources)
  const second = issue(sources, 1)
  assert.equal(first.riskSet.counts.firstLossIntervals, 0)
  assert.equal(second.riskSet.counts.firstLossIntervals, 1)
  assert.equal(second.riskSet.members[1].episodes[0].lowerSeconds, 0)
  assert.equal(second.riskSet.members[1].episodes[0].upperSeconds, 600)
  assert.equal(second.priorSource.cohortObservations.length, 1)
  const scored = score(sources, first, 1)
  assert.equal(scored.members.length, 3)
  assert.equal(scored.members[1].observed.status, 'first_loss_observed')
  assert.equal(scored.members[0].observed.status, 'right_censored')
  assert.equal(scored.members[2].observed.status, 'right_censored')
})

test('provider, source, code, share attrition and missing observations censor', () => {
  const bad = [
    member(holderA, '1000', 'provider_error'),
    member(holderB, '1000', 'source_drift'),
    member(holderA, '10000', 'holder_code_change', { holderCode: '0x6000' }),
  ]
  const sources = fixture([pairMembers(['success', 'success', 'success']), bad])
  const scored = score(sources, issue(sources), 1)
  assert.deepEqual(
    scored.members.map((row) => row.observed.censor.reason),
    ['provider_ambiguity', 'vault_source_drift', 'holder_code_change'],
  )
  const attrition = fixture([
    pairMembers(['success', 'success', 'success']),
    pairMembers(['revert', 'success', 'success'], { 0: { balance: '19999' } }),
  ])
  assert.equal(
    score(attrition, issue(attrition), 1).members[0].observed.censor.reason,
    'share_attrition_or_insufficient_shares',
  )
  const absent = fixture([pairMembers(['success', 'success', 'success']), null])
  assert.throws(() => score(absent, issue(absent), 1), /not yet closed/)
  const closed = score(absent, issue(absent), 1, 4201)
  assert.equal(closed.members[0].observed.censor.reason, 'missing_cohort_observation')
})

test('issue and score clocks exclude rows captured after their respective time', () => {
  const sources = fixture([
    pairMembers(['success', 'success', 'success']),
    pairMembers(['revert', 'success', 'success']),
  ])
  const early = issue(sources)
  assert.equal(early.riskSet.counts.firstLossIntervals, 0)
  assert.throws(
    () => buildIssue({ ...sources, atBlock: 101, issuedAtUtc: iso(BASE + 601) }),
    /Ineligible|unavailable/,
  )
  assert.throws(
    () => scoreIssue({ issue: early, ...sources, throughBlock: 101, scoredAtUtc: iso(BASE + 601) }),
    /Score boundary/,
  )
  assert.throws(
    () => buildIssue({ ...sources, atBlock: 100, issuedAtUtc: iso(BASE + 605) }),
    /Ineligible/,
  )
})

test('flexible horizon bounds classify sampled episodes without a probability claim', () => {
  const sources = fixture([
    pairMembers(['success', 'success', 'success']),
    pairMembers(['success', 'revert', 'success']),
  ])
  const riskSet = asOfRiskSet({ ...sources, throughBlock: 101, issuedAtUtc: iso(BASE + 605) })
  const now = riskSetBoundsAtHorizon(riskSet, 0)
  const later = riskSetBoundsAtHorizon(riskSet, 1800)
  assert.equal(now.definitelyAlive, 3)
  assert.equal(later.definitelyFailed, 1)
  assert.equal(later.ambiguous, 2)
  assert.equal(later.horizonOrigin, 'episode_start')
  assert.match(later.caveat, /no probability/)
  assert.throws(() => riskSetBoundsAtHorizon(riskSet, -1), /Invalid horizon/)
})

test('issuer refuses to skip an older unissued observation after a later quote exists', () => {
  const sources = fixture([
    pairMembers(['success', 'success', 'success']),
    pairMembers(['success', 'success', 'success']),
  ])
  const result = issueLatest({
    out: `/tmp/scrvusd-cohort-duration-test-${process.pid}`,
    sources,
    now: () => new Date((BASE + 605) * 1000),
  })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'oldest_unissued_observation_window_missed')
  assert.equal(result.block, 100)
})
