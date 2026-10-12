import React, { useState } from 'react'
import { Box, Text, VStack, Image, Input, FormControl, FormLabel, Modal, ModalOverlay, ModalContent, ModalBody, ModalCloseButton, ModalHeader, useDisclosure, VisuallyHidden } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import useAppState from '@/persisted-state/useAppState'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { useStorefront } from './hooks/useStorefront'
import { StorefrontRulesSection } from './StorefrontRulesSection'
import { StorefrontPortal } from './StorefrontPortal'
import { StorefrontTOSModal } from './StorefrontTOSModal'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

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

// Main CyberpunkHome Component
export const CyberpunkHome = React.memo(() => {
    const router = useRouter()
    const { chainName } = useChainRoute()
    const { appState, setAppState } = useAppState()

    // The Levels directory view (and /[chain]/levels) was removed 2026-10-12
    // (docs/CUTS-2026-10-12.md). The storefront is now the only view; entering
    // goes to the user's intended route, or the chain root.
    const handleEnter = (username: string) => {
        // Persist ToS + cookie acceptance so returning users aren't forced
        // through the storefront/scan ritual on every visit.
        setAppState({ username, setCookie: true })

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
            router.push(`/${chainName}`)
        }
    }

    return (
        <Box>
            <StorefrontView onEnter={handleEnter} />
        </Box>
    )
})

CyberpunkHome.displayName = 'CyberpunkHome'

