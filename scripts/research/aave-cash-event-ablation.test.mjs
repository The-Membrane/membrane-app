import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DAY,
  HOUR,
  evaluate,
  firstCrossingInHorizon,
  pastBaseline,
  sixHourDrop,
} from './aave-cash-event-ablation.mjs'

const baseAt = 1_700_000_000
function rows(days = 30) {
  return Array.from({ length: days * 8 + 1 }, (_, i) => ({
    at: baseAt + i * 3 * HOUR,
    block: i + 1,
    cash: 200_000_000,
    debt: 50_000_000,
    liquidityRatePct: 1,
    borrowRatePct: 2,
    active: true,
    frozen: false,
    paused: false,
  }))
}

test('baseline uses only rows before the anchor and six-hour path rejects a gap', () => {
  const series = rows()
  const anchor = 20 * 8
  const before = pastBaseline(series, anchor)
  assert.equal(before.p95, 0)
  series[anchor + 1].cash = 1
  assert.deepEqual(pastBaseline(series, anchor), before)
  series[anchor - 1].at -= 5 * HOUR
  assert.equal(sixHourDrop(series, anchor), null)
})

test('target requires first crossing at +6–24h and complete intervening coverage', () => {
  const series = rows()
  const anchor = 20 * 8
  series[anchor + 3].cash = 90_000_000
  assert.equal(firstCrossingInHorizon(series, anchor).first.leadHours, 9)
  series[anchor + 1].cash = 90_000_000
  assert.equal(firstCrossingInHorizon(series, anchor).complete, false)
  series[anchor + 1].cash = 200_000_000
  series[anchor + 2].at += 5 * HOUR
  assert.equal(firstCrossingInHorizon(series, anchor).complete, false)
  series[anchor + 2].at -= 5 * HOUR
  series[anchor + 3].cash = 200_000_000
  series[anchor + 9].cash = 90_000_000
  assert.deepEqual(firstCrossingInHorizon(series, anchor), { complete: true, first: null })
})

test('both arms use the same threshold, with a prior event retaining the true alert', () => {
  const series = rows()
  const hitIndex = 20 * 8
  series[hitIndex].cash = 160_000_000
  series[hitIndex + 1].cash = 160_000_000
  series[hitIndex + 2].cash = 160_000_000
  series[hitIndex + 3].cash = 90_000_000
  const falseIndex = 25 * 8
  series[falseIndex].cash = 150_000_000
  series[falseIndex + 1].cash = 150_000_000
  series[falseIndex + 2].cash = 150_000_000
  const event = {
    type: 'ReserveFrozen',
    enabled: true,
    at: series[hitIndex].at - HOUR,
    asset: '0x0000000000000000000000000000000000000001',
    targetAsset: '0x0000000000000000000000000000000000000002',
  }
  const result = evaluate(series, [event])
  assert.equal(result.cashOnly.alerts, 2)
  assert.equal(result.cashOnly.hits, 1)
  assert.equal(result.cashOnly.falseAlerts, 1)
  assert.equal(result.eventGated.alerts, 1)
  assert.equal(result.eventGated.hits, 1)
  assert.equal(result.eventGated.falseAlerts, 0)
  assert.equal(result.eventGated.recall, 1)
  assert.equal(result.eventGated.leadHours[0], 9)
  assert.equal(result.eventGated.alertsDetail[0].at, result.cashOnly.alertsDetail[0].at)
})

test('a pre-event cash alarm does not suppress the event arm after the event', () => {
  const series = rows()
  const index = 20 * 8
  series[index].cash = 160_000_000
  series[index + 1].cash = 160_000_000
  series[index + 2].cash = 160_000_000
  series[index + 3].cash = 90_000_000
  const event = {
    type: 'ReserveFrozen',
    enabled: true,
    at: series[index].at + 2 * HOUR,
    asset: '0x0000000000000000000000000000000000000001',
    targetAsset: '0x0000000000000000000000000000000000000002',
  }
  const result = evaluate(series, [event])
  assert.equal(result.cashOnly.alerts, 1)
  assert.equal(result.cashOnly.alertsDetail[0].at, series[index].at)
  assert.equal(result.eventGated.alerts, 1)
  assert.equal(result.eventGated.alertsDetail[0].at, series[index + 1].at)
  assert.equal(result.eventGated.hits, 1)
  assert.equal(result.eventGated.leadHours[0], 6)
})

test('positive USDe event and stale cross-asset event do not pass the gate', () => {
  const series = rows()
  const index = 20 * 8
  series[index].cash = 160_000_000
  series[index + 3].cash = 90_000_000
  const targetAsset = '0x0000000000000000000000000000000000000002'
  const event = (asset, at) => ({ type: 'ReservePaused', enabled: true, asset, targetAsset, at })
  const result = evaluate(series, [
    event(targetAsset, series[index].at - HOUR),
    event('0x0000000000000000000000000000000000000001', series[index].at - DAY),
  ])
  assert.equal(result.cashOnly.hits, 1)
  assert.equal(result.eventGated.alerts, 0)
})
