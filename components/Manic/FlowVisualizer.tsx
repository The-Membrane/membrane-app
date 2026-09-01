import React, { useState } from 'react'
import { Box, VStack, HStack, Text, Slider, SliderTrack, SliderFilledTrack, SliderThumb, IconButton, Tooltip } from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { GlowingUSDC } from './GlowingUSDC'

interface FlowVisualizerProps {
    transmuterBalance: number
    baseAPR: number
    fillRatio: number
    onBoostChange?: (multiplier: number) => void
    showLoopCapacity?: boolean
}

export const FlowVisualizer: React.FC<FlowVisualizerProps> = ({
    transmuterBalance,
    baseAPR,
    fillRatio,
    onBoostChange,
    showLoopCapacity = true
}) => {
    const [boostMultiplier, setBoostMultiplier] = useState(1)
    const exampleCollateral = 1000 // Example 1000 USDC for simulation

    // Handle slider change and notify parent
    const handleBoostChange = (val: number) => {
        setBoostMultiplier(val)
        onBoostChange?.(val)
    }

    // Calculate boosted APR
    const boostedAPR = baseAPR * boostMultiplier

    // Calculate required capacity to achieve multiplier on example collateral
    // Required capacity = example collateral × multiplier
    const requiredCapacity = exampleCollateral * boostMultiplier

    return (
        <HStack spacing={SPACING.base} w="100%" align="flex-start">
            {/* Boost Simulator Card */}
            <Box
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                p={SPACING_PATTERNS.cardPadding}
                flex={1}
            >
                <VStack spacing={SPACING.base} align="stretch">
                    <HStack justify="space-between" align="center" w="100%">
                        <HStack spacing={SPACING.sm} align="center" flex={1}>
                            <Text
                                fontSize={TYPOGRAPHY.label}
                                color={SEMANTIC_COLORS.textSecondary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textTransform="uppercase"
                                letterSpacing="0.28em"
                                whiteSpace="nowrap"
                                lineHeight="1"
                            >
                                Boost Simulator
                            </Text>
                            <Tooltip
                                label="Simulate the boosted APR and required capacity for a given multiplier. The multiplier represents how much base APR is amplified through looping at 90% LTV."
                                hasArrow
                            >
                                <IconButton
                                    aria-label="Boost Simulator Info"
                                    icon={<InfoIcon />}
                                    size="xs"
                                    variant="ghost"
                                    color={SEMANTIC_COLORS.textSecondary}
                                    transition={TRANSITIONS.colors}
                                    _hover={HOVER_EFFECTS.brighten}
                                    _active={ACTIVE_EFFECTS.dim}
                                    _focus={FOCUS_STYLES.ring}
                                    minW="auto"
                                    w="auto"
                                    h="auto"
                                />
                            </Tooltip>
                        </HStack>
                        <Text
                            fontSize={TYPOGRAPHY.h4}
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.info}
                            fontFamily={TYPOGRAPHY.fontMono}
                            lineHeight="1"
                            whiteSpace="nowrap"
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {boostMultiplier.toFixed(1)}x
                        </Text>
                    </HStack>

                    <Slider
                        value={boostMultiplier}
                        onChange={handleBoostChange}
                        min={1}
                        max={10}
                        step={0.1}
                        aria-label="Boost multiplier slider"
                    >
                        <SliderTrack bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0}>
                            <SliderFilledTrack bg={SEMANTIC_COLORS.info} />
                        </SliderTrack>
                        <SliderThumb borderRadius={0} _focus={FOCUS_STYLES.ring} />
                    </Slider>

                    <HStack
                        justify="space-between"
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textTertiary}
                        fontFamily={TYPOGRAPHY.fontMono}
                    >
                        <Text>1x</Text>
                        <Text>10x</Text>
                    </HStack>

                    <VStack spacing={SPACING.sm} align="stretch" mt={SPACING.base}>
                        <HStack justify="space-between">
                            <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                Example Collateral:
                            </Text>
                            <Text
                                fontSize={TYPOGRAPHY.small}
                                color={SEMANTIC_COLORS.textPrimary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                fontWeight={TYPOGRAPHY.bold}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {exampleCollateral.toLocaleString()} USDC
                            </Text>
                        </HStack>

                        <HStack justify="space-between">
                            <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                Base APR:
                            </Text>
                            <Text
                                fontSize={TYPOGRAPHY.small}
                                color={SEMANTIC_COLORS.textPrimary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                fontWeight={TYPOGRAPHY.bold}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {baseAPR.toFixed(2)}%
                            </Text>
                        </HStack>

                        <HStack justify="space-between">
                            <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                Projected APR:
                            </Text>
                            <Text
                                fontSize={TYPOGRAPHY.small}
                                color={SEMANTIC_COLORS.info}
                                fontFamily={TYPOGRAPHY.fontMono}
                                fontWeight={TYPOGRAPHY.bold}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {boostedAPR.toFixed(2)}%
                            </Text>
                        </HStack>

                        <HStack
                            justify="space-between"
                            mt={SPACING.sm}
                            pt={SPACING.sm}
                            borderTop="1px solid"
                            borderColor={SEMANTIC_COLORS.borderSubtle}
                        >
                            <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                Required Capacity:
                            </Text>
                            <Text
                                fontSize={TYPOGRAPHY.small}
                                color={SEMANTIC_COLORS.success}
                                fontFamily={TYPOGRAPHY.fontMono}
                                fontWeight={TYPOGRAPHY.bold}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {requiredCapacity.toLocaleString()} USDC
                            </Text>
                        </HStack>
                    </VStack>
                </VStack>
            </Box>

            {/* Loop Capacity Card with GlowingUSDC - Informational Only */}
            {showLoopCapacity && (
                <VStack spacing={SPACING.base} w="20%" align="stretch">
                    {/* GlowingUSDC - Decorative */}
                    <Box position="relative" w="100%" display="flex" justifyContent="center">
                        <GlowingUSDC
                            fillRatio={fillRatio}
                        />
                    </Box>

                    {/* Loop Capacity Card - Informational Only */}
                    <Box
                        bg={SEMANTIC_COLORS.bgSecondary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        borderRadius={0}
                        p={SPACING_PATTERNS.cardPadding}
                        w="100%"
                    >
                        <VStack spacing={SPACING.base} align="stretch">
                            <HStack justify="center" align="center" spacing={SPACING.sm}>
                                <Text
                                    fontSize={TYPOGRAPHY.label}
                                    color={SEMANTIC_COLORS.textSecondary}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    textTransform="uppercase"
                                    letterSpacing="0.28em"
                                    textAlign="center"
                                    whiteSpace="nowrap"
                                    lineHeight="1"
                                >
                                    Loop Capacity
                                </Text>
                                <Tooltip
                                    label="The available USDC balance in the Transmuter that can be consumed by the Manic vault for looping operations."
                                    hasArrow
                                >
                                    <IconButton
                                        aria-label="Loop Capacity Info"
                                        icon={<InfoIcon />}
                                        size="xs"
                                        variant="ghost"
                                        color={SEMANTIC_COLORS.textSecondary}
                                        transition={TRANSITIONS.colors}
                                        _hover={HOVER_EFFECTS.brighten}
                                        _active={ACTIVE_EFFECTS.dim}
                                        _focus={FOCUS_STYLES.ring}
                                        minW="auto"
                                        w="auto"
                                        h="auto"
                                    />
                                </Tooltip>
                            </HStack>

                            <Text
                                fontSize={TYPOGRAPHY.h3}
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.textPrimary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textAlign="center"
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {transmuterBalance.toFixed(2)} USDC
                            </Text>
                        </VStack>
                    </Box>
                </VStack>
            )}
        </HStack>
    )
}
