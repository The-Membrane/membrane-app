import React from 'react'
import { VStack, Text, Box, Divider, Button } from '@chakra-ui/react'
import { SectionComponentProps } from '../types'
import { useDiscoSectionData } from './DiscoSection.hooks'
import { DiscoSectionCumulativeTotals } from './DiscoSectionCumulativeTotals'
import { DiscoSectionDepositCarousel } from './DiscoSectionDepositCarousel'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

export const DiscoSection: React.FC<SectionComponentProps & { tabIndex?: number; hideCharts?: boolean }> = ({ onBack, tabIndex = 0, hideCharts = false }) => {
    const {
        totalMBRN,
        depositCarouselData,
        currentDepositIndex,
        currentDeposit,
        showDepositForm,
        showUnstakeForm,
        setShowDepositForm,
        setShowUnstakeForm,
        walletBalanceMBRN,
        claimHook,
        isLoading,
        cumulativeTotals,
        weightedAPR,
        handleDepositCancel,
        handleDepositSubmit,
        handleUnstakeCancel,
        handleUnstakeSubmit,
        handleClaimAll,
        handlePrevDeposit,
        handleNextDeposit,
        handlePageClick,
    } = useDiscoSectionData()

    // Data Tab (index 0)
    if (tabIndex === 0) {
        return (
            <VStack spacing={3} align="stretch" w="100%" overflowX="hidden">
                <Box>
                    <VStack>
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                            Total MBRN
                        </Text>
                        <Text fontSize="lg" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary} mb={3}>
                            {totalMBRN > 0 ? `${totalMBRN.toFixed(2)} MBRN` : '—'}
                        </Text>
                    </VStack>
                </Box>

                {depositCarouselData.length > 0 && (
                    <>
                        <Divider mb={4} />

                        {/* Cumulative totals */}
                        <DiscoSectionCumulativeTotals
                            cumulativeTotals={cumulativeTotals}
                            weightedAPR={weightedAPR}
                        />

                        {/* Claim action button */}
                        <Box mb={4}>
                            <Button
                                w="100%"
                                color={SEMANTIC_COLORS.bgPrimary}
                                bg={SEMANTIC_COLORS.primary}
                                border="1px solid"
                                borderColor={SEMANTIC_COLORS.borderSubtle}
                                borderRadius={0}
                                fontFamily={TYPOGRAPHY.fontMono}
                                transition={TRANSITIONS.colors}
                                _hover={HOVER_EFFECTS.borderHighlight}
                                _active={ACTIVE_EFFECTS.dim}
                                _focus={FOCUS_STYLES.ring}
                                _focusVisible={FOCUS_STYLES.ring}
                                size="md"
                                onClick={handleClaimAll}
                                isLoading={claimHook.action?.tx?.isPending}
                                isDisabled={!claimHook.msgs?.length || cumulativeTotals.claimable <= 0}
                            >
                                Claim All
                            </Button>
                        </Box>

                        <DiscoSectionDepositCarousel
                            depositCarouselData={depositCarouselData}
                            currentDepositIndex={currentDepositIndex}
                            currentDeposit={currentDeposit}
                            showDepositForm={showDepositForm}
                            showUnstakeForm={showUnstakeForm}
                            setShowDepositForm={setShowDepositForm}
                            setShowUnstakeForm={setShowUnstakeForm}
                            walletBalanceMBRN={walletBalanceMBRN}
                            handleDepositCancel={handleDepositCancel}
                            handleDepositSubmit={handleDepositSubmit}
                            handleUnstakeCancel={handleUnstakeCancel}
                            handleUnstakeSubmit={handleUnstakeSubmit}
                            handlePrevDeposit={handlePrevDeposit}
                            handleNextDeposit={handleNextDeposit}
                            handlePageClick={handlePageClick}
                        />
                    </>
                )}

                {depositCarouselData.length === 0 && !isLoading && (
                    <Box>
                        <Text fontSize="xs" color={SEMANTIC_COLORS.textTertiary} textAlign="center">
                            No deposits found
                        </Text>
                    </Box>
                )}
            </VStack>
        )
    }

    // Metrics Tab (index 1)
    if (tabIndex === 1) {
        return (
            <Box>
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={2}>
                    No metrics available
                </Text>
            </Box>
        )
    }

    // Actions Tab (index 2)
    return (
        <Box>
            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={2}>
                Navigate to Disco page for actions
            </Text>
        </Box>
    )
}
