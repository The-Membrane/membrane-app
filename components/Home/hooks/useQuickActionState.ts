// import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
// import { Summary } from '@/components/Mint/hooks/useMintState'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


export type QuickActionState = {
  autoSPdeposit: number
  autoSPwithdrawal: number
  rangeBoundLPdeposit: number
  rangeBoundLPwithdrawal: number
  usdcSwapToCDT: number
  usdcMint: {
    deposit: number,
    mint: number
  }
}

type Store = {
  quickActionState: QuickActionState
  setQuickActionState: (partialState: Partial<QuickActionState>) => void
}

const initialState: QuickActionState = {
  autoSPdeposit: 0,
  autoSPwithdrawal: 0,
  rangeBoundLPdeposit: 0,
  rangeBoundLPwithdrawal: 0,
  usdcSwapToCDT: 0,
  usdcMint: {
    deposit: 0,
    mint: 0
  },
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
