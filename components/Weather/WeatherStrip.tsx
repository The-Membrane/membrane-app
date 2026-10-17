import React, { memo, type ReactNode } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'

import { useNow, useWeather } from './useWeather'
import { weatherView, type WeatherView } from './weatherView'

// THE WEATHER STRIP — the masthead's dateline: the M0 regime, ETH volatility as options
// price it (DVOL, a measured market price with no direction), the base fee, and every
// input's age. Newspaper rules (membrane-board design/DESIGN_RULES.md): calm is ink; the
// wave ∿ marks choppy, in ink (never an arrow or triangle: those read as "price up"); a
// falling figure is red with ✖; stale is hatched with ░ and the regime word withheld.
// Mount it inside a `.news-edition` root (its colours are the NEWS roles).
//
// Rows, so every state has the same height at each width (loading reserves it):
//   A  mono   regime · reason or hold          | gas · ages            (ages: ≥992px)
//   B  serif  the volatility sentence          | credit · liq. note    (credit: ≥992px)
//   C  mono   gas · ages in one item                                   (below 992px)
// Three lines below 992px (390px included), two from 992px. The date leads on every
// width (the masthead passes a short one below 1280px). The "since" and the hold of an
// active trigger join at 1280px; below 992px the credit and the liquidation note step
// aside too (§8: ears and secondary furniture hide on phones), and the ages fold into one
// item sized to the line. The page's method
// table carries the thresholds and the liquidation note.

const MONO_LINE = '16px'
const SERIF_LINE = '20px'
const CAPS = { textTransform: 'uppercase' as const, letterSpacing: '0.12em' }
type Responsive = { base: string; lg?: string; xl?: string }
const NARROW_ONLY: Responsive = { base: 'flex', lg: 'none' }
const WIDE_FLEX: Responsive = { base: 'none', lg: 'flex' }
const XL_ONLY: Responsive = { base: 'none', xl: 'inline' }
/** A faint ink hatch: the strip's stale / unavailable texture (never a colour). */
const HATCH = 'repeating-linear-gradient(-45deg, var(--news-rule) 0 1px, transparent 1px 6px)'

/** One dateline item, unbroken. `sep` prints a middot before it. */
function Item({
  children,
  sep = true,
  display,
}: {
  children: ReactNode
  sep?: boolean
  display?: Responsive
}) {
  return (
    <Box
      as="span"
      display={display ?? 'inline'}
      whiteSpace="nowrap"
      sx={{ '&::before': { content: '"·"', px: '0.5em', display: sep ? 'inline' : 'none' } }}
    >
      {children}
    </Box>
  )
}

function RegimeWord({ v }: { v: WeatherView }) {
  return (
    <Text
      as="span"
      color={NEWS.ink}
      fontWeight={TYPOGRAPHY.bold}
      sx={v.regime.caps ? CAPS : undefined}
    >
      {v.regime.glyph && (
        <Box as="span" aria-hidden="true" mr="0.4em">
          {v.regime.glyph}
        </Box>
      )}
      {v.regime.text}
    </Text>
  )
}

function ReasonText({ v }: { v: WeatherView }) {
  const r = v.reason
  if (!r) return null
  return (
    <>
      {r.lead}{' '}
      <Text as="span" color={r.loss ? NEWS.danger : NEWS.ink} fontWeight={TYPOGRAPHY.bold}>
        {r.loss && (
          <Box as="span" aria-hidden="true" mr="0.25em">
            ✖
          </Box>
        )}
        {r.figure}
      </Text>{' '}
      {r.tail}
    </>
  )
}

export interface WeatherStripProps {
  /** Printed first: the masthead passes the reader's date. */
  lead?: ReactNode
}

/** A — the date and the regime, then (wide) the base fee and every input's age. */
function RegimeRow({ v, lead }: { v: WeatherView; lead?: ReactNode }) {
  const active = v.reason !== null
  return (
    <Flex wrap="wrap" justify="space-between" columnGap={SPACING.base} minH={MONO_LINE}>
      <Flex as="p" wrap="wrap" align="baseline" minW={0}>
        {lead && (
          <Item sep={false}>
            <Text as="span" color={NEWS.ink} sx={CAPS}>
              {lead}
            </Text>
          </Item>
        )}
        <Item sep={!!lead}>
          <RegimeWord v={v} />
        </Item>
        {v.reason && (
          <Item>
            <ReasonText v={v} />
          </Item>
        )}
        {v.since && <Item display={XL_ONLY}>{v.since}</Item>}
        {v.holds && <Item display={active ? XL_ONLY : undefined}>{v.holds}</Item>}
      </Flex>
      <Flex as="p" wrap="wrap" display={WIDE_FLEX} justify="flex-end">
        {v.gas && (
          <Item sep={false}>
            <Text as="span" color={NEWS.ink}>
              {v.gas}
            </Text>
          </Item>
        )}
        {v.ages.map((a, i) => (
          <Item key={a.split(' ')[0]} sep={i > 0 || !!v.gas}>
            {a}
          </Item>
        ))}
      </Flex>
    </Flex>
  )
}

/** B — the sentence, then (wide) its credit and the liquidation note. */
function SentenceRow({ v }: { v: WeatherView }) {
  return (
    <Flex
      wrap="wrap"
      justify="space-between"
      align="baseline"
      columnGap={SPACING.base}
      minH={SERIF_LINE}
    >
      <Text
        as="p"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontStyle="italic"
        fontSize="13px"
        lineHeight={SERIF_LINE}
        color={NEWS.ink}
      >
        {v.sentence}
      </Text>
      <Flex as="p" wrap="wrap" display={WIDE_FLEX} justify="flex-end">
        {v.credit && <Item sep={false}>{v.credit}</Item>}
        {v.liq && <Item sep={!!v.credit}>{v.liq}</Item>}
      </Flex>
    </Flex>
  )
}

/** C — below 992px: the base fee and the ages in one item. The item is sized to one
 *  390px line beside the base fee (weatherView); on a narrower screen it wraps rather
 *  than overflow. */
function NarrowAgesRow({ v }: { v: WeatherView }) {
  return (
    <Flex as="p" wrap="wrap" display={NARROW_ONLY} minH={MONO_LINE}>
      {v.gas && (
        <Item sep={false}>
          <Text as="span" color={NEWS.ink}>
            {v.gas}
          </Text>
        </Item>
      )}
      {v.agesBrief && (
        <Box
          as="span"
          sx={{ '&::before': { content: '"·"', px: '0.5em', display: v.gas ? 'inline' : 'none' } }}
        >
          {v.agesBrief}
        </Box>
      )}
    </Flex>
  )
}

export const WeatherStrip = memo(function WeatherStrip({ lead }: WeatherStripProps) {
  const now = useNow(15_000)
  const q = useWeather()
  // Before the clock mounts, judge ages at the server's read time.
  const v = weatherView({ status: q.status, data: q.data, nowMs: now ?? q.data?.now ?? 0 })

  return (
    <Box
      as="section"
      aria-label="Market weather"
      aria-busy={v.kind === 'loading'}
      data-weather-state={v.kind}
      borderTop={`3px double ${NEWS.ruleStrong}`}
      borderBottom={`3px double ${NEWS.ruleStrong}`}
      py={SPACING.xs}
      bgImage={v.hatched ? HATCH : undefined}
      color={NEWS.muted}
      fontFamily={NEWS_FONT.mono}
      fontSize={TYPOGRAPHY.label}
      lineHeight={MONO_LINE}
      sx={{ fontVariantNumeric: 'tabular-nums' }}
    >
      <RegimeRow v={v} lead={lead} />
      <SentenceRow v={v} />
      <NarrowAgesRow v={v} />
    </Box>
  )
})

export default WeatherStrip
