import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

// export type Summary = AssetWithBalance & {
//   label: string
//   value: string | number
//   usdValue: string
//   currentDeposit: string | number
//   newDepositWillBe: string
// }

type NFTState = {
    nftBidAmount: number
    assetBidAmount: number
    cdtBridgeAmount: number
    mbrnBridgeAmount: number
}

type Store = {
  NFTState: NFTState
  setNFTState: (partialState: Partial<NFTState>) => void
  reset: () => void
}

const initialState: NFTState = {
    nftBidAmount: 0,
    assetBidAmount: 0,
    cdtBridgeAmount: 0,
    mbrnBridgeAmount: 0,
}

// @ts-ignore
const store = (set) => ({
  NFTState: initialState,
  setNFTState: (partialState: Partial<NFTState>) =>
    set(
      (state: Store) => ({ NFTState: { ...state.NFTState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, NFTState: initialState }), false, '@reset'),
})

const useNFTState = create<Store>(devtools(store, { name: 'NFTState' }))

export default useNFTState
