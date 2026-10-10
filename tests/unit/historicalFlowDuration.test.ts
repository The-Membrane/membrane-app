import { describe, expect, it } from 'vitest'

import {
  elapsedHistoricalBracket,
  formatHistoricalDurationBracket,
  historicalDurationLabel,
  projectHistoricalFlowDuration,
  type HistoricalFlowDurationPath,
} from '@/lib/carry/historicalFlowDuration'
import {
  matchesPairedWindowDuration,
  projectPairedWindowDuration,
} from '@/lib/carry/historicalGrossFlowStress'

const hash = (block: number) => `0x${block.toString(16).padStart(64, '0')}`
const times = [1000, 1017, 1075, 1080, 1130, 1193, 1200]
const path = (
  amounts = ['1000', '400', '200', '600', '300', '800', '1000'],
): HistoricalFlowDurationPath => ({
  originBlock: 100,
  targetBlock: 106,
  sourceJoinSha256: 'a'.repeat(64),
  coverage: 'complete_end_of_block_transfer_path',
  timestampProvenance: 'verified_two_origin_direct_headers_hash_join',
  points: amounts.map((cashAfterRaw, index) => ({
    blockNumber: 100 + index,
    blockHash: hash(100 + index),
    cashAfterRaw,
  })),
  timeHeaders: times.map((timestampSec, index) => ({
    blockNumber: 100 + index,
    blockHash: hash(100 + index),
    timestampSec,
  })),
  gaps: [],
})
const replay = (source = path(), current = '1000', q = '500') =>
  projectHistoricalFlowDuration(source, current, q)

describe('conditional historical time to Q and recovery', () => {
  it('keeps multiple completed end-of-block runs paired with irregular header time', () => {
    const result = replay()
    expect(result.horizonDuration).toEqual({ lowerSeconds: 200, upperSeconds: 200 })
    expect(result.belowQRunCount).toBe(2)
    expect(result.runs[0]).toMatchObject({
      firstBelowBlock: 101,
      recoveryBlock: 103,
      timeToFirstBelow: { lowerSeconds: 17, upperSeconds: 17 },
      belowQDuration: { lowerSeconds: 63, upperSeconds: 63 },
      censoring: { left: false, right: false, gap: false },
    })
    expect(result.runs[1].belowQDuration).toEqual({ lowerSeconds: 63, upperSeconds: 63 })
    expect(historicalDurationLabel(result)).toContain('2 RUNS')
  })

  it('bounds unknown onset and recovery using neighboring verified headers without 12s/block', () => {
    const source = path()
    source.timeHeaders = source.timeHeaders.filter(
      (header) => ![101, 103].includes(header.blockNumber),
    )
    const run = replay(source).runs[0]
    expect(run.timeToFirstBelow).toEqual({ lowerSeconds: 0, upperSeconds: 75 })
    expect(run.belowQDuration).toEqual({ lowerSeconds: 0, upperSeconds: 130 })
    expect(formatHistoricalDurationBracket(run.belowQDuration)).toBe('0–3m')
  })

  it('retains a left censored start and gives recovery from the window start only', () => {
    const result = replay(path(['1000', '1000', '1200', '1600', '1600', '1600', '1600']), '400')
    expect(result.initiallyBelowQ).toBe(true)
    expect(result.runs[0]).toMatchObject({
      timeToFirstBelow: null,
      belowQDuration: null,
      censoring: { left: true, right: false },
    })
    expect(historicalDurationLabel(result)).toContain('ALREADY BELOW Q · RECOVERS BY')
  })

  it('censors an unrecovered run at the fixed block horizon', () => {
    const result = replay(path(['1000', '400', '200', '200', '300', '300', '400']))
    expect(result.runs[0]).toMatchObject({
      recoveryBlock: null,
      belowQDuration: null,
      observedBelowQLowerSeconds: 183,
      censoring: { right: true },
    })
    expect(historicalDurationLabel(result)).toContain('RECOVERY NOT SEEN · OBSERVED BELOW ≥3m')
  })

  it('treats exact Q as adequate and records a target-boundary deterioration', () => {
    const result = replay(path(['1000', '500', '500', '500', '500', '500', '499']))
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]).toMatchObject({
      firstBelowBlock: 106,
      observedBelowQLowerSeconds: 0,
      censoring: { right: true },
    })
  })

  it('does not bridge a missing cash-path interval into a completed duration', () => {
    const source = path()
    source.gaps = [{ fromBlock: 102, toBlock: 104 }]
    const result = replay(source)
    expect(result.pathGapCensored).toBe(true)
    expect(result.runs[0]).toMatchObject({
      recoveryBlock: null,
      belowQDuration: null,
      censoring: { gap: true, right: true },
    })
    expect(result.runs[1].censoring.left).toBe(true)
    expect(historicalDurationLabel(result)).toBe('DURATION · GAP CENSORED')
  })

  it('keeps durations unbounded when no verified time exists on both sides', () => {
    const source = path()
    source.timeHeaders = []
    expect(replay(source).horizonDuration).toBeNull()
    expect(replay(source).runs[0].belowQDuration).toBeNull()
  })

  it('subtracts time brackets outwards without negative elapsed bounds', () => {
    expect(
      elapsedHistoricalBracket(
        { lowerSeconds: 100, upperSeconds: 160 },
        { lowerSeconds: 150, upperSeconds: 170 },
      ),
    ).toEqual({ lowerSeconds: 0, upperSeconds: 70 })
    expect(() =>
      elapsedHistoricalBracket(
        { lowerSeconds: 100, upperSeconds: 90 },
        { lowerSeconds: 110, upperSeconds: 120 },
      ),
    ).toThrow()
    expect(() =>
      elapsedHistoricalBracket(
        { lowerSeconds: 100, upperSeconds: 120 },
        { lowerSeconds: 10, upperSeconds: 20 },
      ),
    ).toThrow()
    expect(formatHistoricalDurationBracket({ lowerSeconds: 61, upperSeconds: 119 })).toBe('1–2m')
  })

  it('recomputes amount-specific crossings when current cash or Q changes', () => {
    expect(replay(path(), '1500').belowQRunCount).toBe(0)
    expect(replay(path(), '1000', '100').belowQRunCount).toBe(0)
    expect(replay(path(), '100', '500').initiallyBelowQ).toBe(true)
  })

  it('rejects conflicting block/hash/time and malformed path ordering', () => {
    const source = path()
    source.timeHeaders[1].blockHash = hash(999)
    expect(() => replay(source)).toThrow('historical_duration_invalid_path')
    const reverse = path()
    reverse.timeHeaders[1].timestampSec = 999
    expect(() => replay(reverse)).toThrow()
    const incomplete = path()
    incomplete.points.pop()
    expect(() => replay(incomplete)).toThrow()
  })

  it('binds the whole path, source seal, cash baseline and requested Q at presentation', () => {
    const source = path()
    const window = {
      originBlock: 100,
      targetBlock: 106,
      sourceCashRaw: '1000',
      targetCashRaw: '1000',
      troughBlock: 102,
      troughCashRaw: '200',
      troughCashDeltaRaw: '-800',
      endpointCashDeltaRaw: '0',
      grossReserveInRaw: '1400',
      grossReserveOutRaw: '1400',
      durationPath: source,
    }
    const duration = projectPairedWindowDuration(window, '1000', '500', 'a'.repeat(64))!
    const translated = {
      ...window,
      duration,
      endpointCashRaw: '1000',
      endpointMarginAfterQRaw: '500',
      endpointDeficitAfterQRaw: '0',
      troughCashRawReplayed: '200',
      troughMarginAfterQRaw: '-300',
      troughDeficitAfterQRaw: '300',
      rank: 1,
      sampleCount: 1,
    }
    expect(matchesPairedWindowDuration(translated, '1000', '500', 'a'.repeat(64))).toBe(true)
    expect(matchesPairedWindowDuration(translated, '1001', '500', 'a'.repeat(64))).toBe(false)
    expect(matchesPairedWindowDuration(translated, '1000', '501', 'a'.repeat(64))).toBe(false)
    expect(matchesPairedWindowDuration(translated, '1000', '500', 'b'.repeat(64))).toBe(false)
    expect(
      matchesPairedWindowDuration(
        { ...translated, troughBlock: 101 },
        '1000',
        '500',
        'a'.repeat(64),
      ),
    ).toBe(false)
  })
})
