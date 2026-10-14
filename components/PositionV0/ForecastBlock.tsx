// THE FORECAST BLOCK (FORECAST_VISUALS.md, option C), directly under the hero:
//   kicker "Chance ETH touches your line within {horizon}"
//   the big number (Redaction 700, 52 / 76px), "likely lo–hi", the confidence line
//   horizon tabs 1d · 3d · 7d · 14d · 30d (real buttons, ≥ 44px, aria-pressed)
//   the curve (TouchGradientSlot)
// A forecast, not a frequency: never "X% of days" here. STALE hatches the block, marks it
// ░ and hides the big number.

import React from 'react'
import { Box, Button, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { NEWS, NEWS_FIGURE, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { fmtMove } from '@/lib/position/format'
import { confidenceLine, formatBand, formatChance } from '@/lib/position/touch'
import { HORIZON_IDS, HORIZON_WORDS, STALE_AFTER_DAYS, type HorizonId, type TouchTable } from '@/lib/position/touchHistory'

import { Credit, Dagger, Kicker, Mono, Section, Small } from './primitives'
import { STALE_HATCH, curveMarks } from './forecastMarks'
import { TouchGradientSlot } from './TouchGradientSlot'
import { TYPE } from './typeScale'
import type { ForecastView, HorizonForecast, PositionView } from './viewModel'

export const HorizonTabs: React.FC<{ value: HorizonId; onChange: (h: HorizonId) => void }> = ({ value, onChange }) => (
  <Box role="group" aria-label="Forecast horizon" display="flex" flexWrap="wrap" borderBottom={`1px solid ${NEWS.rule}`}>
    {HORIZON_IDS.map((h) => {
      const on = h === value
      return (
        <Button
          key={h}
          type="button"
          variant="unstyled"
          aria-pressed={on}
          onClick={() => onChange(h)}
          w="auto"
          h="44px"
          minW="44px"
          textTransform="none"
          px={SPACING.sm}
          borderRadius={0}
          borderBottom={`2px solid ${on ? NEWS.ink : 'transparent'}`}
          mb="-1px"
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPE.body}
          fontWeight={on ? 700 : 400}
          color={on ? NEWS.ink : NEWS.ink2}
          transition={TRANSITIONS.colors}
          _hover={{ color: NEWS.ink }}
        >
          {h}
        </Button>
      )
    })}
  </Box>
)

const Body: React.FC<{ f: ForecastView; hf: HorizonForecast; stale: boolean; t: TouchTable }> = ({ f, hf, stale, t }) => {
  const at = hf.at
  const conf = confidenceLine(hf.confidence)
  let figure: React.ReactNode = null
  if (stale) {
    figure = (
      <Mono color={NEWS.ink2}>
        ░ Stale: the history ends {t.period.dataEnd.slice(0, 10)}, over {STALE_AFTER_DAYS} days ago. No number shown.
      </Mono>
    )
  } else if (at) {
    figure = (
      <>
        <Text as="p" {...NEWS_FIGURE.display} fontSize={TYPE.hero} lineHeight={1} color={NEWS.ink}>
          {formatChance(at.touched, at.n)}
          <Dagger />
        </Text>
        <Mono>likely {formatBand(at.lo, at.hi, at.n)}</Mono>
      </>
    )
  } else {
    figure = (
      <Mono color={NEWS.ink2}>
        {f.lookup === 'within'
          ? 'Your line is under 1% away, closer than the forecast’s first level.'
          : `Your line is past ${t.levels.max}%, beyond the forecast table.`}
      </Mono>
    )
  }
  return (
    <>
      {figure}
      {conf && <Small>{conf}</Small>}
    </>
  )
}

export const ForecastBlock: React.FC<{
  view: PositionView
  horizon: HorizonId
  onHorizon: (h: HorizonId) => void
  stale: boolean
  t: TouchTable
}> = ({ view, horizon, onHorizon, stale, t }) => {
  // No distance to forecast at, or (unsplit) no per-asset line at all: the hero says which.
  if (['no-debt', 'past', 'unreachable', 'unsplit'].includes(view.hero.kind)) return null
  const f = view.forecast
  if (!f) {
    return (
      <Section id="forecast">
        <Kicker>Forecast</Kicker>
        <Mono color={NEWS.ink2}>{view.forecastAbsent ?? 'No forecast for this position.'}</Mono>
      </Section>
    )
  }
  const hf = f.byHorizon[horizon]
  const marks = curveMarks(f, hf)
  const verb = f.direction === 'fall' ? 'falls' : 'rises'
  const summary = stale
    ? `Chance ${f.asset} ${verb}: withheld, the history ends ${t.period.dataEnd.slice(0, 10)}, over ${STALE_AFTER_DAYS} days ago.`
    : hf.at
    ? `Chance ${f.asset} ${verb} to your line (${fmtMove(hf.at.level, f.direction)}) within ${HORIZON_WORDS[horizon]}: ${formatChance(hf.at.touched, hf.at.n)}, likely ${formatBand(hf.at.lo, hf.at.hi, hf.at.n)}. Curve from ${fmtMove(hf.range.from, f.direction)} to ${fmtMove(hf.range.to, f.direction)}.`
    : `Chance ${f.asset} ${verb} ${hf.range.from}% to ${hf.range.to}% within ${HORIZON_WORDS[horizon]}.`

  return (
    <Section
      id="forecast"
      aria-live="polite"
      bgImage={stale ? STALE_HATCH : undefined}
      data-stale={stale ? 'true' : undefined}
    >
      <Kicker>
        Chance {f.asset} touches your line within {HORIZON_WORDS[horizon]}
      </Kicker>
      <Body f={f} hf={hf} stale={stale} t={t} />
      <HorizonTabs value={horizon} onChange={onHorizon} />
      <TouchGradientSlot
        asset={f.asset}
        direction={f.direction}
        curve={hf.curve}
        range={hf.range}
        you={stale ? null : marks.you}
        actions={stale ? [] : marks.actions}
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
    </Section>
  )
}
