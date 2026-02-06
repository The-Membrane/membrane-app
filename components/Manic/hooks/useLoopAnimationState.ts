import { create } from 'zustand'

type LoopAnimationState = {
    triggerCount: number
    triggerAnimation: () => void
    isManuallyActive: boolean
    startAnimation: () => void
    stopAnimation: () => void
}

export const useLoopAnimationState = create<LoopAnimationState>((set) => ({
    triggerCount: 0,
    triggerAnimation: () => set((state) => ({ triggerCount: state.triggerCount + 1 })),
    isManuallyActive: false,
    startAnimation: () => set({ isManuallyActive: true }),
    stopAnimation: () => set({ isManuallyActive: false }),
}))


