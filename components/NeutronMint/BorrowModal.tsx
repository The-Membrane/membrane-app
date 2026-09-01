import React from 'react'
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
    GridItem,
} from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useBorrowModalData } from './hooks/useBorrowModalData'
import { BorrowModalControls } from './BorrowModalControls'
import { BorrowModalPositionPreview } from './BorrowModalPositionPreview'

interface BorrowModalProps {
    isOpen: boolean
    onClose: () => void
    asset: {
        symbol: 'CDT' | 'USDC'
        denom: string
        logo: string
        price: number
    }
    positionIndex?: number
}

export const BorrowModal: React.FC<BorrowModalProps> = ({
    isOpen,
    onClose,
    asset,
    positionIndex = 0,
}) => {
    const {
        selectedRate,
        borrowAmount,
        sliderValue,
        maxBorrowable,
        handleRateChange,
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,
        isFixed,
        displayRates,
        liquidityAvailable,
        fixedCapacity,
        exceedsFixedCap,
        positionData,
        debtComposition,
        currentBorrowApy,
        projectedBorrowApy,
        liquidationData,
        borrowTransaction,
        isLoading,
        isDisabled,
    } = useBorrowModalData({ isOpen, onClose, asset, positionIndex })

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="6xl" isCentered>
            <ModalOverlay bg="blackAlpha.800" />
            <ModalContent
                bg="rgba(10, 10, 10, 0.95)"
                border="1px solid"
                borderColor="whiteAlpha.200"
                borderRadius="lg"
                maxW="1200px"
            >
                <ModalHeader>
                    <HStack spacing={3}>
                        <Image src={asset.logo} alt={asset.symbol} w="32px" h="32px" borderRadius="full" />
                        <Text color="white" fontSize={TYPOGRAPHY.h3} fontWeight={TYPOGRAPHY.bold}>
                            Borrow {asset.symbol}
                        </Text>
                    </HStack>
                </ModalHeader>
                <ModalCloseButton color="whiteAlpha.600" _hover={{ color: 'white' }} />

                <ModalBody pb={6}>
                    <Grid templateColumns={{ base: '1fr', lg: '1fr 400px' }} gap={6}>
                        {/* Left Column: Borrow Controls */}
                        <GridItem>
                            <BorrowModalControls
                                asset={asset}
                                selectedRate={selectedRate}
                                displayRates={displayRates}
                                liquidityAvailable={liquidityAvailable}
                                fixedCapacity={fixedCapacity}
                                isFixed={isFixed}
                                exceedsFixedCap={exceedsFixedCap}
                                borrowAmount={borrowAmount}
                                maxBorrowable={maxBorrowable}
                                sliderValue={sliderValue}
                                handleRateChange={handleRateChange}
                                handleAmountChange={handleAmountChange}
                                handleSliderChange={handleSliderChange}
                                handleMaxClick={handleMaxClick}
                                borrowTransaction={borrowTransaction}
                                isLoading={isLoading}
                                isDisabled={isDisabled}
                            />
                        </GridItem>

                        {/* Right Column: Position Preview */}
                        <GridItem>
                            <BorrowModalPositionPreview
                                positionData={positionData}
                                debtComposition={debtComposition}
                                assetSymbol={asset.symbol}
                                assetLogo={asset.logo}
                                currentBorrowApy={currentBorrowApy}
                                projectedBorrowApy={projectedBorrowApy}
                                liquidationData={liquidationData}
                            />
                        </GridItem>
                    </Grid>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}
