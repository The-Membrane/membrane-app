import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface ProtocolUpdate {
    id: string
    type: 'announcement' | 'feature' | 'maintenance' | 'reward' | 'idle-gains' | 'lockdrop-ending' | 'lockdrop-claims-ready' | 'intent-fulfilled'
    title: string
    message: string
    timestamp: number
    read: boolean
    priority?: 'critical' | 'important' | 'info'
    data?: any
}

type UpdatesState = {
    updates: ProtocolUpdate[]
    lastChecked: number
    readUpdateIds: string[]
}

type Store = {
    updatesState: UpdatesState
    setUpdatesState: (partialState: Partial<UpdatesState>) => void
    addUpdate: (update: Omit<ProtocolUpdate, 'read'>) => void
    markAsRead: (updateId: string) => void
    markAllAsRead: () => void
    clearOldUpdates: (maxAge?: number) => void
    getUnreadCount: () => number
    reset: () => void
}

const initialState: UpdatesState = {
    updates: [],
    lastChecked: 0,
    readUpdateIds: [],
}

const useUpdatesState = create<Store>()(
    persist(
        (set, get) => ({
            updatesState: initialState,
            
            setUpdatesState: (partialState: Partial<UpdatesState>) =>
                set((state) => ({
                    updatesState: { ...state.updatesState, ...partialState },
                })),
            
            addUpdate: (update: Omit<ProtocolUpdate, 'read'>) => {
                const { updatesState } = get()
                const isRead = updatesState.readUpdateIds.includes(update.id)
                const newUpdate: ProtocolUpdate = {
                    ...update,
                    read: isRead,
                }
                
                // Don't add duplicates
                if (updatesState.updates.some(u => u.id === update.id)) {
                    return
                }
                
                set((state) => ({
                    updatesState: {
                        ...state.updatesState,
                        updates: [newUpdate, ...state.updatesState.updates],
                    },
                }))
            },
            
            markAsRead: (updateId: string) => {
                set((state) => ({
                    updatesState: {
                        ...state.updatesState,
                        readUpdateIds: [...new Set([...state.updatesState.readUpdateIds, updateId])],
                        updates: state.updatesState.updates.map(u =>
                            u.id === updateId ? { ...u, read: true } : u
                        ),
                    },
                }))
            },
            
            markAllAsRead: () => {
                set((state) => ({
                    updatesState: {
                        ...state.updatesState,
                        readUpdateIds: [
                            ...new Set([
                                ...state.updatesState.readUpdateIds,
                                ...state.updatesState.updates.map(u => u.id),
                            ]),
                        ],
                        updates: state.updatesState.updates.map(u => ({ ...u, read: true })),
                    },
                }))
            },
            
            clearOldUpdates: (maxAge = 7 * 24 * 60 * 60 * 1000) => { // Default 7 days
                const now = Date.now()
                set((state) => ({
                    updatesState: {
                        ...state.updatesState,
                        updates: state.updatesState.updates.filter(
                            u => now - u.timestamp < maxAge
                        ),
                    },
                }))
            },
            
            getUnreadCount: () => {
                const { updatesState } = get()
                return updatesState.updates.filter(u => !u.read).length
            },
            
            reset: () => set(() => ({ updatesState: initialState })),
        }),
        { name: 'ditto-updates-state' }
    )
)

export default useUpdatesState

