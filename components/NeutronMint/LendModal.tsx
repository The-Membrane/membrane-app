import React, { useEffect } from 'react'
import {
    Modal,
    ModalOverlay,
    ModalContent,
    ModalHeader,
    ModalCloseButton,
    ModalBody,
    VStack,
    HStack,
    Box,
    Text,
    Button,
    Image,
} from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useLendModal } from './hooks/useLendModal'
import { LendModalAmountInput } from './LendModalAmountInput'
import { LendModalRewardPreview } from './LendModalRewardPreview'
import useAcquisitionDeposit from '@/components/acquisition/hooks/useAcquisitionDeposit'
import { getSlotLabel } from '@/components/Disco/types'

interface LendModalProps {
    isOpen: boolean
    onClose: () => void
}

export const LendModal: React.FC<LendModalProps> = ({ isOpen, onClose }) => {
    const lendModal = useLendModal()

    const {
        depositAmount,
        lockDays,
        sliderValue,
        walletBalance,
        projectedPoints,
        projectedShare,
        projectedMbrn,
        acquisitionModel,
        mostProfitableSlot5,
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,
        reset,
    } = lendModal

    // Reset when modal closes
    useEffect(() => {
        if (!isOpen) {
            reset()
        }
    }, [isOpen, reset])

    // Transaction hook — auto-sets MBRN claim intent to most profitable slot 5 asset
    const deposit = useAcquisitionDeposit({
        lockDays,
        amount: depositAmount > 0 ? depositAmount.toString() : '0',
        intentAsset: mostProfitableSlot5?.asset,
        intentSlot: mostProfitableSlot5?.slot,
        txSuccess: () => {
            onClose()
            reset()
        },
    })

    const isLoading = deposit?.action?.simulate?.isLoading || deposit?.action?.tx?.isPending
    const isDisabled = depositAmount <= 0 || depositAmount > walletBalance || !deposit?.action?.simulate?.data

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" isCentered>
            <ModalOverlay bg="blackAlpha.800" />
            <ModalContent
                bg="rgba(10, 10, 10, 0.95)"
                border="1px solid"
                borderColor="whiteAlpha.200"
                borderRadius="lg"
                maxW="520px"
            >
                <ModalHeader>
                    <HStack spacing={3}>
                        <Image
                            src="/images/usdc.svg"
                            alt="USDC"
                            w="32px"
                            h="32px"
                            borderRadius="full"
                            fallbackSrc="/images/default-token.svg"
                        />
                        <Text color="white" fontSize={TYPOGRAPHY.h3} fontWeight={TYPOGRAPHY.bold}>
                            Lend USDC
                        </Text>
                    </HStack>
                </ModalHeader>
                <ModalCloseButton color="whiteAlpha.600" _hover={{ color: 'white' }} />

                <ModalBody pb={6}>
                    <VStack spacing={5} align="stretch">
                        {/* Amount Input Section */}
                        <LendModalAmountInput
                            walletBalance={walletBalance}
                            depositAmount={depositAmount}
                            sliderValue={sliderValue}
                            handleAmountChange={handleAmountChange}
                            handleSliderChange={handleSliderChange}
                            handleMaxClick={handleMaxClick}
                        />

                        {/* Lend Button */}
                        <Button
                            size="lg"
                            colorScheme="purple"
                            bg="purple.500"
                            _hover={{ bg: 'purple.600' }}
                            isDisabled={isDisabled}
                            isLoading={isLoading}
                            onClick={() => deposit?.action?.tx?.mutate()}
                            fontWeight="bold"
                            fontSize="md"
                            w="full"
                        >
                            Lend USDC →
                        </Button>

                        {/* Error messages */}
                        {depositAmount > walletBalance && walletBalance > 0 && (
                            <Text color="red.400" fontSize="sm" textAlign="center">
                                Insufficient USDC balance
                            </Text>
                        )}
                        {deposit?.action?.simulate?.isError && (
                            <Text color="red.400" fontSize="sm" textAlign="center">
                                {deposit.action.simulate.error?.message || 'Transaction simulation failed'}
                            </Text>
                        )}

                        {/* Reward Preview */}
                        <LendModalRewardPreview
                            depositAmount={depositAmount}
                            projectedPoints={projectedPoints}
                            projectedShare={projectedShare}
                            acquisitionModel={acquisitionModel}
                            projectedMbrn={projectedMbrn}
                        />

                        {/* Warning Cards */}
                        <VStack spacing={3} align="stretch">
                            {/* Vesting Cliff Warning */}
                            <Box
                                bg="rgba(251, 191, 36, 0.05)"
                                borderRadius="md"
                                p={3}
                                border="1px solid"
                                borderColor="rgba(251, 191, 36, 0.3)"
                            >
                                <Text color="yellow.200" fontSize="xs" fontWeight="medium" mb={1}>
                                    Vesting Cliff
                                </Text>
                                <Text color="whiteAlpha.600" fontSize="xs" lineHeight="1.5">
                                    MBRN rewards vest at a cliff. Withdrawing any portion of your deposit forfeits all accrued rewards.
                                </Text>
                            </Box>

                            {/* Stablecoin Yield Info */}
                            {mostProfitableSlot5 && (
                                <Box
                                    bg="rgba(34, 211, 238, 0.05)"
                                    borderRadius="md"
                                    p={3}
                                    border="1px solid"
                                    borderColor="rgba(34, 211, 238, 0.3)"
                                >
                                    <Text color="cyan.200" fontSize="xs" fontWeight="medium" mb={1}>
                                        Stablecoin Yield
                                    </Text>
                                    <Text color="whiteAlpha.600" fontSize="xs" lineHeight="1.5">
                                        Your MBRN rewards will be earning you stablecoin yield in the {mostProfitableSlot5.symbol} Slot {mostProfitableSlot5.slot} ({getSlotLabel(mostProfitableSlot5.slot)}) insurance tranche.
                                    </Text>
                                </Box>
                            )}

                            {/* Liquidity Risk Info */}
                            <Box
                                bg="rgba(96, 165, 250, 0.05)"
                                borderRadius="md"
                                p={3}
                                border="1px solid"
                                borderColor="rgba(96, 165, 250, 0.3)"
                            >
                                <Text color="blue.200" fontSize="xs" fontWeight="medium" mb={1}>
                                    Liquidity
                                </Text>
                                <Text color="whiteAlpha.600" fontSize="xs" lineHeight="1.5">
                                    At the end of the 2 Day withdrawal period, deposits are available to borrow. Withdrawal liquidity depends on borrower utilization — funds may not be immediately available.
                                </Text>
                            </Box>
                        </VStack>
                    </VStack>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}
