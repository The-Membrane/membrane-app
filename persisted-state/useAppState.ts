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
}

type Store = {
    appState: AppState
    setAppState: (partialState: Partial<AppState>) => void
    reset: () => void
}

const initialState: AppState = {
    totalPoints: [],
    rpcUrl: rpcUrl,
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
