import React, { useState, useMemo, ChangeEvent } from 'react'
import {
    Box,
    Card,
    VStack,
    HStack,
    Text,
    Input,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
    Button,
    IconButton,
    Tooltip,
    Image,
    Tabs,
    TabList,
    TabPanels,
    Tab,
    TabPanel,
    Progress,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useChainRoute } from '@/hooks/useChainRoute'
import { Formatter } from '@/helpers/formatter'
import { num } from '@/helpers/num'
import { GlowingUSDC } from './GlowingUSDC'
import { BoostBreakdown } from './BoostBreakdown'

interface UnifiedPositionFormProps {
    // Position state
    hasPosition: boolean
    collateralAmount: number
    debtAmount: number
    currentLoopLevel: number
    userAPR: number
    
    // Market data
    baseAPR: number
    transmuterUSDCBalance: number
    funnelFillRatio: number
    
    // Callbacks
    onDeposit: (amount: string, boostMultiplier: number) => void
    onWithdraw?: (amount: string) => void
    onClose?: () => void
    onLoop?: (boostMultiplier: number) => void
}

export const UnifiedPositionForm: React.FC<UnifiedPositionFormProps> = ({
    hasPosition,
    collateralAmount,
    debtAmount,
    currentLoopLevel,
    userAPR,
    baseAPR,
    transmuterUSDCBalance,
    funnelFillRatio,
    onDeposit,
    onWithdraw,
    onClose,
    onLoop,
}) => {
    const { chainName } = useChainRoute()
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const usdcBalance = useBalanceByAsset(usdcAsset)
    
    const [depositAmount, setDepositAmount] = useState('')
    const [withdrawAmount, setWithdrawAmount] = useState('')
    const [boostMultiplier, setBoostMultiplier] = useState(hasPosition ? currentLoopLevel : 1)
    const [activeTab, setActiveTab] = useState(0)

    // Calculate max deposit based on capacity (capacity / 10 for 10x max loop)
    const maxDeposit = useMemo(() => {
        const capacityBasedMax = transmuterUSDCBalance / 10
        const walletBalance = Number(usdcBalance)
        return Math.min(capacityBasedMax, walletBalance)
    }, [transmuterUSDCBalance, usdcBalance])

    // Calculate current equity (for withdraw max)
    const currentEquity = useMemo(() => {
        if (!hasPosition) return 0
        return Math.max(0, collateralAmount - debtAmount)
    }, [hasPosition, collateralAmount, debtAmount])

    // Calculate current LTV
    const currentLTV = useMemo(() => {
        if (!hasPosition || collateralAmount <= 0) return 0
        return (debtAmount / collateralAmount) * 100
    }, [hasPosition, collateralAmount, debtAmount])

    // Health indicator
    const healthColor = useMemo(() => {
        if (currentLTV < 60) return 'green.400'
        if (currentLTV < 80) return 'yellow.400'
        return 'red.400'
    }, [currentLTV])

    const healthLabel = useMemo(() => {
        if (currentLTV < 60) return 'Healthy'
        if (currentLTV < 80) return 'Moderate'
        return 'At Risk'
    }, [currentLTV])

    // Calculate required capacity
    const requiredCapacity = useMemo(() => {
        if (!hasPosition) {
            // For new position: amount * (multiplier - 1) * 0.9 (LTV)
            const amount = parseFloat(depositAmount) || 0
            if (amount <= 0) return 0
            return amount * (boostMultiplier - 1) * 0.9
        } else {
            // For loop adjustment on existing position
            if (boostMultiplier <= currentLoopLevel) return 0
            const additionalDebt = collateralAmount * (boostMultiplier - currentLoopLevel)
            return additionalDebt
        }
    }, [depositAmount, boostMultiplier, hasPosition, collateralAmount, currentLoopLevel])

    // Calculate projected APR
    const projectedAPR = useMemo(() => {
        return baseAPR * boostMultiplier
    }, [baseAPR, boostMultiplier])

    // Handle deposit amount change
    const handleDepositAmountChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            setDepositAmount(value)
        }
    }

    // Handle withdraw amount change
    const handleWithdrawAmountChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            setWithdrawAmount(value)
        }
    }

    // Handle boost multiplier change
    const handleBoostChange = (val: number) => {
        setBoostMultiplier(val)
    }

    // Handle boost multiplier input change
    const handleBoostInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            const numValue = parseFloat(value)
            if (!isNaN(numValue) && numValue >= 1 && numValue <= 10) {
                setBoostMultiplier(numValue)
            }
        }
    }

    // Handle max deposit click
    const handleMaxDepositClick = () => {
        setDepositAmount(maxDeposit.toString())
    }

    // Handle max withdraw click
    const handleMaxWithdrawClick = () => {
        setWithdrawAmount(currentEquity.toString())
    }

    // Validation
    const isValidDeposit = useMemo(() => {
        const amount = parseFloat(depositAmount) || 0
        return amount > 0 && 
               amount <= Number(usdcBalance) && 
               amount <= maxDeposit &&
               requiredCapacity <= transmuterUSDCBalance
    }, [depositAmount, usdcBalance, maxDeposit, requiredCapacity, transmuterUSDCBalance])

    const isValidWithdraw = useMemo(() => {
        const amount = parseFloat(withdrawAmount) || 0
        return amount > 0 && amount <= currentEquity
    }, [withdrawAmount, currentEquity])

    const isValidLoop = useMemo(() => {
        if (!hasPosition) return false
        return boostMultiplier > currentLoopLevel && 
               requiredCapacity <= transmuterUSDCBalance
    }, [hasPosition, boostMultiplier, currentLoopLevel, requiredCapacity, transmuterUSDCBalance])

    // Handle submit
    const handleDepositSubmit = () => {
        if (isValidDeposit) {
            onDeposit(depositAmount, boostMultiplier)
            setDepositAmount('')
            setBoostMultiplier(1)
        }
    }

    const handleWithdrawSubmit = () => {
        if (isValidWithdraw && onWithdraw) {
            onWithdraw(withdrawAmount)
            setWithdrawAmount('')
        }
    }

    const handleCloseSubmit = () => {
        if (onClose) {
            onClose()
        }
    }

    const handleLoopSubmit = () => {
        if (isValidLoop && onLoop) {
            onLoop(boostMultiplier)
        }
    }

    const usdDepositValue = num(depositAmount || 0).times(1).toFixed(2)
    const usdWithdrawValue = num(withdrawAmount || 0).times(1).toFixed(2)

    // No Position State - Deposit Form
    if (!hasPosition) {
        return (
            <Card
                bg="gray.800"
                borderColor="cyan.600"
                borderWidth="2px"
                p={6}
                w="100%"
                boxShadow="0 0 20px rgba(0, 191, 255, 0.15)"
            >
                <VStack spacing={6} align="stretch">
                    {/* Header */}
                    <HStack justify="space-between" align="center">
                        <Text
                            fontSize="lg"
                            fontWeight="bold"
                            color="white"
                            fontFamily="mono"
                            textTransform="uppercase"
                        >
                            Create Position
                        </Text>
                        <Tooltip
                            label="Deposit USDC and configure your loop multiplier to start earning boosted APR."
                            fontSize="xs"
                            bg="gray.800"
                            color="#F5F5F5"
                            border="1px solid"
                            borderColor="cyan.500"
                            borderRadius="md"
                            p={3}
                            hasArrow
                        >
                            <IconButton
                                aria-label="Form Info"
                                icon={<InfoIcon />}
                                size="xs"
                                variant="ghost"
                                color="gray.400"
                                _hover={{ color: "cyan.400" }}
                            />
                        </Tooltip>
                    </HStack>

                    {/* Deposit Amount Input */}
                    <Box w="100%" bg="#11161e" borderRadius="lg" p={5}>
                        <HStack justify="space-between" align="flex-start" w="100%">
                            <VStack align="flex-start" spacing={1} flex={1}>
                                <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium">
                                    Deposit Amount
                                </Text>
                                <Input
                                    variant="unstyled"
                                    fontSize="2xl"
                                    fontWeight="bold"
                                    color="white"
                                    value={depositAmount}
                                    onChange={handleDepositAmountChange}
                                    type="text"
                                    placeholder="0"
                                    w="100%"
                                    _placeholder={{ color: 'whiteAlpha.400' }}
                                    paddingInlineEnd="3"
                                />
                                <Text color="whiteAlpha.600" fontSize="sm">
                                    ~ ${usdDepositValue}
                                </Text>
                                <Text color="gray.500" fontSize="xs" fontFamily="mono">
                                    Max: {maxDeposit.toFixed(2)} USDC (based on capacity)
                                </Text>
                            </VStack>
                            <VStack align="flex-end" spacing={2}>
                                <HStack bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
                                    {usdcAsset?.logo && (
                                        <Image
                                            src={usdcAsset.logo}
                                            alt="USDC"
                                            boxSize="20px"
                                        />
                                    )}
                                    <Text color="white" fontWeight="bold" fontSize="sm">
                                        USDC
                                    </Text>
                                </HStack>
                                <VStack
                                    cursor="pointer"
                                    onClick={handleMaxDepositClick}
                                    sx={{
                                        '&:hover > .wallet-hover-text': {
                                            textDecoration: 'underline',
                                            color: 'blue.300',
                                        },
                                    }}
                                >
                                    <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="xs">
                                        Wallet
                                    </Text>
                                    <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="xs">
                                        {Formatter.toNearestNonZero(usdcBalance)}
                                    </Text>
                                </VStack>
                            </VStack>
                        </HStack>
                    </Box>

                    {/* Boost Multiplier Section */}
                    <VStack spacing={3} align="stretch">
                        <HStack justify="space-between" align="center">
                            <HStack spacing={2}>
                                <Text
                                    fontSize="sm"
                                    color="gray.400"
                                    fontFamily="mono"
                                    textTransform="uppercase"
                                >
                                    Boost Multiplier
                                </Text>
                                <Tooltip
                                    label="The multiplier determines how much your base APR is amplified through looping at 90% LTV."
                                    fontSize="xs"
                                    bg="gray.800"
                                    color="#F5F5F5"
                                    border="1px solid"
                                    borderColor="purple.500"
                                    borderRadius="md"
                                    p={3}
                                    hasArrow
                                >
                                    <IconButton
                                        aria-label="Boost Info"
                                        icon={<InfoIcon />}
                                        size="xs"
                                        variant="ghost"
                                        color="gray.400"
                                        _hover={{ color: "cyan.400" }}
                                    />
                                </Tooltip>
                            </HStack>
                            <HStack spacing={2}>
                                <Input
                                    value={boostMultiplier.toFixed(1)}
                                    onChange={handleBoostInputChange}
                                    size="sm"
                                    w="60px"
                                    textAlign="center"
                                    fontFamily="mono"
                                    fontSize="sm"
                                    color="cyan.400"
                                    fontWeight="bold"
                                />
                                <Text fontSize="sm" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                    x
                                </Text>
                            </HStack>
                        </HStack>

                        <Slider
                            value={boostMultiplier}
                            onChange={handleBoostChange}
                            min={1}
                            max={10}
                            step={0.1}
                            colorScheme="cyan"
                        >
                            <SliderTrack bg="gray.700">
                                <SliderFilledTrack bg="cyan.500" />
                            </SliderTrack>
                            <SliderThumb />
                        </Slider>

                        <HStack justify="space-between" fontSize="xs" color="#F5F5F580" fontFamily="mono">
                            <Text>1x</Text>
                            <Text>10x</Text>
                        </HStack>

                        {/* APR Display */}
                        <HStack justify="space-between" pt={2} borderTop="1px solid" borderColor="gray.700">
                            <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                Base APR:
                            </Text>
                            <Text fontSize="sm" color="#F5F5F5" fontFamily="mono" fontWeight="bold">
                                {baseAPR.toFixed(2)}%
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                Projected APR:
                            </Text>
                            <Text fontSize="lg" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                {projectedAPR.toFixed(2)}%
                            </Text>
                        </HStack>
                    </VStack>

                    {/* Loop Capacity Section */}
                    <VStack spacing={3} align="stretch" pt={2} borderTop="1px solid" borderColor="gray.700">
                        <HStack justify="center" align="center" spacing={2}>
                            <Text
                                fontSize="sm"
                                color="gray.400"
                                fontFamily="mono"
                                textTransform="uppercase"
                            >
                                Loop Capacity
                            </Text>
                            <Tooltip
                                label="The available USDC balance in the Transmuter that can be consumed by the Manic vault for looping operations."
                                fontSize="xs"
                                bg="gray.800"
                                color="#F5F5F5"
                                border="1px solid"
                                borderColor="purple.500"
                                borderRadius="md"
                                p={3}
                                hasArrow
                            >
                                <IconButton
                                    aria-label="Loop Capacity Info"
                                    icon={<InfoIcon />}
                                    size="xs"
                                    variant="ghost"
                                    color="gray.400"
                                    _hover={{ color: "cyan.400" }}
                                />
                            </Tooltip>
                        </HStack>

                        {/* GlowingUSDC - Decorative */}
                        <Box position="relative" w="100%" display="flex" justifyContent="center" py={2}>
                            <GlowingUSDC fillRatio={funnelFillRatio} />
                        </Box>

                        <HStack justify="space-between">
                            <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                Available:
                            </Text>
                            <Text fontSize="sm" color="green.400" fontFamily="mono" fontWeight="bold">
                                {transmuterUSDCBalance.toFixed(2)} USDC
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                Required:
                            </Text>
                            <Text 
                                fontSize="sm" 
                                color={requiredCapacity <= transmuterUSDCBalance ? "cyan.400" : "red.400"} 
                                fontFamily="mono" 
                                fontWeight="bold"
                            >
                                {requiredCapacity.toFixed(2)} USDC
                            </Text>
                        </HStack>
                    </VStack>

                    {/* Submit Button */}
                    <Button
                        size="lg"
                        colorScheme="cyan"
                        bg="cyan.500"
                        color="white"
                        isDisabled={!isValidDeposit}
                        onClick={handleDepositSubmit}
                        _hover={{
                            bg: 'cyan.400',
                        }}
                        fontFamily="mono"
                        fontSize="lg"
                        mt={2}
                    >
                        Create Position
                    </Button>
                </VStack>
            </Card>
        )
    }

    // Has Position State - Adjust Position Form
    return (
        <Card
            bg="gray.800"
            borderColor="cyan.600"
            borderWidth="2px"
            p={6}
            w="100%"
            boxShadow="0 0 20px rgba(0, 191, 255, 0.15)"
        >
            <VStack spacing={6} align="stretch">
                {/* Header */}
                <HStack justify="space-between" align="center">
                    <HStack spacing={2}>
                        <Text
                            fontSize="lg"
                            fontWeight="bold"
                            color="white"
                            fontFamily="mono"
                            textTransform="uppercase"
                        >
                            Adjust Position
                        </Text>
                        <Tooltip
                            label="Manage your USDC looping position. Deposit, withdraw, adjust loop level, or close your position."
                            fontSize="xs"
                            bg="gray.800"
                            color="#F5F5F5"
                            border="1px solid"
                            borderColor="cyan.500"
                            borderRadius="md"
                            p={3}
                            hasArrow
                        >
                            <IconButton
                                aria-label="Position Info"
                                icon={<InfoIcon />}
                                size="xs"
                                variant="ghost"
                                color="gray.400"
                                _hover={{ color: "cyan.400" }}
                            />
                        </Tooltip>
                    </HStack>
                    <BoostBreakdown />
                </HStack>

                {/* Position Summary */}
                <HStack spacing={6} w="100%" justify="space-between" pb={4} borderBottom="1px solid" borderColor="gray.700">
                    <VStack align="start" spacing={1} flex={1}>
                        <Text fontSize="xs" color="gray.400" fontFamily="mono" textTransform="uppercase">
                            Deposited
                        </Text>
                        <Text fontSize="2xl" fontWeight="bold" color="white" fontFamily="mono">
                            {collateralAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
                        </Text>
                    </VStack>
                    <VStack align="start" spacing={1} flex={1}>
                        <Text fontSize="xs" color="gray.400" fontFamily="mono" textTransform="uppercase">
                            Loop Level
                        </Text>
                        <Text fontSize="2xl" fontWeight="bold" color="cyan.400" fontFamily="mono">
                            {currentLoopLevel.toFixed(1)}x
                        </Text>
                    </VStack>
                    <VStack align="start" spacing={1} flex={1}>
                        <Text fontSize="xs" color="gray.400" fontFamily="mono" textTransform="uppercase">
                            Net APR
                        </Text>
                        <Text fontSize="2xl" fontWeight="bold" color="green.400" fontFamily="mono">
                            {userAPR.toFixed(2)}%
                        </Text>
                    </VStack>
                    <VStack align="start" spacing={1} flex={1}>
                        <Text fontSize="xs" color="gray.400" fontFamily="mono" textTransform="uppercase">
                            Health
                        </Text>
                        <VStack align="start" spacing={1} w="100%">
                            <HStack spacing={2}>
                                <Text fontSize="lg" fontWeight="bold" color={healthColor} fontFamily="mono">
                                    {healthLabel}
                                </Text>
                                <Text fontSize="sm" color="gray.500" fontFamily="mono">
                                    ({currentLTV.toFixed(0)}% LTV)
                                </Text>
                            </HStack>
                            <Progress
                                value={currentLTV}
                                max={100}
                                size="xs"
                                colorScheme={currentLTV < 60 ? 'green' : currentLTV < 80 ? 'yellow' : 'red'}
                                bg="gray.700"
                                borderRadius="full"
                                w="100%"
                            />
                        </VStack>
                    </VStack>
                </HStack>

                {/* Tabs for Actions */}
                <Tabs index={activeTab} onChange={setActiveTab} colorScheme="cyan">
                    <TabList>
                        <Tab fontFamily="mono" fontSize="sm">Deposit</Tab>
                        <Tab fontFamily="mono" fontSize="sm">Withdraw</Tab>
                        <Tab fontFamily="mono" fontSize="sm">Loop</Tab>
                        <Tab fontFamily="mono" fontSize="sm">Close</Tab>
                    </TabList>

                    <TabPanels>
                        {/* Deposit Tab */}
                        <TabPanel px={0} pt={6}>
                            <VStack spacing={6} align="stretch">
                                <Box w="100%" bg="#11161e" borderRadius="lg" p={5}>
                                    <HStack justify="space-between" align="flex-start" w="100%">
                                        <VStack align="flex-start" spacing={1} flex={1}>
                                            <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium">
                                                Deposit Amount
                                            </Text>
                                            <Input
                                                variant="unstyled"
                                                fontSize="2xl"
                                                fontWeight="bold"
                                                color="white"
                                                value={depositAmount}
                                                onChange={handleDepositAmountChange}
                                                type="text"
                                                placeholder="0"
                                                w="100%"
                                                _placeholder={{ color: 'whiteAlpha.400' }}
                                                paddingInlineEnd="3"
                                            />
                                            <Text color="whiteAlpha.600" fontSize="sm">
                                                ~ ${usdDepositValue}
                                            </Text>
                                            <Text color="gray.500" fontSize="xs" fontFamily="mono">
                                                Max: {maxDeposit.toFixed(2)} USDC (based on capacity)
                                            </Text>
                                        </VStack>
                                        <VStack align="flex-end" spacing={2}>
                                            <HStack bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
                                                {usdcAsset?.logo && (
                                                    <Image
                                                        src={usdcAsset.logo}
                                                        alt="USDC"
                                                        boxSize="20px"
                                                    />
                                                )}
                                                <Text color="white" fontWeight="bold" fontSize="sm">
                                                    USDC
                                                </Text>
                                            </HStack>
                                            <VStack
                                                cursor="pointer"
                                                onClick={handleMaxDepositClick}
                                                sx={{
                                                    '&:hover > .wallet-hover-text': {
                                                        textDecoration: 'underline',
                                                        color: 'blue.300',
                                                    },
                                                }}
                                            >
                                                <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="xs">
                                                    Wallet
                                                </Text>
                                                <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="xs">
                                                    {Formatter.toNearestNonZero(usdcBalance)}
                                                </Text>
                                            </VStack>
                                        </VStack>
                                    </HStack>
                                </Box>
                                <Button
                                    size="lg"
                                    colorScheme="cyan"
                                    bg="cyan.500"
                                    color="white"
                                    isDisabled={!isValidDeposit}
                                    onClick={handleDepositSubmit}
                                    _hover={{ bg: 'cyan.400' }}
                                    fontFamily="mono"
                                    fontSize="lg"
                                >
                                    Deposit
                                </Button>
                            </VStack>
                        </TabPanel>

                        {/* Withdraw Tab */}
                        <TabPanel px={0} pt={6}>
                            <VStack spacing={6} align="stretch">
                                <Box w="100%" bg="#11161e" borderRadius="lg" p={5}>
                                    <HStack justify="space-between" align="flex-start" w="100%">
                                        <VStack align="flex-start" spacing={1} flex={1}>
                                            <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium">
                                                Withdraw Amount
                                            </Text>
                                            <Input
                                                variant="unstyled"
                                                fontSize="2xl"
                                                fontWeight="bold"
                                                color="white"
                                                value={withdrawAmount}
                                                onChange={handleWithdrawAmountChange}
                                                type="text"
                                                placeholder="0"
                                                w="100%"
                                                _placeholder={{ color: 'whiteAlpha.400' }}
                                                paddingInlineEnd="3"
                                            />
                                            <Text color="whiteAlpha.600" fontSize="sm">
                                                ~ ${usdWithdrawValue}
                                            </Text>
                                            <Text color="gray.500" fontSize="xs" fontFamily="mono">
                                                Max: {currentEquity.toFixed(2)} USDC (available equity)
                                            </Text>
                                        </VStack>
                                        <VStack align="flex-end" spacing={2}>
                                            <HStack bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
                                                {usdcAsset?.logo && (
                                                    <Image
                                                        src={usdcAsset.logo}
                                                        alt="USDC"
                                                        boxSize="20px"
                                                    />
                                                )}
                                                <Text color="white" fontWeight="bold" fontSize="sm">
                                                    USDC
                                                </Text>
                                            </HStack>
                                            <VStack
                                                cursor="pointer"
                                                onClick={handleMaxWithdrawClick}
                                                sx={{
                                                    '&:hover > .equity-hover-text': {
                                                        textDecoration: 'underline',
                                                        color: 'blue.300',
                                                    },
                                                }}
                                            >
                                                <Text className="equity-hover-text" color="whiteAlpha.700" fontSize="xs">
                                                    Equity
                                                </Text>
                                                <Text className="equity-hover-text" color="whiteAlpha.700" fontSize="xs">
                                                    {currentEquity.toFixed(2)}
                                                </Text>
                                            </VStack>
                                        </VStack>
                                    </HStack>
                                </Box>
                                <Button
                                    size="lg"
                                    colorScheme="cyan"
                                    bg="cyan.500"
                                    color="white"
                                    isDisabled={!isValidWithdraw}
                                    onClick={handleWithdrawSubmit}
                                    _hover={{ bg: 'cyan.400' }}
                                    fontFamily="mono"
                                    fontSize="lg"
                                >
                                    Withdraw
                                </Button>
                            </VStack>
                        </TabPanel>

                        {/* Loop Tab */}
                        <TabPanel px={0} pt={6}>
                            <VStack spacing={6} align="stretch">
                                <VStack spacing={3} align="stretch">
                                    <HStack justify="space-between" align="center">
                                        <HStack spacing={2}>
                                            <Text fontSize="sm" color="gray.400" fontFamily="mono" textTransform="uppercase">
                                                Target Loop Level
                                            </Text>
                                            <Tooltip
                                                label="Increase your loop multiplier to boost your APR. Requires additional capacity."
                                                fontSize="xs"
                                                bg="gray.800"
                                                color="#F5F5F5"
                                                border="1px solid"
                                                borderColor="purple.500"
                                                borderRadius="md"
                                                p={3}
                                                hasArrow
                                            >
                                                <IconButton
                                                    aria-label="Loop Info"
                                                    icon={<InfoIcon />}
                                                    size="xs"
                                                    variant="ghost"
                                                    color="gray.400"
                                                    _hover={{ color: "cyan.400" }}
                                                />
                                            </Tooltip>
                                        </HStack>
                                        <HStack spacing={2}>
                                            <Text fontSize="sm" color="gray.500" fontFamily="mono">
                                                Current: {currentLoopLevel.toFixed(1)}x
                                            </Text>
                                            <Input
                                                value={boostMultiplier.toFixed(1)}
                                                onChange={handleBoostInputChange}
                                                size="sm"
                                                w="60px"
                                                textAlign="center"
                                                fontFamily="mono"
                                                fontSize="sm"
                                                color="cyan.400"
                                                fontWeight="bold"
                                            />
                                            <Text fontSize="sm" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                                x
                                            </Text>
                                        </HStack>
                                    </HStack>

                                    <Slider
                                        value={boostMultiplier}
                                        onChange={handleBoostChange}
                                        min={currentLoopLevel}
                                        max={10}
                                        step={0.1}
                                        colorScheme="cyan"
                                    >
                                        <SliderTrack bg="gray.700">
                                            <SliderFilledTrack bg="cyan.500" />
                                        </SliderTrack>
                                        <SliderThumb />
                                    </Slider>

                                    <HStack justify="space-between" fontSize="xs" color="#F5F5F580" fontFamily="mono">
                                        <Text>{currentLoopLevel.toFixed(1)}x</Text>
                                        <Text>10x</Text>
                                    </HStack>

                                    <HStack justify="space-between" pt={2} borderTop="1px solid" borderColor="gray.700">
                                        <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                            Current APR:
                                        </Text>
                                        <Text fontSize="sm" color="#F5F5F5" fontFamily="mono" fontWeight="bold">
                                            {userAPR.toFixed(2)}%
                                        </Text>
                                    </HStack>
                                    <HStack justify="space-between">
                                        <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                            Projected APR:
                                        </Text>
                                        <Text fontSize="lg" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                            {projectedAPR.toFixed(2)}%
                                        </Text>
                                    </HStack>
                                </VStack>

                                {/* Loop Capacity */}
                                <VStack spacing={3} align="stretch" pt={2} borderTop="1px solid" borderColor="gray.700">
                                    <HStack justify="center" align="center" spacing={2}>
                                        <Text fontSize="sm" color="gray.400" fontFamily="mono" textTransform="uppercase">
                                            Loop Capacity
                                        </Text>
                                        <Tooltip
                                            label="The available USDC balance in the Transmuter that can be consumed by the Manic vault for looping operations."
                                            fontSize="xs"
                                            bg="gray.800"
                                            color="#F5F5F5"
                                            border="1px solid"
                                            borderColor="purple.500"
                                            borderRadius="md"
                                            p={3}
                                            hasArrow
                                        >
                                            <IconButton
                                                aria-label="Loop Capacity Info"
                                                icon={<InfoIcon />}
                                                size="xs"
                                                variant="ghost"
                                                color="gray.400"
                                                _hover={{ color: "cyan.400" }}
                                            />
                                        </Tooltip>
                                    </HStack>
                                    <Box position="relative" w="100%" display="flex" justifyContent="center" py={2}>
                                        <GlowingUSDC fillRatio={funnelFillRatio} />
                                    </Box>
                                    <HStack justify="space-between">
                                        <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                            Available:
                                        </Text>
                                        <Text fontSize="sm" color="green.400" fontFamily="mono" fontWeight="bold">
                                            {transmuterUSDCBalance.toFixed(2)} USDC
                                        </Text>
                                    </HStack>
                                    <HStack justify="space-between">
                                        <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                            Required:
                                        </Text>
                                        <Text 
                                            fontSize="sm" 
                                            color={requiredCapacity <= transmuterUSDCBalance ? "cyan.400" : "red.400"} 
                                            fontFamily="mono" 
                                            fontWeight="bold"
                                        >
                                            {requiredCapacity.toFixed(2)} USDC
                                        </Text>
                                    </HStack>
                                </VStack>

                                <Button
                                    size="lg"
                                    colorScheme="purple"
                                    bg="purple.500"
                                    color="white"
                                    isDisabled={!isValidLoop}
                                    onClick={handleLoopSubmit}
                                    _hover={{ bg: 'purple.400' }}
                                    fontFamily="mono"
                                    fontSize="lg"
                                >
                                    Increase Loop to {boostMultiplier.toFixed(1)}x
                                </Button>
                            </VStack>
                        </TabPanel>

                        {/* Close Tab */}
                        <TabPanel px={0} pt={6}>
                            <VStack spacing={6} align="stretch">
                                <Box
                                    bg="gray.700"
                                    borderRadius="lg"
                                    p={6}
                                    border="1px solid"
                                    borderColor="red.500"
                                >
                                    <VStack spacing={4} align="stretch">
                                        <Text fontSize="lg" fontWeight="bold" color="white" fontFamily="mono">
                                            Close Position
                                        </Text>
                                        <Text fontSize="sm" color="gray.300" fontFamily="mono">
                                            This will close your entire position and return all collateral. All debt will be repaid and your position will be closed.
                                        </Text>
                                        <HStack spacing={4} pt={2}>
                                            <VStack align="start" spacing={1} flex={1}>
                                                <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                                    Collateral
                                                </Text>
                                                <Text fontSize="lg" fontWeight="bold" color="white" fontFamily="mono">
                                                    {collateralAmount.toFixed(2)} USDC
                                                </Text>
                                            </VStack>
                                            <VStack align="start" spacing={1} flex={1}>
                                                <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                                    Debt
                                                </Text>
                                                <Text fontSize="lg" fontWeight="bold" color="red.400" fontFamily="mono">
                                                    {debtAmount.toFixed(2)} USDC
                                                </Text>
                                            </VStack>
                                            <VStack align="start" spacing={1} flex={1}>
                                                <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                                    Equity
                                                </Text>
                                                <Text fontSize="lg" fontWeight="bold" color="green.400" fontFamily="mono">
                                                    {currentEquity.toFixed(2)} USDC
                                                </Text>
                                            </VStack>
                                        </HStack>
                                    </VStack>
                                </Box>
                                <Button
                                    size="lg"
                                    colorScheme="red"
                                    bg="red.500"
                                    color="white"
                                    onClick={handleCloseSubmit}
                                    _hover={{ bg: 'red.400' }}
                                    fontFamily="mono"
                                    fontSize="lg"
                                >
                                    Close Position
                                </Button>
                            </VStack>
                        </TabPanel>
                    </TabPanels>
                </Tabs>
            </VStack>
        </Card>
    )
}








