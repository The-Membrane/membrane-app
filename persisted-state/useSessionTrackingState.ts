import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface SessionTrackingState {
    lastSessionTime: number | null
    discoTVL: number
    lockdropTVL: number
    userLockdropClaims: number
    userDiscoClaims: number
}

type Store = {
    trackingState: SessionTrackingState
    setTrackingState: (partialState: Partial<SessionTrackingState>) => void
    reset: () => void
    clearOldData: () => void
}

const initialState: SessionTrackingState = {
    lastSessionTime: null,
    discoTVL: 0,
    lockdropTVL: 0,
    userLockdropClaims: 0,
    userDiscoClaims: 0,
}

const useSessionTrackingState = create<Store>()(
    persist(
        (set, get) => ({
            trackingState: initialState,
            
            setTrackingState: (partialState: Partial<SessionTrackingState>) =>
                set((state) => ({
                    trackingState: { ...state.trackingState, ...partialState },
                })),
            
            reset: () => set(() => ({ trackingState: initialState })),
            
            clearOldData: () => {
                const { trackingState } = get()
                const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000)
                
                // Clear data if last session was more than 30 days ago
                if (trackingState.lastSessionTime && trackingState.lastSessionTime < thirtyDaysAgo) {
                    set(() => ({ trackingState: initialState }))
                }
            },
        }),
        { name: 'ditto-session-tracking-state' }
    )
)

export default useSessionTrackingState

