import React, { useEffect, useState } from 'react'
import { Box, Text, HStack, IconButton } from '@chakra-ui/react'
import { CloseIcon } from '@chakra-ui/icons'
import { m, AnimatePresence } from 'framer-motion'
import { DittoMessage, DittoSeverity } from './types/dittoContract'

// ============================================================================
// STYLING
// ============================================================================

const getSeverityStyles = (severity: DittoSeverity) => {
    switch (severity) {
        case 'danger':
            return {
                borderColor: '#FF6B6B',
                bg: 'rgba(255, 107, 107, 0.1)',
                iconColor: '#FF6B6B',
                glowColor: 'rgba(255, 107, 107, 0.2)',
            }
        case 'warn':
            return {
                borderColor: '#FFB86C',
                bg: 'rgba(255, 184, 108, 0.1)',
                iconColor: '#FFB86C',
                glowColor: 'rgba(255, 184, 108, 0.2)',
            }
        case 'info':
        default:
            return {
                borderColor: '#00D9FF',
                bg: 'rgba(0, 217, 255, 0.1)',
                iconColor: '#00D9FF',
                glowColor: 'rgba(0, 217, 255, 0.2)',
            }
    }
}

const getSeverityIcon = (severity: DittoSeverity) => {
    switch (severity) {
        case 'danger':
            return '⚠️'
        case 'warn':
            return '⚡'
        case 'info':
        default:
            return 'ℹ️'
    }
}

// ============================================================================
// COMPONENT
// ============================================================================

interface DittoToastProps {
    /** The message to display */
    message: DittoMessage | null
    
    /** Interpolated body text (if already processed) */
    interpolatedBody?: string
    
    /** Callback when toast is dismissed */
    onDismiss: () => void
    
    /** Callback when toast is clicked (to open Ditto) */
    onClick?: () => void
    
    /** Auto-dismiss duration in ms (0 to disable) */
    autoDismissMs?: number
    
    /** Whether to show the toast */
    isVisible?: boolean
}

export const DittoToast: React.FC<DittoToastProps> = ({
    message,
    interpolatedBody,
    onDismiss,
    onClick,
    autoDismissMs = 5000,
    isVisible = true,
}) => {
    const [isExiting, setIsExiting] = useState(false)

    // Auto-dismiss timer
    useEffect(() => {
        if (!message || autoDismissMs === 0) return

        const timer = setTimeout(() => {
            setIsExiting(true)
            setTimeout(onDismiss, 200) // Wait for exit animation
        }, autoDismissMs)

        return () => clearTimeout(timer)
    }, [message, autoDismissMs, onDismiss])

    // Reset exit state when message changes
    // react-doctor(no-reset-all-state-on-prop-change): kept — isExiting is a transient exit-animation flag set imperatively (auto-dismiss timer / dismiss click), so it can't be derived. Idiomatic `key={message?.id}` fix belongs on the parent but would change the inter-message exit animation (behavior-changing). Component is currently only re-exported, not rendered.
    useEffect(() => {
        setIsExiting(false)
    }, [message?.id])

    if (!message) return null

    const styles = getSeverityStyles(message.severity)
    const icon = getSeverityIcon(message.severity)
    const bodyText = interpolatedBody || message.body

    return (
        <AnimatePresence>
            {isVisible && !isExiting && (
                <m.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -10, scale: 0.95 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                >
                    <Box
                        position="relative"
                        bg={styles.bg}
                        border="1px solid"
                        borderColor={styles.borderColor}
                        borderRadius="lg"
                        px={3}
                        py={2}
                        maxW="280px"
                        boxShadow={`0 0 20px ${styles.glowColor}`}
                        cursor={onClick ? 'pointer' : 'default'}
                        onClick={onClick}
                        _hover={onClick ? {
                            boxShadow: `0 0 30px ${styles.glowColor}`,
                            transform: 'translateY(-1px)',
                        } : undefined}
                        transition="all 0.2s"
                    >
                        <HStack spacing={2} align="flex-start">
                            {/* Severity Icon */}
                            <Text fontSize="sm" flexShrink={0}>
                                {icon}
                            </Text>

                            {/* Message Body */}
                            <Box flex={1}>
                                {message.title && (
                                    <Text
                                        fontSize="xs"
                                        fontWeight="bold"
                                        color={styles.iconColor}
                                        mb={0.5}
                                    >
                                        {message.title}
                                    </Text>
                                )}
                                <Text
                                    fontSize="xs"
                                    color="#ece6d8"
                                    lineHeight="1.4"
                                    fontFamily="mono"
                                >
                                    {bodyText}
                                </Text>
                            </Box>

                            {/* Dismiss Button */}
                            <IconButton
                                aria-label="Dismiss"
                                icon={<CloseIcon boxSize={2} />}
                                size="xs"
                                variant="ghost"
                                color="#ece6d880"
                                _hover={{ color: '#ece6d8', bg: 'transparent' }}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    setIsExiting(true)
                                    setTimeout(onDismiss, 200)
                                }}
                                flexShrink={0}
                            />
                        </HStack>

                        {/* Progress bar for auto-dismiss */}
                        {autoDismissMs > 0 && (
                            <Box
                                position="absolute"
                                bottom={0}
                                left={0}
                                right={0}
                                h="2px"
                                overflow="hidden"
                                borderBottomRadius="lg"
                            >
                                <m.div
                                    initial={{ scaleX: 1 }}
                                    animate={{ scaleX: 0 }}
                                    transition={{ duration: autoDismissMs / 1000, ease: 'linear' }}
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                        backgroundColor: styles.borderColor,
                                        opacity: 0.5,
                                        transformOrigin: 'left',
                                    }}
                                />
                            </Box>
                        )}
                    </Box>
                </m.div>
            )}
        </AnimatePresence>
    )
}

// ============================================================================
// TOAST CONTAINER
// ============================================================================

interface DittoToastContainerProps {
    /** Position relative to Ditto hologram */
    position?: 'top' | 'bottom' | 'left' | 'right'
    
    /** The message to display */
    message: DittoMessage | null
    
    /** Interpolated body text */
    interpolatedBody?: string
    
    /** Dismiss handler */
    onDismiss: () => void
    
    /** Click handler */
    onClick?: () => void
    
    /** Auto-dismiss duration */
    autoDismissMs?: number
}

const positionStyles = {
    top: { bottom: '100%', left: '50%', transform: 'translateX(-50%)', mb: 2 },
    bottom: { top: '100%', left: '50%', transform: 'translateX(-50%)', mt: 2 },
    left: { right: '100%', top: '50%', transform: 'translateY(-50%)', mr: 2 },
    right: { left: '100%', top: '50%', transform: 'translateY(-50%)', ml: 2 },
}

export const DittoToastContainer: React.FC<DittoToastContainerProps> = ({
    position = 'top',
    message,
    interpolatedBody,
    onDismiss,
    onClick,
    autoDismissMs = 5000,
}) => {
    return (
        <Box
            position="absolute"
            zIndex={1000}
            {...positionStyles[position]}
        >
            <DittoToast
                message={message}
                interpolatedBody={interpolatedBody}
                onDismiss={onDismiss}
                onClick={onClick}
                autoDismissMs={autoDismissMs}
            />
        </Box>
    )
}

export default DittoToast

