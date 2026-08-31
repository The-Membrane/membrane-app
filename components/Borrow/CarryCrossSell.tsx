import React from 'react'
import { Box, Text, HStack } from '@chakra-ui/react'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

export interface CarryCrossSellProps {
  chainName: string
}

/**
 * Section 03 cross-sell, ported from public/proto/borrow.html (lines
 * ~196-204): Borrow is for debt you spend or hold; Carry is for debt that
 * should work. Links to /[chainName]/carry.
 */
export const CarryCrossSell: React.FC<CarryCrossSellProps> = ({ chainName }) => {
  return (
    <Box mt={SPACING['2xl']}>
      <HStack spacing={SPACING.md} align="baseline" mb={SPACING.sm}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.28em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textSecondary}
        >
          03 /
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2} color={SEMANTIC_COLORS.textPrimary}>
          When the debt should work instead
        </Text>
      </HStack>

      <Card variant="default" p={SPACING.lg}>
        <HStack spacing={SPACING.lg} align="center" flexWrap="wrap">
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} lineHeight={1.7} flex={1} minW="260px">
            Borrow is for debt you intend to use elsewhere — or just hold. If the point of the loan is yield, Carry
            borrows and routes the CDT through venues in one motion, and the venue yield pays the loan’s cost.
          </Text>
          <NextLink href={`/${chainName}/carry`} passHref legacyBehavior>
            <Box
              as="a"
              display="inline-block"
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              color={SEMANTIC_COLORS.textPrimary}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              letterSpacing="0.14em"
              textTransform="uppercase"
              px={SPACING.md}
              py={SPACING.sm}
              transition={TRANSITIONS.colors}
              _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
              _focus={FOCUS_STYLES.ring}
            >
              Open Carry →
            </Box>
          </NextLink>
        </HStack>
      </Card>
    </Box>
  )
}

export default CarryCrossSell
