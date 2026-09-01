import React, { useState } from 'react'
import { VStack, Text, Box, HStack, Button } from '@chakra-ui/react'
import { PRIMARY_PURPLE } from './DiscoDepositsShared'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'

type DiscoDepositsDepositFormProps = Pick<
    DiscoDepositsData,
    | 'currentDeposit'
    | 'walletBalanceMBRN'
    | 'depositAmount'
    | 'setDepositAmount'
    | 'setShowDepositForm'
    | 'depositHook'
    | 'handleDepositSubmit'
>

// Static portion of the amount-input style, hoisted so it isn't reallocated every
// render; only boxShadow is dynamic (focus state) and stays inline.
const AMOUNT_INPUT_STYLE: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'white',
    fontFamily: 'monospace',
    fontSize: '14px',
    width: '100%',
    transition: TRANSITIONS.shadow,
    borderRadius: '4px',
}

export const DiscoDepositsDepositForm: React.FC<DiscoDepositsDepositFormProps> = ({
    currentDeposit,
    walletBalanceMBRN,
    depositAmount,
    setDepositAmount,
    setShowDepositForm,
    depositHook,
    handleDepositSubmit,
}) => {
    const [isAmountFocused, setIsAmountFocused] = useState(false)
    return (
        <Box mt={4}>
            <VStack spacing={3} align="stretch">
                <Text fontSize="sm" fontWeight="bold" color={PRIMARY_PURPLE} fontFamily="mono" textTransform="uppercase">
                    Deposit to Slot {currentDeposit?.slot}
                </Text>
                <HStack justify="space-between">
                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">Amount (MBRN)</Text>
                    <Text
                        fontSize="xs"
                        color={PRIMARY_PURPLE}
                        fontFamily="mono"
                        cursor="pointer"
                        _hover={{ textDecoration: 'underline' }}
                        onClick={() => setDepositAmount(walletBalanceMBRN)}
                    >
                        Wallet: {parseFloat(walletBalanceMBRN || '0').toLocaleString('en-US')}
                    </Text>
                </HStack>
                <Box
                    bg="rgba(10, 10, 10, 0.8)"
                    border="1px solid"
                    borderColor={`${PRIMARY_PURPLE}40`}
                    borderRadius="md"
                    px={3}
                    py={2}
                >
                    <input
                        type="number"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        onFocus={() => setIsAmountFocused(true)}
                        onBlur={() => setIsAmountFocused(false)}
                        placeholder="0.00"
                        style={{
                            ...AMOUNT_INPUT_STYLE,
                            boxShadow: isAmountFocused ? FOCUS_STYLES.ring.boxShadow : 'none',
                        }}
                    />
                </Box>
                <HStack spacing={2}>
                    <Button
                        flex={1}
                        size="sm"
                        variant="outline"
                        borderColor={`${PRIMARY_PURPLE}40`}
                        color="whiteAlpha.700"
                        fontFamily="mono"
                        fontSize="xs"
                        _hover={{ borderColor: PRIMARY_PURPLE, color: 'white' }}
                        onClick={() => { setShowDepositForm(false); setDepositAmount('') }}
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
                        _hover={{ bg: 'rgb(186, 166, 255)', boxShadow: `0 0 15px ${PRIMARY_PURPLE}60` }}
                        isDisabled={!depositAmount || parseFloat(depositAmount) <= 0}
                        isLoading={depositHook.action?.tx?.isPending}
                        onClick={handleDepositSubmit}
                    >
                        Deposit
                    </Button>
                </HStack>
            </VStack>
        </Box>
    )
}
