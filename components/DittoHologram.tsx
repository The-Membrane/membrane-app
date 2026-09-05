import React, { useEffect, useState, useMemo, useRef } from 'react'
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
    const isHoveredRef = useRef(false)
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
            /* MOBILE: Ditto leans in from off-screen rather than standing on the page.
               He is pushed past the bottom-left corner so only the head and one arm
               enter the frame, which keeps a 9999-z sprite off the card corners it
               used to cover. Desktop is unchanged. The insets are negative on purpose:
               the sprite is meant to be clipped by the viewport edge. */
            bottom={{ base: '-16px', md: '16px' }}
            left={{ base: '-34px', md: '16px' }}
            zIndex={9999}
            pointerEvents="none"
        >
            {/* Ditto Panel - positioned above Ditto */}
            {stayShown && (
                <Box
                    position="absolute"
                    /* The panel is the "voice", so it starts at the head. On mobile the
                       head sits higher and further right than the desktop anchor because
                       of the tilt, and the left offset cancels the wrapper's negative
                       inset so the panel stays fully on screen. */
                    bottom={{ base: '124px', md: '165px' }}
                    left={{ base: '34px', md: '0' }}
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
            <Box position="relative" w={{ base: '124px', md: '150px' }} h={{ base: '112px', md: '140px' }}>
                {/* TILT LAYER. The rotation wraps the ARTWORK ONLY. The badge and the
                    speech bubble are siblings below, so they stay upright: a tilted
                    speech bubble reads as a rendering bug rather than a character
                    leaning in. Origin is the bottom-left corner so he pivots on the
                    corner he is leaning around. */}
                <Box
                    position="absolute"
                    inset={0}
                    transform={{ base: 'rotate(13deg)', md: 'none' }}
                    transformOrigin="bottom left"
                >
                {/* Base hologram platform. Hidden on mobile: a plinth cut in half by the
                    viewport edge reads as broken, and he is leaning in rather than
                    standing on anything. */}
                {/* The emitter. Aspect 1.500 (1536x1024): width and height are set from
                    that ratio rather than as a square, which would squash it. Hidden on
                    mobile, where Ditto leans in from off-screen with nothing to stand on. */}
                <Image
                    src="/images/holo-plinth.png"
                    alt=""
                    aria-hidden
                    display={{ base: 'none', md: 'block' }}
                    w="132px"
                    h="88px"
                    objectFit="contain"
                    position="absolute"
                    bottom="0"
                    left="9px"
                />

                {/* Ditto image - centered on top of hologram */}
                <Image
                    key={currentTheme.id}
                    src={imagePath}
                    alt={currentTheme.altText}
                    position="absolute"
                    bottom={{ base: '4px', md: '25px' }}
                    left={{ base: '0', md: '50%' }}
                    transform={{ base: 'none', md: 'translateX(-50%)' }}
                    /* HARD CAP on mobile. Themes may set imageSize as large as 220px
                       (mint), which is 56% of a 390px viewport. The cap ignores the
                       theme value so no single page can reintroduce the eyesore. */
                    /* 90% of the plinth's width (owner pick). Height follows the 1.094
                       aspect: a square box would distort him. Mobile keeps its own cap. */
                    w={{ base: '104px', md: '119px' }}
                    h={{ base: '95px', md: '109px' }}
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
                    onMouseEnter={() => { isHoveredRef.current = true }}
                    onMouseLeave={() => { isHoveredRef.current = false }}
                    onError={() => setImageError(true)}
                    filter={showBadge && !isPanelOpen
                        ? `drop-shadow(0 0 15px ${currentTheme.glowColor})`
                        : "none"}
                    _hover={{
                        filter: `drop-shadow(0 0 20px ${currentTheme.glowColor})`,
                    }}
                />
                </Box>

                {/* Action indicator badge */}
                {stayShown && !isPanelOpen && showBadge && (
                    <Box
                        position="absolute"
                        bottom={{ base: '115px', md: '115px' }}
                        left={{ base: '49px', md: '115px' }}
                        pointerEvents="auto"
                    >
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
                        <Box position="relative" w={{ base: '124px', md: '160px' }} h={{ base: '112px', md: '140px' }}>
                            <SpeechBubble
                                message={`Welcome ${username}!`}
                                isVisible={showWelcomeBubble}
                                /* Anchored to the head in both layouts. On mobile the
                                   head has swung right and down with the tilt, and the
                                   left value also has to clear the wrapper's -34px
                                   inset so the bubble never starts off-screen. */
                                position={{
                                    bottom: 'calc(35% + 96px + 16px)',
                                    left: '69%',
                                }}
                                maxW={{ base: 'calc(100vw - 96px)', md: '280px' }}
                                minW={{ base: '0', md: '200px' }}
                                onDismiss={dismissWelcome}
                            />
                        </Box>
                    </Box>
                )}
            </Box>
        </Box>
    )
}
