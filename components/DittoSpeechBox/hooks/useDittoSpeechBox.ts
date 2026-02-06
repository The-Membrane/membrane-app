import { useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/router'
import { SpeechBoxView } from '../types'
import useDittoSpeechBoxState from './useDittoSpeechBoxState'
import useAppState from '@/persisted-state/useAppState'

const routeToViewMap: Record<string, SpeechBoxView> = {
    '/[chain]/disco': 'disco',
    '/disco': 'disco',
    '/[chain]/transmuter': 'transmuter',
    '/transmuter': 'transmuter',
    '/[chain]/manic': 'manic',
    '/manic': 'manic',
    '/[chain]/portfolio': 'hub',
    '/portfolio': 'hub',
}

export const useDittoSpeechBox = () => {
    const router = useRouter()
    const { dittoSpeechBoxState, setDittoSpeechBoxState } = useDittoSpeechBoxState()
    const { appState, setAppState } = useAppState()
    const { currentView, isUserNavigated, justReturnedToHub, justManuallyNavigated, isMinimized, isClosed, isOpen, isEditPanelOpen, hasSeenWelcome, showWelcome, currentTimedMessage } = dittoSpeechBoxState
    const username = appState.setCookie && appState.username ? appState.username : ''

    // Use refs to track manual actions to avoid race conditions with state updates
    const justReturnedToHubRef = useRef(false)
    const justManuallyNavigatedRef = useRef(false)

    // Auto-navigate based on route when on hub
    useEffect(() => {
        if (!router.isReady || !router.pathname) return

        const pathname = router.pathname
        const matchingView = routeToViewMap[pathname] ||
            (pathname.includes('/disco') ? 'disco' :
                pathname.includes('/transmuter') ? 'transmuter' :
                    pathname.includes('/manic') ? 'manic' :
                        pathname.includes('/portfolio') ? 'hub' : null)

        // Close edit panel when returning to hub
        if (currentView === 'hub' && isEditPanelOpen) {
            setDittoSpeechBoxState({ isEditPanelOpen: false })
        }

        // Don't auto-navigate if user just returned to hub manually
        if (justReturnedToHub || justReturnedToHubRef.current) {
            justReturnedToHubRef.current = false
            setDittoSpeechBoxState({ justReturnedToHub: false })
            // If route doesn't match any section, reset isUserNavigated so auto-navigation can work
            if (!matchingView && isUserNavigated) {
                setDittoSpeechBoxState({ isUserNavigated: false })
            }
            return
        }

        // Don't auto-navigate if user just manually navigated to a section
        if (justManuallyNavigated || justManuallyNavigatedRef.current) {
            console.log('Skipping auto-navigation - user just manually navigated')
            justManuallyNavigatedRef.current = false
            setDittoSpeechBoxState({ justManuallyNavigated: false })
            return
        }

        // If route changed to a non-matching route and we're on hub, reset isUserNavigated
        if (currentView === 'hub' && !matchingView && isUserNavigated) {
            setDittoSpeechBoxState({ isUserNavigated: false })
            return
        }

        // Auto-navigate to matching view based on route
        // This works when on hub OR when current view doesn't match the route
        // Speechbox stays closed (isOpen remains false) - user must click to open
        if (matchingView && !isUserNavigated && !justReturnedToHubRef.current && !justManuallyNavigatedRef.current) {
            // Navigate if we're on hub, or if current view doesn't match the route
            if (currentView === 'hub' || currentView !== matchingView) {
                console.log('Auto-navigating to:', matchingView)
                setDittoSpeechBoxState({ currentView: matchingView })
                // Ensure speechbox stays closed (don't set isOpen)
            }
        }
    }, [router.pathname, router.isReady, currentView, isUserNavigated, justReturnedToHub, justManuallyNavigated, isEditPanelOpen, setDittoSpeechBoxState])

    const openSection = (view: SpeechBoxView) => {
        console.log('openSection called with view:', view)
        justManuallyNavigatedRef.current = true
        setDittoSpeechBoxState({
            justManuallyNavigated: true,
            isUserNavigated: true,
            justReturnedToHub: false,
            currentView: view,
        })
        console.log('setCurrentView called with:', view)
    }

    const returnToHub = () => {
        console.log('returnToHub called')
        justReturnedToHubRef.current = true

        // Check if current route matches a section - if so, keep isUserNavigated true to prevent auto-navigation
        const pathname = router.pathname
        const matchingView = routeToViewMap[pathname] ||
            (pathname.includes('/disco') ? 'disco' :
                pathname.includes('/transmuter') ? 'transmuter' :
                    pathname.includes('/manic') ? 'manic' :
                        pathname.includes('/portfolio') ? 'hub' : null)

        // If we're on a route that matches a section, keep isUserNavigated true to prevent auto-navigation
        // Otherwise, reset it so auto-navigation can work for other routes
        setDittoSpeechBoxState({
            currentView: 'hub',
            isUserNavigated: !!matchingView, // Only true if route matches a section
            justReturnedToHub: true,
            justManuallyNavigated: false,
        })
    }

    const minimize = () => {
        setDittoSpeechBoxState({ isMinimized: !isMinimized })
    }

    const close = () => {
        setDittoSpeechBoxState({ isClosed: true, isOpen: false })
    }

    const toggleSpeechBox = () => {
        if (isClosed) {
            // If closed, open it and reset closed state
            setDittoSpeechBoxState({ isOpen: true, isClosed: false })
        } else {
            // Toggle open/closed
            setDittoSpeechBoxState({ isOpen: !isOpen })
        }
    }

    const toggleEditPanel = () => {
        setDittoSpeechBoxState({ isEditPanelOpen: !isEditPanelOpen })
    }

    // Welcome system - show welcome on first visit when username is set
    const triggerWelcome = () => {
        if (!hasSeenWelcome && username) {
            setDittoSpeechBoxState({
                showWelcome: true,
                currentView: 'welcome',
                isOpen: true,
                isClosed: false,
            })
        }
    }

    const dismissWelcome = () => {
        setDittoSpeechBoxState({
            showWelcome: false,
            hasSeenWelcome: true,
            currentView: 'hub',
        })
    }

    // Timed message system - memoized to prevent unnecessary re-renders
    const showTimedMessage = useCallback((message: string) => {
        setDittoSpeechBoxState({
            currentTimedMessage: message,
            timedMessageDismissed: false,
        })
    }, [setDittoSpeechBoxState])

    const dismissTimedMessage = useCallback(() => {
        setDittoSpeechBoxState({
            currentTimedMessage: null,
            timedMessageDismissed: true,
        })
    }, [setDittoSpeechBoxState])

    // Tutorial system
    const openTutorial = () => {
        justManuallyNavigatedRef.current = true
        // Store the current view as the previous view to return to
        const previousView = currentView !== 'tutorial' ? currentView : 'hub'
        setDittoSpeechBoxState({
            justManuallyNavigated: true,
            isUserNavigated: true,
            currentView: 'tutorial',
            previousView: previousView as SpeechBoxView,
            isOpen: true,
            isClosed: false,
        })
    }

    const returnToPreviousView = () => {
        // Get the previous view from state, default to hub if not set
        const previousView = dittoSpeechBoxState.previousView || 'hub'
        justManuallyNavigatedRef.current = true
        setDittoSpeechBoxState({
            justManuallyNavigated: true,
            isUserNavigated: true,
            currentView: previousView,
            isOpen: true,
            isClosed: false,
            previousView: undefined, // Clear previous view after returning
        })
    }

    const openFAQ = () => {
        justManuallyNavigatedRef.current = true
        // Store the current view as the previous view to return to
        const previousView = currentView !== 'faq' ? currentView : 'hub'
        setDittoSpeechBoxState({
            justManuallyNavigated: true,
            isUserNavigated: true,
            currentView: 'faq',
            previousView: previousView as SpeechBoxView,
            isOpen: true,
            isClosed: false,
        })
    }

    return {
        currentView,
        openSection,
        returnToHub,
        minimize,
        close,
        toggleSpeechBox,
        toggleEditPanel,
        isMinimized,
        isClosed,
        isOpen,
        isEditPanelOpen,
        // Welcome system
        hasSeenWelcome,
        showWelcome,
        triggerWelcome,
        dismissWelcome,
        username,
        // Timed messages
        currentTimedMessage,
        showTimedMessage,
        dismissTimedMessage,
        // Tutorial system
        openTutorial,
        openFAQ,
        returnToPreviousView,
    }
}

