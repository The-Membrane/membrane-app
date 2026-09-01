import React, { useState } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Progress,
    Icon,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { ConversionRateRange } from './hooks/usePointsProgress'

interface PointsProgressCompactCardProps {
    totalPoints: number
    level: number
    conversionRateRange: ConversionRateRange | null
    progressPercentage: number
}

export const PointsProgressCompactCard: React.FC<PointsProgressCompactCardProps> = ({
    totalPoints,
    level,
    conversionRateRange,
    progressPercentage,
}) => {
    // Only use hover state for compact version
    // react-doctor(rerender-state-only-in-handlers) FP: drives the hover tooltip's styling in the commented-out block (~L109-122). Keep useState so re-enabling animates; useRef would break it.
    const [isHovered, setIsHovered] = useState(false)

    return (
        <>
            <Box
                bg={SEMANTIC_COLORS.bgSecondary}
                borderRadius={0}
                p={SPACING.base}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
            >
                <VStack spacing={SPACING.md} align="stretch">
                    <HStack justify="flex-end" align="center" w="100%">
                        {/* <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary}>
                            Keep earning points towards HIGHER yield
                        </Text> */}
                        {conversionRateRange && (
                            <HStack
                                spacing={SPACING.xs}
                                onMouseEnter={() => setIsHovered(true)}
                                onMouseLeave={() => setIsHovered(false)}
                                cursor="pointer"
                            >
                                <Text
                                    fontSize={TYPOGRAPHY.xs}
                                    color={SEMANTIC_COLORS.textSecondary}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    textAlign="right"
                                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                                >
                                    $1 = {conversionRateRange.min.toFixed(1)} - {conversionRateRange.max.toFixed(1)} points
                                </Text>
                                <Icon as={InfoIcon} w={3} h={3} color={SEMANTIC_COLORS.textSecondary} />
                            </HStack>
                        )}
                    </HStack>

                    <Box position="relative">
                        <Progress
                            value={progressPercentage}
                            size="md"
                            borderRadius={0}
                            bg={SEMANTIC_COLORS.bgTertiary}
                            sx={{
                                '& > div': {
                                    background: SEMANTIC_COLORS.primary,
                                },
                            }}
                        />
                        <Box
                            position="absolute"
                            left={`${progressPercentage}%`}
                            top="50%"
                            transform="translate(-50%, -50%)"
                            w="2px"
                            h="6"
                            bg={SEMANTIC_COLORS.info}
                            zIndex={2}
                        />
                    </Box>

                    <HStack justify="space-between">
                        <VStack align="start" spacing={SPACING.none}>
                            <Text
                                fontSize={TYPOGRAPHY.h2}
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.primary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {totalPoints.toFixed(0)}
                            </Text>
                            <Text
                                fontSize={TYPOGRAPHY.xs}
                                color={SEMANTIC_COLORS.textSecondary}
                                fontFamily={TYPOGRAPHY.fontMono}
                            >
                                Total points
                            </Text>
                        </VStack>
                        <Box
                            px={SPACING.sm}
                            py={SPACING.xs}
                            bg={SEMANTIC_COLORS.bgTertiary}
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.borderStrong}
                            borderRadius={0}
                        >
                            <Text
                                fontSize={TYPOGRAPHY.label}
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.primary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textTransform="uppercase"
                                letterSpacing="0.28em"
                            >
                                LVL {level}
                            </Text>
                        </Box>
                    </HStack>
                </VStack>
            </Box>

            {/* Fixed position card that animates up from bottom of speechbox on hover - COMPACT VERSION ONLY */}
            {/* {conversionRateRange && conversionRatesTooltip && (
                <Box
                    position="fixed"
                    bottom={isHovered ? "181px" : "16px"}
                    left="16px"
                    w="353px"
                    bg={SEMANTIC_COLORS.bgSecondary}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    borderRadius={0}
                    p={SPACING.md}
                    zIndex={10010}
                    transition="bottom 0.3s ease-in-out, opacity 0.3s ease-in-out"
                    opacity={isHovered ? 1 : 0}
                    pointerEvents={isHovered ? "auto" : "none"}
                >
                    <VStack align="start" spacing={SPACING.sm}>
                        <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary} mb={1}>
                            Conversion Rates
                        </Text>
                        {conversionRatesTooltip.map((rate, idx) => (
                            <HStack key={idx} justify="space-between" w="100%">
                                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                    {rate.label}:
                                </Text>
                                <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary} fontWeight="medium" fontFamily={TYPOGRAPHY.fontMono}>
                                    {rate.value.toFixed(1)} points
                                </Text>
                            </HStack>
                        ))}
                    </VStack>
                </Box>
            )} */}
        </>
    )
}
