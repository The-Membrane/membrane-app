import React from 'react'
import { Box, Text, IconButton, HStack } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { CloseIcon } from '@chakra-ui/icons'
import { m, AnimatePresence } from 'framer-motion'

const MotionBox = m(Box)

const pulseKeyframes = keyframes`
    0% { box-shadow: 0 0 0 0 rgba(155, 220, 79, 0.4); }
    70% { box-shadow: 0 0 0 6px rgba(155, 220, 79, 0); }
    100% { box-shadow: 0 0 0 0 rgba(155, 220, 79, 0); }
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
                    borderColor="#9bdc4f60"
                    borderRadius="full"
                    px={4}
                    py={2}
                    zIndex={10001}
                    maxW="280px"
                    boxShadow="0 4px 12px rgba(0,0,0,0.3), 0 0 20px rgba(155, 220, 79, 0.2)"
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
                            color="#ece6d8"
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
                            color="#ece6d880"
                            _hover={{ color: '#ece6d8', bg: 'transparent' }}
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
                    // Auto-height reveal: a scaleY transform would squash the text, so
                    // animate grid-template-rows 0fr→1fr instead. The grid row (not the
                    // box height) drives the reveal, so the box never triggers per-frame
                    // layout while the content clips rather than distorting (react.doctor
                    // Case C recipe for unknown-size reveals).
                    initial={{ opacity: 0, gridTemplateRows: '0fr' }}
                    animate={{ opacity: 1, gridTemplateRows: '1fr' }}
                    exit={{ opacity: 0, gridTemplateRows: '0fr' }}
                    transition={{ duration: 0.3 }}
                    display="grid"
                    overflow="hidden"
                    mb={3}
                >
                    <Box minH={0} overflow="hidden">
                    <Box
                        bg="linear-gradient(135deg, #9bdc4f20 0%, #46d39a20 100%)"
                        border="1px solid"
                        borderColor="#9bdc4f40"
                        borderRadius="md"
                        p={3}
                    >
                        <HStack justify="space-between" align="flex-start">
                            <Text fontSize="sm" color="#ece6d8" flex={1}>
                                {message}
                            </Text>
                            <IconButton
                                aria-label="Dismiss"
                                icon={<CloseIcon boxSize={2} />}
                                size="xs"
                                variant="ghost"
                                color="#ece6d880"
                                _hover={{ color: '#ece6d8', bg: 'transparent' }}
                                onClick={onDismiss}
                                minW="auto"
                                h="auto"
                                p={1}
                            />
                        </HStack>
                    </Box>
                    </Box>
                </MotionBox>
            )}
        </AnimatePresence>
    )
}

