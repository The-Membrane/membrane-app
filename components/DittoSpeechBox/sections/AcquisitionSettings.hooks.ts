import { useState, useMemo, useEffect } from 'react'
import useAcquisitionClaim from '@/components/acquisition/hooks/useAcquisitionClaim'
// import { useIntentBoosts } from '@/hooks/useIntentBoosts'
import { useUserAcquisitionIntents } from '@/hooks/useUserAcquisitionIntents'
import { useLockdropClaimsReady } from '../hooks/useAcquisitionNotifications'
import { useDiscoAssets } from '@/hooks/useDiscoData'
import { queryClient } from '@/pages/_app'
import type { MbrnClaimIntent, MbrnIntentOption, MbrnIntentType, Locked } from '@/types/acquisitionIntents'
import type { IntentConfig } from './AcquisitionSettingsTypes'

export const useAcquisitionSettingsIntents = () => {
    const { data: discoAssets } = useDiscoAssets()
    const { data: userIntents, refetch: refetchIntents } = useUserAcquisitionIntents()
    const { claimsReady, claimableAmount } = useLockdropClaimsReady()

    // Intent configurations
    const [intents, setIntents] = useState<IntentConfig[]>([
        { type: 'stake', enabled: false, ratio: 0, lockDays: 0 },
        { type: 'deposit', enabled: false, ratio: 0, lockDays: 0, asset: '', slot: 5 },
        { type: 'send', enabled: false, ratio: 0, address: '' },
    ])

    // Load existing intents
    useEffect(() => {
        if (userIntents?.intents && userIntents.intents.length > 0) {
            const newIntents: IntentConfig[] = [
                { type: 'stake', enabled: false, ratio: 0, lockDays: 0 },
                { type: 'deposit', enabled: false, ratio: 0, lockDays: 0, asset: '', slot: 5 },
                { type: 'send', enabled: false, ratio: 0, address: '' },
            ]

            userIntents.intents.forEach((intent: MbrnIntentOption) => {
                const ratio = parseFloat(intent.ratio) * 100
                const lockDays = intent.lock
                    ? Math.floor((parseInt(intent.lock.locked_until) - Math.floor(Date.now() / 1000)) / 86400)
                    : 0

                if ('stake' in intent.intent_type) {
                    newIntents[0] = {
                        type: 'stake',
                        enabled: true,
                        ratio,
                        lockDays: Math.max(0, lockDays),
                    }
                } else if ('deposit_via_mars_mirror' in intent.intent_type) {
                    const deposit = intent.intent_type.deposit_via_mars_mirror
                    newIntents[1] = {
                        type: 'deposit',
                        enabled: true,
                        ratio,
                        lockDays: Math.max(0, lockDays),
                        asset: deposit.asset || '',
                        slot: deposit.slot || 5,
                    }
                } else if ('send_to_address' in intent.intent_type) {
                    newIntents[2] = {
                        type: 'send',
                        enabled: true,
                        ratio,
                        address: intent.intent_type.send_to_address.address || '',
                    }
                }
            })

            setIntents(newIntents)
        }
    }, [userIntents])

    // Calculate total ratio
    const totalRatio = useMemo(() => {
        return intents.reduce((sum, intent) => sum + (intent.enabled ? intent.ratio : 0), 0)
    }, [intents])

    // DISABLED: Intent boosts disabled
    // const intentOptionsForBoost = useMemo((): MbrnIntentOption[] => { ... }, [intents])
    // const { data: boostsData } = useIntentBoosts(intentOptionsForBoost)

    // Update intent
    const updateIntent = (index: number, updates: Partial<IntentConfig>) => {
        const newIntents = [...intents]
        newIntents[index] = { ...newIntents[index], ...updates }
        setIntents(newIntents)
    }

    // Toggle intent
    const toggleIntent = (index: number) => {
        const newIntents = [...intents]
        newIntents[index].enabled = !newIntents[index].enabled
        if (!newIntents[index].enabled) {
            newIntents[index].ratio = 0
        }
        setIntents(newIntents)
    }

    // Normalize ratios
    const normalizeRatios = () => {
        const enabledIntents = intents.filter(i => i.enabled)
        if (enabledIntents.length === 0) return

        const total = enabledIntents.reduce((sum, i) => sum + i.ratio, 0)
        if (total === 0) return

        const newIntents = intents.map(intent => {
            if (intent.enabled) {
                return {
                    ...intent,
                    ratio: (intent.ratio / total) * 100,
                }
            }
            return intent
        })
        setIntents(newIntents)
    }

    // Build MbrnClaimIntent for updating (set_ongoing=true, apply_now=false)
    const buildUpdateIntent = (): MbrnClaimIntent | undefined => {
        const enabledIntents = intents.filter(i => i.enabled && i.ratio > 0)
        if (enabledIntents.length === 0) {
            // If no intents, we still need to clear by setting empty array
            return {
                apply_now: false,
                set_ongoing: true,
                intents: [],
            }
        }

        const currentTime = Math.floor(Date.now() / 1000)
        const intentOptions: MbrnIntentOption[] = enabledIntents.map(intent => {
            let intentType: MbrnIntentType
            let lock: Locked | null = null

            if (intent.type === 'stake') {
                intentType = { stake: {} }
                if (intent.lockDays > 0) {
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
                if (intent.lockDays > 0) {
                    lock = {
                        locked_until: String(currentTime + intent.lockDays * 86400),
                        intended_lock_days: String(intent.lockDays),
                    }
                }
            } else {
                intentType = {
                    send_to_address: {
                        address: intent.address || '',
                    },
                }
            }

            return {
                intent_type: intentType,
                ratio: String(intent.ratio / 100),
                lock: lock || null,
            }
        })

        // For settings, we need to actually claim to save intents
        // So we use apply_now=true and set_ongoing=true
        // This will claim (if available) and save the intents
        return {
            apply_now: true,
            set_ongoing: true,
            intents: intentOptions,
        }
    }

    // Update hook (uses claim with set_ongoing=true, apply_now=false)
    const updateHook = useAcquisitionClaim({
        mbrnIntent: buildUpdateIntent(),
        txSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['user_acquisition_intents'] })
            refetchIntents()
        },
    })

    // Validation
    const isValid = useMemo(() => {
        // Can only update if claims are ready (need to claim to save intents)
        if (!claimsReady || claimableAmount <= 0) return false

        const enabledIntents = intents.filter(i => i.enabled && i.ratio > 0)
        if (enabledIntents.length === 0) return false // Can't clear without claiming

        if (totalRatio < 99 || totalRatio > 101) return false

        // Validate deposit intent
        const depositIntent = intents.find(i => i.type === 'deposit' && i.enabled)
        if (depositIntent && depositIntent.ratio > 0) {
            if (!depositIntent.asset) return false
        }

        // Validate send intent
        const sendIntent = intents.find(i => i.type === 'send' && i.enabled)
        if (sendIntent && sendIntent.ratio > 0) {
            if (!sendIntent.address || sendIntent.address.length < 20) return false
        }

        return true
    }, [intents, totalRatio])

    const enabledIntentsCount = intents.filter(i => i.enabled).length

    return {
        discoAssets,
        userIntents,
        claimsReady,
        claimableAmount,
        intents,
        totalRatio,
        enabledIntentsCount,
        isValid,
        updateHook,
        updateIntent,
        toggleIntent,
        normalizeRatios,
    }
}
