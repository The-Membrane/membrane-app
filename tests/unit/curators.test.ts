import { describe, expect, it } from 'vitest'

import {
  aumCapFigure,
  bondFigure,
  bucketFigure,
  bucketLabel,
  coverageRatio,
  eventToHistoryRow,
  formatBlockTime,
  formatCdt,
  formatUnitsFixed,
  formatWadPct,
  logsForVault,
  NO_BUCKET,
  provenanceLabel,
  rampFigure,
  rateFigure,
  slashCounts,
  slashFigure,
  sortNewestFirst,
  sumBig,
  trailingFigure,
  WAD,
  type CuratorLog,
} from '@/lib/curators/curatorLogic'

const V1 = '0x708122b25cC69A784D260dea19375555B6955726'
const V2 = '0x1111111111111111111111111111111111111111'
const REG = '0xc3e53f4d16ae77db1c982e75a937b9f60fe63690'

const log = (eventName: CuratorLog['eventName'], args: Record<string, unknown>, blockNumber: bigint, logIndex = 0): CuratorLog => ({
  eventName,
  args,
  blockNumber,
  logIndex,
})

describe('formatting', () => {
  it('formats WAD amounts exactly, grouped and truncated', () => {
    expect(formatUnitsFixed(0n)).toBe('0')
    expect(formatUnitsFixed(100_000n * WAD)).toBe('100,000')
    expect(formatUnitsFixed(1234567n * 10n ** 15n)).toBe('1,234.56')
    expect(formatUnitsFixed(1n)).toBe('0')
    expect(formatUnitsFixed(1n, 18, 18)).toBe('0.000000000000000001')
    expect(formatCdt(5n * 10n ** 17n)).toBe('0.5 CDT')
    // No float: a value past 2^53 wei stays exact.
    expect(formatUnitsFixed(123_456_789_012_345_678_901_234n * WAD)).toBe('123,456,789,012,345,678,901,234')
  })

  it('formats WAD fractions as percent', () => {
    expect(formatWadPct(5n * 10n ** 16n)).toBe('5.00%')
    expect(formatWadPct(WAD)).toBe('100.00%')
    expect(formatWadPct(1n * 10n ** 16n, 1)).toBe('1.0%')
    expect(formatWadPct(0n)).toBe('0.00%')
  })

  it('formats block time in UTC', () => {
    expect(formatBlockTime(0n)).toBe('1970-01-01 00:00 UTC')
    expect(formatBlockTime(1_790_000_000)).toBe('2026-09-21 14:13 UTC')
  })

  it('stamps provenance with chain, short registry and block', () => {
    expect(provenanceLabel(31337, REG, 133n)).toBe('local chain · CuratorRegistry 0xc3e5…3690 · block 133')
    expect(provenanceLabel(1, REG, 7)).toBe('chain 1 · CuratorRegistry 0xc3e5…3690 · block 7')
  })
})

describe('figures keep zero visible', () => {
  it('names each empty state instead of hiding it', () => {
    expect(bondFigure(0n)).toEqual({ text: 'no bond posted', empty: true })
    expect(bondFigure(2n * WAD)).toEqual({ text: '2 CDT', empty: false })
    expect(aumCapFigure(0n)).toEqual({ text: 'not listed', empty: true })
    expect(aumCapFigure(100_000n * WAD).text).toBe('100,000 CDT')
    expect(rampFigure(0n)).toEqual({ text: 'ramp at 0', empty: true })
    expect(rateFigure(0n)).toEqual({ text: 'no realized rate', empty: true })
    expect(trailingFigure(0n)).toEqual({ text: 'no payments in 30 d', empty: true })
    expect(slashFigure(0)).toEqual({ text: 'no slashes', empty: true })
    expect(slashFigure(2).text).toBe('2')
  })

  it('renders ramp as percent and day of the 90-day clock', () => {
    expect(rampFigure(WAD / 2n).text).toBe('50.0% · day 45 of 90')
    expect(rampFigure(WAD).text).toBe('100% · day 90 of 90')
    // the live anvil value right after listing
    expect(rampFigure(257201646090n).text).toBe('0.0% · day 0 of 90')
  })

  it('renders realized rate per year', () => {
    expect(rateFigure(12n * 10n ** 15n).text).toBe('1.20%/yr')
  })
})

describe('bucket labels', () => {
  it('maps index to its 0.5% band', () => {
    expect(bucketLabel(0n)).toBe('bucket 0 · 0.0–0.5%/yr')
    expect(bucketLabel(3n)).toBe('bucket 3 · 1.5–2.0%/yr')
    expect(bucketLabel(2000n)).toBe('bucket 2000 · ≥ 1,000.0%/yr')
    expect(bucketLabel(NO_BUCKET)).toBe('none')
  })

  it('says why bucket 0 is 0 when nothing was paid', () => {
    expect(bucketFigure(0n, 0n)).toEqual({ text: 'bucket 0 · 0.0–0.5%/yr · no payments', empty: true })
    expect(bucketFigure(0n, 1n).empty).toBe(false)
  })
})

describe('event → history row', () => {
  it('maps every history event', () => {
    const cases: Array<[CuratorLog, string, string]> = [
      [log('BondPosted', { vault: V1, payer: V2, amount: 10n * WAD, newBond: 10n * WAD }, 5n), 'bond posted', '+10 CDT · bond 10 CDT · payer 0x1111…1111'],
      [log('UnbondBegun', { vault: V1, newCap: 100_000n * WAD, readyTime: 0n }, 5n), 'unbond begun', 'cap to 100,000 CDT · ready 1970-01-01 00:00 UTC'],
      [log('UnbondCompleted', { vault: V1, newCap: 100_000n * WAD, released: 3n * WAD }, 5n), 'unbond completed', '3 CDT released · cap 100,000 CDT'],
      [log('PaymentRecorded', { vault: V1, amount: WAD, trailingTotal: 4n * WAD }, 5n), 'payment recorded', '1 CDT · trailing 30 d 4 CDT'],
      [log('RateDeclared', { vault: V1, rateWad: 5n * 10n ** 16n }, 5n), 'rate declared', '5.00%/yr'],
      [log('AumCredited', { vault: V1, amount: 7n * WAD, newTrackedAum: 7n * WAD }, 5n), 'AUM credited', '+7 CDT · AUM 7 CDT'],
      [log('AumDebited', { vault: V1, amount: 2n * WAD, newTrackedAum: 5n * WAD }, 5n), 'AUM debited', '−2 CDT · AUM 5 CDT'],
      [log('Slashed', { vault: V1, failedAmount: 50n * WAD, slashed: WAD, newBond: 9n * WAD }, 5n), 'slashed', '1 CDT of 50 CDT unserved · bond 9 CDT'],
      [log('SlashedOnLoss', { vault: V1, lossRatioWad: 10n ** 17n, slashed: WAD, newBond: 8n * WAD }, 5n), 'slashed on loss', '1 CDT at 10.00% loss · bond 8 CDT'],
    ]
    for (const [l, title, detail] of cases) {
      const row = eventToHistoryRow(l, 1_790_000_000n)
      expect(row.title).toBe(title)
      expect(row.detail).toBe(detail)
      expect(row.timestamp).toBe(1_790_000_000n)
      expect(row.key).toBe('5-0')
    }
  })

  it('tones slashes and credits', () => {
    expect(eventToHistoryRow(log('Slashed', { slashed: 0n, failedAmount: 0n, newBond: 0n }, 1n)).tone).toBe('slash')
    expect(eventToHistoryRow(log('BondPosted', { amount: 1n, newBond: 1n, payer: V2 }, 1n)).tone).toBe('credit')
    expect(eventToHistoryRow(log('RateDeclared', { rateWad: 0n }, 1n)).timestamp).toBeNull()
  })

  it('sorts newest first by block then log index', () => {
    const rows = [
      eventToHistoryRow(log('RateDeclared', { rateWad: 0n }, 3n, 1)),
      eventToHistoryRow(log('RateDeclared', { rateWad: 0n }, 9n, 0)),
      eventToHistoryRow(log('RateDeclared', { rateWad: 0n }, 3n, 4)),
    ]
    expect(sortNewestFirst(rows).map((r) => r.key)).toEqual(['9-0', '3-4', '3-1'])
    expect(rows[0].key).toBe('3-1') // input not mutated
  })
})

describe('aggregates', () => {
  const logs = [
    log('Slashed', { vault: V1 }, 1n),
    log('SlashedOnLoss', { vault: V1.toLowerCase() }, 2n),
    log('Slashed', { vault: V2 }, 3n),
    log('BondPosted', { vault: V1 }, 4n),
  ]

  it('counts slashes per vault, case-insensitive', () => {
    const c = slashCounts(logs)
    expect(c.get(V1.toLowerCase())).toBe(2)
    expect(c.get(V2.toLowerCase())).toBe(1)
  })

  it('filters logs by vault', () => {
    expect(logsForVault(logs, V1.toUpperCase().replace('0X', '0x'))).toHaveLength(3)
  })

  it('derives coverage from totals; null with no AUM', () => {
    expect(sumBig([1n, 2n, 3n])).toBe(6n)
    expect(coverageRatio(5n * WAD, 0n)).toBeNull()
    expect(coverageRatio(5n * WAD, 100n * WAD)).toBe(0.05)
  })
})
