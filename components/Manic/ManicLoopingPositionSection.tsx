import React from 'react'
import { Box, Card, Text } from '@chakra-ui/react'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { UnifiedPositionForm } from './UnifiedPositionForm'
import { ProfitChart } from '@/components/DittoSpeechBox/sections/ProfitChart'
import { ChartDataPoint } from '@/services/manic'

interface ManicLoopingPositionSectionProps {
    positionRef: React.RefObject<HTMLDivElement>
    hasPosition: boolean
    collateralAmount: number
    debtAmount: number
    currentLoopLevel: number
    userAPR: number
    baseAPR: number
    transmuterUSDCBalance: number
    funnelFillRatio: number
    profitData: ChartDataPoint[] | undefined
    isLoadingProfit: boolean
    onDeposit: (amount: string, boostMultiplier: number) => void
    onWithdraw: (amount: string) => void
    onClose: () => void
    onLoop: (boostMultiplier: number) => void
}

/**
 * ManicLoopingPositionSection
 *
 * Row 2 of the ManicLooping screen: the unified position form plus the
 * profit-over-time chart shown once a position exists. Extracted verbatim;
 * closures over the parent's state/handlers become explicit props.
 */
export const ManicLoopingPositionSection: React.FC<ManicLoopingPositionSectionProps> = ({
    positionRef,
    hasPosition,
    collateralAmount,
    debtAmount,
    currentLoopLevel,
    userAPR,
    baseAPR,
    transmuterUSDCBalance,
    funnelFillRatio,
    profitData,
    isLoadingProfit,
    onDeposit,
    onWithdraw,
    onClose,
    onLoop,
}) => {
    return (
        <Box w="100%" ref={positionRef}>
            <Text
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textSecondary}
                fontFamily={TYPOGRAPHY.fontMono}
                textTransform="uppercase"
                letterSpacing="0.28em"
                mb={SPACING.base}
            >
                {hasPosition ? 'Your Position' : 'Create Position'}
            </Text>
            <UnifiedPositionForm
                hasPosition={hasPosition}
                collateralAmount={collateralAmount}
                debtAmount={debtAmount}
                currentLoopLevel={currentLoopLevel}
                userAPR={userAPR}
                baseAPR={baseAPR}
                transmuterUSDCBalance={transmuterUSDCBalance}
                funnelFillRatio={funnelFillRatio}
                onDeposit={onDeposit}
                onWithdraw={onWithdraw}
                onClose={onClose}
                onLoop={onLoop}
            />

            {/* Profit Over Time Chart - Only shown when user has a position */}
            {hasPosition && (
                <Card
                    borderRadius={0}
                    p={SPACING_PATTERNS.modalPadding}
                    mt={SPACING.base}
                >
                    <Text
                        fontSize={TYPOGRAPHY.label}
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        textTransform="uppercase"
                        letterSpacing="0.28em"
                        mb={SPACING.sm}
                    >
                        Profit Over Time
                    </Text>
                    <ProfitChart
                        data={profitData || []}
                        isLoading={isLoadingProfit}
                    />
                </Card>
            )}
        </Box>
    )
}

export default ManicLoopingPositionSection
