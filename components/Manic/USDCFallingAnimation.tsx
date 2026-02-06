import React from 'react'
import { Box, Image } from '@chakra-ui/react'
import { motion, AnimatePresence } from 'framer-motion'

interface USDCFallingAnimationProps {
    isAnimating: boolean
    onAnimationComplete?: () => void
}

export const USDCFallingAnimation: React.FC<USDCFallingAnimationProps> = ({
    isAnimating,
    onAnimationComplete
}) => {
    return (
        <AnimatePresence>
            {isAnimating && (
                <Box
                    position="absolute"
                    top="0"
                    left="0"
                    width="100%"
                    height="100%"
                    pointerEvents="none"
                    zIndex={10}
                >
                    {/* Falling USDC token */}
                    <motion.div
                        initial={{
                            x: '50%',
                            y: '60%',
                            scale: 0.5,
                            opacity: 1,
                            rotate: 0
                        }}
                        animate={{
                            x: '50%',
                            y: '120%',
                            scale: 1.2,
                            opacity: 0,
                            rotate: 720
                        }}
                        exit={{
                            opacity: 0
                        }}
                        transition={{
                            duration: 1.5,
                            ease: [0.16, 1, 0.3, 1],
                            rotate: {
                                duration: 1.5,
                                ease: 'linear'
                            }
                        }}
                        onAnimationComplete={onAnimationComplete}
                        style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            transform: 'translate(-50%, -50%)',
                            width: '60px',
                            height: '60px'
                        }}
                    >
                        <Image
                            src="/images/usdc.png"
                            alt="USDC Falling"
                            width="100%"
                            height="100%"
                            filter="drop-shadow(0 0 10px rgba(0, 191, 255, 0.8))"
                        />
                    </motion.div>

                    {/* Glow effect */}
                    <motion.div
                        initial={{
                            x: '50%',
                            y: '60%',
                            scale: 0.5,
                            opacity: 0.8
                        }}
                        animate={{
                            x: '50%',
                            y: '120%',
                            scale: 2,
                            opacity: 0
                        }}
                        transition={{
                            duration: 1.5,
                            ease: [0.16, 1, 0.3, 1]
                        }}
                        style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            transform: 'translate(-50%, -50%)',
                            width: '60px',
                            height: '60px',
                            borderRadius: '50%',
                            background: 'radial-gradient(circle, rgba(0, 191, 255, 0.6) 0%, rgba(0, 191, 255, 0) 70%)',
                            filter: 'blur(10px)'
                        }}
                    />
                </Box>
            )}
        </AnimatePresence>
    )
}

