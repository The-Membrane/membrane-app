import React from 'react'
import { HStack, VStack, Text, Progress } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface PositionSummaryProps {
    collateralAmount: number
    currentLoopLevel: number
    userAPR: number
    healthColor: string
    healthLabel: string
    currentLTV: number
}

export const PositionSummary: React.FC<PositionSummaryProps> = ({
    collateralAmount,
    currentLoopLevel,
    userAPR,
    healthColor,
    healthLabel,
    currentLTV,
}) => {
    return (
        <HStack
            spacing={SPACING.lg}
            w="100%"
            justify="space-between"
            pb={SPACING.base}
            borderBottom="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
        >
            <VStack align="start" spacing={SPACING.xs} flex={1}>
                <Text
                    fontSize={TYPOGRAPHY.label}
                    color={SEMANTIC_COLORS.textSecondary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    textTransform="uppercase"
                    letterSpacing="0.28em"
                >
                    Deposited
                </Text>
                <Text
                    fontSize="2xl"
                    fontWeight={TYPOGRAPHY.bold}
                    color={SEMANTIC_COLORS.textPrimary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    {collateralAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
                </Text>
            </VStack>
            <VStack align="start" spacing={SPACING.xs} flex={1}>
                <Text
                    fontSize={TYPOGRAPHY.label}
                    color={SEMANTIC_COLORS.textSecondary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    textTransform="uppercase"
                    letterSpacing="0.28em"
                >
                    Loop Level
                </Text>
                <Text
                    fontSize="2xl"
                    fontWeight={TYPOGRAPHY.bold}
                    color={SEMANTIC_COLORS.info}
                    fontFamily={TYPOGRAPHY.fontMono}
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    {currentLoopLevel.toFixed(1)}x
                </Text>
            </VStack>
            <VStack align="start" spacing={SPACING.xs} flex={1}>
                <Text
                    fontSize={TYPOGRAPHY.label}
                    color={SEMANTIC_COLORS.textSecondary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    textTransform="uppercase"
                    letterSpacing="0.28em"
                >
                    Net APR
                </Text>
                <Text
                    fontSize="2xl"
                    fontWeight={TYPOGRAPHY.bold}
                    color={SEMANTIC_COLORS.success}
                    fontFamily={TYPOGRAPHY.fontMono}
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    {userAPR.toFixed(2)}%
                </Text>
            </VStack>
            <VStack align="start" spacing={SPACING.xs} flex={1}>
                <Text
                    fontSize={TYPOGRAPHY.label}
                    color={SEMANTIC_COLORS.textSecondary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    textTransform="uppercase"
                    letterSpacing="0.28em"
                >
                    Health
                </Text>
                <VStack align="start" spacing={SPACING.xs} w="100%">
                    <HStack spacing={SPACING.sm}>
                        <Text
                            fontSize={TYPOGRAPHY.h4}
                            fontWeight={TYPOGRAPHY.bold}
                            color={healthColor}
                            fontFamily={TYPOGRAPHY.fontMono}
                        >
                            {healthLabel}
                        </Text>
                        <Text
                            fontSize={TYPOGRAPHY.small}
                            color={SEMANTIC_COLORS.textTertiary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            ({currentLTV.toFixed(0)}% LTV)
                        </Text>
                    </HStack>
                    <Progress
                        value={currentLTV}
                        max={100}
                        size="xs"
                        bg={SEMANTIC_COLORS.bgTertiary}
                        borderRadius={0}
                        w="100%"
                        sx={{ '& > div': { backgroundColor: healthColor } }}
                    />
                </VStack>
            </VStack>
        </HStack>
    )
}
