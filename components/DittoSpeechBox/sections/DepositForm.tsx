import React, { useState, useEffect } from 'react'
import {
    VStack,
    Text,
    Box,
    HStack,
    Button,
    NumberInput,
    NumberInputField,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
} from '@chakra-ui/react'

interface DepositFormProps {
    depositType: 'staking' | 'disco'
    minLockDays?: number // Minimum lock days based on existing deposit
    onSubmit: (amount: string, lockDays: number) => void
    onChange?: (amount: string, lockDays: number) => void // Callback for live preview
}

export const DepositForm: React.FC<DepositFormProps> = ({ depositType, minLockDays = 0, onSubmit, onChange }) => {
    const [amount, setAmount] = useState('')
    const [lockDays, setLockDays] = useState(Math.max(minLockDays, 30))

    // Report changes to parent for live preview
    useEffect(() => {
        onChange?.(amount, lockDays)
    }, [amount, lockDays, onChange])

    const handleSubmit = () => {
        if (!amount || parseFloat(amount) <= 0) return
        onSubmit(amount, lockDays)
    }

    const isStaking = depositType === 'staking'
    const maxLockDays = 365
    const effectiveMinLockDays = minLockDays

    return (
        <VStack align="stretch" spacing={4} w="100%" h="100%" pb="50px" overflowY="auto">
            <Text fontSize="xs" color="#F5F5F580" fontWeight="bold" textTransform="uppercase">
                {isStaking ? 'Stake MBRN' : 'Deposit to LTV Disco'}
            </Text>

            {/* Amount Input */}
            <Box>
                <Text fontSize="xs" color="#F5F5F580" mb={2}>
                    Amount (MBRN)
                </Text>
                <NumberInput
                    value={amount}
                    onChange={(valueString) => setAmount(valueString)}
                    min={0}
                >
                    <NumberInputField
                        bg="#1A1D26"
                        border="1px solid"
                        borderColor="#6943FF30"
                        color="#F5F5F5"
                        fontSize="sm"
                        _hover={{ borderColor: '#6943FF60' }}
                        _focus={{ borderColor: '#9F7AEA', boxShadow: '0 0 0 1px #9F7AEA' }}
                        placeholder="0.00"
                    />
                </NumberInput>
            </Box>

            {/* Lock Days Slider */}
            <Box>
                <HStack justify="space-between" mb={2}>
                    <Text fontSize="xs" color="#F5F5F580">
                        Lock Duration
                    </Text>
                    <Text fontSize="xs" color="purple.300" fontWeight="bold">
                        {lockDays} days
                    </Text>
                </HStack>
                <Slider
                    value={lockDays}
                    onChange={(val) => setLockDays(val)}
                    min={effectiveMinLockDays}
                    max={maxLockDays}
                    step={1}
                >
                    <SliderTrack bg="#1A1D26" h="6px" borderRadius="full">
                        <SliderFilledTrack bg="purple.400" />
                    </SliderTrack>
                    <SliderThumb
                        boxSize={4}
                        bg="purple.400"
                        border="2px solid"
                        borderColor="white"
                        _focus={{ boxShadow: '0 0 10px rgba(159, 122, 234, 0.5)' }}
                    />
                </Slider>
                <HStack justify="space-between" mt={1}>
                    <Text fontSize="2xs" color="#F5F5F550">{effectiveMinLockDays}</Text>
                    <Text fontSize="2xs" color="#F5F5F550">{maxLockDays}</Text>
                </HStack>
            </Box>

            {/* Boost Preview */}
            <Box
                bg="#1A1D26"
                border="1px solid"
                borderColor="#6943FF30"
                borderRadius="md"
                p={3}
            >
                <HStack justify="space-between">
                    <Text fontSize="xs" color="#F5F5F580">
                        Effective MBRN Boost
                    </Text>
                    <Text fontSize="xs" color="cyan.300" fontWeight="bold">
                        {(lockDays + 1).toFixed(1)}x
                    </Text>
                </HStack>
            </Box>

            {/* Info Text */}
            <Text fontSize="2xs" color="#F5F5F550">
                Note: The lock period applies from the deposit time.
            </Text>

            {/* Submit Button */}
            <Button

                position={"fixed"}
                bottom={0}
                left={0}
                right={0}
                size="sm"
                bg="purple.500"
                color="white"
                onClick={handleSubmit}
                isDisabled={!amount || parseFloat(amount) <= 0}
                _hover={{ bg: 'purple.400', boxShadow: '0 0 15px rgba(159, 122, 234, 0.4)' }}
                _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
                mt="auto"
            >
                {isStaking ? 'Stake' : 'Deposit'}
            </Button>
        </VStack>
    )
}

