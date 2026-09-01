import React from 'react'
import { VStack, Text, Box, Button } from '@chakra-ui/react'
import { PRIMARY_PURPLE } from './DiscoDepositsShared'
import { DiscoDepositsDetailRows } from './DiscoDepositsDetailRows'
import { DiscoDepositsUnstakeStatus } from './DiscoDepositsUnstakeStatus'
import { DiscoDepositsActions } from './DiscoDepositsActions'
import { DiscoDepositsDepositForm } from './DiscoDepositsDepositForm'
import { DiscoDepositsUnstakeForm } from './DiscoDepositsUnstakeForm'
import { DiscoDepositsPagination } from './DiscoDepositsPagination'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'

type DiscoDepositsCarouselViewProps = Pick<
    DiscoDepositsData,
    | 'currentDeposit'
    | 'depositCarouselData'
    | 'currentDepositIndex'
    | 'showDepositForm'
    | 'showUnstakeForm'
    | 'setShowDeposits'
    | 'setShowDepositForm'
    | 'setShowUnstakeForm'
    | 'depositAmount'
    | 'setDepositAmount'
    | 'walletBalanceMBRN'
    | 'depositHook'
    | 'requestUnstakeHook'
    | 'completeUnstakeHook'
    | 'cancelUnstakeHook'
    | 'handleRequestUnstake'
    | 'handleCompleteUnstake'
    | 'handleCancelUnstake'
    | 'handleDepositSubmit'
    | 'handlePrevDeposit'
    | 'handleNextDeposit'
    | 'handlePageClick'
>

export const DiscoDepositsCarouselView: React.FC<DiscoDepositsCarouselViewProps> = ({
    currentDeposit,
    depositCarouselData,
    currentDepositIndex,
    showDepositForm,
    showUnstakeForm,
    setShowDeposits,
    setShowDepositForm,
    setShowUnstakeForm,
    depositAmount,
    setDepositAmount,
    walletBalanceMBRN,
    depositHook,
    requestUnstakeHook,
    completeUnstakeHook,
    cancelUnstakeHook,
    handleRequestUnstake,
    handleCompleteUnstake,
    handleCancelUnstake,
    handleDepositSubmit,
    handlePrevDeposit,
    handleNextDeposit,
    handlePageClick,
}) => {
    return (
        <Box w="100%">
            {/* Back button */}
            <Button
                mb={4}
                variant="ghost"
                color="whiteAlpha.600"
                fontFamily="mono"
                fontSize="sm"
                onClick={() => setShowDeposits(false)}
                _hover={{ color: 'white', bg: 'rgba(255, 255, 255, 0.1)' }}
            >
                ← Back to Summary
            </Button>

            {/* Centered Deposits Carousel */}
            <Box display="flex" justifyContent="center" w="100%">
                <Box w="100%" maxW="600px">
                    <Text
                        fontSize="lg"
                        fontWeight="bold"
                        color={PRIMARY_PURPLE}
                        fontFamily="mono"
                        letterSpacing="1px"
                        mb={4}
                        textAlign="center"
                    >
                        Deposits ({depositCarouselData.length})
                    </Text>

                    <Box
                        bg="rgba(10, 10, 10, 0.8)"
                        border="2px solid"
                        borderColor={PRIMARY_PURPLE}
                        borderRadius="md"
                        boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                        p={6}
                        minH="300px"
                    >
                        <VStack spacing={4} align="stretch">
                            <DiscoDepositsDetailRows currentDeposit={currentDeposit} />

                            {/* Pending Unstake Status */}
                            {currentDeposit?.pendingUnstake && (
                                <DiscoDepositsUnstakeStatus currentDeposit={currentDeposit} />
                            )}

                            {/* Action Buttons */}
                            {!showDepositForm && !showUnstakeForm ? (
                                <DiscoDepositsActions
                                    currentDeposit={currentDeposit}
                                    completeUnstakeHook={completeUnstakeHook}
                                    cancelUnstakeHook={cancelUnstakeHook}
                                    handleCompleteUnstake={handleCompleteUnstake}
                                    handleCancelUnstake={handleCancelUnstake}
                                    setShowDepositForm={setShowDepositForm}
                                    setShowUnstakeForm={setShowUnstakeForm}
                                />
                            ) : showDepositForm ? (
                                <DiscoDepositsDepositForm
                                    currentDeposit={currentDeposit}
                                    walletBalanceMBRN={walletBalanceMBRN}
                                    depositAmount={depositAmount}
                                    setDepositAmount={setDepositAmount}
                                    setShowDepositForm={setShowDepositForm}
                                    depositHook={depositHook}
                                    handleDepositSubmit={handleDepositSubmit}
                                />
                            ) : (
                                <DiscoDepositsUnstakeForm
                                    setShowUnstakeForm={setShowUnstakeForm}
                                    requestUnstakeHook={requestUnstakeHook}
                                    handleRequestUnstake={handleRequestUnstake}
                                />
                            )}
                        </VStack>
                    </Box>

                    {/* Pagination arrows */}
                    {depositCarouselData.length > 1 && (
                        <DiscoDepositsPagination
                            depositCarouselData={depositCarouselData}
                            currentDepositIndex={currentDepositIndex}
                            handlePrevDeposit={handlePrevDeposit}
                            handleNextDeposit={handleNextDeposit}
                            handlePageClick={handlePageClick}
                        />
                    )}
                </Box>
            </Box>
        </Box>
    )
}
