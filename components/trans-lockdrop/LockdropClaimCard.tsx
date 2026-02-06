import React, { useState, useMemo, useEffect, useRef } from 'react'
import {
    VStack,
    HStack,
    Text,
    Box,
    Button,
    Collapse,
    Radio,
    RadioGroup,
    NumberInput,
    NumberInputField,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
    Select,
    Input,
    Divider,
    useDisclosure,
    IconButton,
} from '@chakra-ui/react'
import { ChevronDownIcon, CloseIcon } from '@chakra-ui/icons'
import { useDittoConfirmation } from '@/components/DittoSpeechBox/hooks/useDittoConfirmation'
import useTransLockdropClaim from './hooks/useTransLockdropClaim'
import { useIntentBoosts } from '@/hooks/useIntentBoosts'
import { useUserLockdropIntents } from '@/hooks/useUserLockdropIntents'
import { useDiscoAssets } from '@/hooks/useDiscoData'
import { useCurrentLockdrop } from '@/hooks/useTransmuterLockdrop'
import { shiftDigits } from '@/helpers/math'
import type { MbrnClaimIntent, MbrnIntentOption, MbrnIntentType, Locked } from '@/types/lockdropIntents'

interface LockdropClaimCardProps {
    claimableAmount: number
    onClaimSuccess?: () => void
}

// Check if mock data is enabled
const USE_MOCK_DATA = true // Should match services/transmuterLockdrop.ts

interface IntentConfig {
    type: 'stake' | 'deposit' | 'send'
    enabled: boolean
    ratio: number // 0-100
    lockDays?: number // 0-365 (optional, only for stake/deposit)
    // For deposit
    asset?: string
    targetLtv?: string
    targetMaxBorrowLtv?: string
    // For send
    address?: string
}

export const LockdropClaimCard: React.FC<LockdropClaimCardProps> = ({
    claimableAmount,
    onClaimSuccess,
}) => {
    const { isOpen, onToggle } = useDisclosure()
    const { openConfirmation } = useDittoConfirmation()
    const { data: discoAssets } = useDiscoAssets()
    const { data: userIntents } = useUserLockdropIntents()
    const { data: currentLockdrop } = useCurrentLockdrop()

    // Intent configurations - only stake and deposit, using radio selection
    const [selectedIntentType, setSelectedIntentType] = useState<'stake' | 'deposit' | null>(null)
    const [intents, setIntents] = useState<IntentConfig[]>([
        { type: 'stake', enabled: false, ratio: 100, lockDays: 0 },
        { type: 'deposit', enabled: false, ratio: 100, lockDays: 0, asset: '', targetLtv: '', targetMaxBorrowLtv: '' },
    ])
    const radioGroupRef = useRef<HTMLDivElement>(null)

    // Pre-fill from ongoing intents if they exist
    useEffect(() => {
        if (userIntents?.intents && userIntents.intents.length > 0 && !isOpen) {
            const newIntents: IntentConfig[] = [
                { type: 'stake', enabled: false, ratio: 100, lockDays: 0 },
                { type: 'deposit', enabled: false, ratio: 100, lockDays: 0, asset: '', targetLtv: '', targetMaxBorrowLtv: '' },
            ]

            let selectedType: 'stake' | 'deposit' | null = null

            userIntents.intents.forEach((intent: MbrnIntentOption) => {
                const ratio = parseFloat(intent.ratio) * 100
                const lockDays = intent.lock
                    ? Math.floor((parseInt(intent.lock.locked_until) - Math.floor(Date.now() / 1000)) / 86400)
                    : 0

                if ('stake' in intent.intent_type) {
                    newIntents[0] = {
                        type: 'stake',
                        enabled: true,
                        ratio: 100,
                        lockDays: Math.max(0, lockDays),
                    }
                    selectedType = 'stake'
                } else if ('deposit_via_mars_mirror' in intent.intent_type) {
                    const deposit = intent.intent_type.deposit_via_mars_mirror
                    newIntents[1] = {
                        type: 'deposit',
                        enabled: true,
                        ratio: 100,
                        lockDays: Math.max(0, lockDays),
                        asset: deposit.asset || '',
                        targetLtv: deposit.target_ltv || '',
                        targetMaxBorrowLtv: deposit.target_max_borrow_ltv || '',
                    }
                    selectedType = 'deposit'
                }
            })

            setIntents(newIntents)
            setSelectedIntentType(selectedType)
        }
    }, [userIntents, isOpen])

    // Calculate total ratio (should always be 100% with radio selection)
    const totalRatio = useMemo(() => {
        return selectedIntentType ? 100 : 0
    }, [selectedIntentType])

    // Build MbrnIntentOption array for boost query
    const intentOptionsForBoost = useMemo((): MbrnIntentOption[] => {
        if (!selectedIntentType) return []

        const currentTime = Math.floor(Date.now() / 1000)
        const intent = intents.find(i => i.type === selectedIntentType)
        if (!intent) return []

        let intentType: MbrnIntentType
        let lock: Locked | null = null

        if (intent.type === 'stake') {
            intentType = { stake: {} }
            if (intent.lockDays && intent.lockDays > 0) {
                lock = {
                    locked_until: String(currentTime + intent.lockDays * 86400),
                    intended_lock_days: String(intent.lockDays),
                }
            }
        } else if (intent.type === 'deposit') {
            intentType = {
                deposit_via_mars_mirror: {
                    asset: intent.asset || '',
                    target_ltv: intent.targetLtv || null,
                    target_max_borrow_ltv: intent.targetMaxBorrowLtv || null,
                },
            }
            if (intent.lockDays && intent.lockDays > 0) {
                lock = {
                    locked_until: String(currentTime + intent.lockDays * 86400),
                    intended_lock_days: String(intent.lockDays),
                }
            }
        } else {
            return []
        }

        return [{
            intent_type: intentType,
            ratio: "1.0", // Always 100% with radio selection
            lock: lock || null,
        }]
    }, [intents, selectedIntentType])

    // Query boosts
    const { data: boostsData } = useIntentBoosts(intentOptionsForBoost)

    // Calculate boosted amounts - use effective amount for mock data
    const effectiveAmountForBoost = USE_MOCK_DATA && claimableAmount <= 0 ? 1000 : claimableAmount
    const boostedAmounts = useMemo(() => {
        if (!selectedIntentType || !boostsData?.boosts || boostsData.boosts.length === 0) {
            return [{ base: 0, boosted: 0, boostPercent: 0 }]
        }

        const boostPercent = parseFloat(boostsData.boosts[0] || '0') * 100
        const baseAmount = effectiveAmountForBoost
        const boostedAmount = baseAmount * (1 + boostPercent / 100)

        return [{
            base: baseAmount,
            boosted: boostedAmount,
            boostPercent,
        }]
    }, [boostsData, selectedIntentType, effectiveAmountForBoost])

    // Update intent by type
    const updateIntent = (type: 'stake' | 'deposit', updates: Partial<IntentConfig>) => {
        const newIntents = [...intents]
        const index = newIntents.findIndex(i => i.type === type)
        if (index >= 0) {
            newIntents[index] = { ...newIntents[index], ...updates }
            setIntents(newIntents)
        }
    }

    // Handle radio button change - allow deselection
    const handleRadioChange = (value: string) => {
        if (value === 'stake' || value === 'deposit') {
            // If clicking the already selected option, deselect it
            if (selectedIntentType === value) {
                setSelectedIntentType(null)
                // Update enabled state - disable all
                const newIntents = intents.map(intent => ({
                    ...intent,
                    enabled: false,
                }))
                setIntents(newIntents)
            } else {
                // Select the new option
                setSelectedIntentType(value)
                // Update enabled state
                const newIntents = intents.map(intent => ({
                    ...intent,
                    enabled: intent.type === value,
                }))
                setIntents(newIntents)
            }
        }
    }

    // Build MbrnClaimIntent from selected radio button
    const buildClaimIntent = (): MbrnClaimIntent | undefined => {
        if (!selectedIntentType) {
            return undefined
        }

        const intent = intents.find(i => i.type === selectedIntentType)
        if (!intent) {
            return undefined
        }

        const currentTime = Math.floor(Date.now() / 1000)
        let intentType: MbrnIntentType
        let lock: Locked | null = null

        if (intent.type === 'stake') {
            intentType = { stake: {} }
            if (intent.lockDays && intent.lockDays > 0) {
                lock = {
                    locked_until: String(currentTime + intent.lockDays * 86400),
                    intended_lock_days: String(intent.lockDays),
                }
            }
        } else if (intent.type === 'deposit') {
            intentType = {
                deposit_via_mars_mirror: {
                    asset: intent.asset || '',
                    target_ltv: intent.targetLtv || null,
                    target_max_borrow_ltv: intent.targetMaxBorrowLtv || null,
                },
            }
            if (intent.lockDays && intent.lockDays > 0) {
                lock = {
                    locked_until: String(currentTime + intent.lockDays * 86400),
                    intended_lock_days: String(intent.lockDays),
                }
            }
        } else {
            return undefined
        }

        const intentOption: MbrnIntentOption = {
            intent_type: intentType,
            ratio: "1.0", // Always 100% with radio selection
            lock: lock || null,
        }

        return {
            apply_now: true,
            set_ongoing: false,
            intents: [intentOption],
        }
    }

    // Claim hook - use effective amount for mock data
    const effectiveAmount = USE_MOCK_DATA && claimableAmount <= 0 ? 1000 : claimableAmount
    const claimHook = useTransLockdropClaim({
        mbrnIntent: buildClaimIntent(),
        txSuccess: () => {
            onClaimSuccess?.()
            onToggle() // Collapse card
        },
    })

    // Validation
    const isValid = useMemo(() => {
        if (!selectedIntentType) {
            return false
        }

        const intent = intents.find(i => i.type === selectedIntentType)
        if (!intent) {
            return false
        }

        // Validate deposit intent - must have asset selected
        if (intent.type === 'deposit') {
            if (!intent.asset || intent.asset === '') {
                return false
            }
        }

        return true
    }, [intents, selectedIntentType])

    const handleClaim = () => {
        if (!isValid || !claimHook.action?.simulate?.data) return

        const enabledIntents = intents.filter(i => i.enabled && i.ratio > 0)
        const totalBoosted = boostedAmounts.reduce((sum, b) => sum + b.boosted, 0)
        const displayAmount = effectiveClaimableAmount

        openConfirmation(
            claimHook.action,
            <VStack spacing={2} align="stretch" p={2}>
                <Text fontSize="sm" color="#F5F5F580">
                    Claiming {displayAmount.toFixed(2)} MBRN
                </Text>
                {totalBoosted > displayAmount && (
                    <Text fontSize="sm" color="green.400">
                        With boosts: {totalBoosted.toFixed(2)} MBRN (+{((totalBoosted / displayAmount - 1) * 100).toFixed(2)}%)
                    </Text>
                )}
                <Divider />
                {enabledIntents.map((intent, idx) => {
                    const boost = boostedAmounts[idx]
                    return (
                        <Box key={idx}>
                            <Text fontSize="xs" color="#F5F5F580">
                                {intent.type === 'stake' && 'Stake'}
                                {intent.type === 'deposit' && 'Deposit to Disco'}
                                {intent.type === 'send' && 'Send to Address'}
                                : {intent.ratio.toFixed(1)}%
                            </Text>
                            {boost && boost.boostPercent > 0 && (
                                <Text fontSize="xs" color="green.400">
                                    Boost: +{boost.boostPercent.toFixed(2)}%
                                </Text>
                            )}
                        </Box>
                    )
                })}
                {false && (
                    <Text fontSize="xs" color="purple.400" mt={2}>
                        Will be set as ongoing intent
                    </Text>
                )}
            </VStack>,
            { label: 'Claim', actionType: 'withdraw' }
        )
    }

    const selectedIntent = intents.find(i => i.type === selectedIntentType)
    const currentBoost = boostedAmounts[0] || { base: 0, boosted: 0, boostPercent: 0 }

    // For mock data, always enable the button with a mock amount
    const effectiveClaimableAmount = USE_MOCK_DATA && claimableAmount <= 0 ? 1000 : claimableAmount
    const isButtonDisabled = !USE_MOCK_DATA && claimableAmount <= 0

    // Format time remaining until withdrawal_end
    const formatTimeRemaining = (withdrawalEnd: number | null): string => {
        if (!withdrawalEnd) return 'Claims in —'

        const currentTime = Math.floor(Date.now() / 1000)
        const remaining = withdrawalEnd - currentTime

        if (remaining <= 0) return 'Ready To Claim'

        // Use largest whole unit
        const days = Math.floor(remaining / 86400)
        if (days > 0) {
            return `Claims in ${days} ${days === 1 ? 'day' : 'days'}`
        }

        const hours = Math.floor(remaining / 3600)
        if (hours > 0) {
            return `Claims in ${hours} ${hours === 1 ? 'hr' : 'hrs'}`
        }

        const minutes = Math.floor(remaining / 60)
        return `Claims in ${minutes} ${minutes === 1 ? 'min' : 'mins'}`
    }

    const withdrawalEnd = currentLockdrop?.lockdrop?.withdrawal_end || null
    const buttonLabel = formatTimeRemaining(withdrawalEnd)

    return (
        <VStack spacing={0} align="stretch" w="100%">
            {/* No claims message */}
            {!USE_MOCK_DATA && claimableAmount <= 0 && (
                <Text fontSize="xs" color="#F5F5F580" textAlign="center" mb={1}>
                    No claims available
                </Text>
            )}

            {/* Ready To Claim Button - only show when collapsed */}
            {!isOpen && (
                <Button
                    onClick={onToggle}
                    rightIcon={<ChevronDownIcon transform={isOpen ? 'rotate(180deg)' : 'rotate(0deg)'} transition="transform 0.2s" />}
                    size="md"
                    colorScheme="green"
                    isDisabled={isButtonDisabled}
                >
                    {buttonLabel}
                </Button>
            )}

            {/* Expanded Intent Content */}
            <Collapse in={isOpen} animateOpacity>
                <VStack spacing={4} align="stretch" p={4} bg="gray.800" borderRadius="md" border="1px solid" borderColor="purple.500">
                    {/* Header with close icon */}
                    <HStack justify="space-between" align="center">
                        <Text fontSize="sm" fontWeight="bold" color="purple.400">
                            Boost your Claims
                        </Text>
                        <IconButton
                            aria-label="Close"
                            icon={<CloseIcon />}
                            size="sm"
                            width={"11%"}
                            variant="ghost"
                            onClick={onToggle}
                            colorScheme="gray"
                        />
                    </HStack>

                    {/* Radio Button Selection */}
                    <RadioGroup ref={radioGroupRef} value={selectedIntentType || ''} onChange={handleRadioChange}>
                        <VStack spacing={3} align="stretch">
                            {intents.map((intent, index) => {
                                const isStake = intent.type === 'stake'
                                const isDeposit = intent.type === 'deposit'
                                const isSelected = selectedIntentType === intent.type

                                return (
                                    <Box
                                        key={index}
                                        p={3}
                                        bg="gray.900"
                                        borderRadius="md"
                                        border="1px solid"
                                        borderColor={isSelected ? "purple.500" : "gray.700"}
                                        cursor="pointer"
                                        onClick={(e) => {
                                            // If clicking on the box when already selected, deselect it
                                            if (isSelected) {
                                                e.preventDefault()
                                                e.stopPropagation()
                                                // Manually uncheck the radio input
                                                const radioInput = e.currentTarget.querySelector(`input[type="radio"][value="${intent.type}"]`) as HTMLInputElement
                                                if (radioInput) {
                                                    radioInput.checked = false
                                                }
                                                setSelectedIntentType(null)
                                                const newIntents = intents.map(i => ({
                                                    ...i,
                                                    enabled: false,
                                                }))
                                                setIntents(newIntents)
                                            }
                                        }}
                                    >
                                        <HStack spacing={3} align="flex-start">
                                            <Radio
                                                value={intent.type}
                                                colorScheme="purple"
                                                mt={1}
                                            >
                                                <Text fontSize="xs" color="#F5F5F5">
                                                    {isStake && 'Stake MBRN'}
                                                    {isDeposit && 'Deposit to Disco'}
                                                </Text>
                                            </Radio>
                                        </HStack>

                                        {isSelected && (
                                            <VStack spacing={2} align="stretch" mt={3}>
                                                {/* Deposit-specific fields - only show when deposit is selected, at the top */}
                                                {isDeposit && (
                                                    <Box>
                                                        <Text fontSize="xs" color="#F5F5F580" mb={1}>
                                                            Asset
                                                        </Text>
                                                        <Select
                                                            size="xs"
                                                            value={intent.asset || ''}
                                                            onChange={(e) => {
                                                                if (intent.type === 'deposit') {
                                                                    updateIntent(intent.type, { asset: e.target.value })
                                                                }
                                                            }}
                                                            bg="#1A1D26"
                                                            borderColor="#6943FF30"
                                                        >
                                                            <option value="">Select asset</option>
                                                            {discoAssets?.assets?.map((asset: string) => (
                                                                <option key={asset} value={asset}>
                                                                    {asset}
                                                                </option>
                                                            ))}
                                                        </Select>
                                                    </Box>
                                                )}

                                                {/* Lock Duration for Stake and Deposit */}
                                                <Box>
                                                    <HStack justify="space-between" mb={2}>
                                                        <Text fontSize="xs" color="#F5F5F580">
                                                            Lock Duration {isStake && '(3 day unstake)'}
                                                        </Text>
                                                        <Text fontSize="xs" color="purple.300" fontWeight="bold">
                                                            {intent.lockDays || 0} days
                                                        </Text>
                                                    </HStack>
                                                    <Slider
                                                        value={intent.lockDays || 0}
                                                        onChange={(val) => {
                                                            if (intent.type === 'stake' || intent.type === 'deposit') {
                                                                updateIntent(intent.type, { lockDays: val })
                                                            }
                                                        }}
                                                        min={0}
                                                        max={365}
                                                        step={1}
                                                    >
                                                        <SliderTrack bg="#1A1D26" h="6px" borderRadius="full">
                                                            <SliderFilledTrack bg="purple.400" />
                                                        </SliderTrack>
                                                        <SliderThumb boxSize={4} bg="purple.400" border="2px solid" borderColor="white" />
                                                    </Slider>
                                                </Box>

                                                {/* Boost Display */}
                                                {currentBoost && currentBoost.boostPercent > 0 && (
                                                    <Box p={2} bg="green.900" borderRadius="md" border="1px solid" borderColor="green.500">
                                                        <HStack justify="space-between">
                                                            <Text fontSize="xs" color="#F5F5F580">
                                                                Boost
                                                            </Text>
                                                            <Text fontSize="xs" color="green.400" fontWeight="bold">
                                                                +{currentBoost.boostPercent.toFixed(2)}%
                                                            </Text>
                                                        </HStack>
                                                        <HStack justify="space-between" mt={1}>
                                                            <Text fontSize="xs" color="#F5F5F580">
                                                                Amount
                                                            </Text>
                                                            <Text fontSize="xs" color="green.300" fontWeight="bold">
                                                                {currentBoost.base.toFixed(2)} → {currentBoost.boosted.toFixed(2)} MBRN
                                                            </Text>
                                                        </HStack>
                                                    </Box>
                                                )}
                                            </VStack>
                                        )}
                                    </Box>
                                )
                            })}
                        </VStack>
                    </RadioGroup>

                    {/* Claim Button */}
                    <Button
                        onClick={handleClaim}
                        isDisabled={!isValid || !claimHook.action?.simulate?.data}
                        isLoading={claimHook.action?.tx?.isPending}
                        colorScheme="green"
                        size="md"
                    >
                        Claim {effectiveClaimableAmount.toFixed(2)} MBRN
                    </Button>
                </VStack>
            </Collapse>
        </VStack>
    )
}

