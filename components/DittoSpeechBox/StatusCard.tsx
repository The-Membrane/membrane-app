import React from 'react'
import { Box, HStack, Text, Icon } from '@chakra-ui/react'
import { ChevronRightIcon } from '@chakra-ui/icons'
import { m } from 'framer-motion'
import { LucideIcon } from 'lucide-react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

const MotionBox = m(Box)

/** Fires a click handler from keyboard Enter/Space on a non-native clickable. */
const keyActivate =
    (handler?: () => void) => (e: React.KeyboardEvent<HTMLElement>) => {
        if (!handler) return
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handler()
        }
    }

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
    iconColor = SEMANTIC_COLORS.info,
    iconBg = 'transparent',
    title,
    subtitle,
    subtitleHighlight,
    highlightColor = SEMANTIC_COLORS.info,
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
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={isExpanded ? SEMANTIC_COLORS.borderStrong : SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                overflow="hidden"
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
            >
                {/* Main card content */}
                <HStack
                    p={SPACING.md}
                    justify="space-between"
                    align="center"
                    cursor={onClick ? 'pointer' : 'default'}
                    onClick={onClick}
                    onKeyDown={onClick ? keyActivate(onClick) : undefined}
                    role={onClick ? 'button' : undefined}
                    tabIndex={onClick ? 0 : undefined}
                    aria-expanded={onClick ? isExpanded : undefined}
                    transition={TRANSITIONS.colors}
                    _focus={onClick ? FOCUS_STYLES.ring : undefined}
                    _focusVisible={onClick ? FOCUS_STYLES.ring : undefined}
                >
                    <HStack spacing={SPACING.md} flex={1}>
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
                                fontFamily={TYPOGRAPHY.fontMono}
                                fontSize={TYPOGRAPHY.small}
                                fontWeight={TYPOGRAPHY.semibold}
                                color={SEMANTIC_COLORS.textPrimary}
                                lineHeight="1.3"
                            >
                                {title}
                            </Text>
                            <Text
                                fontFamily={TYPOGRAPHY.fontMono}
                                fontSize={TYPOGRAPHY.xs}
                                color={SEMANTIC_COLORS.textSecondary}
                                lineHeight="1.3"
                            >
                                {subtitleHighlight ? (
                                    <>
                                        {subtitle.split(subtitleHighlight)[0]}
                                        <Text
                                            as="span"
                                            color={highlightColor}
                                            fontWeight={TYPOGRAPHY.medium}
                                        >
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
                            color={SEMANTIC_COLORS.textTertiary}
                            transform={isExpanded ? 'rotate(90deg)' : 'rotate(0deg)'}
                            transition={TRANSITIONS.transformQuick}
                        />
                    )}
                </HStack>

                {/* Expanded content */}
                {isExpanded && children && (
                    <Box
                        borderTop="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        borderRadius={0}
                        p={SPACING.md}
                        bg={SEMANTIC_COLORS.bgTertiary}
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
    highlightColor = SEMANTIC_COLORS.primary,
    onClick,
}) => {
    return (
        <MotionBox
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
        >
            <Box
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                p={SPACING.md}
                cursor="pointer"
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _focus={FOCUS_STYLES.ring}
                _focusVisible={FOCUS_STYLES.ring}
                role="button"
                tabIndex={0}
                onClick={onClick}
                onKeyDown={keyActivate(onClick)}
            >
                <HStack justify="space-between" align="center">
                    <HStack spacing={SPACING.sm}>
                        <Text color={SEMANTIC_COLORS.primary} fontSize={TYPOGRAPHY.small}>
                            →
                        </Text>
                        <Text
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            color={SEMANTIC_COLORS.textPrimary}
                        >
                            {highlightText ? (
                                <>
                                    {label.split(highlightText)[0]}
                                    <Text
                                        as="span"
                                        color={highlightColor}
                                        fontWeight={TYPOGRAPHY.medium}
                                    >
                                        {highlightText}
                                    </Text>
                                    {label.split(highlightText)[1]}
                                </>
                            ) : (
                                label
                            )}
                        </Text>
                    </HStack>
                    <Icon
                        as={ChevronRightIcon}
                        w={5}
                        h={5}
                        color={SEMANTIC_COLORS.textTertiary}
                    />
                </HStack>
            </Box>
        </MotionBox>
    )
}

export default StatusCard









