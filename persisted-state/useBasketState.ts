
import { Basket } from '@/contracts/codegen/positions/Positions.types'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Store = {
    basketState: Basket
    setBasketState: (partialState: Partial<Basket>) => void
    reset: () => void
}

const initialState = {}

// @ts-ignore
const store = (set) => ({
    basketState: initialState,
    setBasketState: (partialState: Partial<Basket>) =>
        set(
            (state: Store) => ({ basketState: { ...state.basketState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, basketState: initialState }), false, '@reset'),
})

const useBasketState = create<Store>(persist(store, { name: 'basketState' }))

export default useBasketState
