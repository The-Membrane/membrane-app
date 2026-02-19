import React, { useMemo, useEffect } from 'react'
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
    Input,
    Button,
    Image,
    Grid,
    GridItem,
} from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { num } from '@/helpers/num'
import { useBorrowModal, type BorrowRate } from './hooks/useBorrowModal'
import { useBorrowRates } from './hooks/useBorrowRates'
import { useBorrowTransaction } from './hooks/useBorrowTransaction'
import { BorrowRateSelector } from './BorrowRateSelector'
import { BorrowModalPositionPreview } from './BorrowModalPositionPreview'
import { Slider, SliderTrack, SliderFilledTrack, SliderThumb, SliderMark } from '@chakra-ui/react'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { getSymbolFromDenom, getLogoFromSymbol } from './types'
import { getMockBorrowData } from './mockBorrowData'
import { stableSymbols } from '@/config/defaults'

// Set to true to use mock data for testing the borrow modal
// Change this to `true` to enable mock data
const USE_MOCK_DATA = process.env.NODE_ENV === 'development' && true

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
    const { chainName } = useChainRoute()

    // Use mock data if enabled, otherwise use real hooks
    const mockData = USE_MOCK_DATA ? getMockBorrowData() : null
    const { data: basketPositions } = useUserPositions()
    const { data: prices } = useOraclePrice()

    // Override with mock data if enabled
    const finalBasketPositions = mockData?.basketPositions || basketPositions
    const finalPrices = mockData?.prices || prices

    const borrowModal = useBorrowModal({ positionIndex, asset })
    const rates = useBorrowRates({ assetSymbol: asset.symbol })

    const {
        selectedRate,
        borrowAmount,
        receiveToWallet,
        sliderValue,
        maxBorrowable,
        currentPosition,
        projectedPosition,
        handleRateChange,
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,
        setReceiveToWallet,
        reset,
    } = borrowModal

    // Reset modal when it closes
    useEffect(() => {
        if (!isOpen) {
            reset()
        }
    }, [isOpen, reset])

    // Get current rate APR
    const currentApr = useMemo(() => {
        return rates.getRate(selectedRate)
    }, [rates, selectedRate])

    // Get liquidity available
    const liquidityAvailable = useMemo(() => {
        // CDT is unlimited (-1), USDC would have actual liquidity
        return asset.symbol === 'CDT' ? -1 : 0 // TODO: Get actual USDC liquidity
    }, [asset.symbol])

    // Build position data for preview
    const positionData = useMemo(() => {
        // Calculate current APY (simplified - would need actual calculation)
        const currentApy = currentPosition.collateralValue > 0
            ? num(currentPosition.debtAmount)
                .dividedBy(currentPosition.collateralValue)
                .times(currentApr)
                .toNumber()
            : 0

        const projectedApy = projectedPosition.collateralValue > 0
            ? num(projectedPosition.debtAmount)
                .dividedBy(projectedPosition.collateralValue)
                .times(currentApr)
                .toNumber()
            : 0

        return {
            current: {
                ...currentPosition,
                apy: currentApy,
            },
            projected: {
                ...projectedPosition,
                apy: projectedApy,
            },
        }
    }, [currentPosition, projectedPosition, currentApr])

    // Build debt composition for preview (dynamic based on current debt and borrow input)
    // TODO: Replace existing debt rate type lookup with actual queries to get debt composition by rate type
    const debtComposition = useMemo(() => {
        const compositionRows: Array<{
            type: string
            rate: number
            ratio: number
        }> = []

        const totalDebt = projectedPosition.debtAmount
        const existingDebt = currentPosition.debtAmount
        const newBorrow = borrowAmount

        if (totalDebt <= 0) {
            return compositionRows
        }

        // Get rate type label
        const getRateTypeLabel = (rate: BorrowRate) => {
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

        if (existingDebt > 0 && newBorrow === 0) {
            // Only existing debt - assume Variable for now (TODO: query actual rate type)
            compositionRows.push({
                type: 'Variable',
                rate: rates.getRate('variable'),
                ratio: 100,
            })
        } else if (existingDebt > 0 && newBorrow > 0) {
            // Existing debt + new borrow
            const existingRatio = num(existingDebt).dividedBy(totalDebt).times(100).toNumber()
            const newRatio = num(newBorrow).dividedBy(totalDebt).times(100).toNumber()

            // If new borrow is also variable, merge them
            if (selectedRate === 'variable') {
                compositionRows.push({
                    type: 'Variable',
                    rate: rates.getRate('variable'),
                    ratio: 100,
                })
            } else {
                // Different rate types - show separately
                // Assume existing debt is Variable (TODO: query actual rate type)
                compositionRows.push({
                    type: 'Variable',
                    rate: rates.getRate('variable'),
                    ratio: existingRatio,
                })
                compositionRows.push({
                    type: getRateTypeLabel(selectedRate),
                    rate: currentApr,
                    ratio: newRatio,
                })
            }
        } else if (newBorrow > 0) {
            // Only new borrow
            compositionRows.push({
                type: getRateTypeLabel(selectedRate),
                rate: currentApr,
                ratio: 100,
            })
        }

        return compositionRows
    }, [currentPosition.debtAmount, projectedPosition.debtAmount, borrowAmount, selectedRate, currentApr, rates])

    // Calculate current Borrow APY (before new borrow)
    const currentBorrowApy = useMemo(() => {
        if (currentPosition.debtAmount <= 0) {
            return 0
        }

        // For current debt, assume Variable rate (TODO: query actual rate types)
        return rates.getRate('variable')
    }, [currentPosition.debtAmount, rates])

    // Calculate projected Borrow APY (after new borrow)
    const projectedBorrowApy = useMemo(() => {
        if (debtComposition.length === 0) {
            return 0
        }

        // Calculate weighted average: sum of (rate * ratio) / 100
        const weightedSum = debtComposition.reduce((sum, row) => {
            return sum + (row.rate * row.ratio)
        }, 0)

        return weightedSum / 100
    }, [debtComposition])

    // Calculate liquidation data
    const liquidationData = useMemo(() => {
        if (!finalBasketPositions || !finalPrices) {
            return { type: 'threshold' as const, value: 0 }
        }

        const positions = getPositions(finalBasketPositions, finalPrices, positionIndex, chainName) || []
        const activePositions = positions.filter(p => p && num(p.amount).isGreaterThan(0))

        if (activePositions.length === 0) {
            return { type: 'threshold' as const, value: 0 }
        }

        // Check if single collateral
        if (activePositions.length === 1) {
            const position = activePositions[0]
            const currentPrice = position.assetPrice || 0
            const liquidationLTV = currentPosition.liquidationLTV || 0

            if (currentPrice > 0 && liquidationLTV > 0 && projectedPosition.debtAmount > 0) {
                // Liquidation price = (debt / (collateral_amount * liquidation_ltv)) * current_price
                const collateralAmount = position.amount
                const liquidationPrice = num(projectedPosition.debtAmount)
                    .dividedBy(num(collateralAmount).times(liquidationLTV).dividedBy(100))
                    .toNumber()

                return {
                    type: 'price' as const,
                    value: liquidationPrice,
                    symbol: position.symbol || 'Asset',
                }
            }
        }

        // Check if 1 volatile + 1 stable
        if (activePositions.length === 2) {
            const volatilePos = activePositions.find(p => !stableSymbols.includes(p.symbol || ''))
            const stablePos = activePositions.find(p => stableSymbols.includes(p.symbol || ''))

            if (volatilePos && stablePos) {
                const currentPrice = volatilePos.assetPrice || 0
                const liquidationLTV = currentPosition.liquidationLTV || 0

                if (currentPrice > 0 && liquidationLTV > 0 && projectedPosition.debtAmount > 0) {
                    // For 1 volatile + stable: liquidation price of the volatile asset
                    // Total collateral value = volatile_value + stable_value
                    // At liquidation: volatile_value * (liquidation_ltv/100) + stable_value = debt
                    // So: volatile_price * volatile_amount * (liquidation_ltv/100) = debt - stable_value
                    // Therefore: volatile_price = (debt - stable_value) / (volatile_amount * liquidation_ltv/100)
                    const stableValue = stablePos.usdValue || 0
                    const volatileAmount = volatilePos.amount
                    const debtMinusStable = Math.max(0, num(projectedPosition.debtAmount).minus(stableValue).toNumber())

                    if (debtMinusStable > 0 && volatileAmount > 0) {
                        const liquidationPrice = num(debtMinusStable)
                            .dividedBy(num(volatileAmount).times(liquidationLTV).dividedBy(100))
                            .toNumber()

                        return {
                            type: 'price' as const,
                            value: liquidationPrice,
                            symbol: volatilePos.symbol || 'Asset',
                        }
                    }
                }
            }
        }

        // For multiple collateral positions, show liquidation threshold
        const liquidationLTV = currentPosition.liquidationLTV || 0
        if (liquidationLTV > 0 && projectedPosition.collateralValue > 0) {
            // Liquidation threshold = collateral_value * (liquidation_ltv / 100)
            const threshold = num(projectedPosition.collateralValue)
                .times(liquidationLTV)
                .dividedBy(100)
                .toNumber()

            return {
                type: 'threshold' as const,
                value: threshold,
            }
        }

        return { type: 'threshold' as const, value: 0 }
    }, [finalBasketPositions, finalPrices, positionIndex, chainName, currentPosition, projectedPosition])

    // Transaction hook
    const borrowTransaction = useBorrowTransaction({
        asset,
        borrowAmount,
        selectedRate,
        receiveToWallet,
        positionIndex,
        enabled: isOpen && borrowAmount > 0,
        onSuccess: () => {
            onClose()
            reset()
        },
    })

    const isLoading = borrowTransaction?.simulate.isLoading || borrowTransaction?.tx.isPending
    const isDisabled = borrowAmount <= 0 || borrowTransaction?.simulate.isError || !borrowTransaction?.simulate.data

    // Get rate label for contextual text
    const getRateLabel = (rate: typeof selectedRate) => {
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
                            <VStack spacing={6} align="stretch">
                                {/* Top Metrics Row */}
                                <Box>
                                    <BorrowRateSelector
                                        selectedRate={selectedRate}
                                        rates={{
                                            variable: rates.variable,
                                            fixed1m: rates.fixed1m,
                                            fixed3m: rates.fixed3m,
                                            fixed6m: rates.fixed6m,
                                        }}
                                        assetSymbol={asset.symbol}
                                        liquidityAvailable={liquidityAvailable}
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
                                            <Box px={2} position="relative">
                                                <Box position="relative" minH="12px" w="100%">
                                                    {/* Hidden range input for accessibility and dragging */}
                                                    <Box
                                                        as="input"
                                                        type="range"
                                                        value={sliderValue}
                                                        onChange={(e) => handleSliderChange(Number(e.target.value))}
                                                        min={0}
                                                        max={100}
                                                        step={1}
                                                        disabled={maxBorrowable <= 0}
                                                        position="absolute"
                                                        zIndex={2}
                                                        w="100%"
                                                        h="12px"
                                                        opacity={0}
                                                        cursor="pointer"
                                                        style={{
                                                            appearance: 'none',
                                                            WebkitAppearance: 'none',
                                                        }}
                                                    />
                                                    {/* Slider track with segments and markers */}
                                                    <HStack
                                                        position="absolute"
                                                        w="100%"
                                                        spacing={1}
                                                        align="center"
                                                        h="4px"
                                                        top="4px"
                                                    >
                                                        {[0, 25, 50, 75, 100].map((mark, index) => {
                                                            const isActive = sliderValue >= mark
                                                            const isLast = index === [0, 25, 50, 75, 100].length - 1
                                                            const nextMark = isLast ? 100 : [0, 25, 50, 75, 100][index + 1]
                                                            const segmentProgress = isLast
                                                                ? 0
                                                                : Math.max(0, Math.min(100, ((sliderValue - mark) / (nextMark - mark)) * 100))

                                                            return (
                                                                <React.Fragment key={mark}>
                                                                    {/* Hexagon marker button */}
                                                                    <Box
                                                                        as="button"
                                                                        type="button"
                                                                        zIndex={20}
                                                                        w="12px"
                                                                        h="12px"
                                                                        outline="none !important"
                                                                        _hover={{
                                                                            opacity: 0.8,
                                                                        }}
                                                                        onClick={() => handleSliderChange(mark)}
                                                                        cursor="pointer"
                                                                        flexShrink={0}
                                                                        display="flex"
                                                                        alignItems="center"
                                                                        justifyContent="center"
                                                                    >
                                                                        <Box
                                                                            as="svg"
                                                                            width="12px"
                                                                            height="12px"
                                                                            viewBox="0 0 12 12"
                                                                        >
                                                                            <polygon
                                                                                points="6,0 10.392,3 10.392,9 6,12 1.608,9 1.608,3"
                                                                                fill={isActive ? '#00D9FF' : 'transparent'}
                                                                                stroke={isActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.4)'}
                                                                                strokeWidth="1.5"
                                                                            />
                                                                        </Box>
                                                                    </Box>
                                                                    {/* Track segment */}
                                                                    {!isLast && (
                                                                        <Box
                                                                            position="relative"
                                                                            flex={1}
                                                                            h="4px"
                                                                            borderRadius="sm"
                                                                            bg="whiteAlpha.100"
                                                                        >
                                                                            <Box
                                                                                position="relative"
                                                                                zIndex={1}
                                                                                h="4px"
                                                                                borderRadius="sm"
                                                                                bg="cyan.400"
                                                                                w={`${segmentProgress}%`}
                                                                                transition="width 0.1s"
                                                                            />
                                                                        </Box>
                                                                    )}
                                                                </React.Fragment>
                                                            )
                                                        })}
                                                    </HStack>
                                                    {/* Draggable thumb */}
                                                    <Box
                                                        position="absolute"
                                                        zIndex={20}
                                                        left={`${sliderValue}%`}
                                                        transform="translate(-50%, 0px)"
                                                        cursor="pointer"
                                                        top="0px"
                                                        display="flex"
                                                        alignItems="center"
                                                        justifyContent="center"
                                                    >
                                                        <Box
                                                            as="svg"
                                                            width="12px"
                                                            height="12px"
                                                            viewBox="0 0 12 12"
                                                            zIndex={20}
                                                            outline="none !important"
                                                            _hover={{
                                                                cursor: 'pointer',
                                                            }}
                                                        >
                                                            <polygon
                                                                points="6,0 10.392,3 10.392,9 6,12 1.608,9 1.608,3"
                                                                fill="#00D9FF"
                                                                stroke="#00E5FF"
                                                                strokeWidth="2"
                                                            />
                                                        </Box>
                                                    </Box>
                                                </Box>
                                            </Box>
                                        </Box>

                                        {/* Receive funds info */}
                                        <Text color="whiteAlpha.400" fontSize="xs" textAlign="left">
                                            Borrowed funds will go directly to your wallet
                                        </Text>

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

