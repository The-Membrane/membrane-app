import { useState, useMemo, useEffect, useRef } from 'react'
import { useDisclosure } from '@chakra-ui/react'
import useAcquisitionClaim from './useAcquisitionClaim'
// import { useIntentBoosts } from '@/hooks/useIntentBoosts'
import { useUserAcquisitionIntents } from '@/hooks/useUserAcquisitionIntents'
import { useDiscoAssets } from '@/hooks/useDiscoData'
import { useCurrentAcquisition } from '@/hooks/useAcquisition'
import type { MbrnClaimIntent, MbrnIntentOption, MbrnIntentType, Locked } from '@/types/acquisitionIntents'

// Check if mock data is enabled
const USE_MOCK_DATA = true // Should match services/acquisition.ts

export interface IntentConfig {
    type: 'stake' | 'deposit' | 'send'
    enabled: boolean
    ratio: number // 0-100
    lockDays?: number // 0-365 (optional, only for stake/deposit)
    // For deposit
    asset?: string
    slot?: number // 1-9
    // For send
    address?: string
}

interface UseAcquisitionClaimCardParams {
    claimableAmount: number
    onClaimSuccess?: () => void
}

export const useAcquisitionClaimCard = ({
    claimableAmount,
    onClaimSuccess,
}: UseAcquisitionClaimCardParams) => {
    const { isOpen, onToggle } = useDisclosure()
    const { data: discoAssets } = useDiscoAssets()
    const { data: userIntents } = useUserAcquisitionIntents()
    const { data: currentLockdrop } = useCurrentAcquisition()

    // Intent configurations - only stake and deposit, using radio selection
    const [selectedIntentType, setSelectedIntentType] = useState<'stake' | 'deposit' | null>(null)
    const [intents, setIntents] = useState<IntentConfig[]>([
        { type: 'stake', enabled: false, ratio: 100, lockDays: 0 },
        { type: 'deposit', enabled: false, ratio: 100, lockDays: 0, asset: '', slot: 5 },
    ])
    const radioGroupRef = useRef<HTMLDivElement>(null)

    // Pre-fill from ongoing intents if they exist
    useEffect(() => {
        if (userIntents?.intents && userIntents.intents.length > 0 && !isOpen) {
            const newIntents: IntentConfig[] = [
                { type: 'stake', enabled: false, ratio: 100, lockDays: 0 },
                { type: 'deposit', enabled: false, ratio: 100, lockDays: 0, asset: '', slot: 5 },
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
                        slot: deposit.slot || 5,
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

    // DISABLED: Intent boosts disabled
    // const intentOptionsForBoost = useMemo((): MbrnIntentOption[] => { ... }, [intents, selectedIntentType])
    // const { data: boostsData } = useIntentBoosts(intentOptionsForBoost)
    // const boostedAmounts = useMemo(() => { ... }, [boostsData, selectedIntentType, effectiveAmountForBoost])

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
                    slot: intent.slot || 5,
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
    const claimHook = useAcquisitionClaim({
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

    const selectedIntent = intents.find(i => i.type === selectedIntentType)

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

    // No claims message visibility (mock data always suppresses it)
    const showNoClaims = !USE_MOCK_DATA && claimableAmount <= 0

    return {
        isOpen,
        onToggle,
        discoAssets,
        selectedIntentType,
        setSelectedIntentType,
        intents,
        setIntents,
        radioGroupRef,
        updateIntent,
        handleRadioChange,
        claimHook,
        isValid,
        effectiveClaimableAmount,
        isButtonDisabled,
        buttonLabel,
        showNoClaims,
    }
}

export default useAcquisitionClaimCard
