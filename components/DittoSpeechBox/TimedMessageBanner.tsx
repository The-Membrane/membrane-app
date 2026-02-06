import React from 'react'
import { Box, Text, IconButton, HStack } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { CloseIcon } from '@chakra-ui/icons'
import { motion, AnimatePresence } from 'framer-motion'

const MotionBox = motion(Box)

const pulseKeyframes = keyframes`
    0% { box-shadow: 0 0 0 0 rgba(105, 67, 255, 0.4); }
    70% { box-shadow: 0 0 0 6px rgba(105, 67, 255, 0); }
    100% { box-shadow: 0 0 0 0 rgba(105, 67, 255, 0); }
`

interface TimedMessageBannerProps {
    message: string | null
    isVisible: boolean
    onDismiss: () => void
}

export const TimedMessageBanner: React.FC<TimedMessageBannerProps> = ({
    message,
    isVisible,
    onDismiss,
}) => {
    if (!message || !isVisible) return null

    return (
        <AnimatePresence>
            {isVisible && message && (
                <MotionBox
                    initial={{ opacity: 0, y: -10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -10, scale: 0.95 }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                    position="absolute"
                    top={-12}
                    left="50%"
                    transform="translateX(-50%)"
                    bg="#23252B"
                    border="1px solid"
                    borderColor="#6943FF60"
                    borderRadius="full"
                    px={4}
                    py={2}
                    zIndex={10001}
                    maxW="280px"
                    boxShadow="0 4px 12px rgba(0,0,0,0.3), 0 0 20px rgba(105, 67, 255, 0.2)"
                    animation={`${pulseKeyframes} 2s infinite`}
                    _before={{
                        content: '""',
                        position: 'absolute',
                        bottom: '-6px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        width: 0,
                        height: 0,
                        borderLeft: '6px solid transparent',
                        borderRight: '6px solid transparent',
                        borderTop: '6px solid #23252B',
                    }}
                >
                    <HStack spacing={2} align="center">
                        <Text
                            fontSize="xs"
                            color="#F5F5F5"
                            fontWeight="medium"
                            whiteSpace="nowrap"
                            overflow="hidden"
                            textOverflow="ellipsis"
                        >
                            {message}
                        </Text>
                        <IconButton
                            aria-label="Dismiss"
                            icon={<CloseIcon boxSize={2} />}
                            size="xs"
                            variant="ghost"
                            color="#F5F5F580"
                            _hover={{ color: '#F5F5F5', bg: 'transparent' }}
                            onClick={onDismiss}
                            minW="auto"
                            h="auto"
                            p={1}
                        />
                    </HStack>
                </MotionBox>
            )}
        </AnimatePresence>
    )
}

/**
 * Inline version of the timed message for use within the speech box
 */
export const TimedMessageInline: React.FC<TimedMessageBannerProps> = ({
    message,
    isVisible,
    onDismiss,
}) => {
    if (!message || !isVisible) return null

    return (
        <AnimatePresence>
            {isVisible && message && (
                <MotionBox
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.3 }}
                    overflow="hidden"
                    mb={3}
                >
                    <Box
                        bg="linear-gradient(135deg, #6943FF20 0%, #3BE5E520 100%)"
                        border="1px solid"
                        borderColor="#6943FF40"
                        borderRadius="md"
                        p={3}
                    >
                        <HStack justify="space-between" align="flex-start">
                            <Text fontSize="sm" color="#F5F5F5" flex={1}>
                                {message}
                            </Text>
                            <IconButton
                                aria-label="Dismiss"
                                icon={<CloseIcon boxSize={2} />}
                                size="xs"
                                variant="ghost"
                                color="#F5F5F580"
                                _hover={{ color: '#F5F5F5', bg: 'transparent' }}
                                onClick={onDismiss}
                                minW="auto"
                                h="auto"
                                p={1}
                            />
                        </HStack>
                    </Box>
                </MotionBox>
            )}
        </AnimatePresence>
    )
}

