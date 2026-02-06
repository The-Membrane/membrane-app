import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

export interface RevenueHistoryEntry {
    timestamp: number
    totalRevenue: number
}

export interface AirdropHistoryEntry {
    timestamp: number
    amount: number
    mbrnAmount: string
}

export interface PortState {
    // Session tracking
    lastSessionTime: number | null
    lastSessionRevenue: number
    sessionStartTime: number

    // Revenue tracking
    revenueHistory: RevenueHistoryEntry[]
    lifetimeRevenue: number
    todayRevenue: number
    sessionRevenue: number
    cumulativeRevenue: number // Cumulative counter that accumulates over time

    // Airdrop tracking
    airdropHistory: AirdropHistoryEntry[]
    lastAirdropTime: number | null

    // Action tracking
    actionCount: number
    lastActionTime: number | null
}

type Store = {
    portState: PortState
    setPortState: (partialState: Partial<PortState>) => void
    reset: () => void
}

const initialState: PortState = {
    lastSessionTime: null,
    lastSessionRevenue: 0,
    sessionStartTime: Date.now(),
    revenueHistory: [],
    lifetimeRevenue: 0,
    todayRevenue: 0,
    sessionRevenue: 0,
    cumulativeRevenue: 0,
    airdropHistory: [],
    lastAirdropTime: null,
    actionCount: 0,
    lastActionTime: null,
}

const usePortState = create<Store>()(
    persist(
        (set) => ({
            portState: initialState,
            setPortState: (partialState: Partial<PortState>) =>
                set((state) => ({
                    portState: { ...state.portState, ...partialState },
                })),
            reset: () => set(() => ({ portState: initialState })),
        }),
        { name: 'portState' }
    )
)

export default usePortState
