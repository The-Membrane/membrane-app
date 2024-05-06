import { Asset } from '@/helpers/chain'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type QuickActionState = {
  selectedAsset?: Asset
  assetActionAmount: number
}

type Store = {
  quickActionState: QuickActionState
  setQuickActionState: (partialState: Partial<QuickActionState>) => void
}

const initialState: QuickActionState = {  
    assetActionAmount: 0,
}

// @ts-ignore
const store = (set) => ({
  quickActionState: initialState,
  setQuickActionState: (partialState: Partial<QuickActionState>) =>
    set(
      (state: Store) => ({ quickActionState: { ...state.quickActionState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
})

// @ts-ignore
const useQuickActionState = create<Store>(devtools(store, { name: 'quickActionState' }))

export default useQuickActionState
