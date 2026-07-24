import React, { useState } from 'react'
import { VStack, Text, Box, HStack, Divider } from '@chakra-ui/react'
import { SectionComponentProps } from '../types'
import { useBoostBreakdown } from '@/components/Manic/hooks/useBoostBreakdown'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import { SelectedDeposit, ActiveForm } from './BoostTypes'
import { BoostDepositGroup } from './BoostDepositGroup'
import { BoostActionBar } from './BoostActionBar'
import { BoostFormView } from './BoostFormView'

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

const formatMBRN = (amount: string) => {
    return shiftDigits(amount, -6).toFixed(2)
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
            borderColor: selected ? '#9F7AEA' : otherSelected ? '#9bdc4f10' : '#9bdc4f30',
            borderRadius: 'md',
            p: 2,
            cursor: 'pointer',
            transition: 'all 0.2s ease-in-out',
            transform: selected ? 'scale(1.02)' : 'scale(1)',
            opacity: otherSelected ? 0.5 : 1,
            position: 'relative' as const,
            boxShadow: selected ? '0 0 8px rgba(159, 122, 234, 0.5)' : 'none',
            _hover: {
                borderColor: selected ? '#9F7AEA' : '#9bdc4f60',
                transform: selected ? 'scale(1.02)' : 'scale(1.01)',
                boxShadow: selected ? '0 0 8px rgba(159, 122, 234, 0.5)' : '0 0 4px rgba(155, 220, 79, 0.3)',
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
                <Text fontSize="xs" color="#ece6d880">
                    Loading boost data...
                </Text>
            </Box>
        )
    }

    const selectedDepositData = getSelectedDepositData()

    // Form View - 50/50 split with back button
    if (activeForm && selectedDeposit && selectedDepositData) {
        return (
            <BoostFormView
                selectedDeposit={selectedDeposit}
                selectedDepositData={selectedDepositData}
                activeForm={activeForm}
                formatMBRN={formatMBRN}
                pendingAmount={pendingAmount}
                pendingLockDays={pendingLockDays}
                onBack={handleBackToMain}
                onDepositChange={(amount, lockDays) => {
                    setPendingAmount(amount)
                    setPendingLockDays(lockDays)
                }}
                onFormSubmit={handleFormSubmit}
            />
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
                            <Text fontSize="xs" color="#ece6d880" mb={1}>
                                Total Boost
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color="secondary.400" mb={3}>
                                {boostPercent}%
                            </Text>
                        </VStack>
                    </HStack>
                </Box>

                <Divider mb={4} mt={4} />

                {/* Staking Section */}
                <BoostDepositGroup
                    title="STAKING"
                    type="staking"
                    baseMBRN={displayBreakdown.staking.baseMBRN}
                    lockedDeposits={displayBreakdown.staking.lockedDeposits}
                    totalEffectiveMBRN={displayBreakdown.staking.totalEffectiveMBRN}
                    totalEffectiveColor="secondary.300"
                    formatMBRN={formatMBRN}
                    boostContribution={(deposit) => num(deposit.boostAmount).plus(deposit.amount).shiftedBy(-6).toFixed(2)}
                    onNewDeposit={handleNewDeposit}
                    onDepositClick={handleDepositClick}
                    isSelected={isSelected}
                    getDepositStyles={getDepositStyles}
                />

                <Divider mb={4} mt={4} />

                {/* LTV Disco Section */}
                <BoostDepositGroup
                    title="LTV DISCO"
                    type="disco"
                    baseMBRN={displayBreakdown.ltvDisco.baseMBRN}
                    lockedDeposits={displayBreakdown.ltvDisco.lockedDeposits}
                    totalEffectiveMBRN={displayBreakdown.ltvDisco.totalEffectiveMBRN}
                    totalEffectiveColor="primary.300"
                    formatMBRN={formatMBRN}
                    boostContribution={(deposit) => formatMBRN(deposit.boostAmount)}
                    onNewDeposit={handleNewDeposit}
                    onDepositClick={handleDepositClick}
                    isSelected={isSelected}
                    getDepositStyles={getDepositStyles}
                />
            </Box>

            {/* Action Buttons - Fixed at bottom of viewable area on selection */}
            <BoostActionBar
                hasSelection={hasSelection}
                isLocked={isSelectedDepositLocked()}
                onDeposit={handleDeposit}
                onWithdraw={handleWithdraw}
                onEditLock={handleEditLock}
            />
        </VStack>
    )
}
