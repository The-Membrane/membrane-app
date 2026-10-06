import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import {
  changeCell,
  fmtAmount,
  fmtDuration,
  queueCell,
  waitCell,
} from '@/components/Venue/exitQueueLogic'
import {
  beaconSnapshot,
  parseSpec,
  summarizeExitQueue,
  type ExitingValidator,
} from '@/lib/exitQueue/beacon'
import { buildExitQueueFeed, observationStatus } from '@/lib/exitQueue/feed'
import { applyEvents, emptyLedger, recordSnapshot } from '@/lib/exitQueue/ledger'
import { venueMetrics } from '@/lib/exitQueue/metrics'
import { exitTimeInput, exitTimeS } from '@/lib/exitQueue/riskFrontier'
import { ledgerFile, loadLedger, saveLedger } from '@/lib/exitQueue/store'
import { label, LABEL_TEXT } from '@/lib/exitQueue/types'
import { allVenues } from '@/lib/exitQueue/venues'

import { addr, def, ledgerWithCoverage, tsOf } from './exitQueueFixtures'

const D = 86_400
const v = (exitEpoch: string, gwei: string, status = 'active_exiting'): ExitingValidator => ({
  status,
  validator: { exit_epoch: exitEpoch, effective_balance: gwei },
})

describe('beacon exit queue', () => {
  it('takes the schedule tail from the largest assigned exit epoch', () => {
    // Shape of the 2026-10-05 reading: head epoch 480,074, tail 482,088 → 2,014 epochs ≈ 8.95 d.
    const s = summarizeExitQueue(480_074 * 32 + 5, [
      v('480075', '32000000000'),
      v('482088', '2048000000000'),
      v('18446744073709551615', '32000000000'), // FAR_FUTURE: not actually exiting
      v('481000', '32000000000', 'active_ongoing'),
    ])
    expect(s).toMatchObject({
      headEpoch: 480_074,
      exitingCount: 2,
      exitingGwei: '2080000000000',
      tailExitEpoch: 482_088,
    })
    expect(s.scheduleWaitS).toBe(2_014 * 384)
    expect(s.withdrawabilityDelayS).toBe(256 * 384)
  })

  it('an empty queue waits 0; a bad spec is refused', () => {
    expect(summarizeExitQueue(100, []).scheduleWaitS).toBe(0)
    expect(() => parseSpec({ SECONDS_PER_SLOT: '12' })).toThrow(/SLOTS_PER_EPOCH/)
  })

  it('beacon readings over a window feed the beacon row and Risk Frontier as chain_schedule', () => {
    const l = emptyLedger('beacon-exit')
    for (const [i, days] of [8, 9, 10].entries()) {
      const s = summarizeExitQueue(480_000 * 32, [
        v(String(480_000 + Math.round((days * D) / 384)), '32000000000'),
      ])
      recordSnapshot(l, beaconSnapshot(s, 1_000 + i * 7_200, tsOf(1_000 + i * 7_200)))
    }
    const m = venueMetrics(def('beacon-exit'), l)
    const w30 = m.windows.find((w) => w.windowDays === 30)!
    expect(w30.requestToFinalize.n).toBe(3)
    const input = exitTimeInput(m)!
    // Readings over the window are history; only the anchor reading is the chain schedule.
    expect(input.label.basis).toBe('measured_history')
    expect(input.scheduleFloorS).toBe(m.scheduleWaitS! + 256 * 384)
    // Readings get the same withdrawability delay as the floor, so the parts compare.
    expect(input.requestToExit.p90S).toBe(w30.requestToFinalize.p90S! + 256 * 384)
  })
})

describe('Risk Frontier exit-time input', () => {
  it('takes the max of cooldown, schedule floor and measured quantile; null when nothing is known', () => {
    const base = {
      venue: 'sUSDe' as const,
      anchor: { block: 1, ts: 1 },
      label: label('measured_history'),
      advertisedSetsWait: true,
      oldestOpenAgeS: null,
      windowDays: 30,
      coverage: 'complete' as const,
      queueDepth: { amount: null, count: null, symbol: 'USDe', decimals: 18 },
      lastParamChangeTs: null,
      scheduleFloorS: null,
    }
    expect(
      exitTimeS({
        ...base,
        advertisedCooldownS: D,
        requestToExit: { p50S: D, p90S: D + 600, atLeastS: null, n: 9 },
      }),
    ).toBe(D + 600)
    // p90 not reached: the lower bound stands in, never zero.
    expect(
      exitTimeS({
        ...base,
        advertisedCooldownS: null,
        requestToExit: { p50S: null, p90S: null, atLeastS: 3 * D, n: 4 },
      }),
    ).toBe(3 * D)
    expect(
      exitTimeS({
        ...base,
        advertisedCooldownS: null,
        requestToExit: { p50S: null, p90S: null, atLeastS: null, n: 0 },
      }),
    ).toBeNull()
  })
})

describe('feed', () => {
  it('reports no_local_ledger when no venue has data', () => {
    const feed = buildExitQueueFeed(
      allVenues().map((d) => ({ def: d, ledger: emptyLedger(d.key) })),
    )
    expect(feed.status).toBe('no_local_ledger')
    expect(feed.observationStatus).toBeNull()
    expect(feed.riskFrontier).toEqual([])
    expect(feed.labels.measured_history).toBe('measured history, not a forecast')
  })

  it('orders venues by priority and goes historical when the oldest anchor is stale', () => {
    const lido = ledgerWithCoverage('lido-steth', 1_000, 2_000)
    const susde = ledgerWithCoverage('sUSDe', 1_000, 2_000)
    const feed = buildExitQueueFeed(
      [
        { def: def('sUSDe'), ledger: susde },
        { def: def('lido-steth'), ledger: lido },
      ],
      (tsOf(2_000) + 31 * 3_600) * 1_000,
    )
    expect(feed.venues.map((x) => x.venue)).toEqual(['lido-steth', 'sUSDe'])
    expect(feed.observationStatus).toBe('paused')
    expect(observationStatus(tsOf(2_000), (tsOf(2_000) + 3_600) * 1_000)).toBe('recent')
    expect(feed.riskFrontier.map((x) => x.venue)).toEqual(['lido-steth', 'sUSDe'])
  })
})

describe('store', () => {
  it('round-trips a ledger and refuses a file for another venue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exitq-'))
    const l = applyEvents(ledgerWithCoverage('lido-steth', 1, 2), def('lido-steth'), [
      { kind: 'request', id: '1', owner: addr(1), amount: 5n, block: 1, ts: 1, logIndex: 0 },
    ])
    saveLedger(l, dir)
    expect(loadLedger('lido-steth', dir)).toEqual(l)
    expect(loadLedger('kelp-rseth', dir)).toEqual(emptyLedger('kelp-rseth'))
    writeFileSync(ledgerFile('kelp-rseth', dir), JSON.stringify({ ...l }))
    expect(() => loadLedger('kelp-rseth', dir)).toThrow(/schema 1 for kelp-rseth/)
  })

  it('keeps ERC-7540 keys filesystem-safe', () => {
    expect(ledgerFile('erc7540:0xabc', '/d')).toBe('/d/erc7540_0xabc.json')
  })
})

describe('card text', () => {
  const metrics = () => {
    const l = ledgerWithCoverage('lido-steth', 1_000, 60_000)
    applyEvents(l, def('lido-steth'), [
      {
        kind: 'request',
        id: '1',
        owner: addr(1),
        amount: 10n ** 18n,
        block: 10_000,
        ts: tsOf(10_000),
        logIndex: 0,
      },
    ])
    recordSnapshot(l, {
      block: 60_000,
      ts: tsOf(60_000),
      depthAmount: (150_123n * 10n ** 18n).toString(),
      depthCount: 513,
      depthSource: 'onchain',
    })
    l.changes.push({
      param: 'bunkerMode',
      from: false,
      to: true,
      block: 50_000,
      ts: tsOf(50_000),
      source: 'state_diff',
      sinceBlock: 40_000,
    })
    return venueMetrics(def('lido-steth'), l)
  }

  it('shows the verified pre-coverage sUSDe cooldown change, and drops the seed once the ledger has the event', () => {
    const l = ledgerWithCoverage('sUSDe', 26_000_000, 26_100_000)
    const seededView = changeCell(venueMetrics(def('sUSDe'), l))
    expect(seededView.primary).toBe('cooldown 7.0d → 24.0h')
    expect(seededView.secondary).toMatch(/^2026-03-16 · emitted as an event/)
    l.changes.push({ ...def('sUSDe').seededChanges![0], source: 'event' })
    expect(venueMetrics(def('sUSDe'), l).changes).toHaveLength(1)
  })

  it('formats durations without pretending to precision', () => {
    expect([
      fmtDuration(null),
      fmtDuration(0),
      fmtDuration(30),
      fmtDuration(1_800),
      fmtDuration(5 * 3_600),
      fmtDuration(3 * D),
    ]).toEqual(['—', '0s', '<1m', '30m', '5.0h', '3.0d'])
    expect([fmtAmount(0, 'syrupUSDC'), fmtAmount(15_265_198.2, 'USDe')]).toEqual([
      '0 syrupUSDC',
      '15.27M USDe',
    ])
  })

  it('shows queue now, a censored wait as a lower bound, and a silent change with its bracket', () => {
    const m = metrics()
    expect(queueCell(m)).toEqual({ primary: '150.1k stETH', secondary: '513 requests waiting' })
    const wait = waitCell(m)
    expect(wait.primary).toBe(`≥ ${fmtDuration(tsOf(60_000) - tsOf(10_000))}`)
    expect(wait.secondary).toMatch(/still waiting/)
    expect(changeCell(m).primary).toBe('bunker mode off → on')
    expect(changeCell(m).secondary).toMatch(/silent \(no event\).*after block 40000/)
  })

  it('flags a ledger/chain mismatch next to the queue count', () => {
    const m = metrics()
    m.queueNow.reconciliation = { ledgerOpen: 141, onchain: 138, status: 'ledger_over' }
    expect(queueCell(m).secondary).toBe(
      '513 requests waiting · ledger holds 141 open vs 138 on-chain',
    )
  })

  it('says when completion times are only upper bounds', () => {
    const m = metrics()
    m.ledgerHealth.bracketedFinalizations = 3
    expect(waitCell(m).secondary).toMatch(/3 completion times are upper bounds/)
  })

  it('never words a number as an ETA or estimate', () => {
    const text = JSON.stringify([
      queueCell(metrics()),
      waitCell(metrics()),
      changeCell(metrics()),
      LABEL_TEXT,
    ])
    expect(text).not.toMatch(/\bETA\b|estimat|expected|predict/i)
  })
})
