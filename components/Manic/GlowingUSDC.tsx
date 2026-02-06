import React from 'react'
import { Box, VStack } from '@chakra-ui/react'
import { motion } from 'framer-motion'

interface GlowingUSDCProps {
    fillRatio: number // 0 to 1
    isAnimating?: boolean
    borderColor?: string
    borderGlow?: boolean
}

export const GlowingUSDC: React.FC<GlowingUSDCProps> = ({
    fillRatio,
    isAnimating = false,
    borderColor = "#00BFFF",
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
                    {/* Outer glow ring */}
                    {borderGlow && (
                        <motion.div
                            animate={{
                                boxShadow: isAnimating
                                    ? `0 0 120px ${borderColor}, 0 0 240px ${borderColor}`
                                    : `0 0 60px ${borderColor}`
                            }}
                            transition={{ duration: 0.3 }}
                            style={{
                                position: 'absolute',
                                width: '100%',
                                height: '100%',
                                borderRadius: '50%',
                                pointerEvents: 'none',
                            }}
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
                                <stop offset="0%" stopColor="#00BFFF" />
                                <stop offset="50%" stopColor="#3182CE" />
                                <stop offset="100%" stopColor="#00BFFF" />
                            </linearGradient>

                            <filter id="glow">
                                <feGaussianBlur stdDeviation="12" result="coloredBlur" />
                                <feMerge>
                                    <feMergeNode in="coloredBlur" />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>
                        </defs>
                        {/* Background circle */}
                        <circle
                            cx="360"
                            cy="360"
                            r={radius}
                            fill="none"
                            stroke="rgba(113, 128, 150, 0.2)"
                            strokeWidth={borderWidthNum}
                        />
                        {/* Animated progress circle */}
                        <motion.circle
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
                        <motion.div
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
                                    style={{
                                        filter: `drop-shadow(0 0 60px ${borderColor})`,
                                        opacity: 1
                                    }}
                                />
                            </svg>
                        </motion.div>
                    )}

                    {/* USDC Image */}
                    <Box
                        position="relative"
                        width={imageSize}
                        height={imageSize}
                        borderRadius="50%"
                        overflow="hidden"
                        bg="gray.800"
                        border="6px solid"
                        borderColor="gray.700"
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
                            filter={isAnimating ? 'brightness(1.2)' : 'brightness(1)'}
                            transition="filter 0.3s"
                            pointerEvents="none"
                            style={{
                                imageRendering: '-webkit-optimize-contrast',
                                shapeRendering: 'geometricPrecision',
                                textRendering: 'geometricPrecision',
                                backfaceVisibility: 'hidden',
                                transform: 'translateZ(0)',
                                WebkitFontSmoothing: 'antialiased',
                                willChange: 'auto',
                            }}
                        />
                    </Box>
                </Box>
            </VStack>
        </Box>
    )
}
