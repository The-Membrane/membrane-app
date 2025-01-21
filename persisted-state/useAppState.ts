import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

export type AppState = {
    setCookie?: boolean
}

type Store = {
    appState: AppState
    setAppState: (partialState: Partial<AppState>) => void
    reset: () => void
}

const initialState: AppState = {}

// @ts-ignore
const store = (set) => ({
    appState: initialState,
    setAppState: (partialState: Partial<AppState>) =>
        set(
            (state: Store) => ({ appState: { ...state.appState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, appState: initialState }), false, '@reset'),
})

const useAppState = create<Store>(persist(store, { name: 'appState' }))

export default useAppState
