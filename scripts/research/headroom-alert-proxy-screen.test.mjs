import test from 'node:test'
import assert from 'node:assert/strict'
import { GRID } from './multi-market-exit-prevalence.mjs'
import { evaluateWarning, groupEvents, screen } from './headroom-alert-proxy-screen.mjs'

const start = 1_700_000_000
const row = (i, cash = 2_000_000, opts = {}) => ({
  market: opts.market ?? 'sample',
  block: GRID.first + i * GRID.step,
  at: (opts.start ?? start) + i * 6 * 3600,
  cashUsdAssumingPeg: cash,
  supplyUsdAssumingPeg: 10_000_000,
  active: true,
  withdrawPaused: false,
  kind: 'observed',
  ...opts,
})
const onset = (r) => ({ market: r.market, block: r.block, at: r.at, cause: 'cash' })

test('past-only warning and actual pre-onset lead; immediate crossing is late', () => {
  const rs = [row(0, 1_200_000), row(1), row(2), row(3, 500_000), row(4)]
  const events = new Map([[rs[3].block, onset(rs[3])]])
  assert.equal(evaluateWarning(rs, 0, events, start + 100 * 86400).status, 'hit')
  assert.equal(evaluateWarning(rs, 2, events, start + 100 * 86400).status, 'false')
  const times = [0, 3, 5, 11, 17]
  const shortLead = rs.map((r, i) => ({ ...r, at: rs[0].at + times[i] * 3600 }))
  assert.equal(evaluateWarning(shortLead, 0, events, start + 100 * 86400).status, 'false')
})

test('four grid steps beyond 24 actual hours are not timely', () => {
  const times = [0, 6, 12, 18, 24 + 1 / 3600]
  const rs = times.map((hours, i) => ({
    ...row(i, i === 0 ? 1_200_000 : i === 4 ? 500_000 : 2_000_000),
    at: start + Math.round(hours * 3600),
  }))
  const events = new Map([[rs[4].block, onset(rs[4])]])
  const verdict = evaluateWarning(rs, 0, events, start + 100 * 86400)
  assert.equal(verdict.status, 'false')
  assert.equal(verdict.reason, 'late')
  assert.equal(verdict.firstOnset, `${rs[4].market}:${rs[4].block}`)
})

test('cooldown keeps first warning and full eligible-anchor denominator', () => {
  const rs = Array.from({ length: 9 }, (_, i) => row(i, 1_200_000))
  const x = screen(rs, [], [], start + 100 * 86400)
  assert.equal(x.train.eligibleAnchors, 9)
  assert.equal(x.train.candidateAnchors, 9)
  assert.deepEqual(
    x.warnings.map((w) => w.block),
    [rs[0].block, rs[4].block, rs[8].block],
  )
  assert.equal(x.train.falseWarnings, 2)
  assert.equal(x.train.exclusions.missingHorizon, 1)
})

test('missing horizon and pause interference stay explicit; calm future is false', () => {
  const rs = Array.from({ length: 5 }, (_, i) => row(i, i === 0 ? 1_200_000 : 2_000_000))
  assert.equal(evaluateWarning(rs, 0, new Map(), start + 100 * 86400).status, 'false')
  assert.equal(
    evaluateWarning(rs.slice(0, 4), 0, new Map(), start + 100 * 86400).status,
    'missingHorizon',
  )
  assert.equal(
    evaluateWarning(
      rs.map((r, i) => (i === 2 ? { ...r, withdrawPaused: true } : r)),
      0,
      new Map(),
      start + 100 * 86400,
    ).status,
    'pauseInterference',
  )
})

test('48-hour calendar linkage joins markets and keeps later groups distinct', () => {
  const events = [onset(row(0)), onset(row(1, 500_000, { market: 'other' })), onset(row(10))]
  assert.deepEqual(
    groupEvents(events).map((g) => g.events.length),
    [2, 1],
  )
})

test('chronological split purges boundary, forbids cross-split horizon and group leakage', () => {
  const boundary = start + 50 * 6 * 3600
  const rs = Array.from({ length: 12 }, (_, i) => row(i + 44, i === 44 ? 1_200_000 : 2_000_000))
  const near = [row(45, 1_200_000), row(46), row(47), row(48), row(49)]
  assert.equal(evaluateWarning(near, 0, new Map(), boundary).status, 'boundaryPurge')
  const all = [row(0, 1_200_000), row(1), row(2, 500_000), ...rs]
  const x = screen(all, [onset(all[2]), onset(rs.at(-1))], [], boundary)
  assert.equal(x.train.cashOnsets, 1)
  assert.equal(x.holdout.cashOnsets, 1)
  assert.equal(x.groups.train.length, 1)
  assert.equal(x.groups.holdout.length, 1)
})
