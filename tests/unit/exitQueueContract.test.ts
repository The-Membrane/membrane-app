import { readFileSync } from 'fs'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import { emptyLedger } from '@/lib/exitQueue/ledger'
import { venueMetrics } from '@/lib/exitQueue/metrics'
import { exitTime, exitTimeInput, exitTimeS, type ExitTimeInput } from '@/lib/exitQueue/riskFrontier'
import {
  BASIS_CLASS,
  label,
  LABEL_TEXT,
  type LabelBasis,
  type LabelClass,
} from '@/lib/exitQueue/types'
import { allVenues, venueKeyForAsset } from '@/lib/exitQueue/venues'

import { def, ledgerWithCoverage } from './exitQueueFixtures'

/**
 * The contract with the other layers, as the 2026-10-04 UMBRELLA board entry sets it:
 * one venue key per venue, a finalized-block anchor, and label classes that never blur.
 */

const D = 86_400
const BASES = Object.keys(LABEL_TEXT) as LabelBasis[]

describe('label classes (umbrella shared contract 3)', () => {
  it('every basis this layer emits is class measured_change', () => {
    expect(BASES.sort()).toEqual(['chain_schedule', 'change_log', 'measured_history', 'onchain_state'])
    for (const b of BASES) expect(BASIS_CLASS[b]).toBe('measured_change')
  })

  it('a label carries its class, basis and text together', () => {
    expect(label('chain_schedule')).toEqual({
      class: 'measured_change',
      basis: 'chain_schedule',
      text: 'beacon-chain schedule at the anchor, not a forecast',
    })
  })

  it('negative control: no exit-queue number is a stress scenario or a forecast', () => {
    const never: LabelClass[] = ['stress_scenario', 'calibrated_forecast', 'leading_signal']
    for (const b of BASES) expect(never).not.toContain(label(b).class)
    // Durations say what they are not.
    expect(LABEL_TEXT.measured_history).toMatch(/not a forecast/)
    expect(LABEL_TEXT.chain_schedule).toMatch(/not a forecast/)
  })

  it('metrics label each number by what it is', () => {
    const m = venueMetrics(def('lido-steth'), ledgerWithCoverage('lido-steth', 1_000, 2_000))
    expect(m.queueNow.label.basis).toBe('onchain_state')
    expect(m.windows.every((w) => w.label.basis === 'measured_history')).toBe(true)
    const b = venueMetrics(def('beacon-exit'), emptyLedger('beacon-exit'), { block: 2, ts: 2 })
    expect(b.windows.every((w) => w.label.basis === 'chain_schedule')).toBe(true)
  })
})

describe('venue keys (umbrella shared contract 1)', () => {
  it('a venue the venue recorder already names keeps the recorder name', () => {
    const cfg = JSON.parse(
      readFileSync(join(process.cwd(), 'tools/venue-recorder.config.json'), 'utf8'),
    ) as { venues: Array<{ name: string }> }
    const recorderNames = cfg.venues.map((v) => v.name)
    for (const v of allVenues()) {
      for (const a of v.aliases?.assets ?? []) {
        if (recorderNames.includes(a)) expect(v.key).toBe(a)
      }
    }
    expect(venueKeyForAsset('sUSDe')).toBe('sUSDe')
  })

  it('maps position assets to the queue they exit through', () => {
    expect(venueKeyForAsset('stETH')).toBe('lido-steth')
    expect(venueKeyForAsset('wstETH')).toBe('lido-steth')
    expect(venueKeyForAsset('weETH')).toBe('etherfi-weeth')
    expect(venueKeyForAsset('eETH')).toBe('etherfi-weeth')
    expect(venueKeyForAsset('rsETH')).toBe('kelp-rseth')
    expect(venueKeyForAsset('syrupUSDC')).toBe('maple-syrupusdc')
    expect(venueKeyForAsset('WSTETH')).toBe('lido-steth')
  })

  it('negative control: a token no ledger covers has no venue', () => {
    for (const s of ['sUSDS', 'sDAI', 'aEthUSDC', 'scrvUSD', 'rETH', 'ETH', '', '  ']) {
      expect(venueKeyForAsset(s)).toBeUndefined()
    }
  })

  it('each asset symbol belongs to one venue', () => {
    const all = allVenues().flatMap((v) => (v.aliases?.assets ?? []).map((a) => a.toLowerCase()))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('exit time: what the single number rests on', () => {
  const input = (over: Partial<ExitTimeInput>): ExitTimeInput => ({
    venue: 'kelp-rseth',
    anchor: { block: 1, ts: 1 },
    label: label('measured_history'),
    windowDays: 30,
    coverage: 'complete',
    requestToExit: { p50S: null, p90S: null, atLeastS: null, n: 0 },
    advertisedCooldownS: null,
    advertisedSetsWait: false,
    scheduleFloorS: null,
    queueDepth: { amount: null, count: null, symbol: 'rsETH', decimals: 18 },
    lastParamChangeTs: null,
    ...over,
  })

  it('negative control: a floor-only cooldown of 0 with nothing measured is unknown, never 0', () => {
    // Kelp's withdrawalDelayBlocks reads 0 on-chain; requests wait a median 16.6 days.
    const kelp = input({ advertisedCooldownS: 0 })
    expect(exitTime(kelp)).toBeNull()
    expect(exitTimeS(kelp)).toBeNull()
  })

  it('a floor-only cooldown never beats a measurement it is below', () => {
    const e = exitTime(
      input({
        advertisedCooldownS: 0,
        requestToExit: { p50S: 16.6 * D, p90S: null, atLeastS: 20 * D, n: 217 },
      }),
    )!
    expect(e).toMatchObject({ seconds: 20 * D, source: 'measured_at_least', atLeast: true })
    expect(e.label.basis).toBe('measured_history')
    expect(exitTime(input({ requestToExit: { p50S: 16.6 * D, p90S: null, atLeastS: 20 * D, n: 217 } }), 'p50')!)
      .toMatchObject({ seconds: 16.6 * D, source: 'measured_quantile', atLeast: false })
  })

  it('a floor-only cooldown above the measurement wins, as a lower bound read on-chain', () => {
    const e = exitTime(
      input({ advertisedCooldownS: 8 * D, requestToExit: { p50S: D, p90S: 2 * D, atLeastS: null, n: 50 } }),
    )!
    expect(e).toMatchObject({ seconds: 8 * D, source: 'advertised_cooldown', atLeast: true })
    expect(e.label.basis).toBe('onchain_state')
  })

  it('a cooldown that sets the wait stands alone when nothing was requested', () => {
    const e = exitTime(
      input({ venue: 'sUSDe', advertisedCooldownS: D, advertisedSetsWait: true }),
    )!
    expect(e).toMatchObject({ seconds: D, source: 'advertised_cooldown', atLeast: false })
    expect(e.label.basis).toBe('onchain_state')
  })

  it('a tie keeps the measured part and its label', () => {
    const e = exitTime(
      input({
        venue: 'sUSDe',
        advertisedCooldownS: D,
        advertisedSetsWait: true,
        requestToExit: { p50S: D, p90S: D, atLeastS: null, n: 964 },
      }),
    )!
    expect(e).toMatchObject({ seconds: D, source: 'measured_quantile', atLeast: false, n: 964 })
    expect(e.label.basis).toBe('measured_history')
  })

  it('the beacon queue is a chain-schedule floor (the sweep is not in it)', () => {
    const delay = 256 * 384
    const e = exitTime(
      input({
        venue: 'beacon-exit',
        label: label('chain_schedule'),
        requestToExit: { p50S: 7 * D + delay, p90S: 8 * D + delay, atLeastS: null, n: 3 },
        scheduleFloorS: 8.5 * D + delay,
      }),
    )!
    expect(e).toMatchObject({ seconds: 8.5 * D + delay, source: 'chain_schedule', atLeast: true })
    expect(e.label.basis).toBe('chain_schedule')
  })

  it('exitTimeInput keeps the metrics anchor and the venue cooldown rule', () => {
    const m = venueMetrics(def('sUSDe'), ledgerWithCoverage('sUSDe', 1_000, 2_000))
    const i = exitTimeInput(m)!
    expect(i.anchor).toEqual(m.anchor)
    expect(i.advertisedSetsWait).toBe(true)
    expect(exitTimeInput(venueMetrics(def('kelp-rseth'), ledgerWithCoverage('kelp-rseth', 1_000, 2_000)))!
      .advertisedSetsWait).toBe(false)
  })
})
