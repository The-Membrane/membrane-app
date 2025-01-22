
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type IntentResponse = {
    user: string,
    intent: {
        vault_tokens: string,
        intents: {
            user: string,
            last_conversion_rate: string,
            purchase_intents: {
                desired_asset: string,
                route: any | undefined,
                yield_percent: string,
                position_id: number | undefined,
                slippage: string | undefined
            }[]
        },
        unstake_time: number,
        fee_to_caller: string
    }
}

type Store = {
    userIntentState: IntentResponse[]
    setUserIntentState: (partialState: Partial<IntentResponse[]>) => void
    reset: () => void
}

const initialState = {}

// @ts-ignore
const store = (set) => ({
    userIntentState: initialState,
    setUserIntentState: (partialState: Partial<IntentResponse[]>) =>
        set(
            (state: Store) => ({ userIntentState: { ...state.userIntentState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, userIntentState: initialState }), false, '@reset'),
})

const useUserIntentState = create<Store>(persist(store, { name: 'userIntentState' }))

export default useUserIntentState
