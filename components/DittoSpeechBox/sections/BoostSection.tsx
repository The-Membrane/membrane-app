import React, { useState } from 'react'
import { VStack, Text, Box, HStack, Divider, Button, Icon } from '@chakra-ui/react'
import { ChevronLeft, Pencil } from 'lucide-react'
import { SectionComponentProps } from '../types'
import { useBoostBreakdown } from '@/components/Manic/hooks/useBoostBreakdown'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import { DepositForm } from './DepositForm'
import { WithdrawForm } from './WithdrawForm'
import { EditLockForm } from './EditLockForm'

interface SelectedDeposit {
    type: 'staking' | 'disco'
    index: number
}

type ActiveForm = 'deposit' | 'withdraw' | 'edit' | null

// Mock data for UI testing - remove or set USE_MOCK_DATA to false for production
const USE_MOCK_DATA = true

const MOCK_BREAKDOWN = {
    totalBoost: '0.045', // 4.5%
    staking: {
        baseMBRN: '15000000000', // 15,000 MBRN
        lockedDeposits: [
            {
                amount: '5000000000', // 5,000 MBRN
                lockedUntil: Math.floor(Date.now() / 1000) + 86400 * 180,
                boostAmount: '2500000000', // 2,500 MBRN boost
                daysRemaining: 180,
            },
            {
                amount: '10000000000', // 10,000 MBRN
                lockedUntil: Math.floor(Date.now() / 1000) + 86400 * 90,
                boostAmount: '3000000000', // 3,000 MBRN boost
                daysRemaining: 90,
            },
        ],
        totalEffectiveMBRN: '20500000000', // 20,500 MBRN
    },
    ltvDisco: {
        baseMBRN: '8000000000', // 8,000 MBRN
        lockedDeposits: [
            {
                amount: '3000000000', // 3,000 MBRN
                lockedUntil: Math.floor(Date.now() / 1000) + 86400 * 365,
                boostAmount: '3000000000', // 3,000 MBRN boost (100% for max lock)
                daysRemaining: 365,
            },
            {
                amount: '2000000000', // 2,000 MBRN
                lockedUntil: Math.floor(Date.now() / 1000) + 86400 * 30,
                boostAmount: '200000000', // 200 MBRN boost
                daysRemaining: 30,
            },
            {
                amount: '3000000000', // 3,000 MBRN
                lockedUntil: Math.floor(Date.now() / 1000) + 86400 * 45,
                boostAmount: '450000000', // 450 MBRN boost
                daysRemaining: 45,
            },
        ],
        totalEffectiveMBRN: '11650000000', // 11,650 MBRN
    },
}

export const BoostSection: React.FC<SectionComponentProps> = ({ onBack }) => {
    const { data: breakdown, isLoading } = useBoostBreakdown()
    const router = useRouter()
    const { chainName } = useChainRoute()
    const [selectedDeposit, setSelectedDeposit] = useState<SelectedDeposit | null>(null)
    const [activeForm, setActiveForm] = useState<ActiveForm>(null)
    // Track pending deposit form values for live preview
    const [pendingAmount, setPendingAmount] = useState('')
    const [pendingLockDays, setPendingLockDays] = useState(30)

    const formatMBRN = (amount: string) => {
        return shiftDigits(amount, -6).toFixed(2)
    }

    // Use mock data if enabled and no real data available
    const displayBreakdown = breakdown || (USE_MOCK_DATA ? MOCK_BREAKDOWN : {
        totalBoost: '0',
        staking: {
            baseMBRN: '0',
            lockedDeposits: [],
            totalEffectiveMBRN: '0',
        },
        ltvDisco: {
            baseMBRN: '0',
            lockedDeposits: [],
            totalEffectiveMBRN: '0',
        },
    })

    const boostPercent = num(displayBreakdown.totalBoost).times(100).toFixed(2)

    const isSelected = (type: 'staking' | 'disco', index: number) => {
        return selectedDeposit?.type === type && selectedDeposit?.index === index
    }

    const hasSelection = selectedDeposit !== null

    const handleDepositClick = (type: 'staking' | 'disco', index: number) => {
        if (isSelected(type, index)) {
            setSelectedDeposit(null)
        } else {
            setSelectedDeposit({ type, index })
        }
    }

    const handleDeposit = () => {
        if (!selectedDeposit) return
        setActiveForm('deposit')
    }

    const handleWithdraw = () => {
        if (!selectedDeposit) return
        setActiveForm('withdraw')
    }

    const handleEditLock = () => {
        if (!selectedDeposit) return
        setActiveForm('edit')
    }

    const handleBackToMain = () => {
        setActiveForm(null)
        // Clear selection when backing out, especially for new deposits
        setSelectedDeposit(null)
    }

    // Handle new deposit from section title click (no existing deposit selected)
    const handleNewDeposit = (type: 'staking' | 'disco') => {
        // Create a "virtual" selection for new deposit with no lock
        setSelectedDeposit({ type, index: -1 })
        setActiveForm('deposit')
    }

    // Get the selected deposit data
    const getSelectedDepositData = () => {
        if (!selectedDeposit) return null
        // For new deposits (index -1), return mock empty data
        if (selectedDeposit.index === -1) {
            return {
                amount: '0',
                lockedUntil: 0,
                boostAmount: '0',
                daysRemaining: 0,
            }
        }
        const deposits = selectedDeposit.type === 'staking'
            ? displayBreakdown.staking.lockedDeposits
            : displayBreakdown.ltvDisco.lockedDeposits
        return deposits[selectedDeposit.index]
    }

    // Check if selected deposit is locked
    const isSelectedDepositLocked = (): boolean => {
        const data = getSelectedDepositData()
        return Boolean(data && data.daysRemaining > 0)
    }

    const getDepositStyles = (type: 'staking' | 'disco', index: number) => {
        const selected = isSelected(type, index)
        const otherSelected = hasSelection && !selected

        return {
            bg: '#1A1D26',
            border: '1px solid',
            borderColor: selected ? '#9F7AEA' : otherSelected ? '#6943FF10' : '#6943FF30',
            borderRadius: 'md',
            p: 2,
            cursor: 'pointer',
            transition: 'all 0.2s ease-in-out',
            transform: selected ? 'scale(1.02)' : 'scale(1)',
            opacity: otherSelected ? 0.5 : 1,
            position: 'relative' as const,
            boxShadow: selected ? '0 0 8px rgba(159, 122, 234, 0.5)' : 'none',
            _hover: {
                borderColor: selected ? '#9F7AEA' : '#6943FF60',
                transform: selected ? 'scale(1.02)' : 'scale(1.01)',
                boxShadow: selected ? '0 0 8px rgba(159, 122, 234, 0.5)' : '0 0 4px rgba(105, 67, 255, 0.3)',
            },
        }
    }

    // Mock submit handlers for forms
    const handleFormSubmit = (formType: string, data: any) => {
        console.log(`[BoostSection] ${formType} submitted:`, data)
        // TODO: Wire up to actual contract calls
        setActiveForm(null)
    }

    if (isLoading) {
        return (
            <Box>
                <Text fontSize="xs" color="#F5F5F580">
                    Loading boost data...
                </Text>
            </Box>
        )
    }

    const selectedDepositData = getSelectedDepositData()

    // Form View - 50/50 split with back button
    if (activeForm && selectedDeposit && selectedDepositData) {
        return (
            <VStack spacing={0} align="stretch" w="100%" h="100%">
                {/* Back Button Header */}
                <Box
                    w="100%"
                    mb={3}
                    pb={2}
                    borderBottom="1px solid"
                    borderColor="#6943FF30"
                >
                    <Button
                        leftIcon={<Icon as={ChevronLeft} w={4} h={4} />}
                        size="sm"
                        variant="ghost"
                        color="#F5F5F580"
                        onClick={handleBackToMain}
                        _hover={{ bg: '#6943FF20', color: '#F5F5F5' }}
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
                        <Text fontSize="xs" color="#F5F5F580" mb={2} fontWeight="bold" textTransform="uppercase">
                            {selectedDeposit.index === -1 ? 'Pending Deposit' : 'Selected Deposit'}
                        </Text>
                        <VStack align="stretch" spacing={2}>
                            <HStack justify="space-between">
                                <Text fontSize="xs" color="#F5F5F580">
                                    Type
                                </Text>
                                <Text fontSize="xs" color={selectedDeposit.type === 'staking' ? 'cyan.300' : 'purple.300'} fontWeight="bold">
                                    {selectedDeposit.type === 'staking' ? 'Staking' : 'LTV Disco'}
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="xs" color="#F5F5F580">
                                    Amount
                                </Text>
                                <Text fontSize="xs" color="#F5F5F5" fontWeight="bold">
                                    {selectedDeposit.index === -1
                                        ? (pendingAmount ? `${pendingAmount} MBRN` : '0.00 MBRN')
                                        : `${formatMBRN(selectedDepositData.amount)} MBRN`
                                    }
                                </Text>
                            </HStack>
                            <HStack justify="space-between">
                                <Text fontSize="xs" color="#F5F5F580">
                                    {selectedDeposit.index === -1 ? 'Lock Duration' : 'Lock Remaining'}
                                </Text>
                                <Text fontSize="xs" color="purple.300">
                                    {selectedDeposit.index === -1
                                        ? `${pendingLockDays} days`
                                        : `${selectedDepositData.daysRemaining} days`
                                    }
                                </Text>
                            </HStack>
                        </VStack>
                    </Box>
                </Box>

                <Divider mb={3} borderColor="#6943FF30" />

                {/* Bottom 50%: Form */}
                <Box flex={1} minH="45%">
                    {activeForm === 'deposit' && (
                        <DepositForm
                            depositType={selectedDeposit.type}
                            minLockDays={selectedDepositData.daysRemaining > 0 ? selectedDepositData.daysRemaining : 0}
                            onSubmit={(amount, lockDays) => handleFormSubmit('deposit', { amount, lockDays })}
                            onChange={(amount, lockDays) => {
                                setPendingAmount(amount)
                                setPendingLockDays(lockDays)
                            }}
                        />
                    )}
                    {activeForm === 'withdraw' && (
                        <WithdrawForm
                            depositType={selectedDeposit.type}
                            maxAmount={selectedDepositData.amount}
                            onSubmit={(amount) => handleFormSubmit('withdraw', { amount })}
                        />
                    )}
                    {activeForm === 'edit' && (
                        <EditLockForm
                            depositType={selectedDeposit.type}
                            currentLockDays={selectedDepositData.daysRemaining}
                            onSubmit={(newLockDays) => handleFormSubmit('editLock', { newLockDays })}
                        />
                    )}
                </Box>
            </VStack>
        )
    }

    // Main View - Deposit list with action buttons
    return (
        <VStack spacing={3} align="stretch" w="100%" h="100%" position="relative" overflow="hidden">
            {/* Scrollable Content */}
            <Box flex={1} overflowY="auto" pb="70px">
                {/* Summary */}
                <Box>
                    <HStack spacing={4} align="flex-start" wrap="wrap" justifyContent="center">
                        <VStack>
                            <Text fontSize="xs" color="#F5F5F580" mb={1}>
                                Total Boost
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color="cyan.400" mb={3}>
                                {boostPercent}%
                            </Text>
                        </VStack>
                    </HStack>
                </Box>

                <Divider mb={4} mt={4} />

                {/* Staking Section */}
                <Box>
                    <HStack
                        mb={2}
                        cursor="pointer"
                        onClick={() => handleNewDeposit('staking')}
                        _hover={{ opacity: 0.8 }}
                        transition="opacity 0.2s"
                    >
                        <Text fontSize="xs" color="#F5F5F580" fontWeight="bold">
                            STAKING
                        </Text>
                        <Icon as={Pencil} w={3} h={3} color="#F5F5F550" />
                    </HStack>
                    <VStack align="stretch" spacing={2}>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#F5F5F580">
                                Base MBRN
                            </Text>
                            <Text fontSize="xs" color="#F5F5F5" fontWeight="bold">
                                {formatMBRN(displayBreakdown.staking.baseMBRN)} MBRN
                            </Text>
                        </HStack>
                        {displayBreakdown.staking.lockedDeposits.length > 0 && (
                            <VStack align="stretch" spacing={2} mt={2}>
                                {displayBreakdown.staking.lockedDeposits.map((deposit, idx) => (
                                    <Box
                                        key={idx}
                                        onClick={() => handleDepositClick('staking', idx)}
                                        {...getDepositStyles('staking', idx)}
                                    >
                                        <Box bg="#1A1D26" borderRadius="md" position="relative" zIndex={1}>
                                            {/* Edit icon indicator */}
                                            <HStack justify="flex-end" mb={1}>
                                                <Icon
                                                    as={Pencil}
                                                    w={3}
                                                    h={3}
                                                    color={isSelected('staking', idx) ? '#9F7AEA' : '#F5F5F550'}
                                                    opacity={isSelected('staking', idx) ? 1 : 0.5}
                                                    transition="opacity 0.2s"
                                                />
                                            </HStack>
                                            <VStack align="stretch" spacing={2}>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="#F5F5F580">
                                                        Deposit Amount
                                                    </Text>
                                                    <Text fontSize="xs" color="#F5F5F5" fontWeight="bold">
                                                        {formatMBRN(deposit.amount)} MBRN
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="#F5F5F580">
                                                        Lock Duration
                                                    </Text>
                                                    <Text fontSize="xs" color="purple.300">
                                                        {deposit.daysRemaining} days
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="#F5F5F580">
                                                        Boost Contribution
                                                    </Text>
                                                    <Text fontSize="xs" color="cyan.300" fontWeight="bold">
                                                        +{num(deposit.boostAmount).plus(deposit.amount).shiftedBy(-6).toFixed(2)} MBRN
                                                    </Text>
                                                </HStack>
                                            </VStack>
                                        </Box>
                                    </Box>
                                ))}
                            </VStack>
                        )}
                        <HStack justify="space-between" mt={2}>
                            <Text fontSize="xs" fontWeight="bold" color="#F5F5F580">
                                Total Effective MBRN
                            </Text>
                            <Text fontSize="xs" fontWeight="bold" color="cyan.300">
                                {formatMBRN(displayBreakdown.staking.totalEffectiveMBRN)} MBRN
                            </Text>
                        </HStack>
                    </VStack>
                </Box>

                <Divider mb={4} mt={4} />

                {/* LTV Disco Section */}
                <Box>
                    <HStack
                        mb={2}
                        cursor="pointer"
                        onClick={() => handleNewDeposit('disco')}
                        _hover={{ opacity: 0.8 }}
                        transition="opacity 0.2s"
                    >
                        <Text fontSize="xs" color="#F5F5F580" fontWeight="bold">
                            LTV DISCO
                        </Text>
                        <Icon as={Pencil} w={3} h={3} color="#F5F5F550" />
                    </HStack>
                    <VStack align="stretch" spacing={2}>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#F5F5F580">
                                Base MBRN
                            </Text>
                            <Text fontSize="xs" color="#F5F5F5" fontWeight="bold">
                                {formatMBRN(displayBreakdown.ltvDisco.baseMBRN)} MBRN
                            </Text>
                        </HStack>
                        {displayBreakdown.ltvDisco.lockedDeposits.length > 0 && (
                            <VStack align="stretch" spacing={2} mt={2}>
                                {displayBreakdown.ltvDisco.lockedDeposits.map((deposit, idx) => (
                                    <Box
                                        key={idx}
                                        onClick={() => handleDepositClick('disco', idx)}
                                        {...getDepositStyles('disco', idx)}
                                    >
                                        <Box bg="#1A1D26" borderRadius="md" position="relative" zIndex={1}>
                                            {/* Edit icon indicator */}
                                            <HStack justify="flex-end" mb={1}>
                                                <Icon
                                                    as={Pencil}
                                                    w={3}
                                                    h={3}
                                                    color={isSelected('disco', idx) ? '#9F7AEA' : '#F5F5F550'}
                                                    opacity={isSelected('disco', idx) ? 1 : 0.5}
                                                    transition="opacity 0.2s"
                                                />
                                            </HStack>
                                            <VStack align="stretch" spacing={2}>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="#F5F5F580">
                                                        Deposit Amount
                                                    </Text>
                                                    <Text fontSize="xs" color="#F5F5F5" fontWeight="bold">
                                                        {formatMBRN(deposit.amount)} MBRN
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="#F5F5F580">
                                                        Lock Duration
                                                    </Text>
                                                    <Text fontSize="xs" color="purple.300">
                                                        {deposit.daysRemaining} days
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="xs" color="#F5F5F580">
                                                        Boost Contribution
                                                    </Text>
                                                    <Text fontSize="xs" color="cyan.300" fontWeight="bold">
                                                        +{formatMBRN(deposit.boostAmount)} MBRN
                                                    </Text>
                                                </HStack>
                                            </VStack>
                                        </Box>
                                    </Box>
                                ))}
                            </VStack>
                        )}
                        <HStack justify="space-between" mt={2}>
                            <Text fontSize="xs" fontWeight="bold" color="#F5F5F580">
                                Total Effective MBRN
                            </Text>
                            <Text fontSize="xs" fontWeight="bold" color="purple.300">
                                {formatMBRN(displayBreakdown.ltvDisco.totalEffectiveMBRN)} MBRN
                            </Text>
                        </HStack>
                    </VStack>
                </Box>
            </Box>

            {/* Action Buttons - Fixed at bottom of viewable area on selection */}
            <Box
                position={hasSelection ? "fixed" : "absolute"}
                bottom={0}
                left={0}
                right={0}
                bg="#23252B"
                borderTop="1px solid"
                borderColor={hasSelection ? '#9F7AEA' : '#6943FF30'}
                pt={3}
                px={1}
                pb={hasSelection ? 3 : 1}
                transition="all 0.25s cubic-bezier(0.4, 0, 0.2, 1)"
                boxShadow={hasSelection ? '0 -4px 20px rgba(159, 122, 234, 0.3)' : 'none'}
                zIndex={10}
            >
                <HStack spacing={2} w="100%">
                    <Button
                        size="sm"
                        variant="outline"
                        borderColor={hasSelection ? 'purple.400' : '#6943FF30'}
                        color={hasSelection ? 'purple.300' : '#F5F5F550'}
                        onClick={handleDeposit}
                        isDisabled={!hasSelection}
                        _hover={hasSelection ? {
                            bg: '#6943FF20',
                            boxShadow: '0 0 10px rgba(159, 122, 234, 0.3)',
                        } : {}}
                        _disabled={{
                            opacity: 0.5,
                            cursor: 'not-allowed',
                        }}
                        flex={1}
                        transition="all 0.2s"
                    >
                        Deposit
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        borderColor={hasSelection && !isSelectedDepositLocked() ? 'cyan.400' : '#6943FF30'}
                        color={hasSelection && !isSelectedDepositLocked() ? 'cyan.300' : '#F5F5F550'}
                        onClick={handleWithdraw}
                        isDisabled={!hasSelection || isSelectedDepositLocked()}
                        _hover={hasSelection && !isSelectedDepositLocked() ? {
                            bg: '#38B2AC20',
                            boxShadow: '0 0 10px rgba(56, 178, 172, 0.3)',
                        } : {}}
                        _disabled={{
                            opacity: 0.5,
                            cursor: 'not-allowed',
                        }}
                        flex={1}
                        transition="all 0.2s"
                        title={isSelectedDepositLocked() ? 'Cannot withdraw locked deposits' : ''}
                    >
                        Withdraw
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        borderColor={hasSelection ? 'blue.400' : '#6943FF30'}
                        color={hasSelection ? 'blue.300' : '#F5F5F550'}
                        onClick={handleEditLock}
                        isDisabled={!hasSelection}
                        _hover={hasSelection ? {
                            bg: '#4299E120',
                            boxShadow: '0 0 10px rgba(66, 153, 225, 0.3)',
                        } : {}}
                        _disabled={{
                            opacity: 0.5,
                            cursor: 'not-allowed',
                        }}
                        flex={1}
                        transition="all 0.2s"
                    >
                        Extend
                    </Button>
                </HStack>
            </Box>
        </VStack>
    )
}
