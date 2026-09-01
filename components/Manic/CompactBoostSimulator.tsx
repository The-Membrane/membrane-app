import React, { useState } from 'react'
import { Box, VStack, HStack, Text, Slider, SliderTrack, SliderFilledTrack, SliderThumb, IconButton, Tooltip } from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { Card } from '@chakra-ui/react'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface CompactBoostSimulatorProps {
    baseAPR: number
    onBoostChange?: (multiplier: number) => void
}

export const CompactBoostSimulator: React.FC<CompactBoostSimulatorProps> = ({
    baseAPR,
    onBoostChange
}) => {
    const [boostMultiplier, setBoostMultiplier] = useState(1)

    // Handle slider change and notify parent
    const handleBoostChange = (val: number) => {
        setBoostMultiplier(val)
        onBoostChange?.(val)
    }

    // Calculate boosted APR
    const boostedAPR = baseAPR * boostMultiplier

    return (
        <Card
            width="100%"
            borderRadius={0}
            p={SPACING_PATTERNS.cardPadding}
        >
            <VStack spacing={SPACING.md} align="stretch">
                <HStack justify="space-between" align="center" w="100%">
                    <HStack spacing={SPACING.sm} align="center">
                        <Text
                            fontSize={TYPOGRAPHY.label}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                            whiteSpace="nowrap"
                        >
                            Boost Simulator
                        </Text>
                        <Tooltip
                            label="Simulate the boosted APR for a given multiplier. The multiplier represents how much base APR is amplified through looping at 90% LTV."
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
                    size="sm"
                    aria-label="Boost multiplier"
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

                <VStack spacing={SPACING.xs} align="stretch" mt={SPACING.sm}>
                    <HStack justify="space-between">
                        <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                            Base APR:
                        </Text>
                        <Text
                            fontSize={TYPOGRAPHY.xs}
                            color={SEMANTIC_COLORS.textPrimary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontWeight={TYPOGRAPHY.bold}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {baseAPR.toFixed(2)}%
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                            Projected:
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
                </VStack>
            </VStack>
        </Card>
    )
}
