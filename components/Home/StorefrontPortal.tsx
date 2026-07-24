import { Box, Image } from '@chakra-ui/react'

interface StorefrontPortalProps {
    scanComplete: boolean
    username: string
    onEnter: (username: string) => void
}

// The hexagonal portal that fades/scales in after the scan completes and,
// once a username is entered, becomes the clickable "enter" target.
export const StorefrontPortal = ({ scanComplete, username, onEnter }: StorefrontPortalProps) => {
    return (
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
                        color="#46d39a"
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
                        filter: 'drop-shadow(0 0 20px #46d39a) drop-shadow(0 0 30px #9bdc4f)',
                    } : {}}
                >
                    <defs>
                        <linearGradient id="hexBorderGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="#46d39a" />
                            <stop offset="50%" stopColor="#9bdc4f" />
                            <stop offset="100%" stopColor="#9bdc4f" />
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
    )
}
