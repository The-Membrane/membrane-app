import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { Summary } from '@/components/Mint/hooks/useMintState'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


export type QuickActionState = {
  levAsset?: AssetWithBalance
  stableAsset?: AssetWithBalance
  assets: AssetWithBalance[]
  summary?: Summary[]
  totalUsdValue?: number
  levSwapRatio?: number
  useCookies: boolean
  readyToLoop: boolean
}

type Store = {
  quickActionState: QuickActionState
  setQuickActionState: (partialState: Partial<QuickActionState>) => void
}

const initialState: QuickActionState = {  
  assets: [],
  useCookies: false,
  readyToLoop: false,
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
