import React from 'react'
import { VStack, Text, Box, HStack, Divider, Button, Icon } from '@chakra-ui/react'
import { ChevronLeft } from 'lucide-react'
import { DepositForm } from './DepositForm'
import { WithdrawForm } from './WithdrawForm'
import { EditLockForm } from './EditLockForm'
import { SelectedDeposit, ActiveForm, BoostDeposit } from './BoostTypes'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'

interface BoostFormViewProps {
    selectedDeposit: SelectedDeposit
    selectedDepositData: BoostDeposit
    activeForm: ActiveForm
    formatMBRN: (amount: string) => string
    pendingAmount: string
    pendingLockDays: number
    onBack: () => void
    onDepositChange: (amount: string, lockDays: number) => void
    onFormSubmit: (formType: string, data: any) => void
}

export const BoostFormView: React.FC<BoostFormViewProps> = ({
    selectedDeposit,
    selectedDepositData,
    activeForm,
    formatMBRN,
    pendingAmount,
    pendingLockDays,
    onBack,
    onDepositChange,
    onFormSubmit,
}) => {
    return (
        <VStack spacing={0} align="stretch" w="100%" h="100%">
            {/* Back Button Header */}
            <Box
                w="100%"
                mb={SPACING.md}
                pb={SPACING.sm}
                borderBottom="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
            >
                <Button
                    leftIcon={<Icon as={ChevronLeft} w={4} h={4} />}
                    size="sm"
                    variant="ghost"
                    color={SEMANTIC_COLORS.textSecondary}
                    onClick={onBack}
                    transition={TRANSITIONS.colors}
                    _hover={{ color: SEMANTIC_COLORS.textPrimary }}
                    _focus={FOCUS_STYLES.ring}
                    fontSize="xs"
                    fontWeight="normal"
                    px={SPACING.sm}
                >
                    Back to Breakdown
                </Button>
            </Box>

            {/* Top 50%: Selected/Pending Deposit Summary */}
            <Box
                flex={1}
                maxH="45%"
                overflowY="auto"
                mb={3}
            >
                <Box
                    bg={SEMANTIC_COLORS.bgTertiary}
                    border="1px solid"
                    borderColor={selectedDeposit.index === -1 ? SEMANTIC_COLORS.secondary : SEMANTIC_COLORS.primary}
                    borderRadius={0}
                    p={SPACING.md}
                >
                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={SPACING.sm} fontWeight="bold" textTransform="uppercase">
                        {selectedDeposit.index === -1 ? 'Pending Deposit' : 'Selected Deposit'}
                    </Text>
                    <VStack align="stretch" spacing={SPACING.sm}>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                Type
                            </Text>
                            <Text fontSize="xs" color={selectedDeposit.type === 'staking' ? SEMANTIC_COLORS.info : SEMANTIC_COLORS.primary} fontWeight="bold">
                                {selectedDeposit.type === 'staking' ? 'Staking' : 'LTV Disco'}
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                Amount
                            </Text>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">
                                {selectedDeposit.index === -1
                                    ? (pendingAmount ? `${pendingAmount} MBRN` : '0.00 MBRN')
                                    : `${formatMBRN(selectedDepositData.amount)} MBRN`
                                }
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                {selectedDeposit.index === -1 ? 'Lock Duration' : 'Lock Remaining'}
                            </Text>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.primary}>
                                {selectedDeposit.index === -1
                                    ? `${pendingLockDays} days`
                                    : `${selectedDepositData.daysRemaining} days`
                                }
                            </Text>
                        </HStack>
                    </VStack>
                </Box>
            </Box>

            <Divider mb={SPACING.md} borderColor={SEMANTIC_COLORS.borderSubtle} />

            {/* Bottom 50%: Form */}
            <Box flex={1} minH="45%">
                {activeForm === 'deposit' && (
                    <DepositForm
                        depositType={selectedDeposit.type}
                        minLockDays={selectedDepositData.daysRemaining > 0 ? selectedDepositData.daysRemaining : 0}
                        onSubmit={(amount, lockDays) => onFormSubmit('deposit', { amount, lockDays })}
                        onChange={(amount, lockDays) => onDepositChange(amount, lockDays)}
                    />
                )}
                {activeForm === 'withdraw' && (
                    <WithdrawForm
                        depositType={selectedDeposit.type}
                        maxAmount={selectedDepositData.amount}
                        onSubmit={(amount) => onFormSubmit('withdraw', { amount })}
                    />
                )}
                {activeForm === 'edit' && (
                    <EditLockForm
                        depositType={selectedDeposit.type}
                        currentLockDays={selectedDepositData.daysRemaining}
                        onSubmit={(newLockDays) => onFormSubmit('editLock', { newLockDays })}
                    />
                )}
            </Box>
        </VStack>
    )
}
