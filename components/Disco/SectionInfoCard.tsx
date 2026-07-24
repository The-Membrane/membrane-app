import React, { useState, useEffect } from 'react'
import { Box } from '@chakra-ui/react'
import { m, AnimatePresence } from 'framer-motion'
import useDiscoDeposit from './hooks/useDiscoDeposit'
import { useSectionInfoData } from './hooks/useSectionInfoData'
import { SectionInfoDisplay } from './SectionInfoDisplay'
import { SectionInfoDepositForm } from './SectionInfoDepositForm'
import type { SlotData } from './types'

// Color constants
const PRIMARY_PURPLE = 'rgb(155, 220, 79)'

interface SectionInfoCardProps {
    selectedSlot: SlotData | null
    slotsData?: SlotData[]
    onOpenDepositForm?: () => void
    externalFormTrigger?: number
}

export const SectionInfoCard: React.FC<SectionInfoCardProps> = ({ selectedSlot, slotsData, onOpenDepositForm, externalFormTrigger }) => {
    const [showForm, setShowForm] = useState(false)
    const [amount, setAmount] = useState('')

    // Watch for external form trigger
    useEffect(() => {
        if (externalFormTrigger && externalFormTrigger > 0 && selectedSlot) {
            setShowForm(true)
        }
    }, [externalFormTrigger, selectedSlot])

    // Reset form when selectedSlot changes
    // react-doctor(no-reset-all-state-on-prop-change): kept — clears the form only on slot DESELECT (selectedSlot === null). Idiomatic fix = `key` on <SectionInfoCard/> in DiscoPageGlobalSection.tsx; behavior-preserving key is `selectedSlot ? 'active' : 'none'` (keying on slot id would also reset on slot-switch). Deriving would ripple into the child's setAmount prop, so kept in-file.
    useEffect(() => {
        if (!selectedSlot) {
            setShowForm(false)
            setAmount('')
        }
    }, [selectedSlot])

    const { walletBalanceMBRN, lossAbsorptionData, revenueMultiplier, asset } = useSectionInfoData(selectedSlot, slotsData)

    // Initialize deposit hook
    const depositHook = useDiscoDeposit({
        asset,
        slot: selectedSlot?.slot ?? 0,
        amount,
        txSuccess: () => {
            setShowForm(false)
            setAmount('')
        },
    })

    const handleMaxClick = () => {
        if (walletBalanceMBRN) {
            setAmount(walletBalanceMBRN)
        }
    }

    const handleDeposit = async () => {
        if (!amount || !depositHook.action?.simulate?.data) return
        await depositHook.action.tx.mutateAsync()
    }

    const handleCancel = () => {
        setShowForm(false)
        setAmount('')
    }

    return (
        <Box
            as={m.div}
            layout
            bg="rgba(10, 10, 10, 0.95)"
            p={4}
            borderRadius="md"
            border="2px solid"
            borderColor={PRIMARY_PURPLE}
            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
            w="100%"
            backdropFilter="blur(10px)"
            position="relative"
            overflow="hidden"
            h="fit-content"
            transition={{ layout: { duration: 0.3, ease: "easeInOut" } }}
        >
            <AnimatePresence mode="wait">
                {!showForm ? (
                    <m.div
                        key="card"
                        initial={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        transition={{ duration: 0.2 }}
                    >
                        <SectionInfoDisplay
                            selectedSlot={selectedSlot}
                            lossAbsorptionData={lossAbsorptionData}
                            revenueMultiplier={revenueMultiplier}
                        />
                    </m.div>
                ) : (
                    <m.div
                        key="form"
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -20, scale: 0.95 }}
                        transition={{
                            duration: 0.3,
                            ease: [0.4, 0, 0.2, 1]
                        }}
                    >
                        <SectionInfoDepositForm
                            selectedSlot={selectedSlot}
                            amount={amount}
                            setAmount={setAmount}
                            walletBalanceMBRN={walletBalanceMBRN}
                            onMaxClick={handleMaxClick}
                            onCancel={handleCancel}
                            onDeposit={handleDeposit}
                            isPending={depositHook.action?.tx?.isPending}
                        />
                    </m.div>
                )}
            </AnimatePresence>
        </Box>
    )
}
