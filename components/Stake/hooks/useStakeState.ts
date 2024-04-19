import { Asset } from '@chain-registry/types'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

type StakeState = {
  asset: Asset | null
  amount: string
  txType?: 'Stake' | 'Unstake'
}

type Store = {
  stakeState: StakeState
  setStakeState: (partialState: Partial<StakeState>) => void
  reset: () => void
}

const initialState: StakeState = {
  asset: null,
  amount: '0',
}

// @ts-ignore
const store = (set) => ({
  stakeState: initialState,
  setStakeState: (partialState: Partial<StakeState>) =>
    set(
      (state: Store) => ({ stakeState: { ...state.stakeState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, stakeState: initialState }), false, '@reset'),
})

// @ts-ignore
const useStakeState = create<Store>(devtools(store, { name: 'stakeState' }))

export default useStakeState
