import React from 'react'
import { VStack, Box, Text, HStack, IconButton, Button, Icon } from '@chakra-ui/react'
import { ChevronLeftIcon, CloseIcon, QuestionIcon } from '@chakra-ui/icons'
import { BookOpen, HelpCircle } from 'lucide-react'
import { useDittoSpeechBox } from './hooks/useDittoSpeechBox'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface DittoSpeechBoxSectionProps {
    title: string
    onBack: () => void
    onClose?: () => void
    children: React.ReactNode
    titleColor?: string
    showTutorialButton?: boolean
    onTutorialClick?: () => void
    onFAQClick?: () => void
}

export const DittoSpeechBoxSection: React.FC<DittoSpeechBoxSectionProps> = ({
    title,
    onBack,
    onClose,
    children,
    titleColor = SEMANTIC_COLORS.textPrimary,
    showTutorialButton = false,
    onTutorialClick,
    onFAQClick,
}) => {
    // const { currentView } = useDittoSpeechBox()

    return (
        <Box position="relative" w="100%" flex={1} overflow="hidden" display="flex" flexDirection="column">
            <VStack spacing={SPACING.md} align="stretch" w="100%" position="relative" zIndex={5} bg="transparent" flex={1} overflow="hidden" minH={0}>
                {/* Header with Back, Title, and Close - always visible */}
                <Box w="100%" flexShrink={0} position="relative" zIndex={5}>
                    <HStack justify="space-between" align="center" mb={SPACING.sm} w="100%" minH="40px" spacing={SPACING.sm}>
                        <Button
                            size="xs"
                            variant="ghost"
                            leftIcon={<ChevronLeftIcon />}
                            onClick={onBack}
                            color={SEMANTIC_COLORS.textPrimary}
                            borderRadius={0}
                            transition={TRANSITIONS.colors}
                            _hover={HOVER_EFFECTS.brighten}
                            _active={ACTIVE_EFFECTS.dim}
                            _focus={FOCUS_STYLES.ring}
                            _focusVisible={FOCUS_STYLES.ring}
                            flexShrink={0}
                            minW="60px"
                            width="20%"
                        >
                            {/* Back */}
                        </Button>
                        {/* Full title with border */}
                        {title === "Boost Breakdown" ? (
                            <Box
                                flex={1}
                                display="flex"
                                justifyContent="center"
                                alignItems="center"
                                transform="translate(-3%, 0%)"
                                position="relative"
                                zIndex={1}
                            >
                                <Box
                                    border="1px solid"
                                    borderColor={SEMANTIC_COLORS.borderStrong}
                                    borderRadius={0}
                                    display="inline-block"
                                >
                                    <VStack
                                        spacing={SPACING.none}
                                        align="center"
                                        justify="center"
                                        bg={SEMANTIC_COLORS.bgTertiary}
                                        borderRadius={0}
                                        px={SPACING.md}
                                        py={SPACING.xs}
                                    >
                                        <Text
                                            fontFamily={TYPOGRAPHY.fontDisplay}
                                            fontSize={TYPOGRAPHY.h3}
                                            fontWeight={TYPOGRAPHY.semibold}
                                            color={SEMANTIC_COLORS.textPrimary}
                                            lineHeight="1.2"
                                        >
                                            Boost
                                        </Text>
                                        <Text
                                            fontFamily={TYPOGRAPHY.fontDisplay}
                                            fontSize={TYPOGRAPHY.h3}
                                            fontWeight={TYPOGRAPHY.semibold}
                                            color={SEMANTIC_COLORS.textPrimary}
                                            lineHeight="1.2"
                                        >
                                            Breakdown
                                        </Text>
                                    </VStack>
                                </Box>
                            </Box>
                        ) : (
                            <Box
                                flex={1}
                                display="flex"
                                justifyContent="center"
                                alignItems="center"
                                transform={title === "Acquisition" ? "translate(0, 0%)" : "translate(-3%, 0%)"}
                                position="relative"
                                zIndex={1}
                            >
                                <Box
                                    border="1px solid"
                                    borderColor={SEMANTIC_COLORS.borderStrong}
                                    borderRadius={0}
                                    display="inline-block"
                                >
                                    <Text
                                        fontFamily={TYPOGRAPHY.fontDisplay}
                                        fontSize={TYPOGRAPHY.h3}
                                        fontWeight={TYPOGRAPHY.semibold}
                                        color={titleColor}
                                        textAlign="center"
                                        px={SPACING.md}
                                        py={SPACING.xs}
                                        bg={SEMANTIC_COLORS.bgTertiary}
                                        borderRadius={0}
                                        noOfLines={title === "Acquisition" ? undefined : 1}
                                    >
                                        {title}
                                    </Text>
                                </Box>
                            </Box>
                        )}
                        <HStack spacing={SPACING.sm} flexShrink={0} minW="auto" justify="flex-end">
                            {showTutorialButton && onTutorialClick && (
                                <IconButton
                                    aria-label="Tutorial"
                                    icon={<Icon as={BookOpen} w={4} h={4} />}
                                    size="sm"
                                    variant="ghost"
                                    color={SEMANTIC_COLORS.textPrimary}
                                    onClick={onTutorialClick}
                                    transition={TRANSITIONS.colors}
                                    _hover={{ bg: 'transparent', color: SEMANTIC_COLORS.primary }}
                                    _active={ACTIVE_EFFECTS.dim}
                                    _focus={FOCUS_STYLES.ring}
                                    _focusVisible={FOCUS_STYLES.ring}
                                    title="Tutorial"
                                    borderRadius={0}
                                />
                            )}
                            {onFAQClick && (
                                <IconButton
                                    aria-label="FAQ"
                                    icon={<Icon as={HelpCircle} w={4} h={4} />}
                                    size="sm"
                                    variant="ghost"
                                    color={SEMANTIC_COLORS.textPrimary}
                                    onClick={onFAQClick}
                                    transition={TRANSITIONS.colors}
                                    _hover={{ bg: 'transparent', color: SEMANTIC_COLORS.primary }}
                                    _active={ACTIVE_EFFECTS.dim}
                                    _focus={FOCUS_STYLES.ring}
                                    _focusVisible={FOCUS_STYLES.ring}
                                    title="FAQ"
                                    borderRadius={0}
                                />
                            )}
                            <IconButton
                                aria-label="Close"
                                icon={<CloseIcon />}
                                size="sm"
                                variant="ghost"
                                color={SEMANTIC_COLORS.textPrimary}
                                onClick={onClose || (() => { })}
                                transition={TRANSITIONS.colors}
                                _hover={{ bg: 'transparent', color: SEMANTIC_COLORS.primary }}
                                _active={ACTIVE_EFFECTS.dim}
                                _focus={FOCUS_STYLES.ring}
                                _focusVisible={FOCUS_STYLES.ring}
                                borderRadius={0}
                            />
                        </HStack>
                    </HStack>
                </Box>
                {/* Content - scrollable when over max height */}
                <Box
                    w="100%"
                    flex={1}
                    minH={0}
                    overflowY="auto"
                    overflowX="hidden"
                    position="relative"
                    zIndex={5}
                    sx={{
                        '&::-webkit-scrollbar': {
                            width: '6px',
                        },
                        '&::-webkit-scrollbar-track': {
                            background: SEMANTIC_COLORS.bgPrimary,
                            borderRadius: 0,
                        },
                        '&::-webkit-scrollbar-thumb': {
                            background: SEMANTIC_COLORS.borderStrong,
                            borderRadius: 0,
                        },
                        '&::-webkit-scrollbar-thumb:hover': {
                            background: SEMANTIC_COLORS.primary,
                        },
                    }}
                >
                    {children}
                </Box>
            </VStack>
        </Box>
    )
}

