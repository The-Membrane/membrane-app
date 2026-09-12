// THE CARRY CLAIMS — four lines, one caveat. Copy comes only from CARRY_CLAIMS /
// CARRY_CLAIMS_CAVEAT (owner comms list, Sep 2026). Rendered inside CarrySection, so it
// appears under the fold on BOTH builds — it is never mounted standalone any more.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { CARRY_CLAIMS, CARRY_CLAIMS_CAVEAT } from '@/lib/position-sim'

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
    <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={SPACING.md}>
      {CARRY_CLAIMS.map((line) => (
        <Text
          key={line}
          fontSize="15px"
          lineHeight={1.5}
          color={SEMANTIC_COLORS.textPrimary}
          borderLeft="2px solid"
          borderColor={SEMANTIC_COLORS.success}
          pl={SPACING.md}
        >
          {line}
        </Text>
      ))}
    </Box>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.warning}>
      {CARRY_CLAIMS_CAVEAT}
    </Text>
  </Box>
)

export default ClaimsBlock
