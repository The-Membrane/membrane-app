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

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

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
        <VStack align="stretch" spacing={SPACING.base} w="100%" h="100%" pb="50px" overflowY="auto">
            <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textSecondary}
                fontWeight={TYPOGRAPHY.bold}
                textTransform="uppercase"
                letterSpacing="0.28em"
            >
                {isStaking ? 'Stake MBRN' : 'Deposit to LTV Disco'}
            </Text>

            {/* Amount Input */}
            <Box>
                <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.label}
                    color={SEMANTIC_COLORS.textSecondary}
                    textTransform="uppercase"
                    letterSpacing="0.28em"
                    mb={SPACING.sm}
                >
                    Amount (MBRN)
                </Text>
                <NumberInput
                    value={amount}
                    onChange={handleAmountChange}
                    min={0}
                >
                    <NumberInputField
                        bg={SEMANTIC_COLORS.bgTertiary}
                        border="1px solid"
                        borderRadius={0}
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.borderHighlight}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        placeholder="0.00"
                    />
                </NumberInput>
            </Box>

            {/* Lock Days Slider */}
            <Box>
                <HStack justify="space-between" mb={SPACING.sm}>
                    <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.label}
                        color={SEMANTIC_COLORS.textSecondary}
                        textTransform="uppercase"
                        letterSpacing="0.28em"
                    >
                        Lock Duration
                    </Text>
                    <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.primary}
                        fontWeight={TYPOGRAPHY.bold}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
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
                    <SliderTrack bg={SEMANTIC_COLORS.bgTertiary} h="6px" borderRadius={0}>
                        <SliderFilledTrack bg={SEMANTIC_COLORS.primary} />
                    </SliderTrack>
                    <SliderThumb
                        boxSize={4}
                        bg={SEMANTIC_COLORS.primary}
                        border="2px solid"
                        borderColor={SEMANTIC_COLORS.bgPrimary}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                    />
                </Slider>
                <HStack justify="space-between" mt={SPACING.xs}>
                    <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textTertiary}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        {effectiveMinLockDays}
                    </Text>
                    <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textTertiary}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        {maxLockDays}
                    </Text>
                </HStack>
            </Box>

            {/* Boost Preview */}
            <Box
                bg={SEMANTIC_COLORS.bgTertiary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                p={SPACING.md}
            >
                <HStack justify="space-between">
                    <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.label}
                        color={SEMANTIC_COLORS.textSecondary}
                        textTransform="uppercase"
                        letterSpacing="0.28em"
                    >
                        Effective MBRN Boost
                    </Text>
                    <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.info}
                        fontWeight={TYPOGRAPHY.bold}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                        {(lockDays + 1).toFixed(1)}x
                    </Text>
                </HStack>
            </Box>

            {/* Info Text */}
            <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
            >
                Note: The lock period applies from the deposit time.
            </Text>

            {/* Submit Button */}
            <Button
                position={"fixed"}
                bottom={0}
                left={0}
                right={0}
                size="sm"
                borderRadius={0}
                bg={SEMANTIC_COLORS.primary}
                color={SEMANTIC_COLORS.bgPrimary}
                fontFamily={TYPOGRAPHY.fontMono}
                onClick={handleSubmit}
                isDisabled={!amount || parseFloat(amount) <= 0}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _active={ACTIVE_EFFECTS.dim}
                _focus={FOCUS_STYLES.ring}
                _focusVisible={FOCUS_STYLES.ring}
                _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
                mt="auto"
            >
                {isStaking ? 'Stake' : 'Deposit'}
            </Button>
        </VStack>
    )
}

