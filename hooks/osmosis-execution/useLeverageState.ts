import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { Coin } from '@cosmjs/stargate'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

//Notes
//- If we are leveraging a new Position, we must query the current position ID before depositing
// so we can build the loop msgs in the same sign bundle
// - # of leverage loops will be hardcoded, Ledger users can manually do their single loop on the app.

type leverageState = {
    LTV: number //LTV to loop or unloop to.
    positionID: string //If new position, this is set to the Basket's position ID (must requery). If existing, use current ID.
    iterations?: number //Number of deleverage loops to be done. Needs to be Some if unlooped.
}

type Store = {
    leverageState: leverageState
    setleverageState: (partialState: Partial<leverageState>) => void
    reset: () => void
}

const initialState: leverageState = {
    LTV: 0,
    positionID: '0',
}


// @ts-ignore
const store = (set) => ({
    leverageState: initialState,
    setleverageState: (partialState: Partial<leverageState>) =>
        set(
            (state: Store) => ({ leverageState: { ...state.leverageState, ...partialState } }),
            false,
            `@update/${Object.keys(partialState).join(',')}`,
        ),
    reset: () => set((state: Store) => ({ ...state, leverageState: initialState }), false, '@reset'),
})

const useLeverageState = create<Store>(devtools(store, { name: 'LeverageState' }))

export default useLeverageState
