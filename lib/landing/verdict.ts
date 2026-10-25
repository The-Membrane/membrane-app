/**
 * THE ONE-SENTENCE DOLLAR VERDICT (framework "Output", rewritten to the copy ruling).
 *
 * Framework draft: "Membrane kept $X more of this position." The ruling bans "kept" as
 * fact and wants every Real-vs-Membrane line in the conditional with "(simulator)". So
 * the figure is DEBT CLOSED — the same quantity the Oct 10 census publishes as
 * aaveClosedUsd / membraneClosedUsd — and the sentence says "would have".
 *
 * "Closed" sums every repay. The source engine only emits liquidations; Membrane may
 * also retire debt through a recall or a cure, and a dollar of loan closed by a recall
 * is still closed. Pure: everything here is derived from the two runs.
 */

import type { Comparison, SimEvent } from '@/lib/position-sim'

export interface ClosedTotals {
  /** Debt the venue's engine retired over the replay. */
  venueClosedUsd: number
  /** Debt Membrane's engine retired over the replay (sales, recalls and cures). */
  membraneClosedUsd: number
  /** venue − membrane. Positive = Membrane would have closed less. */
  lessUsd: number
}

export function closedTotals(cmp: Comparison): ClosedTotals {
  const venueClosedUsd = cmp.source.events
    .filter((e) => e.kind === 'liquidation')
    .reduce((a, e) => a + e.repaidUsd, 0)
  const membraneClosedUsd = cmp.membrane.events.reduce((a, e) => a + Math.max(0, e.repaidUsd), 0)
  return { venueClosedUsd, membraneClosedUsd, lessUsd: venueClosedUsd - membraneClosedUsd }
}

const usd = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString('en-US')}`

/** The measured figures, when the replayed position is a census row. */
export interface MeasuredSide {
  aaveClosedUsd: number
  membraneClosedUsd: number
  events: number
}

export interface Verdict {
  /** One sentence, one $ figure, about DEBT closed, conditional, labelled (simulator). */
  headline: string
  /** Both terms of the gap, each with where it comes from. */
  detail: string
  measured: boolean
}

/**
 * The verdict. With a census row the two terms are the census's: what Aave actually
 * closed (measured) and what the census walk says Membrane would have closed. Without
 * one, Aave is the page's model at the median repay size and is labelled as such.
 * `whose` is "this" on the demo wallet and "your" on a pasted or entered position.
 */
export function verdictOf(cmp: Comparison, whose: 'this' | 'your', measured: MeasuredSide | null = null): Verdict {
  const t = closedTotals(cmp)
  const venue = measured ? measured.aaveClosedUsd : t.venueClosedUsd
  const mem = measured ? measured.membraneClosedUsd : t.membraneClosedUsd
  const less = venue - mem
  const what = `of ${whose} position’s debt`
  const src = cmp.position.label
  let headline: string
  if (venue < 0.5 && mem < 0.5) headline = `Neither engine would have closed any ${what} on this replay (simulator).`
  else if (Math.abs(less) < 0.5) headline = `Membrane would have closed the same ${usd(mem)} ${what} (simulator).`
  else headline = `Membrane would have closed ${usd(less)} ${less > 0 ? 'less' : 'more'} ${what} (simulator).`
  const detail = measured
    ? `${src} closed ${usd(venue)} in ${measured.events} liquidation${measured.events === 1 ? '' : 's'} (measured, 10 Oct 2025 census); Membrane would have closed ${usd(mem)} (simulator, census walk).`
    : `${src} modelled at the median repay size: ${usd(venue)} closed; Membrane would have closed ${usd(mem)} (simulator).`
  return { headline, detail, measured: !!measured }
}

/** Back-compat: the headline alone. */
export function verdictSentence(cmp: Comparison, whose: 'this' | 'your', measured: MeasuredSide | null = null): string {
  return verdictOf(cmp, whose, measured).headline
}

/** Chart event marks, one per engine event, in the DESIGN_RULES §2 grammar. */
export type MarkTone = 'sold' | 'armed' | 'cleared' | 'recalled'

export interface EventMark {
  minute: number
  engine: 'venue' | 'membrane'
  tone: MarkTone
  /** Glyph that carries the colour (§2: red and amber differ by hue alone). */
  glyph: string
  label: string
}

const GLYPH: Record<MarkTone, string> = { sold: '✖', armed: '░', cleared: '●', recalled: '▲' }

export function eventMarks(cmp: Comparison): EventMark[] {
  const out: EventMark[] = []
  for (const e of cmp.source.events) {
    if (e.kind !== 'liquidation') continue
    out.push({ minute: e.minute, engine: 'venue', tone: 'sold', glyph: GLYPH.sold, label: `${cmp.position.label} liquidation · ${usd(e.repaidUsd)} debt closed, ${usd(e.seizedUsd)} collateral sold` })
  }
  for (const e of cmp.membrane.events) out.push(membraneMark(e))
  return out
}

function membraneMark(e: SimEvent): EventMark {
  switch (e.kind) {
    case 'breach':
      return { minute: e.minute, engine: 'membrane', tone: 'armed', glyph: GLYPH.armed, label: '8h window armed' }
    case 'cure':
      return { minute: e.minute, engine: 'membrane', tone: 'cleared', glyph: GLYPH.cleared, label: `cured · ${usd(e.recalledUsd)} recalled, nothing sold` }
    case 'recall':
      return { minute: e.minute, engine: 'membrane', tone: 'recalled', glyph: GLYPH.recalled, label: `recall · ${usd(e.recalledUsd)}, nothing sold` }
    default:
      return { minute: e.minute, engine: 'membrane', tone: 'sold', glyph: GLYPH.sold, label: `Membrane trim · ${usd(e.seizedUsd)} sold` }
  }
}

/**
 * The minutes the Membrane 8h window was armed on this replay, as [start, end) pairs.
 *
 * The engine records the breach that arms the window and any sale, cure or recall that
 * ends it, but a return under the line by PRICE clears the timer silently
 * (DelayTimer, lib/position-sim/curePath.ts). So the end is the first of: a later
 * Membrane event, a minute whose LTV is back at or under the line, the 8h expiry, or the
 * path end. `priceCured` marks windows that ended because the price came back.
 */
export interface ArmedWindow {
  start: number
  end: number
  priceCured: boolean
}

export function armedWindows(cmp: Comparison, pathCount: number, cureMinutes: number): ArmedWindow[] {
  const out: ArmedWindow[] = []
  const evs = cmp.membrane.events
  const ltv = cmp.membrane.ltvSeries
  for (let k = 0; k < evs.length; k++) {
    const e = evs[k]
    if (e.kind !== 'breach') continue
    const nextEvent = evs.slice(k + 1).find((x) => x.minute > e.minute)
    let end = Math.min(pathCount, e.minute + cureMinutes, nextEvent ? nextEvent.minute : pathCount)
    let priceCured = false
    for (let i = e.minute + 1; i < end; i++) {
      const v = ltv[i]
      if (v !== null && v !== undefined && v <= e.line) {
        end = i
        priceCured = true
        break
      }
    }
    out.push({ start: e.minute, end, priceCured })
  }
  return out
}
