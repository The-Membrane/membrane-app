import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


export type ActionMenu = {
    value: string
    label: string
}

export type GlobalState = {
    totalDebt: number

}

type Store = {
    globalState: GlobalState
    setGlobalState: (partialState: Partial<GlobalState>) => void
    reset: () => void
}

const initialState: GlobalState = {
    totalDebt: 0,
}

// @ts-ignore
const store = (set) => ({
    globalState: initialState,
    setGlobalState: (partialState: Partial<GlobalState>) =>
        set(
            (state: Store) => ({ globalState: { ...state.globalState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, globalState: initialState }), false, '@reset'),
})

const useGlobalState = create<Store>(devtools(store, { name: 'globalState' }))

export default useGlobalState
