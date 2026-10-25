import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'

import { Masthead } from './Masthead'
import { regimeCredit, regimeRows } from './todayCopy'

// THE TODAY EDITION (/[chain]/today): the newspaper masthead with the weather strip, and
// how the M0 regime is set. The `.news-edition` root switches on the newspaper token layer
// (styles/news-edition.css). The calm/choppy body is the next build; nothing else here.

const CAPS = { textTransform: 'uppercase' as const, letterSpacing: '0.12em' }
const ROWS = regimeRows()
const CREDIT = regimeCredit()

function RegimeMethod() {
  return (
    <Box
      as="section"
      aria-labelledby="regime-method"
      data-news-section="regime"
      pt={{ base: SPACING.lg, md: SPACING.xl }}
      maxW="720px"
    >
      <Text
        as="p"
        fontFamily={NEWS_FONT.mono}
        fontSize={TYPOGRAPHY.label}
        color={NEWS.accent}
        sx={CAPS}
      >
        The regime
      </Text>
      <Text
        as="h2"
        id="regime-method"
        fontFamily={NEWS_FONT.display}
        fontWeight={TYPOGRAPHY.bold}
        fontSize="22px"
        lineHeight="28px"
        color={NEWS.ink}
        pb={SPACING.sm}
      >
        How the regime is set
      </Text>
      <Box
        as="dl"
        display="grid"
        gridTemplateColumns={{
          base: 'minmax(0, 9rem) minmax(0, 1fr)',
          md: 'minmax(0, 12rem) minmax(0, 1fr)',
        }}
        borderTop={`1px solid ${NEWS.ruleStrong}`}
        fontFamily={NEWS_FONT.mono}
        sx={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {ROWS.map((r) => (
          <React.Fragment key={r.label}>
            <Box
              as="dt"
              py={SPACING.sm}
              borderBottom={`1px solid ${NEWS.rule}`}
              fontSize={TYPOGRAPHY.label}
              lineHeight="16px"
              color={NEWS.muted}
              sx={CAPS}
            >
              {r.label}
            </Box>
            <Box
              as="dd"
              py={SPACING.sm}
              pl={SPACING.base}
              borderBottom={`1px solid ${NEWS.rule}`}
              fontSize="13px"
              lineHeight="16px"
              color={NEWS.ink}
            >
              {r.value}
            </Box>
          </React.Fragment>
        ))}
      </Box>
      <Text
        as="p"
        textAlign="right"
        pt={SPACING.sm}
        fontFamily={NEWS_FONT.mono}
        fontSize={TYPOGRAPHY.label}
        lineHeight="16px"
        color={NEWS.muted}
        overflowWrap="anywhere"
      >
        {CREDIT}
      </Text>
    </Box>
  )
}

export function TodayEdition() {
  return (
    <Box
      className="news-edition"
      minH="100vh"
      px={{ base: SPACING.base, md: SPACING.lg, lg: SPACING.xl }}
    >
      <Box maxW="1200px" mx="auto" pb={SPACING['2xl']}>
        <Masthead />
        <RegimeMethod />
      </Box>
    </Box>
  )
}

export default TodayEdition
