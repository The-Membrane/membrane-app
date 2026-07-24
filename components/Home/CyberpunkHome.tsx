import React, { useState, useEffect, useRef } from 'react'
import { Box, Button, Text, VStack, HStack, Image, Icon, Input, FormControl, FormLabel, Modal, ModalOverlay, ModalContent, ModalBody, ModalCloseButton, ModalHeader, useDisclosure } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import { UserCircle, ArrowUp, ArrowLeft, Lock, Unlock, Wifi } from 'lucide-react'
import useAppState from '@/persisted-state/useAppState'
import { SpeechBubble } from '@/components/SpeechBubble'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import type { Level } from './CyberpunkLevelsData'
import { useStorefront } from './hooks/useStorefront'
import { StorefrontRulesSection } from './StorefrontRulesSection'
import { StorefrontPortal } from './StorefrontPortal'
import { StorefrontTOSModal } from './StorefrontTOSModal'
import { LevelsControlPanel } from './LevelsControlPanel'
import { LevelsDisplay } from './LevelsDisplay'

type View = 'storefront' | 'about' | 'levels'

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
            bg="#09090a"
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
                                stroke="#9bdc4f"
                                strokeWidth="1"
                            />
                            {/* Right hexagon (offset down) */}
                            <polygon
                                points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                fill="none"
                                stroke="#9bdc4f"
                                strokeWidth="1"
                            />
                            {/* Top-right continuation for seamless tiling */}
                            <polygon
                                points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                fill="none"
                                stroke="#9bdc4f"
                                strokeWidth="1"
                            />
                        </pattern>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#hexagonPattern)" />
                </Box>
            </Box>

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
                        color="#8d877b"
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
                            bg="#09090a"
                            border="2px solid"
                            borderColor="#46d39a50"
                            color="#ece6d8"
                            borderRadius="md"
                            px={4}
                            py={3}
                            _hover={{
                                borderColor: '#46d39a',
                            }}
                            _focus={{
                                borderColor: '#46d39a',
                                boxShadow: '0 0 10px #46d39a',
                                outline: 'none',
                            }}
                            _placeholder={{
                                color: '#8d877b',
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
                    bg="#46d39a"
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
                <Text color="#8d877b" fontSize="xs" letterSpacing="widest">
                    OPEN 24/7
                </Text>
                <Text color="#46d39a" fontSize="xs" letterSpacing="widest">
                    NEURAL_DISTRICT_07
                </Text>
            </Box>
        </Box>
    )
}

// Lobby Component
// const LobbyView = ({
//     onBack,
//     onReceptionist,
//     onElevator
// }: {
//     onBack: () => void
//     onReceptionist: () => void
//     onElevator: () => void
// }) => {
//     const { appState, setAppState } = useAppState()
//     const { chainName } = useChainRoute()
//     const username = appState.setCookie && appState.username ? appState.username : ''
//     const [showWelcomeMessage, setShowWelcomeMessage] = useState(false)
//     const [isFadingOut, setIsFadingOut] = useState(false)

//     // Show welcome message on entry and fade out after 7 seconds (only once)
//     useEffect(() => {
//         if (username && !appState.hasSeenWelcomeMessage) {
//             setShowWelcomeMessage(true)
//             setIsFadingOut(false)
//             setAppState({ hasSeenWelcomeMessage: true })

//             let hideTimer: NodeJS.Timeout | null = null

//             const fadeOutTimer = setTimeout(() => {
//                 setIsFadingOut(true)
//                 // Hide completely after fade animation completes
//                 hideTimer = setTimeout(() => {
//                     setShowWelcomeMessage(false)
//                 }, 300) // Match transition duration
//             }, 7000) // 7 seconds

//             return () => {
//                 clearTimeout(fadeOutTimer)
//                 if (hideTimer) {
//                     clearTimeout(hideTimer)
//                 }
//             }
//         }
//     }, [username, appState.hasSeenWelcomeMessage, setAppState])

//     return (
//         <Box
//             position="relative"
//             minH="100vh"
//             bg="#09090a"
//             overflow="hidden"
//             display="flex"
//             flexDirection="column"
//             alignItems="center"
//             px={4}
//         >
//             {/* Hexagonal Background Grid */}
//             <Box
//                 position="fixed"
//                 inset={0}
//                 opacity={0.5}
//                 zIndex={0}
//             >
//                 <Box
//                     as="svg"
//                     w="100%"
//                     h="100%"
//                 >
//                     <defs>
//                         <pattern id="hexagonPatternLobby" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
//                             {/* Left hexagon */}
//                             <polygon
//                                 points="34.64,10 51.96,20 51.96,40 34.64,50 17.32,40 17.32,20"
//                                 fill="none"
//                                 stroke="#9bdc4f"
//                                 strokeWidth="1"
//                             />
//                             {/* Right hexagon (offset down) */}
//                             <polygon
//                                 points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
//                                 fill="none"
//                                 stroke="#9bdc4f"
//                                 strokeWidth="1"
//                             />
//                             {/* Top-right continuation for seamless tiling */}
//                             <polygon
//                                 points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
//                                 fill="none"
//                                 stroke="#9bdc4f"
//                                 strokeWidth="1"
//                             />
//                         </pattern>
//                     </defs>
//                     <rect width="100%" height="100%" fill="url(#hexagonPatternLobby)" />
//                 </Box>
//             </Box>

//             {/* Ditto Speech Bubble - only show on neutron */}
//             {chainName === 'neutron' && username && showWelcomeMessage && (
//                 <Box
//                     position="fixed"
//                     bottom={0}
//                     left={0}
//                     zIndex={11}
//                     p={4}
//                     pointerEvents="none"
//                     opacity={isFadingOut ? 0 : 1}
//                     transition="opacity 0.3s ease-in-out"
//                 >
//                     <Box position="relative" w="128px" h="128px">
//                         <SpeechBubble
//                             message={`Welcome within, ${username}!`}
//                             isVisible={true}
//                             position={{
//                                 bottom: 'calc(35% + 96px + 16px)',
//                                 left: '69%',
//                             }}
//                         />
//                     </Box>
//                 </Box>
//             )}

//             {/* Content */}
//             <Box
//                 position="relative"
//                 zIndex={2}
//                 minH="100vh"
//                 display="flex"
//                 flexDirection="column"
//                 alignItems="center"
//                 justifyContent="center"
//                 w="100%"
//             >
//                 {/* Header */}
//                 <VStack mb={16} spacing={2}>
//                     <Text
//                         fontSize={{ base: '2xl', md: '4xl', lg: '6xl' }}
//                         fontFamily="mono"
//                         color="#9bdc4f"
//                         textShadow="0 0 20px #9bdc4f, 0 0 30px #9bdc4f"
//                         letterSpacing="wider"
//                         textAlign="center"
//                     >
//                         WELCOME TO THE MEMBRANE
//                     </Text>
//                     <Text color="#8d877b" letterSpacing="widest" fontSize="sm">
//                         CHOOSE YOUR DESTINATION
//                     </Text>
//                 </VStack>

//                 {/* Main Choices */}
//                 <HStack
//                     spacing={12}
//                     maxW="4xl"
//                     w="100%"
//                     flexDirection={{ base: 'column', md: 'row' }}
//                     mb={16}
//                 >
//                     {/* Receptionist - About */}
//                     <Box
//                         as="button"
//                         onClick={onReceptionist}
//                         position="relative"
//                         h="320px"
//                         w="100%"
//                         bgGradient="linear(to-br, #9bdc4f20, #09090a)"
//                         border="2px solid"
//                         borderColor="#9bdc4f"
//                         borderRadius="md"
//                         overflow="hidden"
//                         transition="all 0.3s"
//                         cursor="pointer"
//                         _hover={{
//                             borderColor: '#9bdc4f',
//                             boxShadow: '0 0 40px #9bdc4f',
//                             transform: 'scale(1.05)',
//                         }}
//                         role="group"
//                     >
//                         <VStack
//                             position="absolute"
//                             top={8}
//                             left="50%"
//                             transform="translateX(-50%)"
//                             spacing={4}
//                         >
//                             <Box position="relative">
//                                 <Icon
//                                     as={UserCircle}
//                                     w={20}
//                                     h={20}
//                                     color="#9bdc4f"
//                                     filter="drop-shadow(0 0 10px #9bdc4f)"
//                                     transition="color 0.3s"
//                                     _groupHover={{
//                                         color: '#9bdc4f',
//                                     }}
//                                 />
//                                 <Box
//                                     position="absolute"
//                                     top="-16px"
//                                     left="-16px"
//                                     right="-16px"
//                                     bottom="-16px"
//                                     border="2px solid"
//                                     borderColor="#46d39a"
//                                     borderRadius="full"
//                                     opacity={0.3}
//                                     css={{
//                                         animation: 'ping 2s cubic-bezier(0, 0, 0.2, 1) infinite',
//                                     }}
//                                 />
//                             </Box>
//                         </VStack>

//                         <VStack
//                             position="absolute"
//                             bottom={12}
//                             left={0}
//                             right={0}
//                             spacing={2}
//                             px={6}
//                         >
//                             <Text color="#ece6d8" fontSize="2xl" letterSpacing="wider">
//                                 RECEPTIONIST
//                             </Text>
//                             <Text color="#8d877b" fontSize="sm">
//                                 Learn about The Membrane
//                             </Text>
//                             <Box mt={4} h="4px" w="96px" mx="auto" bgGradient="linear(to-r, transparent, #46d39a, transparent)" />
//                         </VStack>

//                         {/* Corner Accents */}
//                         <Box
//                             position="absolute"
//                             top={0}
//                             right={0}
//                             w="64px"
//                             h="64px"
//                             borderTop="4px solid"
//                             borderRight="4px solid"
//                             borderColor="#46d39a"
//                             opacity={0.5}
//                         />
//                         <Box
//                             position="absolute"
//                             bottom={0}
//                             left={0}
//                             w="64px"
//                             h="64px"
//                             borderBottom="4px solid"
//                             borderLeft="4px solid"
//                             borderColor="#46d39a"
//                             opacity={0.5}
//                         />
//                     </Box>

//                     {/* Elevator - Levels */}
//                     <Box
//                         as="button"
//                         onClick={onElevator}
//                         position="relative"
//                         h="320px"
//                         w="100%"
//                         bgGradient="linear(to-br, #46d39a20, #09090a)"
//                         border="2px solid"
//                         borderColor="#46d39a"
//                         borderRadius="md"
//                         overflow="hidden"
//                         transition="all 0.3s"
//                         cursor="pointer"
//                         _hover={{
//                             borderColor: '#9bdc4f',
//                             boxShadow: '0 0 40px #46d39a',
//                             transform: 'scale(1.05)',
//                         }}
//                         role="group"
//                     >
//                         <VStack
//                             position="absolute"
//                             top={8}
//                             left="50%"
//                             transform="translateX(-50%)"
//                             spacing={4}
//                         >
//                             <Box
//                                 w="96px"
//                                 h="128px"
//                                 border="4px solid"
//                                 borderColor="#46d39a"
//                                 borderRadius="md"
//                                 bg="#09090a80"
//                                 display="flex"
//                                 alignItems="center"
//                                 justifyContent="center"
//                             >
//                                 <Icon
//                                     as={ArrowUp}
//                                     w={12}
//                                     h={12}
//                                     color="#46d39a"
//                                     filter="drop-shadow(0 0 10px #46d39a)"
//                                     transition="color 0.3s"
//                                     animation="bounce 1s infinite"
//                                     _groupHover={{
//                                         color: '#9bdc4f',
//                                     }}
//                                 />
//                             </Box>
//                         </VStack>

//                         <VStack
//                             position="absolute"
//                             bottom={12}
//                             left={0}
//                             right={0}
//                             spacing={2}
//                             px={6}
//                         >
//                             <Text color="#ece6d8" fontSize="2xl" letterSpacing="wider">
//                                 ELEVATOR
//                             </Text>
//                             <Text color="#8d877b" fontSize="sm">
//                                 Explore the levels
//                             </Text>
//                             <Box mt={4} h="4px" w="96px" mx="auto" bgGradient="linear(to-r, transparent, #9bdc4f, transparent)" />
//                         </VStack>

//                         {/* Corner Accents */}
//                         <Box
//                             position="absolute"
//                             top={0}
//                             right={0}
//                             w="64px"
//                             h="64px"
//                             borderTop="4px solid"
//                             borderRight="4px solid"
//                             borderColor="#9bdc4f"
//                             opacity={0.5}
//                         />
//                         <Box
//                             position="absolute"
//                             bottom={0}
//                             left={0}
//                             w="64px"
//                             h="64px"
//                             borderBottom="4px solid"
//                             borderLeft="4px solid"
//                             borderColor="#9bdc4f"
//                             opacity={0.5}
//                         />
//                     </Box>
//                 </HStack>

//                 {/* Back Button */}
//                 <Button
//                     onClick={onBack}
//                     px={8}
//                     py={3}
//                     border="1px solid"
//                     borderColor="#8d877b"
//                     color="#8d877b"
//                     bg="transparent"
//                     _hover={{
//                         borderColor: '#ece6d8',
//                         color: '#ece6d8',
//                     }}
//                     transition="colors 0.3s"
//                     letterSpacing="wider"
//                     fontSize="sm"
//                     width="20%"
//                 >
//                     EXIT
//                 </Button>

//             </Box>
//         </Box>
//     )
// }

// About Component
const AboutView = ({
    onBack,
    onElevator
}: {
    onBack: () => void
    onElevator: () => void
}) => {
    return (
        <Box
            position="relative"
            minH="100vh"
            bg="#09090a"
            overflow="hidden"
            display="flex"
            flexDirection="column"
            alignItems="center"
            px={4}
            py={12}
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
                        <pattern id="hexagonPatternAbout" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
                            {/* Left hexagon */}
                            <polygon
                                points="34.64,10 51.96,20 51.96,40 34.64,50 17.32,40 17.32,20"
                                fill="none"
                                stroke="#9bdc4f"
                                strokeWidth="1"
                            />
                            {/* Right hexagon (offset down) */}
                            <polygon
                                points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                fill="none"
                                stroke="#9bdc4f"
                                strokeWidth="1"
                            />
                            {/* Top-right continuation for seamless tiling */}
                            <polygon
                                points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                fill="none"
                                stroke="#9bdc4f"
                                strokeWidth="1"
                            />
                        </pattern>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#hexagonPatternAbout)" />
                </Box>
            </Box>

            {/* Content */}
            <Box position="relative" zIndex={2} maxW="3xl" mx="auto" w="100%">
                {/* Header */}
                <VStack mb={12} spacing={6}>
                    <Box
                        display="inline-block"
                        p={6}
                        border="2px solid"
                        borderColor="#9bdc4f"
                        borderRadius="full"
                        boxShadow="0 0 30px #9bdc4f"
                    >
                        <Box
                            w="96px"
                            h="96px"
                            bgGradient="linear(to-br, #9bdc4f, #9bdc4f)"
                            borderRadius="full"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                        >
                            <Text color="#ece6d8" fontSize="4xl">R</Text>
                        </Box>
                    </Box>
                    <Text
                        fontSize={{ base: '2xl', md: '4xl', lg: '6xl' }}
                        fontFamily="mono"
                        color="#9bdc4f"
                        textShadow="0 0 20px #9bdc4f"
                        letterSpacing="wider"
                        textAlign="center"
                    >
                        RECEPTIONIST
                    </Text>
                    <Text color="#8d877b" letterSpacing="widest">
                        NEURAL INTERFACE ACTIVE
                    </Text>
                </VStack>

                {/* Dialogue Box */}
                <Box
                    bgGradient="linear(to-br, #9bdc4f10, #09090a)"
                    border="2px solid"
                    borderColor="#9bdc4f"
                    borderRadius="md"
                    p={8}
                    mb={8}
                    boxShadow="0 0 20px #9bdc4f20"
                >
                    <VStack spacing={6} align="stretch">
                        <HStack align="start" spacing={4}>
                            <Box
                                w="8px"
                                h="8px"
                                bg="#46d39a"
                                borderRadius="full"
                                mt={2}
                                animation="pulse 2s infinite"
                            />
                            <Text color="#ece6d8" flex={1}>
                                Welcome to <Text as="span" color="#9bdc4f">The Membrane</Text>, where the boundaries between reality and the digital realm blur into something extraordinary.
                            </Text>
                        </HStack>

                        <HStack align="start" spacing={4}>
                            <Box
                                w="8px"
                                h="8px"
                                bg="#46d39a"
                                borderRadius="full"
                                mt={2}
                                animation="pulse 2s infinite"
                                style={{ animationDelay: '0.5s' }}
                            />
                            <Text color="#ece6d8" flex={1}>
                                We are more than just a club. We are a neural nexus, a convergence point for digital consciousness and human experience.
                            </Text>
                        </HStack>
                    </VStack>
                </Box>

                {/* Features Grid */}
                <HStack
                    spacing={6}
                    mb={8}
                    flexDirection={{ base: 'column', md: 'row' }}
                >
                    <Box
                        border="1px solid"
                        borderColor="#9bdc4f50"
                        borderRadius="md"
                        p={6}
                        bg="#09090a80"
                        _hover={{ borderColor: '#46d39a' }}
                        transition="colors 0.3s"
                        flex={1}
                    >
                        <Text color="#46d39a" mb={4} fontSize="2xl">⚡</Text>
                        <Text color="#ece6d8" mb={2} fontWeight="bold">
                            IMMERSIVE EXPERIENCE
                        </Text>
                        <Text color="#8d877b" fontSize="sm">
                            Cutting-edge neural technology creates unparalleled sensory journeys
                        </Text>
                    </Box>

                    <Box
                        border="1px solid"
                        borderColor="#9bdc4f50"
                        borderRadius="md"
                        p={6}
                        bg="#09090a80"
                        _hover={{ borderColor: '#46d39a' }}
                        transition="colors 0.3s"
                        flex={1}
                    >
                        <Text color="#9bdc4f" mb={4} fontSize="2xl">🛡️</Text>
                        <Text color="#ece6d8" mb={2} fontWeight="bold">
                            SECURE PROTOCOL
                        </Text>
                        <Text color="#8d877b" fontSize="sm">
                            Military-grade encryption protects your neural signature
                        </Text>
                    </Box>

                    <Box
                        border="1px solid"
                        borderColor="#9bdc4f50"
                        borderRadius="md"
                        p={6}
                        bg="#09090a80"
                        _hover={{ borderColor: '#46d39a' }}
                        transition="colors 0.3s"
                        flex={1}
                    >
                        <Text color="#9bdc4f" mb={4} fontSize="2xl">🧠</Text>
                        <Text color="#ece6d8" mb={2} fontWeight="bold">
                            MULTI-LEVEL ACCESS
                        </Text>
                        <Text color="#8d877b" fontSize="sm">
                            Explore different dimensions of consciousness across our levels
                        </Text>
                    </Box>
                </HStack>

                {/* Info Box */}
                <Box
                    borderLeft="4px solid"
                    borderColor="#46d39a"
                    bg="#46d39a05"
                    borderRadius="md"
                    p={6}
                    mb={8}
                >
                    <Text color="#ece6d8" mb={2}>
                        <Text as="span" color="#46d39a">STATUS:</Text> Currently operating at 99.7% neural sync capacity
                    </Text>
                    <Text color="#ece6d8">
                        <Text as="span" color="#46d39a">LOCATION:</Text> Neural District 07, Sector Grid 42-A
                    </Text>
                </Box>

                {/* Navigation Buttons */}
                <HStack spacing={4} justify="center">
                    <Button
                        onClick={onBack}
                        px={8}
                        py={3}
                        border="2px solid"
                        borderColor="#9bdc4f"
                        color="#ece6d8"
                        bg="transparent"
                        _hover={{
                            bg: '#9bdc4f20',
                            boxShadow: '0 0 20px #9bdc4f',
                        }}
                        transition="all 0.3s"
                        letterSpacing="wider"
                        leftIcon={<Icon as={ArrowLeft} w={5} h={5} />}
                    >
                        BACK TO LOBBY
                    </Button>
                    <Button
                        onClick={onElevator}
                        px={8}
                        py={3}
                        bgGradient="linear(to-r, #9bdc4f, #9bdc4f)"
                        color="#ece6d8"
                        _hover={{
                            boxShadow: '0 0 30px #9bdc4f',
                        }}
                        transition="all 0.3s"
                        letterSpacing="wider"
                    >
                        EXPLORE LEVELS
                    </Button>
                </HStack>
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
            bg="#09090a"
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
                                stroke="#9bdc4f"
                                strokeWidth="1"
                            />
                            {/* Right hexagon (offset down) */}
                            <polygon
                                points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                fill="none"
                                stroke="#9bdc4f"
                                strokeWidth="1"
                            />
                            {/* Top-right continuation for seamless tiling */}
                            <polygon
                                points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                fill="none"
                                stroke="#9bdc4f"
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
                        fontSize={{ base: '2xl', md: '4xl', lg: '6xl' }}
                        fontFamily="mono"
                        color="#46d39a"
                        textShadow="0 0 20px #46d39a, 0 0 40px #46d39a"
                        letterSpacing="wider"
                        textAlign="center"
                    >
                        ELEVATOR ACCESS
                    </Text>
                    <HStack spacing={2} color="#8d877b">
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
                        borderColor="#8d877b"
                        color="#8d877b"
                        bg="transparent"
                        _hover={{
                            borderColor: '#ece6d8',
                            color: '#ece6d8',
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
                        borderColor="#9bdc4f"
                        color="#ece6d8"
                        bg="transparent"
                        _hover={{
                            bg: '#9bdc4f20',
                            boxShadow: '0 0 20px #9bdc4f',
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

    const handleReceptionist = () => {
        setCurrentView('about')
        router.push(`/${chainName}?view=about`, undefined, { shallow: true })
    }

    const handleElevator = () => {
        setCurrentView('levels')
        router.push(`/${chainName}?view=levels`, undefined, { shallow: true })
    }

    const handleAbout = () => {
        router.push(`/${chainName}/about`)
    }

    return (
        <Box>
            {currentView === 'storefront' && <StorefrontView onEnter={handleEnter} />}
            {currentView === 'about' && (
                <AboutView
                    onBack={() => {
                        router.push(`/${chainName}/levels`)
                    }}
                    onElevator={handleElevator}
                />
            )}
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

