
import { BasketPositionsResponse } from '@/contracts/codegen/positions/Positions.types'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Store = {
    userPositionState: BasketPositionsResponse[]
    setUserPositionState: (partialState: Partial<BasketPositionsResponse[]>) => void
    reset: () => void
}

const initialState = {}

// @ts-ignore
const store = (set) => ({
    userPositionState: initialState,
    setUserPositionState: (partialState: Partial<BasketPositionsResponse[]>) =>
        set(
            (state: Store) => ({ userPositionState: { ...state.userPositionState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, userPositionState: initialState }), false, '@reset'),
})

const useUserPositionState = create<Store>(persist(store, { name: 'userPositionState' }))

export default useUserPositionState
