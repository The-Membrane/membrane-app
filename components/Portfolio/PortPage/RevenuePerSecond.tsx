import React, { useState, useMemo } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Collapse,
    Divider,
} from '@chakra-ui/react'
import { ChevronDownIcon, ChevronUpIcon } from '@chakra-ui/icons'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { useRevenuePerSecond } from './hooks/useRevenuePerSecond'

interface RevenuePerSecondProps {
    alwaysShowBreakdown?: boolean
}

// Format number with 6 decimal places for per-second rates
const formatRPS = (value: number): string => {
    return value.toFixed(6)
}

export const RevenuePerSecond: React.FC<RevenuePerSecondProps> = ({ alwaysShowBreakdown = false }) => {
    const { revenuePerSecond, cumulativeRevenue, revenuePerSecondBySource } = useRevenuePerSecond()
    const [isExpanded, setIsExpanded] = useState(false)

    // Format cumulative revenue with 6 decimal places - memoized to prevent unnecessary recalculations
    const formattedCumulative = useMemo(() => {
        return cumulativeRevenue.toFixed(6)
    }, [cumulativeRevenue])

    return (
        <Card
            bg={SEMANTIC_COLORS.bgSecondary}
            borderColor={SEMANTIC_COLORS.borderMedium}
            borderRadius={0}
            p={SPACING.lg}
        >
            <VStack spacing={SPACING.base} align="stretch">
                <HStack justify="space-between" align="center">
                    <VStack align="flex-start" spacing={0}>
                        <Text
                            fontSize="sm"
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            textTransform="uppercase"
                            letterSpacing="wide"
                        >
                            Revenue Counter
                        </Text>
                        <Text
                            fontSize="xs"
                            color={SEMANTIC_COLORS.textTertiary}
                            fontFamily={TYPOGRAPHY.fontMono}
                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {formatRPS(revenuePerSecond)}/sec
                        </Text>
                    </VStack>
                    {!alwaysShowBreakdown && (
                        <HStack
                            spacing={SPACING.sm}
                            as="button"
                            type="button"
                            onClick={() => setIsExpanded(!isExpanded)}
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? 'Collapse breakdown' : 'Expand breakdown'}
                            cursor="pointer"
                            transition={TRANSITIONS.colors}
                            _hover={HOVER_EFFECTS.brighten}
                            _focus={FOCUS_STYLES.ring}
                            align="center"
                        >
                            <Text
                                fontSize="xs"
                                color={SEMANTIC_COLORS.textSecondary}
                                fontFamily={TYPOGRAPHY.fontMono}
                            >
                                Breakdown
                            </Text>
                            {/*
                              Plain icon, NOT an IconButton. This whole HStack is already
                              `as="button"`, and a <button> inside a <button> is invalid
                              HTML: the parser auto-closes the outer one, so the real DOM
                              never matches React's tree and hydration fails, forcing the
                              entire page to re-render client-side. The chevron is
                              decorative anyway — it had no onClick of its own.
                            */}
                            <Box as={isExpanded ? ChevronUpIcon : ChevronDownIcon} color={SEMANTIC_COLORS.textSecondary} aria-hidden="true" />
                        </HStack>
                    )}
                </HStack>

                <Box
                    willChange="contents"
                    style={{
                        transform: 'translateZ(0)',
                        backfaceVisibility: 'hidden',
                        WebkitFontSmoothing: 'antialiased',
                    }}
                >
                    <Text
                        fontSize="4xl"
                        fontWeight={TYPOGRAPHY.bold}
                        color={SEMANTIC_COLORS.info}
                        fontFamily={TYPOGRAPHY.fontMono}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                        letterSpacing="tight"
                        style={{
                            transform: 'translateZ(0)',
                            backfaceVisibility: 'hidden',
                            WebkitFontSmoothing: 'antialiased',
                            textRendering: 'optimizeLegibility',
                        }}
                    >
                        ${formattedCumulative}
                    </Text>
                </Box>

                {alwaysShowBreakdown ? (
                    <Box mt={SPACING.base} pt={SPACING.base} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderMedium}>
                        <VStack spacing={SPACING.md} align="stretch">
                            <Text
                                fontSize="xs"
                                color={SEMANTIC_COLORS.textTertiary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textTransform="uppercase"
                                letterSpacing="wide"
                            >
                                Revenue Per Second
                            </Text>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                    Disco
                                </Text>
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                    ${formatRPS(revenuePerSecondBySource.disco)}/sec
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                    Transmuter
                                </Text>
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                    ${formatRPS(revenuePerSecondBySource.transmuter)}/sec
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                    Manic Vault
                                </Text>
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                    ${formatRPS(revenuePerSecondBySource.manic)}/sec
                                </Text>
                            </HStack>
                        </VStack>
                    </Box>
                ) : (
                    <Collapse in={isExpanded} animateOpacity>
                        <Box mt={SPACING.base} pt={SPACING.base} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderMedium}>
                            <VStack spacing={SPACING.md} align="stretch">
                                <Text
                                    fontSize="xs"
                                    color={SEMANTIC_COLORS.textTertiary}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    textTransform="uppercase"
                                    letterSpacing="wide"
                                >
                                    Revenue Per Second
                                </Text>
                                <HStack justify="space-between">
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                        Disco
                                    </Text>
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                        ${formatRPS(revenuePerSecondBySource.disco)}/sec
                                    </Text>
                                </HStack>
                                <HStack justify="space-between">
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                        Transmuter
                                    </Text>
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                        ${formatRPS(revenuePerSecondBySource.transmuter)}/sec
                                    </Text>
                                </HStack>
                                <HStack justify="space-between">
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono}>
                                        Manic Vault
                                    </Text>
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                        ${formatRPS(revenuePerSecondBySource.manic)}/sec
                                    </Text>
                                </HStack>
                            </VStack>
                        </Box>
                    </Collapse>
                )}

            </VStack>
        </Card>
    )
}
