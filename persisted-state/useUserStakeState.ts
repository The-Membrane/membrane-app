
import { StakerResponse } from '@/contracts/codegen/staking/Staking.types'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Store = {
    stakeState: StakerResponse
    setStakeState: (partialState: Partial<StakerResponse>) => void
    reset: () => void
}

const initialState = {}

// @ts-ignore
const store = (set) => ({
    stakeState: initialState,
    setStakeState: (partialState: Partial<StakerResponse>) =>
        set(
            (state: Store) => ({ stakeState: { ...state.stakeState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, stakeState: initialState }), false, '@reset'),
})

const useStakeState = create<Store>(persist(store, { name: 'stakeState' }))

export default useStakeState
