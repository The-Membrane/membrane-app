import React, { useState } from 'react'
import {
    VStack,
    Text,
    Box,
    HStack,
    Button,
    NumberInput,
    NumberInputField,
} from '@chakra-ui/react'
import { shiftDigits } from '@/helpers/math'

interface WithdrawFormProps {
    depositType: 'staking' | 'disco'
    maxAmount: string // In base units (with 6 decimals)
    onSubmit: (amount: string) => void
}

export const WithdrawForm: React.FC<WithdrawFormProps> = ({ depositType, maxAmount, onSubmit }) => {
    const [amount, setAmount] = useState('')

    const maxAmountFormatted = shiftDigits(maxAmount, -6).toFixed(2)

    const handleMax = () => {
        setAmount(maxAmountFormatted)
    }

    const handleSubmit = () => {
        if (!amount || parseFloat(amount) <= 0) return
        onSubmit(amount)
    }

    const isStaking = depositType === 'staking'

    return (
        <VStack align="stretch" spacing={4} w="100%" h="100%" pb="50px" overflowY="auto">
            <Text fontSize="xs" color="#F5F5F580" fontWeight="bold" textTransform="uppercase">
                {isStaking ? 'Unstake MBRN' : 'Withdraw from LTV Disco'}
            </Text>

            {/* Amount Input */}
            <Box>
                <HStack justify="space-between" mb={2}>
                    <Text fontSize="xs" color="#F5F5F580">
                        Amount (MBRN)
                    </Text>
                    <Button
                        size="xs"
                        variant="ghost"
                        color="cyan.400"
                        onClick={handleMax}
                        _hover={{ bg: '#38B2AC20' }}
                        h="auto"
                        p={1}
                    >
                        MAX
                    </Button>
                </HStack>
                <NumberInput
                    value={amount}
                    onChange={(valueString) => setAmount(valueString)}
                    min={0}
                    max={parseFloat(maxAmountFormatted)}
                >
                    <NumberInputField
                        bg="#1A1D26"
                        border="1px solid"
                        borderColor="#6943FF30"
                        color="#F5F5F5"
                        fontSize="sm"
                        _hover={{ borderColor: '#6943FF60' }}
                        _focus={{ borderColor: '#38B2AC', boxShadow: '0 0 0 1px #38B2AC' }}
                        placeholder="0.00"
                    />
                </NumberInput>
                <Text fontSize="2xs" color="#F5F5F550" mt={1}>
                    Available: {maxAmountFormatted} MBRN
                </Text>
            </Box>

            {/* Warning for locked deposits */}
            <Box
                bg="#1A1D2680"
                border="1px solid"
                borderColor="#F5905030"
                borderRadius="md"
                p={3}
            >
                <Text fontSize="xs" color="#F59050">
                    Note: Locked deposits cannot be withdrawn until the lock expires.
                </Text>
            </Box>

            {/* Submit Button */}
            <Button
                position="fixed"
                bottom={0}
                left={0}
                right={0}
                size="sm"
                bg="cyan.500"
                color="white"
                onClick={handleSubmit}
                isDisabled={!amount || parseFloat(amount) <= 0}
                _hover={{ bg: 'cyan.400', boxShadow: '0 0 15px rgba(56, 178, 172, 0.4)' }}
                _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
            >
                {isStaking ? 'Unstake' : 'Withdraw'}
            </Button>
        </VStack>
    )
}

