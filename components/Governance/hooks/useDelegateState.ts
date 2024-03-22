import { Asset } from '@chain-registry/types'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

type DelegateState = {
  delegator?: any
  remainingBalance: string | number
  amount?: string | number
  txType?: 'Stake' | 'Unstake'
  delegations?: any[]
}

type Store = {
  delegateState: DelegateState
  setDelegateState: (partialState: Partial<DelegateState>) => void
  reset: () => void
}

const initialState: DelegateState = {
  remainingBalance: 0,
}

// @ts-ignore
const store = (set) => ({
  delegateState: initialState,
  setDelegateState: (partialState: Partial<DelegateState>) =>
    set(
      (state: Store) => ({ delegateState: { ...state.delegateState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, delegateState: initialState }), false, '@reset'),
})

// @ts-ignore
const useDelegateState = create<Store>(devtools(store, { name: 'delegateState' }))

export default useDelegateState
