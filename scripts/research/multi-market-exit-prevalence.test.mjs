import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GRID,
  COUNT,
  MARKETS,
  SCENARIOS,
  blocks,
  validRow,
  validateRows,
  validateCheckpoint,
  loadCache,
  mergeRows,
  plan,
  episodes,
  controls,
  snapshot,
  score,
  readCheckpoint,
} from './multi-market-exit-prevalence.mjs'

const m = MARKETS[2]
const row = (i, cash = 2_000_000, at = 1_700_000_000 + i * 6 * 3600) => ({
  market: m.name,
  block: GRID.first + i * GRID.step,
  at,
  base: m.base,
  decimals: m.decimals,
  cashUsdAssumingPeg: cash,
  supplyUsdAssumingPeg: 100_000_000,
  withdrawPaused: false,
  active: true,
  frozen: false,
  source: 'archive',
})

test('grid and cache reuse are exact-block only with partial Aave supply', () => {
  assert.equal(blocks().length, COUNT)
  const cached = loadCache(),
    p = plan(cached)
  assert.equal(p.markets['aave-usde'].cachedPartial, COUNT)
  assert.equal(p.markets['aave-usdc'].missing, COUNT)
  assert.equal(p.markets.cUSDCv3.cachedFull, 57)
  assert.equal(p.markets.cUSDTv3.cachedFull, 57)
  assert.equal(p.markets.cUSDSv3.cachedFull, 57)
  assert.equal(score(cached).status, 'partial')
})

test('identity, duplicate, invalid and incomplete rows are rejected', () => {
  assert.equal(validRow(row(0)), true)
  assert.equal(validRow({ ...row(0), base: '0xdead' }), false)
  assert.equal(validRow({ ...row(0), block: GRID.first + 1 }), false)
  assert.equal(validRow({ ...row(0), supplyUsdAssumingPeg: undefined }), false)
  assert.throws(() => validateRows([row(0), row(0)]), /duplicate/)
  assert.throws(() => mergeRows([row(0)], [{ ...row(0), cashUsdAssumingPeg: 3 }]), /Conflicting/)
  assert.throws(() => mergeRows([row(0)], [{ ...row(0), at: row(0).at + 1 }]), /Conflicting/)
  assert.throws(() => mergeRows([row(0)], [{ ...row(0), active: false }]), /Conflicting/)
})

test('cash onset requires a funded active unpaused pre-onset anchor', () => {
  const inadequate = [row(0), { ...row(1, 500_000), supplyUsdAssumingPeg: 500_000 }]
  assert.equal(episodes(inadequate, SCENARIOS[0]).events.length, 1) // pre-anchor, not current supply, is eligibility
  const noSupply = [{ ...row(0), supplyUsdAssumingPeg: null }, row(1, 500_000)]
  assert.equal(episodes(noSupply, SCENARIOS[0]).events.length, 0)
  assert.equal(episodes(noSupply, SCENARIOS[0]).excluded.missingSupply, 1)
  const tooSmall = [{ ...row(0), supplyUsdAssumingPeg: 500_000 }, row(1, 500_000)]
  assert.equal(episodes(tooSmall, SCENARIOS[0]).events.length, 0)
  const paused = [{ ...row(0), withdrawPaused: true }, row(1, 500_000)]
  assert.equal(episodes(paused, SCENARIOS[0]).events.length, 0)
  const nowPaused = [row(0), { ...row(1, 500_000), withdrawPaused: true }]
  assert.equal(episodes(nowPaused, SCENARIOS[0]).events.length, 0)
})

test('24h recovered state and 48h separation deduplicate recrossings', () => {
  const rs = Array.from({ length: 27 }, (_, i) =>
    row(i, i === 1 || i === 3 || (i >= 10 && i <= 14) || i === 20 ? 500_000 : 2_000_000),
  )
  const e = episodes(rs, SCENARIOS[0])
  assert.deepEqual(
    e.events.map((x) => x.block),
    [row(1).block, row(10).block, row(20).block],
  )
})

test('left censor, >8h gap censor, dynamic threshold missing and pause separate', () => {
  const low = [row(0, 500_000), row(1), row(2, 500_000, 1_700_000_000 + 30 * 3600)]
  const e = episodes(low, SCENARIOS[0])
  assert.equal(e.events.length, 0)
  assert.equal(e.excluded.leftCensored, 2)
  assert.equal(e.excluded.gapCensored, 1)
  assert.equal(
    episodes([{ ...row(0), supplyUsdAssumingPeg: null }], SCENARIOS[2]).excluded.missingSupply,
    1,
  )
  const p = episodes([row(0), { ...row(1), withdrawPaused: true }], SCENARIOS[0])
  assert.equal(p.events.length, 0)
  assert.equal(
    episodes([row(0), { ...row(1), withdrawPaused: true }], SCENARIOS[0], 'pause').events.length,
    1,
  )
})

test('daily controls require complete forward samples and are disjoint from events', () => {
  const rs = Array.from({ length: 5 }, (_, i) => row(i))
  const boundary = rs[0].at + 100 * 86400
  assert.equal(controls(rs, SCENARIOS[0], [], boundary).controls, 1)
  assert.ok(controls(rs.slice(0, 4), SCENARIOS[0], [], boundary).unscorable.missingForward >= 1)
  assert.equal(controls(rs, SCENARIOS[0], [{ at: rs[2].at }], boundary).controls, 0)
  assert.equal(
    controls([{ ...rs[0], supplyUsdAssumingPeg: null }, ...rs.slice(1)], SCENARIOS[0], [], boundary)
      .unscorable.insufficientSupplyOrCash,
    1,
  )
})

test('pause is separately deduplicated, split, purged and controlled', () => {
  const b = Math.floor(COUNT * 0.7)
  const rs = Array.from({ length: 21 }, (_, i) => ({
    ...row(b - 10 + i, 2_000_000, 1_700_000_000 + i * 6 * 3600),
    withdrawPaused: i === 4 || i === 16,
  }))
  const pause = score(rs).markets[m.name].scenarios['fixed-1m'].pause
  const cash = score(rs).markets[m.name].scenarios['fixed-1m'].cash
  assert.equal(pause.observedEpisodes, 2)
  assert.equal(pause.train, 1)
  assert.equal(pause.holdout, 1)
  assert.equal(cash.observedEpisodes, 0)
  assert.ok(pause.denominator.observedMarketDays > 0)
  const recross = Array.from({ length: 27 }, (_, i) => ({
    ...row(i),
    withdrawPaused: i === 1 || i === 3 || (i >= 10 && i <= 14) || i === 20,
  }))
  assert.equal(episodes(recross, SCENARIOS[0], 'pause').events.length, 3)
})

test('forward horizon uses timestamps and censors <24h even after four slots', () => {
  const boundary = 1_700_000_000 + 100 * 86400
  const after = Array.from({ length: 5 }, (_, i) =>
    row(i, i === 4 ? 500_000 : 2_000_000, 1_700_000_000 + i * 6 * 3600 + (i === 4 ? 60 : 0)),
  )
  assert.equal(controls(after, SCENARIOS[0], [], boundary).controls, 1)
  const before = after.map((r, i) => ({
    ...r,
    at: 1_700_000_000 + i * 6 * 3600 - (i === 4 ? 60 : 0),
  }))
  assert.equal(controls(before, SCENARIOS[0], [], boundary).unscorable.missingForward >= 1, true)
  const covered = [...before, row(5, 2_000_000, 1_700_000_000 + 30 * 3600)]
  assert.equal(controls(covered, SCENARIOS[0], [], boundary).controls, 0)
})

test('boundary purge uses true time, not block-slot count', () => {
  const b = Math.floor(COUNT * 0.7)
  const t = 1_700_000_000
  const inside = [
    row(b - 6, 2_000_000, t - 27 * 3600),
    row(b - 5, 500_000, t - 22.5 * 3600),
    row(b, 2_000_000, t),
  ]
  assert.equal(score(inside).markets[m.name].scenarios['fixed-1m'].cash.observedEpisodes, 0)
  assert.equal(score(inside).markets[m.name].scenarios['fixed-1m'].cash.purged, 1)
  const outside = [
    row(b - 5, 2_000_000, t - 32 * 3600),
    row(b - 4, 500_000, t - 26 * 3600),
    row(b, 2_000_000, t),
  ]
  assert.equal(score(outside).markets[m.name].scenarios['fixed-1m'].cash.observedEpisodes, 1)
})

test('time split purges 24h around boundary, retains independent denominator', () => {
  const boundary = Math.floor(COUNT * 0.7)
  const rs = [
    row(boundary - 5),
    row(boundary - 4, 500_000),
    row(boundary - 3),
    row(boundary - 1),
    row(boundary),
    row(boundary + 1, 500_000),
  ]
  const s = score(rs).markets[m.name].scenarios['fixed-1m'].cash
  assert.equal(s.observedEpisodes, 0)
  assert.ok(s.purged >= 1)
  assert.equal(score(rs).markets[m.name].missing, COUNT - rs.length)
})

test('checkpoint detects corruption and never treats partial as complete', () => {
  const directory = mkdtempSync(join(tmpdir(), 'multi-market-screen-test-'))
  const file = join(directory, 'checkpoint.json')
  try {
    const valid = snapshot([row(0)], [])
    assert.equal(validateCheckpoint(valid).status, 'partial')
    assert.throws(() => validateCheckpoint({ ...valid, status: 'complete' }), /Incomplete/)
    assert.throws(
      () => validateCheckpoint({ ...valid, rows: [{ ...row(0), cashUsdAssumingPeg: -1 }] }),
      /Invalid/,
    )
    const failed = snapshot([], [{ market: m.name, block: GRID.first, error: 'timeout' }])
    const duplicate = snapshot([], [...failed.failures, ...failed.failures])
    assert.throws(() => validateCheckpoint(duplicate), /Invalid failure/)
    writeFileSync(file, JSON.stringify({ ...valid, rowsSha256: 'bad' }))
    assert.throws(() => readCheckpoint(file), /corruption/)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).rowsSha256, 'bad')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
