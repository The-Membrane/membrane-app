import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { BoostBreakdown } from '@/components/Manic/BoostBreakdown'

/**
 * ManicLoopingHeader
 *
 * Page header for the ManicLooping screen: title/subtitle plus the boost badge.
 * Extracted verbatim from ManicLooping so the container stays a thin composition.
 */
export const ManicLoopingHeader: React.FC = () => {
    return (
        <HStack w="100%" justify="space-between" align="flex-start" spacing={6}>
            <Box flex={1}>
                <Text
                    as="h1"
                    fontSize={TYPOGRAPHY.h1}
                    fontWeight={TYPOGRAPHY.bold}
                    color={SEMANTIC_COLORS.textPrimary}
                    fontFamily={TYPOGRAPHY.fontDisplay}
                    mb={2}
                >
                    Manic Looping
                </Text>
                <Text
                    fontSize="sm"
                    color={SEMANTIC_COLORS.textSecondary}
                    fontFamily={TYPOGRAPHY.fontMono}
                >
                    Looped USDC Lending
                </Text>
            </Box>
            {/* Boost Badge - Top Right */}
            <Box flexShrink={0}>
                <BoostBreakdown />
            </Box>
        </HStack>
    )
}

export default ManicLoopingHeader
