import React from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Progress,
    Tooltip,
    Icon,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import type { ConversionRateRange, ConversionRate } from './hooks/usePointsProgress'

interface PointsProgressFullCardProps {
    totalPoints: number
    level: number
    rank: number | null | undefined
    conversionRateRange: ConversionRateRange | null
    conversionRatesTooltip: ConversionRate[] | null
    progressPercentage: number
}

export const PointsProgressFullCard: React.FC<PointsProgressFullCardProps> = ({
    totalPoints,
    level,
    rank,
    conversionRateRange,
    conversionRatesTooltip,
    progressPercentage,
}) => {
    return (
        <Card
            bg={SEMANTIC_COLORS.bgSecondary}
            borderRadius={0}
            borderColor={SEMANTIC_COLORS.borderMedium}
            p={SPACING.lg}
        >
            <VStack spacing={SPACING.base} align="stretch">
                {/* Header with headline and conversion rate */}
                <HStack justify="flex-end" align="flex-start" w="100%">
                    {/* <Text fontSize="lg" fontWeight="bold" color="white" lineHeight="1.2">
                        Keep earning points towards HIGHER yield
                    </Text> */}
                    {conversionRateRange && (
                        <Tooltip
                            label={
                                <VStack align="start" spacing={SPACING.xs} p={SPACING.sm}>
                                    {conversionRatesTooltip?.map((rate, idx) => (
                                        <HStack key={rate.label} justify="space-between" w="100%">
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.primary}>
                                                {rate.label}:
                                            </Text>
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.medium} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                                {rate.value.toFixed(1)} points
                                            </Text>
                                        </HStack>
                                    ))}
                                </VStack>
                            }
                            hasArrow
                            placement="right"
                            bg={SEMANTIC_COLORS.bgSecondary}
                            color={SEMANTIC_COLORS.textPrimary}
                            borderRadius={0}
                            zIndex={10010}
                        >
                            <HStack
                                spacing={SPACING.xs}
                                cursor="pointer"
                                tabIndex={0}
                                _focus={FOCUS_STYLES.ring}
                                _focusVisible={FOCUS_STYLES.ring}
                            >
                                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono} textAlign="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                    $1 = {conversionRateRange.min.toFixed(1)} - {conversionRateRange.max.toFixed(1)} points
                                </Text>
                                <Icon as={InfoIcon} w={3} h={3} color={SEMANTIC_COLORS.textSecondary} />
                            </HStack>
                        </Tooltip>
                    )}
                </HStack>

                {/* Progress bar */}
                <Box position="relative" py={SPACING.sm}>
                    <Box position="relative">
                        <Progress
                            value={progressPercentage}
                            size="lg"
                            borderRadius={0}
                            bg={SEMANTIC_COLORS.bgTertiary}
                            h="8px"
                            sx={{
                                '& > div': {
                                    background: `linear-gradient(90deg, ${SEMANTIC_COLORS.primary} 0%, ${SEMANTIC_COLORS.info} 100%)`,
                                },
                            }}
                        />
                        {/* Current position indicator */}
                        <Box
                            position="absolute"
                            left={`${progressPercentage}%`}
                            top="50%"
                            transform="translate(-50%, -50%)"
                            w="2px"
                            h="8"
                            bg={SEMANTIC_COLORS.primary}
                            zIndex={2}
                        />
                    </Box>
                </Box>

                {/* Current points display */}
                <HStack justify="space-between" align="center">
                    <VStack align="start" spacing={0}>
                        <Text fontSize="3xl" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} lineHeight="1" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                            {totalPoints.toFixed(0)}
                        </Text>
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                            Total points
                        </Text>
                    </VStack>
                    <HStack spacing={SPACING.sm}>
                        <Box
                            px={SPACING.md}
                            py={SPACING.xs}
                            bg={SEMANTIC_COLORS.bgTertiary}
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.primary}
                            borderRadius={0}
                        >
                            <Text fontSize="sm" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.primary} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                LVL {level}
                            </Text>
                        </Box>
                        {rank && (
                            <Box
                                px={SPACING.md}
                                py={SPACING.xs}
                                bg={SEMANTIC_COLORS.bgTertiary}
                                border="1px solid"
                                borderColor={SEMANTIC_COLORS.info}
                                borderRadius={0}
                            >
                                <Text fontSize="sm" fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                    Rank {rank}
                                </Text>
                            </Box>
                        )}
                    </HStack>
                </HStack>
            </VStack>
        </Card>
    )
}
