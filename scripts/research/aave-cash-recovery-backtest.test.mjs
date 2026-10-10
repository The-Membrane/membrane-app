import test from 'node:test'
import assert from 'node:assert/strict'
import { readCheckpoint, snapshot } from './aave-stable-expansion.mjs'
import { SOURCE } from './aave-cash-horizon-labels.mjs'
import {
  evaluateRecoveryCheckpoint,
  evaluateRecoverySeries,
} from './aave-cash-recovery-backtest.mjs'

const H = 3600
const BASE = 2_000_000_000
const Q = 1_000_000
const row = (n, cash, extra = {}) => ({
  market: 'DAI',
  block: n + 1,
  at: BASE + n * 6 * H,
  kind: 'observed',
  active: true,
  withdrawPaused: false,
  cashUsdAssumingPeg: cash,
  ...extra,
})
const run = (rows, extra = {}) =>
  evaluateRecoverySeries(rows, {
    market: 'DAI',
    amountUsd: Q,
    horizonSeconds: 8 * H,
    boundaryAt: BASE + 40 * 6 * H,
    ...extra,
  })

test('recovery bracket before H is yes; bracket straddling H remains unresolved', () => {
  const yes = run([row(0, Q), row(1, Q - 1), row(2, Q)], { boundaryAt: BASE + 100 * H })
  assert.equal(yes.records.train[0].status, 'recovered_by_horizon')
  assert.equal(yes.records.train[0].outcome, true)
  const ambiguous = run([row(0, Q), row(1, Q - 1), row(2, Q - 1), row(3, Q)], {
    boundaryAt: BASE + 100 * H,
  })
  assert.equal(ambiguous.records.train[0].status, 'recovery_bracket_straddles_target')
  assert.equal(ambiguous.records.train[0].outcome, null)
  assert.deepEqual(ambiguous.records.train[0].recoveryBracket, {
    afterAt: BASE + 12 * H,
    byAt: BASE + 18 * H,
  })
})

test('a below sample near H yields a sampled negative and elapsed landmark is one episode', () => {
  const rows = [row(0, Q), row(1, Q - 1), row(2, Q - 1), row(3, Q - 1), row(4, Q - 1), row(5, Q)]
  const result = run(rows, { boundaryAt: BASE + 100 * H, elapsedSeconds: 6 * H })
  assert.equal(result.records.train.length, 1)
  assert.equal(result.records.train[0].landmarkAt, rows[2].at)
  assert.equal(result.records.train[0].status, 'still_below_at_horizon_sample')
  assert.equal(result.records.train[0].outcome, false)
})

test('left censor, gap, ineligible sample, and series edge remain separate', () => {
  const boundaryAt = BASE + 100 * H
  assert.match(
    run([row(0, Q - 1), row(1, Q)], { boundaryAt }).records.train[0].status,
    /left_censored_series_edge/,
  )
  const gap = run([row(0, Q), row(1, Q - 1), row(3, Q)], { boundaryAt })
  assert.equal(gap.records.train[0].status, 'right_censored_gap')
  const ineligible = run([row(0, Q), row(1, Q - 1), row(2, undefined, { kind: 'ineligible' })], {
    boundaryAt,
  })
  assert.equal(ineligible.records.train[0].status, 'right_censored_ineligible_sample')
  const edge = run([row(0, Q), row(1, Q - 1)], { boundaryAt })
  assert.equal(edge.records.train[0].status, 'right_censored_split_boundary')
  const holdoutEdge = run([row(0, Q), row(1, Q - 1)], { boundaryAt: BASE - 100 * H })
  assert.equal(holdoutEdge.records.holdout[0].status, 'right_censored_series_edge')
})

test('an elapsed landmark after recovery is not a new independent episode', () => {
  const result = run([row(0, Q), row(1, Q - 1), row(2, Q)], {
    boundaryAt: BASE + 100 * H,
    elapsedSeconds: 12 * H,
  })
  assert.equal(result.records.excludedBoundary.length, 1)
  assert.equal(result.records.excludedBoundary[0].status, 'censored_before_landmark')
  assert.equal(result.records.train.length, 0)
})

test('boundary purge excludes crossing episodes and no future outcome is used at as-of', () => {
  const rows = [row(0, Q), row(1, Q - 1), row(2, Q), row(3, Q - 1), row(4, Q)]
  const boundary = run(rows, { boundaryAt: rows[3].at })
  assert.equal(boundary.records.train.length, 0)
  assert.equal(boundary.records.holdout.length, 0)
  assert.equal(boundary.records.excludedBoundary.length, 2)
  const pending = run(rows, { boundaryAt: BASE + 100 * H, asOfAt: rows[1].at })
  assert.equal(pending.records.train[0].status, 'pending_as_of')
  assert.equal(pending.records.train[0].outcome, null)
})

test('training episode exposes no recovery observation from after its split cutoff', () => {
  const rows = Array.from({ length: 21 }, (_, n) => row(n, n === 0 || n === 20 ? Q : Q - 1))
  const result = run(rows, { boundaryAt: BASE + 100 * H })
  const record = result.records.train[0]
  assert.equal(record.outcome, false)
  assert.equal(record.rightBracketed, false)
  assert.equal(record.rightCensorReason, 'split_boundary')
  assert.equal(record.recoveryBracket, null)
})

test('identical training prefixes yield identical records with different future tails', () => {
  const prefix = Array.from({ length: 13 }, (_, n) => row(n, n === 0 ? Q : Q - 1))
  const recoveredLater = run([...prefix, row(13, Q)], { boundaryAt: BASE + 100 * H })
  const staysBelow = run([...prefix, row(13, Q - 1), row(14, Q - 1)], {
    boundaryAt: BASE + 100 * H,
  })
  assert.deepEqual(recoveredLater.records.train, staysBelow.records.train)
  assert.equal(recoveredLater.records.train[0].rightCensorReason, 'split_boundary')
  assert.equal(recoveredLater.records.train[0].recoveryBracket, null)
})

test('support failure suppresses all empirical recovery estimates', () => {
  const result = run([row(0, Q), row(1, Q - 1), row(2, Q)], { boundaryAt: BASE + 100 * H })
  assert.equal(result.eligible, false)
  assert.equal(result.empiricalTrainRecoveryFraction, null)
  assert.equal(result.exploratoryHoldout, null)
  assert.equal(result.claims.likelyDuration, null)
  assert.ok(result.support.train.reasons.includes('too_few_distinct_episodes'))
})

test('full checkpoint requires frozen source digest and actual grid returns abstention', () => {
  const checkpoint = readCheckpoint(SOURCE)
  assert.ok(checkpoint)
  const result = evaluateRecoveryCheckpoint(checkpoint, {
    market: 'DAI',
    amountUsd: Q,
    horizonSeconds: 24 * H,
  })
  assert.equal(result.eligible, false)
  assert.equal(result.empiricalTrainRecoveryFraction, null)
  assert.equal(result.exploratoryHoldout, null)
  assert.equal(result.claims.alertEligible, false)
  const changed = checkpoint.entries.map((entry, i) =>
    i === 0 ? { ...entry, cashUsdAssumingPeg: entry.cashUsdAssumingPeg + 1 } : entry,
  )
  assert.throws(
    () =>
      evaluateRecoveryCheckpoint(snapshot(changed, []), {
        market: 'DAI',
        amountUsd: Q,
        horizonSeconds: 24 * H,
      }),
    /Frozen complete Aave checkpoint required/,
  )
})
