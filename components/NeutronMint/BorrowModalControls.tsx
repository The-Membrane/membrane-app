import React from 'react'
import {
    VStack,
    HStack,
    Box,
    Text,
    Input,
    Button,
    Image,
} from '@chakra-ui/react'
import { num } from '@/helpers/num'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { BorrowRateSelector } from './BorrowRateSelector'
import { BorrowModalRiskSlider } from './BorrowModalRiskSlider'
import type { BorrowRate } from './hooks/useBorrowModal'
import type { BorrowModalAsset, useBorrowModalData } from './hooks/useBorrowModalData'

type BorrowModalData = ReturnType<typeof useBorrowModalData>

// Get rate label for contextual text
const getRateLabel = (rate: BorrowRate) => {
    switch (rate) {
        case 'variable':
            return 'Variable'
        case 'fixed-1m':
            return 'Fixed 1-Month'
        case 'fixed-3m':
            return 'Fixed 3-Month'
        case 'fixed-6m':
            return 'Fixed 6-Month'
        default:
            return 'Variable'
    }
}

interface BorrowModalControlsProps {
    asset: BorrowModalAsset
    selectedRate: BorrowRate
    displayRates: BorrowModalData['displayRates']
    liquidityAvailable: number
    fixedCapacity: number
    isFixed: boolean
    exceedsFixedCap: boolean
    borrowAmount: number
    maxBorrowable: number
    sliderValue: number
    handleRateChange: (rate: BorrowRate) => void
    handleAmountChange: (amount: number) => void
    handleSliderChange: (value: number) => void
    handleMaxClick: () => void
    borrowTransaction: BorrowModalData['borrowTransaction']
    isLoading: BorrowModalData['isLoading']
    isDisabled: BorrowModalData['isDisabled']
}

/**
 * Left-column borrow controls: rate selector, amount input, risk slider, fixed-rate cap
 * notice and the borrow CTA. Presentational — all state/handlers are threaded in from
 * BorrowModal via useBorrowModalData. Declared at module scope so the amount Input does not
 * remount (and lose focus) between keystrokes.
 */
export const BorrowModalControls: React.FC<BorrowModalControlsProps> = ({
    asset,
    selectedRate,
    displayRates,
    liquidityAvailable,
    fixedCapacity,
    isFixed,
    exceedsFixedCap,
    borrowAmount,
    maxBorrowable,
    sliderValue,
    handleRateChange,
    handleAmountChange,
    handleSliderChange,
    handleMaxClick,
    borrowTransaction,
    isLoading,
    isDisabled,
}) => {
    return (
        <VStack spacing={6} align="stretch">
            {/* Top Metrics Row */}
            <Box>
                <BorrowRateSelector
                    selectedRate={selectedRate}
                    rates={displayRates}
                    assetSymbol={asset.symbol}
                    liquidityAvailable={liquidityAvailable}
                    fixedRateCapacity={Number.isFinite(fixedCapacity) ? fixedCapacity : undefined}
                    onRateChange={handleRateChange}
                />
            </Box>

            {/* Amount & Position Section */}
            <Box
                bg="rgba(10, 10, 10, 0.8)"
                borderRadius="lg"
                p={4}
                border="1px solid"
                borderColor="whiteAlpha.200"
            >
                <VStack spacing={4} align="stretch">
                    {/* Contextual label */}
                    <Text color="whiteAlpha.600" fontSize="xs">
                        Borrowing with {getRateLabel(selectedRate)} rate
                    </Text>

                    {/* Amount Input */}
                    <Box>
                        <HStack justify="space-between" mb={2}>
                            <HStack spacing={2}>
                                <Image src={asset.logo} alt={asset.symbol} w="24px" h="24px" borderRadius="full" />
                                <Text color="white" fontSize="lg" fontWeight="medium">
                                    {asset.symbol}
                                </Text>
                            </HStack>
                            <HStack spacing={2}>
                                <Text color="whiteAlpha.600" fontSize="sm">
                                    Max: {num(maxBorrowable).toFixed(2)}
                                </Text>
                                <Button
                                    size="xs"
                                    variant="outline"
                                    colorScheme="cyan"
                                    onClick={handleMaxClick}
                                >
                                    MAX
                                </Button>
                            </HStack>
                        </HStack>

                        <Input
                            value={borrowAmount > 0 ? borrowAmount.toString() : ''}
                            onChange={(e) => {
                                const value = parseFloat(e.target.value) || 0
                                handleAmountChange(value)
                            }}
                            placeholder="0"
                            type="number"
                            bg="rgba(0, 0, 0, 0.3)"
                            borderColor="whiteAlpha.200"
                            color="white"
                            fontSize="2xl"
                            fontWeight="bold"
                            textAlign="right"
                            _focus={{ borderColor: 'cyan.400', boxShadow: '0 0 0 1px cyan.400' }}
                            mb={2}
                        />

                        <HStack justify="space-between" mb={4}>
                            <Text color="whiteAlpha.600" fontSize="sm">
                                ~ ${num(borrowAmount).times(asset.price).toFixed(2)}
                            </Text>
                        </HStack>

                        {/* Risk/Leverage Slider */}
                        <BorrowModalRiskSlider
                            sliderValue={sliderValue}
                            maxBorrowable={maxBorrowable}
                            handleSliderChange={handleSliderChange}
                        />
                    </Box>

                    {/* Receive funds info */}
                    <Text color="whiteAlpha.400" fontSize="xs" textAlign="left">
                        Borrowed funds will go directly to your wallet
                    </Text>

                    {/* Fixed-rate aggregate cap notice */}
                    {isFixed && Number.isFinite(fixedCapacity) && (
                        <Text
                            color={exceedsFixedCap ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.warning}
                            fontSize="xs"
                            textAlign="left"
                        >
                            {exceedsFixedCap
                                ? `Exceeds fixed-rate capacity. Up to ${num(fixedCapacity).toFixed(2)} CDT available at a fixed rate.`
                                : `Fixed-rate capacity remaining: ${num(fixedCapacity).toFixed(2)} CDT`}
                        </Text>
                    )}

                    {/* Borrow Button */}
                    <Button
                        size="lg"
                        colorScheme="cyan"
                        bg="cyan.500"
                        _hover={{ bg: 'cyan.600' }}
                        isDisabled={isDisabled}
                        isLoading={isLoading}
                        onClick={() => borrowTransaction?.tx.mutate()}
                        fontWeight="bold"
                        fontSize="md"
                    >
                        Borrow →
                    </Button>

                    {/* Error message */}
                    {borrowTransaction?.simulate.isError && (
                        <Text color="red.400" fontSize="sm" textAlign="center">
                            {borrowTransaction.simulate.error?.message || 'Transaction simulation failed'}
                        </Text>
                    )}
                </VStack>
            </Box>
        </VStack>
    )
}
