import React from 'react'
import { Box, HStack, VStack, Text } from '@chakra-ui/react'
import { AnimatedCounter } from './DiscoPageAnimatedCounter'
import { PRIMARY_PURPLE } from './DiscoPageConstants'
import type { DiscoPageState } from './hooks/useDiscoPage'

interface DiscoPageMetricsBarProps {
    metrics: DiscoPageState['metrics']
    slotCount: number
}

/** Global metrics header bar: Total TVL, Active Slots, Total Insurance. */
export const DiscoPageMetricsBar: React.FC<DiscoPageMetricsBarProps> = ({ metrics, slotCount }) => {
    return (
        <Box
            w="100%"
            maxW="1200px"
            mx="auto"
            px={{ base: 4, md: 8 }}
        >
            <HStack
                spacing={{ base: 4, md: 6 }}
                justify={{ base: 'center', md: 'space-between' }}
                flexWrap="wrap"
                bg="rgba(10, 10, 10, 0.6)"
                p={4}
                borderRadius="md"
                border="1px solid"
                borderColor="rgba(155, 220, 79, 0.3)"
                boxShadow={`0 0 20px ${PRIMARY_PURPLE}20`}
                position="relative"
                zIndex={2}
            >
                <VStack spacing={0} align={{ base: 'center', md: 'flex-start' }}>
                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                        Total TVL
                    </Text>
                    <Text
                        fontSize={{ base: 'xl', md: '2xl' }}
                        fontWeight="bold"
                        color="white"
                        fontFamily="'Neon Tubes', monospace"
                    >
                        <AnimatedCounter value={metrics.totalDeposits} /> MBRN
                    </Text>
                </VStack>
                <VStack spacing={0} align={{ base: 'center', md: 'flex-start' }}>
                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                        Active Slots
                    </Text>
                    <Text
                        fontSize={{ base: 'xl', md: '2xl' }}
                        fontWeight="bold"
                        color="white"
                        fontFamily="'Neon Tubes', monospace"
                    >
                        <AnimatedCounter value={metrics.activeSlots} /> / {slotCount}
                    </Text>
                </VStack>
                <VStack spacing={0} align={{ base: 'center', md: 'flex-start' }}>
                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                        Total Insurance
                    </Text>
                    <Text
                        fontSize={{ base: 'xl', md: '2xl' }}
                        fontWeight="bold"
                        color="white"
                        fontFamily="'Neon Tubes', monospace"
                    >
                        <AnimatedCounter value={metrics.totalInsurance} decimals={0} /> CDT
                    </Text>
                </VStack>
            </HStack>
        </Box>
    )
}
