import React from 'react'
import { VStack, Text, Box, HStack } from '@chakra-ui/react'
import { DiscoSectionData } from './DiscoSection.hooks'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

type DiscoSectionCumulativeTotalsProps = Pick<DiscoSectionData, 'cumulativeTotals' | 'weightedAPR'>

export const DiscoSectionCumulativeTotals: React.FC<DiscoSectionCumulativeTotalsProps> = ({ cumulativeTotals, weightedAPR }) => {
    return (
        <Box mb={4} pb={4} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
            <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} mb={2} justifySelf={"center"}>
                Cumulative Totals
            </Text>
            <VStack spacing={2} align="stretch">
                <HStack justify="space-between">
                    <Text fontSize="md" color={SEMANTIC_COLORS.textSecondary}>
                        Lifetime Earnings
                    </Text>
                    <Text
                        fontSize="md"
                        fontWeight="bold"
                        fontFamily={TYPOGRAPHY.fontMono}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        {cumulativeTotals.lifetime.toFixed(2)} CDT
                    </Text>
                </HStack>
                <HStack justify="space-between">
                    <Text fontSize="md" color={SEMANTIC_COLORS.textSecondary}>
                        Weighted Avg APR
                    </Text>
                    <Text
                        fontSize="md"
                        fontWeight="bold"
                        fontFamily={TYPOGRAPHY.fontMono}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        {weightedAPR.toFixed(2)}%
                    </Text>
                </HStack>
                <HStack justify="space-between">
                    <Text fontSize="md" color={SEMANTIC_COLORS.textSecondary}>
                        Claimable CDT
                    </Text>
                    <Text
                        fontSize="md"
                        color={SEMANTIC_COLORS.success}
                        fontWeight="bold"
                        fontFamily={TYPOGRAPHY.fontMono}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        +{cumulativeTotals.claimable.toFixed(2)} CDT
                    </Text>
                </HStack>
            </VStack>
        </Box>
    )
}
