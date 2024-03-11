import { exported_supportedAssets } from '@/helpers/chain'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

type SwapState = {
  nonCDTasset: keyof exported_supportedAssets //This will be a collateral asset or MBRN
  tokenInAmount: number //Could be either CDT or nonCDTasset, depends on toCDT
  toCDT: boolean // if true, nonCDTasset is being swapped to CDT. If false, CDT is being swapped to nonCDTasset.
}

type Store = {
  swapState: SwapState
  setswapState: (partialState: Partial<SwapState>) => void
  reset: () => void
}

const initialState: SwapState = {
  nonCDTasset: 'OSMO',
  tokenInAmount: 0,
  toCDT: true,
}


// @ts-ignore
const store = (set) => ({
  swapState: initialState,
  setswapState: (partialState: Partial<SwapState>) =>
    set(
      (state: Store) => ({ swapState: { ...state.swapState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, swapState: initialState }), false, '@reset'),
})

const useSwapState = create<Store>(devtools(store, { name: 'swapState' }))

export default useSwapState
