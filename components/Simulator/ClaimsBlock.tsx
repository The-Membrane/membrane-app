// THE CARRY CLAIMS — three verified reasons. Copy comes only from CARRY_CLAIMS /
// (owner comms list, Sep 2026). Rendered inside CarrySection, so it
// appears under the fold on BOTH builds — it is never mounted standalone any more.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { CARRY_CLAIMS, CARRY_CLAIM_TITLES } from '@/lib/position-sim'
import { NEWS, NEWS_FONT, useNewsEdition } from '@/components/NewsEdition'

/**
 * THE NEWS EDITION (canvas "Landing", section 05): the three claims as a ruled, numbered
 * list rather than cards. Same titles and lines, verbatim, same test id. The claim rule
 * is ink, not green: these are not money figures.
 */
const NewsClaims: React.FC = () => (
  <Box data-testid="sim-claims" display="grid" gap="10px">
    <Text
      fontFamily={NEWS_FONT.mono}
      fontSize="11px"
      fontWeight={700}
      letterSpacing="0.2em"
      textTransform="uppercase"
      color={NEWS.muted}
    >
      why carry here
    </Text>
    <Box
      as="ol"
      listStyleType="none"
      m={0}
      p={0}
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }}
      gap="10px 24px"
    >
      {CARRY_CLAIMS.map((line, i) => (
        <Box as="li" key={line} borderTop="1px solid" borderColor={NEWS.ink} pt="8px" minW={0}>
          <Text
            fontFamily={NEWS_FONT.mono}
            fontSize="12px"
            fontWeight={700}
            letterSpacing="0.1em"
            textTransform="uppercase"
            color={NEWS.ink}
          >
            {String(i + 1).padStart(2, '0')} {CARRY_CLAIM_TITLES[i]}
          </Text>
          <Text mt="4px" fontFamily={NEWS_FONT.mono} fontSize="13px" lineHeight={1.55} color={NEWS.ink2}>
            {line}
          </Text>
        </Box>
      ))}
    </Box>
  </Box>
)

export const ClaimsBlock: React.FC = () =>
  useNewsEdition() ? (
    <NewsClaims />
  ) : (
  <Box data-testid="sim-claims" display="grid" gap={SPACING.sm}>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="10px"
      letterSpacing="0.24em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textSecondary}
    >
      why carry here
    </Text>
    <Box
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: '1fr 1fr', lg: 'repeat(3, 1fr)' }}
      gap={SPACING.md}
    >
      {CARRY_CLAIMS.map((line, i) => (
        <Box
          key={line}
          bg={SEMANTIC_COLORS.bgPrimary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          borderTop="2px solid"
          borderTopColor={SEMANTIC_COLORS.success}
          borderRadius={0}
          p={SPACING.base}
          display="grid"
          gap={SPACING.sm}
          alignContent="start"
        >
          {/* The title carries the gist on its own — readable without the body. */}
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize="19px"
            lineHeight={1.2}
            color={SEMANTIC_COLORS.textPrimary}
          >
            <Text
              as="span"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="10px"
              letterSpacing="0.24em"
              color={SEMANTIC_COLORS.textTertiary}
              mr={SPACING.sm}
              verticalAlign="middle"
            >
              {String(i + 1).padStart(2, '0')}
            </Text>
            {CARRY_CLAIM_TITLES[i]}
          </Text>
          <Text fontSize="13px" lineHeight={1.55} color={SEMANTIC_COLORS.textPrimary}>
            {line}
          </Text>
        </Box>
      ))}
    </Box>
  </Box>
)

export default ClaimsBlock
