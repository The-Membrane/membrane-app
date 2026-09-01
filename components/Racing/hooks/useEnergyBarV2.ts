import { useMemo, useState } from 'react'
import { useBreakpointValue } from '@chakra-ui/react'
import useAppState from '@/persisted-state/useAppState'
import { useCarEnergy } from '@/services/q-racing'
import { useLongPress } from '@/helpers/useLongPress'
import useRacingState from './useRacingState'
import { usePaymentSelection } from './usePaymentSelection'
import useRefillEnergy from './useRefillEnergy'

const formatDuration = (ms: number) => {
    if (ms <= 0) return 'Full'
    const totalSeconds = Math.floor(ms / 1000)
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
}

const handleQuickRefill = () => {
    // This function is no longer used since we only open the menu
    // All execution happens in handleOptionSelect
}

export const useEnergyBarV2 = (tokenId?: string) => {
    const { appState } = useAppState()
    const { data } = useCarEnergy(tokenId, appState.rpcUrl)

    const { racingState, setRacingState } = useRacingState()
    const isMobile = useBreakpointValue({ base: true, md: false })
    const lightningIconSize = useBreakpointValue({ base: 16, sm: 20, md: 30 })
    const style = useMemo(() => {
        if (!data) {
            return {
                opacity: 0.5,
                cursor: 'not-allowed'
            }
        }
        return undefined
    }, [data])

    // Create refill energy hook for free refills
    const freeRefillHook = useRefillEnergy({ tokenId, paymentOption: null })

    // Create refill energy hook for paid refills (will be updated when option selected)
    const [currentPaymentOption, setCurrentPaymentOption] = useState<any>(null)
    const paidRefillHook = useRefillEnergy({ tokenId, paymentOption: currentPaymentOption })

    const {
        isOptionsOpen,
        isLoading,
        statusMessage,
        lastUsedPaymentMethod,
        paymentOptions,
        openOptions,
        closeOptions,
        executePayment,
        quickRefill
    } = usePaymentSelection(tokenId)



    useMemo(() => {
        if (data) {
            setRacingState({ energy: data.current_energy })
        }
    }, [data, setRacingState])

    const pct = useMemo(() => {
        if (!data) return 0
        if (data.max_energy === 0) return 0
        return Math.min(100, Math.round((racingState.energy / data.max_energy) * 100))
    }, [data, racingState.energy])

    const timeToFull = useMemo(() => {
        if (!data) return 0
        const missing = Math.max(0, data.max_energy - racingState.energy)
        if (missing === 0 || data.energy_recovery_hours === 0) return 0
        const fullMs = data.energy_recovery_hours * 60 * 60 * 1000
        return Math.ceil((missing / data.max_energy) * fullMs)
    }, [data, racingState.energy])

    // Long press handler for mobile
    const longPressRef = useLongPress({
        onLongPress: () => {
            if (isMobile) {
                openOptions()
            }
        },
        threshold: 500
    })

    const handleOptionSelect = (option: any) => {
        if (option.denom && option.amount !== '0') {
            // Paid option
            setCurrentPaymentOption({
                denom: option.denom,
                amount: option.amount
            })
            executePayment(option, () => paidRefillHook.action.tx.mutate())
        } else {
            // Free option
            executePayment(option, () => freeRefillHook.action.tx.mutate())
        }
    }

    const getActionForOption = (option: any) => {
        if (option.denom && option.amount !== '0') {
            return paidRefillHook.action
        } else {
            return freeRefillHook.action
        }
    }

    const energyLabel = data ? `${racingState.energy} / ${data.max_energy}` : '0 / 0'
    const timeToFullLabel = formatDuration(timeToFull)

    return {
        style,
        lightningIconSize,
        racingState,
        pct,
        energyLabel,
        timeToFullLabel,
        statusMessage,
        isLoading,
        isOptionsOpen,
        paymentOptions,
        lastUsedPaymentMethod,
        openOptions,
        closeOptions,
        handleOptionSelect,
        getActionForOption,
        longPressRef,
        isMobile,
    }
}

export type EnergyBarViewProps = ReturnType<typeof useEnergyBarV2> & {
    inline?: boolean
}

export default useEnergyBarV2
