import React, { useState, useMemo } from 'react'
import { Box, VStack, HStack, Text, Slider, SliderTrack, SliderFilledTrack, SliderThumb, IconButton, Tooltip } from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { GlowingUSDC } from './GlowingUSDC'

interface FlowVisualizerProps {
    transmuterBalance: number
    baseAPR: number
    fillRatio: number
    onBoostChange?: (multiplier: number) => void
    showLoopCapacity?: boolean
}

export const FlowVisualizer: React.FC<FlowVisualizerProps> = ({
    transmuterBalance,
    baseAPR,
    fillRatio,
    onBoostChange,
    showLoopCapacity = true
}) => {
    const [boostMultiplier, setBoostMultiplier] = useState(1)
    const exampleCollateral = 1000 // Example 1000 USDC for simulation

    // Handle slider change and notify parent
    const handleBoostChange = (val: number) => {
        setBoostMultiplier(val)
        onBoostChange?.(val)
    }

    // Calculate boosted APR
    const boostedAPR = useMemo(() => {
        return baseAPR * boostMultiplier
    }, [baseAPR, boostMultiplier])

    // Calculate required capacity to achieve multiplier on example collateral
    // Required capacity = example collateral × multiplier
    const requiredCapacity = useMemo(() => {
        return exampleCollateral * boostMultiplier
    }, [boostMultiplier])

    return (
        <HStack spacing={4} w="100%" align="flex-start">
            {/* Boost Simulator Card */}
            <Box
                bg="gray.800"
                border="1px solid"
                borderColor="purple.500"
                borderRadius="md"
                p={4}
                flex={1}
            >
                <VStack spacing={4} align="stretch">
                    <HStack justify="space-between" align="center" w="100%">
                        <HStack spacing={2} align="center" flex={1}>
                            <Text
                                fontSize="sm"
                                color="gray.400"
                                fontFamily="mono"
                                textTransform="uppercase"
                                whiteSpace="nowrap"
                                lineHeight="1"
                            >
                                Boost Simulator
                            </Text>
                            <Tooltip
                                label="Simulate the boosted APR and required capacity for a given multiplier. The multiplier represents how much base APR is amplified through looping at 90% LTV."
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
                                    aria-label="Boost Simulator Info"
                                    icon={<InfoIcon />}
                                    size="xs"
                                    variant="ghost"
                                    color="gray.400"
                                    _hover={{ color: "cyan.400" }}
                                    minW="auto"
                                    w="auto"
                                    h="auto"
                                />
                            </Tooltip>
                        </HStack>
                        <Text
                            fontSize="lg"
                            fontWeight="bold"
                            color="cyan.400"
                            fontFamily="mono"
                            lineHeight="1"
                            whiteSpace="nowrap"
                        >
                            {boostMultiplier.toFixed(1)}x
                        </Text>
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

                    <VStack spacing={2} align="stretch" mt={4}>
                        <HStack justify="space-between">
                            <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                Example Collateral:
                            </Text>
                            <Text fontSize="sm" color="#F5F5F5" fontFamily="mono" fontWeight="bold">
                                {exampleCollateral.toLocaleString()} USDC
                            </Text>
                        </HStack>

                        <HStack justify="space-between">
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
                            <Text fontSize="sm" color="cyan.400" fontFamily="mono" fontWeight="bold">
                                {boostedAPR.toFixed(2)}%
                            </Text>
                        </HStack>

                        <HStack justify="space-between" mt={2} pt={2} borderTop="1px solid" borderColor="gray.700">
                            <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                Required Capacity:
                            </Text>
                            <Text fontSize="sm" color="green.400" fontFamily="mono" fontWeight="bold">
                                {requiredCapacity.toLocaleString()} USDC
                            </Text>
                        </HStack>
                    </VStack>
                </VStack>
            </Box>

            {/* Loop Capacity Card with GlowingUSDC - Informational Only */}
            {showLoopCapacity && (
                <VStack spacing={4} w="20%" align="stretch">
                    {/* GlowingUSDC - Decorative */}
                    <Box position="relative" w="100%" display="flex" justifyContent="center">
                        <GlowingUSDC
                            fillRatio={fillRatio}
                        />
                    </Box>

                    {/* Loop Capacity Card - Informational Only */}
                    <Box
                        bg="gray.800"
                        border="1px solid"
                        borderColor="purple.500"
                        borderRadius="md"
                        p={4}
                        w="100%"
                    >
                        <VStack spacing={4} align="stretch">
                            <HStack justify="center" align="center" spacing={2}>
                                <Text
                                    fontSize="sm"
                                    color="gray.400"
                                    fontFamily="mono"
                                    textTransform="uppercase"
                                    textAlign="center"
                                    whiteSpace="nowrap"
                                    lineHeight="1"
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
                                        minW="auto"
                                        w="auto"
                                        h="auto"
                                    />
                                </Tooltip>
                            </HStack>

                            <Text
                                fontSize="xl"
                                fontWeight="bold"
                                color="#F5F5F5"
                                fontFamily="mono"
                                textAlign="center"
                            >
                                {transmuterBalance.toFixed(2)} USDC
                            </Text>
                        </VStack>
                    </Box>
                </VStack>
            )}
        </HStack>
    )
}
