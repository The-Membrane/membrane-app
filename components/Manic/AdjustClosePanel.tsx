import React from 'react'
import { Box, HStack, VStack, Text, Button } from '@chakra-ui/react'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface AdjustClosePanelProps {
    collateralAmount: number
    debtAmount: number
    currentEquity: number
    handleCloseSubmit: () => void
}

export const AdjustClosePanel: React.FC<AdjustClosePanelProps> = ({
    collateralAmount,
    debtAmount,
    currentEquity,
    handleCloseSubmit,
}) => {
    return (
        <VStack spacing={SPACING.lg} align="stretch">
            <Box
                bg={SEMANTIC_COLORS.bgTertiary}
                borderRadius={0}
                p={SPACING_PATTERNS.modalPadding}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.danger}
            >
                <VStack spacing={SPACING.base} align="stretch">
                    <Text
                        fontSize={TYPOGRAPHY.h4}
                        fontWeight={TYPOGRAPHY.bold}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        textTransform="uppercase"
                        letterSpacing="0.12em"
                    >
                        Close Position
                    </Text>
                    <Text
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily={TYPOGRAPHY.fontMono}
                    >
                        This will close your entire position and return all collateral. All debt will be repaid and your position will be closed.
                    </Text>
                    <HStack spacing={SPACING.base} pt={SPACING.sm}>
                        <VStack align="start" spacing={SPACING.xs} flex={1}>
                            <Text
                                fontSize={TYPOGRAPHY.label}
                                color={SEMANTIC_COLORS.textSecondary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textTransform="uppercase"
                                letterSpacing="0.28em"
                            >
                                Collateral
                            </Text>
                            <Text
                                fontSize={TYPOGRAPHY.h4}
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.textPrimary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {collateralAmount.toFixed(2)} USDC
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
                                Debt
                            </Text>
                            <Text
                                fontSize={TYPOGRAPHY.h4}
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.danger}
                                fontFamily={TYPOGRAPHY.fontMono}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {debtAmount.toFixed(2)} USDC
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
                                Equity
                            </Text>
                            <Text
                                fontSize={TYPOGRAPHY.h4}
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.success}
                                fontFamily={TYPOGRAPHY.fontMono}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {currentEquity.toFixed(2)} USDC
                            </Text>
                        </VStack>
                    </HStack>
                </VStack>
            </Box>
            <Button
                size="lg"
                onClick={handleCloseSubmit}
                color={SEMANTIC_COLORS.danger}
                borderColor={SEMANTIC_COLORS.danger}
                transition={TRANSITIONS.colors}
                _hover={{
                    color: SEMANTIC_COLORS.danger,
                    borderColor: SEMANTIC_COLORS.danger,
                    bg: SEMANTIC_COLORS.bgTertiary,
                }}
                _active={ACTIVE_EFFECTS.dim}
                _focus={FOCUS_STYLES.ring}
            >
                Close Position
            </Button>
        </VStack>
    )
}
