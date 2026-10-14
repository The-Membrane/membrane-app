import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS } from '@/components/NewsEdition/tokens'
import { WeatherStrip } from '@/components/Weather/WeatherStrip'

import { DATELINE_MAX_CHARS, datelineLabel, localIsoDate, TAGLINE } from './todayCopy'

// THE TODAY MASTHEAD: heavy rule, the nameplate in the pixel cut (Redaction 35, declared
// in styles/fonts.css), the tagline (shown on phones too, DESIGN_RULES §8), then the
// dateline between double rules: the reader's date and the weather strip.

const NAMEPLATE_FONT = "'Redaction 35', 'Redaction', Georgia, serif"
/** The date slot's width before it fills: the longest date, caps-tracked mono (0.6em
 *  advance + 0.12em tracking per character). */
const DATE_WIDTH = `${DATELINE_MAX_CHARS * (0.6 + 0.12)}em`

const noSubscribe = () => () => {}
const clientDay = () => localIsoDate(new Date())
const serverDay = () => null

/** The reader's local date. The server cannot know the reader's day, so it renders the
 *  slot empty at its final width; the client fills it during hydration. */
function TodayDate() {
  const iso = useSyncExternalStore(noSubscribe, clientDay, serverDay)
  return (
    <Box
      as="time"
      display="inline-block"
      minW={DATE_WIDTH}
      dateTime={iso ?? undefined}
      suppressHydrationWarning
    >
      {iso ? datelineLabel(iso) : '\u00a0'}
    </Box>
  )
}

export function Masthead() {
  return (
    <Box as="header" pt={{ base: SPACING.base, md: SPACING.lg }}>
      <Box borderTop={`4px solid ${NEWS.ink}`} />
      <Text
        as="h1"
        textAlign="center"
        fontFamily={NAMEPLATE_FONT}
        fontWeight={TYPOGRAPHY.normal}
        fontSize="clamp(56px, 16vw, 120px)"
        lineHeight={1.05}
        color={NEWS.ink}
        pt={SPACING.sm}
      >
        Membrane
      </Text>
      <Text
        textAlign="center"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontStyle="italic"
        fontSize="13px"
        lineHeight="20px"
        color={NEWS.ink2}
        pb={SPACING.md}
      >
        {TAGLINE}
      </Text>
      <WeatherStrip lead={<TodayDate />} />
    </Box>
  )
}

export default Masthead
