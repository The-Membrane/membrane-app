import React from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    CircularProgress,
    CircularProgressLabel,
} from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { useContributionPercentage } from './hooks/useContributionPercentage'
import { ShareButton } from '@/components/ShareableCard/ShareButton'

/**
 * Shows the user's share of system TVL and revenue as plain facts. The old
 * Stabilizer→Prime Engineer tier ladder was removed: it graded 80% wealth
 * share + 20% revenue share, which BADASS_RULESET.md §11 prohibits
 * (progression keyed to capital/returns).
 */
export const ContributionMeter: React.FC = () => {
    const { tvlContribution, revenueContribution } = useContributionPercentage()

    return (
        <Card
            bg={SEMANTIC_COLORS.bgSecondary}
            borderColor={SEMANTIC_COLORS.borderMedium}
            borderRadius={0}
            p={SPACING.lg}
        >
            <VStack spacing={SPACING.base} align="stretch">
                <HStack justify="space-between" align="center">
                    <HStack spacing={SPACING.sm}>
                        <Text
                            fontSize="sm"
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="wide"
                        >
                            System Contribution
                        </Text>
                        <ShareButton cardType="contribution" size="xs" />
                    </HStack>
                </HStack>

                <HStack justify="center" spacing={SPACING.xl}>
                    <VStack spacing={SPACING.sm}>
                        <CircularProgress
                            value={tvlContribution}
                            size="120px"
                            thickness="8px"
                            color={SEMANTIC_COLORS.info}
                            trackColor={SEMANTIC_COLORS.bgTertiary}
                        >
                            <CircularProgressLabel>
                                <VStack spacing={0}>
                                    <Text fontSize="2xl" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                        {tvlContribution.toFixed(2)}%
                                    </Text>
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                        of system TVL
                                    </Text>
                                </VStack>
                            </CircularProgressLabel>
                        </CircularProgress>
                    </VStack>
                </HStack>

                <Box
                    mt={SPACING.base}
                    p={SPACING.base}
                    bg={SEMANTIC_COLORS.bgTertiary}
                    borderRadius={0}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderMedium}
                >
                    <VStack spacing={SPACING.sm} align="stretch">
                        <HStack justify="space-between">
                            <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
                                My deposits back
                            </Text>
                            <Text fontSize="sm" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                {tvlContribution.toFixed(2)}% of TVL
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
                                My share of revenue
                            </Text>
                            <Text fontSize="sm" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                {revenueContribution.toFixed(2)}%
                            </Text>
                        </HStack>
                    </VStack>
                </Box>
            </VStack>
        </Card>
    )
}
