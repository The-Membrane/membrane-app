import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { Summary } from '@/components/Mint/hooks/useMintState'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


export type EarnState = {
    deposit: number
    withdraw: number
    leverageMulti: number
}

type Store = {
  earnState: EarnState
  setEarnState: (partialState: Partial<EarnState>) => void
}

const initialState: EarnState = {  
    deposit: 0,
    withdraw: 0,
    leverageMulti: 1
}

// @ts-ignore
const store = (set) => ({
  earnState: initialState,
  setEarnState: (partialState: Partial<EarnState>) =>
    set(
      (state: Store) => ({ earnState: { ...state.earnState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
})

// @ts-ignore
const useEarnState = create<Store>(devtools(store, { name: 'earnState' }))

export default useEarnState
