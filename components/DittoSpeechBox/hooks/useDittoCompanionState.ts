import { useCallback, useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import useDittoSpeechBoxState from './useDittoSpeechBoxState'
import useUpdatesState from '@/persisted-state/useUpdatesState'
import useAppState from '@/persisted-state/useAppState'

// Companion interaction history
interface InteractionRecord {
    type: 'click' | 'message_shown' | 'message_dismissed' | 'section_opened' | 'action_completed'
    timestamp: number
    data?: any
}

// Persisted companion state
interface CompanionPersistedState {
    // Welcome flow
    hasSeenWelcome: boolean
    welcomeShownAt: number | null
    
    // Interaction tracking
    totalInteractions: number
    lastInteractionAt: number | null
    interactionHistory: InteractionRecord[]
    
    // Message tracking
    shownMessageIds: string[]
    dismissedMessageIds: string[]
    
    // Activity tracking
    visitedPages: string[]
    lastActiveAt: number
    totalSessionTime: number
    
    // Preferences
    preferredOpenState: 'open' | 'closed' | 'auto'
    autoShowTimedMessages: boolean
}

type CompanionStore = {
    companionState: CompanionPersistedState
    setCompanionState: (partialState: Partial<CompanionPersistedState>) => void
    recordInteraction: (type: InteractionRecord['type'], data?: any) => void
    markMessageShown: (messageId: string) => void
    markMessageDismissed: (messageId: string) => void
    recordPageVisit: (page: string) => void
    updateActivity: () => void
    reset: () => void
}

const initialCompanionState: CompanionPersistedState = {
    hasSeenWelcome: false,
    welcomeShownAt: null,
    totalInteractions: 0,
    lastInteractionAt: null,
    interactionHistory: [],
    shownMessageIds: [],
    dismissedMessageIds: [],
    visitedPages: [],
    lastActiveAt: Date.now(),
    totalSessionTime: 0,
    preferredOpenState: 'auto',
    autoShowTimedMessages: true,
}

const useCompanionStore = create<CompanionStore>()(
    persist(
        (set, get) => ({
            companionState: initialCompanionState,
            
            setCompanionState: (partialState) =>
                set((state) => ({
                    companionState: { ...state.companionState, ...partialState },
                })),
            
            recordInteraction: (type, data) => {
                const now = Date.now()
                const record: InteractionRecord = { type, timestamp: now, data }
                
                set((state) => ({
                    companionState: {
                        ...state.companionState,
                        totalInteractions: state.companionState.totalInteractions + 1,
                        lastInteractionAt: now,
                        interactionHistory: [
                            record,
                            ...state.companionState.interactionHistory.slice(0, 99), // Keep last 100
                        ],
                    },
                }))
            },
            
            markMessageShown: (messageId) => {
                set((state) => ({
                    companionState: {
                        ...state.companionState,
                        shownMessageIds: [...new Set([...state.companionState.shownMessageIds, messageId])],
                    },
                }))
            },
            
            markMessageDismissed: (messageId) => {
                set((state) => ({
                    companionState: {
                        ...state.companionState,
                        dismissedMessageIds: [...new Set([...state.companionState.dismissedMessageIds, messageId])],
                    },
                }))
            },
            
            recordPageVisit: (page) => {
                set((state) => ({
                    companionState: {
                        ...state.companionState,
                        visitedPages: [...new Set([...state.companionState.visitedPages, page])],
                    },
                }))
            },
            
            updateActivity: () => {
                const now = Date.now()
                set((state) => {
                    const sessionDelta = state.companionState.lastActiveAt
                        ? Math.min(now - state.companionState.lastActiveAt, 60000) // Cap at 1 minute
                        : 0
                    
                    return {
                        companionState: {
                            ...state.companionState,
                            lastActiveAt: now,
                            totalSessionTime: state.companionState.totalSessionTime + sessionDelta,
                        },
                    }
                })
            },
            
            reset: () => set(() => ({ companionState: initialCompanionState })),
        }),
        { name: 'ditto-companion-state' }
    )
)

/**
 * Unified companion state hook that combines all Ditto state management
 */
export const useDittoCompanionState = () => {
    const { companionState, setCompanionState, recordInteraction, markMessageShown, markMessageDismissed, recordPageVisit, updateActivity, reset } = useCompanionStore()
    const { dittoSpeechBoxState, setDittoSpeechBoxState } = useDittoSpeechBoxState()
    const { updatesState, getUnreadCount, markAsRead, markAllAsRead } = useUpdatesState()
    const { appState, setAppState } = useAppState()
    
    // Computed values
    const isFirstVisit = !companionState.hasSeenWelcome
    const hasUnreadUpdates = getUnreadCount() > 0
    const username = appState.setCookie && appState.username ? appState.username : ''
    
    // Time since last activity
    const timeSinceLastActivity = useMemo(() => {
        return Date.now() - companionState.lastActiveAt
    }, [companionState.lastActiveAt])
    
    // Check if user has been away (5+ minutes)
    const wasAway = timeSinceLastActivity > 5 * 60 * 1000
    
    // Welcome flow
    const showWelcome = useCallback(() => {
        setCompanionState({
            hasSeenWelcome: false,
            welcomeShownAt: null,
        })
        setDittoSpeechBoxState({
            currentView: 'welcome',
            isOpen: true,
            isClosed: false,
            showWelcome: true,
        })
    }, [setCompanionState, setDittoSpeechBoxState])
    
    const completeWelcome = useCallback(() => {
        setCompanionState({
            hasSeenWelcome: true,
            welcomeShownAt: Date.now(),
        })
        setDittoSpeechBoxState({
            currentView: 'hub',
            showWelcome: false,
            hasSeenWelcome: true,
        })
        recordInteraction('message_dismissed', { type: 'welcome' })
    }, [setCompanionState, setDittoSpeechBoxState, recordInteraction])
    
    // Action tracking
    const trackSectionOpen = useCallback((section: string) => {
        recordInteraction('section_opened', { section })
    }, [recordInteraction])
    
    const trackActionCompleted = useCallback((action: string, data?: any) => {
        recordInteraction('action_completed', { action, ...data })
    }, [recordInteraction])
    
    // Check if a message has been shown
    const hasMessageBeenShown = useCallback((messageId: string) => {
        return companionState.shownMessageIds.includes(messageId)
    }, [companionState.shownMessageIds])
    
    // Check if a message has been dismissed
    const hasMessageBeenDismissed = useCallback((messageId: string) => {
        return companionState.dismissedMessageIds.includes(messageId)
    }, [companionState.dismissedMessageIds])
    
    // Check if page has been visited
    const hasVisitedPage = useCallback((page: string) => {
        return companionState.visitedPages.includes(page)
    }, [companionState.visitedPages])
    
    // Get user engagement level based on interactions
    const engagementLevel = useMemo(() => {
        const interactions = companionState.totalInteractions
        if (interactions < 5) return 'new'
        if (interactions < 20) return 'learning'
        if (interactions < 50) return 'familiar'
        return 'expert'
    }, [companionState.totalInteractions])
    
    return {
        // State
        companionState,
        speechBoxState: dittoSpeechBoxState,
        updatesState,
        
        // Computed
        isFirstVisit,
        hasUnreadUpdates,
        unreadCount: getUnreadCount(),
        username,
        timeSinceLastActivity,
        wasAway,
        engagementLevel,
        
        // Welcome flow
        showWelcome,
        completeWelcome,
        hasSeenWelcome: companionState.hasSeenWelcome,
        
        // Interaction tracking
        recordInteraction,
        trackSectionOpen,
        trackActionCompleted,
        
        // Message tracking
        markMessageShown,
        markMessageDismissed,
        hasMessageBeenShown,
        hasMessageBeenDismissed,
        
        // Page tracking
        recordPageVisit,
        hasVisitedPage,
        
        // Updates
        markAsRead,
        markAllAsRead,
        
        // Activity
        updateActivity,
        
        // Preferences
        setPreference: (key: keyof Pick<CompanionPersistedState, 'preferredOpenState' | 'autoShowTimedMessages'>, value: any) => {
            setCompanionState({ [key]: value })
        },
        
        // Reset
        reset,
    }
}

