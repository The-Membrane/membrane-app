import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { AssetWithBalance } from './useCombinBalance'

export type Summary = AssetWithBalance & {
  label: string
  value: string | number
  usdValue: string
  currentDeposit: string | number
  newDepositWillBe: string
}

type MintState = {
  assets: AssetWithBalance[]
  ltvSlider?: number
  isTakeAction?: boolean
  totalUsdValue?: number
  summary?: Summary[]
  mint: number
  repay: number
  newDebtAmount?: number
  overdraft?: boolean
  belowMinDebt?: boolean
  positionNumber: number
}

type Store = {
  mintState: MintState
  setMintState: (partialState: Partial<MintState>) => void
  reset: () => void
}

const initialState: MintState = {
  mint: 0,
  repay: 0,
  assets: [],
  ltvSlider: 0,
  positionNumber: 1,
  isTakeAction: true
}

// @ts-ignore
const store = (set) => ({
  mintState: initialState,
  setMintState: (partialState: Partial<MintState>) =>
    set(
      (state: Store) => ({ mintState: { ...state.mintState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, mintState: initialState }), false, '@reset'),
})

const useMintState = create<Store>(devtools(store, { name: 'mintState' }))

export default useMintState
