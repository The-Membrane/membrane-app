import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

/** Footer — what this page deliberately does not show (measurement discipline). */
export const NotShown: React.FC = () => (
  <Box
    as="details"
    mt={SPACING.xl}
    pt={SPACING.base}
    borderTop="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10.5px"
    color={SEMANTIC_COLORS.textTertiary}
    lineHeight={1.7}
    maxW="96ch"
  >
    <Box as="summary" cursor="pointer" color={SEMANTIC_COLORS.textSecondary} letterSpacing="0.2em" textTransform="uppercase" fontSize="10px">
      What this page does not show
    </Box>
    <Text mt={SPACING.md} mb={SPACING.sm}>
      This page does not show a portfolio value. It does not show a percentage return. It does not show an
      unrealized profit. These numbers change when the market changes. They do not show what you did.
    </Text>
    <Text mb={SPACING.sm}>
      This page shows only events that occurred. It shows the yield that arrived, the debt that you paid, the
      shocks that the position survived, and the calls that resolved.
    </Text>
    <Text>
      The route data has a measurement date. We measured 1,245 positions and 25 routes in August 2026. We
      measure them again on a schedule. Each event on this page shows the date of its data. Do not trust a
      number that has no measurement date.
    </Text>
  </Box>
)
