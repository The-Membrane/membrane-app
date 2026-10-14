import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  appendGapRun,
  decodeGapFile,
  evaluateI3,
  gapText,
  i3Headline,
  i3Points,
  leadDaysText,
  observeGap,
  recordCaveats,
  recordCredit,
  recordLines,
  thresholdText,
  type GapObservation,
  type I3Record,
} from '@/lib/curatorFeed/oracleGap'
import { datasetsRoot } from '@/lib/curatorFeed/paths'
import { parseOracleGapFile } from '@/lib/curatorFeed/store'
import recordJson from '@/lib/curatorFeed/i3Record.generated.json'
// @ts-expect-error — plain ESM builder, no type declarations
import { buildI3Record } from '../../scripts/curator-feed/build-i3-record.mjs'

const record = recordJson as unknown as I3Record
const C = record.constants
const H = 3600
const T = 1_790_000_000 - (1_790_000_000 % H) // an hour boundary

/** n hourly points from `start`, each with gap g(i). */
const hourly = (n: number, g: (i: number) => number | null, start = T): GapObservation[] =>
  Array.from({ length: n }, (_, i) => ({ ts: start + i * H + 600, gap: g(i) }))

describe('evaluateI3 — the T2 I3 rule, live', () => {
  it('reads its constants from the generated record', () => {
    expect(C.gap).toBe(0.02)
    expect(C.persistenceHours).toBe(24)
    expect(C.persistenceDailyPoints).toBe(2)
  })

  it('gap ≥ 2% counts; just below does not (boundary)', () => {
    const at = hourly(24, () => C.gap)
    const now = at[23].ts + 60
    expect(evaluateI3(at, C, now).state).toBe('fired')
    const below = hourly(24, () => C.gap - 1e-6)
    const r = evaluateI3(below, C, now)
    expect(r.state).toBe('below')
    expect(r.hoursAboveConsecutive).toBe(0)
  })

  it('23 hours is building, the 24th fires — from the 24th point, not back-dated', () => {
    const obs = hourly(24, () => 0.03)
    const r23 = evaluateI3(obs.slice(0, 23), C, obs[22].ts + 60)
    expect(r23).toMatchObject({ state: 'building', hoursAboveConsecutive: 23, persistence: 24 })
    expect(r23.firedSince).toBeUndefined()
    const r24 = evaluateI3(obs, C, obs[23].ts + 60)
    expect(r24).toMatchObject({ state: 'fired', hoursAboveConsecutive: 24, currentGap: 0.03 })
    expect(r24.firedSince).toBe(obs[23].ts)
    const r30 = evaluateI3(
      hourly(30, () => 0.03),
      C,
      T + 30 * H,
    )
    expect(r30.hoursAboveConsecutive).toBe(30)
    expect(r30.firedSince).toBe(T + 23 * H + 600)
  })

  it('an unobserved hour breaks the run (explicit null or a missing hour)', () => {
    const withNull = hourly(30, (i) => (i === 10 ? null : 0.05))
    const r = evaluateI3(withNull, C, withNull[29].ts + 60)
    expect(r).toMatchObject({ state: 'building', hoursAboveConsecutive: 19 })
    const missing = hourly(30, () => 0.05).filter((_, i) => i !== 10)
    expect(evaluateI3(missing, C, missing.at(-1)!.ts + 60).hoursAboveConsecutive).toBe(19)
    // A dip below the line also restarts it.
    const dip = hourly(30, (i) => (i === 10 ? 0.01 : 0.05))
    expect(evaluateI3(dip, C, dip[29].ts + 60).hoursAboveConsecutive).toBe(19)
  })

  it('run-time jitter: hourly runs up to 1.5 h apart stay consecutive; two in one hour count once', () => {
    // 10:58, 12:02 (64 min apart, an hour slot skipped) — consecutive by D2's 1.5× hold.
    const jitter: GapObservation[] = [
      { ts: T + 58 * 60, gap: 0.05 },
      { ts: T + 2 * H + 2 * 60, gap: 0.05 },
    ]
    expect(evaluateI3(jitter, C, T + 2 * H + 300).hoursAboveConsecutive).toBe(2)
    // 2 h apart is not.
    const gap2h: GapObservation[] = [
      { ts: T + 600, gap: 0.05 },
      { ts: T + 2 * H + 600, gap: 0.05 },
    ]
    expect(evaluateI3(gap2h, C, T + 2 * H + 900).hoursAboveConsecutive).toBe(1)
    // Two runs in one UTC hour: the newest wins, counted once.
    const twice: GapObservation[] = [
      { ts: T + 60, gap: 0.05 },
      { ts: T + 3000, gap: 0.01 },
    ]
    expect(evaluateI3(twice, C, T + 3100)).toMatchObject({ state: 'below', currentGap: 0.01 })
  })

  it('an oracle BELOW market never fires (one-sided)', () => {
    const obs = hourly(72, () => -0.3)
    const r = evaluateI3(obs, C, obs[71].ts + 60)
    expect(r).toMatchObject({ state: 'below', hoursAboveConsecutive: 0, currentGap: -0.3 })
    expect(i3Points(obs, C).some((p) => p.fired)).toBe(false)
  })

  it('stale after 3 h without a point; values kept, as of the last point', () => {
    const obs = hourly(24, () => 0.05)
    const last = obs[23].ts
    expect(evaluateI3(obs, C, last + 3 * H).state).toBe('fired')
    const r = evaluateI3(obs, C, last + 3 * H + 1)
    expect(r).toMatchObject({ state: 'stale', hoursAboveConsecutive: 24, lastObservedTs: last })
    expect(r.firedSince).toBe(last)
  })

  it('unobserved: nothing measured, or the newest point has no answer', () => {
    expect(evaluateI3([], C, T)).toMatchObject({ state: 'unobserved', hoursAboveConsecutive: 0 })
    expect(
      evaluateI3(
        hourly(3, () => null),
        C,
        T + 3 * H,
      ).state,
    ).toBe('unobserved')
    const tail = hourly(5, (i) => (i === 4 ? null : 0.05))
    const r = evaluateI3(tail, C, tail[4].ts + 60)
    expect(r).toMatchObject({ state: 'unobserved', hoursAboveConsecutive: 0 })
    expect(r.currentGap).toBeUndefined()
    expect(r.lastObservedTs).toBe(tail[3].ts)
  })

  it('daily cadence fires on the 2nd consecutive point (T2 D3/D8)', () => {
    const d = (i: number, gap: number | null) => ({ ts: T + i * 86_400, gap })
    expect(evaluateI3([d(0, 0.03)], C, T, 'daily').state).toBe('building')
    expect(evaluateI3([d(0, 0.03), d(1, 0.03)], C, T + 86_400, 'daily').state).toBe('fired')
    // Two days apart (> 1.5 d) is not consecutive.
    expect(evaluateI3([d(0, 0.03), d(2, 0.03)], C, T + 2 * 86_400, 'daily').state).toBe('building')
  })
})

// ── replay of T2's own I3 series ───────────────────────────────────────────────

const T2 = join(datasetsRoot(), 'validation', 't2')
const csv = (name: string) => {
  const [head, ...rows] = readFileSync(join(T2, name), 'utf8').trim().split(/\r?\n/)
  const cols = head.split(',')
  const at = (r: string[], c: string) => r[cols.indexOf(c)]
  return rows.map((line) => {
    const r = line.split(',')
    return {
      t: at(r, 't_utc'),
      ts: Number(at(r, 'ts')),
      gap: at(r, 'observed') === '1' ? Number(at(r, 'gap')) : null,
      fired: at(r, 'fired') === '1',
    }
  })
}
const rowOf = (asset: string) => record.incidents.find((x) => x.asset === asset)!

describe.skipIf(!existsSync(join(T2, 'AZND-I3.csv')))('replay of validation/t2 I3 series', () => {
  for (const [asset, cadence] of [
    ['AZND', 'daily'],
    ['msY', 'daily'],
    ['sdeUSD', 'hourly'],
  ] as const) {
    it(`${asset} (${cadence}): every point's fired flag and the first fire match T2`, () => {
      const rows = csv(`${asset}-I3.csv`)
      const pts = i3Points(rows, C, cadence)
      expect(pts.length).toBe(rows.length)
      const mismatch = pts.filter((p, i) => p.fired !== rows[i].fired).map((p) => p.ts)
      expect(mismatch).toEqual([])
      const first = pts.find((p) => p.fired)
      const iso = first ? new Date(first.ts * 1000).toISOString().slice(0, 16) + 'Z' : null
      expect(iso).toBe(rowOf(asset).firstFire)
    })
  }
})

// ── one observation ────────────────────────────────────────────────────────────

describe('observeGap', () => {
  const ts = 1_790_000_000
  const usdc = { price: 0.9999, timestamp: ts - 300, confidence: 0.99, decimals: 6 }
  it('price()/1e36 × 10^(dc − dl) loan per collateral × the loan’s DefiLlama USD price', () => {
    // AZND-like: 18-dec collateral, 6-dec USDC loan, price() = 1e24 → 1 USDC per token.
    const { obs, reason } = observeGap({
      ts,
      block: 1,
      price: (10n ** 24n).toString(),
      collateralDecimals: 18,
      loanDecimals: 6,
      collateral: { price: 0.97732659, timestamp: ts - 600, confidence: 0.9 },
      loan: usdc,
    })
    expect(reason).toBeUndefined()
    expect(obs.oracleUsd).toBe(0.9999)
    expect(obs.marketUsd).toBe(0.977327)
    expect(obs.gap).toBeCloseTo(0.9999 / 0.97732659 - 1, 6)
    expect(obs.marketConfidence).toBe(0.9)
    expect(obs.marketSource).toBe('defillama')
  })
  it('converts a non-USD loan token with its own DefiLlama price (no $1 assumption)', () => {
    // wstETH/WETH: 1.2 WETH per wstETH, WETH $3,000 → oracle $3,600 vs market $3,500.
    const { obs } = observeGap({
      ts,
      block: 1,
      price: (12n * 10n ** 35n).toString(),
      collateralDecimals: 18,
      loanDecimals: 18,
      collateral: { price: 3500, timestamp: ts },
      loan: { price: 3000, timestamp: ts },
    })
    expect(obs.oracleUsd).toBe(3600)
    expect(obs.gap).toBeCloseTo(3600 / 3500 - 1, 6)
  })
  it('a revert, a missing or old price is an unobserved point, never a 0', () => {
    const base = {
      ts,
      block: 1,
      price: '1' + '0'.repeat(24),
      collateralDecimals: 18,
      loanDecimals: 6,
      loan: usdc,
      collateral: { price: 1, timestamp: ts },
    }
    const reason = (o: Partial<typeof base> & Record<string, unknown>) =>
      observeGap({ ...base, ...o } as Parameters<typeof observeGap>[0])
    expect(reason({ price: null as never })).toMatchObject({
      reason: 'oracle-reverts',
      obs: { gap: null },
    })
    expect(reason({ price: undefined }).reason).toBe('oracle-unread')
    expect(reason({ collateral: undefined }).reason).toBe('no-market-price')
    expect(reason({ loan: undefined }).reason).toBe('no-loan-price')
    expect(reason({ collateral: { price: 1, timestamp: ts - 6 * H } }).reason).toBe(
      'market-price-old',
    )
    expect(reason({ collateral: { price: 1, timestamp: ts - 6 * H + 1 } }).reason).toBeUndefined()
    expect(reason({ collateralDecimals: undefined }).reason).toBe('no-decimals')
    expect(reason({ price: '0' }).reason).toBe('zero-price')
  })
})

// ── the rolling store ──────────────────────────────────────────────────────────

describe('appendGapRun / decodeGapFile', () => {
  const o = (gap: number | null): GapObservation =>
    gap === null ? { ts: 0, gap } : { ts: 0, gap, oracleUsd: 1, marketUsd: 1 / (1 + gap) }
  it('stores observed points only; a missing row decodes as an unobserved point', () => {
    let f = appendGapRun(null, { ts: T, block: 1 }, [
      ['0xA', o(0.03)],
      ['0xb', o(null)],
    ]).file
    f = appendGapRun(f, { ts: T + H, block: 2 }, [['0xb', o(0.01)]]).file
    f = parseOracleGapFile(JSON.parse(JSON.stringify(f)))
    expect(f.runs).toEqual([
      [T, 1],
      [T + H, 2],
    ])
    expect(f.markets).toEqual(['0xa', '0xb'])
    const { byMarket } = decodeGapFile(f)
    expect(byMarket.get('0xa')!.map((x) => x.gap)).toEqual([0.03, null])
    expect(byMarket.get('0xb')!.map((x) => [x.ts, x.block, x.gap])).toEqual([[T + H, 2, 0.01]])
  })
  it('dedupes within one UTC hour (newest wins), ignores older and empty runs', () => {
    const a = appendGapRun(null, { ts: T + 60, block: 1 }, [['0xa', o(0.03)]])
    const b = appendGapRun(a.file, { ts: T + 3000, block: 5 }, [['0xa', o(0.01)]])
    expect(b.result).toBe('replaced')
    expect(b.file.runs).toEqual([[T + 3000, 5]])
    expect(b.file.rows[0][5]).toBe(0.01)
    expect(appendGapRun(b.file, { ts: T, block: 0 }, [['0xa', o(0.5)]]).result).toBe(
      'skipped-older',
    )
    const empty = appendGapRun(b.file, { ts: T + 2 * H, block: 9 }, [['0xa', o(null)]])
    expect(empty.result).toBe('skipped-empty')
    expect(empty.file.runs.length).toBe(1)
  })
  it('keeps the last 7 days', () => {
    let f = null as ReturnType<typeof appendGapRun>['file'] | null
    for (let i = 0; i < 24 * 8; i++)
      f = appendGapRun(f, { ts: T + i * H, block: i }, [['0xa', o(0.01)]]).file
    expect(f!.runs.length).toBe(24 * 7)
    expect(f!.runs[0][0]).toBe(T + 24 * H)
    expect(f!.keepDays).toBe(7)
  })
})

// ── the generated record ───────────────────────────────────────────────────────

describe('i3Record.generated.json', () => {
  const day = (iso: string) => Date.parse(iso.replace(/Z$/, ':00Z')) / 1000 / 86_400
  it('is internally consistent', () => {
    expect(record.indicator).toBe('I3')
    expect(record.source.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(record.kind).toContain(`n = ${record.incidentCount} incidents`)
    expect(new Set(record.incidents.map((x) => x.incident)).size).toBe(record.incidentCount)
    for (const x of record.incidents) {
      expect(x.calmFireStarts.length, x.asset).toBe(x.calmEpisodeStarts)
      if (x.calmDays >= C.minCalmDays)
        expect(x.falseFireRatePerQuarter, x.asset).toBeCloseTo(
          x.calmEpisodeStarts / (x.calmDays / C.quarterDays),
          3,
        )
      if (x.leadDays !== null) {
        expect(x.firstFire, x.asset).not.toBeNull()
        expect(day(x.T0) - day(x.firstFire!), x.asset).toBeCloseTo(x.leadDays, 2)
        expect(x.warned9d, x.asset).toBe(x.leadDays >= C.warnDays)
        expect(x.status, x.asset).toMatch(/^(warned|fired)/)
      } else {
        expect(x.warned9d).toBe(false)
        expect(x.status).toBe('did not fire')
      }
    }
    const warned = new Set(record.incidents.filter((x) => x.warned9d).map((x) => x.incident))
    expect(record.passLine.incidentsWarned).toBe(warned.size)
    expect(record.passLine.warnedIncidents).toEqual([...warned])
    // The pass line needs ≥ 2 warned incidents; I3 has fewer, so it cannot carry a PASS.
    if (warned.size < 2) expect(record.passLine.verdict).toBe('FAIL')
  })

  it.skipIf(!existsSync(join(T2, 'results.json')))(
    'regenerates byte-identically from the datasets repo (minus generatedAt)',
    () => {
      const { generatedAt, ...body } = recordJson as Record<string, unknown>
      expect(typeof generatedAt).toBe('string')
      expect(buildI3Record(datasetsRoot())).toEqual(body)
    },
  )
})

describe('copy built from the record and constants', () => {
  it('rounds lead days: ≥ 10 → whole, else one decimal', () => {
    expect(leadDaysText(49.054)).toBe('49')
    expect(leadDaysText(6.658)).toBe('6.7')
    expect(leadDaysText(10)).toBe('10')
    expect(leadDaysText(9.96)).toBe('10.0')
  })
  it('states the finding in ink, from the constants', () => {
    expect(thresholdText(C)).toBe('2%')
    expect(i3Headline(0, C)).toBe('No oracle ≥ 2% above market for 24 h')
    expect(i3Headline(1, C)).toBe('1 market: oracle ≥ 2% above market for 24 h')
    expect(i3Headline(2, { gap: 0.03, persistenceHours: 12 })).toBe(
      '2 markets: oracle ≥ 3% above market for 12 h',
    )
    expect(gapText(0.0231)).toBe('+2.31%')
    expect(gapText(-0.004)).toBe('−0.40%')
  })
  it('composes the record rows and caveats from the record only', () => {
    const lines = recordLines(record)
    const text = lines.map((l) => `${l.label} | ${l.date} | ${l.value}`)
    expect(text).toEqual([
      'warned ≥ 9 days ahead |  | 1 of 3 incidents',
      'sdeUSD write-off | 2025-11-11 | fired 6.7 days before (under 9 days) · 0 false alarms in 216 calm days',
      'AZND write-off | 2026-07-31 | fired 49 days before · 0 false alarms in 74 calm days',
      'msY write-off | 2026-07-31 | did not fire',
      'Oct 10 crash | 2025-10-10 | did not fire · ETH, BTC, stETH, USDe',
    ])
    expect(recordCaveats(record)).toBe(
      'Retrospective, n = 3 incidents (Q25 T2: FAIL overall). stETH: 2 false alarms in 2022. ' +
        "AZND's oracle was fixed at 1 USDC.",
    )
    expect(recordCredit(record)).toBe(
      `membrane-datasets validation/t2 · ${record.source.commit!.slice(0, 7)}`,
    )
    // Numbers follow the record, not the code.
    const moved = structuredClone(record)
    moved.incidents[1].leadDays = 12.4
    moved.incidents[5].calmEpisodeStarts = 3
    moved.incidents[5].calmFireStarts.push('2023-01-01T00:00Z')
    expect(recordLines(moved)[2].value).toContain('fired 12 days before')
    expect(recordCaveats(moved)).toContain('stETH: 3 false alarms in 2022, 2023.')
  })
})
