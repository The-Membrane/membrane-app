import React from 'react'
import { VStack, Text, Box, HStack, Divider, Button, Icon } from '@chakra-ui/react'
import { ChevronLeft } from 'lucide-react'
import { DepositForm } from './DepositForm'
import { WithdrawForm } from './WithdrawForm'
import { EditLockForm } from './EditLockForm'
import { SelectedDeposit, ActiveForm, BoostDeposit } from './BoostTypes'

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
                mb={3}
                pb={2}
                borderBottom="1px solid"
                borderColor="#9bdc4f30"
            >
                <Button
                    leftIcon={<Icon as={ChevronLeft} w={4} h={4} />}
                    size="sm"
                    variant="ghost"
                    color="#ece6d880"
                    onClick={onBack}
                    _hover={{ bg: '#9bdc4f20', color: '#ece6d8' }}
                    fontSize="xs"
                    fontWeight="normal"
                    px={2}
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
                    bg="#1A1D26"
                    border="1px solid"
                    borderColor={selectedDeposit.index === -1 ? '#38B2AC' : '#9F7AEA'}
                    borderRadius="md"
                    p={3}
                    boxShadow={selectedDeposit.index === -1 ? '0 0 10px rgba(56, 178, 172, 0.3)' : '0 0 10px rgba(159, 122, 234, 0.3)'}
                >
                    <Text fontSize="xs" color="#ece6d880" mb={2} fontWeight="bold" textTransform="uppercase">
                        {selectedDeposit.index === -1 ? 'Pending Deposit' : 'Selected Deposit'}
                    </Text>
                    <VStack align="stretch" spacing={2}>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#ece6d880">
                                Type
                            </Text>
                            <Text fontSize="xs" color={selectedDeposit.type === 'staking' ? 'secondary.300' : 'primary.300'} fontWeight="bold">
                                {selectedDeposit.type === 'staking' ? 'Staking' : 'LTV Disco'}
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#ece6d880">
                                Amount
                            </Text>
                            <Text fontSize="xs" color="#ece6d8" fontWeight="bold">
                                {selectedDeposit.index === -1
                                    ? (pendingAmount ? `${pendingAmount} MBRN` : '0.00 MBRN')
                                    : `${formatMBRN(selectedDepositData.amount)} MBRN`
                                }
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#ece6d880">
                                {selectedDeposit.index === -1 ? 'Lock Duration' : 'Lock Remaining'}
                            </Text>
                            <Text fontSize="xs" color="primary.300">
                                {selectedDeposit.index === -1
                                    ? `${pendingLockDays} days`
                                    : `${selectedDepositData.daysRemaining} days`
                                }
                            </Text>
                        </HStack>
                    </VStack>
                </Box>
            </Box>

            <Divider mb={3} borderColor="#9bdc4f30" />

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
