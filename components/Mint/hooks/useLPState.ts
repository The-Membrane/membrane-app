import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


type LPState = {
    newCDT: number
    positionIDs: string[]
}

type Store = {
  LPState: LPState
  setLPState: (partialState: Partial<LPState>) => void
  reset: () => void
}

const initialState: LPState = {
    newCDT: 0,
    positionIDs: [],
}

// @ts-ignore
const store = (set) => ({
  LPState: initialState,
  setLPState: (partialState: Partial<LPState>) =>
    set(
      (state: Store) => ({ LPState: { ...state.LPState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, LPState: initialState }), false, '@reset'),
})

const useLPState = create<Store>(devtools(store, { name: 'LPState' }))

export default useLPState
