import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INPUTS,
  LOADOUTS,
  TIME_KNOTS,
  TREE_FLOOR_MISSING,
  buildStressPosition,
  capacityCutText,
  computeFrontier,
  crashLevel,
  detailRows,
  duration,
  edgeView,
  exitChipText,
  exitPresetName,
  laneTimeline,
  leafView,
  multText,
  pct,
  positionExitName,
  resolveSelection,
  stockSourceText,
  swatchText,
  timeX,
  treeLanes,
  usdShort,
  type CapacityChoice,
  type FrontierModel,
  type SandboxInputs,
} from '@/components/RiskFrontier/viewModel'
import { DEFAULT_VENUE_REFERENCE } from '@/lib/position-sim/frontier'
import { MEMBRANE_CLASS_PARAMS } from '@/lib/position-sim/membrane'
import {
  EXIT_CAPACITY_DEFAULT_CUTS,
  EXIT_CAPACITY_DEFAULT_PRESET,
  EXIT_CAPACITY_PRESETS,
  EXIT_CAPACITY_PRESET_ORDER,
  STRESS_CODE_VERSION,
  STRESS_LABEL,
  oct10ReplayShape,
  runStress,
  type StressResult,
} from '@/lib/position-sim/stressGrid'
import type { Oct10Series } from '@/lib/position-sim/scenario'

const series = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../public/data/oct10-2025/prices-1m.json'), 'utf8'),
) as Oct10Series
const replay = oct10ReplayShape(series, 'WETH')

/**
 * UPDATED 2026-10-07 (owner ruling: the default exit is cash vs book, Aave USDC typical at a
 * $50M book — ×1, its idle cash covered the whole book). The mechanics pins below were
 * derived on a PARTIAL stock (×0.1119 of $14,200 = $1,589), so they now name that level
 * explicitly: the everyone-exits floor of the same venue's typical event.
 */
const FLOOR_INPUTS: SandboxInputs = {
  ...DEFAULT_INPUTS,
  capacity: { kind: 'preset', preset: 'aave-usdc-floor-typical' },
}

/** Every user-visible string the view model hands the screen for one model. */
function visibleStrings(m: FrontierModel): string[] {
  const out: string[] = [m.headline.lead, m.headline.detail ?? '', exitChipText(m.sandbox) ?? '']
  out.push(...m.swatch.cols)
  for (const lane of m.tree) out.push(lane.label, lane.sub, lane.leaf.title, lane.leaf.short)
  for (const c of m.crash) out.push(c.title, c.summary, c.limit.text, c.limit.hint)
  for (const row of m.swatch.rows)
    for (const cell of row.cells) out.push(cell.leaf.title, cell.leaf.short, cell.text)
  for (const lane of m.tree)
    if (lane.result)
      for (const r of detailRows(
        lane.result,
        stockSourceText(m.sandbox.position, lane.scenario?.venue),
      ))
        out.push(r.label, r.value)
  for (const e of [
    m.dtd.price.breach,
    m.dtd.price.arm,
    m.dtd.price.sale,
    m.dtd.saleAtShock,
    m.dtd.capacity.arm,
    m.dtd.capacity.sale,
    m.dtd.freeze.arm,
    m.dtd.freeze.sale,
  ]) {
    const v = edgeView(e, 'drop')
    out.push(v.text, v.hint)
  }
  return out
}

describe('risk frontier view model — format', () => {
  it('never prints a bare 0%; ∞ for collateral gone', () => {
    expect(pct(0)).toBe('—')
    expect(pct(Infinity)).toBe('∞')
    expect(pct(0.71363)).toBe('71.4%')
    expect(pct(null)).toBe('—')
  })

  it('formats money and durations', () => {
    expect(usdShort(14_200)).toBe('$14.2k')
    expect(usdShort(940)).toBe('$940')
    expect(usdShort(1_050_000)).toBe('$1.05M')
    expect(duration(30)).toBe('<1m')
    expect(duration(60)).toBe('1m')
    expect(duration(8 * 3600)).toBe('8h')
    expect(duration(76_680)).toBe('21h 18m')
    expect(duration(null)).toBe('—')
  })
})

describe('risk frontier view model — sandbox inputs', () => {
  it('clamps the line to the class ceiling and reports it', () => {
    const sb = buildStressPosition({ ...DEFAULT_INPUTS, line: 0.95 })
    expect(sb.line).toBe(MEMBRANE_CLASS_PARAMS.delayed.ltvCeiling)
    expect(sb.lineClamped).toBe(true)
    const nd = buildStressPosition({ ...DEFAULT_INPUTS, membraneClass: 'no-delay', line: 0.95 })
    expect(nd.line).toBe(0.95)
    expect(nd.lineClamped).toBe(false)
    expect(nd.breakLine).toBe(0.95) // no band
  })

  it('caps deployed at the debt and drops venue fields for levered long', () => {
    const sb = buildStressPosition({ ...DEFAULT_INPUTS, deployedUsd: 99_999 })
    expect(sb.deployedUsd).toBe(DEFAULT_INPUTS.debtUsd)
    expect(sb.deployedClamped).toBe(true)
    const lev = buildStressPosition({ ...DEFAULT_INPUTS, tradeShape: 'levered_long' })
    expect(lev.position.deployedUsd).toBeUndefined()
    expect(lev.position.exitCapacityPreset).toBeUndefined()
    expect(lev.position.exitCapacityUsd).toBeUndefined()
    expect(lev.exitCapacityUsd).toBeNull()
  })

  it('passes a preset through, and a custom multiplier as a multiple of the deployed amount', () => {
    // UPDATED 2026-10-07 (owner ruling: the headline is cash vs book; the default is typical
    // Aave USDC stress at a $50M book, was the pro-rata ×0.1119 — now the floor): the default
    // preset passes through as an id and resolves to deployed × its measured mult — ×1, the
    // venue's idle cash covered the whole book, and the label says so.
    const preset = buildStressPosition(DEFAULT_INPUTS)
    expect(preset.position.exitCapacityPreset).toBe('aave-usdc-50m-typical')
    expect(preset.exitCapacityUsd).toBeCloseTo(DEFAULT_INPUTS.deployedUsd * 1, 9)
    expect(preset.capacityLabel).toBe('Aave USDC · $50M book · typical · ×1, cash covers the book')
    expect(preset.capacityLockHours).toBe(0)
    const floor = buildStressPosition({
      ...DEFAULT_INPUTS,
      capacity: { kind: 'preset', preset: 'aave-usdc-floor-typical' },
    })
    expect(floor.exitCapacityUsd).toBeCloseTo(DEFAULT_INPUTS.deployedUsd * 0.1119, 9)
    expect(floor.capacityLabel).toBe('Aave USDC · floor (everyone exits) · typical')
    const kelp = buildStressPosition({
      ...DEFAULT_INPUTS,
      capacity: { kind: 'preset', preset: 'aave-usdc-floor-worst' },
    })
    expect(kelp.capacityLockHours).toBe(45)
    // The same Kelp event against a $50M book: idle cash under 1% of the book for 16 h.
    const kelpBook = buildStressPosition({
      ...DEFAULT_INPUTS,
      capacity: { kind: 'preset', preset: 'aave-usdc-50m-worst' },
    })
    expect(kelpBook.capacityLockHours).toBe(16)
    const custom = buildStressPosition({
      ...DEFAULT_INPUTS,
      capacity: { kind: 'custom', mult: 0.3 },
    })
    expect(custom.position.exitCapacityPreset).toBeUndefined()
    // UPDATED 2026-10-04 (review: custom capacity skewed the crash test): was passed as a
    // fixed exitCapacityUsd, which the reverse solve held in $ while rescaling the debt.
    expect(custom.position.exitCapacityUsd).toBeUndefined()
    expect(custom.position.exitCapacityMult).toBe(0.3)
    expect(custom.exitCapacityUsd).toBeCloseTo(DEFAULT_INPUTS.deployedUsd * 0.3, 9)
    const node = runStress(custom.position, { price: { kind: 'step', drop: 0.25 } })
    expect(node.outcome !== 'not_modelled' && node.recallAvailableUsd).toBeCloseTo(
      DEFAULT_INPUTS.deployedUsd * 0.3,
      2,
    )
    const wild = buildStressPosition({ ...DEFAULT_INPUTS, capacity: { kind: 'custom', mult: 7 } })
    expect(wild.capacityMult).toBe(1)
  })

  it('never defaults to the optimistic exit (owner ruling 2026-10-04)', () => {
    expect(DEFAULT_INPUTS.capacity).not.toEqual({ kind: 'preset', preset: 'optimistic' })
    // Owner ruling 2026-10-07: typical Aave USDC stress against a $50M book.
    expect(EXIT_CAPACITY_DEFAULT_PRESET).toBe('aave-usdc-50m-typical')
    expect(DEFAULT_INPUTS.capacity).toEqual({
      kind: 'preset',
      preset: EXIT_CAPACITY_DEFAULT_PRESET,
    })
    for (const l of LOADOUTS) {
      if (l.inputs.capacity.kind === 'preset') {
        expect(EXIT_CAPACITY_PRESETS[l.inputs.capacity.preset], l.id).toBeDefined()
        expect(l.inputs.capacity.preset, l.id).not.toBe('optimistic')
      }
    }
    // The 'Small loan' quick start silently ran at the ×1 upper bound (review 2026-10-07).
    expect(LOADOUTS.find((l) => l.id === 'small')!.inputs.capacity).toEqual({
      kind: 'preset',
      preset: EXIT_CAPACITY_DEFAULT_PRESET,
    })
  })

  // Review 2026-10-07: no quick start or default may resolve to ×1 unless its label says ×1.
  it('no quick start or default resolves to ×1 unless it is labelled ×1', () => {
    const resolved = [
      { id: 'DEFAULT_INPUTS', inputs: DEFAULT_INPUTS },
      ...LOADOUTS.map((l) => ({ id: l.id, inputs: l.inputs })),
    ]
    let ones = 0
    for (const { id, inputs } of resolved) {
      const sb = buildStressPosition(inputs)
      if (sb.capacityMult === null) continue // levered long: no venue
      if (sb.capacityMult >= 1) {
        ones++
        expect(sb.capacityLabel, id).toMatch(/×1\b/)
      }
    }
    // The default resolves to a measured ×1 today, so the rule is exercised, not vacuous.
    expect(ones).toBeGreaterThan(0)
    // Every preset that resolves to ×1 is labelled so; no other label claims ×1.
    for (const x of Object.values(EXIT_CAPACITY_PRESETS)) {
      expect(/×1\b/.test(x.label), x.id).toBe(x.mult >= 1)
    }
  })
})

describe('risk frontier view model — edges and leaves', () => {
  it('quotes found edges toward risk, whole units', () => {
    const node = runStress(buildStressPosition(DEFAULT_INPUTS).position, {
      price: { kind: 'step', drop: 0.36 },
    })
    const found = edgeView(
      {
        status: 'found',
        unit: 'pct',
        display: 35,
        safeBelow: 0.357,
        triggersAt: 0.3571,
        iterations: 20,
        at: node,
      },
      'drop',
    )
    expect(found.text).toBe('35%')
    expect(found.at).toBeCloseTo(0.35, 12)
    expect(found.hint).toBe('nothing at 35% of drop; the edge is in (35%, 36%]')
    const tiny = edgeView(
      {
        status: 'found',
        unit: 'hours',
        display: 0,
        safeBelow: 0.001,
        triggersAt: 0.0011,
        iterations: 9,
        at: node,
      },
      'freeze',
    )
    expect(tiny.text).toBe('<1h')
    expect(edgeView({ status: 'beyond_range', unit: 'pct', max: 0.99 }, 'drop')).toMatchObject({
      state: 'beyond',
      at: null,
      text: '>99%',
    })
    expect(edgeView({ status: 'not_applicable', reason: 'no_delay_class' }, 'drop').text).toBe(
      'no window',
    )
  })

  it('gives every outcome its own glyph', () => {
    const glyphs = new Set<string>()
    const pos = buildStressPosition(FLOOR_INPUTS).position
    // UPDATED 2026-10-06 (owner instruction: measured venue analogs; the default exit is typical
    // Aave USDC stress, ×0.1119 of deployed, was the named 'stressed' ×0.5): the recall cure is
    // reached at −20% (needs $1,128 of the $1,589 stock), no longer at −25%.
    const runs: StressResult[] = [
      runStress(pos, { price: { kind: 'step', drop: 0 } }),
      runStress(pos, { price: { kind: 'step', drop: 0.2 } }),
      runStress(pos, { price: { kind: 'step', drop: 0.5 } }),
      runStress({ ...pos, exitCapacityPreset: undefined }, { price: { kind: 'step', drop: 0.1 } }),
    ]
    for (const r of runs) glyphs.add(leafView(r).glyph)
    expect([...glyphs].sort()).toEqual(['●', '◆', '✖', '░'].sort())
    expect(leafView(null, 'Oct 10 tape loading')).toMatchObject({
      glyph: '░',
      short: 'Oct 10 tape loading',
    })
  })
})

describe('risk frontier view model — swatch cells', () => {
  it('gives each outcome a compact line that carries its number', () => {
    const pos = buildStressPosition(FLOOR_INPUTS).position
    const flat = runStress(pos, { price: { kind: 'step', drop: 0 } })
    // UPDATED 2026-10-06 (owner instruction: measured venue analogs; the default exit is typical
    // Aave USDC stress, ×0.1119 of deployed, was the named 'stressed' ×0.5): recall cures at −20%.
    const recall = runStress(pos, { price: { kind: 'step', drop: 0.2 } })
    const sold = runStress(pos, { price: { kind: 'step', drop: 0.5 } })
    const nm = runStress(
      { ...pos, exitCapacityPreset: undefined },
      { price: { kind: 'step', drop: 0.1 } },
    )
    expect(flat.outcome).toBe('no_breach')
    expect(swatchText(flat)).toBe('peak 71%')
    expect(recall.outcome).toBe('recall_cured')
    expect(swatchText(recall)).toMatch(/^recall \$\d/)
    expect(sold.outcome).toBe('sold')
    expect(swatchText(sold)).toMatch(/^\$[\d.,]+k? sold$/)
    expect(swatchText(nm)).toBe('not modelled')
  })

  it('stores the compact line on every grid cell', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null)
    for (const row of m.swatch.rows)
      for (const cell of row.cells) expect(cell.text).toBe(swatchText(cell.result))
  })
})

describe('risk frontier view model — tree timeline', () => {
  it('maps time monotonically onto [0, 1] through its knots', () => {
    for (const [s, x] of TIME_KNOTS) expect(timeX(s)).toBeCloseTo(x, 12)
    expect(timeX(-5)).toBe(0)
    expect(timeX(1e9)).toBe(1)
    let prev = -1
    for (let s = 0; s <= 70 * 3600; s += 997) {
      const x = timeX(s)
      expect(x).toBeGreaterThanOrEqual(prev)
      prev = x
    }
  })

  it('hatches a lane with no modelled result, and keeps segments contiguous otherwise', () => {
    expect(laneTimeline(null, 0.1)).toEqual({
      events: [],
      segments: [{ from: 0.1, to: 1, tone: 'muted' }],
      endX: 1,
    })
    const m = computeFrontier(DEFAULT_INPUTS, replay)
    for (const lane of m.tree) {
      const segs = lane.segments
      expect(segs[0].from).toBeCloseTo(lane.startX, 12)
      for (let i = 1; i < segs.length; i++) expect(segs[i].from).toBeCloseTo(segs[i - 1].to, 12)
      for (const s of segs) expect(s.to).toBeGreaterThan(s.from)
    }
  })

  it('builds the named branches, venue rows under the −25% step', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null)
    expect(m.tree.map((l) => l.id)).toEqual([
      'flat',
      'step10',
      'step25',
      'freeze8',
      'capFloor',
      'wick25',
      'oct10',
    ])
    expect(m.tree.filter((l) => l.parent === 'step25').map((l) => l.id)).toEqual([
      'freeze8',
      'capFloor',
    ])
    const oct = m.tree.find((l) => l.id === 'oct10')!
    expect(oct.result).toBeNull()
    expect(oct.leaf.glyph).toBe('░')
    for (const lane of m.tree) {
      if (!lane.result) continue
      expect(lane.result.label).toBe(STRESS_LABEL)
      expect(lane.result.codeVersion).toBe(STRESS_CODE_VERSION)
    }
    // The venue rows fork at the parent's first breach.
    const step = m.tree.find((l) => l.id === 'step25')!
    const fork = m.tree.find((l) => l.id === 'freeze8')!
    expect(step.result?.outcome).not.toBe('not_modelled')
    expect(fork.startX).toBeGreaterThan(0)
  })

  it('runs the Oct 10 replay once the tape is in', () => {
    expect(replay).not.toBeNull()
    const m = computeFrontier(DEFAULT_INPUTS, replay)
    const oct = m.tree.find((l) => l.id === 'oct10')!
    expect(oct.result?.outcome).not.toBe('not_modelled')
    expect(oct.sub).toContain('sensitivity test')
  })

  it("the everyone-exits lane runs the chosen venue's OWN floor, not a cut of the chosen level", () => {
    // Review 2026-10-07: the lane applied the default's floor ÷ default cut (×0.1119) on top of
    // whatever capacity was chosen, so it was "everyone exits" only at the default preset.
    const lane = (capacity: CapacityChoice) =>
      computeFrontier({ ...DEFAULT_INPUTS, capacity }, null).tree.find((l) => l.id === 'capFloor')!
    const strip = (r: StressResult | null) => ({ ...r!, cellKey: '', scenarioId: '' })
    const cases = [
      ['aave-usdc-50m-worst', 'aave-usdc-floor-worst'], // was ×0.0000112 behind its 16 h lock
      ['steakhouse-usdc-50m-typical', 'steakhouse-usdc-floor-typical'], // was ×0.0336
      ['aave-usdc-floor-typical', 'aave-usdc-floor-typical'], // was ×0.0125, the floor of the floor
      ['spark-usds-250m-bad', 'spark-usds-floor-bad'],
      [EXIT_CAPACITY_DEFAULT_PRESET, 'aave-usdc-floor-typical'],
    ] as const
    for (const [chosen, floorId] of cases) {
      const l = lane({ kind: 'preset', preset: chosen })
      const floor = EXIT_CAPACITY_PRESETS[floorId]
      expect(l.label, chosen).toBe(`Exit ×${multText(floor.mult)}`)
      expect(l.sub, chosen).toContain(`${floor.source!.venueName} everyone exits`)
      if (floor.freezeHours > 0) expect(l.sub, chosen).toContain(`${floor.freezeHours}h lock`)
      // The same walk as a position that chose that floor itself.
      const own = buildStressPosition({
        ...DEFAULT_INPUTS,
        capacity: { kind: 'preset', preset: floorId },
      })
      const direct = runStress(own.position, { price: DEFAULT_VENUE_REFERENCE })
      expect(strip(l.result), chosen).toEqual(strip(direct))
    }
    expect(lane(DEFAULT_INPUTS.capacity).label).toBe('Exit ×0.1119')
    // Every measured level: the lane's stock is deployed × its own venue's floor at its level.
    for (const id of EXIT_CAPACITY_PRESET_ORDER) {
      const src = EXIT_CAPACITY_PRESETS[id].source
      if (!src) continue
      const floor = EXIT_CAPACITY_PRESETS[`${src.slug}-floor-${src.level}`]
      const capacity: CapacityChoice = { kind: 'preset', preset: id }
      const sb = buildStressPosition({ ...DEFAULT_INPUTS, capacity })
      const def = treeLanes(capacity, null).find((l) => l.id === 'capFloor')!
      const r = runStress(sb.position, def.scenario!)
      expect(r.outcome === 'not_modelled' ? null : r.recallAvailableUsd, id).toBeCloseTo(
        sb.deployedUsd * floor.mult,
        1,
      )
      expect(def.label, id).toBe(`Exit ×${multText(floor.mult)}`)
    }
    // A bound or a custom multiple names no venue: the lane is missing, never a multiplier.
    for (const c of [
      { kind: 'preset', preset: 'frozen' },
      { kind: 'preset', preset: 'optimistic' },
      { kind: 'custom', mult: 0.3 },
    ] as CapacityChoice[]) {
      const l = lane(c)
      expect(l.scenario).toBeNull()
      expect(l.result).toBeNull()
      expect([l.leaf.glyph, l.leaf.short]).toEqual(['░', TREE_FLOOR_MISSING])
      expect(l.label).not.toMatch(/×/)
    }
  })

  it('shows levered-long venue rows as not modelled, with the reason', () => {
    const m = computeFrontier({ ...DEFAULT_INPUTS, tradeShape: 'levered_long' }, null)
    for (const id of ['freeze8', 'capFloor']) {
      const lane = m.tree.find((l) => l.id === id)!
      expect(lane.leaf.glyph).toBe('░')
      expect(lane.leaf.short).toBe('levered long: no venue recall')
    }
    expect(m.swatch.cols).toEqual(['chosen exit'])
  })
})

describe('risk frontier view model — headline, crash test, selection', () => {
  it('names the nearest price edge without folding in venue axes', () => {
    const m = computeFrontier(FLOOR_INPUTS, null)
    // UPDATED 2026-10-06 (owner instruction: measured venue analogs; the default exit is typical
    // Aave USDC stress, ×0.1119 of deployed, was the named 'stressed' ×0.5): the $1,589 stock
    // cures drops to ~21.2% (was 35% with $7,100).
    expect(m.headline.lead).toBe('A held drop past 21% arms the 8h window.')
    // UPDATED 2026-10-07: the default (cash vs book, $50M, ×1) recalls the whole $14,200.
    expect(computeFrontier(DEFAULT_INPUTS, null).headline.lead).toBe(
      'A held drop past 54% arms the 8h window.',
    )
    expect(m.headline.detail).toContain('Modelled recall, not a guarantee.')
    const nd = computeFrontier(LOADOUTS.find((l) => l.id === 'no-delay')!.inputs, null)
    expect(nd.headline.lead).toContain('no window in this class')
    expect(visibleStrings(nd).join(' ')).not.toMatch(
      /8h window|arms the|window armed|past the band/,
    )
  })

  it('says when a carry position starts over the line (recall fires at once)', () => {
    // UPDATED 2026-10-06 (owner instruction: measured venue analogs; the default exit is typical
    // Aave USDC stress, ×0.1119 of deployed, was the named 'stressed' ×0.5): at $39,500 the
    // $1,660 the recall needs is over the $1,589 stock, so the case moves to $39,400 ($1,560).
    const m = computeFrontier({ ...FLOOR_INPUTS, debtUsd: 39_400 }, null)
    expect(m.dtd.price.breach.status).toBe('already')
    expect(m.headline.detail).toMatch(
      /^Already over the line: start LTV 89\.5% vs line 86%, so recall fires at once\./,
    )
    const short = computeFrontier({ ...FLOOR_INPUTS, debtUsd: 39_500 }, null)
    expect(short.dtd.price.breach.status).toBe('already')
    // UPDATED 2026-10-07 (claims refuter round 3: the capacity is named with its model): was
    // "the chosen exit capacity holds $1,589." with no level.
    expect(short.headline.detail).toMatch(
      /^Recall would need \$1,660; the chosen exit capacity \[Aave USDC · floor \(everyone exits\) · typical\] holds \$1,589\./,
    )
    expect(computeFrontier(DEFAULT_INPUTS, null).headline.detail).not.toContain(
      'Already over the line',
    )
  })

  it('crash verdicts come from the user’s own node at that drop', () => {
    const m = computeFrontier(FLOOR_INPUTS, null)
    expect(m.crash.map((c) => c.title)).toEqual(['−50%', '−60%'])
    for (const c of m.crash) {
      expect(c.verdict).toBe(
        c.node.outcome === 'sold'
          ? 'sold'
          : c.node.outcome === 'not_modelled'
            ? 'not_modelled'
            : 'cleared',
      )
    }
    // UPDATED 2026-10-06 (owner instruction: measured venue analogs; the default exit is typical
    // Aave USDC stress, ×0.1119 of deployed, was the named 'stressed' ×0.5): at −50% the limit
    // start LTV is 45% (was 55%).
    expect(m.crash[0].limit.text).toBe('45%')
    expect(m.crash[0].verdict).toBe('sold')
    // UPDATED 2026-10-04 (owner ruling 1, the debt floor on what a call actually repays):
    // was every level 'cleared'. The small loan ($3k debt, $2.5k deployed; UPDATED 2026-10-07:
    // at the default cash-vs-book level, ×1 — was the silent 'optimistic' ×1) breaches at both drops; the ask is the whole loan and the venue's $2,500 would leave
    // $500 — under the $2,000 floor — so the call repays all and sells the $500.
    const small = computeFrontier(LOADOUTS.find((l) => l.id === 'small')!.inputs, null)
    for (const c of small.crash) {
      expect(c.verdict).toBe('sold')
      expect(c.node.outcome === 'sold' && c.node.saleReason).toBe('floor')
      expect(c.node.outcome === 'sold' && c.node.exposedUsd).toBeCloseTo(500, 6)
    }
  })

  it('a custom capacity multiple solves exactly like the preset with the same multiple', () => {
    // The review case: $38k of debt, $22.8k deployed. The custom choice used to reach the
    // engine as a fixed $11,400, which the reverse solve held in dollars while it rescaled
    // the debt: at −60% the limit read 60% (custom ×0.50) vs 49% ('stressed', ×0.5), and at
    // −50% 68% vs 61% — the custom answer optimistic exactly where the crash test matters.
    // UPDATED 2026-10-06: the preset is the measured 'aave-usdc-floor-typical' (×0.1119), was the
    // named 'stressed' (×0.5, where the limits read 61% / 49%).
    const base = { ...DEFAULT_INPUTS, debtUsd: 38_000, deployedUsd: 22_800 }
    const preset = computeFrontier(
      { ...base, capacity: { kind: 'preset', preset: 'aave-usdc-floor-typical' } },
      null,
    )
    const custom = computeFrontier({ ...base, capacity: { kind: 'custom', mult: 0.1119 } }, null)
    expect(custom.crash.map((c) => c.limit.text)).toEqual(preset.crash.map((c) => c.limit.text))
    expect(preset.crash.map((c) => c.limit.text)).toEqual(['46%', '36%'])
    expect(custom.dtd.reverse).toEqual(preset.dtd.reverse)
    expect(custom.dtd.capacity).toEqual(preset.dtd.capacity)
    expect(custom.sandbox.exitCapacityUsd).toBeCloseTo(2_551.32, 9)
  })

  it('the crash stamp carries the node’s own glyph: ● only when the line was never crossed', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null)
    for (const c of m.crash) {
      const own = leafView(c.node)
      expect([c.glyph, c.tone]).toEqual([own.glyph, own.tone])
    }
    // A cleared level that crossed the line and was recalled is ◆, not the "no breach" ●.
    const p = buildStressPosition(DEFAULT_INPUTS).position
    const recalled = runStress(p, { price: { kind: 'step', drop: 0.5 } })
    const fake = { ...recalled, outcome: 'recall_cured' } as StressResult
    const lvl = crashLevel(0.5, m.dtd.reverse.at50, fake, 0.7, 0.86)
    expect(lvl.verdict).toBe('cleared')
    expect(lvl.glyph).toBe('◆')
    const armed = crashLevel(
      0.5,
      m.dtd.reverse.at50,
      { ...recalled, outcome: 'armed_cured' } as StressResult,
      0.7,
      0.86,
    )
    expect(armed.glyph).toBe('▲')
    const covered = crashLevel(
      0.5,
      m.dtd.reverse.at50,
      { ...recalled, outcome: 'recall_liquidated' } as StressResult,
      0.7,
      0.86,
    )
    expect([covered.verdict, covered.glyph]).toEqual(['cleared', '■'])
  })

  it('resolves a selection against the current model', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null)
    const lane = resolveSelection(m, { kind: 'lane', id: 'capFloor' })
    expect(lane.result?.cellKey).toBe(m.tree.find((l) => l.id === 'capFloor')!.result?.cellKey)
    const edge = resolveSelection(m, { kind: 'edge', axis: 'price', edge: 'sale' })
    expect(edge.result?.outcome).toBe('sold')
    const cell = resolveSelection(m, { kind: 'swatch', row: 1, col: 2 })
    expect(cell.result?.cellKey).toBe(m.swatch.rows[1].cells[2].result.cellKey)
    const none = resolveSelection(m, { kind: 'edge', axis: 'capacity', edge: 'breach' })
    expect(none.result).toBeNull()
  })

  it('keeps the copy rules in every exit-capacity label and provenance the picker shows', () => {
    // Review 2026-10-07: 'Idle cash $0 …' (spark-dai-50m-bad) and a mid-sentence 'Under 0.01%'.
    for (const id of EXIT_CAPACITY_PRESET_ORDER) {
      const x = EXIT_CAPACITY_PRESETS[id]
      for (const text of [x.label, x.provenance]) {
        expect(text, id).not.toMatch(/(^|[^\d.])0(\.0+)?%/) // no bare 0%
        expect(text, id).not.toMatch(/\$0(?![\d,.])/) // no bare $0
        expect(text, id).not.toMatch(/[a-z0-9,;:] Under\b/) // no capital mid-sentence
        expect(text, id).not.toMatch(/\bfree\b|interest-free/i)
      }
    }
    expect(EXIT_CAPACITY_PRESETS['spark-dai-50m-bad'].provenance).toContain(
      'Idle cash under $1 across the 8 h window covers under 0.01% of the $50M book',
    )
  })

  it('keeps the copy rules on every loadout', () => {
    for (const l of LOADOUTS) {
      const text = visibleStrings(computeFrontier(l.inputs, replay)).join(' \n ')
      expect(text).not.toMatch(/(^|[^\d.])0(\.0+)?%/) // no bare 0%
      expect(text).not.toMatch(/\$0(?![\d,.])/) // no bare $0
      expect(text).not.toMatch(
        /\bfree\b|interest-free|\bsafe\b|\bok\b|win rate|confidence|% of users/i,
      )
      expect(text.split(STRESS_LABEL).join('')).not.toMatch(/probab|odds|chance|likely/i)
    }
  })
})

// Claims refuter round 3 (2026-10-07), C: the HUD EXIT chip showed a bare "$14,200 ×1" with the
// model and book only in a hover title (invisible on touch); the swatch columns read
// "exit ×0.9032" / "exit ×0.1119" with no source while multiplying whatever was chosen; the
// venue stock row and the headline named no level. Every one now names its model and book.
describe('risk frontier view model — every exit capacity is named', () => {
  const BOOK_OR_MODEL =
    /cash vs book · .*\$(10|50|250)M book|floor \(everyone exits\)|bound|custom ×|Frozen/

  it('the EXIT chip shows the model and book, not only a multiple', () => {
    const def = buildStressPosition(DEFAULT_INPUTS)
    expect(exitChipText(def)).toBe(
      '$14,200 · cash vs book · Aave USDC · $50M book · typical · ×1, cash covers the book',
    )
    const floor = buildStressPosition(FLOOR_INPUTS)
    expect(exitChipText(floor)).toBe(
      '$1,589 ×0.1119 · Aave USDC · floor (everyone exits) · typical',
    )
    const kelp = buildStressPosition({
      ...DEFAULT_INPUTS,
      capacity: { kind: 'preset', preset: 'aave-usdc-50m-worst' },
    })
    expect(exitChipText(kelp)).toMatch(
      /^\$\d[\d,]* ×0\.0001 · 16h lock · cash vs book · Aave USDC · \$50M book · worst seen$/,
    )
    const custom = buildStressPosition({
      ...DEFAULT_INPUTS,
      capacity: { kind: 'custom', mult: 0.3 },
    })
    expect(exitChipText(custom)).toBe('$4,260 · custom ×0.3 of deployed')
    expect(
      exitChipText(buildStressPosition({ ...DEFAULT_INPUTS, tradeShape: 'levered_long' })),
    ).toBeNull()
    // Every preset: the chip names its model and book, and a ×1 always says so.
    for (const id of EXIT_CAPACITY_PRESET_ORDER) {
      const sb = buildStressPosition({
        ...DEFAULT_INPUTS,
        capacity: { kind: 'preset', preset: id },
      })
      const text = exitChipText(sb)!
      expect(text, id).toMatch(BOOK_OR_MODEL)
      expect(text, id).toContain(exitPresetName(id))
      if (EXIT_CAPACITY_PRESETS[id].mult >= 1) expect(text, id).toMatch(/×1\b/)
    }
  })

  it('the HUD renders the chip text itself, not a hover title', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../components/RiskFrontier/RiskFrontier.tsx'),
      'utf8',
    )
    expect(src).toContain('<HudChip label="EXIT" value={exitChip} />')
    expect(src).toContain('const exitChip = exitChipText(sb)')
    expect(src).not.toMatch(/title=\{sb\.capacityLabel/)
  })

  it('names each swatch cut at the default level', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null)
    expect(EXIT_CAPACITY_DEFAULT_CUTS.map((c) => [c.id, c.from, c.mult])).toEqual([
      ['bad', 'aave-usdc-50m-bad', 0.9032],
      ['floor', 'aave-usdc-floor-typical', 0.1119],
    ])
    expect(m.swatch.cols).toEqual([
      'chosen exit',
      'exit ×0.9032 · Aave USDC $50M bad',
      'exit ×0.1119 · Aave USDC floor typical',
      'freeze 4h',
      'freeze 8h',
      'freeze 24h',
    ])
  })

  it('spells out the product a cut runs away from the default level', () => {
    // The cuts multiply whatever was chosen: under the floor (×0.1119) the "bad" column runs
    // ×0.1119 × 0.9032 = ×0.1011, not the $50M bad level.
    const m = computeFrontier(FLOOR_INPUTS, null)
    expect(m.swatch.cols.slice(1, 3)).toEqual([
      'exit ×0.1011 = chosen ×0.1119 × 0.9032 (Aave USDC $50M bad ÷ Aave USDC $50M typical)',
      'exit ×0.0125 = chosen ×0.1119 × 0.1119 (Aave USDC floor typical ÷ Aave USDC $50M typical)',
    ])
    const pos = buildStressPosition({ ...DEFAULT_INPUTS, capacity: { kind: 'custom', mult: 0.5 } })
    expect(capacityCutText(0.9032, pos.position)).toBe(
      'exit ×0.4516 = chosen ×0.5 × 0.9032 (Aave USDC $50M bad ÷ Aave USDC $50M typical)',
    )
    // A fixed-dollar capacity has no multiple to multiply: the cut says it scales the choice.
    expect(capacityCutText(0.9032, { ...pos.position, exitCapacityUsd: 1000 })).toBe(
      'chosen exit × 0.9032 (Aave USDC $50M bad ÷ Aave USDC $50M typical)',
    )
    // No column, at any level, is a bare "exit ×N".
    for (const inputs of [DEFAULT_INPUTS, FLOOR_INPUTS, ...LOADOUTS.map((l) => l.inputs)]) {
      for (const c of computeFrontier(inputs, null).swatch.cols) {
        expect(c).not.toMatch(/^exit ×[\d.]+$/)
      }
    }
  })

  it('names where the venue stock comes from in the node detail', () => {
    const m = computeFrontier(DEFAULT_INPUTS, null)
    const stockOf = (sel: Parameters<typeof resolveSelection>[1]) => {
      const r = resolveSelection(m, sel)
      return detailRows(r.result!, r.stock).find((x) => x.label === 'venue stock')!.value
    }
    const chosen = 'cash vs book · Aave USDC · $50M book · typical · ×1, cash covers the book'
    expect(positionExitName(m.sandbox.position)).toBe(chosen)
    expect(stockOf({ kind: 'swatch', row: 1, col: 0 })).toMatch(
      new RegExp(`^\\$[\\d,]+ · ${chosen.replace(/[$()]/g, '\\$&')}$`),
    )
    expect(stockOf({ kind: 'swatch', row: 1, col: 1 })).toContain(
      `${chosen} × 0.9032 (Aave USDC $50M bad ÷ Aave USDC $50M typical)`,
    )
    // The tree's everyone-exits lane REPLACES the chosen level with the venue's own floor.
    expect(stockOf({ kind: 'lane', id: 'capFloor' })).toMatch(
      /^\$[\d,]+ · Aave USDC · floor \(everyone exits\) · typical$/,
    )
    expect(stockOf({ kind: 'crash', index: 0 })).toContain(chosen)
    for (const lane of m.tree) {
      if (!lane.result || lane.result.outcome === 'not_modelled') continue
      const v = detailRows(lane.result, stockSourceText(m.sandbox.position, lane.scenario?.venue))
      expect(v.find((x) => x.label === 'venue stock')!.value, lane.id).toMatch(BOOK_OR_MODEL)
    }
  })

  it('names the chosen level in the headline', () => {
    let named = 0
    for (const inputs of [
      DEFAULT_INPUTS,
      FLOOR_INPUTS,
      { ...FLOOR_INPUTS, debtUsd: 39_500 },
      { ...DEFAULT_INPUTS, capacity: { kind: 'preset', preset: 'frozen' } } as SandboxInputs,
      ...LOADOUTS.map((l) => l.inputs),
    ]) {
      const m = computeFrontier(inputs, null)
      const d = m.headline.detail ?? ''
      // Never a bare "the chosen exit capacity holds/returns": always its bracketed name.
      expect(d).not.toMatch(/the chosen exit capacity (holds|returns)/i)
      if (/chosen exit capacity/i.test(d)) {
        named++
        expect(d).toContain(`[${positionExitName(m.sandbox.position)}]`)
      }
    }
    expect(named).toBeGreaterThan(1)
  })
})
