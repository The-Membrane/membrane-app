import React, { useState } from 'react'
import {
    Box,
    Text,
    VStack,
    HStack,
    Icon,
    Popover,
    PopoverTrigger,
    PopoverContent,
    PopoverBody,
    Divider,
} from '@chakra-ui/react'
import { ChevronDown } from 'lucide-react'
import { useBoostBreakdown } from './hooks/useBoostBreakdown'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'

export const BoostBreakdown: React.FC = () => {
    const { data: breakdown, isLoading } = useBoostBreakdown()
    const [isOpen, setIsOpen] = useState(false)

    const boostPercent = breakdown 
        ? num(breakdown.totalBoost).times(100).toFixed(2)
        : '0.00'

    const formatMBRN = (amount: string) => {
        return shiftDigits(amount, -6).toFixed(2)
    }

    // Show default breakdown if no data
    const displayBreakdown = breakdown || {
        totalBoost: '0',
        staking: {
            baseMBRN: '0',
            lockedDeposits: [],
            totalEffectiveMBRN: '0',
        },
        ltvDisco: {
            baseMBRN: '0',
            lockedDeposits: [],
            totalEffectiveMBRN: '0',
        },
    }

    return (
        <Box
            position="relative"
            onMouseEnter={() => setIsOpen(true)}
            onMouseLeave={() => setIsOpen(false)}
        >
            <Popover
                isOpen={isOpen}
                onOpen={() => setIsOpen(true)}
                onClose={() => setIsOpen(false)}
                placement="bottom-end"
                closeOnBlur={true}
            >
                <PopoverTrigger>
                    <Box
                        cursor="pointer"
                        px={4}
                        py={2}
                        border="2px solid"
                        borderColor="purple.400"
                        borderRadius="md"
                        bg="gray.800"
                        onClick={() => setIsOpen(!isOpen)}
                        _hover={{
                            borderColor: 'purple.300',
                            boxShadow: '0 0 20px rgba(166, 146, 255, 0.3)',
                        }}
                        transition="all 0.3s"
                    >
                    <HStack spacing={2}>
                        <Text
                            fontSize="lg"
                            fontWeight="bold"
                            bgGradient="linear(to-r, purple.400, cyan.400)"
                            bgClip="text"
                            fontFamily="mono"
                        >
                            {boostPercent}%
                        </Text>
                        <Text fontSize="sm" color="gray.400" fontFamily="mono" textTransform="uppercase">
                            BOOST
                        </Text>
                        <Icon 
                            as={ChevronDown} 
                            w={4} 
                            h={4} 
                            color="gray.400"
                            transform={isOpen ? 'rotate(180deg)' : 'rotate(0deg)'}
                            transition="transform 0.2s"
                        />
                    </HStack>
                </Box>
            </PopoverTrigger>
            <PopoverContent
                bg="gray.800"
                border="2px solid"
                borderColor="purple.400"
                borderRadius="md"
                boxShadow="0 0 30px rgba(166, 146, 255, 0.3)"
                w="400px"
                maxH="600px"
                overflowY="auto"
            >
                <PopoverBody p={6}>
                    <VStack align="stretch" spacing={4}>
                        {/* Header */}
                        <VStack align="start" spacing={1}>
                            <Text
                                fontSize="xl"
                                fontWeight="bold"
                                color="white"
                                fontFamily="mono"
                                textTransform="uppercase"
                            >
                                Boost Breakdown
                            </Text>
                            <Text fontSize="sm" color="gray.400" fontFamily="mono">
                                Total Boost: {boostPercent}%
                            </Text>
                        </VStack>

                        <Divider borderColor="gray.600" />

                        {/* Staking Section */}
                        <VStack align="stretch" spacing={3}>
                            <Text
                                fontSize="sm"
                                fontWeight="bold"
                                color="cyan.400"
                                fontFamily="mono"
                                textTransform="uppercase"
                            >
                                Staking
                            </Text>
                            <VStack align="stretch" spacing={2} pl={4}>
                                <HStack justify="space-between">
                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                        Base MBRN
                                    </Text>
                                        <Text fontSize="xs" color="gray.300" fontFamily="mono">
                                            {formatMBRN(displayBreakdown.staking.baseMBRN)} MBRN
                                        </Text>
                                    </HStack>
                                    {displayBreakdown.staking.lockedDeposits.length > 0 && (
                                        <>
                                            <Text fontSize="xs" color="gray.500" fontFamily="mono" mt={2}>
                                                Locked Deposits:
                                            </Text>
                                            {displayBreakdown.staking.lockedDeposits.map((deposit, idx) => (
                                            <Box
                                                key={idx}
                                                pl={2}
                                                borderLeft="2px solid"
                                                borderColor="purple.500"
                                                py={1}
                                            >
                                                <HStack justify="space-between" mb={1}>
                                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                                        Deposit
                                                    </Text>
                                                    <Text fontSize="xs" color="gray.300" fontFamily="mono">
                                                        {formatMBRN(deposit.amount)} MBRN
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between" mb={1}>
                                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                                        Lock Duration
                                                    </Text>
                                                    <Text fontSize="xs" color="purple.300" fontFamily="mono">
                                                        {deposit.daysRemaining} days
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                                        Boost Contribution
                                                    </Text>
                                                    <Text fontSize="xs" color="cyan.300" fontFamily="mono">
                                                        +{formatMBRN(deposit.boostAmount)} MBRN
                                                    </Text>
                                                </HStack>
                                            </Box>
                                        ))}
                                    </>
                                )}
                                <Divider borderColor="gray.700" mt={2} />
                                <HStack justify="space-between">
                                    <Text fontSize="xs" fontWeight="bold" color="gray.300" fontFamily="mono">
                                        Total Effective MBRN
                                    </Text>
                                        <Text fontSize="xs" fontWeight="bold" color="cyan.300" fontFamily="mono">
                                            {formatMBRN(displayBreakdown.staking.totalEffectiveMBRN)} MBRN
                                        </Text>
                                    </HStack>
                                </VStack>
                            </VStack>

                            <Divider borderColor="gray.600" />

                            {/* LTV Disco Section */}
                            <VStack align="stretch" spacing={3}>
                                <Text
                                    fontSize="sm"
                                    fontWeight="bold"
                                    color="purple.400"
                                    fontFamily="mono"
                                    textTransform="uppercase"
                                >
                                    LTV Disco
                                </Text>
                                <VStack align="stretch" spacing={2} pl={4}>
                                    <HStack justify="space-between">
                                        <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                            Base MBRN
                                        </Text>
                                        <Text fontSize="xs" color="gray.300" fontFamily="mono">
                                            {formatMBRN(displayBreakdown.ltvDisco.baseMBRN)} MBRN
                                        </Text>
                                    </HStack>
                                    {displayBreakdown.ltvDisco.lockedDeposits.length > 0 && (
                                        <>
                                            <Text fontSize="xs" color="gray.500" fontFamily="mono" mt={2}>
                                                Locked Deposits:
                                            </Text>
                                            {displayBreakdown.ltvDisco.lockedDeposits.map((deposit, idx) => (
                                            <Box
                                                key={idx}
                                                pl={2}
                                                borderLeft="2px solid"
                                                borderColor="purple.500"
                                                py={1}
                                            >
                                                <HStack justify="space-between" mb={1}>
                                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                                        Deposit
                                                    </Text>
                                                    <Text fontSize="xs" color="gray.300" fontFamily="mono">
                                                        {formatMBRN(deposit.amount)} MBRN
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between" mb={1}>
                                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                                        Lock Duration
                                                    </Text>
                                                    <Text fontSize="xs" color="purple.300" fontFamily="mono">
                                                        {deposit.daysRemaining} days
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="gray.400" fontFamily="mono">
                                                        Boost Contribution
                                                    </Text>
                                                    <Text fontSize="xs" color="cyan.300" fontFamily="mono">
                                                        +{formatMBRN(deposit.boostAmount)} MBRN
                                                    </Text>
                                                </HStack>
                                            </Box>
                                        ))}
                                    </>
                                )}
                                <Divider borderColor="gray.700" mt={2} />
                                <HStack justify="space-between">
                                    <Text fontSize="xs" fontWeight="bold" color="gray.300" fontFamily="mono">
                                        Total Effective MBRN
                                    </Text>
                                    <Text fontSize="xs" fontWeight="bold" color="purple.300" fontFamily="mono">
                                        {formatMBRN(displayBreakdown.ltvDisco.totalEffectiveMBRN)} MBRN
                                    </Text>
                                </HStack>
                            </VStack>
                        </VStack>
                    </VStack>
                </PopoverBody>
            </PopoverContent>
        </Popover>
        </Box>
    )
}

