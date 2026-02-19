import React, { useEffect, useState, useMemo } from 'react'
import { Box, Image } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { DittoPanel } from './DittoSpeechBox/DittoPanel'
import { usePageActions } from './DittoSpeechBox/hooks/usePageActions'
import { ActionIndicator } from './DittoSpeechBox/ActionIndicator'
import { getThemeForRoute, getFallbackImage, DittoTheme } from '@/config/dittoThemes'
import { SpeechBubble } from '@/components/SpeechBubble'
import useAppState from '@/persisted-state/useAppState'
import useDittoSpeechBoxState from './DittoSpeechBox/hooks/useDittoSpeechBoxState'

interface DittoHologramProps {
    stayShown?: boolean
}

export const DittoHologram: React.FC<DittoHologramProps> = ({ stayShown = true }) => {
    const router = useRouter()
    const { hasAvailableActions, actionTooltip, availableActions } = usePageActions()
    const { appState } = useAppState()
    const { dittoSpeechBoxState, setDittoSpeechBoxState } = useDittoSpeechBoxState()
    const [isHovered, setIsHovered] = useState(false)
    const [imageError, setImageError] = useState(false)
    const [isPanelOpen, setIsPanelOpen] = useState(false)
    const [showWelcomeBubble, setShowWelcomeBubble] = useState(false)
    
    const username = appState.setCookie && appState.username ? appState.username : ''
    const hasSeenWelcome = dittoSpeechBoxState.hasSeenWelcome

    // Get current theme based on route
    const currentTheme: DittoTheme = useMemo(() => {
        return getThemeForRoute(router.pathname)
    }, [router.pathname])

    // Reset image error when theme changes
    useEffect(() => {
        setImageError(false)
    }, [currentTheme.id])

    // Get the image path (fallback if error)
    const imagePath = imageError ? getFallbackImage() : currentTheme.imagePath

    // Show welcome bubble after portal entry (when username is set and not on home page)
    useEffect(() => {
        if (username && !hasSeenWelcome && stayShown && !isPanelOpen && router.pathname !== '/') {
            // Small delay to ensure navigation is complete
            const timer = setTimeout(() => {
                setShowWelcomeBubble(true)
            }, 1000)
            return () => clearTimeout(timer)
        }
    }, [username, hasSeenWelcome, stayShown, isPanelOpen, router.pathname])

    // Auto-dismiss after 5 seconds
    useEffect(() => {
        if (showWelcomeBubble) {
            const timer = setTimeout(() => {
                setShowWelcomeBubble(false)
                setDittoSpeechBoxState({ hasSeenWelcome: true })
            }, 5000)
            return () => clearTimeout(timer)
        }
    }, [showWelcomeBubble, setDittoSpeechBoxState])

    // Dismiss welcome handler
    const dismissWelcome = () => {
        setShowWelcomeBubble(false)
        setDittoSpeechBoxState({ hasSeenWelcome: true })
    }

    // Toggle panel open/closed
    const togglePanel = () => {
        setIsPanelOpen(prev => !prev)
        // Dismiss welcome bubble when panel opens
        if (showWelcomeBubble) {
            dismissWelcome()
        }
    }

    // Handle action indicator click
    const handleActionIndicatorClick = () => {
        setIsPanelOpen(true)
    }

    // Show badge when there are actions available
    const showBadge = hasAvailableActions
    const badgeCount = availableActions.length

    return (
        <Box
            position="fixed"
            bottom="16px"
            left="16px"
            zIndex={9999}
            pointerEvents="none"
        >
            {/* Ditto Panel - positioned above Ditto */}
            {stayShown && (
                <Box
                    position="absolute"
                    bottom="165px"
                    left="0"
                    pointerEvents="auto"
                    zIndex={10000}
                >
                    <DittoPanel
                        isVisible={isPanelOpen}
                        onClose={() => setIsPanelOpen(false)}
                    />
                </Box>
            )}

            {/* Container for hologram and Ditto */}
            <Box position="relative" w="160px" h="140px">
                {/* Base hologram platform */}
                <Image
                    src="/images/holo-no-ditto.svg"
                    alt="Holo no ditto"
                    w="128px"
                    h="128px"
                    objectFit="contain"
                    position="absolute"
                    bottom="-14px"
                    left="16px"
                />

                {/* Ditto image - centered on top of hologram */}
                <Image
                    key={currentTheme.id}
                    src={imagePath}
                    alt={currentTheme.altText}
                    position="absolute"
                    bottom="50px"
                    left="50%"
                    transform="translateX(-50%)"
                    w="110px"
                    h="110px"
                    objectFit="contain"
                    opacity={stayShown ? 1 : 0}
                    transition="all 0.3s ease-in-out"
                    zIndex={1}
                    pointerEvents="auto"
                    cursor="pointer"
                    onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        togglePanel()
                    }}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                    onError={() => setImageError(true)}
                    filter={showBadge && !isPanelOpen
                        ? `drop-shadow(0 0 15px ${currentTheme.glowColor})`
                        : "none"}
                    _hover={{
                        filter: `drop-shadow(0 0 20px ${currentTheme.glowColor})`,
                        transform: "translateX(-50%) scale(1.1)",
                    }}
                />

                {/* Action indicator badge */}
                {stayShown && !isPanelOpen && showBadge && (
                    <Box position="absolute" bottom="115px" left="115px" pointerEvents="auto">
                        <ActionIndicator
                            hasActions={hasAvailableActions}
                            tooltip={actionTooltip}
                            count={badgeCount}
                            onClick={handleActionIndicatorClick}
                        />
                    </Box>
                )}

                {/* Welcome Speech Bubble - shown after portal entry */}
                {stayShown && showWelcomeBubble && username && !isPanelOpen && (
                    <Box
                        position="absolute"
                        bottom="0"
                        left="0"
                        pointerEvents="auto"
                        zIndex={10001}
                    >
                        <Box position="relative" w="160px" h="140px">
                            <SpeechBubble
                                message={`Welcome ${username}!`}
                                isVisible={showWelcomeBubble}
                                position={{
                                    bottom: 'calc(35% + 96px + 16px)',
                                    left: '69%',
                                }}
                                maxW="280px"
                                minW="200px"
                                onDismiss={dismissWelcome}
                            />
                        </Box>
                    </Box>
                )}
            </Box>
        </Box>
    )
}
