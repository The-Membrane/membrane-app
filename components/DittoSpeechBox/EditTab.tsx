import React from 'react'
import { Box, Text, VStack } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface EditTabProps {
    onClick: () => void
    isPanelOpen: boolean
}

export const EditTab: React.FC<EditTabProps> = ({ onClick, isPanelOpen }) => {
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick()
        }
    }

    return (
        <Box
            position="absolute"
            right="-60px"
            top="15%"
            transform="translateY(-50%)"
            w="43px"
            h="88px"
            bg={SEMANTIC_COLORS.bgSecondary}
            borderRadius={0}
            borderTop="1px solid"
            borderBottom="1px solid"
            borderRight="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            cursor="pointer"
            display="flex"
            alignItems="center"
            justifyContent="center"
            zIndex={0}
            opacity={isPanelOpen ? 0 : 1}
            pointerEvents={isPanelOpen ? 'none' : 'auto'}
            transition={TRANSITIONS.colors}
            _hover={{
                bg: SEMANTIC_COLORS.bgTertiary,
                borderColor: SEMANTIC_COLORS.primary,
                color: SEMANTIC_COLORS.primary,
            }}
            _focus={FOCUS_STYLES.ring}
            _focusVisible={FOCUS_STYLES.ring}
            role="button"
            tabIndex={isPanelOpen ? -1 : 0}
            aria-label="Open edit panel"
            aria-expanded={isPanelOpen}
            onClick={onClick}
            onKeyDown={handleKeyDown}
        >
            <VStack spacing={SPACING.xs} transform="rotate(90deg)" transformOrigin="center center">
                <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    fontWeight={TYPOGRAPHY.semibold}
                    color={SEMANTIC_COLORS.textSecondary}
                    lineHeight="1"
                >
                    ✎
                </Text>
                <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    fontWeight={TYPOGRAPHY.bold}
                    letterSpacing="0.1em"
                    color={SEMANTIC_COLORS.textPrimary}
                    whiteSpace="nowrap"
                >
                    EDIT
                </Text>
            </VStack>
        </Box>
    )
}
