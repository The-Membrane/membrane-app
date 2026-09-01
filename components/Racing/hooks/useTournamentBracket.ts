import { useState } from 'react'
import { useBreakpointValue } from '@chakra-ui/react'
import {
    useTournamentState,
    useRegistrations,
    useCurrentBracket,
    useTournamentConfig
} from './useTournamentQueries'
import { useRunNextMatch, useRegisterForTournament } from './useTournamentActions'
import { usePaymentSelection, PaymentOption } from './usePaymentSelection'
import { useOwnedCars } from '@/hooks/useQRacing'
import useWallet from '@/hooks/useWallet'

// Data fetching, registration/payment state and tournament actions for TournamentBracket.
// Hook call order is preserved exactly from the original component body.
// Get car names (you'll need to implement this based on your car data structure)
const getCarName = (carId: number, ownedCars: any): string => {
    const carName = (ownedCars?.find((car: any) => car.id === carId.toString()))?.name
    if (carName) {
        return carName
    }
    // This should be replaced with actual car name lookup
    return `Car #${carId}`
}

export const useTournamentBracket = () => {
    const { data: tournamentState, isLoading: stateLoading } = useTournamentState()
    const { data: registrations, isLoading: regLoading } = useRegistrations()
    const { data: bracket, isLoading: bracketLoading } = useCurrentBracket()
    const { data: tournamentConfig, isLoading: configLoading } = useTournamentConfig()
    const { address } = useWallet()
    const { data: ownedCars } = useOwnedCars(address)

    const [selectedCarId, setSelectedCarId] = useState<number | null>(null)

    // Payment selection hook
    const {
        paymentOptions,
        isLoading: isPaymentLoading,
        executePayment,
        openOptions: openPaymentOptions,
        closeOptions: closePaymentOptions
    } = usePaymentSelection(selectedCarId?.toString())

    // Local state for payment options visibility
    const [isPaymentOptionsOpen, setIsPaymentOptionsOpen] = useState(false)

    const openOptions = () => {
        setIsPaymentOptionsOpen(true)
        openPaymentOptions()
    }

    const closeOptions = () => {
        setIsPaymentOptionsOpen(false)
        closePaymentOptions()
    }

    const isMobile = useBreakpointValue({ base: true, md: false })

    // Check if a car is already registered
    const isCarRegistered = (carId: number): boolean => {
        const result = registrations?.registrations.some(reg =>
            String(reg.car_id) === String(carId)
        ) ?? false
        // console.log('isCarRegistered:', {
        //     carId,
        //     carIdString: carId.toString(),
        //     registrations: registrations?.registrations.map(r => ({ car_id: r.car_id, car_id_type: typeof r.car_id })),
        //     result
        // })
        return result
    }

    // Registration action hook for free option
    const freeRegistrationAction = useRegisterForTournament({
        carId: selectedCarId!,
        paymentOption: null,
        isRegistered: selectedCarId ? isCarRegistered(selectedCarId) : false,
        onSuccess: () => {
            setSelectedCarId(null)
            closeOptions()
        }
    })

    // Get action for a specific payment option
    const getActionForOption = (option: PaymentOption) => {
        if (option.denom && option.amount !== '0') {
            // For paid options, we'll create the action in the PaymentOptionsSheet
            // This is a placeholder - the actual action will be created when the option is selected
            return freeRegistrationAction.action
        } else {
            // Free option
            return freeRegistrationAction.action
        }
    }

    // Handle payment option selection
    const handleOptionSelect = (option: PaymentOption) => {
        executePayment(option, () => {
            if (option.denom && option.amount !== '0') {
                // For paid options, we need to create a new action with the payment
                // This is a simplified approach - in a real implementation, you'd want to
                // create the action properly with the payment option
                console.log('Paid registration with:', option)
                // For now, just use the free action as a placeholder
                return freeRegistrationAction.action.tx.mutate()
            } else {
                // Free option
                return freeRegistrationAction.action.tx.mutate()
            }
        })
    }

    // Check if free registration is allowed and handle button click
    const handleRegisterClick = () => {
        console.log('Tournament config allow_free_registration:', tournamentConfig?.config?.allow_free_registration)

        if (tournamentConfig?.config?.allow_free_registration) {
            console.log('Free registration is enabled - executing directly')
            // If free registration is allowed, execute directly
            executePayment(
                { denom: '', amount: '0', label: 'Free registration', sublabel: 'No cost', isAvailable: true },
                () => freeRegistrationAction.action.tx.mutate()
            )
        } else {
            console.log('Free registration is disabled - opening payment options')
            // Otherwise, open payment options
            openOptions()
        }
    }

    // Run next match action
    const runNextMatchAction = useRunNextMatch({
        onSuccess: () => {
            // Tournament state will be automatically invalidated
        }
    })

    return {
        tournamentState,
        stateLoading,
        registrations,
        regLoading,
        bracket,
        bracketLoading,
        tournamentConfig,
        ownedCars,
        selectedCarId,
        setSelectedCarId,
        isPaymentLoading,
        paymentOptions,
        isPaymentOptionsOpen,
        openOptions,
        closeOptions,
        isMobile,
        getCarName,
        isCarRegistered,
        freeRegistrationAction,
        getActionForOption,
        handleOptionSelect,
        handleRegisterClick,
        runNextMatchAction
    }
}
