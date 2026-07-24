import React from 'react'
import { VStack, Text, Box, HStack, IconButton, Button } from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import { DiscoDepositForm } from './DiscoDepositForm'
import { DiscoWithdrawForm } from './DiscoWithdrawForm'
import { getSlotLabel } from '@/components/Disco/types'
import { DiscoSectionData } from './DiscoSection.hooks'

type DiscoSectionDepositCarouselProps = Pick<
    DiscoSectionData,
    | 'depositCarouselData'
    | 'currentDepositIndex'
    | 'currentDeposit'
    | 'showDepositForm'
    | 'showUnstakeForm'
    | 'setShowDepositForm'
    | 'setShowUnstakeForm'
    | 'walletBalanceMBRN'
    | 'handleDepositCancel'
    | 'handleDepositSubmit'
    | 'handleUnstakeCancel'
    | 'handleUnstakeSubmit'
    | 'handlePrevDeposit'
    | 'handleNextDeposit'
    | 'handlePageClick'
>

export const DiscoSectionDepositCarousel: React.FC<DiscoSectionDepositCarouselProps> = ({
    depositCarouselData,
    currentDepositIndex,
    currentDeposit,
    showDepositForm,
    showUnstakeForm,
    setShowDepositForm,
    setShowUnstakeForm,
    walletBalanceMBRN,
    handleDepositCancel,
    handleDepositSubmit,
    handleUnstakeCancel,
    handleUnstakeSubmit,
    handlePrevDeposit,
    handleNextDeposit,
    handlePageClick,
}) => {
    return (
        <Box>
            <Text fontSize="sm" color="#ece6d880" mb={2}>
                Deposits ({depositCarouselData.length})
            </Text>

            <Box
                bg="gray.800"
                border="1px solid"
                borderColor="primary.500"
                borderRadius="md"
                p={4}
                minH="200px"
            >
                <VStack spacing={3} align="stretch">
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="#ece6d880">
                            Asset
                        </Text>
                        <Text fontSize="md" color="#ece6d8" fontWeight="bold">
                            {currentDeposit?.asset || '—'}
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="#ece6d880">
                            Slot
                        </Text>
                        <Text fontSize="md" color="primary.300" fontWeight="bold">
                            {currentDeposit?.slot ? `${getSlotLabel(currentDeposit?.slot || 0)}` : '—'}
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="#ece6d880">
                            Amount
                        </Text>
                        <Text fontSize="md" color="#ece6d8">
                            {currentDeposit?.amount.toFixed(2) || '0.00'} MBRN
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="#ece6d880">
                            Lifetime
                        </Text>
                        <Text fontSize="md" fontWeight="bold">
                            {currentDeposit?.lifetime.toFixed(2) || '0.00'} CDT
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="#ece6d880">
                            Current APR
                        </Text>
                        <Text fontSize="md" fontWeight="bold">
                            {currentDeposit?.apr.toFixed(2) || '0.00'}%
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="#ece6d880">
                            Claimable
                        </Text>
                        <Text fontSize="md" color="green.400" fontWeight="bold">
                            +{currentDeposit?.claimable.toFixed(2) || '0.00'} CDT
                        </Text>
                    </HStack>

                    {/* Deposit and Unstake buttons */}
                    {!showDepositForm && !showUnstakeForm ? (
                        <>
                            <HStack spacing={2} mt={2}>
                                <Button
                                    flex={1}
                                    size="sm"
                                    onClick={() => setShowDepositForm(true)}
                                >
                                    Deposit
                                </Button>
                            </HStack>
                            <Button
                                w="100%"
                                size="sm"
                                variant="outline"
                                borderColor="red.500"
                                color="red.400"
                                _hover={{ bg: 'red.500', color: 'white' }}
                                onClick={() => setShowUnstakeForm(true)}
                            >
                                Request Unstake
                            </Button>
                        </>
                    ) : showDepositForm ? (
                        <Box mt={2}>
                            <DiscoDepositForm
                                deposit={{
                                    asset: currentDeposit?.asset || '',
                                    slot: currentDeposit?.slot,
                                    apr: currentDeposit?.apr,
                                }}
                                walletBalanceMBRN={walletBalanceMBRN}
                                onCancel={handleDepositCancel}
                                onSubmit={handleDepositSubmit}
                            />
                        </Box>
                    ) : (
                        <Box mt={2}>
                            <DiscoWithdrawForm
                                deposit={{
                                    asset: currentDeposit?.asset || '',
                                    amount: currentDeposit?.amount || 0,
                                    slot: currentDeposit?.slot,
                                    depositId: currentDeposit?.depositId,
                                    apr: currentDeposit?.apr,
                                }}
                                onCancel={handleUnstakeCancel}
                                onSubmit={handleUnstakeSubmit}
                            />
                        </Box>
                    )}
                </VStack>
            </Box>

            {/* Pagination arrows */}
            {depositCarouselData.length > 1 && (
                <HStack justify="center" spacing={4} mt={4} position="relative">
                    <IconButton
                        aria-label="Previous deposit"
                        icon={<ChevronLeftIcon />}
                        size="sm"
                        variant="ghost"
                        color="#ece6d8"
                        onClick={handlePrevDeposit}
                        _hover={{ bg: 'gray.700' }}
                    />

                    {/* Pagination dots */}
                    <HStack spacing={2}>
                        {depositCarouselData.map((deposit, index) => (
                            <Button
                                key={deposit.depositId}
                                size="xs"
                                minW="8px"
                                h="8px"
                                p={0}
                                borderRadius="full"
                                bg={index === currentDepositIndex ? "primary.500" : "gray.600"}
                                _hover={{ bg: index === currentDepositIndex ? "primary.400" : "gray.500" }}
                                onClick={() => handlePageClick(index)}
                                aria-label={`Go to deposit ${index + 1}`}
                            />
                        ))}
                    </HStack>

                    <IconButton
                        aria-label="Next deposit"
                        icon={<ChevronRightIcon />}
                        size="sm"
                        variant="ghost"
                        color="#ece6d8"
                        onClick={handleNextDeposit}
                        _hover={{ bg: 'gray.700' }}
                    />
                </HStack>
            )}
        </Box>
    )
}
