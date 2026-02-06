import React, { useState, useMemo } from 'react'
import { Box, VStack, HStack, Text, Slider, SliderTrack, SliderFilledTrack, SliderThumb, IconButton, Tooltip } from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { Card } from '@chakra-ui/react'

interface CompactBoostSimulatorProps {
    baseAPR: number
    onBoostChange?: (multiplier: number) => void
}

export const CompactBoostSimulator: React.FC<CompactBoostSimulatorProps> = ({
    baseAPR,
    onBoostChange
}) => {
    const [boostMultiplier, setBoostMultiplier] = useState(1)

    // Handle slider change and notify parent
    const handleBoostChange = (val: number) => {
        setBoostMultiplier(val)
        onBoostChange?.(val)
    }

    // Calculate boosted APR
    const boostedAPR = useMemo(() => {
        return baseAPR * boostMultiplier
    }, [baseAPR, boostMultiplier])

    return (
        <Card
            width="100%"
            bg="gray.800"
            borderColor="purple.500"
            borderWidth="2px"
            p={4}
            boxShadow="0 0 20px rgba(159, 122, 234, 0.2)"
        >
            <VStack spacing={3} align="stretch">
                <HStack justify="space-between" align="center" w="100%">
                    <HStack spacing={2} align="center">
                        <Text
                            fontSize="xs"
                            color="gray.400"
                            fontFamily="mono"
                            textTransform="uppercase"
                            whiteSpace="nowrap"
                        >
                            Boost Simulator
                        </Text>
                        <Tooltip
                            label="Simulate the boosted APR for a given multiplier. The multiplier represents how much base APR is amplified through looping at 90% LTV."
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
                    size="sm"
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

                <VStack spacing={1} align="stretch" mt={2}>
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="gray.400" fontFamily="mono">
                            Base APR:
                        </Text>
                        <Text fontSize="xs" color="#F5F5F5" fontFamily="mono" fontWeight="bold">
                            {baseAPR.toFixed(2)}%
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="gray.400" fontFamily="mono">
                            Projected:
                        </Text>
                        <Text fontSize="sm" color="cyan.400" fontFamily="mono" fontWeight="bold">
                            {boostedAPR.toFixed(2)}%
                        </Text>
                    </HStack>
                </VStack>
            </VStack>
        </Card>
    )
}








