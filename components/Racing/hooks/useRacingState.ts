import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


type RacingState = {
    energy: number
    energyColor: string
    singularityTrainingSessions: number
    selectedTrackId?: string
    showTraining?: boolean
    showPvp?: boolean
}

type Store = {
    racingState: RacingState
    setRacingState: (partialState: Partial<RacingState>) => void
    initializeSingularityTrainingSessions: (count: number) => void
    incrementSingularityTrainingSessions: () => void
    reset: () => void
}

const initialState: RacingState = {
    energy: 100,
    energyColor: '#7cffa0',
    singularityTrainingSessions: 0,
}

// @ts-ignore
const store = (set) => ({
    racingState: initialState,
    setRacingState: (partialState: Partial<RacingState>) =>
        set(
            (state: Store) => ({ racingState: { ...state.racingState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    initializeSingularityTrainingSessions: (count: number) =>
        set(
            (state: Store) => ({
                racingState: {
                    ...state.racingState,
                    singularityTrainingSessions: count
                }
            }),
            false,
            '@update/singularityTrainingSessions',
        ),
    incrementSingularityTrainingSessions: () =>
        set(
            (state: Store) => ({
                racingState: {
                    ...state.racingState,
                    singularityTrainingSessions: state.racingState.singularityTrainingSessions + 1
                }
            }),
            false,
            '@update/singularityTrainingSessions',
        ),
    reset: () => set((state: Store) => ({ ...state, racingState: initialState }), false, '@reset'),
})

const useRacingState = create<Store>(devtools(store, { name: 'racingState' }) as any)

export default useRacingState
