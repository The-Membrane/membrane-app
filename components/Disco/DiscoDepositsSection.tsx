import React from 'react'
import { VStack, Box } from '@chakra-ui/react'
import { useDiscoDepositsData } from '@/components/Disco/hooks/useDiscoDepositsData'
import { DiscoDepositsTotalCard } from './DiscoDepositsTotalCard'
import { DiscoDepositsSummaryView } from './DiscoDepositsSummaryView'
import { DiscoDepositsCarouselView } from './DiscoDepositsCarouselView'
import { DiscoDepositsEmptyState } from './DiscoDepositsEmptyState'

export const DiscoDepositsSection: React.FC = () => {
    const {
        isLoading,
        totalMBRN,
        depositCarouselData,
        currentDepositIndex,
        currentDeposit,
        showDepositForm,
        setShowDepositForm,
        showUnstakeForm,
        setShowUnstakeForm,
        showDeposits,
        setShowDeposits,
        depositAmount,
        setDepositAmount,
        walletBalanceMBRN,
        depositHook,
        requestUnstakeHook,
        completeUnstakeHook,
        cancelUnstakeHook,
        claimHook,
        cumulativeTotals,
        weightedAPR,
        handleClaimAll,
        handleRequestUnstake,
        handleCompleteUnstake,
        handleCancelUnstake,
        handleDepositSubmit,
        handlePrevDeposit,
        handleNextDeposit,
        handlePageClick,
    } = useDiscoDepositsData()

    return (
        <Box w="100%" maxW="1400px" mx="auto" px={{ base: 4, md: 8 }}>
            <VStack spacing={6} align="stretch" w="100%">
                {/* Total MBRN Display */}
                <DiscoDepositsTotalCard totalMBRN={totalMBRN} />

                {depositCarouselData.length > 0 ? (
                    <>
                        {!showDeposits ? (
                            /* Default View: Cumulative Totals */
                            <DiscoDepositsSummaryView
                                cumulativeTotals={cumulativeTotals}
                                weightedAPR={weightedAPR}
                                claimHook={claimHook}
                                handleClaimAll={handleClaimAll}
                                setShowDeposits={setShowDeposits}
                            />
                        ) : (
                            /* Deposits Carousel View */
                            <DiscoDepositsCarouselView
                                currentDeposit={currentDeposit}
                                depositCarouselData={depositCarouselData}
                                currentDepositIndex={currentDepositIndex}
                                showDepositForm={showDepositForm}
                                showUnstakeForm={showUnstakeForm}
                                setShowDeposits={setShowDeposits}
                                setShowDepositForm={setShowDepositForm}
                                setShowUnstakeForm={setShowUnstakeForm}
                                depositAmount={depositAmount}
                                setDepositAmount={setDepositAmount}
                                walletBalanceMBRN={walletBalanceMBRN}
                                depositHook={depositHook}
                                requestUnstakeHook={requestUnstakeHook}
                                completeUnstakeHook={completeUnstakeHook}
                                cancelUnstakeHook={cancelUnstakeHook}
                                handleRequestUnstake={handleRequestUnstake}
                                handleCompleteUnstake={handleCompleteUnstake}
                                handleCancelUnstake={handleCancelUnstake}
                                handleDepositSubmit={handleDepositSubmit}
                                handlePrevDeposit={handlePrevDeposit}
                                handleNextDeposit={handleNextDeposit}
                                handlePageClick={handlePageClick}
                            />
                        )}
                    </>
                ) : (
                    /* Empty State */
                    <DiscoDepositsEmptyState isLoading={isLoading} />
                )}
            </VStack>
        </Box>
    )
}
