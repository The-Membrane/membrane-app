import React from 'react'
import { Box, HStack, Text, Icon, IconButton } from '@chakra-ui/react'
import { ChevronRightIcon } from '@chakra-ui/icons'
import { m } from 'framer-motion'
import { LucideIcon } from 'lucide-react'

const MotionBox = m(Box)

export interface StatusCardProps {
    /** Icon component to display */
    icon: LucideIcon
    /** Icon color */
    iconColor?: string
    /** Icon background color */
    iconBg?: string
    /** Main title text */
    title: string
    /** Subtitle or value text */
    subtitle: string
    /** Highlighted portion of subtitle (optional) */
    subtitleHighlight?: string
    /** Highlight color */
    highlightColor?: string
    /** Click handler - navigates or expands form */
    onClick?: () => void
    /** Whether the card is expandable (shows chevron) */
    showChevron?: boolean
    /** Whether this card is currently expanded */
    isExpanded?: boolean
    /** Children to render when expanded */
    children?: React.ReactNode
}

/**
 * StatusCard - A clickable card for Ditto's Status tab
 * 
 * Displays status information with an icon and optional action.
 * Can expand to show inline forms or navigate to a page.
 */
export const StatusCard: React.FC<StatusCardProps> = ({
    icon,
    iconColor = 'secondary.400',
    iconBg = 'transparent',
    title,
    subtitle,
    subtitleHighlight,
    highlightColor = 'secondary.400',
    onClick,
    showChevron = true,
    isExpanded = false,
    children,
}) => {
    return (
        <MotionBox
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
        >
            <Box
                bg="#1A1D26"
                border="1px solid"
                borderColor={isExpanded ? '#9bdc4f60' : '#9bdc4f20'}
                borderRadius="lg"
                overflow="hidden"
                transition="all 0.2s"
                _hover={{
                    borderColor: '#9bdc4f60',
                    bg: '#1E2130',
                }}
            >
                {/* Main card content */}
                <HStack
                    p={3}
                    justify="space-between"
                    align="center"
                    cursor={onClick ? 'pointer' : 'default'}
                    onClick={onClick}
                >
                    <HStack spacing={3} flex={1}>
                        {/* Icon container */}
                        <Box
                            w="36px"
                            h="36px"
                            borderRadius="full"
                            bg={iconBg}
                            border="1px solid"
                            borderColor={iconColor}
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                            flexShrink={0}
                        >
                            <Icon as={icon} w={4} h={4} color={iconColor} />
                        </Box>

                        {/* Text content */}
                        <Box flex={1}>
                            <Text
                                fontSize="sm"
                                fontWeight="semibold"
                                color="#ece6d8"
                                lineHeight="1.3"
                            >
                                {title}
                            </Text>
                            <Text fontSize="xs" color="#ece6d880" lineHeight="1.3">
                                {subtitleHighlight ? (
                                    <>
                                        {subtitle.split(subtitleHighlight)[0]}
                                        <Text as="span" color={highlightColor} fontWeight="medium">
                                            {subtitleHighlight}
                                        </Text>
                                        {subtitle.split(subtitleHighlight)[1]}
                                    </>
                                ) : (
                                    subtitle
                                )}
                            </Text>
                        </Box>
                    </HStack>

                    {/* Chevron */}
                    {showChevron && (
                        <Icon
                            as={ChevronRightIcon}
                            w={5}
                            h={5}
                            color="#ece6d840"
                            transform={isExpanded ? 'rotate(90deg)' : 'rotate(0deg)'}
                            transition="transform 0.2s"
                        />
                    )}
                </HStack>

                {/* Expanded content */}
                {isExpanded && children && (
                    <Box
                        borderTop="1px solid"
                        borderColor="#9bdc4f20"
                        p={3}
                        bg="#15171E"
                    >
                        {children}
                    </Box>
                )}
            </Box>
        </MotionBox>
    )
}

/**
 * ShortcutCard - A simpler card for navigation shortcuts
 */
export interface ShortcutCardProps {
    label: string
    highlightText?: string
    highlightColor?: string
    onClick?: () => void
}

export const ShortcutCard: React.FC<ShortcutCardProps> = ({
    label,
    highlightText,
    highlightColor = 'primary.400',
    onClick,
}) => {
    return (
        <MotionBox
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
        >
            <Box
                bg="#1A1D26"
                border="1px solid"
                borderColor="#9bdc4f20"
                borderRadius="lg"
                p={3}
                cursor="pointer"
                transition="all 0.2s"
                _hover={{
                    borderColor: '#9bdc4f60',
                    bg: '#1E2130',
                }}
                onClick={onClick}
            >
                <HStack justify="space-between" align="center">
                    <HStack spacing={2}>
                        <Text color="primary.400" fontSize="sm">→</Text>
                        <Text fontSize="sm" color="#ece6d8">
                            {highlightText ? (
                                <>
                                    {label.split(highlightText)[0]}
                                    <Text as="span" color={highlightColor} fontWeight="medium">
                                        {highlightText}
                                    </Text>
                                    {label.split(highlightText)[1]}
                                </>
                            ) : (
                                label
                            )}
                        </Text>
                    </HStack>
                    <Icon as={ChevronRightIcon} w={5} h={5} color="#ece6d840" />
                </HStack>
            </Box>
        </MotionBox>
    )
}

export default StatusCard









