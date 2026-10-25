// THE FORECAST BLOCK (FORECAST_VISUALS.md, option C), directly under the hero. Visual first
// (owner, 2026-10-16), and the visual answers WHEN (owner, 2026-10-17: "within 7 days it's
// 14% but it's low chance in 1 day or the next 12 hours … combine the ranges into one
// visual instead of scrolling through them"):
//   kicker "Chance ETH touches your line, by when"
//   the big number: the 7-day chance (Redaction 700, 52 / 76px), "likely lo–hi" beside it
//   THE TIME CHART (TimeToTouchChart): chance touched by t, 1 h → 7 days, as a band, with
//     the 1 / 3 / 7-day figures marked as checked points; it replaces the horizon tabs
//   the curve read at three times: "Under 1% by 12 h · 3% by day 2 · 14% by day 7"
//   the confidence line (7 days)
//   the depth curve (TouchGradientSlot) at 7 days, with the levers the action rows solve
// A forecast, not a frequency: never "X% of days" here.
//
// WHY THE OWNER SAW NOTHING (round 2): the "visual" was a 100-cell strip that inks the
// chance as printed, so every line under 1% (most real positions sit 30–40% away) inked
// zero cells; positions with no forecast (a ratio line, a flagged oracle, a line past the
// table, past the line) rendered text or nothing at all. Now the chart's frame is always
// drawn: with the curve whenever a chance exists, otherwise "reading…" or withheld with the
// reason inside the frame (STALE hatched).

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FIGURE } from '@/components/NewsEdition/tokens'
import { fmtMove } from '@/lib/position/format'
import { confidenceLine, formatBand, formatChance } from '@/lib/position/touch'
import { HORIZON_WORDS, STALE_AFTER_DAYS, type HorizonId, type TouchTable } from '@/lib/position/touchHistory'
import { TOUCH_TIME_GRID, readingLine } from '@/lib/position/touchTime'
import { gridRange, rowReading, touchGrid } from '@/lib/position/touchGrid'

import { Credit, Dagger, Kicker, Mono, Section, Small, StaleTag } from './primitives'
import { STALE_HATCH, curveMarks } from './forecastMarks'
import { TimeToTouchChart, type TimeChartState } from './TimeToTouchChart'
import { TouchGridChart, type GridChartState } from './TouchGridChart'
import { TouchGradientSlot } from './TouchGradientSlot'
import { TYPE } from './typeScale'
import type { ForecastView, HorizonForecast, PositionView } from './viewModel'

/** The y caption of the time chart. */
export const TIME_CAPTION = 'chance touched by then'

/** Why a position has no time curve, ≤ 8 words, or null when it has one. Pure. */
export function timeWithheld(view: PositionView, t: TouchTable): string | null {
  switch (view.hero.kind) {
    case 'no-debt':
      return null
    case 'past':
      return 'already past the line'
    case 'unreachable':
      return view.hero.cause === 'interest' ? 'only interest moves this line' : 'no price reaches this line'
    case 'unsplit':
      return 'no per-asset line to forecast'
  }
  const f = view.forecast
  if (!f) {
    // Short, for inside the frame; the full reason prints under it.
    if (view.oracleFlag) return 'the oracle is not the market price'
    if (view.basis.kind === 'ratio') return `the line is the ${view.basis.base}/${view.basis.quote} ratio, not a USD price`
    return 'no single price history fits this line'
  }
  if (f.time) return null
  return f.lookup === 'within' ? 'line under 1% away' : `line past ${t.levels.max}%, beyond the table`
}

const Figure: React.FC<{ f: ForecastView; hf: HorizonForecast; stale: boolean; t: TouchTable }> = ({ f, hf, stale, t }) => {
  const at = hf.at
  if (stale) {
    return (
      <Mono color={NEWS.ink2}>
        <StaleTag />: the history ends {t.period.dataEnd.slice(0, 10)}, over {STALE_AFTER_DAYS} days ago. No number shown.
      </Mono>
    )
  }
  if (at) {
    return (
      // The figure and its range share one baseline: the chart under it is the visual.
      <Box display="flex" flexWrap="wrap" alignItems="baseline" columnGap={SPACING.md} minW={0}>
        <Text as="p" m={0} {...NEWS_FIGURE.display} fontSize={TYPE.hero} lineHeight={1} color={NEWS.ink}>
          {formatChance(at.touched, at.n)}
          <Dagger />
        </Text>
        <Mono as="span">
          within {HORIZON_WORDS[hf.horizon]} · likely {formatBand(at.lo, at.hi, at.n)}
        </Mono>
      </Box>
    )
  }
  return (
    <Mono color={NEWS.ink2}>
      {f.lookup === 'within'
        ? 'Your line is under 1% away, closer than the forecast’s first level.'
        : `Your line is past ${t.levels.max}%, beyond the forecast table.`}
    </Mono>
  )
}

/** The block for a position with no forecast: the chart's frame, withheld with the reason. */
const Withheld: React.FC<{ asset: string | null; reason: string; note: string | null; two: boolean }> = ({ asset, reason, note, two }) => (
  <Section id="forecast" aria-live="polite">
    <Kicker>Chance {asset ?? 'the price'} touches your line, by when and how far</Kicker>
    {two ? (
      <TimeToTouchChart state={{ kind: 'withheld', reason }} caption={TIME_CAPTION} />
    ) : (
      <TouchGridChart state={{ kind: 'withheld', reason }} />
    )}
    {note && <Mono color={NEWS.ink2}>{note}</Mono>}
  </Section>
)

/**
 * The one chart's state for a position: the time × depth grid over the default rows, widened
 * to the reader's line and to every lever's row; withheld (with the reason) when there is no
 * row to read. Pure.
 */
export function forecastGridState(f: ForecastView, hf: HorizonForecast, stale: boolean, t: TouchTable, withheld: string | null): GridChartState {
  if (stale) return { kind: 'withheld', stale: true, reason: `history ends ${t.period.dataEnd.slice(0, 10)}` }
  if (!f.time) return { kind: 'withheld', reason: withheld ?? 'no level to read' }
  const marks = curveMarks(f, hf)
  const you = f.time.level
  const range = gridRange(t, [you, ...marks.levers.map((p) => p.level)])
  const grid = touchGrid(t, TOUCH_TIME_GRID, f.asset, f.direction, range)
  const levers = marks.levers
    .filter((p) => p.level !== you && p.level >= range.from && p.level <= range.to)
    .map((p) => ({ level: p.level, kinds: p.kinds, detail: p.detail }))
  const verb = f.direction === 'fall' ? 'falls' : 'rises'
  const read = rowReading(grid, you)
    .map((r) => `${r.chance} within ${HORIZON_WORDS[r.horizon]}`)
    .join(', ')
  const leverWords = levers.length ? ` Levers move your row to ${levers.map((p) => fmtMove(p.level, f.direction)).join(' and ')}.` : ''
  return {
    kind: 'ready',
    grid,
    you,
    levers,
    initial: { level: you, hours: 168 },
    summary: `Chance ${f.asset} ${verb} to each depth from ${fmtMove(range.from, f.direction)} to ${fmtMove(range.to, f.direction)} by each time from 1 hour to 7 days. Your line, ${fmtMove(you, f.direction)}: ${read}.${leverWords}`,
  }
}

export const ForecastBlock: React.FC<{
  view: PositionView
  horizon: HorizonId
  stale: boolean
  t: TouchTable
  /** ?charts=two: the round-3 pair (time curve, depth curve) for comparison. */
  two?: boolean
  /** "History through 2026-10-06 · 11 days old · STALE from 2026-11-05" (client clock). */
  ageLine?: string | null
}> = ({ view, horizon, stale, t, two = false, ageLine = null }) => {
  // A lender's position has no line: the lending block takes this place.
  if (view.hero.kind === 'no-debt') return null
  const f = view.forecast
  const withheld = timeWithheld(view, t)
  if (!f) {
    return <Withheld asset={null} reason={withheld ?? 'no forecast'} note={view.forecastAbsent} two={two} />
  }
  const hf = f.byHorizon[horizon]
  const marks = curveMarks(f, hf)
  const verb = f.direction === 'fall' ? 'falls' : 'rises'
  const leverLines = marks.levers.flatMap((p) => p.detail)
  const levers = leverLines.length > 0 ? ` Marked: ${leverLines.join('; ')}.` : ''
  const summary = stale
    ? `Chance ${f.asset} ${verb}: withheld, the history ends ${t.period.dataEnd.slice(0, 10)}, over ${STALE_AFTER_DAYS} days ago.`
    : hf.at
    ? `Chance ${f.asset} ${verb} to your line (${fmtMove(hf.at.level, f.direction)}) within ${HORIZON_WORDS[horizon]}: ${formatChance(hf.at.touched, hf.at.n)}, likely ${formatBand(hf.at.lo, hf.at.hi, hf.at.n)}. Curve from ${fmtMove(hf.range.from, f.direction)} to ${fmtMove(hf.range.to, f.direction)}.${levers}`
    : `Chance ${f.asset} ${verb} ${hf.range.from}% to ${hf.range.to}% within ${HORIZON_WORDS[horizon]}.${levers}`

  const tt = f.time
  const time: TimeChartState = stale
    ? { kind: 'withheld', stale: true, reason: `history ends ${t.period.dataEnd.slice(0, 10)}` }
    : tt
      ? {
          kind: 'ready',
          series: [{ tt, tone: 'ink' }],
          marks: true,
          summary: `Chance ${f.asset} ${verb} to your line (${fmtMove(tt.level, f.direction)}) by each time from 1 hour to 7 days: ${readingLine(tt)}.`,
        }
      : { kind: 'withheld', reason: withheld ?? 'no level to read' }
  const conf = confidenceLine(hf.confidence)

  if (!two) {
    const grid = forecastGridState(f, hf, stale, t, withheld)
    return (
      <Section id="forecast" aria-live="polite" bgImage={stale ? STALE_HATCH : undefined} data-stale={stale ? 'true' : undefined}>
        <Kicker>Chance {f.asset} touches your line, by when and how far</Kicker>
        <Figure f={f} hf={hf} stale={stale} t={t} />
        <TouchGridChart state={grid} />
        {tt && !stale && <Mono>Your row: {readingLine(tt)}.</Mono>}
        {conf && <Small>{conf} (7 days)</Small>}
        <Credit>
          <Box as="span" display={{ base: 'none', md: 'inline' }}>
            {f.credit}
          </Box>
          <Box as="span" display={{ base: 'inline', md: 'none' }}>
            {f.creditShort}
          </Box>
        </Credit>
        {ageLine && <Credit data-age-line="">{ageLine}</Credit>}
      </Section>
    )
  }

  return (
    <Section id="forecast" aria-live="polite" bgImage={stale ? STALE_HATCH : undefined} data-stale={stale ? 'true' : undefined}>
      <Kicker>Chance {f.asset} touches your line, by when</Kicker>
      <Figure f={f} hf={hf} stale={stale} t={t} />
      <TimeToTouchChart state={time} caption={TIME_CAPTION} />
      {tt && !stale && <Mono>{readingLine(tt)}.</Mono>}
      {conf && <Small>{conf} (7 days)</Small>}
      <Kicker tone="muted" pt={SPACING.sm}>
        Within {HORIZON_WORDS[horizon]}, by how far {f.asset} {verb}
      </Kicker>
      <TouchGradientSlot
        asset={f.asset}
        direction={f.direction}
        curve={hf.curve}
        range={hf.range}
        you={stale ? null : marks.you}
        levers={stale ? [] : marks.levers}
        summary={summary}
      />
      <Credit>
        <Box as="span" display={{ base: 'none', md: 'inline' }}>
          {f.credit}
        </Box>
        <Box as="span" display={{ base: 'inline', md: 'none' }}>
          {f.creditShort}
        </Box>
      </Credit>
      {ageLine && <Credit data-age-line="">{ageLine}</Credit>}
    </Section>
  )
}
