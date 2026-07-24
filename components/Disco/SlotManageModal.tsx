import React, { useState, useMemo } from 'react'
import {
    Modal,
    ModalOverlay,
    ModalContent,
    ModalHeader,
    ModalCloseButton,
    ModalBody,
    VStack,
    HStack,
    Box,
    Text,
    Button,
} from '@chakra-ui/react'
import { getSlotLabel } from './types'
import { shiftDigits } from '@/helpers/math'
import useDiscoDeposit from './hooks/useDiscoDeposit'
import useDiscoUnstake from './hooks/useDiscoUnstake'
import useDiscoMoveDeposit from './hooks/useDiscoMoveDeposit'
import { useEffectiveUnlockTime } from '@/hooks/useDiscoData'
import useWallet from '@/hooks/useWallet'
import { getSlotRGB } from './SlotManageHelpers'
import type { Tab, UnstakeRequestData, SlotData } from './SlotManageHelpers'
import { SlotManageSummary } from './SlotManageSummary'
import { SlotManageTabContent } from './SlotManageTabContent'

const PRIMARY_PURPLE = 'rgb(155, 220, 79)'

// Hoisted to module scope so these default values are referentially stable across renders
const EMPTY_UNSTAKE_REQUESTS: UnstakeRequestData[] = []
const EMPTY_AVAILABLE_SLOTS: number[] = []

interface SlotManageModalProps {
    isOpen: boolean
    onClose: () => void
    slot: number
    slotData: SlotData
    asset: string
    depositId?: string
    unstakeRequests?: UnstakeRequestData[]
    availableSlots?: number[]
}

const tabs: { key: Tab; label: string }[] = [
    { key: 'deposit', label: 'Deposit' },
    { key: 'withdraw', label: 'Withdraw' },
    { key: 'move', label: 'Move' },
]

export const SlotManageModal: React.FC<SlotManageModalProps> = ({
    isOpen,
    onClose,
    slot,
    slotData,
    asset,
    depositId,
    unstakeRequests = EMPTY_UNSTAKE_REQUESTS,
    availableSlots = EMPTY_AVAILABLE_SLOTS,
}) => {
    const [activeTab, setActiveTab] = useState<Tab>('deposit')
    const [amount, setAmount] = useState('')
    const [targetSlot, setTargetSlot] = useState<number | null>(null)
    const { address } = useWallet()

    // Query effective unlock time for the first unstake request (accounts for liquidation lockout)
    const firstUnstakeReq = unstakeRequests[0]
    const { data: effectiveUnlock } = useEffectiveUnlockTime(
        address,
        asset,
        firstUnstakeReq?.slot ?? slot,
        depositId || '',
    )

    // Transaction hooks
    const depositHook = useDiscoDeposit({
        asset,
        slot,
        amount,
        depositId,
        txSuccess: () => { handleClose() },
    })

    const unstakeHook = useDiscoUnstake({
        asset,
        slot,
        depositId: depositId || '',
        amount,
        action: 'request',
        txSuccess: () => { handleClose() },
    })

    const moveHook = useDiscoMoveDeposit({
        asset,
        depositId: depositId || '',
        fromSlot: slot,
        toSlot: targetSlot || 0,
        amount,
        txSuccess: () => { handleClose() },
    })

    const { r, g, b } = getSlotRGB(slot)
    const slotColor = `rgb(${r}, ${g}, ${b})`

    // Reset on close
    const handleClose = () => {
        setAmount('')
        setTargetSlot(null)
        setActiveTab('deposit')
        onClose()
    }

    // Available target slots for moving (all except current)
    const moveTargets = useMemo(() => {
        return availableSlots.filter(s => s !== slot)
    }, [slot, availableSlots])

    // Compute unstaking totals
    const unstakingAmount = useMemo(() => {
        return unstakeRequests.reduce((sum, req) => {
            const tokens = parseFloat(req.vault_tokens || '0')
            return sum + shiftDigits(tokens.toString(), -6).toNumber()
        }, 0)
    }, [unstakeRequests])

    const isLiquidationLockout = effectiveUnlock?.is_locked_by_liquidation ?? false

    const unstakeHoursLeft = useMemo(() => {
        if (unstakeRequests.length === 0) return 0
        // Use effective unlock time (accounts for liquidation lockout) when available
        const effectiveTime = effectiveUnlock?.effective_unlock_time
        const nearest = effectiveTime
            ?? Math.min(...unstakeRequests.map(req => req.unlock_time))
        return Math.max(0, Math.ceil((nearest - Math.floor(Date.now() / 1000)) / 3600))
    }, [unstakeRequests, effectiveUnlock])

    return (
        <Modal isOpen={isOpen} onClose={handleClose} size="md" isCentered>
            <ModalOverlay bg="blackAlpha.800" />
            <ModalContent
                bg="rgba(10, 10, 10, 0.95)"
                border="1px solid"
                borderColor={`rgba(${r}, ${g}, ${b}, 0.4)`}
                borderRadius="lg"
            >
                <ModalHeader pb={2}>
                    <HStack spacing={3}>
                        <Box
                            w="10px"
                            h="10px"
                            borderRadius="full"
                            bg={slotColor}
                            boxShadow={`0 0 8px ${slotColor}`}
                        />
                        <Text color="white" fontSize="lg" fontWeight="bold" fontFamily="mono">
                            Slot {getSlotLabel(slot)}
                        </Text>
                    </HStack>
                </ModalHeader>
                <ModalCloseButton color="whiteAlpha.600" _hover={{ color: 'white' }} />

                <ModalBody pb={6}>
                    <VStack spacing={4} align="stretch">
                        {/* Slot summary */}
                        <SlotManageSummary
                            slotData={slotData}
                            unstakingAmount={unstakingAmount}
                            isLiquidationLockout={isLiquidationLockout}
                            unstakeHoursLeft={unstakeHoursLeft}
                        />

                        {/* Tab buttons */}
                        <HStack spacing={0} borderRadius="md" overflow="hidden" border="1px solid" borderColor="whiteAlpha.200">
                            {tabs.map(({ key, label }) => (
                                <Button
                                    key={key}
                                    flex={1}
                                    size="sm"
                                    borderRadius={0}
                                    bg={activeTab === key ? `rgba(${r}, ${g}, ${b}, 0.2)` : 'transparent'}
                                    color={activeTab === key ? slotColor : 'whiteAlpha.600'}
                                    borderBottom={activeTab === key ? `2px solid ${slotColor}` : '2px solid transparent'}
                                    fontFamily="mono"
                                    fontSize="xs"
                                    fontWeight="bold"
                                    letterSpacing="0.5px"
                                    _hover={{ bg: `rgba(${r}, ${g}, ${b}, 0.1)`, color: 'white' }}
                                    onClick={() => {
                                        setActiveTab(key)
                                        setAmount('')
                                        setTargetSlot(null)
                                    }}
                                >
                                    {label}
                                </Button>
                            ))}
                        </HStack>

                        {/* Tab content */}
                        <SlotManageTabContent
                            activeTab={activeTab}
                            amount={amount}
                            setAmount={setAmount}
                            targetSlot={targetSlot}
                            setTargetSlot={setTargetSlot}
                            slot={slot}
                            slotData={slotData}
                            moveTargets={moveTargets}
                            r={r}
                            g={g}
                            b={b}
                            slotColor={slotColor}
                            depositHook={depositHook}
                            unstakeHook={unstakeHook}
                            moveHook={moveHook}
                            unstakingAmount={unstakingAmount}
                            isLiquidationLockout={isLiquidationLockout}
                            unstakeHoursLeft={unstakeHoursLeft}
                        />
                    </VStack>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}
