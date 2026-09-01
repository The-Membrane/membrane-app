import React, { ChangeEvent } from 'react'
import {
    VStack,
    HStack,
    Text,
    Input,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
    Button,
    IconButton,
    Tooltip,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { LoopCapacitySection } from './LoopCapacitySection'

interface AdjustLoopPanelProps {
    currentLoopLevel: number
    boostMultiplier: number
    handleBoostInputChange: (e: ChangeEvent<HTMLInputElement>) => void
    handleBoostChange: (val: number) => void
    userAPR: number
    projectedAPR: number
    funnelFillRatio: number
    transmuterUSDCBalance: number
    requiredCapacity: number
    isValidLoop: boolean
    handleLoopSubmit: () => void
}

export const AdjustLoopPanel: React.FC<AdjustLoopPanelProps> = ({
    currentLoopLevel,
    boostMultiplier,
    handleBoostInputChange,
    handleBoostChange,
    userAPR,
    projectedAPR,
    funnelFillRatio,
    transmuterUSDCBalance,
    requiredCapacity,
    isValidLoop,
    handleLoopSubmit,
}) => {
    return (
        <VStack spacing={SPACING.lg} align="stretch">
            <VStack spacing={SPACING.md} align="stretch">
                <HStack justify="space-between" align="center">
                    <HStack spacing={SPACING.sm}>
                        <Text
                            fontSize={TYPOGRAPHY.label}
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                        >
                            Target Loop Level
                        </Text>
                        <Tooltip
                            label="Increase your loop multiplier to boost your APR. Requires additional capacity."
                            hasArrow
                        >
                            <IconButton
                                aria-label="Loop Info"
                                icon={<InfoIcon />}
                                size="xs"
                                variant="ghost"
                                color={SEMANTIC_COLORS.textSecondary}
                                transition={TRANSITIONS.colors}
                                _hover={HOVER_EFFECTS.brighten}
                                _active={ACTIVE_EFFECTS.dim}
                                _focus={FOCUS_STYLES.ring}
                            />
                        </Tooltip>
                    </HStack>
                    <HStack spacing={SPACING.sm}>
                        <Text
                            fontSize={TYPOGRAPHY.small}
                            color={SEMANTIC_COLORS.textTertiary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            Current: {currentLoopLevel.toFixed(1)}x
                        </Text>
                        <Input
                            value={boostMultiplier.toFixed(1)}
                            onChange={handleBoostInputChange}
                            size="sm"
                            w="60px"
                            textAlign="center"
                            aria-label="Target loop level"
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            color={SEMANTIC_COLORS.info}
                            fontWeight={TYPOGRAPHY.bold}
                            borderRadius={0}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                            _focus={FOCUS_STYLES.ring}
                        />
                        <Text
                            fontSize={TYPOGRAPHY.small}
                            color={SEMANTIC_COLORS.info}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontWeight={TYPOGRAPHY.bold}
                        >
                            x
                        </Text>
                    </HStack>
                </HStack>

                <Slider
                    value={boostMultiplier}
                    onChange={handleBoostChange}
                    min={currentLoopLevel}
                    max={10}
                    step={0.1}
                    aria-label="Target loop level slider"
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
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    <Text>{currentLoopLevel.toFixed(1)}x</Text>
                    <Text>10x</Text>
                </HStack>

                <HStack
                    justify="space-between"
                    pt={SPACING.sm}
                    borderTop="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                >
                    <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                        Current APR:
                    </Text>
                    <Text
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontWeight={TYPOGRAPHY.bold}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        {userAPR.toFixed(2)}%
                    </Text>
                </HStack>
                <HStack justify="space-between">
                    <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                        Projected APR:
                    </Text>
                    <Text
                        fontSize={TYPOGRAPHY.h4}
                        color={SEMANTIC_COLORS.info}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontWeight={TYPOGRAPHY.bold}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        {projectedAPR.toFixed(2)}%
                    </Text>
                </HStack>
            </VStack>

            {/* Loop Capacity */}
            <LoopCapacitySection
                funnelFillRatio={funnelFillRatio}
                transmuterUSDCBalance={transmuterUSDCBalance}
                requiredCapacity={requiredCapacity}
            />

            <Button
                size="lg"
                isDisabled={!isValidLoop}
                onClick={handleLoopSubmit}
                transition={TRANSITIONS.colors}
                _active={ACTIVE_EFFECTS.dim}
                _focus={FOCUS_STYLES.ring}
            >
                Increase Loop to {boostMultiplier.toFixed(1)}x
            </Button>
        </VStack>
    )
}
