import test from 'node:test'
import assert from 'node:assert/strict'
import { readCheckpoint } from './aave-stable-expansion.mjs'
import { SOURCE } from './aave-cash-horizon-labels.mjs'
import {
  evaluateStrictBreach,
  evaluateStrictBreachGrid,
  strictBreachSeries,
} from './aave-cash-strict-breach-backtest.mjs'

const H = 3600
const BOUNDARY = 2_000_000_000
const START = BOUNDARY - 100 * 86400
const row = (n, changes = {}) => ({
  market: 'USDC',
  block: n,
  at: START + n * 6 * H,
  kind: 'observed',
  active: true,
  withdrawPaused: false,
  cashUsdAssumingPeg: 2_000_000,
  ...changes,
})
const options = { amountUsd: 1_000_000, horizonSeconds: 24 * H, boundaryAt: BOUNDARY }
const at = (rows, block = 0, extra = {}) =>
  strictBreachSeries(rows, { ...options, ...extra }).find((label) => label.anchorBlock === block)

test('breach by H remains positive after recovery by the target witness', () => {
  const rows = [row(0), row(1, { cashUsdAssumingPeg: 500_000 }), row(2), row(3), row(4)]
  const label = at(rows)
  assert.equal(label.status, 'observed')
  assert.equal(label.breachedByH, true)
  assert.equal(label.firstBreachByHBlock, 1)
  assert.equal(label.legacyLagInclusiveBreach, true)
})

test('first below-q witness after H is v1 positive but strict negative', () => {
  const rows = [
    row(0),
    row(1),
    row(2),
    row(3),
    row(4, { at: row(4).at + H, cashUsdAssumingPeg: 500_000 }),
  ]
  const label = at(rows)
  assert.equal(label.status, 'observed')
  assert.equal(label.targetObservationLagSeconds, H)
  assert.equal(label.legacyLagInclusiveBreach, true)
  assert.equal(label.breachedByH, false)
  assert.deepEqual(label.firstBelowOnlyAfterH, { at: rows[4].at, block: 4 })
})

test('below-q at exact H is a by-H event', () => {
  const rows = [row(0), row(1), row(2), row(3), row(4, { cashUsdAssumingPeg: 500_000 })]
  assert.equal(at(rows).firstBreachByHAt, row(4).at)
  assert.equal(at(rows).breachedByH, true)
})

test('a gap or ineligible source censors even an earlier breach', () => {
  const gap = [row(0), row(1, { cashUsdAssumingPeg: 500_000 }), row(3), row(4)]
  assert.deepEqual([at(gap).status, at(gap).breachedByH], ['censored', null])
  const ineligible = [
    row(0),
    row(1, { cashUsdAssumingPeg: 500_000 }),
    row(2, { kind: 'ineligible' }),
    row(3),
    row(4),
  ]
  assert.deepEqual([at(ineligible).status, at(ineligible).breachedByH], ['censored', null])
})

test('as-of before H plus eight hours stays pending despite an early target witness', () => {
  const rows = [row(0), row(1, { cashUsdAssumingPeg: 500_000 }), row(2), row(3), row(4)]
  const label = at(rows, 0, { asOfAt: row(4).at })
  assert.equal(label.status, 'pending')
  assert.equal(label.censorReason, 'outcome_window_open_as_of')
  assert.equal(label.breachedByH, null)
  const complete = at(rows, 0, { asOfAt: row(4).at + 8 * H })
  assert.equal(complete.status, 'observed')
  assert.equal(complete.breachedByH, true)
})

test('later cash cannot leak through an as-of cutoff', () => {
  const rows = [row(0), row(1), row(2), row(3), row(4, { cashUsdAssumingPeg: 500_000 })]
  assert.equal(at(rows, 0, { asOfAt: row(3).at }).status, 'pending')
  assert.equal(at(rows, 0, { asOfAt: row(3).at }).firstBreachByHAt, null)
})

test('pause is a separate state and not itself a cash breach', () => {
  const rows = [row(0), row(1, { withdrawPaused: true }), row(2), row(3), row(4)]
  const label = at(rows)
  assert.equal(label.breachedByH, false)
  assert.equal(label.pauseObserved, true)
  assert.equal(at(rows, 1), undefined)
})

test('full frozen checkpoint yields the fixed nine cells with bounded counts', () => {
  const checkpoint = readCheckpoint(SOURCE)
  const grid = evaluateStrictBreachGrid(checkpoint)
  assert.equal(grid.cells.length, 9)
  for (const cell of grid.cells)
    for (const split of ['train', 'holdout']) {
      const counts = cell.total[split]
      assert.equal(counts.observed + counts.censored + counts.pending, counts.eligibleAnchors)
      assert.equal(counts.breachedByH + counts.noSampledBreachByH, counts.observed)
      assert.equal(
        counts.legacyPositiveStrictNegative,
        counts.legacyLagInclusiveBreach - counts.breachedByH,
      )
      assert.ok(counts.maxTargetObservationLagSeconds <= 8 * H)
    }
  assert.equal(
    evaluateStrictBreach(checkpoint, { amountUsd: 1_000_000, horizonSeconds: 24 * H })
      .sourceEntriesSha256,
    checkpoint.entriesSha256,
  )
})

test('partial or different source cohort is refused', () => {
  assert.throws(
    () =>
      evaluateStrictBreach(
        { status: 'partial', entries: [], failures: [] },
        { amountUsd: 1_000_000, horizonSeconds: 24 * H },
      ),
    /Checkpoint/,
  )
})
