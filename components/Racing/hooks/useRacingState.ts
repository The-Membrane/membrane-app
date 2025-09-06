import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


type RacingState = {
    energy: number
    energyColor: string
    singularityTrainingSessions: number
    selectedTrackId?: string
    showTraining?: boolean
    showPvp?: boolean
    rewardConfig?: {
        distance: number
        stuck: number
        wall: number
        no_move: number
        explore: number
        going_backward: {
            penalty: number
            include_progress_towards_finish: boolean
        }
        rank: {
            first: number
            second: number
            third: number
            other: number
        }
    }
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
    rewardConfig: {
        distance: 3,
        stuck: -3,
        wall: -30,
        no_move: -30,
        explore: 0,
        going_backward: {
            penalty: -4,
            include_progress_towards_finish: true,
        },
        rank: {
            first: 50,
            second: 0,
            third: 0,
            other: 0,
        },
    },
}

// @ts-ignore
const store = (set) => ({
    racingState: initialState,
    setRacingState: (partialState: Partial<RacingState>) => {
        console.log('useRacingState: setRacingState called with', partialState);
        set(
            (state: Store) => {
                const newState = { racingState: { ...state.racingState, ...partialState } };
                console.log('useRacingState: updating state from', state.racingState, 'to', newState.racingState);
                return newState;
            },
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        );
    },
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
