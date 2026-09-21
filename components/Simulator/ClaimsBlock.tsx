// THE CARRY CLAIMS — four lines, one caveat. Copy comes only from CARRY_CLAIMS /
// CARRY_CLAIMS_CAVEAT (owner comms list, Sep 2026). Rendered inside CarrySection, so it
// appears under the fold on BOTH builds — it is never mounted standalone any more.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { CARRY_CLAIMS, CARRY_CLAIM_TITLES, CARRY_CLAIMS_CAVEAT } from '@/lib/position-sim'

export const ClaimsBlock: React.FC = () => (
  <Box data-testid="sim-claims" display="grid" gap={SPACING.sm}>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="10px"
      letterSpacing="0.28em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textSecondary}
    >
      why carry here
    </Text>
    <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr 1fr', lg: 'repeat(4, 1fr)' }} gap={SPACING.md}>
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
            color={SEMANTIC_COLORS.success}
          >
            <Text
              as="span"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="10px"
              letterSpacing="0.2em"
              color={SEMANTIC_COLORS.textTertiary}
              mr={SPACING.sm}
              verticalAlign="middle"
            >
              {String(i + 1).padStart(2, '0')}
            </Text>
            {CARRY_CLAIM_TITLES[i]}
          </Text>
          <Text fontSize="13px" lineHeight={1.55} color={SEMANTIC_COLORS.textSecondary}>
            {line}
          </Text>
        </Box>
      ))}
    </Box>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.warning}>
      {CARRY_CLAIMS_CAVEAT}
    </Text>
  </Box>
)

export default ClaimsBlock
