import React, { useState, useMemo } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Collapse,
    IconButton,
    Divider,
} from '@chakra-ui/react'
import { ChevronDownIcon, ChevronUpIcon } from '@chakra-ui/icons'
import { useRevenuePerSecond } from './hooks/useRevenuePerSecond'

interface RevenuePerSecondProps {
    alwaysShowBreakdown?: boolean
}

export const RevenuePerSecond: React.FC<RevenuePerSecondProps> = ({ alwaysShowBreakdown = false }) => {
    const { revenuePerSecond, cumulativeRevenue, revenuePerSecondBySource } = useRevenuePerSecond()
    const [isExpanded, setIsExpanded] = useState(false)

    // Format number with 6 decimal places for per-second rates
    const formatRPS = (value: number): string => {
        return value.toFixed(6)
    }

    // Format cumulative revenue with 6 decimal places - memoized to prevent unnecessary recalculations
    const formattedCumulative = useMemo(() => {
        return cumulativeRevenue.toFixed(6)
    }, [cumulativeRevenue])

    return (
        <Box
            bg="gray.800"
            border="1px solid"
            borderColor="purple.500"
            borderRadius="md"
            p={6}
            position="relative"
            overflow="hidden"
            _before={{
                content: '""',
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'linear-gradient(135deg, rgba(111, 255, 194, 0.05) 0%, rgba(138, 43, 226, 0.05) 100%)',
                pointerEvents: 'none',
            }}
        >
            <VStack spacing={4} align="stretch" position="relative" zIndex={1}>
                <HStack justify="space-between" align="center">
                    <VStack align="flex-start" spacing={0}>
                        <Text
                            fontSize="sm"
                            color="gray.400"
                            fontFamily="mono"
                            textTransform="uppercase"
                            letterSpacing="wide"
                        >
                            Revenue Counter
                        </Text>
                        <Text
                            fontSize="xs"
                            color="gray.500"
                            fontFamily="mono"
                        >
                            {formatRPS(revenuePerSecond)}/sec
                        </Text>
                    </VStack>
                    {!alwaysShowBreakdown && (
                        <HStack
                            spacing={2}
                            as="button"
                            onClick={() => setIsExpanded(!isExpanded)}
                            cursor="pointer"
                            _hover={{ opacity: 0.8 }}
                            align="center"
                        >
                            <Text
                                fontSize="xs"
                                color="gray.400"
                                fontFamily="mono"
                                _hover={{ color: 'cyan.400' }}
                            >
                                Breakdown
                            </Text>
                            <IconButton
                                aria-label={isExpanded ? 'Collapse' : 'Expand'}
                                icon={isExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
                                size="xs"
                                variant="ghost"
                                color="gray.400"
                                _hover={{ color: 'cyan.400' }}
                                minW="auto"
                                w="auto"
                                h="auto"
                            />
                        </HStack>
                    )}
                </HStack>

                <Box
                    willChange="contents"
                    style={{
                        transform: 'translateZ(0)',
                        backfaceVisibility: 'hidden',
                        WebkitFontSmoothing: 'antialiased',
                    }}
                >
                    <Text
                        fontSize="4xl"
                        fontWeight="bold"
                        color="cyan.400"
                        fontFamily="mono"
                        textShadow="0 0 10px rgba(111, 255, 194, 0.5)"
                        letterSpacing="tight"
                        style={{
                            willChange: 'contents',
                            transform: 'translateZ(0)',
                            backfaceVisibility: 'hidden',
                            WebkitFontSmoothing: 'antialiased',
                            textRendering: 'optimizeLegibility',
                        }}
                    >
                        ${formattedCumulative}
                    </Text>
                </Box>

                {alwaysShowBreakdown ? (
                    <Box mt={4} pt={4} borderTop="1px solid" borderColor="gray.700">
                        <VStack spacing={3} align="stretch">
                            <Text
                                fontSize="xs"
                                color="gray.500"
                                fontFamily="mono"
                                textTransform="uppercase"
                                letterSpacing="wide"
                            >
                                Revenue Per Second
                            </Text>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                    Disco
                                </Text>
                                <Text fontSize="sm" color="white" fontFamily="mono" fontWeight="bold">
                                    ${formatRPS(revenuePerSecondBySource.disco)}/sec
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                    Transmuter
                                </Text>
                                <Text fontSize="sm" color="white" fontFamily="mono" fontWeight="bold">
                                    ${formatRPS(revenuePerSecondBySource.transmuter)}/sec
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                    Manic Vault
                                </Text>
                                <Text fontSize="sm" color="white" fontFamily="mono" fontWeight="bold">
                                    ${formatRPS(revenuePerSecondBySource.manic)}/sec
                                </Text>
                            </HStack>
                        </VStack>
                    </Box>
                ) : (
                    <Collapse in={isExpanded} animateOpacity>
                        <Box mt={4} pt={4} borderTop="1px solid" borderColor="gray.700">
                            <VStack spacing={3} align="stretch">
                                <Text
                                    fontSize="xs"
                                    color="gray.500"
                                    fontFamily="mono"
                                    textTransform="uppercase"
                                    letterSpacing="wide"
                                >
                                    Revenue Per Second
                                </Text>
                                <HStack justify="space-between">
                                    <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                        Disco
                                    </Text>
                                    <Text fontSize="sm" color="white" fontFamily="mono" fontWeight="bold">
                                        ${formatRPS(revenuePerSecondBySource.disco)}/sec
                                    </Text>
                                </HStack>
                                <HStack justify="space-between">
                                    <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                        Transmuter
                                    </Text>
                                    <Text fontSize="sm" color="white" fontFamily="mono" fontWeight="bold">
                                        ${formatRPS(revenuePerSecondBySource.transmuter)}/sec
                                    </Text>
                                </HStack>
                                <HStack justify="space-between">
                                    <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                        Manic Vault
                                    </Text>
                                    <Text fontSize="sm" color="white" fontFamily="mono" fontWeight="bold">
                                        ${formatRPS(revenuePerSecondBySource.manic)}/sec
                                    </Text>
                                </HStack>
                            </VStack>
                        </Box>
                    </Collapse>
                )}

            </VStack>
        </Box>
    )
}
