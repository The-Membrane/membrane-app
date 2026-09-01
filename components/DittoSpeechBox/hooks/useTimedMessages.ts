import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/router'
import { TimedMessage, getMessagesForPage } from '@/config/dittoMessages'
import useDittoSpeechBoxState from './useDittoSpeechBoxState'
import { useManicData } from '@/hooks/useManic'
import { useDiscoUserMetrics } from '@/hooks/useDiscoData'
import useWallet from '@/hooks/useWallet'

interface TimedMessageState {
    currentMessage: TimedMessage | null
    isVisible: boolean
    shownMessageIds: Set<string>
}

interface ConditionChecks {
    hasPosition: boolean
    hasDeposit: boolean
    firstVisit: boolean
}

// client-localstorage-no-version: versioned keys so a future change to the stored shape
// (currently a JSON array of string ids) can bump the suffix and skip stale entries
// instead of JSON.parse-ing (or misinterpreting) an old shape.
const SHOWN_MESSAGES_KEY = 'ditto-shown-messages:v1'
const VISITED_PAGES_KEY = 'ditto-visited-pages:v1'

// Track shown messages across sessions
const getShownMessages = (): Set<string> => {
    if (typeof window === 'undefined') return new Set()
    try {
        const stored = localStorage.getItem(SHOWN_MESSAGES_KEY)
        return stored ? new Set(JSON.parse(stored)) : new Set()
    } catch {
        return new Set()
    }
}

const saveShownMessage = (messageId: string) => {
    if (typeof window === 'undefined') return
    try {
        const shown = getShownMessages()
        shown.add(messageId)
        localStorage.setItem(SHOWN_MESSAGES_KEY, JSON.stringify([...shown]))
    } catch {
        // Ignore storage errors
    }
}

// Track page visits
const getVisitedPages = (): Set<string> => {
    if (typeof window === 'undefined') return new Set()
    try {
        const stored = localStorage.getItem(VISITED_PAGES_KEY)
        return stored ? new Set(JSON.parse(stored)) : new Set()
    } catch {
        return new Set()
    }
}

const saveVisitedPage = (page: string) => {
    if (typeof window === 'undefined') return
    try {
        const visited = getVisitedPages()
        visited.add(page)
        localStorage.setItem(VISITED_PAGES_KEY, JSON.stringify([...visited]))
    } catch {
        // Ignore storage errors
    }
}

export const useTimedMessages = () => {
    const router = useRouter()
    const { dittoSpeechBoxState, setDittoSpeechBoxState } = useDittoSpeechBoxState()
    const { address } = useWallet()
    const { hasPosition: manicHasPosition } = useManicData()
    const { deposits: discoDeposits } = useDiscoUserMetrics(address || 'mock-user')

    const [state, setState] = useState<TimedMessageState>({
        currentMessage: null,
        isVisible: false,
        shownMessageIds: getShownMessages(),
    })

    const timerRef = useRef<NodeJS.Timeout | null>(null)
    const currentPageRef = useRef<string>('')
    // Mirrors state.isVisible synchronously so the page-change effect below can read
    // "is a message currently visible" without listing state.isVisible as a dependency —
    // doing so would make the effect re-fire on its own dismissMessage()/showMessage() writes.
    const isVisibleRef = useRef(false)

    // Check conditions for a message
    const checkConditions = useCallback((message: TimedMessage): boolean => {
        if (!message.condition) return true

        const conditions: ConditionChecks = {
            hasPosition: manicHasPosition || false,
            hasDeposit: (discoDeposits?.length || 0) > 0,
            firstVisit: !getVisitedPages().has(currentPageRef.current),
        }

        // Check each condition
        if (message.condition.hasPosition !== undefined) {
            if (message.condition.hasPosition !== conditions.hasPosition) return false
        }
        if (message.condition.hasDeposit !== undefined) {
            if (message.condition.hasDeposit !== conditions.hasDeposit) return false
        }
        if (message.condition.firstVisit !== undefined) {
            if (message.condition.firstVisit !== conditions.firstVisit) return false
        }

        return true
    }, [manicHasPosition, discoDeposits])

    // Find the next message to show
    const findNextMessage = useCallback((): TimedMessage | null => {
        const page = router.pathname
        const messages = getMessagesForPage(page)
        const shownMessages = getShownMessages()

        for (const message of messages) {
            // Skip if already shown and showOnce is true
            if (message.showOnce && shownMessages.has(message.id)) {
                continue
            }

            // Check conditions
            if (checkConditions(message)) {
                return message
            }
        }

        return null
    }, [router.pathname, checkConditions])

    // Show a message
    const showMessage = useCallback((message: TimedMessage) => {
        setState(prev => ({
            ...prev,
            currentMessage: message,
            isVisible: true,
        }))
        isVisibleRef.current = true
        setDittoSpeechBoxState({ currentTimedMessage: message.message })

        // Mark as shown if showOnce
        if (message.showOnce) {
            saveShownMessage(message.id)
            setState(prev => ({
                ...prev,
                shownMessageIds: new Set([...prev.shownMessageIds, message.id]),
            }))
        }
    }, [setDittoSpeechBoxState])

    // Dismiss the current message
    const dismissMessage = useCallback(() => {
        setState(prev => ({
            ...prev,
            currentMessage: null,
            isVisible: false,
        }))
        isVisibleRef.current = false
        setDittoSpeechBoxState({ currentTimedMessage: null, timedMessageDismissed: true })
    }, [setDittoSpeechBoxState])

    // Schedule a message
    const scheduleMessage = useCallback((message: TimedMessage) => {
        if (timerRef.current) {
            clearTimeout(timerRef.current)
        }

        timerRef.current = setTimeout(() => {
            // Don't show if Ditto is not open or welcome is showing
            if (!dittoSpeechBoxState.isOpen || dittoSpeechBoxState.showWelcome) {
                return
            }

            showMessage(message)
        }, message.delay * 1000)
    }, [dittoSpeechBoxState.isOpen, dittoSpeechBoxState.showWelcome, showMessage])

    // Handle page changes
    useEffect(() => {
        const page = router.pathname
        if (page === currentPageRef.current) return

        // Clear any pending message timer
        if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
        }

        // Dismiss current message on page change
        if (isVisibleRef.current) {
            dismissMessage()
        }

        currentPageRef.current = page

        // Mark page as visited
        saveVisitedPage(page)

        // Find and schedule next message
        const nextMessage = findNextMessage()
        if (nextMessage) {
            scheduleMessage(nextMessage)
        }
        // isVisibleRef (not state.isVisible) gates the dismiss above so this effect doesn't
        // list its own transitive output as a dependency and re-fire itself after
        // dismissMessage()/showMessage() update state.isVisible.
    }, [router.pathname, findNextMessage, scheduleMessage, dismissMessage])

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current)
            }
        }
    }, [])

    return {
        currentMessage: state.currentMessage,
        isVisible: state.isVisible,
        dismissMessage,
        // Manual trigger for custom messages
        showCustomMessage: (message: string, duration?: number) => {
            const customMessage: TimedMessage = {
                id: `custom-${Date.now()}`,
                page: router.pathname,
                delay: 0,
                message,
                showOnce: false,
            }
            showMessage(customMessage)

            if (duration) {
                setTimeout(dismissMessage, duration * 1000)
            }
        },
    }
}

