import React, { forwardRef, ReactNode, useCallback } from 'react'
import { Box, VStack, HStack, Text, Image } from '@chakra-ui/react'

export interface ShareableCardProps {
    children: ReactNode
    title?: string
    subtitle?: string
    showWatermark?: boolean
    cardRef?: React.RefObject<HTMLDivElement>
}

/**
 * Base shareable card component with consistent styling
 * Dimensions optimized for social media: 1200x630px at 2x scale
 */
export const ShareableCard = forwardRef<HTMLDivElement, ShareableCardProps>(
    ({ children, title, subtitle, showWatermark = true, cardRef }, ref) => {
        // Handle both forwarded ref and cardRef prop
        const setRef = useCallback((node: HTMLDivElement | null) => {
            if (cardRef) {
                (cardRef as React.MutableRefObject<HTMLDivElement | null>).current = node
            }
            if (typeof ref === 'function') {
                ref(node)
            } else if (ref) {
                (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
            }
        }, [cardRef, ref])

        return (
            <Box
                ref={setRef}
                data-card-element="true"
                w="600px"
                h="315px"
                bg="#1a1a2e"
                position="relative"
                overflow="visible"
                borderRadius="xl"
                p={6}
                boxSizing="border-box"
                sx={{
                    border: '2px solid transparent',
                    backgroundImage: 'linear-gradient(#1a1a2e, #1a1a2e), linear-gradient(135deg, #8A2BE2 0%, #6FFFC2 100%)',
                    backgroundOrigin: 'border-box',
                    backgroundClip: 'padding-box, border-box',
                }}
                _before={{
                    content: '""',
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'linear-gradient(135deg, rgba(138, 43, 226, 0.15) 0%, rgba(111, 255, 194, 0.1) 100%)',
                    pointerEvents: 'none',
                }}
                _after={{
                    content: '""',
                    position: 'absolute',
                    top: '-50%',
                    right: '-20%',
                    width: '60%',
                    height: '100%',
                    background: 'radial-gradient(circle, rgba(111, 255, 194, 0.1) 0%, transparent 70%)',
                    pointerEvents: 'none',
                }}
            >
                <VStack spacing={4} align="stretch" h="100%" position="relative" zIndex={2} boxSizing="border-box">
                    {/* Header */}
                    {(title || subtitle) && (
                        <Box position="relative" zIndex={2}>
                            {title && (
                                <Text
                                    fontSize="xs"
                                    color="gray.400"
                                    fontFamily="mono"
                                    textTransform="uppercase"
                                    letterSpacing="widest"
                                    mb={1}
                                >
                                    {title}
                                </Text>
                            )}
                            {subtitle && (
                                <Text
                                    fontSize="2xl"
                                    fontWeight="bold"
                                    color="white"
                                    fontFamily="mono"
                                    lineHeight="1.2"
                                    wordBreak="break-word"
                                >
                                    {subtitle}
                                </Text>
                            )}
                        </Box>
                    )}

                    {/* Content */}
                    <Box flex={1} position="relative" zIndex={2} minH="0">
                        {children}
                    </Box>

                    {/* Logo in top right */}
                    {showWatermark && (
                        <Box
                            position="absolute"
                            top={"-14px"}
                            right={"-12px"}
                            zIndex={10}
                            opacity={0.9}
                        >
                            <Image
                                src="/images/Logo_with_both_images.svg"
                                alt="Membrane"
                                maxH="60px"
                                maxW="120px"
                                fallback={
                                    <Box
                                        w="120px"
                                        h="60px"
                                        bg="purple.500"
                                        borderRadius="md"
                                        display="flex"
                                        alignItems="center"
                                        justifyContent="center"
                                    >
                                        <Text fontSize="xs" color="white" fontFamily="mono">
                                            MBRN
                                        </Text>
                                    </Box>
                                }
                            />
                        </Box>
                    )}
                </VStack>
            </Box>
        )
    }
)

ShareableCard.displayName = 'ShareableCard'

export default ShareableCard


