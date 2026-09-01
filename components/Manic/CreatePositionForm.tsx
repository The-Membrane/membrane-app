import React, { ChangeEvent } from 'react'
import {
    Card,
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
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Asset } from '@/helpers/chain'
import { DepositAmountInput } from './DepositAmountInput'
import { LoopCapacitySection } from './LoopCapacitySection'

interface CreatePositionFormProps {
    usdcAsset: Asset | null
    usdcBalance: string
    depositAmount: string
    handleDepositAmountChange: (e: ChangeEvent<HTMLInputElement>) => void
    usdDepositValue: string
    maxDeposit: number
    handleMaxDepositClick: () => void
    boostMultiplier: number
    handleBoostInputChange: (e: ChangeEvent<HTMLInputElement>) => void
    handleBoostChange: (val: number) => void
    baseAPR: number
    projectedAPR: number
    funnelFillRatio: number
    transmuterUSDCBalance: number
    requiredCapacity: number
    isValidDeposit: boolean
    handleDepositSubmit: () => void
}

export const CreatePositionForm: React.FC<CreatePositionFormProps> = ({
    usdcAsset,
    usdcBalance,
    depositAmount,
    handleDepositAmountChange,
    usdDepositValue,
    maxDeposit,
    handleMaxDepositClick,
    boostMultiplier,
    handleBoostInputChange,
    handleBoostChange,
    baseAPR,
    projectedAPR,
    funnelFillRatio,
    transmuterUSDCBalance,
    requiredCapacity,
    isValidDeposit,
    handleDepositSubmit,
}) => {
    return (
        <Card
            borderRadius={0}
            p={SPACING_PATTERNS.modalPadding}
            w="100%"
        >
            <VStack spacing={SPACING.lg} align="stretch">
                {/* Header */}
                <HStack justify="space-between" align="center">
                    <Text
                        fontSize={TYPOGRAPHY.h4}
                        fontWeight={TYPOGRAPHY.bold}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        textTransform="uppercase"
                        letterSpacing="0.12em"
                    >
                        Create Position
                    </Text>
                    <Tooltip
                        label="Deposit USDC and configure your loop multiplier to start earning boosted APR."
                        hasArrow
                    >
                        <IconButton
                            aria-label="Form Info"
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

                {/* Deposit Amount Input */}
                <DepositAmountInput
                    depositAmount={depositAmount}
                    handleDepositAmountChange={handleDepositAmountChange}
                    usdDepositValue={usdDepositValue}
                    maxDeposit={maxDeposit}
                    usdcAsset={usdcAsset}
                    usdcBalance={usdcBalance}
                    handleMaxDepositClick={handleMaxDepositClick}
                />

                {/* Boost Multiplier Section */}
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
                                Boost Multiplier
                            </Text>
                            <Tooltip
                                label="The multiplier determines how much your base APR is amplified through looping at 90% LTV."
                                hasArrow
                            >
                                <IconButton
                                    aria-label="Boost Info"
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
                            <Input
                                value={boostMultiplier.toFixed(1)}
                                onChange={handleBoostInputChange}
                                size="sm"
                                w="60px"
                                textAlign="center"
                                aria-label="Boost multiplier"
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

                    {/* APR Display */}
                    <HStack
                        justify="space-between"
                        pt={SPACING.sm}
                        borderTop="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                    >
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

                {/* Loop Capacity Section */}
                <LoopCapacitySection
                    funnelFillRatio={funnelFillRatio}
                    transmuterUSDCBalance={transmuterUSDCBalance}
                    requiredCapacity={requiredCapacity}
                />

                {/* Submit Button */}
                <Button
                    size="lg"
                    isDisabled={!isValidDeposit}
                    onClick={handleDepositSubmit}
                    mt={SPACING.sm}
                    transition={TRANSITIONS.colors}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                >
                    Create Position
                </Button>
            </VStack>
        </Card>
    )
}
