import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Store = {
  show: boolean
  setShow: (show: boolean) => void
}

const store = (set: any) => ({
  show: true,
  setShow: (show: boolean) => set(() => ({ show })),
})

const config = {
  name: 'members-rules',
}

const useMembersRulesState = create<Store>(persist(store, config))

export default useMembersRulesState
