import assert from 'node:assert/strict'
import test from 'node:test'
import { COUNT, GRID } from './multi-market-exit-prevalence.mjs'
import {
  evaluateWarning,
  LOOKBACK_BLOCKS,
  PAIRS,
  pastCashDrop,
  screen,
} from './peer-cash-shock-proxy-screen.mjs'

const START = 1_700_000_000
const STEP_SECONDS = 6 * 3600
const BOUNDARY_INDEX = 800
const BOUNDARY_AT = START + BOUNDARY_INDEX * STEP_SECONDS
const row = (market, index, cash = 2_000_000) => ({
  market,
  block: GRID.first + index * GRID.step,
  at: START + index * STEP_SECONDS,
  kind: 'observed',
  active: true,
  withdrawPaused: false,
  supplyUsdAssumingPeg: 10_000_000,
  cashUsdAssumingPeg: cash,
})
const onset = (market, index) => ({
  market,
  block: GRID.first + index * GRID.step,
  at: START + index * STEP_SECONDS,
  cause: 'cash',
})
const cohort = () =>
  PAIRS.map(([market]) => Array.from({ length: COUNT }, (_, index) => row(market, index))).flat()
const find = (rows, market, index) =>
  rows.find((x) => x.market === market && x.block === GRID.first + index * GRID.step)

test('7,200-block peer lookback is four grid steps and uses only observations by anchor time', () => {
  assert.equal(LOOKBACK_BLOCKS, 4 * GRID.step)
  const prior = row('cUSDCv3', 96, 2_000_000)
  const current = row('cUSDCv3', 100, 1_600_000)
  const x = pastCashDrop(current, prior, row('aave-usdc', 100).at)
  assert.equal(x.status, 'scorable')
  assert.equal(x.drop, 0.2)
  assert.equal(x.lookbackSeconds, 24 * 3600)
  assert.equal(pastCashDrop(current, null, row('aave-usdc', 100).at).status, 'missingPeer')
  assert.equal(
    pastCashDrop({ ...current, at: current.at + 1 }, prior, current.at).status,
    'invalidPeer',
  )
  assert.equal(pastCashDrop({ ...current, active: false }, prior, current.at).status, 'invalidPeer')
  assert.equal(
    pastCashDrop(current, { ...prior, withdrawPaused: true }, current.at).status,
    'invalidPeer',
  )
})

test('actual pre-onset 6h, event <=24h, and 2-4 grid steps are required', () => {
  const rows = Array.from({ length: 5 }, (_, index) => row('aave-usdc', index))
  const events = new Map([[rows[2].block, onset('aave-usdc', 2)]])
  assert.equal(evaluateWarning(rows, 0, events, BOUNDARY_AT).status, 'hit')
  assert.equal(evaluateWarning(rows, 1, events, BOUNDARY_AT).status, 'late')
  const shortLead = rows.map((r, i) => ({ ...r, at: START + [0, 3, 6, 9, 12][i] * 3600 }))
  assert.equal(evaluateWarning(shortLead, 0, events, BOUNDARY_AT).status, 'late')
  const over24h = rows.map((r, i) => ({
    ...r,
    at: START + [0, 6, 12, 18, 24 + 1 / 3600][i] * 3600,
  }))
  const quiet = evaluateWarning(over24h, 0, new Map(), BOUNDARY_AT)
  assert.equal(quiet.status, 'quietFalse')
  assert.equal(quiet.observedThroughSeconds, 24 * 3600 + 1)
  const atFourth = new Map([[over24h[4].block, onset('aave-usdc', 4)]])
  atFourth.get(over24h[4].block).at = over24h[4].at
  assert.equal(evaluateWarning(over24h, 0, atFourth, BOUNDARY_AT).status, 'late')
})

test('cooldown retains first warning while every eligible anchor and quiet false alarm is counted', () => {
  const rows = cohort()
  find(rows, 'cUSDCv3', 100).cashUsdAssumingPeg = 1_500_000
  find(rows, 'cUSDCv3', 101).cashUsdAssumingPeg = 1_400_000
  const result = screen(rows, [], BOUNDARY_AT)
  const peer = result.rules.peerShock
  const selected = peer.warnings.filter(
    (w) =>
      w.target === 'aave-usdc' &&
      w.block >= GRID.first + 100 * GRID.step &&
      w.block <= GRID.first + 101 * GRID.step,
  )
  assert.equal(selected.length, 1)
  assert.equal(selected[0].status, 'quietFalse')
  assert.equal(peer.train.quietFalse >= 1, true)
  assert.equal(peer.train.eligibleAnchors > peer.train.emittedWarnings, true)
  assert.equal(result.coverage.cashOnsets, 0)
  assert.equal(result.exploratoryFalsification.retired, true)
})

test('an unlabeled low-cash future is not counted as a quiet false alarm', () => {
  const rows = Array.from({ length: 5 }, (_, index) => row('aave-usdc', index))
  rows[2].cashUsdAssumingPeg = 500_000
  assert.equal(evaluateWarning(rows, 0, new Map(), BOUNDARY_AT).status, 'unlabelledLow')
})

test('valid Comet rows with undefined kind work as both peer and target', () => {
  const rows = cohort()
  for (const r of rows) if (r.market === 'cUSDCv3') delete r.kind
  find(rows, 'cUSDCv3', 100).cashUsdAssumingPeg = 1_500_000
  const result = screen(rows, [], BOUNDARY_AT)
  assert.equal(result.coverage.peerMissingness.invalidPeer, 0)
  assert.equal(
    result.rules.peerShock.warnings.some(
      (w) => w.target === 'aave-usdc' && w.block === GRID.first + 100 * GRID.step,
    ),
    true,
  )
  assert.equal(result.rules.peerShock.train.eligibleAnchors > 0, true)
  const cometFuture = Array.from({ length: 5 }, (_, index) => {
    const r = row('cUSDCv3', index)
    delete r.kind
    return r
  })
  const event = onset('cUSDCv3', 2)
  assert.equal(
    evaluateWarning(cometFuture, 0, new Map([[event.block, event]]), BOUNDARY_AT).status,
    'hit',
  )
})

test('missing or ineligible peer history fails closed without fabricating a signal', () => {
  const rows = cohort()
  find(rows, 'cUSDCv3', 100).cashUsdAssumingPeg = 1_500_000
  find(rows, 'cUSDCv3', 100).kind = 'ineligible'
  const result = screen(rows, [], BOUNDARY_AT)
  assert.equal(result.coverage.peerMissingness.invalidPeer >= 1, true)
  assert.equal(
    result.rules.peerShock.warnings.some(
      (w) => w.target === 'aave-usdc' && w.block === GRID.first + 100 * GRID.step,
    ),
    false,
  )
  assert.throws(
    () =>
      screen(
        rows.filter((x) => !(x.market === 'cUSDCv3' && x.block === GRID.first + 100 * GRID.step)),
        [],
        BOUNDARY_AT,
      ),
    /Incomplete paired market/,
  )
})

test('chronological purge prevents a cross-boundary target from becoming a hit', () => {
  const near = Array.from({ length: 5 }, (_, index) => row('aave-usdc', BOUNDARY_INDEX - 2 + index))
  const event = onset('aave-usdc', BOUNDARY_INDEX)
  assert.equal(
    evaluateWarning(near, 0, new Map([[event.block, event]]), BOUNDARY_AT).status,
    'boundaryPurge',
  )
  const rows = cohort()
  find(rows, 'cUSDCv3', BOUNDARY_INDEX - 2).cashUsdAssumingPeg = 1_500_000
  const result = screen(rows, [event], BOUNDARY_AT)
  assert.equal(result.rules.peerShock.train.hitOnsets, 0)
  assert.equal(result.rules.peerShock.holdout.hitOnsets, 0)
  assert.equal(result.rules.peerShock.purged.exclusions.boundaryPurge >= 1, true)
})
