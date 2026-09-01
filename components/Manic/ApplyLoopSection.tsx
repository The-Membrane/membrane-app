import React, { useMemo } from 'react'
import {
    Box,
    Card,
    VStack,
    HStack,
    Text,
    Button,
    Tooltip,
} from '@chakra-ui/react'
import { WarningIcon } from '@chakra-ui/icons'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface ApplyLoopSectionProps {
    hasPosition: boolean
    targetLoopLevel: number
    currentLoopLevel: number
    baseAPR: number
    collateralAmount: number
    transmuterBalance: number
    onApplyLoop: () => void
    isLoading?: boolean
}

export const ApplyLoopSection: React.FC<ApplyLoopSectionProps> = ({
    hasPosition,
    targetLoopLevel,
    currentLoopLevel,
    baseAPR,
    collateralAmount,
    transmuterBalance,
    onApplyLoop,
    isLoading = false,
}) => {
    // Calculate new net APR at target loop level
    const targetAPR = baseAPR * targetLoopLevel

    // Calculate required capacity
    // Required = collateral × target multiplier (approximately)
    const requiredCapacity = useMemo(() => {
        if (!hasPosition || collateralAmount <= 0) return 0
        return collateralAmount * targetLoopLevel
    }, [hasPosition, collateralAmount, targetLoopLevel])

    // Check if we can apply the loop
    const canApply = useMemo(() => {
        if (!hasPosition) return false
        if (targetLoopLevel <= currentLoopLevel) return false
        if (requiredCapacity > transmuterBalance) return false
        return true
    }, [hasPosition, targetLoopLevel, currentLoopLevel, requiredCapacity, transmuterBalance])

    // Determine disabled reason
    const disabledReason = useMemo(() => {
        if (!hasPosition) return 'Deposit required to enable looping'
        if (targetLoopLevel <= currentLoopLevel) return 'Target must be higher than current loop level'
        if (requiredCapacity > transmuterBalance) return `Insufficient capacity (need ${requiredCapacity.toLocaleString()} USDC, available ${transmuterBalance.toLocaleString()} USDC)`
        return null
    }, [hasPosition, targetLoopLevel, currentLoopLevel, requiredCapacity, transmuterBalance])

    // Determine button text (must run before any early return so Hook order is stable)
    const buttonText = useMemo(() => {
        if (targetLoopLevel <= currentLoopLevel) {
            return `Current: ${currentLoopLevel.toFixed(1)}×`
        }
        return `Increase Loop to ${targetLoopLevel.toFixed(1)}×`
    }, [targetLoopLevel, currentLoopLevel])

    // Don't render if no position
    if (!hasPosition) {
        return null
    }

    return (
        <Card
            borderRadius={0}
            borderColor={canApply ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
            p={SPACING_PATTERNS.modalPadding}
            w="100%"
            transition={TRANSITIONS.colors}
        >
            <VStack spacing={SPACING.base} align="stretch">
                {/* Header */}
                <Text
                    fontSize={TYPOGRAPHY.label}
                    color={SEMANTIC_COLORS.textSecondary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    textTransform="uppercase"
                    letterSpacing="0.28em"
                >
                    Apply Loop Configuration
                </Text>

                {/* Summary Panel */}
                <HStack spacing={SPACING.xl} w="100%" justify="space-between" flexWrap="wrap">
                    {/* Target Loops */}
                    <VStack align="start" spacing={SPACING.none}>
                        <Text
                            fontSize={TYPOGRAPHY.label}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                        >
                            Target Loop
                        </Text>
                        <HStack spacing={SPACING.sm} align="baseline">
                            <Text
                                fontSize={TYPOGRAPHY.h3}
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.info}
                                fontFamily={TYPOGRAPHY.fontMono}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {targetLoopLevel.toFixed(1)}×
                            </Text>
                            <Text
                                fontSize={TYPOGRAPHY.small}
                                color={SEMANTIC_COLORS.textTertiary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                (from {currentLoopLevel.toFixed(1)}×)
                            </Text>
                        </HStack>
                    </VStack>

                    {/* New Net APR */}
                    <VStack align="start" spacing={SPACING.none}>
                        <Text
                            fontSize={TYPOGRAPHY.label}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                        >
                            Projected APR
                        </Text>
                        <Text
                            fontSize={TYPOGRAPHY.h3}
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.success}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {targetAPR.toFixed(2)}%
                        </Text>
                    </VStack>

                    {/* Required Capacity */}
                    <VStack align="start" spacing={SPACING.none}>
                        <Text
                            fontSize={TYPOGRAPHY.label}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                        >
                            Required Capacity
                        </Text>
                        <Text
                            fontSize={TYPOGRAPHY.h3}
                            fontWeight={TYPOGRAPHY.bold}
                            color={requiredCapacity <= transmuterBalance ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.danger}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {requiredCapacity.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC
                        </Text>
                    </VStack>

                    {/* CTA Button */}
                    <Box>
                        <Tooltip
                            label={disabledReason}
                            isDisabled={canApply}
                            hasArrow
                        >
                            <Button
                                size="lg"
                                onClick={onApplyLoop}
                                isDisabled={!canApply}
                                isLoading={isLoading}
                                px={SPACING.xl}
                                minW="200px"
                                transition={TRANSITIONS.colors}
                                _active={ACTIVE_EFFECTS.dim}
                                _focus={FOCUS_STYLES.ring}
                                _disabled={{
                                    opacity: 0.4,
                                    cursor: 'not-allowed',
                                }}
                            >
                                {buttonText}
                            </Button>
                        </Tooltip>
                    </Box>
                </HStack>

                {/* Inline warning if disabled */}
                {disabledReason && !canApply && (
                    <HStack spacing={SPACING.sm} color={SEMANTIC_COLORS.warning}>
                        <WarningIcon boxSize={3} />
                        <Text fontSize={TYPOGRAPHY.xs} fontFamily={TYPOGRAPHY.fontMono}>
                            {disabledReason}
                        </Text>
                    </HStack>
                )}
            </VStack>
        </Card>
    )
}
