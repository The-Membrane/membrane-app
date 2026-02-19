import React, { useMemo, useState } from 'react'
import {
    Box,
    Menu,
    MenuButton,
    MenuList,
    MenuItem,
    HStack,
    Text,
    Icon,
    VStack,
    Tooltip,
} from '@chakra-ui/react'
import { ChevronDownIcon, InfoOutlineIcon } from '@chakra-ui/icons'
import { BorrowRate } from './hooks/useBorrowModal'
import { Formatter } from '@/helpers/formatter'

interface RateOption {
    value: BorrowRate
    label: string
    description: string
    apr: number
}

interface BorrowRateSelectorProps {
    selectedRate: BorrowRate
    rates: {
        variable: number
        fixed1m: number
        fixed3m: number
        fixed6m: number
    }
    assetSymbol: 'CDT' | 'USDC'
    liquidityAvailable: number // -1 for unlimited, or USD value
    onRateChange: (rate: BorrowRate) => void
}

export const BorrowRateSelector: React.FC<BorrowRateSelectorProps> = ({
    selectedRate,
    rates,
    assetSymbol,
    liquidityAvailable,
    onRateChange,
}) => {
    const [hoveredRate, setHoveredRate] = useState<BorrowRate | null>(null)

    // Mock liquidity data per rate option
    const mockLiquidityData: Record<BorrowRate, number> = {
        'variable': -1, // Unlimited for CDT
        'fixed-1m': 150000, // $150K available
        'fixed-3m': 120000, // $120K available
        'fixed-6m': 90000,  // $90K available
    }

    const rateOptions: RateOption[] = [
        {
            value: 'variable',
            label: 'Variable',
            description: 'Lowest cost, flexible',
            apr: rates.variable,
        },
        {
            value: 'fixed-1m',
            label: 'Fixed 1-Month',
            description: 'Short-term, predictable',
            apr: rates.fixed1m,
        },
        {
            value: 'fixed-3m',
            label: 'Fixed 3-Month',
            description: 'Medium-term stability',
            apr: rates.fixed3m,
        },
        {
            value: 'fixed-6m',
            label: 'Fixed 6-Month',
            description: 'Longer stability',
            apr: rates.fixed6m,
        },
    ]

    const selectedOption = rateOptions.find(opt => opt.value === selectedRate) || rateOptions[0]

    // Format rate label
    const getRateLabel = (rate: BorrowRate) => {
        const option = rateOptions.find(opt => opt.value === rate)
        if (!option) return 'Variable'
        return option.label
    }

    // Get current liquidity based on hover or selection
    const currentLiquidity = useMemo(() => {
        const rateToUse = hoveredRate || selectedRate
        return mockLiquidityData[rateToUse] ?? liquidityAvailable
    }, [hoveredRate, selectedRate, liquidityAvailable])

    // Get current APR based on hover or selection
    const currentApr = useMemo(() => {
        const rateToUse = hoveredRate || selectedRate
        const option = rateOptions.find(opt => opt.value === rateToUse)
        return option?.apr ?? selectedOption.apr
    }, [hoveredRate, selectedRate, rateOptions, selectedOption])

    // Format availability text
    const availabilityText = useMemo(() => {
        if (currentLiquidity < 0) return 'Unlimited'
        // Format number using Formatter.tvlShort for K/M abbreviations, then add CDT
        return `${Formatter.tvlShort(currentLiquidity)} CDT`
    }, [currentLiquidity])

    return (
        <Box>
            <HStack spacing={4} align="flex-start">
                {/* Borrow APR Dropdown */}
                <VStack align="flex-start" spacing={0}>
                    <HStack spacing={1}>
                        <Text color="whiteAlpha.600" fontSize="xs">
                            Borrow Rate APY
                        </Text>
                        <Tooltip
                            label="Fixed rates are calculated based on your position's collateral composition. The displayed rate is an estimate — your actual fixed rate = collateral weighted rate × multiplier."
                            placement="top"
                            hasArrow
                            bg="gray.800"
                            color="white"
                            fontSize="xs"
                            maxW="260px"
                        >
                            <span>
                                <Icon as={InfoOutlineIcon} color="whiteAlpha.400" boxSize={3} cursor="help" />
                            </span>
                        </Tooltip>
                    </HStack>
                    <Menu>
                        <MenuButton
                            as={Box}
                            cursor="pointer"
                            _hover={{ opacity: 0.8 }}
                            transition="opacity 0.2s"
                        >
                            <HStack spacing={1}>
                                <Text color="white" fontSize="lg" fontWeight="bold" transition="all 0.2s">
                                    {getRateLabel(hoveredRate || selectedRate)} · {currentApr.toFixed(2)}%
                                </Text>
                                <Icon as={ChevronDownIcon} color="whiteAlpha.600" boxSize={4} />
                            </HStack>
                        </MenuButton>
                        <MenuList
                            bg="rgba(10, 10, 10, 0.95)"
                            borderColor="whiteAlpha.200"
                            onMouseLeave={() => setHoveredRate(null)}
                        >
                            {rateOptions.map((option) => (
                                <MenuItem
                                    key={option.value}
                                    bg={selectedRate === option.value ? 'whiteAlpha.100' : 'transparent'}
                                    border={selectedRate === option.value ? '1px solid' : '1px solid transparent'}
                                    borderColor={selectedRate === option.value ? 'cyan.400' : 'transparent'}
                                    borderRadius={selectedRate === option.value ? '16px' : '0'}
                                    _hover={{ bg: 'whiteAlpha.50' }}
                                    onClick={() => {
                                        onRateChange(option.value)
                                        setHoveredRate(null)
                                    }}
                                    onMouseEnter={() => setHoveredRate(option.value)}
                                >
                                    <VStack align="flex-start" spacing={0}>
                                        <HStack spacing={2}>
                                            <Text color="white" fontSize="sm" fontWeight="medium">
                                                {option.label}
                                            </Text>
                                            {selectedRate === option.value && (
                                                <Box w={2} h={2} borderRadius="full" bg="cyan.400" />
                                            )}
                                        </HStack>
                                        <Text color="whiteAlpha.600" fontSize="xs">
                                            {option.description}
                                        </Text>
                                        <Text color="white" fontSize="sm" fontWeight="semibold">
                                            {option.apr.toFixed(2)}%
                                        </Text>
                                    </VStack>
                                </MenuItem>
                            ))}
                        </MenuList>
                    </Menu>
                </VStack>

                {/* Availability */}
                <VStack align="flex-start" spacing={"2px"}>
                    <Text color="whiteAlpha.600" fontSize="xs">
                        Liquidity available
                    </Text>
                    <Text
                        color={currentLiquidity < 0 ? 'cyan.400' : 'white'}
                        fontSize="sm"
                        fontWeight="medium"
                        transition="color 0.2s"
                    >
                        {availabilityText}
                    </Text>
                </VStack>
            </HStack>
        </Box>
    )
}

