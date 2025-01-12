import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


export type ActionMenu = {
  value: string
  label: string
}

export type NeuroState = {
  openSelectedAsset?: AssetWithBalance
  depositSelectedAsset?: AssetWithBalance
  withdrawSelectedAsset?: AssetWithBalance
  closeInputValue: number
  position_to_close?: number
  assets: AssetWithBalance[]
  guardedPositions: string[]
  setCookie: boolean

}

type Store = {
  neuroState: NeuroState
  setNeuroState: (partialState: Partial<NeuroState>) => void
  reset: () => void
}

const initialState: NeuroState = {
  assets: [{ symbol: "WBTC", label: "WBTC", display: "WBTC", value: "WBTC", combinUsdValue: 1, maxBorrowLTV: 0.5, balance: 0 }],
  guardedPositions: [],
  closeInputValue: 0,
  openSelectedAsset: { symbol: "WBTC", label: "WBTC", display: "WBTC", value: "WBTC", maxBorrowLTV: 0.5 },
  setCookie: false
}

// @ts-ignore
const store = (set) => ({
  neuroState: initialState,
  setNeuroState: (partialState: Partial<NeuroState>) =>
    set(
      (state: Store) => ({ neuroState: { ...state.neuroState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, neuroState: initialState }), false, '@reset'),
})

const useNeuroState = create<Store>(devtools(store, { name: 'neuroState' }))

export default useNeuroState
