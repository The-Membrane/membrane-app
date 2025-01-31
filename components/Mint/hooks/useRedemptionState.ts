import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


type RedemptionState = {
    deposit: number
    withdraw: number
    premium: number
}

type Store = {
    redemptionState: RedemptionState
    setRedemptionState: (partialState: Partial<RedemptionState>) => void
    reset: () => void
}

const initialState: RedemptionState = {
    deposit: 0,
    withdraw: 0,
    premium: 1,
}

// @ts-ignore
const store = (set) => ({
    redemptionState: initialState,
    setRedemptionState: (partialState: Partial<RedemptionState>) =>
        set(
            (state: Store) => ({ redemptionState: { ...state.redemptionState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, redemptionState: initialState }), false, '@reset'),
})

const useRedemptionState = create<Store>(devtools(store, { name: 'redemptionState' }))

export default useRedemptionState
