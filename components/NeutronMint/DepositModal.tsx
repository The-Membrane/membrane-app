import React, { useEffect } from 'react'
import {
    Modal,
    ModalOverlay,
    ModalContent,
    ModalHeader,
    ModalCloseButton,
    ModalBody,
    HStack,
    Text,
    Image,
    Grid,
} from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useDepositModal } from './hooks/useDepositModal'
import { useDepositTransaction } from './hooks/useDepositTransaction'
import { DepositModalControls } from './DepositModalControls'
import { DepositModalPositionPreview } from './DepositModalPositionPreview'

interface DepositModalProps {
    isOpen: boolean
    onClose: () => void
    asset: {
        symbol: string
        denom: string
        logo: string
        price: number
        decimal?: number
    }
    positionIndex?: number
}

export const DepositModal: React.FC<DepositModalProps> = ({
    isOpen,
    onClose,
    asset,
    positionIndex = 0,
}) => {
    const depositModal = useDepositModal({ positionIndex, asset })

    const {
        depositAmount,
        sliderValue,
        walletBalance,
        currentPosition,
        projectedPosition,
        liquidationData,
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,
        reset,
    } = depositModal

    // Reset when modal closes
    useEffect(() => {
        if (!isOpen) {
            reset()
        }
    }, [isOpen, reset])

    // Transaction hook
    const depositTransaction = useDepositTransaction({
        asset,
        depositAmount,
        positionIndex,
        enabled: isOpen && depositAmount > 0,
        onSuccess: () => {
            onClose()
            reset()
        },
    })

    const isLoading = depositTransaction?.simulate.isLoading || depositTransaction?.tx.isPending
    const isDisabled = depositAmount <= 0 || depositAmount > walletBalance || depositTransaction?.simulate.isError || !depositTransaction?.simulate.data

    const onDepositClick = () => depositTransaction?.tx.mutate()

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="4xl" isCentered>
            <ModalOverlay bg="blackAlpha.800" />
            <ModalContent
                bg="rgba(10, 10, 10, 0.95)"
                border="1px solid"
                borderColor="whiteAlpha.200"
                borderRadius="lg"
                maxW="900px"
            >
                <ModalHeader>
                    <HStack spacing={3}>
                        <Image
                            src={asset.logo}
                            alt={asset.symbol}
                            w="32px"
                            h="32px"
                            borderRadius="full"
                            fallbackSrc="/images/default-token.svg"
                        />
                        <Text color="white" fontSize={TYPOGRAPHY.h3} fontWeight={TYPOGRAPHY.bold}>
                            Deposit {asset.symbol}
                        </Text>
                    </HStack>
                </ModalHeader>
                <ModalCloseButton color="whiteAlpha.600" _hover={{ color: 'white' }} />

                <ModalBody pb={6}>
                    <Grid templateColumns={{ base: '1fr', lg: '1fr 340px' }} gap={6}>
                        {/* Left Column: Deposit Controls */}
                        <DepositModalControls
                            asset={asset}
                            depositAmount={depositAmount}
                            walletBalance={walletBalance}
                            sliderValue={sliderValue}
                            handleAmountChange={handleAmountChange}
                            handleSliderChange={handleSliderChange}
                            handleMaxClick={handleMaxClick}
                            isDisabled={isDisabled}
                            isLoading={isLoading}
                            onDepositClick={onDepositClick}
                            simulateError={depositTransaction?.simulate.isError}
                            simulateErrorMessage={depositTransaction?.simulate.error?.message}
                        />

                        {/* Right Column: Position Preview */}
                        <DepositModalPositionPreview
                            currentPosition={currentPosition}
                            projectedPosition={projectedPosition}
                            liquidationData={liquidationData}
                        />
                    </Grid>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}
