
import { UserStatsResponse } from '@/contracts/codegen/points/Points.types'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Store = {
    pointsState: UserStatsResponse[]
    setPointsState: (partialState: Partial<UserStatsResponse[]>) => void
    reset: () => void
}

const initialState = {}

// @ts-ignore
const store = (set) => ({
    pointsState: initialState,
    setPointsState: (partialState: Partial<UserStatsResponse[]>) =>
        set(
            (state: Store) => ({ pointsState: { ...state.pointsState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, pointsState: initialState }), false, '@reset'),
})

const usePointsState = create<Store>(persist(store, { name: 'pointsState' }))

export default usePointsState
