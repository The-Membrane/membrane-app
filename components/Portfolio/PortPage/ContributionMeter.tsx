import React from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    CircularProgress,
    CircularProgressLabel,
    Badge,
} from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { useContributionPercentage } from './hooks/useContributionPercentage'
import { ShareButton } from '@/components/ShareableCard/ShareButton'

const tierConfig = {
    Stabilizer: {
        color: SEMANTIC_COLORS.textSecondary,
        threshold: 1,
    },
    Contributor: {
        color: SEMANTIC_COLORS.info,
        threshold: 5,
    },
    'Top 1% Contributor': {
        color: SEMANTIC_COLORS.primary,
        threshold: 10,
    },
    'Prime Engineer': {
        color: SEMANTIC_COLORS.warning,
        threshold: Infinity,
    },
}

export const ContributionMeter: React.FC = () => {
    const { percentage, tvlContribution, revenueContribution, tier } = useContributionPercentage()

    const tierInfo = tierConfig[tier]

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
                    <Badge
                        bg={SEMANTIC_COLORS.bgTertiary}
                        color={tierInfo.color}
                        border="1px solid"
                        borderColor={tierInfo.color}
                        fontSize="xs"
                        px={SPACING.md}
                        py={SPACING.xs}
                        borderRadius={0}
                        fontFamily={TYPOGRAPHY.fontMono}
                        textTransform="uppercase"
                    >
                        {tier}
                    </Badge>
                </HStack>

                <HStack justify="center" spacing={SPACING.xl}>
                    <VStack spacing={SPACING.sm}>
                        <CircularProgress
                            value={percentage}
                            size="120px"
                            thickness="8px"
                            color={tierInfo.color}
                            trackColor={SEMANTIC_COLORS.bgTertiary}
                        >
                            <CircularProgressLabel>
                                <VStack spacing={0}>
                                    <Text fontSize="2xl" fontWeight={TYPOGRAPHY.bold} color={tierInfo.color} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                        {percentage.toFixed(2)}%
                                    </Text>
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                        Total
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
                        <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono} textTransform="uppercase">
                            Contribution Breakdown
                        </Text>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
                                TVL Contribution (80%):
                            </Text>
                            <Text fontSize="sm" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                {tvlContribution.toFixed(2)}%
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
                                Revenue Contribution (20%):
                            </Text>
                            <Text fontSize="sm" color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                {revenueContribution.toFixed(2)}%
                            </Text>
                        </HStack>
                    </VStack>
                </Box>

                <Box
                    mt={SPACING.sm}
                    p={SPACING.md}
                    bg={SEMANTIC_COLORS.bgTertiary}
                    borderRadius={0}
                    border="1px solid"
                    borderColor={tierInfo.color}
                >
                    <Text fontSize="xs" color={tierInfo.color} fontFamily={TYPOGRAPHY.fontMono} textAlign="center" fontStyle="italic">
                        {tier === 'Stabilizer' && 'A silent guardian in the depths. Your presence maintains the balance.'}
                        {tier === 'Contributor' && 'You\'ve carved your mark in the shadows. The system recognizes your resonance.'}
                        {tier === 'Top 1% Contributor' && 'You stand among the elite. Your domain expansion echoes through the network.'}
                        {tier === 'Prime Engineer' && 'A cursed technique master. You are the foundation upon which the system thrives.'}
                    </Text>
                </Box>
            </VStack>
        </Card>
    )
}
