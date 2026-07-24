import React from 'react'
import { Box, VStack, Text, Button, NumberInput, NumberInputField, HStack } from '@chakra-ui/react'
import { shiftDigits } from '@/helpers/math'
import { getSlotLabel } from './types'
import type { SlotData } from './types'

// Color constants
const PRIMARY_PURPLE = 'rgb(155, 220, 79)'

interface SectionInfoDepositFormProps {
    selectedSlot: SlotData | null
    amount: string
    setAmount: (value: string) => void
    walletBalanceMBRN: string
    onMaxClick: () => void
    onCancel: () => void
    onDeposit: () => void
    isPending?: boolean
}

export const SectionInfoDepositForm: React.FC<SectionInfoDepositFormProps> = ({
    selectedSlot,
    amount,
    setAmount,
    walletBalanceMBRN,
    onMaxClick,
    onCancel,
    onDeposit,
    isPending,
}) => {
    return (
        <VStack spacing={4} align="stretch">
            {/* Slot Info Display */}
            <Box
                bg="rgba(155, 220, 79, 0.1)"
                p={3}
                borderRadius="md"
                border="1px solid"
                borderColor={`${PRIMARY_PURPLE}40`}
            >
                <Text
                    fontSize="sm"
                    fontWeight="bold"
                    color={PRIMARY_PURPLE}
                    fontFamily="mono"
                    letterSpacing="1px"
                    mb={2}
                    textTransform="uppercase"
                >
                    Slot Details
                </Text>
                <VStack spacing={1.5} align="stretch">
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                            Slot
                        </Text>
                        <Text fontSize="xs" fontWeight="bold" color={PRIMARY_PURPLE} fontFamily="mono">
                            {getSlotLabel(selectedSlot?.slot || 0)}
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                            TVL
                        </Text>
                        <Text fontSize="xs" fontWeight="bold" color="secondary.400" fontFamily="mono">
                            {selectedSlot?.tvl
                                ? parseFloat(shiftDigits(selectedSlot.tvl.toString(), -6).toString()).toLocaleString()
                                : '0'} MBRN
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                            APR
                        </Text>
                        <Text fontSize="xs" fontWeight="bold" color={selectedSlot?.apr ? "secondary.400" : "whiteAlpha.500"} fontFamily="mono">
                            {selectedSlot?.apr || 'N/A'}
                        </Text>
                    </HStack>
                </VStack>
            </Box>

            {/* Amount Input */}
            <Box>
                <HStack justify="space-between" mb={2}>
                    <Text
                        fontSize="xs"
                        color="whiteAlpha.600"
                        fontFamily="mono"
                        letterSpacing="0.5px"
                    >
                        Amount (MBRN)
                    </Text>
                    <Text
                        fontSize="xs"
                        color={PRIMARY_PURPLE}
                        fontFamily="mono"
                        letterSpacing="0.5px"
                        cursor="pointer"
                        _hover={{
                            color: 'rgb(186, 166, 255)',
                            textDecoration: 'underline'
                        }}
                        onClick={onMaxClick}
                    >
                        Wallet: {parseFloat(walletBalanceMBRN || '0').toLocaleString()}
                    </Text>
                </HStack>
                <NumberInput
                    value={amount}
                    onChange={(valueString) => setAmount(valueString)}
                    min={0}
                    max={parseFloat(walletBalanceMBRN || '0')}
                >
                    <NumberInputField
                        bg="rgba(10, 10, 10, 0.8)"
                        border="1px solid"
                        borderColor={`${PRIMARY_PURPLE}40`}
                        color="white"
                        fontFamily="mono"
                        fontSize="sm"
                        _hover={{ borderColor: `${PRIMARY_PURPLE}60` }}
                        _focus={{
                            borderColor: PRIMARY_PURPLE,
                            boxShadow: `0 0 0 1px ${PRIMARY_PURPLE}40`
                        }}
                        placeholder="0.00"
                        autoFocus
                    />
                </NumberInput>
            </Box>

            {/* Action Buttons */}
            <VStack spacing={2} align="stretch">
                <HStack spacing={2}>
                    <Button
                        flex={1}
                        size="sm"
                        variant="outline"
                        borderColor={`${PRIMARY_PURPLE}40`}
                        color="whiteAlpha.700"
                        fontFamily="mono"
                        fontSize="xs"
                        _hover={{
                            borderColor: PRIMARY_PURPLE,
                            color: 'white'
                        }}
                        onClick={onCancel}
                    >
                        Cancel
                    </Button>
                    <Button
                        flex={1}
                        size="sm"
                        bg={PRIMARY_PURPLE}
                        color="white"
                        fontFamily="mono"
                        fontSize="xs"
                        fontWeight="bold"
                        _hover={{
                            bg: 'rgb(186, 166, 255)',
                            boxShadow: `0 0 15px ${PRIMARY_PURPLE}60`
                        }}
                        isDisabled={!amount || parseFloat(amount) <= 0}
                        isLoading={isPending}
                        onClick={onDeposit}
                    >
                        Deposit
                    </Button>
                </HStack>
            </VStack>
        </VStack>
    )
}
