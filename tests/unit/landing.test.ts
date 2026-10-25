import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { demoBorrowerDetection, demoBorrowerPosition, CURE_WINDOW_SECONDS } from '@/lib/position-sim'
import { HEADLINES, hashToHeadline, resolveHeadline, SUBHEAD, RUN_LABEL } from '@/lib/landing/headline'
import { LANDING_EVENT_NAMES, setLandingSink, track, type LandingEvent } from '@/lib/landing/instrumentation'
import { buildManualPosition, decodeManual, encodeManual, morphoBonus, morphoLltvs, aaveLine, validateManual } from '@/lib/landing/manualPosition'
import { OBJECTIONS, summariseCensus } from '@/lib/landing/objections'
import { runReplay } from '@/lib/landing/replay'
import { classifyVisit, readVisit, writeVisit, RETURN_KEY, visitDelta, type VisitRecord } from '@/lib/landing/returnVisit'
import { SCENARIOS, scenarioById } from '@/lib/landing/scenarios'
import { depthRegistry, exitCostShare, skewLines, skewNote } from '@/lib/landing/sizeSkew'
import { armedWindows, closedTotals, eventMarks, verdictSentence } from '@/lib/landing/verdict'
import { delayReadings, forwardReach, historyReadings, fallToPct, shown } from '@/lib/landing/forecastLayer'
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
    expect(v).toMatch(/^Membrane would have closed \$[\d,]+ (less|more) of this position \(simulator\)\.$/)
    expect(v).not.toMatch(BANNED)
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
      { venue: 'aave-v3', collateral: 'USDe', collateralUsd: 50_000, debtUsd: 30_000, liquidationLtv: 0.9 },
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
  const rec: VisitRecord = { address: '0x' + 'a'.repeat(40), at: 1, debtUsd: 100, collateralUsd: 200, ltv: 0.5, lessUsd: 10, scenarioId: 'oct10-2025' }
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
    const cur = { address: rec.address, debtUsd: 100, collateralUsd: 200, ltv: 0.5, lessUsd: 10 }
    expect(classifyVisit(null, cur)).toBe('first')
    expect(classifyVisit(rec, cur)).toBe('returning')
    expect(classifyVisit(rec, { ...cur, debtUsd: 111 })).toBe('changed')
    expect(classifyVisit(rec, { ...cur, ltv: 0.52 })).toBe('changed')
    expect(classifyVisit(rec, { ...cur, address: '0x' + 'b'.repeat(40) })).toBe('first')
    expect(visitDelta(rec, { ...cur, debtUsd: 150 }, 11).debtUsd).toBe(50)
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
  })
})

describe('census card (delay postpones the loss)', () => {
  const c = summariseCensus(evidence)
  it('shows recovered AND not-recovered, from the builder tally', () => {
    expect(c.recovered).toBe(evidence.meta.cureModel.outcomes['cured-then-held'])
    expect(c.expired).toBe(evidence.meta.cureModel.outcomes['sold-at-expiry'])
    expect(c.recovered).toBeGreaterThan(0)
    expect(c.expired + c.brokeBand).toBeGreaterThan(0)
    expect(c.recoveredExample?.outcome).toBe('cured-then-held')
    expect(c.failedExample?.outcome).toBe('sold-at-expiry')
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
    expect(delayReadings(cmp, w, series.startTs, series.stepSeconds, null).status).toBe('pending')
    const fr = forwardReach(cmp.position, 1_760_000_000, null)
    if (fr.status === 'ready') for (const row of fr.value.rows) expect(shown(row.result).kind).not.toBe('probability')
    const eth = decodeCompactSeries(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/forecast/ETHUSDT-1h.json'), 'utf8')))
    const d = delayReadings(cmp, w, series.startTs, series.stepSeconds, eth)
    expect(d.status).toBe('ready')
    if (d.status === 'ready') {
      for (const step of d.value)
        for (const row of step.reach.rows) {
          const sh = shown(row.result)
          if (sh.kind === "probability") expect(PROBABILITY_CLASSES.has(row.result!.cell!.class)).toBe(true)
        }
    }
    expect(historyReadings([], () => null).status).toBe('pending')
    expect(fallToPct(0.8, 0.8)).toBe(0)
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
