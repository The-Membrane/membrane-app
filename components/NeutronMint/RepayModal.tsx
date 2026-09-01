import React, { useEffect, useState } from 'react'
import {
    Modal,
    ModalOverlay,
    ModalContent,
    ModalCloseButton,
    ModalBody,
    Grid,
    GridItem,
} from '@chakra-ui/react'
import { useRepayModal } from './hooks/useRepayModal'
import { useRepayTransaction } from './hooks/useRepayTransaction'
import { useRepayLiquidationData } from './hooks/useRepayLiquidationData'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { useChainRoute } from '@/hooks/useChainRoute'
import { getMockBorrowData } from './mockBorrowData'
import { USE_MOCK_DATA } from './devConfig'
import { DEBT_ASSETS, type DebtAssetSymbol } from './RepayModalConstants'
import { RepayModalHeader } from './RepayModalHeader'
import { RepayAmountPanel } from './RepayAmountPanel'
import { RepayPositionPreview } from './RepayPositionPreview'

interface RepayModalProps {
    isOpen: boolean
    onClose: () => void
    positionIndex?: number
    initialAsset?: string
}

export const RepayModal: React.FC<RepayModalProps> = ({
    isOpen,
    onClose,
    positionIndex = 0,
    initialAsset,
}) => {
    const { chainName } = useChainRoute()

    // Selected debt asset
    const [selectedSymbol, setSelectedSymbol] = useState<DebtAssetSymbol>(
        (initialAsset === 'USDC' ? 'USDC' : 'CDT') as DebtAssetSymbol
    )
    const selectedAsset = DEBT_ASSETS.find(a => a.symbol === selectedSymbol) || DEBT_ASSETS[0]

    // Sync with initialAsset when modal opens
    useEffect(() => {
        if (isOpen && initialAsset) {
            setSelectedSymbol(initialAsset === 'USDC' ? 'USDC' : 'CDT')
        }
    }, [isOpen, initialAsset])

    // Use mock data if enabled, otherwise use real hooks
    const mockData = USE_MOCK_DATA ? getMockBorrowData() : null
    const { data: basketPositions } = useUserPositions()
    const { data: prices } = useOraclePrice()

    // Override with mock data if enabled
    const finalBasketPositions = mockData?.basketPositions || basketPositions
    const finalPrices = mockData?.prices || prices

    const repayModal = useRepayModal({ positionIndex })

    const {
        repayAmount,
        sliderValue,
        maxRepayable,
        currentDebt,
        currentPosition,
        projectedPosition,
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,
        reset,
    } = repayModal

    // Reset modal when it closes
    useEffect(() => {
        if (!isOpen) {
            reset()
        }
    }, [isOpen, reset])

    // Calculate liquidation data
    const liquidationData = useRepayLiquidationData({
        finalBasketPositions,
        finalPrices,
        positionIndex,
        chainName,
        currentPosition,
        projectedPosition,
    })

    // Transaction hook
    const repayTransaction = useRepayTransaction({
        repayAmount,
        assetSymbol: selectedAsset.symbol,
        assetDenom: selectedAsset.denom,
        positionIndex,
        enabled: isOpen && repayAmount > 0,
        onSuccess: () => {
            onClose()
            reset()
        },
    })

    const isLoading = repayTransaction?.simulate.isLoading || repayTransaction?.tx.isPending
    const isDisabled = repayAmount <= 0 || repayTransaction?.simulate.isError || !repayTransaction?.simulate.data

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
                <RepayModalHeader
                    selectedAsset={selectedAsset}
                    selectedSymbol={selectedSymbol}
                    debtAssets={DEBT_ASSETS}
                    onSelectSymbol={(symbol) => {
                        setSelectedSymbol(symbol)
                        repayModal.reset()
                    }}
                />
                <ModalCloseButton color="whiteAlpha.600" _hover={{ color: 'white' }} />

                <ModalBody pb={6}>
                    <Grid templateColumns={{ base: '1fr', lg: '1fr 340px' }} gap={6}>
                        {/* Left Column: Repay Controls */}
                        <GridItem>
                            <RepayAmountPanel
                                selectedAsset={selectedAsset}
                                maxRepayable={maxRepayable}
                                repayAmount={repayAmount}
                                sliderValue={sliderValue}
                                handleAmountChange={handleAmountChange}
                                handleSliderChange={handleSliderChange}
                                handleMaxClick={handleMaxClick}
                                isDisabled={isDisabled}
                                isLoading={isLoading}
                                onRepay={() => repayTransaction?.tx.mutate()}
                                simulateIsError={repayTransaction?.simulate.isError}
                                simulateErrorMessage={repayTransaction?.simulate.error?.message}
                            />
                        </GridItem>

                        {/* Right Column: Position Preview */}
                        <GridItem>
                            <RepayPositionPreview
                                currentPosition={currentPosition}
                                projectedPosition={projectedPosition}
                                repayAmount={repayAmount}
                                liquidationData={liquidationData}
                            />
                        </GridItem>
                    </Grid>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}
