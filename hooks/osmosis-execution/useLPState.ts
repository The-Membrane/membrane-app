import { Coin } from '@cosmjs/stargate'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type GAMM = {
    id: string
    token1: Coin
    token2?: Coin
    shareInAmount?: string //Only if exiting liquidity
    lock?: number, //Some LPs have a lock period for incentives, this is shares to lock
    unlock?: number //If set, unlock shares
}
export interface CL {
    id: string;
    token1: Coin;
    token2: Coin;
}
type LPState = {
    join: boolean // if true, enter liquidity. If false, exit liquidity.
    pool?: GAMM | CL
}

type Store = {
    LPState: LPState
    setLPState: (partialState: Partial<LPState>) => void
    reset: () => void
}

const initialState: LPState = {
    join: true,
}


// @ts-ignore
const store = (set) => ({
    LPState: initialState,
    setLPState: (partialState: Partial<LPState>) =>
        set(
            (state: Store) => ({ LPState: { ...state.LPState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, LPState: initialState }), false, '@reset'),
})

const useLPState = create<Store>(devtools(store, { name: 'LPState' }))

export default useLPState
