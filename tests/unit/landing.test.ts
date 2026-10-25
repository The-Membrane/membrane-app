import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { demoBorrowerDetection, demoBorrowerPosition, CURE_WINDOW_SECONDS, DEMO_BORROWER_ADDRESS, DEMO_BORROWER_ROW, MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim'
import { HEADLINES, hashToHeadline, resolveHeadline, SUBHEAD, RUN_LABEL } from '@/lib/landing/headline'
import { LANDING_EVENT_NAMES, setLandingSink, track, type LandingEvent } from '@/lib/landing/instrumentation'
import { buildManualPosition, decodeManual, encodeManual, morphoBonus, morphoLltvs, aaveLine, validateManual } from '@/lib/landing/manualPosition'
import { OBJECTIONS, summariseCensus } from '@/lib/landing/objections'
import { runReplay } from '@/lib/landing/replay'
import { classifyVisit, readVisit, sameKey, writeVisit, RETURN_KEY, visitDelta, type VisitRecord } from '@/lib/landing/returnVisit'
import { SCENARIOS, scenarioById } from '@/lib/landing/scenarios'
import { depthRegistry, exitCostShare, skewLines, skewNote } from '@/lib/landing/sizeSkew'
import { armedWindows, closedTotals, eventMarks, verdictOf, verdictSentence } from '@/lib/landing/verdict'
import { censusRowFor } from '@/lib/landing/census'
import { delayReadings, engineSpot, forwardReach, historyReadings, fallToPct, shown } from '@/lib/landing/forecastLayer'
import { PROSE } from '@/lib/landing/prose'
import { decodeCompactSeries, PROBABILITY_CLASSES } from '@/lib/forecast'

const DATA = path.resolve(__dirname, '../../public/data/oct10-2025')
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))
const series = read('prices-1m.json')
const manifest = read('manifest.json')
const protocols = read('protocols.json')
const evidence = read('evidence.json')

const demoRun = () =>
  runReplay(demoBorrowerPosition(), demoBorrowerDetection(), { series, manifest, measured: protocols.measuredLiquidations })

/** The owner's copy ruling, as a test: none of these may appear in user-facing copy. */
const BANNED = /\b(safe|odds|protected|survives?|kept|held|guaranteed?)\b|0% borrow|can.t be liquidated/i

describe('headline test', () => {
  it('pins crawlers to the default and honours ?v=', () => {
    expect(resolveHeadline({ userAgent: 'Googlebot/2.1', randomId: 'x' })).toBe('default')
    expect(resolveHeadline({ query: 'b', randomId: 'x' })).toBe('b')
    expect(resolveHeadline({ query: ['c'], randomId: 'x' })).toBe('c')
    expect(resolveHeadline({})).toBe('default')
  })
  it('splits fresh readers three ways, reproducibly', () => {
    const seen = new Set(Array.from({ length: 60 }, (_, i) => hashToHeadline(`id-${i}`)))
    expect(seen).toEqual(new Set(['a', 'b', 'c']))
    expect(hashToHeadline('same')).toBe(hashToHeadline('same'))
  })
  it('every headline, the subhead, the button and the prose obey the copy ruling', () => {
    for (const h of Object.values(HEADLINES)) expect(h.headline).not.toMatch(BANNED)
    expect(SUBHEAD).not.toMatch(BANNED)
    expect(RUN_LABEL).not.toMatch(/forecast/i)
    for (const p of PROSE) expect(p).not.toMatch(BANNED)
    for (const o of OBJECTIONS) for (const f of o.facts) expect(f.text).not.toMatch(/\b(safe|odds|guaranteed?)\b/i)
  })
  // Owner ruling 2026-10-25: the owner's W.O.W. headlines run longer than the copy
  // budget's 12-word H1. The coordinator set 20 for this set; the owner's draft 2 counts
  // 21 (numbers count as words, copy-budget rule), so the limit is 21 and is reported.
  it('fits the copy budget: H1 ≤ 21 words (owner set), subhead ≤ 20', () => {
    const words = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
    for (const h of Object.values(HEADLINES)) expect(words(h.headline)).toBeLessThanOrEqual(21)
    expect(HEADLINES.default.headline).toBe(HEADLINES.a.headline)
    expect(words(SUBHEAD)).toBeLessThanOrEqual(20)
  })
  it('prose is 100-300 words (SEO R10)', () => {
    const words = PROSE.join(' ').split(/\s+/).length
    expect(words).toBeGreaterThanOrEqual(100)
    expect(words).toBeLessThanOrEqual(300)
  })
})

describe('verdict on the demo wallet', () => {
  const cmp = demoRun()
  it('matches the engine totals and uses the ruled wording', () => {
    const t = closedTotals(cmp)
    expect(t.venueClosedUsd).toBeGreaterThan(0)
    expect(t.lessUsd).toBeCloseTo(t.venueClosedUsd - t.membraneClosedUsd, 6)
    const v = verdictSentence(cmp, 'this')
    expect(v).toMatch(/^Membrane would have closed \$[\d,]+ (less|more) of this position’s debt \(simulator\)\.$/)
    expect(v).not.toMatch(BANNED)
    expect(verdictOf(cmp, 'your').detail).toMatch(/modelled at the median repay size/)
  })
  it('uses the census row for Aave on the demo (review D1)', () => {
    const row = DEMO_BORROWER_ROW
    const measured = runReplay(demoBorrowerPosition(), demoBorrowerDetection(), { series, manifest, measured: protocols.measuredLiquidations }, {
      user: row.user, events: row.events, t0Index: row.t0Index, aaveClosedUsd: row.aaveClosedUsd,
      membraneClosedUsd: row.membraneClosedUsd, outcome: row.outcome, collSymbol: row.collSymbol, debtSymbol: row.debtSymbol,
    })
    const v = verdictOf(measured, 'this', row)
    const gap = Math.round(row.aaveClosedUsd - row.membraneClosedUsd).toLocaleString('en-US')
    expect(v.headline).toBe(`Membrane would have closed $${gap} less of this position’s debt (simulator).`)
    expect(v.detail).toContain(`Aave V3 closed $${Math.round(row.aaveClosedUsd).toLocaleString('en-US')} in ${row.events} liquidations (measured`)
    expect(v.detail).toContain(`Membrane would have closed $${Math.round(row.membraneClosedUsd).toLocaleString('en-US')} (simulator`)
    // The chart's Aave events are the measured close, one mark at the first event.
    expect(measured.source.events).toHaveLength(1)
    expect(measured.source.events[0].minute).toBe(row.t0Index)
    expect(measured.source.events[0].repaidUsd).toBeCloseTo(row.aaveClosedUsd, 2)
    // The census lookup finds the same row in evidence.json.
    expect(censusRowFor(evidence.cohort, DEMO_BORROWER_ADDRESS)?.aaveClosedUsd).toBe(row.aaveClosedUsd)
    expect(censusRowFor(evidence.cohort, '0x' + '1'.repeat(40))).toBeNull()
  })
  it('marks every engine event with a glyph', () => {
    const marks = eventMarks(cmp)
    expect(marks.filter((m) => m.engine === 'venue').length).toBe(cmp.source.events.filter((e) => e.kind === 'liquidation').length)
    expect(marks.filter((m) => m.engine === 'membrane').length).toBe(cmp.membrane.events.length)
    expect(marks.every((m) => m.glyph.length > 0)).toBe(true)
  })
  it('finds the armed window and ends it at the next Membrane event', () => {
    const w = armedWindows(cmp, cmp.membrane.equitySeries.length, CURE_WINDOW_SECONDS / series.stepSeconds)
    const breach = cmp.membrane.events.find((e) => e.kind === 'breach')!
    expect(w[0].start).toBe(breach.minute)
    expect(w[0].end).toBeGreaterThan(w[0].start)
    expect(w[0].end - w[0].start).toBeLessThanOrEqual(CURE_WINDOW_SECONDS / series.stepSeconds)
  })
  it('says "neither" when nothing closes', () => {
    const quiet = { ...cmp, source: { ...cmp.source, events: [] }, membrane: { ...cmp.membrane, events: [] } }
    expect(verdictSentence(quiet, 'your')).toMatch(/^Neither engine would have closed any of your position/)
  })
})

describe('size skew', () => {
  const reg = depthRegistry(protocols.usdeExitLiquidity)
  it('has depth only where the dataset measured it', () => {
    expect(Object.keys(reg)).toEqual(['USDe'])
    expect(exitCostShare(reg.USDe, 0)).toBe(0)
    expect(exitCostShare(reg.USDe, reg.USDe.clipTokens * 2)).toBeNull()
    const full = exitCostShare(reg.USDe, reg.USDe.clipTokens)!
    expect(full).toBeCloseTo(1 - reg.USDe.clipAvgPrice / reg.USDe.marginalPrice, 9)
  })
  it('draws no line for WETH and says why', () => {
    const lines = skewLines(demoRun(), reg)
    expect(lines.map((l) => l.multiple)).toEqual([10, 100])
    expect(lines.every((l) => !l.drawable)).toBe(true)
    expect(skewNote(lines[0], reg)).toMatch(/no exit-depth series for WETH/)
  })
  it('draws a USDe line inside the measured clip and refuses past the pool', () => {
    const built = buildManualPosition(
      { venue: 'morpho-blue', collateral: 'USDe', collateralUsd: 50_000, debtUsd: 30_000, liquidationLtv: 0.9 },
      protocols,
      1,
    )
    if (!('position' in built)) throw new Error('manual build failed')
    const cmp = runReplay(built.position, null, { series, manifest, measured: protocols.measuredLiquidations })
    const [ten, hundred] = skewLines(cmp, reg)
    expect(ten.drawable).toBe(true)
    expect(ten.membrane.length).toBe(cmp.membrane.equitySeries.length)
    expect(ten.endCostPer1xUsd!).toBeGreaterThan(0)
    expect(hundred.drawable).toBe(false)
    expect(hundred.legs[0].status).toBe('beyond-pool')
  })
})

describe('return visits', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  const rec: VisitRecord = { address: '0x' + 'a'.repeat(40), at: 1, debtUsd: 100, collateralUsd: 200, ltv: 0.5, lessUsd: 10, scenarioId: 'oct10-2025', positionKey: 'aave-v3:' }
  it('round-trips and rejects junk', () => {
    const s = mem()
    expect(readVisit(s)).toBeNull()
    writeVisit(rec, s)
    expect(readVisit(s)).toEqual(rec)
    s.setItem(RETURN_KEY, '{bad')
    expect(readVisit(s)).toBeNull()
    s.setItem(RETURN_KEY, JSON.stringify({ ...rec, address: 'nope' }))
    expect(readVisit(s)).toBeNull()
  })
  it('survives a throwing storage', () => {
    const boom = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') } }
    expect(readVisit(boom)).toBeNull()
    expect(() => writeVisit(rec, boom)).not.toThrow()
  })
  it('classifies first / returning / changed', () => {
    const cur = { address: rec.address, positionKey: 'aave-v3:', debtUsd: 100, collateralUsd: 200, ltv: 0.5, lessUsd: 10 }
    expect(classifyVisit(null, cur)).toBe('first')
    expect(classifyVisit(rec, cur)).toBe('returning')
    expect(classifyVisit(rec, { ...cur, debtUsd: 111 })).toBe('changed')
    expect(classifyVisit(rec, { ...cur, ltv: 0.52 })).toBe('changed')
    expect(classifyVisit(rec, { ...cur, address: '0x' + 'b'.repeat(40) })).toBe('first')
    expect(visitDelta(rec, { ...cur, debtUsd: 150 }, 11).debtUsd).toBe(50)
    // Another position on the same wallet: no change is claimed, no delta is taken.
    expect(classifyVisit(rec, { ...cur, positionKey: 'morpho-blue:0xabc', debtUsd: 999 })).toBe('returning')
    expect(sameKey(rec, { ...cur, positionKey: 'morpho-blue:0xabc' })).toBe(false)
    expect(sameKey({ ...rec, positionKey: undefined }, cur)).toBe(false)
  })
})

describe('manual position', () => {
  it('reads the venue parameters, never assumes them', () => {
    expect(aaveLine(protocols, 'WETH')).toBeCloseTo(protocols.aaveV3.reserves.WETH.liquidationThresholdPct / 100, 9)
    const l = morphoLltvs(protocols, 'wstETH')
    expect(l.length).toBeGreaterThan(0)
    expect(morphoBonus(protocols, 0.86)).toBeCloseTo(1 / (1 - 0.3 * 0.14) - 1, 9)
  })
  it('validates and round-trips through the URL', () => {
    const i = { venue: 'morpho-blue' as const, collateral: 'wstETH' as const, collateralUsd: 1000, debtUsd: 500, liquidationLtv: 0.86 }
    expect(validateManual(i)).toBeNull()
    expect(decodeManual(encodeManual(i))).toEqual(i)
    expect(validateManual({ ...i, debtUsd: 900 })).toBe('underwater')
    expect(decodeManual('evil:WETH:1:1:0.5')).toBeNull()
    expect(buildManualPosition(i, protocols, null)).toEqual({ error: 'price' })
    // No Aave reserve, no silent 0% bonus.
    expect(aaveLine(protocols, 'USDe')).toBeNull()
    expect(buildManualPosition({ ...i, venue: 'aave-v3', collateral: 'USDe' }, protocols, 1)).toEqual({ error: 'reserve' })
  })
})

describe('census card (delay postpones the loss)', () => {
  const c = summariseCensus(evidence)
  it('shows recovered AND not-recovered; one path that agrees with the builder tally (D5)', () => {
    const o = evidence.meta.cureModel.outcomes
    expect(c.recovered).toBe(o['cured-then-held'])
    expect(c.expired).toBe(o['sold-at-expiry'])
    expect(c.brokeBand).toBe(o['sold-at-band'])
    expect(c.gridEnd).toBe(o['sold-at-grid-end'])
    // The builder's t0 count mixes priced and unpriced rows; the card splits it.
    expect(c.atT0 + c.unpricedAtT0).toBe(o['sold-at-t0'])
    expect(c.walked).toBe(c.recovered + c.expired + c.brokeBand + c.atT0 + c.gridEnd)
    expect(c.walked).toBe(evidence.debt.priced.accounts)
    expect(c.recovered).toBeGreaterThan(0)
    expect(c.expired + c.brokeBand).toBeGreaterThan(0)
    expect(c.recoveredExample?.outcome).toBe('cured-then-held')
    expect(c.failedExample?.outcome).toBe('sold-at-expiry')
  })
  it('quotes the minutes to the FIRST cure (D4)', () => {
    const row = evidence.cohort.find((r: { user: string; outcome: string }) => r.user === c.recoveredExample!.user && r.outcome === 'cured-then-held')
    expect(c.recoveredExample!.minutesToFirstCure).toBe(row.minutesToFirstCure)
    expect(c.recoveredExample!.user.startsWith('0xa740')).toBe(true)
    expect(c.recoveredExample!.minutesToFirstCure).toBe(3)
  })
  it('names bond coverage and audits as source pending, with no number', () => {
    for (const id of ['spread', 'trust']) {
      const o = OBJECTIONS.find((x) => x.id === id)!
      expect(o.pending?.length).toBeGreaterThan(0)
      for (const p of o.pending!) expect(p).toMatch(/source pending|none yet/)
    }
  })
})

describe('scenarios', () => {
  it('only Oct 10 is runnable; the others name their data pull', () => {
    expect(SCENARIOS.filter((s) => s.status === 'live').map((s) => s.id)).toEqual(['oct10-2025'])
    for (const s of SCENARIOS.filter((x) => x.status === 'coming')) expect(s.needs).toBeTruthy()
    expect(scenarioById('aug05-2024').id).toBe('oct10-2025')
  })
})

describe('instrumentation', () => {
  it('is a no-op by default and never throws', () => {
    expect(() => track({ name: 'return_visit', headline: 'a', state: 'returning', address: '0x', sinceMs: 1 })).not.toThrow()
    const got: LandingEvent[] = []
    setLandingSink((e) => got.push(e))
    track({ name: 'deploy_click', headline: 'b', door: 'migrate', isDemo: true, protocol: 'aave-v3', debtUsd: 1 })
    setLandingSink(() => { throw new Error('sink down') })
    expect(() => track({ name: 'wallet_run', headline: 'c', source: 'paste', scenarioId: 'oct10-2025', protocols: [] })).not.toThrow()
    setLandingSink(null)
    expect(got.map((e) => e.name)).toEqual(['deploy_click'])
    expect(LANDING_EVENT_NAMES).toEqual(['wallet_run', 'return_visit', 'deploy_click', 'live_position'])
  })
})

const eth = decodeCompactSeries(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/forecast/ETHUSDT-1h.json'), 'utf8')))

describe('forecast layer gating', () => {
  it('renders only what a result allows', () => {
    expect(shown(null)).toEqual({ kind: 'none', reason: null })
    expect(shown({ p: 0.12, cell: null, display: 'none', label: '', reason: 'gated', originTs: 0, spot: null })).toEqual({ kind: 'none', reason: 'gated' })
    const count = shown({
      p: 0.5, cell: null, display: 'count', label: 'history count', reason: null, originTs: 0, spot: null,
      count: { k: 3, n: 99, since: '2017', horizonH: 72, levelPct: -30, firstTs: 0, lastTs: 0, seriesId: 'ETHUSDT' },
    })
    expect(count.kind).toBe('count')
    if (count.kind === 'count') {
      expect(count.text).toBe('fell 30% within 3d 3 times since 2017')
      expect(count.text).not.toMatch(/%.*of|odds/)
    }
  })
  it('is pending with no series, and reads the engine with one', () => {
    const cmp = demoRun()
    const w = armedWindows(cmp, cmp.membrane.equitySeries.length, CURE_WINDOW_SECONDS / series.stepSeconds)
    const priceAt = (m: number) => {
      const col = series.columns.ethOracle as (number | null)[]
      for (let k = m; k >= 0; k--) if (col[k] !== null) return col[k]
      return null
    }
    expect(delayReadings(cmp, w, series.startTs, series.stepSeconds, null, priceAt).status).toBe('pending')
    expect(forwardReach(cmp.position, 1_760_000_000, null).status).toBe('pending')
    const d = delayReadings(cmp, w, series.startTs, series.stepSeconds, eth, priceAt)
    expect(d.status).toBe('ready')
    if (d.status === 'ready') {
      for (const step of d.value)
        for (const row of step.reach?.rows ?? []) {
          const sh = shown(row.result)
          if (sh.kind === "probability") expect(PROBABILITY_CLASSES.has(row.result!.cell!.class)).toBe(true)
        }
    }
    expect(historyReadings([], () => null).status).toBe('pending')
    expect(fallToPct(0.8, 0.8)).toBe(0)
  })
  it('measures the delay reading from the engine’s spot at 21:14 Oct 10 (D2)', () => {
    const cmp = demoRun()
    const w = armedWindows(cmp, cmp.membrane.equitySeries.length, CURE_WINDOW_SECONDS / series.stepSeconds)
    const col = series.columns.ethOracle as (number | null)[]
    const priceAt = (m: number) => { for (let k = m; k >= 0; k--) if (col[k] !== null) return col[k]; return null }
    const d = delayReadings(cmp, w, series.startTs, series.stepSeconds, eth, priceAt)
    if (d.status !== 'ready') throw new Error('expected readings')
    const step = d.value[0]
    expect(new Date(step.ts * 1000).toISOString().slice(11, 16)).toBe('21:14')
    const spot = engineSpot('WETH', step.ts, eth)!
    expect(step.spot).toBe(spot)
    const breach = cmp.membrane.events.find((e) => e.kind === 'breach')!
    const breakPrice = (priceAt(step.minute)! * cmp.membrane.ltvSeries[step.minute]!) / (breach.line * (1 + MAX_THRESHOLD_TO_DELAY))
    expect(step.breakPrice).toBeCloseTo(breakPrice, 6)
    if (step.alreadyPast) {
      expect(step.reach).toBeNull()
      expect(breakPrice / spot - 1).toBeGreaterThanOrEqual(0)
    } else {
      expect(step.toBreakPct!).toBeCloseTo((breakPrice / spot - 1) * 100, 9)
      expect(step.reach!.lineDistancePct).toBeCloseTo(step.toBreakPct!, 9)
    }
  })
  it('reads "from today" off amounts at the latest spot; the demo is through its line (D3)', () => {
    const p = demoBorrowerPosition()
    const last = eth.startTs + eth.close.length * 3600
    const r = forwardReach(p, last, eth)
    if (r.status !== 'ready') throw new Error('expected a reach')
    const spot = engineSpot('WETH', last, eth)!
    const linePrice = p.totalDebtUsd / p.liquidationLtv / p.collateral[0].amount
    expect(r.value.linePrice).toBeCloseTo(linePrice, 6)
    expect(r.value.distancePct).toBeCloseTo((linePrice / spot - 1) * 100, 9)
    expect(linePrice).toBeGreaterThan(spot)
    expect(r.value.reach.throughLine).toBe(true)
    expect(r.value.reach.rows).toHaveLength(0)
    expect(fallToPct(0.4, 0.8)).toBeCloseTo(-50, 9)
  })
})

describe('share card and doors seam', () => {
  it('parses only a well-formed replay summary', async () => {
    const { replayCardSummary, parseOgKind } = await import('@/lib/share/permalink')
    expect(parseOgKind('replay')).toBe('replay')
    const ok = { address: '0x' + 'a'.repeat(40), isDemo: true, label: 'Aave V3', venueClosedUsd: 10, membraneClosedUsd: 5, verdict: 'Membrane would have closed $5 less of this position (simulator).' }
    expect(replayCardSummary(ok)?.venueClosedUsd).toBe(10)
    expect(replayCardSummary({ ...ok, verdict: 'Membrane kept $5' })).toBeNull()
    expect(replayCardSummary({ ...ok, venueClosedUsd: -1 })).toBeNull()
    expect(replayCardSummary({ ...ok, error: 'x' })).toBeNull()
  })
  it('prefills the intent from the replayed position', async () => {
    const { intentFrom } = await import('@/lib/landing/doors')
    const p = demoBorrowerPosition()
    const i = intentFrom(p, { source: 'demo', membraneLine: 0.8, scenarioId: 'oct10-2025' })
    expect(i.collateral[0].amount).toBe(p.collateral[0].amount)
    expect(i.debt[0].valueUsd).toBe(p.debt[0].valueUsd)
    expect(i.venueLine).toBe(p.liquidationLtv)
    expect(i.position).toBe(p)
  })
})

describe('doors (owner ruling 2026-10-25)', () => {
  it('shows Migrate only for a real wallet with a borrow', async () => {
    const { doorSet } = await import('@/lib/landing/doors')
    const labels = (m: 'demo' | 'address' | 'manual', b: boolean) => doorSet(m, b).map((d) => `${d.action}:${d.label}${d.primary ? '*' : ''}`)
    expect(labels('demo', true)).toEqual(['focus-input:Paste your wallet*', 'fresh:Open a position'])
    expect(labels('manual', true)).toEqual(['fresh:Open a position with these numbers*'])
    expect(labels('address', true)).toEqual(['migrate:Migrate this position*', 'fresh:Open a position'])
    expect(labels('address', false)).toEqual(['fresh:Open a position*'])
    for (const m of ['demo', 'manual'] as const) for (const b of [true, false]) expect(doorSet(m, b).some((d) => d.action === 'migrate')).toBe(false)
    for (const m of ['demo', 'address', 'manual'] as const)
      for (const b of [true, false]) expect(doorSet(m, b).filter((d) => d.primary)).toHaveLength(1)
  })
})

describe('STORY beats T and O', () => {
  const clock = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16) + 'Z'
  it('T uses the measured census close and time on the demo', async () => {
    const { troubleLine } = await import('@/lib/landing/verdict')
    const row = DEMO_BORROWER_ROW
    const cmp = runReplay(demoBorrowerPosition(), demoBorrowerDetection(), { series, manifest, measured: protocols.measuredLiquidations }, {
      user: row.user, events: row.events, t0Index: row.t0Index, aaveClosedUsd: row.aaveClosedUsd,
      membraneClosedUsd: row.membraneClosedUsd, outcome: row.outcome, collSymbol: row.collSymbol, debtSymbol: row.debtSymbol,
    })
    const t = troubleLine(cmp, 'this', row, clock)
    expect(t).toBe(`Aave V3 liquidated $${Math.round(row.aaveClosedUsd).toLocaleString('en-US')} at ${clock(series.startTs + row.t0Index * series.stepSeconds)} (measured).`)
    expect(t).not.toMatch(BANNED)
  })
  it('T is labelled modelled without a census row, and says plainly when nothing sold', async () => {
    const { troubleLine } = await import('@/lib/landing/verdict')
    const cmp = demoRun()
    expect(troubleLine(cmp, 'your', null, clock)).toMatch(/^Aave V3 would have liquidated \$[\d,]+ at \d\d:\d\dZ \(modelled\)\./)
    const quiet = { ...cmp, source: { ...cmp.source, events: [] } }
    expect(troubleLine(quiet, 'your', null, clock)).toBe('Aave V3 would have sold nothing of your position on this replay (modelled).')
  })
  it('O states the window honestly: opened, how it ended, what Membrane would have closed', async () => {
    const { outcomeBeat } = await import('@/lib/landing/verdict')
    const row = DEMO_BORROWER_ROW
    const cmp = demoRun()
    const w = armedWindows(cmp, cmp.membrane.equitySeries.length, CURE_WINDOW_SECONDS / series.stepSeconds)
    const o = outcomeBeat(cmp, row, w, clock, { cureHours: 8, bandPct: 4, stepSeconds: series.stepSeconds })
    expect(o).toMatch(/^8h window from \d\d:\d\dZ; band broke \d+ min later\. Membrane would have closed \$309,635 \(simulator\)\.$/)
    expect(o).not.toMatch(BANNED)
  })
  it('every H1 states the band ceiling and the window, from the constants (owner ruling)', async () => {
    const { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } = await import('@/lib/position-sim/membrane')
    const band = `${Math.round(MAX_THRESHOLD_TO_DELAY * 100)}%`
    const hours = `${CURE_WINDOW_HOURS} hours`
    expect(band).toBe('4%')
    expect(hours).toBe('8 hours')
    for (const h of Object.values(HEADLINES)) {
      expect(h.headline).toContain(band)
      expect(h.headline).toContain(hours)
      expect(h.headline).toContain(`Within ${band} of your line`)
      expect(h.headline).not.toMatch(/profit/i)
    }
    expect(HEADLINES.default.headline).toBe('Borrow without babysitting. Within 4% of your line, you get 8 hours to repay — automatically.')
  })
  it('the subhead has a desktop and a phone line', async () => {
    const { SUBHEAD_DESKTOP, SUBHEAD_PHONE } = await import('@/lib/landing/headline')
    expect(SUBHEAD_DESKTOP).toBe('Open your position, then close your laptop.')
    expect(SUBHEAD_PHONE).toBe('Open your position, then throw your phone.')
  })
})

describe('verdict second, at its shortest', () => {
  it('states the debt gap with its label', async () => {
    const { verdictShort } = await import('@/lib/landing/verdict')
    const row = DEMO_BORROWER_ROW
    const gap = Math.round(row.aaveClosedUsd - row.membraneClosedUsd).toLocaleString('en-US')
    expect(verdictShort(demoRun(), row)).toBe(`$${gap} less debt closed than Aave V3 (simulator).`)
  })
})

describe('/carry copy (owner brief 2026-10-25)', () => {
  it('every H1 states the band and the window from the constants; no profit promise; no unverified 14-day cover', async () => {
    const { CARRY_HEADLINES, CARRY_OBJECTIONS } = await import('@/lib/landing/carry')
    const { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } = await import('@/lib/position-sim/membrane')
    const words = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
    for (const h of Object.values(CARRY_HEADLINES)) {
      expect(h.headline).toContain(`Within ${Math.round(MAX_THRESHOLD_TO_DELAY * 100)}% of your line`)
      expect(h.headline).toContain(`${CURE_WINDOW_HOURS} hours`)
      expect(h.headline).not.toMatch(/profit|guarantee|14 days|curators? (pay|cover)/i)
      expect(h.headline).not.toMatch(BANNED)
      expect(words(h.headline)).toBeLessThanOrEqual(21)
    }
    // The 14-day curator spread cover is not in the contracts: only named as absent.
    const spread = CARRY_OBJECTIONS.find((o) => o.id === 'spread')!
    expect(spread.answer).toMatch(/No curator cover exists on-chain yet/)
    for (const o of CARRY_OBJECTIONS) expect(o.answer.split(/\s+/).length).toBeLessThanOrEqual(25)
  })
})

describe('redesign: comparison table, proof figures, moving line', () => {
  const protocols = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/oct10-2025/protocols.json'), 'utf8'))
  const evidence = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/oct10-2025/evidence.json'), 'utf8'))

  it('venue cells come from protocols.json; recall row only on /carry', async () => {
    const { comparisonRows } = await import('@/lib/landing/comparison')
    const rows = comparisonRows(protocols, false)
    expect(rows.map((r) => r.id)).toEqual(['window', 'partial', 'nothing'])
    expect(comparisonRows(protocols, true).map((r) => r.id)).toEqual(['window', 'partial', 'recall', 'nothing'])
    const partial = rows.find((r) => r.id === 'partial')!
    const cf = protocols.aaveV3.closeFactor.documented
    expect(partial.aave.mark).toBe('partial')
    expect(partial.aave.text).toContain(`${cf.DEFAULT_LIQUIDATION_CLOSE_FACTOR_pct}%`)
    expect(partial.aave.text).toContain(String(cf.CLOSE_FACTOR_HF_THRESHOLD))
    expect(partial.morpho.mark).toBe(protocols.morphoBlue.hasCloseFactor === false ? 'no' : 'na')
    // The window row is stated from the constants, never typed.
    expect(rows[0].label).toContain(`${Math.round(MAX_THRESHOLD_TO_DELAY * 100)}%`)
    // Every Membrane ✓ carries at least one source.
    for (const r of comparisonRows(protocols, true)) if (r.membrane.mark === 'yes') expect(r.sources.some((s) => s.startsWith('Membrane:'))).toBe(true)
    // No source → no ✓ for a venue, and a missing doc never invents one.
    for (const r of comparisonRows(null, true)) {
      expect(r.aave.mark).not.toBe('yes')
      expect(r.morpho.mark).not.toBe('yes')
    }
  })

  it('proof figures are cohort sums, per chain adding to the total', () => {
    const s = summariseCensus(evidence)
    const priced = evidence.cohort.filter((r: { excluded?: boolean; priced?: boolean }) => !r.excluded && r.priced !== false)
    expect(s.accounts).toBe(evidence.meta.accounts)
    expect(s.venueClosedUsd).toBeCloseTo(priced.reduce((t: number, r: { aaveClosedUsd: number }) => t + r.aaveClosedUsd, 0), 2)
    expect(s.byChain.reduce((t, c) => t + c.venueClosedUsd, 0)).toBeCloseTo(s.venueClosedUsd, 2)
    expect(s.byChain.reduce((t, c) => t + c.membraneClosedUsd, 0)).toBeCloseTo(s.membraneClosedUsd, 2)
    expect(s.byChain.reduce((t, c) => t + c.rows, 0)).toBe(s.walked)
  })

  it('the moving line stays hidden until the batched migrate flow is live', async () => {
    const { BATCHED_MIGRATE_LIVE, MOVING_LINE, movingLineFor } = await import('@/lib/landing/doors')
    expect(BATCHED_MIGRATE_LIVE).toBe(false)
    expect(movingLineFor('address', true)).toBeNull()
    expect(movingLineFor('address', true, true)).toBe(MOVING_LINE)
    expect(movingLineFor('demo', true, true)).toBeNull()
    expect(movingLineFor('address', false, true)).toBeNull()
  })
})

describe('/carry demo is a census event (parent review 2026-10-25)', () => {
  it('opens on a wallet Aave liquidated, stable debt against ETH/BTC, never wstETH', async () => {
    const { LANDING_PAGES } = await import('@/lib/landing/pages')
    const d = LANDING_PAGES.carry.demo
    expect(d.census).not.toBeNull()
    expect(d.census!.aaveClosedUsd).toBeGreaterThan(0)
    expect(['WETH', 'WBTC', 'cbBTC']).toContain(d.census!.collSymbol)
    expect(['USDC', 'USDT', 'DAI', 'USDS', 'GHO']).toContain(d.census!.debtSymbol)
    expect(d.census!.collSymbol).not.toBe('wstETH')
    const ev = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/oct10-2025/evidence.json'), 'utf8'))
    const row = ev.cohort.find((r: { user: string }) => r.user.toLowerCase() === d.address.toLowerCase())
    expect(row.aaveClosedUsd).toBe(d.census!.aaveClosedUsd)
  })
})
