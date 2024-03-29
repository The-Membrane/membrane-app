import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

type BidState = {}

type Store = {
  bidState: BidState
  setBidState: (partialState: Partial<BidState>) => void
}

const initialState: BidState = {}

// @ts-ignore
const store = (set) => ({
  bidState: initialState,
  setBidState: (partialState: Partial<BidState>) =>
    set(
      (state: Store) => ({ bidState: { ...state.bidState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
})

// @ts-ignore
const useBidState = create<Store>(devtools(store, { name: 'bidState' }))

export default useBidState
