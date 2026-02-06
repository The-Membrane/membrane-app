import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { Box } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import useAppState from '@/persisted-state/useAppState'
import { SpeechBubble } from './SpeechBubble'

interface RouteGuardProps {
    children: React.ReactNode
}

// Pages that don't require auth
const PUBLIC_PAGES = [
    '/[chain]',
    '/[chain]/index',
    '/[chain]/about',
]

export const RouteGuard: React.FC<RouteGuardProps> = ({ children }) => {
    const router = useRouter()
    const { appState, setAppState } = useAppState()
    const [isRedirecting, setIsRedirecting] = useState(false)
    const [showSpeechBubble, setShowSpeechBubble] = useState(false)

    const hasAuth = appState.setCookie && appState.username
    // Check if current pathname matches any public page pattern
    // router.pathname for /neutron/disco would be /[chain]/disco
    const isPublicPage = PUBLIC_PAGES.includes(router.pathname)

    useEffect(() => {
        // Skip guard for public pages
        if (isPublicPage) {
            return
        }

        // If user doesn't have auth and we're not already redirecting
        if (!hasAuth && !isRedirecting) {
            // Store intended route if not already stored
            if (!appState.intendedRoute) {
                setAppState({ intendedRoute: router.asPath })
            }

            // Show Ditto speech bubble
            setShowSpeechBubble(true)

            // Start fade out animation
            setIsRedirecting(true)

            // After fade out completes, redirect to home
            const redirectTimer = setTimeout(() => {
                const chainName = router.query.chain as string || 'neutron'
                router.push(`/${chainName}`).then(() => {
                    // Reset redirecting state after navigation
                    setTimeout(() => {
                        setIsRedirecting(false)
                        setShowSpeechBubble(false)
                    }, 100)
                })
            }, 800) // Match fade out duration

            return () => clearTimeout(redirectTimer)
        }
    }, [hasAuth, isPublicPage, isRedirecting, router, appState.intendedRoute, setAppState])

    // Don't render children if redirecting
    if (!hasAuth && !isPublicPage && isRedirecting) {
        return (
            <>
                <AnimatePresence>
                    {showSpeechBubble && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.3 }}
                            style={{
                                position: 'fixed',
                                bottom: 'calc(35% + 96px + 16px)',
                                left: '69%',
                                transform: 'translateX(-50%)',
                                zIndex: 10001,
                                pointerEvents: 'none',
                            }}
                        >
                            <SpeechBubble
                                message="No no no, you can't get past signing The Rites that easily."
                                isVisible={true}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
                <motion.div
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.8, ease: 'easeInOut' }}
                >
                    {children}
                </motion.div>
            </>
        )
    }

    return <>{children}</>
}

