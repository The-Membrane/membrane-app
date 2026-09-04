import React, { useState, useEffect, useRef } from 'react'
import { Box, Button, Text, VStack, HStack, Image, Icon, Input, FormControl, FormLabel, Modal, ModalOverlay, ModalContent, ModalBody, ModalCloseButton, ModalHeader, useDisclosure, VisuallyHidden } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import { ArrowLeft, Wifi } from 'lucide-react'
import useAppState from '@/persisted-state/useAppState'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import type { Level } from './CyberpunkLevelsData'
import { useStorefront } from './hooks/useStorefront'
import { StorefrontRulesSection } from './StorefrontRulesSection'
import { StorefrontPortal } from './StorefrontPortal'
import { StorefrontTOSModal } from './StorefrontTOSModal'
import { LevelsControlPanel } from './LevelsControlPanel'
import { LevelsDisplay } from './LevelsDisplay'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

type View = 'storefront' | 'levels'

export type { Level }

// ImageWithFallback component
const ImageWithFallback = ({ src, alt, ...props }: any) => {
    const [hasError, setHasError] = useState(false)

    if (hasError) {
        return (
            <Box
                bg="gray.800"
                display="flex"
                alignItems="center"
                justifyContent="center"
                {...props}
            >
                <Text color="gray.500" fontSize="sm">Image failed to load</Text>
            </Box>
        )
    }

    return (
        <Image
            src={src}
            alt={alt}
            onError={() => setHasError(true)}
            {...props}
        />
    )
}

// Storefront Component
const StorefrontView = ({ onEnter }: { onEnter: (username: string) => void }) => {
    const {
        scanComplete,
        isScanning,
        scannerRef,
        scanLineRef,
        handleScannerMouseEnter,
        handleScannerMouseLeave,
        handleScannerClick,
        handleScannerKeyDown,
        username,
        setUsername,
        isTOSOpen,
        onTOSOpen,
        onTOSClose,
        tosContent,
    } = useStorefront()

    return (
        <Box
            position="relative"
            minH="100vh"
            bg={SEMANTIC_COLORS.bgPrimary}
            overflow="hidden"
            display="flex"
            flexDirection="column"
            alignItems="center"
            px={4}
        >
            {/* Hexagonal Background Grid */}
            <Box
                position="fixed"
                inset={0}
                opacity={0.5}
                zIndex={0}
            >
                <Box
                    as="svg"
                    w="100%"
                    h="100%"
                // css={{
                //     animation: 'hexScroll 33s linear infinite',
                // }}
                >
                    <defs>
                        <pattern id="hexagonPattern" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
                            {/* Left hexagon */}
                            <polygon
                                points="34.64,10 51.96,20 51.96,40 34.64,50 17.32,40 17.32,20"
                                fill="none"
                                stroke={SEMANTIC_COLORS.primary}
                                strokeWidth="1"
                            />
                            {/* Right hexagon (offset down) */}
                            <polygon
                                points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                fill="none"
                                stroke={SEMANTIC_COLORS.primary}
                                strokeWidth="1"
                            />
                            {/* Top-right continuation for seamless tiling */}
                            <polygon
                                points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                fill="none"
                                stroke={SEMANTIC_COLORS.primary}
                                strokeWidth="1"
                            />
                        </pattern>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#hexagonPattern)" />
                </Box>
            </Box>

            {/* The visible "THE MEMBRANE" wordmark below is built from decorative
                per-letter tags so it can be styled as a neon sign, and it only
                renders once the scan completes. This gives the page a single,
                always-present h1 so it is never heading-less for screen readers. */}
            <VisuallyHidden as="h1">The Membrane</VisuallyHidden>

            {/* Rules Section - At the top */}
            {!scanComplete && (
                <StorefrontRulesSection
                    scanComplete={scanComplete}
                    isScanning={isScanning}
                    scannerRef={scannerRef}
                    onTOSOpen={onTOSOpen}
                    handleScannerMouseEnter={handleScannerMouseEnter}
                    handleScannerMouseLeave={handleScannerMouseLeave}
                    handleScannerClick={handleScannerClick}
                    handleScannerKeyDown={handleScannerKeyDown}
                />
            )}

            {/* Neon Sign - Shown after scan complete */}
            {scanComplete && (
                <VStack mt={8} mb={16} spacing={4} position="relative" zIndex={2}>
                    <Box
                        className="neonSignon"
                        letterSpacing="wider"
                        textAlign="center"
                        display="flex"
                        flexDirection={{ base: "column", md: "row" }}
                        justifyContent="center"
                        alignItems="center"
                        gap={{ base: 0, md: "0.2em" }}
                        as="div"
                    >
                        <b style={{ display: "flex" }}>
                            <span>T</span>
                            <span>H</span>
                            <span>E</span>
                        </b>
                        <b style={{ display: "flex" }}>
                            <i style={{ display: "inline-block", fontSize: "clamp(75px, 4vh, 4vh)", fontStyle: "normal" }}>M</i>
                            <span>E</span>
                            <span>M</span>
                            <i style={{ display: "inline-block", fontSize: "clamp(75px, 4vh, 4vh)", fontStyle: "normal" }}>B</i>
                            <i style={{ display: "inline-block", fontSize: "clamp(75px, 4vh, 4vh)", fontStyle: "normal" }}>R</i>
                            <span>A</span>
                            <i style={{ display: "inline-block", fontSize: "clamp(75px, 4vh, 4vh)", fontStyle: "normal" }}>N</i>
                            <span>E</span>
                        </b>
                    </Box>
                </VStack>
            )}

            {/* Username Input Section */}
            {scanComplete && (
                <VStack spacing={4} position="relative" zIndex={2} mb={24}>
                    <Text
                        fontSize={{ base: "xs", md: "sm" }}
                        color={SEMANTIC_COLORS.textSecondary}
                        fontStyle="italic"
                        textAlign="end"
                    >
                        Your name is your sigil. Choose wisely.
                    </Text>
                    <FormControl>
                        <Input
                            // placeholder="Enter username to step within"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            bg={SEMANTIC_COLORS.bgPrimary}
                            border="2px solid"
                            borderColor="color-mix(in srgb, var(--m-secondary) 31%, transparent)"
                            color={SEMANTIC_COLORS.textPrimary}
                            borderRadius="md"
                            px={4}
                            py={3}
                            _hover={{
                                borderColor: SEMANTIC_COLORS.secondary,
                            }}
                            _focus={{
                                borderColor: SEMANTIC_COLORS.secondary,
                                boxShadow: `0 0 10px ${SEMANTIC_COLORS.secondary}`,
                                outline: 'none',
                            }}
                            _placeholder={{
                                color: SEMANTIC_COLORS.textSecondary,
                                letterSpacing: 'widest',
                                fontSize: 'sm',
                                textAlign: 'center',
                            }}
                            textAlign="start"
                            maxW="300px"
                            w="100%"
                        />
                    </FormControl>
                </VStack>
            )}

            {/* Blue Neon Scanning Line */}
            {isScanning && !scanComplete && (
                <Box
                    ref={scanLineRef}
                    position="fixed"
                    left={0}
                    top={0}
                    w="75px"
                    h="3px"
                    bg={SEMANTIC_COLORS.secondary}
                    pointerEvents="none"
                    zIndex={4}
                    willChange="transform"
                    style={{
                        animation: 'neonScanGlow 1s ease-in-out infinite',
                    }}
                />
            )}

            {/* Hexagonal Portal */}
            <StorefrontPortal
                scanComplete={scanComplete}
                username={username}
                onEnter={onEnter}
            />

            {/* Cursor-Following Black Circle */}
            {/* <Box
                ref={circleRef}
                position="fixed"
                left={0}
                top={0}
                w="120px"
                h="120px"
                borderRadius="full"
                bg="#000000"
                opacity={0.75}
                pointerEvents="none"
                zIndex={1}
                willChange="transform"
                filter="blur(8px)"
            /> */}

            {/* TOS Modal */}
            <StorefrontTOSModal
                isOpen={isTOSOpen}
                onClose={onTOSClose}
                tosContent={tosContent}
            />

            {/* Ambient Info */}
            <Box position="absolute" bottom={8} right={8} textAlign="right" zIndex={2}>
                <Text color={SEMANTIC_COLORS.textSecondary} fontSize="xs" letterSpacing="widest">
                    OPEN 24/7
                </Text>
                <Text color={SEMANTIC_COLORS.secondary} fontSize="xs" letterSpacing="widest">
                    NEURAL_DISTRICT_07
                </Text>
            </Box>
        </Box>
    )
}

// Levels Component
const LevelsView = ({
    onBack,
    onAbout
}: {
    onBack: () => void
    onAbout: () => void
}) => {
    const router = useRouter()
    const { chainName } = useChainRoute()
    const [selectedLevel, setSelectedLevel] = useState<number | null>(null)
    const currentFloorRef = useRef(0)

    const handleLevelClick = (level: Level) => {
        if (level.status === 'unlocked') {
            if (level.route) {
                router.push(`/${chainName}/${level.route}`)
                return
            }
            setSelectedLevel(level.id)
            currentFloorRef.current = level.id
        }
    }

    return (
        <Box
            position="relative"
            minH="100vh"
            bg={SEMANTIC_COLORS.bgPrimary}
            overflow="hidden"
            display="flex"
            flexDirection="column"
            alignItems="center"
            px={4}
            py={8}
        >
            {/* Hexagonal Background Grid */}
            <Box
                position="fixed"
                inset={0}
                opacity={0.5}
                zIndex={0}
            >
                <Box
                    as="svg"
                    w="100%"
                    h="100%"
                >
                    <defs>
                        <pattern id="hexagonPatternLevels" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
                            {/* Left hexagon */}
                            <polygon
                                points="34.64,10 51.96,20 51.96,40 34.64,50 17.32,40 17.32,20"
                                fill="none"
                                stroke={SEMANTIC_COLORS.primary}
                                strokeWidth="1"
                            />
                            {/* Right hexagon (offset down) */}
                            <polygon
                                points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                fill="none"
                                stroke={SEMANTIC_COLORS.primary}
                                strokeWidth="1"
                            />
                            {/* Top-right continuation for seamless tiling */}
                            <polygon
                                points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                fill="none"
                                stroke={SEMANTIC_COLORS.primary}
                                strokeWidth="1"
                            />
                        </pattern>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#hexagonPatternLevels)" />
                </Box>
            </Box>

            {/* Content */}
            <Box position="relative" zIndex={2} minH="100vh" display="flex" flexDirection="column" w="100%" px={4} py={8}>
                {/* Header */}
                <VStack mb={8} spacing={4}>
                    <Text
                        as="h1"
                        fontSize={TYPOGRAPHY.h1}
                        fontWeight={TYPOGRAPHY.bold}
                        fontFamily={TYPOGRAPHY.fontDisplay}
                        color={SEMANTIC_COLORS.textPrimary}
                        textAlign="center"
                    >
                        Elevator Access
                    </Text>
                    <HStack spacing={2} color={SEMANTIC_COLORS.textSecondary}>
                        <Icon as={Wifi} w={4} h={4} animation="pulse 2s infinite" />
                        <Text letterSpacing="widest" fontSize="sm">NEURAL LINK STABLE</Text>
                    </HStack>
                </VStack>

                <HStack
                    spacing={8}
                    maxW="6xl"
                    mx="auto"
                    w="100%"
                    flexDirection={{ base: 'column', md: 'row' }}
                    flex={1}
                    align="stretch"
                >
                    {/* Elevator Control Panel */}
                    <LevelsControlPanel
                        selectedLevel={selectedLevel}
                        onLevelClick={handleLevelClick}
                    />

                    {/* Level Display */}
                    <LevelsDisplay selectedLevel={selectedLevel} />
                </HStack>

                {/* Navigation */}
                <HStack spacing={4} justify="center" mt={8}>
                    <Button
                        onClick={onBack}
                        px={8}
                        py={3}
                        border="2px solid"
                        borderColor={SEMANTIC_COLORS.textSecondary}
                        color={SEMANTIC_COLORS.textSecondary}
                        bg="transparent"
                        _hover={{
                            borderColor: SEMANTIC_COLORS.textPrimary,
                            color: SEMANTIC_COLORS.textPrimary,
                        }}
                        transition="all 0.3s"
                        letterSpacing="wider"
                        leftIcon={<Icon as={ArrowLeft} w={5} h={5} />}
                    >
                        BACK
                    </Button>
                    <Button
                        onClick={onAbout}
                        px={8}
                        py={3}
                        border="2px solid"
                        borderColor={SEMANTIC_COLORS.primary}
                        color={SEMANTIC_COLORS.textPrimary}
                        bg="transparent"
                        _hover={{
                            bg: 'color-mix(in srgb, var(--m-primary) 13%, transparent)',
                            boxShadow: `0 0 20px ${SEMANTIC_COLORS.primary}`,
                        }}
                        transition="all 0.3s"
                        letterSpacing="wider"
                    >
                        ABOUT
                    </Button>
                </HStack>
            </Box>
        </Box>
    )
}

// Main CyberpunkHome Component
export const CyberpunkHome = React.memo(() => {
    const router = useRouter()
    const { chainName } = useChainRoute()
    const { appState, setAppState } = useAppState()

    // Check for query parameter to set initial view. This intentionally
    // ignores appState.setCookie on the very first (SSR-matching) render to
    // avoid a hydration mismatch - the effect below corrects it immediately
    // after mount for returning users.
    const initialView = (router.query.view as View) || 'storefront'
    const [currentView, setCurrentView] = useState<View>(initialView)

    // Update view when the query parameter changes, or - for returning
    // users who have already accepted the vow/ToS+cookies (persisted via
    // appState.setCookie) - skip the storefront ritual and land straight in
    // the normal app view. An explicit `?view=storefront` always re-opens
    // the ritual, e.g. for testing or re-reading the terms.
    React.useEffect(() => {
        if (router.query.view) {
            setCurrentView(router.query.view as View)
        } else if (appState.setCookie) {
            setCurrentView('levels')
        }
    }, [router.query.view, appState.setCookie])

    const handleEnter = (username: string) => {
        // Persist ToS + cookie acceptance so returning users aren't forced
        // through the storefront/scan ritual on every visit.
        setAppState({ username, setCookie: true })
        setCurrentView('levels')
        
        // Check if user has an intended route to redirect to
        if (appState.intendedRoute) {
            const intendedRoute = appState.intendedRoute
            // Clear the intended route
            setAppState({ intendedRoute: undefined })
            // Redirect to intended route after a brief delay
            setTimeout(() => {
                router.push(intendedRoute)
            }, 500)
        } else {
            router.push(`/${chainName}/levels`)
        }
    }

    const handleBack = () => {
        setCurrentView('storefront')
        router.push(`/${chainName}`, undefined, { shallow: true })
    }

    const handleAbout = () => {
        router.push(`/${chainName}/about`)
    }

    return (
        <Box>
            {currentView === 'storefront' && <StorefrontView onEnter={handleEnter} />}
            {currentView === 'levels' && (
                <LevelsView
                    onBack={handleBack}
                    onAbout={handleAbout}
                />
            )}
        </Box>
    )
})

CyberpunkHome.displayName = 'CyberpunkHome'

