import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


export type ActionMenu = {
  value: string
  label: string
}

export type NeuroState = {
  selectedAsset?: AssetWithBalance
  position_to_close?: number
  assets: AssetWithBalance[]
  guardedPositions: string[]

}

type Store = {
  neuroState: NeuroState
  setNeuroState: (partialState: Partial<NeuroState>) => void
  reset: () => void
}

const initialState: NeuroState = {
  assets: [{ name: "WBTC" }],
  guardedPositions: [],
  selectedAsset: { symbol: "WBTC" },
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
