import React, { useState, useEffect } from 'react'
import { Box, Button, Text, VStack, HStack, Image, Icon, Input, FormControl, FormLabel, Modal, ModalOverlay, ModalContent, ModalBody, ModalCloseButton, ModalHeader, useDisclosure } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import { UserCircle, ArrowUp, ArrowLeft, Lock, Unlock, Wifi } from 'lucide-react'
import useAppState from '@/persisted-state/useAppState'
import { SpeechBubble } from '@/components/SpeechBubble'

type View = 'storefront' | 'about' | 'levels'

export interface Level {
    id: number
    name: string
    subtitle?: string
    description: string
    status: 'unlocked' | 'locked'
    color: string
    route?: string
}

export const levels: Level[] = [

    {
        id: 1,
        name: 'TRANSMUTER',
        subtitle: 'CDT <> USDC Exchange',
        description: 'Earn MBRN by providing USDC to fuel the transmutation of CDT to USDC.',
        status: 'unlocked',
        color: '#3BE5E5',
        route: 'transmuter'
    },
    {
        id: 2,
        name: 'MANIC',
        subtitle: 'Boosted stablecoin yield',
        description: 'Loop USDC supplied on Mars Protocol to boost your stablecoin yield by 10x.',
        status: 'unlocked',
        color: '#6943FF',
        route: 'manic'
    },
    {
        id: 3,
        name: 'LTV DISCO',
        subtitle: 'Revenue-fueled System Backstop',
        description: 'Deposit MBRN to earn protocol revenue in exchange for backstopping the system.',
        status: 'unlocked',
        color: '#A692FF',
        route: 'disco'
    },
    {
        id: 5,
        name: 'MAZE RUNNERS',
        subtitle: 'On-chain AI Racing Game',
        description: 'Train your own AI to traverse mazes, earn $BYTE and reign supreme as the world\'s #1.',
        status: 'unlocked',
        color: '#6943FF',
        route: 'maze-runners'
    },
    {
        id: 6,
        name: 'STAKE',
        subtitle: 'Staking Protocol',
        description: 'Stake MBRN to earn protocol rewards.',
        status: 'unlocked',
        color: '#A692FF',
        route: 'stake'
    },
    {
        id: 7,
        name: 'BRIDGE',
        subtitle: 'Osmosis -> Neutron MBRN Bridge',
        description: 'Bridge MBRN & transmute MBRN from Osmosis to use on Neutron.',
        status: 'unlocked',
        color: '#3BE5E5',
        route: 'bridge'
    }
]

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
    const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 })
    const circleRef = React.useRef<HTMLDivElement>(null)
    const { setAppState } = useAppState()

    // Scanner state
    const [isScanning, setIsScanning] = useState(false)
    const [scanComplete, setScanComplete] = useState(false)
    const [scanPatterns, setScanPatterns] = useState(0)
    const [lastY, setLastY] = useState<number | null>(null)
    const [currentDirection, setCurrentDirection] = useState<'down' | 'up' | null>(null)
    const [scanLineY, setScanLineY] = useState(0)
    const [scannerBounds, setScannerBounds] = useState<{ top: number; bottom: number; centerX: number } | null>(null)
    const [username, setUsername] = useState('')
    const [tosContent, setTosContent] = useState<string>('')
    const { isOpen: isTOSOpen, onOpen: onTOSOpen, onClose: onTOSClose } = useDisclosure()
    const scanLineRef = React.useRef<HTMLDivElement>(null)
    const scannerRef = React.useRef<HTMLDivElement>(null)
    const scanAnimationRef = React.useRef<number | null>(null)

    // Load TOS content only when modal opens
    useEffect(() => {
        if (isTOSOpen && !tosContent) {
            fetch('/TOS.md')
                .then(res => res.text())
                .then(text => setTosContent(text))
                .catch(err => console.error('Failed to load TOS:', err))
        }
    }, [isTOSOpen, tosContent])

    React.useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            // Use requestAnimationFrame for smoother updates
            requestAnimationFrame(() => {
                if (circleRef.current) {
                    // Use transform instead of left/top for better performance
                    circleRef.current.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`
                }
                setMousePosition({ x: e.clientX, y: e.clientY })
            })
        }

        window.addEventListener('mousemove', handleMouseMove)

        return () => {
            window.removeEventListener('mousemove', handleMouseMove)
        }
    }, [])



    // Auto-scanning animation
    React.useEffect(() => {
        if (!isScanning || scanComplete || !scannerBounds) return

        let direction: 'up' | 'down' = 'down' // Start going down from top
        let currentY = scannerBounds.top
        const speed = 0.6 // Slower speed - pixels per frame
        let cycleStep = 0 // Track cycle steps: 0=initial, 1=reached bottom, 2=reached top after bottom, 3=reached bottom again (complete)

        const animate = () => {
            if (direction === 'down') {
                currentY += speed
                if (currentY >= scannerBounds.bottom) {
                    currentY = scannerBounds.bottom
                    if (cycleStep === 0) {
                        // First time reaching bottom (first part: down)
                        cycleStep = 1
                        direction = 'up'
                        setCurrentDirection('up')
                    } else if (cycleStep === 2) {
                        // Reached bottom again (third part: down) - complete cycle: down -> up -> down
                        setScanComplete(true)
                        setIsScanning(false)
                        setAppState({ setCookie: true })
                        return // Stop animation
                    }
                }
            } else {
                currentY -= speed
                if (currentY <= scannerBounds.top) {
                    currentY = scannerBounds.top
                    if (cycleStep === 1) {
                        // Reached top after going down (second part: up)
                        cycleStep = 2
                        direction = 'down'
                        setCurrentDirection('down')
                    }
                }
            }

            setScanLineY(currentY)
            setLastY(currentY)

            if (isScanning && !scanComplete) {
                scanAnimationRef.current = requestAnimationFrame(animate)
            }
        }

        scanAnimationRef.current = requestAnimationFrame(animate)

        return () => {
            if (scanAnimationRef.current) {
                cancelAnimationFrame(scanAnimationRef.current)
            }
        }
    }, [isScanning, scanComplete, scannerBounds])

    // Update scanning line position (within the 40px box, not following cursor)
    React.useEffect(() => {
        if (!isScanning || scanComplete || !scanLineRef.current || !scannerBounds) return

        // Calculate center of the 40px box
        const boxCenterX = scannerBounds.centerX
        const boxCenterY = (scannerBounds.top + scannerBounds.bottom) / 2

        requestAnimationFrame(() => {
            if (scanLineRef.current) {
                scanLineRef.current.style.transform = `translate(${boxCenterX}px, ${scanLineY}px) translate(-50%, -50%)`
            }
        })
    }, [scanLineY, isScanning, scanComplete, scannerBounds])

    const handleScannerMouseEnter = (e: React.MouseEvent) => {
        if (scanComplete) return

        // Get scanner bounds - 16px x 24px activation area in the center
        const rect = e.currentTarget.getBoundingClientRect()
        const boxHeight = 24 // 24px height
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2

        setScannerBounds({
            top: centerY - boxHeight / 2,
            bottom: centerY + boxHeight / 2,
            centerX: centerX
        })

        setIsScanning(true)
        setScanPatterns(0)
        setCurrentDirection('down') // Start with down direction
        setScanLineY(centerY - boxHeight / 2)
        setLastY(centerY - boxHeight / 2)
    }


    const handleScannerMouseLeave = () => {
        if (scanComplete) return
        setIsScanning(false)
        setCurrentDirection(null)
        setLastY(null)
        setScannerBounds(null)
        if (scanAnimationRef.current) {
            cancelAnimationFrame(scanAnimationRef.current)
        }
    }

    return (
        <Box
            position="relative"
            minH="100vh"
            bg="#0A0A0A"
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
                                stroke="#6943FF"
                                strokeWidth="1"
                            />
                            {/* Right hexagon (offset down) */}
                            <polygon
                                points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                fill="none"
                                stroke="#6943FF"
                                strokeWidth="1"
                            />
                            {/* Top-right continuation for seamless tiling */}
                            <polygon
                                points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                fill="none"
                                stroke="#6943FF"
                                strokeWidth="1"
                            />
                        </pattern>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#hexagonPattern)" />
                </Box>
            </Box>

            {/* Rules Section - At the top */}
            {!scanComplete && (
                <VStack spacing={4} position="relative" zIndex={2} mb={8} maxW="800px" w="100%" px={4} mt={8}>
                    <Box
                        bg="#0A0A0A"
                        border="2px solid"
                        borderColor="#6943FF50"
                        borderRadius="md"
                        py={24}
                        px={6}
                        w="fit-content"
                        mx="auto"
                    >
                        <VStack spacing={8} align="stretch">
                            {/* Neon Sign */}
                            <VStack spacing={4} position="relative" zIndex={2} mb={{ base: 12, md: 24 }}>
                                <Box
                                    className="neonSignon"
                                    letterSpacing="wider"
                                    textAlign="center"
                                    display="flex"
                                    flexDirection={{ base: "column" }}
                                    justifyContent="center"
                                    alignItems="center"
                                    gap={{ base: 0, md: "0.2em" }}
                                    as="div"
                                >
                                    <b style={{ display: "flex" }}>
                                        <span>T</span>
                                        <span>H</span>
                                        <span>E</span>
                                        <span style={{ marginRight: '0.2em', width: '0.2em' }}> </span>
                                    </b>
                                    <b style={{ display: "flex" }}>
                                        <a>M</a>
                                        <span>E</span>
                                        <span>M</span>
                                        <a>B</a>
                                        <a>R</a>
                                        <span>A</span>
                                        <a>N</a>
                                        <span>E</span>
                                    </b>
                                </Box>
                            </VStack>

                            {/* TOS Text */}
                            <VStack spacing={1} align="stretch" position="relative" zIndex={2}>
                                <Text
                                    fontSize={{ base: "sm", md: "md" }}
                                    color="#F5F5F5"
                                    textAlign="left"
                                    lineHeight="1.8"
                                    fontFamily="mono"
                                    letterSpacing="0.08em"
                                    textShadow="0 0 8px rgba(59, 229, 229, 0.8), 0 0 15px rgba(105, 67, 255, 0.6)"
                                >
                                    I approach as a sovereign soul, claiming my own risks and severing foreign ties.
                                </Text>
                                <Text
                                    fontSize={{ base: "sm", md: "md" }}
                                    color="#F5F5F5"
                                    textAlign="left"
                                    lineHeight="1.8"
                                    fontFamily="mono"
                                    letterSpacing="0.08em"
                                    textShadow="0 0 8px rgba(59, 229, 229, 0.8), 0 0 15px rgba(105, 67, 255, 0.6)"
                                >
                                    I accept that every action I take becomes an immutable ripple through time.
                                </Text>
                                <Text
                                    fontSize={{ base: "sm", md: "md" }}
                                    color="#F5F5F5"
                                    textAlign="left"
                                    lineHeight="1.8"
                                    fontFamily="mono"
                                    letterSpacing="0.08em"
                                    textShadow="0 0 8px rgba(59, 229, 229, 0.8), 0 0 15px rgba(105, 67, 255, 0.6)"
                                >
                                    If I break this vow, the consequences fall solely upon me.
                                </Text>
                                <Text
                                    fontSize={{ base: "sm", md: "md" }}
                                    color="#F5F5F5"
                                    textAlign="left"
                                    lineHeight="1.8"
                                    fontFamily="mono"
                                    letterSpacing="0.08em"
                                    textShadow="0 0 8px rgba(59, 229, 229, 0.8), 0 0 15px rgba(105, 67, 255, 0.6)"
                                >
                                    My steps are my fingerprint.
                                </Text>
                                <Text
                                    fontSize={{ base: "sm", md: "md" }}
                                    color="#F5F5F5"
                                    textAlign="left"
                                    lineHeight="1.8"
                                    fontFamily="mono"
                                    letterSpacing="0.08em"
                                    textShadow="0 0 8px rgba(59, 229, 229, 0.8), 0 0 15px rgba(105, 67, 255, 0.6)"
                                >
                                    Once inside, there is no return.
                                </Text>
                                <Text
                                    fontSize={{ base: "sm", md: "md" }}
                                    color="#F5F5F5"
                                    textAlign="left"
                                    lineHeight="1.8"
                                    fontFamily="mono"
                                    letterSpacing="0.08em"
                                    textShadow="0 0 8px rgba(59, 229, 229, 0.8), 0 0 15px rgba(105, 67, 255, 0.6)"
                                >
                                    Within, we are the Membrane.
                                </Text>
                            </VStack>

                            {/* Scan Instructions */}
                            <VStack spacing={0} mt={6}>
                                <Text
                                    fontSize={{ base: "md", md: "lg" }}
                                    color="#3BE5E5"
                                    textAlign="center"
                                    letterSpacing="wider"
                                    fontWeight="bold"
                                    mb={2}
                                >
                                    Initiate Scan to Accept the{' '}
                                    <Text
                                        as="span"
                                        color="#3BE5E5"
                                        cursor="pointer"
                                        textDecoration="underline"
                                        _hover={{
                                            color: '#A692FF',
                                            textShadow: '0 0 10px #3BE5E5',
                                        }}
                                        onClick={onTOSOpen}
                                        transition="all 0.3s"
                                    >
                                        Terms
                                    </Text>
                                </Text>
                                <Text
                                    fontSize={{ base: "xs", md: "sm" }}
                                    color="#8A8A8A"
                                    fontStyle="italic"
                                    textAlign="end"
                                >
                                    Scan completion activates the Contract.
                                </Text>
                                <Text
                                    fontSize={{ base: "xs", md: "sm" }}
                                    color="#8A8A8A"
                                    fontStyle="italic"
                                    textAlign="end"
                                >
                                    Includes acceptance of essential, analytics, and functional cookies.
                                </Text>
                            </VStack>

                            {/* Cursor Scanner - Inside rules box */}
                            <Box
                                position="relative"
                                zIndex={3}
                                w="100%"
                                display="flex"
                                alignItems="center"
                                justifyContent="center"
                            // mt={4}
                            >
                                <Box
                                    position="relative"
                                    css={{
                                        animation: 'scannerGlow 2s ease-in-out infinite',
                                    }}
                                >
                                    <Image
                                        src="/images/cursor-scanner.svg"
                                        alt="Scanner"
                                        w="75px"
                                        h="75px"
                                        objectFit="contain"
                                        pointerEvents="none"
                                    />
                                </Box>
                                {/* 40px activation area in the center */}
                                <Box
                                    ref={scannerRef}
                                    position="absolute"
                                    w="16px"
                                    h="24px"
                                    cursor="pointer"
                                    onMouseEnter={handleScannerMouseEnter}
                                    onMouseLeave={handleScannerMouseLeave}
                                    left="50%"
                                    top="50%"
                                    transform="translate(-50%, -50%)"
                                />
                            </Box>
                        </VStack>
                    </Box>
                </VStack>
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
                            <a>M</a>
                            <span>E</span>
                            <span>M</span>
                            <a>B</a>
                            <a>R</a>
                            <span>A</span>
                            <a>N</a>
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
                        color="#8A8A8A"
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
                            bg="#0A0A0A"
                            border="2px solid"
                            borderColor="#3BE5E550"
                            color="#F5F5F5"
                            borderRadius="md"
                            px={4}
                            py={3}
                            _hover={{
                                borderColor: '#3BE5E5',
                            }}
                            _focus={{
                                borderColor: '#3BE5E5',
                                boxShadow: '0 0 10px #3BE5E5',
                                outline: 'none',
                            }}
                            _placeholder={{
                                color: '#8A8A8A',
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
                    bg="#3BE5E5"
                    pointerEvents="none"
                    zIndex={4}
                    willChange="transform"
                    style={{
                        animation: 'neonScanGlow 1s ease-in-out infinite',
                    }}
                />
            )}

            {/* Hexagonal Portal */}
            <Box
                position="relative"
                zIndex={2}
                opacity={scanComplete ? 1 : 0}
                transform={scanComplete ? 'scale(1)' : 'scale(0.3)'}
                transition="opacity 0.5s, transform 0.6s ease-out"
                style={{
                    transformOrigin: 'center center',
                }}
                onClick={scanComplete && username.trim() ? () => onEnter(username.trim()) : undefined}
                cursor={scanComplete && username.trim() ? 'pointer' : 'default'}
                role="group"
            >
                {/* Enter Label - Visible on hover */}
                {/* {scanComplete && username.trim() && (
                    <Text
                        position="absolute"
                        top="-40px"
                        left="50%"
                        transform="translateX(-50%)"
                        color="#3BE5E5"
                        fontSize="sm"
                        letterSpacing="widest"
                        opacity={0}
                        transition="opacity 0.3s"
                        _groupHover={{
                            opacity: 1,
                        }}
                        pointerEvents="none"
                        zIndex={11}
                    >
                        ENTER
                    </Text>
                )} */}
                {/* Hexagonal Portal Component */}
                <Box
                    position="relative"
                    w="256px"
                    h="256px"
                    mx="auto"
                >
                    {/* Rotating Portal Image - Clipped to Hex */}
                    <Box
                        position="absolute"
                        inset="0"
                        overflow="hidden"
                        style={{
                            clipPath: 'polygon(50% 0%, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)',
                        }}
                    >
                        <Box
                            position="absolute"
                            left="-25%"
                            top="-25%"
                            transform="translate(-50%, -50%)"
                            w="150%"
                            h="150%"
                            style={{
                                animation: 'portalSpin 20s linear infinite',
                                animationPlayState: username.trim() ? 'running' : 'paused',
                                transformOrigin: 'center center',
                            }}
                        >
                            <Image
                                src="/images/portal_within.svg"
                                alt="Portal"
                                w="100%"
                                h="100%"
                                objectFit="cover"
                            />
                        </Box>
                    </Box>

                    {/* Static Hexagonal Border with Gradient - SVG approach */}
                    <Box
                        as="svg"
                        position="absolute"
                        left="-2px"
                        top="-2px"
                        right="-2px"
                        bottom="-2px"
                        pointerEvents="none"
                        zIndex={10}
                        w="calc(100% + 4px)"
                        h="calc(100% + 4px)"
                        viewBox="-2 -2 258 258"
                        preserveAspectRatio="none"
                        overflow="visible"
                        transition="filter 0.3s"
                        _groupHover={username.trim() ? {
                            filter: 'drop-shadow(0 0 20px #3BE5E5) drop-shadow(0 0 30px #6943FF)',
                        } : {}}
                    >
                        <defs>
                            <linearGradient id="hexBorderGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stopColor="#3BE5E5" />
                                <stop offset="50%" stopColor="#6943FF" />
                                <stop offset="100%" stopColor="#A692FF" />
                            </linearGradient>
                        </defs>
                        <polygon
                            points="128,0 240,64 240,192 128,256 12,192 12,64"
                            fill="none"
                            stroke="url(#hexBorderGradient)"
                            strokeWidth="8"
                        />
                    </Box>
                </Box>
            </Box>

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
            <Modal isOpen={isTOSOpen} onClose={onTOSClose} size="xl" isCentered>
                <ModalOverlay bg="blackAlpha.800" />
                <ModalContent
                    bg="#0A0A0A"
                    border="2px solid"
                    borderColor="#6943FF"
                    borderRadius="md"
                    minW={{ base: "90%", md: "600px" }}
                    maxW="800px"
                    maxH="70vh"
                >
                    <ModalHeader
                        color="#A692FF"
                        fontSize={{ base: "xl", md: "2xl" }}
                        textShadow="0 0 20px #6943FF"
                        letterSpacing="wider"
                        borderBottom="1px solid"
                        borderColor="#6943FF50"
                        pb={4}
                    >
                        TERMS OF SERVICE
                    </ModalHeader>
                    <ModalCloseButton color="#8A8A8A" _hover={{ color: "#3BE5E5" }} />
                    <ModalBody
                        p={6}
                        overflowY="auto"
                        css={{
                            '&::-webkit-scrollbar': {
                                width: '8px',
                            },
                            '&::-webkit-scrollbar-track': {
                                background: '#0A0A0A',
                            },
                            '&::-webkit-scrollbar-thumb': {
                                background: '#6943FF',
                                borderRadius: '4px',
                            },
                            '&::-webkit-scrollbar-thumb:hover': {
                                background: '#3BE5E5',
                            },
                        }}
                    >
                        <VStack spacing={4} align="stretch">
                            {tosContent.split('\n').map((line, index) => {
                                const trimmed = line.trim();

                                if (trimmed.startsWith('# ')) {
                                    return (
                                        <React.Fragment key={index}>
                                            <Text
                                                as="h1"
                                                color="#A692FF"
                                                fontSize="1.5em"
                                                fontWeight="bold"
                                                mt={6}
                                                mb={2}
                                                textShadow="0 0 10px #6943FF"
                                            >
                                                {trimmed.substring(2)}
                                            </Text>
                                            <br />
                                        </React.Fragment>
                                    );
                                }

                                if (trimmed.startsWith('## ')) {
                                    return (
                                        <React.Fragment key={index}>
                                            <Text
                                                as="h2"
                                                color="#3BE5E5"
                                                fontSize="1.3em"
                                                fontWeight="bold"
                                                mt={5}
                                                mb={2}
                                                textShadow="0 0 8px #3BE5E5"
                                            >
                                                {trimmed.substring(3)}
                                            </Text>
                                            <br />
                                        </React.Fragment>
                                    );
                                }

                                if (trimmed === '---') {
                                    return (
                                        <React.Fragment key={index}>
                                            <Box
                                                borderTop="1px solid"
                                                borderColor="#6943FF50"
                                                my={6}
                                            />
                                            <br />
                                        </React.Fragment>
                                    );
                                }

                                if (trimmed.startsWith('- ') || /^\d+\. /.test(trimmed)) {
                                    const listItem = trimmed.replace(/^[-•]\s*/, '').replace(/^\d+\.\s*/, '');
                                    return (
                                        <React.Fragment key={index}>
                                            <Text
                                                as="li"
                                                ml={6}
                                                color="#F5F5F5"
                                            >
                                                {listItem.split(/\*\*(.+?)\*\*/g).map((part, i) =>
                                                    i % 2 === 1 ? (
                                                        <Text as="span" key={i} color="#3BE5E5" fontWeight="bold">
                                                            {part}
                                                        </Text>
                                                    ) : (
                                                        part
                                                    )
                                                )}
                                            </Text>
                                            <br />
                                        </React.Fragment>
                                    );
                                }

                                if (trimmed === '') {
                                    return (
                                        <React.Fragment key={index}>
                                            <Box h={2} />
                                            <br />
                                        </React.Fragment>
                                    );
                                }

                                return (
                                    <React.Fragment key={index}>
                                        <Text
                                            color="#F5F5F5"
                                            mb={2}
                                        >
                                            {trimmed.split(/\*\*(.+?)\*\*/g).map((part, i) =>
                                                i % 2 === 1 ? (
                                                    <Text as="span" key={i} color="#3BE5E5" fontWeight="bold">
                                                        {part}
                                                    </Text>
                                                ) : (
                                                    part
                                                )
                                            )}
                                        </Text>
                                        <br />
                                    </React.Fragment>
                                );
                            })}
                        </VStack>
                    </ModalBody>
                </ModalContent>
            </Modal>

            {/* Ambient Info */}
            <Box position="absolute" bottom={8} right={8} textAlign="right" zIndex={2}>
                <Text color="#8A8A8A" fontSize="xs" letterSpacing="widest">
                    OPEN 24/7
                </Text>
                <Text color="#3BE5E5" fontSize="xs" letterSpacing="widest">
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
//             bg="#0A0A0A"
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
//                                 stroke="#6943FF"
//                                 strokeWidth="1"
//                             />
//                             {/* Right hexagon (offset down) */}
//                             <polygon
//                                 points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
//                                 fill="none"
//                                 stroke="#6943FF"
//                                 strokeWidth="1"
//                             />
//                             {/* Top-right continuation for seamless tiling */}
//                             <polygon
//                                 points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
//                                 fill="none"
//                                 stroke="#6943FF"
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
//                         color="#A692FF"
//                         textShadow="0 0 20px #6943FF, 0 0 30px #6943FF"
//                         letterSpacing="wider"
//                         textAlign="center"
//                     >
//                         WELCOME TO THE MEMBRANE
//                     </Text>
//                     <Text color="#8A8A8A" letterSpacing="widest" fontSize="sm">
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
//                         bgGradient="linear(to-br, #6943FF20, #0A0A0A)"
//                         border="2px solid"
//                         borderColor="#6943FF"
//                         borderRadius="md"
//                         overflow="hidden"
//                         transition="all 0.3s"
//                         cursor="pointer"
//                         _hover={{
//                             borderColor: '#A692FF',
//                             boxShadow: '0 0 40px #6943FF',
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
//                                     color="#6943FF"
//                                     filter="drop-shadow(0 0 10px #6943FF)"
//                                     transition="color 0.3s"
//                                     _groupHover={{
//                                         color: '#A692FF',
//                                     }}
//                                 />
//                                 <Box
//                                     position="absolute"
//                                     top="-16px"
//                                     left="-16px"
//                                     right="-16px"
//                                     bottom="-16px"
//                                     border="2px solid"
//                                     borderColor="#3BE5E5"
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
//                             <Text color="#F5F5F5" fontSize="2xl" letterSpacing="wider">
//                                 RECEPTIONIST
//                             </Text>
//                             <Text color="#8A8A8A" fontSize="sm">
//                                 Learn about The Membrane
//                             </Text>
//                             <Box mt={4} h="4px" w="96px" mx="auto" bgGradient="linear(to-r, transparent, #3BE5E5, transparent)" />
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
//                             borderColor="#3BE5E5"
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
//                             borderColor="#3BE5E5"
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
//                         bgGradient="linear(to-br, #3BE5E520, #0A0A0A)"
//                         border="2px solid"
//                         borderColor="#3BE5E5"
//                         borderRadius="md"
//                         overflow="hidden"
//                         transition="all 0.3s"
//                         cursor="pointer"
//                         _hover={{
//                             borderColor: '#A692FF',
//                             boxShadow: '0 0 40px #3BE5E5',
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
//                                 borderColor="#3BE5E5"
//                                 borderRadius="md"
//                                 bg="#0A0A0A80"
//                                 display="flex"
//                                 alignItems="center"
//                                 justifyContent="center"
//                             >
//                                 <Icon
//                                     as={ArrowUp}
//                                     w={12}
//                                     h={12}
//                                     color="#3BE5E5"
//                                     filter="drop-shadow(0 0 10px #3BE5E5)"
//                                     transition="color 0.3s"
//                                     animation="bounce 1s infinite"
//                                     _groupHover={{
//                                         color: '#A692FF',
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
//                             <Text color="#F5F5F5" fontSize="2xl" letterSpacing="wider">
//                                 ELEVATOR
//                             </Text>
//                             <Text color="#8A8A8A" fontSize="sm">
//                                 Explore the levels
//                             </Text>
//                             <Box mt={4} h="4px" w="96px" mx="auto" bgGradient="linear(to-r, transparent, #6943FF, transparent)" />
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
//                             borderColor="#6943FF"
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
//                             borderColor="#6943FF"
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
//                     borderColor="#8A8A8A"
//                     color="#8A8A8A"
//                     bg="transparent"
//                     _hover={{
//                         borderColor: '#F5F5F5',
//                         color: '#F5F5F5',
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
            bg="#0A0A0A"
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
                                stroke="#6943FF"
                                strokeWidth="1"
                            />
                            {/* Right hexagon (offset down) */}
                            <polygon
                                points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                fill="none"
                                stroke="#6943FF"
                                strokeWidth="1"
                            />
                            {/* Top-right continuation for seamless tiling */}
                            <polygon
                                points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                fill="none"
                                stroke="#6943FF"
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
                        borderColor="#6943FF"
                        borderRadius="full"
                        boxShadow="0 0 30px #6943FF"
                    >
                        <Box
                            w="96px"
                            h="96px"
                            bgGradient="linear(to-br, #6943FF, #A692FF)"
                            borderRadius="full"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                        >
                            <Text color="#F5F5F5" fontSize="4xl">R</Text>
                        </Box>
                    </Box>
                    <Text
                        fontSize={{ base: '2xl', md: '4xl', lg: '6xl' }}
                        fontFamily="mono"
                        color="#A692FF"
                        textShadow="0 0 20px #6943FF"
                        letterSpacing="wider"
                        textAlign="center"
                    >
                        RECEPTIONIST
                    </Text>
                    <Text color="#8A8A8A" letterSpacing="widest">
                        NEURAL INTERFACE ACTIVE
                    </Text>
                </VStack>

                {/* Dialogue Box */}
                <Box
                    bgGradient="linear(to-br, #6943FF10, #0A0A0A)"
                    border="2px solid"
                    borderColor="#6943FF"
                    borderRadius="md"
                    p={8}
                    mb={8}
                    boxShadow="0 0 20px #6943FF20"
                >
                    <VStack spacing={6} align="stretch">
                        <HStack align="start" spacing={4}>
                            <Box
                                w="8px"
                                h="8px"
                                bg="#3BE5E5"
                                borderRadius="full"
                                mt={2}
                                animation="pulse 2s infinite"
                            />
                            <Text color="#F5F5F5" flex={1}>
                                Welcome to <Text as="span" color="#A692FF">The Membrane</Text>, where the boundaries between reality and the digital realm blur into something extraordinary.
                            </Text>
                        </HStack>

                        <HStack align="start" spacing={4}>
                            <Box
                                w="8px"
                                h="8px"
                                bg="#3BE5E5"
                                borderRadius="full"
                                mt={2}
                                animation="pulse 2s infinite"
                                style={{ animationDelay: '0.5s' }}
                            />
                            <Text color="#F5F5F5" flex={1}>
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
                        borderColor="#6943FF50"
                        borderRadius="md"
                        p={6}
                        bg="#0A0A0A80"
                        _hover={{ borderColor: '#3BE5E5' }}
                        transition="colors 0.3s"
                        flex={1}
                    >
                        <Text color="#3BE5E5" mb={4} fontSize="2xl">⚡</Text>
                        <Text color="#F5F5F5" mb={2} fontWeight="bold">
                            IMMERSIVE EXPERIENCE
                        </Text>
                        <Text color="#8A8A8A" fontSize="sm">
                            Cutting-edge neural technology creates unparalleled sensory journeys
                        </Text>
                    </Box>

                    <Box
                        border="1px solid"
                        borderColor="#6943FF50"
                        borderRadius="md"
                        p={6}
                        bg="#0A0A0A80"
                        _hover={{ borderColor: '#3BE5E5' }}
                        transition="colors 0.3s"
                        flex={1}
                    >
                        <Text color="#A692FF" mb={4} fontSize="2xl">🛡️</Text>
                        <Text color="#F5F5F5" mb={2} fontWeight="bold">
                            SECURE PROTOCOL
                        </Text>
                        <Text color="#8A8A8A" fontSize="sm">
                            Military-grade encryption protects your neural signature
                        </Text>
                    </Box>

                    <Box
                        border="1px solid"
                        borderColor="#6943FF50"
                        borderRadius="md"
                        p={6}
                        bg="#0A0A0A80"
                        _hover={{ borderColor: '#3BE5E5' }}
                        transition="colors 0.3s"
                        flex={1}
                    >
                        <Text color="#6943FF" mb={4} fontSize="2xl">🧠</Text>
                        <Text color="#F5F5F5" mb={2} fontWeight="bold">
                            MULTI-LEVEL ACCESS
                        </Text>
                        <Text color="#8A8A8A" fontSize="sm">
                            Explore different dimensions of consciousness across our levels
                        </Text>
                    </Box>
                </HStack>

                {/* Info Box */}
                <Box
                    borderLeft="4px solid"
                    borderColor="#3BE5E5"
                    bg="#3BE5E505"
                    borderRadius="md"
                    p={6}
                    mb={8}
                >
                    <Text color="#F5F5F5" mb={2}>
                        <Text as="span" color="#3BE5E5">STATUS:</Text> Currently operating at 99.7% neural sync capacity
                    </Text>
                    <Text color="#F5F5F5">
                        <Text as="span" color="#3BE5E5">LOCATION:</Text> Neural District 07, Sector Grid 42-A
                    </Text>
                </Box>

                {/* Navigation Buttons */}
                <HStack spacing={4} justify="center">
                    <Button
                        onClick={onBack}
                        px={8}
                        py={3}
                        border="2px solid"
                        borderColor="#6943FF"
                        color="#F5F5F5"
                        bg="transparent"
                        _hover={{
                            bg: '#6943FF20',
                            boxShadow: '0 0 20px #6943FF',
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
                        bgGradient="linear(to-r, #6943FF, #A692FF)"
                        color="#F5F5F5"
                        _hover={{
                            boxShadow: '0 0 30px #6943FF',
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
    const [currentFloor, setCurrentFloor] = useState(0)

    const handleLevelClick = (level: Level) => {
        if (level.status === 'unlocked') {
            if (level.route) {
                router.push(`/${chainName}/${level.route}`)
                return
            }
            setSelectedLevel(level.id)
            setCurrentFloor(level.id)
        }
    }

    return (
        <Box
            position="relative"
            minH="100vh"
            bg="#0A0A0A"
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
                                stroke="#6943FF"
                                strokeWidth="1"
                            />
                            {/* Right hexagon (offset down) */}
                            <polygon
                                points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                fill="none"
                                stroke="#6943FF"
                                strokeWidth="1"
                            />
                            {/* Top-right continuation for seamless tiling */}
                            <polygon
                                points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                fill="none"
                                stroke="#6943FF"
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
                        color="#3BE5E5"
                        textShadow="0 0 20px #3BE5E5, 0 0 40px #3BE5E5"
                        letterSpacing="wider"
                        textAlign="center"
                    >
                        ELEVATOR ACCESS
                    </Text>
                    <HStack spacing={2} color="#8A8A8A">
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
                    <Box flex={1} display="flex" flexDirection="column">
                        <Box
                            bgGradient="linear(to-br, #6943FF10, #0A0A0A)"
                            border="2px solid"
                            borderColor="#6943FF"
                            borderRadius="md"
                            p={6}
                            boxShadow="0 0 30px #6943FF30"
                            flex={1}
                            display="flex"
                            flexDirection="column"
                        >
                            <HStack justify="space-between" mb={6}>
                                <Text color="#F5F5F5" fontSize="xl" letterSpacing="wider">
                                    CONTROL PANEL
                                </Text>
                                {/* <Text color="#3BE5E5" fontSize="2xl" fontFamily="mono">
                                    {currentFloor}
                                </Text> */}
                            </HStack>

                            {/* Level Buttons */}
                            <VStack spacing={3}>
                                {levels.map((level) => (
                                    <Button
                                        key={level.id}
                                        onClick={() => handleLevelClick(level)}
                                        isDisabled={level.status === 'locked'}
                                        w="100%"
                                        p={4}
                                        border="2px solid"
                                        borderRadius="md"
                                        transition="all 0.3s"
                                        bg={
                                            selectedLevel === level.id
                                                ? `linear-gradient(to right, ${level.color}30, ${level.color}20)`
                                                : 'transparent'
                                        }
                                        borderColor={
                                            selectedLevel === level.id
                                                ? '#3BE5E5'
                                                : level.status === 'locked'
                                                    ? '#8A8A8A30'
                                                    : '#6943FF50'
                                        }
                                        opacity={level.status === 'locked' ? 0.5 : 1}
                                        cursor={level.status === 'locked' ? 'not-allowed' : 'pointer'}
                                        _hover={
                                            level.status === 'unlocked'
                                                ? {
                                                    borderColor: '#A692FF',
                                                    bg: '#6943FF10',
                                                }
                                                : {}
                                        }
                                        boxShadow={
                                            selectedLevel === level.id && level.status === 'unlocked'
                                                ? `0 0 20px ${level.color}`
                                                : 'none'
                                        }
                                    >
                                        <HStack justify="space-between" w="100%">
                                            <VStack align="start" spacing={1}>
                                                <HStack spacing={2}>
                                                    <Icon
                                                        as={level.status === 'unlocked' ? Unlock : Lock}
                                                        w={4}
                                                        h={4}
                                                        color={level.status === 'unlocked' ? level.color : '#8A8A8A'}
                                                    />
                                                    <Text
                                                        letterSpacing="wider"
                                                        color={level.status === 'unlocked' ? level.color : '#8A8A8A'}
                                                    >
                                                        {level.name}
                                                    </Text>
                                                </HStack>
                                                <Text color="#8A8A8A" fontSize="sm">
                                                    {level.description}
                                                </Text>
                                            </VStack>
                                            <Text
                                                fontSize="3xl"
                                                fontFamily="mono"
                                                color={level.status === 'unlocked' ? level.color : '#8A8A8A'}
                                            >
                                                {level.id}
                                            </Text>
                                        </HStack>
                                    </Button>
                                ))}
                            </VStack>
                        </Box>
                    </Box>

                    {/* Level Display */}
                    <Box flex={1} display="flex" flexDirection="column">
                        {selectedLevel ? (
                            <Box
                                bgGradient="linear(to-br, #3BE5E510, #0A0A0A)"
                                border="2px solid"
                                borderColor="#3BE5E5"
                                borderRadius="md"
                                p={8}
                                flex={1}
                                display="flex"
                                flexDirection="column"
                                boxShadow="0 0 30px #3BE5E530"
                            >
                                <VStack
                                    align="center"
                                    justify="center"
                                    flex={1}
                                    spacing={6}
                                    textAlign="center"
                                >
                                    {/* <Text
                                        fontSize="8xl"
                                        fontFamily="mono"
                                        color={levels[selectedLevel - 1].color}
                                        textShadow={`0 0 30px ${levels[selectedLevel - 1].color}`}
                                    >
                                        {selectedLevel}
                                    </Text> */}
                                    <Text
                                        fontSize="3xl"
                                        letterSpacing="wider"
                                        color={levels[selectedLevel - 1].color}
                                    >
                                        {levels[selectedLevel - 1].name}
                                    </Text>
                                    <Text color="#F5F5F5" maxW="md">
                                        {levels[selectedLevel - 1].description}
                                    </Text>

                                    {/* Level Visualization */}
                                    <VStack spacing={2} w="100%" maxW="xs">
                                        {[...Array(levels.length)].reverse().map((_, i) => {
                                            const levelIndex = levels.length - 1 - i
                                            const level = levels[levelIndex]
                                            return (
                                                <Box
                                                    key={i}
                                                    h="48px"
                                                    mb={2}
                                                    border="2px solid"
                                                    borderRadius="md"
                                                    transition="all 0.3s"
                                                    bg={
                                                        level.id === selectedLevel
                                                            ? 'linear-gradient(to right, #6943FF, #A692FF)'
                                                            : '#0A0A0A'
                                                    }
                                                    borderColor={
                                                        level.id === selectedLevel
                                                            ? '#3BE5E5'
                                                            : '#6943FF30'
                                                    }
                                                    boxShadow={
                                                        level.id === selectedLevel
                                                            ? '0 0 20px #6943FF'
                                                            : 'none'
                                                    }
                                                >
                                                    <HStack justify="space-between" h="100%" px={4}>
                                                        <Text color="#8A8A8A" fontSize="sm">
                                                            {level.name}
                                                        </Text>
                                                        {level.id === selectedLevel && (
                                                            <Box
                                                                w="8px"
                                                                h="8px"
                                                                bg="#3BE5E5"
                                                                borderRadius="full"
                                                                animation="pulse 2s infinite"
                                                            />
                                                        )}
                                                    </HStack>
                                                </Box>
                                            )
                                        })}
                                    </VStack>
                                </VStack>
                            </Box>
                        ) : (
                            <Box
                                border="2px solid"
                                borderColor="#6943FF30"
                                borderStyle="dashed"
                                borderRadius="md"
                                p={8}
                                flex={1}
                                display="flex"
                                alignItems="center"
                                justifyContent="center"
                            >
                                <VStack spacing={4}>
                                    <Text fontSize="6xl" opacity={0.2}>⟐</Text>
                                    <Text color="#8A8A8A">Select a level to begin</Text>
                                </VStack>
                            </Box>
                        )}
                    </Box>
                </HStack>

                {/* Navigation */}
                <HStack spacing={4} justify="center" mt={8}>
                    <Button
                        onClick={onBack}
                        px={8}
                        py={3}
                        border="2px solid"
                        borderColor="#8A8A8A"
                        color="#8A8A8A"
                        bg="transparent"
                        _hover={{
                            borderColor: '#F5F5F5',
                            color: '#F5F5F5',
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
                        borderColor="#6943FF"
                        color="#F5F5F5"
                        bg="transparent"
                        _hover={{
                            bg: '#6943FF20',
                            boxShadow: '0 0 20px #6943FF',
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

    // Check for query parameter to set initial view
    const initialView = (router.query.view as View) || 'storefront'
    const [currentView, setCurrentView] = useState<View>(initialView)

    // Update view when query parameter changes
    React.useEffect(() => {
        if (router.query.view) {
            setCurrentView(router.query.view as View)
        }
    }, [router.query.view])

    const { appState, setAppState } = useAppState()

    const handleEnter = (username: string) => {
        setAppState({ username })
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

