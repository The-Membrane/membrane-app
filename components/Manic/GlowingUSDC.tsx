import React from 'react'
import { Box, VStack } from '@chakra-ui/react'
import { m } from 'framer-motion'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

// Living Typeface: this sits inside the Loop Capacity card (app chrome), not a
// hero, so the old bloom/drop-shadow treatment is gone. What remains is the part
// that carries data — the circular fill ring — drawn in phosphor/teal with a
// bone hairline track. `borderGlow` now toggles a hairline ring, not a bloom.
interface GlowingUSDCProps {
    fillRatio: number // 0 to 1
    isAnimating?: boolean
    borderColor?: string
    borderGlow?: boolean
}

export const GlowingUSDC: React.FC<GlowingUSDCProps> = ({
    fillRatio,
    isAnimating = false,
    borderColor = SEMANTIC_COLORS.info,
    borderGlow = true,
}) => {
    // Calculate sizes - fixed pixel values to fit in 20% width container
    const containerSize = '80px'
    const imageSize = '80px'
    const radius = 315
    const circumference = 2 * Math.PI * radius
    const borderWidthNum = 3

    return (
        <Box
            position="relative"
            width="100%"
            height="auto"
            minH="auto"
            display="flex"
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            mt={0}
            pt={0}
            pb={4}
        >
            <VStack spacing={3.5} mt={0} align="center">
                {/* Circular USDC Image with Animated Border */}
                <Box
                    position="relative"
                    width={containerSize}
                    height={containerSize}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                >
                    {/* Outer hairline ring (was a glow bloom) */}
                    {borderGlow && (
                        <Box
                            position="absolute"
                            width="100%"
                            height="100%"
                            borderRadius="50%"
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.borderSubtle}
                            pointerEvents="none"
                        />
                    )}

                    {/* SVG Circular Progress Border */}
                    <svg
                        width="100%"
                        height="100%"
                        viewBox="0 0 720 720"
                        preserveAspectRatio="xMidYMid meet"
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            transform: 'rotate(-90deg)',
                        }}
                    >
                        <defs>
                            <linearGradient id="borderGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stopColor={SEMANTIC_COLORS.primary} />
                                <stop offset="50%" stopColor={SEMANTIC_COLORS.info} />
                                <stop offset="100%" stopColor={SEMANTIC_COLORS.primary} />
                            </linearGradient>
                        </defs>
                        {/* Background circle — bone hairline track */}
                        <circle
                            cx="360"
                            cy="360"
                            r={radius}
                            fill="none"
                            stroke={SEMANTIC_COLORS.borderStrong}
                            strokeWidth={borderWidthNum}
                        />
                        {/* Animated progress circle */}
                        <m.circle
                            cx="360"
                            cy="360"
                            r={radius}
                            fill="none"
                            stroke="url(#borderGradient)"
                            strokeWidth={borderWidthNum}
                            strokeLinecap="round"
                            strokeDasharray={circumference}
                            initial={{ strokeDashoffset: circumference }}
                            animate={{
                                strokeDashoffset: circumference * (1 - fillRatio)
                            }}
                            transition={{
                                duration: 0.5,
                                ease: "easeOut"
                            }}
                        />
                    </svg>

                    {/* Cycling glow effect - separate rotating SVG */}
                    {isAnimating && (
                        <m.div
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '100%',
                                transform: 'rotate(-90deg)',
                                transformOrigin: 'center center',
                            }}
                            animate={{
                                rotate: [-90, 270],
                            }}
                            transition={{
                                duration: 2.5,
                                repeat: Infinity,
                                ease: "linear",
                                repeatType: "loop"
                            }}
                        >
                            <svg
                                width="100%"
                                height="100%"
                                viewBox="0 0 720 720"
                                preserveAspectRatio="xMidYMid meet"
                            >
                                <defs>
                                    <linearGradient id="cyclingGlowGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                                        <stop offset="0%" stopColor="transparent" stopOpacity="0" />
                                        <stop offset="15%" stopColor={borderColor} stopOpacity="0.2" />
                                        <stop offset="25%" stopColor={borderColor} stopOpacity="1" />
                                        <stop offset="35%" stopColor={borderColor} stopOpacity="1" />
                                        <stop offset="45%" stopColor={borderColor} stopOpacity="0.2" />
                                        <stop offset="100%" stopColor="transparent" stopOpacity="0" />
                                    </linearGradient>
                                </defs>
                                <circle
                                    cx="360"
                                    cy="360"
                                    r={radius}
                                    fill="none"
                                    stroke="url(#cyclingGlowGradient)"
                                    strokeWidth={borderWidthNum + 10}
                                    strokeLinecap="round"
                                    strokeDasharray={`${circumference * 0.3} ${circumference * 0.7}`}
                                    style={{ opacity: 1 }}
                                />
                            </svg>
                        </m.div>
                    )}

                    {/* USDC Image */}
                    <Box
                        position="relative"
                        width={imageSize}
                        height={imageSize}
                        borderRadius="50%"
                        overflow="hidden"
                        bg={SEMANTIC_COLORS.bgTertiary}
                        border="6px solid"
                        borderColor={SEMANTIC_COLORS.bgTertiary}
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        pointerEvents="none"
                        zIndex={1}
                    >
                        <Box
                            width="80%"
                            height="80%"
                            backgroundImage="url(/images/sharp_usdc.png)"
                            backgroundSize="contain"
                            backgroundRepeat="no-repeat"
                            backgroundPosition="center"
                            pointerEvents="none"
                            style={{
                                imageRendering: '-webkit-optimize-contrast',
                                shapeRendering: 'geometricPrecision',
                                textRendering: 'geometricPrecision',
                                backfaceVisibility: 'hidden',
                                transform: 'translateZ(0)',
                                WebkitFontSmoothing: 'antialiased',
                            }}
                        />
                    </Box>
                </Box>
            </VStack>
        </Box>
    )
}
