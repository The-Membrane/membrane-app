import React, { useMemo, useEffect, useState } from 'react'
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
    Progress,
    Tooltip,
    Menu,
    MenuButton,
    MenuItem,
    MenuList,
} from '@chakra-ui/react'
import { ChevronDownIcon, InfoOutlineIcon } from '@chakra-ui/icons'
import { TYPOGRAPHY } from '@/helpers/typography'
import { num } from '@/helpers/num'
import { useRepayModal } from './hooks/useRepayModal'
import { useRepayTransaction } from './hooks/useRepayTransaction'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { getMockBorrowData } from './mockBorrowData'
import { stableSymbols } from '@/config/defaults'

// Set to true to use mock data for testing the repay modal
const USE_MOCK_DATA = process.env.NODE_ENV === 'development' && true

type DebtAssetSymbol = 'CDT' | 'USDC'

const DEBT_ASSETS: { symbol: DebtAssetSymbol; logo: string; denom: string }[] = [
    { symbol: 'CDT', logo: '/images/cdt.svg', denom: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt' },
    { symbol: 'USDC', logo: '/images/usdc.svg', denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4' },
]

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
            const currentPrice = (position as any).assetPrice || 0
            const liquidationLTV = currentPosition.liquidationLTV || 0

            if (currentPrice > 0 && liquidationLTV > 0 && projectedPosition.debtAmount > 0) {
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
                const liquidationLTV = currentPosition.liquidationLTV || 0

                if (liquidationLTV > 0 && projectedPosition.debtAmount > 0) {
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

    // Health bar color
    const getHealthColor = (health: number) => {
        if (health >= 80) return 'green'
        if (health >= 50) return 'yellow'
        if (health >= 20) return 'orange'
        return 'red'
    }

    // Deltas
    const debtDelta = num(projectedPosition.debtAmount).minus(currentPosition.debtAmount).toNumber()
    const netWorthDelta = num(projectedPosition.netWorth).minus(currentPosition.netWorth).toNumber()

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
                        <Text color="white" fontSize={TYPOGRAPHY.h3} fontWeight={TYPOGRAPHY.bold}>
                            Repay
                        </Text>
                        <Menu placement="bottom-start">
                            <MenuButton
                                as={Button}
                                variant="ghost"
                                rightIcon={<ChevronDownIcon />}
                                px={2}
                                h="40px"
                                w="fit-content"
                                _hover={{ bg: 'whiteAlpha.100' }}
                            >
                                <HStack spacing={2}>
                                    <Image src={selectedAsset.logo} alt={selectedAsset.symbol} w="24px" h="24px" borderRadius="full" />
                                    <Text color="white" fontSize={TYPOGRAPHY.h3} fontWeight={TYPOGRAPHY.bold}>
                                        {selectedAsset.symbol}
                                    </Text>
                                </HStack>
                            </MenuButton>
                            <MenuList
                                bg="rgba(10, 10, 10, 0.95)"
                                borderColor="whiteAlpha.200"
                                minW="auto"
                                w="fit-content"
                                py={1}
                            >
                                {DEBT_ASSETS.filter((asset) => asset.symbol !== selectedSymbol).map((asset) => (
                                    <MenuItem
                                        key={asset.symbol}
                                        bg="transparent"
                                        _hover={{ bg: 'whiteAlpha.100' }}
                                        onClick={() => {
                                            setSelectedSymbol(asset.symbol)
                                            repayModal.reset()
                                        }}
                                    >
                                        <HStack spacing={2}>
                                            <Image src={asset.logo} alt={asset.symbol} w="20px" h="20px" borderRadius="full" />
                                            <Text color="white" fontSize="sm" fontWeight="medium">
                                                {asset.symbol}
                                            </Text>
                                        </HStack>
                                    </MenuItem>
                                ))}
                            </MenuList>
                        </Menu>
                    </HStack>
                </ModalHeader>
                <ModalCloseButton color="whiteAlpha.600" _hover={{ color: 'white' }} />

                <ModalBody pb={6}>
                    <Grid templateColumns={{ base: '1fr', lg: '1fr 340px' }} gap={6}>
                        {/* Left Column: Repay Controls */}
                        <GridItem>
                            <VStack spacing={6} align="stretch">
                                {/* Amount & Slider Section */}
                                <Box
                                    bg="rgba(10, 10, 10, 0.8)"
                                    borderRadius="lg"
                                    p={4}
                                    border="1px solid"
                                    borderColor="whiteAlpha.200"
                                >
                                    <VStack spacing={4} align="stretch">
                                        <Text color="whiteAlpha.600" fontSize="xs">
                                            Repay {selectedAsset.symbol} to reduce your debt
                                        </Text>

                                        {/* Amount Input */}
                                        <Box>
                                            <HStack justify="space-between" mb={2}>
                                                <HStack spacing={2}>
                                                    <Image src={selectedAsset.logo} alt={selectedAsset.symbol} w="24px" h="24px" borderRadius="full" />
                                                    <Text color="white" fontSize="lg" fontWeight="medium">
                                                        {selectedAsset.symbol}
                                                    </Text>
                                                </HStack>
                                                <HStack spacing={2}>
                                                    <Text color="whiteAlpha.600" fontSize="sm">
                                                        Debt: {num(maxRepayable).toFixed(2)}
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
                                                value={repayAmount > 0 ? repayAmount.toString() : ''}
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
                                                    ~ ${num(repayAmount).toFixed(2)}
                                                </Text>
                                            </HStack>

                                            {/* Slider */}
                                            <Box px={2} position="relative">
                                                <Box position="relative" h="12px" w="100%" overflow="hidden">
                                                    {/* Hidden range input */}
                                                    <Box
                                                        as="input"
                                                        type="range"
                                                        value={sliderValue}
                                                        onChange={(e: any) => handleSliderChange(Number(e.target.value))}
                                                        min={0}
                                                        max={100}
                                                        step={1}
                                                        disabled={maxRepayable <= 0}
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
                                                            const isLast = index === 4
                                                            const nextMark = isLast ? 100 : [0, 25, 50, 75, 100][index + 1]
                                                            const segmentProgress = isLast
                                                                ? 0
                                                                : Math.max(0, Math.min(100, ((sliderValue - mark) / (nextMark - mark)) * 100))

                                                            return (
                                                                <React.Fragment key={mark}>
                                                                    <Box
                                                                        as="button"
                                                                        type="button"
                                                                        zIndex={20}
                                                                        w="12px"
                                                                        h="12px"
                                                                        outline="none !important"
                                                                        _hover={{ opacity: 0.8 }}
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
                                                                                fill={isActive ? '#22d3ee' : 'transparent'}
                                                                                stroke={isActive ? '#22d3ee' : 'rgba(255, 255, 255, 0.4)'}
                                                                                strokeWidth="1.5"
                                                                            />
                                                                        </Box>
                                                                    </Box>
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
                                                            _hover={{ cursor: 'pointer' }}
                                                        >
                                                            <polygon
                                                                points="6,0 10.392,3 10.392,9 6,12 1.608,9 1.608,3"
                                                                fill="#22d3ee"
                                                                stroke="#22d3ee"
                                                                strokeWidth="2"
                                                            />
                                                        </Box>
                                                    </Box>
                                                </Box>
                                            </Box>
                                        </Box>

                                        <HStack spacing={1}>
                                            <Text color="whiteAlpha.400" fontSize="xs" textAlign="left">
                                                Repayments reduce variable rate debt first, then fixed (1mo → 3mo → 6mo)
                                            </Text>
                                        </HStack>

                                        {/* Repay Button */}
                                        <Button
                                            size="lg"
                                            colorScheme="cyan"
                                            bg="cyan.500"
                                            _hover={{ bg: 'cyan.600' }}
                                            isDisabled={isDisabled}
                                            isLoading={isLoading}
                                            onClick={() => repayTransaction?.tx.mutate()}
                                            fontWeight="bold"
                                            fontSize="md"
                                        >
                                            Repay
                                        </Button>

                                        {/* Error message */}
                                        {repayTransaction?.simulate.isError && (
                                            <Text color="red.400" fontSize="sm" textAlign="center">
                                                {repayTransaction.simulate.error?.message || 'Transaction simulation failed'}
                                            </Text>
                                        )}
                                    </VStack>
                                </Box>

                            </VStack>
                        </GridItem>

                        {/* Right Column: Position Preview */}
                        <GridItem>
                            <Box
                                bg="rgba(10, 10, 10, 0.8)"
                                borderRadius="lg"
                                p={4}
                                border="1px solid"
                                borderColor="whiteAlpha.200"
                            >
                                <VStack spacing={4} align="stretch">
                                    {/* Net Worth */}
                                    <VStack align="flex-start" spacing={1}>
                                        <Text color="whiteAlpha.600" fontSize="xs">
                                            Net Worth
                                        </Text>
                                        <HStack spacing={2}>
                                            <Text color="white" fontSize="lg" fontWeight="bold">
                                                ${num(currentPosition.netWorth).toFixed(2)}
                                            </Text>
                                            {netWorthDelta !== 0 && (
                                                <>
                                                    <Text color="whiteAlpha.400">&rarr;</Text>
                                                    <Text
                                                        color={netWorthDelta >= 0 ? 'green.400' : 'red.400'}
                                                        fontSize="lg"
                                                        fontWeight="bold"
                                                    >
                                                        ${num(projectedPosition.netWorth).toFixed(2)}
                                                    </Text>
                                                </>
                                            )}
                                        </HStack>
                                    </VStack>

                                    {/* Health Bar */}
                                    <VStack align="flex-start" spacing={1}>
                                        <Text color="whiteAlpha.600" fontSize="xs">
                                            Health
                                        </Text>
                                        <Box w="100%">
                                            <Progress
                                                value={projectedPosition.health}
                                                colorScheme={getHealthColor(projectedPosition.health)}
                                                bg="whiteAlpha.100"
                                                borderRadius="full"
                                                h="8px"
                                            />
                                        </Box>
                                    </VStack>

                                    {/* Position Details */}
                                    <VStack align="stretch" spacing={2}>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.600" fontSize="xs">
                                                Collateral Value
                                            </Text>
                                            <Text color="white" fontSize="sm" fontWeight="medium">
                                                ${num(currentPosition.collateralValue).toFixed(2)}
                                            </Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.600" fontSize="xs">
                                                Total Debt
                                            </Text>
                                            <HStack spacing={1}>
                                                <Text color="white" fontSize="sm" fontWeight="medium">
                                                    ${num(currentPosition.debtAmount).toFixed(2)}
                                                </Text>
                                                {debtDelta !== 0 && (
                                                    <>
                                                        <Text color="whiteAlpha.400">&rarr;</Text>
                                                        <Text color="green.400" fontSize="sm" fontWeight="medium">
                                                            ${num(projectedPosition.debtAmount).toFixed(2)}
                                                        </Text>
                                                    </>
                                                )}
                                            </HStack>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.600" fontSize="xs">
                                                LTV
                                            </Text>
                                            <HStack spacing={1}>
                                                <Text color="white" fontSize="sm" fontWeight="medium">
                                                    {currentPosition.ltv.toFixed(1)}%
                                                </Text>
                                                {repayAmount > 0 && (
                                                    <>
                                                        <Text color="whiteAlpha.400">&rarr;</Text>
                                                        <Text color="green.400" fontSize="sm" fontWeight="medium">
                                                            {projectedPosition.ltv.toFixed(1)}%
                                                        </Text>
                                                    </>
                                                )}
                                            </HStack>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text color="whiteAlpha.600" fontSize="xs">
                                                {liquidationData.type === 'price' ? 'Liquidation Price' : 'Liquidation Threshold'}
                                            </Text>
                                            <Text color="white" fontSize="sm" fontWeight="medium">
                                                {liquidationData.type === 'price'
                                                    ? `$${num(liquidationData.value).toFixed(2)}${liquidationData.symbol ? ` (${liquidationData.symbol})` : ''}`
                                                    : `$${num(liquidationData.value).toFixed(2)}`
                                                }
                                            </Text>
                                        </HStack>
                                    </VStack>
                                </VStack>
                            </Box>
                        </GridItem>
                    </Grid>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}
