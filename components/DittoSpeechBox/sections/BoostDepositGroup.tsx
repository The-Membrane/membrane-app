import React from 'react'
import { VStack, Text, Box, HStack, Icon, BoxProps } from '@chakra-ui/react'
import { Pencil } from 'lucide-react'
import { BoostDeposit } from './BoostTypes'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'

interface BoostDepositGroupProps {
    title: string
    type: 'staking' | 'disco'
    baseMBRN: string
    lockedDeposits: BoostDeposit[]
    totalEffectiveMBRN: string
    totalEffectiveColor: string
    formatMBRN: (amount: string) => string
    boostContribution: (deposit: BoostDeposit) => string
    onNewDeposit: (type: 'staking' | 'disco') => void
    onDepositClick: (type: 'staking' | 'disco', index: number) => void
    isSelected: (type: 'staking' | 'disco', index: number) => boolean
    getDepositStyles: (type: 'staking' | 'disco', index: number) => BoxProps
}

export const BoostDepositGroup: React.FC<BoostDepositGroupProps> = ({
    title,
    type,
    baseMBRN,
    lockedDeposits,
    totalEffectiveMBRN,
    totalEffectiveColor,
    formatMBRN,
    boostContribution,
    onNewDeposit,
    onDepositClick,
    isSelected,
    getDepositStyles,
}) => {
    return (
        <Box>
            <HStack
                mb={SPACING.sm}
                cursor="pointer"
                role="button"
                tabIndex={0}
                aria-label={`New ${title} deposit`}
                onClick={() => onNewDeposit(type)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onNewDeposit(type)
                    }
                }}
                _hover={{ opacity: 0.8 }}
                _focus={FOCUS_STYLES.ring}
                transition={TRANSITIONS.opacityQuick}
            >
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontWeight="bold">
                    {title}
                </Text>
                <Icon as={Pencil} w={3} h={3} color={SEMANTIC_COLORS.textTertiary} />
            </HStack>
            <VStack align="stretch" spacing={SPACING.sm}>
                <HStack justify="space-between">
                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                        Base MBRN
                    </Text>
                    <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">
                        {formatMBRN(baseMBRN)} MBRN
                    </Text>
                </HStack>
                {lockedDeposits.length > 0 && (
                    <VStack align="stretch" spacing={SPACING.sm} mt={SPACING.sm}>
                        {lockedDeposits.map((deposit, idx) => (
                            <Box
                                key={deposit.lockedUntil}
                                role="button"
                                tabIndex={0}
                                aria-pressed={isSelected(type, idx)}
                                aria-label={`Select ${title} deposit ${idx + 1}`}
                                onClick={() => onDepositClick(type, idx)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        onDepositClick(type, idx)
                                    }
                                }}
                                _focus={FOCUS_STYLES.ring}
                                _focusVisible={FOCUS_STYLES.ring}
                                {...getDepositStyles(type, idx)}
                            >
                                <Box bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} position="relative" zIndex={1}>
                                    {/* Edit icon indicator */}
                                    <HStack justify="flex-end" mb={SPACING.xs}>
                                        <Icon
                                            as={Pencil}
                                            w={3}
                                            h={3}
                                            color={isSelected(type, idx) ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textTertiary}
                                            opacity={isSelected(type, idx) ? 1 : 0.5}
                                            transition={TRANSITIONS.opacityQuick}
                                        />
                                    </HStack>
                                    <VStack align="stretch" spacing={SPACING.sm}>
                                        <HStack justify="space-between">
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                                Deposit Amount
                                            </Text>
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">
                                                {formatMBRN(deposit.amount)} MBRN
                                            </Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                                Lock Duration
                                            </Text>
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.primary}>
                                                {deposit.daysRemaining} days
                                            </Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                                Boost Contribution
                                            </Text>
                                            <Text fontSize="xs" color={SEMANTIC_COLORS.info} fontWeight="bold">
                                                +{boostContribution(deposit)} MBRN
                                            </Text>
                                        </HStack>
                                    </VStack>
                                </Box>
                            </Box>
                        ))}
                    </VStack>
                )}
                <HStack justify="space-between" mt={SPACING.sm}>
                    <Text fontSize="xs" fontWeight="bold" color={SEMANTIC_COLORS.textSecondary}>
                        Total Effective MBRN
                    </Text>
                    <Text fontSize="xs" fontWeight="bold" color={totalEffectiveColor}>
                        {formatMBRN(totalEffectiveMBRN)} MBRN
                    </Text>
                </HStack>
            </VStack>
        </Box>
    )
}
