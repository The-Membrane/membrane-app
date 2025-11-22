import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { rpcUrl } from '@/config/defaults'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

export type TrainingPaymentOption = {
    denom: string
    amount: string
}

export type AppState = {
    setCookie?: boolean
    rpcUrl: string
    totalPoints: {
        user: string
        points: string
    }[]
    lastUsedRacingPaymentMethod?: TrainingPaymentOption | null
    // Guidance system state
    hasSeenPreMintGuidance?: boolean
    hasCompletedTutorial?: boolean
    tutorialStep?: number
    hasMintedFirstCar?: boolean
    username?: string
}

type Store = {
    appState: AppState
    setAppState: (partialState: Partial<AppState>) => void
    reset: () => void
}

const initialState: AppState = {
    totalPoints: [],
    rpcUrl: rpcUrl,
    hasSeenPreMintGuidance: false,
    hasCompletedTutorial: false,
    tutorialStep: 0,
    hasMintedFirstCar: false,
}

const useAppState = create<Store>()(
    persist(
        (set) => ({
            appState: initialState,
            setAppState: (partialState: Partial<AppState>) =>
                set((state) => ({
                    appState: { ...state.appState, ...partialState },
                })),
            reset: () => set(() => ({ appState: initialState })),
        }),
        { name: 'appState' }
    )
)

export default useAppState
