import React from 'react'
import {
    Box,
    Card,
    VStack,
    Text,
    Divider
} from '@chakra-ui/react'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { MarketConditionsChart } from './MarketConditionsChart'
import { FlowVisualizer } from './FlowVisualizer'
import { ApplyLoopSection } from './ApplyLoopSection'
import { ManicLoopingHeader } from './ManicLoopingHeader'
import { ManicLoopingMarketContext } from './ManicLoopingMarketContext'
import { ManicLoopingPositionSection } from './ManicLoopingPositionSection'
import { useManicLooping } from './hooks/useManicLooping'

const ManicLooping: React.FC = () => {
    const {
        positionRef,
        targetBoostMultiplier,
        globalManicTVL,
        transmuterUSDCBalance,
        collateralAmount,
        debtAmount,
        currentLoopLevel,
        hasPosition,
        funnelFillRatio,
        aprMetrics,
        marketConditions,
        isLoadingMarketConditions,
        profitData,
        isLoadingProfit,
        isManuallyActive,
        fulfillIntent,
        handleBoostChange,
        handleApplyLoop,
        handleDeposit,
        handleWithdraw,
        handleClose,
        handleLoop,
    } = useManicLooping()

    return (
        <Box
            w="100%"
            minH="100vh"
            bg={SEMANTIC_COLORS.bgPrimary}
            py={SPACING.xl}
            px={SPACING.base}
        >
            <VStack spacing={SPACING.xl} maxW="1400px" mx="auto">
                {/* Header with Boost Card */}
                <ManicLoopingHeader />

                {/* ========== ROW 1: Market Context (Global, Non-Personal) ========== */}
                <ManicLoopingMarketContext
                    globalManicTVL={globalManicTVL}
                    maxAPR={aprMetrics.maxAPR}
                    baseAPR={aprMetrics.baseAPR}
                    onBoostChange={handleBoostChange}
                />

                <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

                {/* ========== ROW 2: Unified Position Form ========== */}
                <ManicLoopingPositionSection
                    positionRef={positionRef}
                    hasPosition={hasPosition}
                    collateralAmount={collateralAmount}
                    debtAmount={debtAmount}
                    currentLoopLevel={currentLoopLevel}
                    userAPR={aprMetrics.userAPR}
                    baseAPR={aprMetrics.baseAPR}
                    transmuterUSDCBalance={transmuterUSDCBalance}
                    funnelFillRatio={funnelFillRatio}
                    profitData={profitData}
                    isLoadingProfit={isLoadingProfit}
                    onDeposit={handleDeposit}
                    onWithdraw={handleWithdraw}
                    onClose={handleClose}
                    onLoop={handleLoop}
                />

                <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

                {/* ========== ROW 3: Loop Configuration (Stateless Simulator) ========== */}
                <Box w="100%">
                    <Text
                        fontSize={TYPOGRAPHY.label}
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        textTransform="uppercase"
                        letterSpacing="0.28em"
                        mb={SPACING.base}
                    >
                        Configure Loop
                    </Text>
                    <FlowVisualizer
                        transmuterBalance={transmuterUSDCBalance}
                        baseAPR={aprMetrics.baseAPR}
                        fillRatio={funnelFillRatio}
                        onBoostChange={handleBoostChange}
                        showLoopCapacity={false}
                    />
                </Box>

                {/* ========== ROW 4: Apply/Adjust (Single CTA) ========== */}
                {hasPosition && (
                    <Box w="100%">
                        <ApplyLoopSection
                            hasPosition={hasPosition}
                            targetLoopLevel={targetBoostMultiplier}
                            currentLoopLevel={currentLoopLevel}
                            baseAPR={aprMetrics.baseAPR}
                            collateralAmount={collateralAmount}
                            transmuterBalance={transmuterUSDCBalance}
                            onApplyLoop={handleApplyLoop}
                            isLoading={fulfillIntent.tx.isPending || isManuallyActive}
                        />
                    </Box>
                )}

                <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

                {/* ========== ROW 5: Historical Market Conditions ========== */}
                <Box w="100%" data-chart="market-conditions">
                    <Text
                        fontSize={TYPOGRAPHY.label}
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        textTransform="uppercase"
                        letterSpacing="0.28em"
                        mb={SPACING.base}
                    >
                        Historical Market Conditions
                    </Text>
                    <Card
                        borderRadius={0}
                        p={SPACING_PATTERNS.modalPadding}
                    >
                        <MarketConditionsChart
                            data={marketConditions || []}
                            isLoading={isLoadingMarketConditions}
                        />
                    </Card>
                </Box>
            </VStack>
        </Box>
    )
}

export default ManicLooping
