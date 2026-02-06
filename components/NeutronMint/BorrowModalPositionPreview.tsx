import React, { useState, useEffect } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Progress,
    Collapse,
    Icon,
    Table,
    Thead,
    Tbody,
    Tr,
    Th,
    Td,
    Image,
} from '@chakra-ui/react'
import { ChevronDownIcon, ChevronUpIcon } from '@chakra-ui/icons'
import { num } from '@/helpers/num'

interface PositionData {
    current: {
        netWorth: number
        leverage: number
        health: number
        collateralValue: number
        debtAmount: number
        apy: number
    }
    projected: {
        netWorth: number
        leverage: number
        health: number
        collateralValue: number
        debtAmount: number
        apy: number
    }
}

interface DebtCompositionRow {
    type: string // e.g., "Variable", "Fixed 1-Month", etc.
    rate: number // APR percentage
    ratio: number // Percentage of total debt (0-100)
}

interface LiquidationData {
    type: 'price' | 'threshold'
    value: number
    symbol?: string
}

interface BorrowModalPositionPreviewProps {
    positionData: PositionData
    debtComposition: DebtCompositionRow[]
    assetSymbol: string
    assetLogo: string
    currentBorrowApy: number
    projectedBorrowApy: number
    liquidationData: LiquidationData
}

export const BorrowModalPositionPreview: React.FC<BorrowModalPositionPreviewProps> = ({
    positionData,
    debtComposition,
    assetSymbol,
    assetLogo,
    currentBorrowApy,
    projectedBorrowApy,
    liquidationData,
}) => {
    const [overviewOpen, setOverviewOpen] = useState(true)
    const [debtCompositionOpen, setDebtCompositionOpen] = useState(false)

    const { current, projected } = positionData

    // Calculate deltas
    const netWorthDelta = num(projected.netWorth).minus(current.netWorth).toNumber()
    const debtDelta = num(projected.debtAmount).minus(current.debtAmount).toNumber()
    const apyDelta = num(projected.apy).minus(current.apy).toNumber()
    const borrowApyDelta = num(projectedBorrowApy).minus(currentBorrowApy).toNumber()

    // Auto-open Debt Composition when debt changes
    useEffect(() => {
        if (debtDelta !== 0 && debtComposition.length > 0) {
            setDebtCompositionOpen(true)
        }
    }, [debtDelta, debtComposition.length])

    // Health bar color based on health percentage
    const getHealthColor = (health: number) => {
        if (health >= 80) return 'green.400'
        if (health >= 50) return 'yellow.400'
        if (health >= 20) return 'orange.400'
        return 'red.400'
    }

    // Calculate collateral power (collateral value * max LTV)
    // For now, using a simplified calculation
    const collateralPower = num(current.collateralValue).times(0.8).toNumber()

    return (
        <Box
            bg="rgba(10, 10, 10, 0.8)"
            borderRadius="lg"
            p={4}
            border="1px solid"
            borderColor="whiteAlpha.200"
        >
            <VStack spacing={4} align="stretch">
                {/* Net Worth Delta */}
                <VStack align="flex-start" spacing={1}>
                    <Text color="whiteAlpha.600" fontSize="xs">
                        Net Worth
                    </Text>
                    <HStack spacing={2}>
                        <Text color="white" fontSize="lg" fontWeight="bold">
                            ${num(current.netWorth).toFixed(2)}
                        </Text>
                        {netWorthDelta !== 0 && (
                            <>
                                <Text color="whiteAlpha.400">→</Text>
                                <Text
                                    color={netWorthDelta >= 0 ? 'green.400' : 'red.400'}
                                    fontSize="lg"
                                    fontWeight="bold"
                                >
                                    ${num(projected.netWorth).toFixed(2)}
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
                            value={projected.health}
                            colorScheme={getHealthColor(projected.health) === 'green.400' ? 'green' :
                                getHealthColor(projected.health) === 'yellow.400' ? 'yellow' :
                                    getHealthColor(projected.health) === 'orange.400' ? 'orange' : 'red'}
                            bg="whiteAlpha.100"
                            borderRadius="full"
                            h="8px"
                        />
                    </Box>
                </VStack>

                {/* Overview (Collapsible) */}
                <Box>
                    <HStack
                        justify="space-between"
                        cursor="pointer"
                        onClick={() => setOverviewOpen(!overviewOpen)}
                        w="100%"
                        py={2}
                        px={4}
                        borderBottom="1px solid"
                        borderColor="whiteAlpha.100"
                        mb={0}
                    >
                        <Text color="white" fontSize="sm" fontWeight="semibold">
                            Overview
                        </Text>
                        <Box pr={1}>
                            <Icon
                                as={overviewOpen ? ChevronUpIcon : ChevronDownIcon}
                                w="17px"
                                h="17px"
                                color="currentColor"
                            />
                        </Box>
                    </HStack>
                    <Collapse in={overviewOpen} animateOpacity>
                        <VStack align="stretch" spacing={2} mt={2}>
                            <HStack justify="space-between">
                                <Text color="whiteAlpha.600" fontSize="xs">
                                    Total Balance
                                </Text>
                                <Text color="white" fontSize="sm" fontWeight="medium">
                                    ${num(current.collateralValue).toFixed(2)}
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text color="whiteAlpha.600" fontSize="xs">
                                    Collateral Power
                                </Text>
                                <Text color="white" fontSize="sm" fontWeight="medium">
                                    ${num(collateralPower).toFixed(2)}
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text color="whiteAlpha.600" fontSize="xs">
                                    Total Debt
                                </Text>
                                <HStack spacing={1}>
                                    <Text color="white" fontSize="sm" fontWeight="medium">
                                        ${num(current.debtAmount).toFixed(2)}
                                    </Text>
                                    {debtDelta !== 0 && (
                                        <>
                                            <Text color="whiteAlpha.400">→</Text>
                                            <Text color="red.400" fontSize="sm" fontWeight="medium">
                                                ${num(projected.debtAmount).toFixed(2)}
                                            </Text>
                                        </>
                                    )}
                                </HStack>
                            </HStack>
                            <HStack justify="space-between">
                                <Text color="whiteAlpha.600" fontSize="xs">
                                    Borrow APY
                                </Text>
                                <HStack spacing={1}>
                                    <Text color="white" fontSize="sm" fontWeight="medium">
                                        {currentBorrowApy > 0 ? `${currentBorrowApy.toFixed(2)}%` : '0.00%'}
                                    </Text>
                                    {borrowApyDelta !== 0 && (
                                        <>
                                            <Text color="whiteAlpha.400">→</Text>
                                            <Text
                                                color={borrowApyDelta > 0 ? 'red.400' : 'green.400'}
                                                fontSize="sm"
                                                fontWeight="medium"
                                            >
                                                {projectedBorrowApy > 0 ? `${projectedBorrowApy.toFixed(2)}%` : '0.00%'}
                                            </Text>
                                        </>
                                    )}
                                </HStack>
                            </HStack>
                            <HStack justify="space-between">
                                <Text color="whiteAlpha.600" fontSize="xs">
                                    {liquidationData.type === 'price' ? 'Liquidation Price' : 'Liquidation Threshold'}
                                </Text>
                                <HStack spacing={1}>
                                    <Text color="white" fontSize="sm" fontWeight="medium">
                                        {liquidationData.type === 'price'
                                            ? `$${num(liquidationData.value).toFixed(2)}${liquidationData.symbol ? ` (${liquidationData.symbol})` : ''}`
                                            : `$${num(liquidationData.value).toFixed(2)}`
                                        }
                                    </Text>
                                </HStack>
                            </HStack>
                        </VStack>
                    </Collapse>
                </Box>

                {/* Debt Composition Table (Collapsible) */}
                <Box>
                    <HStack
                        justify="space-between"
                        cursor="pointer"
                        onClick={() => setDebtCompositionOpen(!debtCompositionOpen)}
                        w="100%"
                        py={2}
                        px={4}
                        borderBottom="1px solid"
                        borderColor="whiteAlpha.100"
                        mb={0}
                    >
                        <HStack spacing={2}>
                            <Image
                                src="/images/cdt.svg"
                                alt="CDT"
                                w="20px"
                                h="20px"
                                borderRadius="full"
                                fallbackSrc="/images/default-token.svg"
                            />
                            <Text color="white" fontSize="sm" fontWeight="semibold">
                                Debt Composition
                            </Text>
                        </HStack>
                        <Box pr={1}>
                            <Icon
                                as={debtCompositionOpen ? ChevronUpIcon : ChevronDownIcon}
                                w="17px"
                                h="17px"
                                color="currentColor"
                            />
                        </Box>
                    </HStack>
                    <Collapse in={debtCompositionOpen} animateOpacity>
                        <Table variant="unstyled" size="sm" mt={2}>
                            <Thead>
                                <Tr>
                                    <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0}>
                                        Type
                                    </Th>
                                    <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} isNumeric>
                                        Rate
                                    </Th>
                                    <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} isNumeric>
                                        Ratio
                                    </Th>
                                </Tr>
                            </Thead>
                            <Tbody>
                                {debtComposition.length > 0 ? (
                                    debtComposition.map((row, idx) => (
                                        <Tr key={`debt-comp-${idx}`}>
                                            <Td px={0} py={2}>
                                                <Text color="white" fontSize="xs">
                                                    {row.type}
                                                </Text>
                                            </Td>
                                            <Td px={0} py={2} isNumeric>
                                                <Text color="white" fontSize="xs">
                                                    {row.rate.toFixed(2)}%
                                                </Text>
                                            </Td>
                                            <Td px={0} py={2} isNumeric>
                                                <Text color="whiteAlpha.600" fontSize="xs">
                                                    {row.ratio.toFixed(1)}%
                                                </Text>
                                            </Td>
                                        </Tr>
                                    ))
                                ) : (
                                    <Tr>
                                        <Td colSpan={3} px={0} py={2}>
                                            <Text color="whiteAlpha.600" fontSize="xs" textAlign="center">
                                                No debt
                                            </Text>
                                        </Td>
                                    </Tr>
                                )}
                            </Tbody>
                        </Table>
                    </Collapse>
                </Box>
            </VStack>
        </Box>
    )
}

