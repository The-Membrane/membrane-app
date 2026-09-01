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

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

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
            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontWeight="bold" textTransform="uppercase">
                {isStaking ? 'Unstake MBRN' : 'Withdraw from LTV Disco'}
            </Text>

            {/* Amount Input */}
            <Box>
                <HStack justify="space-between" mb={2}>
                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                        Amount (MBRN)
                    </Text>
                    <Button
                        size="xs"
                        variant="ghost"
                        color={SEMANTIC_COLORS.info}
                        onClick={handleMax}
                        transition={TRANSITIONS.colors}
                        _hover={{ bg: SEMANTIC_COLORS.bgTertiary, color: SEMANTIC_COLORS.textPrimary }}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
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
                        bg={SEMANTIC_COLORS.bgSecondary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        borderRadius={0}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                        transition={TRANSITIONS.colors}
                        _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        placeholder="0.00"
                    />
                </NumberInput>
                <Text fontSize="2xs" color={SEMANTIC_COLORS.textTertiary} mt={1}>
                    Available: {maxAmountFormatted} MBRN
                </Text>
            </Box>

            {/* Warning for locked deposits */}
            <Box
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                p={SPACING.md}
            >
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.warning}>
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
                bg={SEMANTIC_COLORS.info}
                color={SEMANTIC_COLORS.bgPrimary}
                borderRadius={0}
                fontFamily={TYPOGRAPHY.fontMono}
                onClick={handleSubmit}
                isDisabled={!amount || parseFloat(amount) <= 0}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _active={ACTIVE_EFFECTS.dim}
                _focus={FOCUS_STYLES.ring}
                _focusVisible={FOCUS_STYLES.ring}
                _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
            >
                {isStaking ? 'Unstake' : 'Withdraw'}
            </Button>
        </VStack>
    )
}

