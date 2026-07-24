import React, { useState, useEffect, useRef } from 'react'
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
    // rerender-lazy-state-init FP: Math.max(minLockDays, 30) is a single O(1)
    // comparison, not an expensive init, so a lazy useState initializer isn't warranted.
    const [lockDays, setLockDays] = useState(Math.max(minLockDays, 30))

    // Snapshot of the initial amount/lockDays plus the latest onChange, held in
    // refs so the mount-only effect below can read them without needing them in
    // its dependency array (ref reads are exempt from exhaustive-deps). This
    // keeps the effect's deps array empty so it runs exactly once, reporting the
    // starting values to the parent for the live preview. All subsequent changes
    // are reported directly from the input handlers instead of via an
    // effect that mirrors state into a prop callback.
    const initialValuesRef = useRef({ amount, lockDays })
    const onChangeRef = useRef(onChange)
    // Keep the ref current WITHOUT writing during render (no-ref-current-in-render):
    // update it in an effect so post-commit reads still see the latest onChange.
    useEffect(() => { onChangeRef.current = onChange }, [onChange])

    useEffect(() => {
        onChangeRef.current?.(initialValuesRef.current.amount, initialValuesRef.current.lockDays)
    }, [])

    const handleAmountChange = (valueString: string) => {
        setAmount(valueString)
        onChange?.(valueString, lockDays)
    }

    const handleLockDaysChange = (val: number) => {
        setLockDays(val)
        onChange?.(amount, val)
    }

    const handleSubmit = () => {
        if (!amount || parseFloat(amount) <= 0) return
        onSubmit(amount, lockDays)
    }

    const isStaking = depositType === 'staking'
    const maxLockDays = 365
    const effectiveMinLockDays = minLockDays

    return (
        <VStack align="stretch" spacing={4} w="100%" h="100%" pb="50px" overflowY="auto">
            <Text fontSize="xs" color="#ece6d880" fontWeight="bold" textTransform="uppercase">
                {isStaking ? 'Stake MBRN' : 'Deposit to LTV Disco'}
            </Text>

            {/* Amount Input */}
            <Box>
                <Text fontSize="xs" color="#ece6d880" mb={2}>
                    Amount (MBRN)
                </Text>
                <NumberInput
                    value={amount}
                    onChange={handleAmountChange}
                    min={0}
                >
                    <NumberInputField
                        bg="#1A1D26"
                        border="1px solid"
                        borderColor="#9bdc4f30"
                        color="#ece6d8"
                        fontSize="sm"
                        _hover={{ borderColor: '#9bdc4f60' }}
                        _focus={{ borderColor: '#9F7AEA', boxShadow: '0 0 0 1px #9F7AEA' }}
                        placeholder="0.00"
                    />
                </NumberInput>
            </Box>

            {/* Lock Days Slider */}
            <Box>
                <HStack justify="space-between" mb={2}>
                    <Text fontSize="xs" color="#ece6d880">
                        Lock Duration
                    </Text>
                    <Text fontSize="xs" color="primary.300" fontWeight="bold">
                        {lockDays} days
                    </Text>
                </HStack>
                <Slider
                    value={lockDays}
                    onChange={handleLockDaysChange}
                    min={effectiveMinLockDays}
                    max={maxLockDays}
                    step={1}
                >
                    <SliderTrack bg="#1A1D26" h="6px" borderRadius="full">
                        <SliderFilledTrack bg="primary.400" />
                    </SliderTrack>
                    <SliderThumb
                        boxSize={4}
                        bg="primary.400"
                        border="2px solid"
                        borderColor="white"
                        _focus={{ boxShadow: '0 0 10px rgba(159, 122, 234, 0.5)' }}
                    />
                </Slider>
                <HStack justify="space-between" mt={1}>
                    <Text fontSize="2xs" color="#ece6d850">{effectiveMinLockDays}</Text>
                    <Text fontSize="2xs" color="#ece6d850">{maxLockDays}</Text>
                </HStack>
            </Box>

            {/* Boost Preview */}
            <Box
                bg="#1A1D26"
                border="1px solid"
                borderColor="#9bdc4f30"
                borderRadius="md"
                p={3}
            >
                <HStack justify="space-between">
                    <Text fontSize="xs" color="#ece6d880">
                        Effective MBRN Boost
                    </Text>
                    <Text fontSize="xs" color="secondary.300" fontWeight="bold">
                        {(lockDays + 1).toFixed(1)}x
                    </Text>
                </HStack>
            </Box>

            {/* Info Text */}
            <Text fontSize="2xs" color="#ece6d850">
                Note: The lock period applies from the deposit time.
            </Text>

            {/* Submit Button */}
            <Button

                position={"fixed"}
                bottom={0}
                left={0}
                right={0}
                size="sm"
                bg="primary.500"
                color="white"
                onClick={handleSubmit}
                isDisabled={!amount || parseFloat(amount) <= 0}
                _hover={{ bg: 'primary.400', boxShadow: '0 0 15px rgba(159, 122, 234, 0.4)' }}
                _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
                mt="auto"
            >
                {isStaking ? 'Stake' : 'Deposit'}
            </Button>
        </VStack>
    )
}

