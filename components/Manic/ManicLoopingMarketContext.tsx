import React from 'react'
import { Box, Card, VStack, Text, Grid, GridItem } from '@chakra-ui/react'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { CompactBoostSimulator } from './CompactBoostSimulator'

interface ManicLoopingMarketContextProps {
    globalManicTVL: number
    maxAPR: number
    baseAPR: number
    onBoostChange: (multiplier: number) => void
}

/**
 * ManicLoopingMarketContext
 *
 * Row 1 of the ManicLooping screen: global (non-personal) market context —
 * Global Manic TVL, Max APR, and the compact boost simulator. Extracted
 * verbatim; closures over the parent's state become explicit props.
 */
export const ManicLoopingMarketContext: React.FC<ManicLoopingMarketContextProps> = ({
    globalManicTVL,
    maxAPR,
    baseAPR,
    onBoostChange,
}) => {
    return (
        <Grid
            templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)' }}
            gap={SPACING_PATTERNS.sectionGap}
            w="100%"
        >
            {/* Slot 1: VStack with Global Manic TVL and Max APR */}
            <GridItem>
                <VStack spacing={SPACING.base} align="stretch" h="100%" display="flex">
                    <Card
                        borderRadius={0}
                        p={SPACING_PATTERNS.cardPadding}
                        flex={1}
                        display="flex"
                        flexDirection="column"
                    >
                        <VStack align="start" spacing={SPACING.sm}>
                            <Text
                                fontSize={TYPOGRAPHY.label}
                                color={SEMANTIC_COLORS.textSecondary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textTransform="uppercase"
                                letterSpacing="0.28em"
                            >
                                Global Manic TVL
                            </Text>
                            <Text
                                fontSize="3xl"
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.info}
                                fontFamily={TYPOGRAPHY.fontMono}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {globalManicTVL > 0 ? `${globalManicTVL.toFixed(2)} USDC` : '—'}
                            </Text>
                        </VStack>
                    </Card>
                    <Card
                        borderRadius={0}
                        p={SPACING_PATTERNS.cardPadding}
                        flex={1}
                        display="flex"
                        flexDirection="column"
                    >
                        <VStack align="start" spacing={SPACING.sm}>
                            <Text
                                fontSize={TYPOGRAPHY.label}
                                color={SEMANTIC_COLORS.textSecondary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                textTransform="uppercase"
                                letterSpacing="0.28em"
                            >
                                Max APR
                            </Text>
                            <Text
                                fontSize="3xl"
                                fontWeight={TYPOGRAPHY.bold}
                                color={SEMANTIC_COLORS.primary}
                                fontFamily={TYPOGRAPHY.fontMono}
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                                {maxAPR.toFixed(2)}%
                            </Text>
                        </VStack>
                    </Card>
                </VStack>
            </GridItem>

            {/* Slot 2: Compact Boost Simulator */}
            <GridItem>
                <Box h="100%" display="flex" alignItems="center">
                    <CompactBoostSimulator
                        baseAPR={baseAPR}
                        onBoostChange={onBoostChange}
                    />
                </Box>
            </GridItem>
        </Grid>
    )
}

export default ManicLoopingMarketContext
