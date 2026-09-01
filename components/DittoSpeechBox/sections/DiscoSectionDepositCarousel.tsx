import React from 'react'
import { VStack, Text, Box, HStack, IconButton, Button } from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import { DiscoDepositForm } from './DiscoDepositForm'
import { DiscoWithdrawForm } from './DiscoWithdrawForm'
import { getSlotLabel } from '@/components/Disco/types'
import { DiscoSectionData } from './DiscoSection.hooks'

import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

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
            <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} mb={2}>
                Deposits ({depositCarouselData.length})
            </Text>

            <Box
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                p={SPACING.base}
                minH="200px"
            >
                <VStack spacing={3} align="stretch">
                    <HStack justify="space-between">
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary}>
                            Asset
                        </Text>
                        <Text fontSize="md" color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">
                            {currentDeposit?.asset || '—'}
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary}>
                            Slot
                        </Text>
                        <Text fontSize="md" color={SEMANTIC_COLORS.primary} fontWeight="bold">
                            {currentDeposit?.slot ? `${getSlotLabel(currentDeposit?.slot || 0)}` : '—'}
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary}>
                            Amount
                        </Text>
                        <Text fontSize="md" color={SEMANTIC_COLORS.textPrimary}>
                            {currentDeposit?.amount.toFixed(2) || '0.00'} MBRN
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary}>
                            Lifetime
                        </Text>
                        <Text fontSize="md" fontWeight="bold">
                            {currentDeposit?.lifetime.toFixed(2) || '0.00'} CDT
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary}>
                            Current APR
                        </Text>
                        <Text fontSize="md" fontWeight="bold">
                            {currentDeposit?.apr.toFixed(2) || '0.00'}%
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary}>
                            Claimable
                        </Text>
                        <Text fontSize="md" color={SEMANTIC_COLORS.success} fontWeight="bold">
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
                                borderColor={SEMANTIC_COLORS.danger}
                                color={SEMANTIC_COLORS.danger}
                                _hover={{ bg: SEMANTIC_COLORS.danger, color: SEMANTIC_COLORS.textPrimary }}
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
                        color={SEMANTIC_COLORS.textPrimary}
                        onClick={handlePrevDeposit}
                        _hover={{ bg: SEMANTIC_COLORS.bgTertiary }}
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
                                bg={index === currentDepositIndex ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textTertiary}
                                _hover={{ bg: index === currentDepositIndex ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary }}
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
                        color={SEMANTIC_COLORS.textPrimary}
                        onClick={handleNextDeposit}
                        _hover={{ bg: SEMANTIC_COLORS.bgTertiary }}
                    />
                </HStack>
            )}
        </Box>
    )
}
