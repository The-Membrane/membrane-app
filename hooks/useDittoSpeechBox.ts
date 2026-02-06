import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import { SpeechBoxView } from '@/components/DittoSpeechBox/types'

const routeToViewMap: Record<string, SpeechBoxView> = {
    '/[chain]/disco': 'disco',
    '/disco': 'disco',
    '/[chain]/transmuter': 'transmuter',
    '/transmuter': 'transmuter',
    '/[chain]/manic': 'manic',
    '/manic': 'manic',
}

export const useDittoSpeechBox = () => {
    const router = useRouter()
    const [currentView, setCurrentView] = useState<SpeechBoxView>('hub')
    const [isUserNavigated, setIsUserNavigated] = useState(false)
    const justReturnedToHubRef = useRef(false)
    const justManuallyNavigatedRef = useRef(false)

    // Auto-navigate based on route when on hub
    useEffect(() => {
        if (!router.isReady || !router.pathname) return

        // Don't auto-navigate if user just returned to hub manually
        if (justReturnedToHubRef.current) {
            justReturnedToHubRef.current = false
            return
        }

        // Don't auto-navigate if user just manually navigated to a section
        if (justManuallyNavigatedRef.current) {
            console.log('Skipping auto-navigation - user just manually navigated')
            justManuallyNavigatedRef.current = false
            return
        }

        // Only auto-navigate if user is on hub and hasn't manually navigated
        // Use a function to get current state to avoid stale closure
        setCurrentView((prevView) => {
            if (prevView === 'hub' && !isUserNavigated) {
                const pathname = router.pathname
                // Check both exact pathname and pattern matches
                const matchingView = routeToViewMap[pathname] ||
                    (pathname.includes('/disco') ? 'disco' :
                        pathname.includes('/transmuter') ? 'transmuter' :
                            pathname.includes('/manic') ? 'manic' : null)

                if (matchingView) {
                    console.log('Auto-navigating to:', matchingView)
                    return matchingView
                }
            }
            return prevView
        })
    }, [router.pathname, router.isReady, isUserNavigated])

    // Reset user navigation flag when returning to hub
    const openSection = (view: SpeechBoxView) => {
        console.log('openSection called with view:', view)
        // justManuallyNavigatedRef.current = true // Mark that user manually navigated
        setCurrentView(view)

        // setIsUserNavigated(true)
        // justReturnedToHubRef.current = false
        console.log('setCurrentView called with:', view)
    }

    const returnToHub = () => {
        setCurrentView('hub')
        setIsUserNavigated(false)
        justReturnedToHubRef.current = true // Mark that user just returned to hub
        justManuallyNavigatedRef.current = false
    }

    return {
        currentView,
        openSection,
        returnToHub,
    }
}

