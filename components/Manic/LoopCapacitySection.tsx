import React from 'react'
import { Box, HStack, VStack, Text, Tooltip, IconButton } from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { GlowingUSDC } from './GlowingUSDC'

interface LoopCapacitySectionProps {
    funnelFillRatio: number
    transmuterUSDCBalance: number
    requiredCapacity: number
}

export const LoopCapacitySection: React.FC<LoopCapacitySectionProps> = ({
    funnelFillRatio,
    transmuterUSDCBalance,
    requiredCapacity,
}) => {
    return (
        <VStack
            spacing={SPACING.md}
            align="stretch"
            pt={SPACING.sm}
            borderTop="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
        >
            <HStack justify="center" align="center" spacing={SPACING.sm}>
                <Text
                    fontSize={TYPOGRAPHY.label}
                    color={SEMANTIC_COLORS.textSecondary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    textTransform="uppercase"
                    letterSpacing="0.28em"
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
                    />
                </Tooltip>
            </HStack>

            {/* GlowingUSDC - Decorative */}
            <Box position="relative" w="100%" display="flex" justifyContent="center" py={SPACING.sm}>
                <GlowingUSDC fillRatio={funnelFillRatio} />
            </Box>

            <HStack justify="space-between">
                <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                    Available:
                </Text>
                <Text
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.success}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontWeight={TYPOGRAPHY.bold}
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    {transmuterUSDCBalance.toFixed(2)} USDC
                </Text>
            </HStack>
            <HStack justify="space-between">
                <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                    Required:
                </Text>
                <Text
                    fontSize={TYPOGRAPHY.small}
                    color={requiredCapacity <= transmuterUSDCBalance ? SEMANTIC_COLORS.info : SEMANTIC_COLORS.danger}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontWeight={TYPOGRAPHY.bold}
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    {requiredCapacity.toFixed(2)} USDC
                </Text>
            </HStack>
        </VStack>
    )
}
