import assert from 'node:assert/strict'
import test from 'node:test'
import { scoreDenseWindow, scoreExpanded } from './aave-freeze-window-score.mjs'

const HOUR = 3600
const DAY = 86400

function windowAt(anchorAt, kind = 'incident', incidentAt = anchorAt, postCash = [900, 880]) {
  const rows = Array.from({ length: 115 }, (_, i) => ({
    block: 1000 + i,
    at: anchorAt + (i - 112) * 3 * HOUR,
    cash: i < 113 ? 1000 : postCash[i - 113],
    cashRaw: String(i < 113 ? 1000 : postCash[i - 113]),
    status: 'ok',
  }))
  return {
    kind,
    incidentAt,
    anchorAt,
    anchorBlock: 1112,
    rows,
    coverage: { complete: true, scheduled: 115 },
  }
}

test('scores a strictly pre-anchor p95 and exact +3h/+6h six-hour deltas', () => {
  const scored = scoreDenseWindow(windowAt(20 * DAY))
  assert.equal(scored.status, 'scored')
  assert.equal(scored.baseline.p95Usd, 0)
  assert.equal(scored.baseline.pairs, 110)
  assert.deepEqual(
    scored.checkpoints.map((r) => [r.hour, r.sixHourDropUsd, r.flagged]),
    [
      [3, 100, true],
      [6, 120, true],
    ],
  )
  assert.equal(scored.flagged, true)
  assert.ok(scored.baseline.drops.every((r) => r.at < scored.anchorAt))
})

test('rejects missing baseline rows and misaligned checkpoint without inventing negatives', () => {
  const anchorAt = 20 * DAY
  const gap = windowAt(anchorAt)
  gap.rows.splice(20, 3)
  gap.coverage.scheduled = gap.rows.length
  assert.equal(scoreDenseWindow(gap).status, 'unscorable')
  const late = windowAt(anchorAt)
  late.rows[113].at += 2 * HOUR
  assert.equal(scoreDenseWindow(late).status, 'unscorable')
})

test('unchanged or increasing cash never flags even when p95 is zero', () => {
  const scored = scoreDenseWindow(windowAt(20 * DAY, 'incident', 20 * DAY, [1000, 1001]))
  assert.equal(scored.status, 'scored')
  assert.equal(scored.flagged, false)
  assert.deepEqual(
    scored.checkpoints.map((r) => r.flagged),
    [false, false],
  )
})

test('joins only the frozen four outcome pairs and preserves April source', () => {
  const aprilAt = 1776539039
  const incidentAts = [20 * DAY, 40 * DAY, aprilAt, 60 * DAY]
  const incidents = incidentAts.map((at, i) => ({
    at,
    block: 1112,
    response: { 100000000: { eligible: true, crossed: i === 2 } },
    control: {
      at: at + 7 * DAY,
      block: 1112,
      response: { 100000000: { eligible: true, crossed: false } },
    },
  }))
  const windows = incidentAts
    .filter((at) => at !== aprilAt)
    .flatMap((at) => [
      windowAt(at, 'incident', at, [1000, 1000]),
      windowAt(at + 7 * DAY, 'control', at, [1000, 1000]),
    ])
  const prior = (anchorAt, flagged) => ({
    anchorAt,
    baseline: '14d pre-anchor p95',
    p95: 20,
    pairs: 110,
    coverage: { rows: 115 },
    checkpoints: [
      { hour: 3, sixHourDrop: flagged ? 30 : 0, flagged },
      { hour: 6, sixHourDrop: flagged ? 30 : 0, flagged },
    ],
  })
  const scored = scoreExpanded({
    windows: { status: 'complete', windows },
    april: {
      status: 'complete',
      exploratory: true,
      results: [prior(aprilAt, true), prior(aprilAt + 7 * DAY, false)],
    },
    study: { status: 'complete', incidents },
  })
  assert.equal(scored.results.length, 8)
  assert.equal(scored.summary.incidentTruePositives, 1)
  assert.equal(scored.summary.incidentFalsePositives, 0)
  assert.equal(scored.summary.controlFlags, 0)
  assert.equal(scored.summary.minimumSampleGatePassed, false)
  assert.match(scored.results[4].source, /not recomputed/)
  windows[0].rows.splice(20, 3)
  windows[0].coverage.scheduled = windows[0].rows.length
  const partial = scoreExpanded({
    windows: { status: 'complete', windows },
    april: {
      status: 'complete',
      exploratory: true,
      results: [prior(aprilAt, true), prior(aprilAt + 7 * DAY, false)],
    },
    study: { status: 'complete', incidents },
  })
  assert.equal(partial.status, 'partial')
  assert.equal(partial.summary.scoredIncidents, 3)
})

test('a non-crossing incident flag retires the candidate instead of being hidden by April', () => {
  const aprilAt = 1776539039
  const ats = [20 * DAY, 40 * DAY, aprilAt, 60 * DAY]
  const study = {
    status: 'complete',
    incidents: ats.map((at, i) => ({
      at,
      block: 1112,
      response: { 100000000: { eligible: true, crossed: i === 2 } },
      control: {
        at: at + 7 * DAY,
        block: 1112,
        response: { 100000000: { eligible: true, crossed: false } },
      },
    })),
  }
  const windows = {
    status: 'complete',
    windows: ats
      .filter((at) => at !== aprilAt)
      .flatMap((at) => [
        windowAt(at, 'incident', at, at === 20 * DAY ? [900, 880] : [1000, 1000]),
        windowAt(at + 7 * DAY, 'control', at, [1000, 1000]),
      ]),
  }
  const april = {
    status: 'complete',
    exploratory: true,
    results: [aprilAt, aprilAt + 7 * DAY].map((anchorAt, i) => ({
      anchorAt,
      baseline: '14d pre-anchor p95',
      p95: 20,
      pairs: 110,
      checkpoints: [
        { hour: 3, sixHourDrop: i ? 0 : 30, flagged: i === 0 },
        { hour: 6, sixHourDrop: 0, flagged: false },
      ],
    })),
  }
  const scored = scoreExpanded({ windows, april, study })
  assert.equal(scored.summary.incidentFalsePositives, 1)
  assert.equal(scored.summary.retireCandidateAsAlert, true)
})
