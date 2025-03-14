import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type RulesState = {
  show: boolean
}

type Store = {
  rulesState: RulesState
  setRulesState: (partialState: Partial<RulesState>) => void
  reset: () => void
}

const initialState: RulesState = {
  show: true,
}

// @ts-ignore
const store = (set) => ({
  rulesState: initialState,
  setRulesState: (partialState: Partial<RulesState>) =>
    set(
      (state: Store) => ({ rulesState: { ...state.rulesState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, rulesState: initialState }), false, '@reset'),
})



const useMembersRulesState = create<Store>(persist(store, { name: 'members-rules' }))

export default useMembersRulesState
