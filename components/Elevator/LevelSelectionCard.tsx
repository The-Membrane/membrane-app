import React from 'react'
import { Box, Button, Text, VStack, HStack } from '@chakra-ui/react'
import { Level } from '@/components/Home/CyberpunkHome'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SPACING } from '@/config/spacing'

interface LevelSelectionCardProps {
    level: Level | null
    onEnter: (level: Level) => void
}

export const LevelSelectionCard: React.FC<LevelSelectionCardProps> = ({ level, onEnter }) => {
    if (!level) {
        return (
            <Card
                variant="default"
                borderRadius={0}
                bg="transparent"
                border="1px dashed"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                p={SPACING.xl}
                flex={1}
                display="flex"
                alignItems="center"
                justifyContent="center"
            >
                <VStack spacing={4}>
                    <Text fontSize="6xl" opacity={0.2}>⟐</Text>
                    <Text color={SEMANTIC_COLORS.textSecondary}>Select a level to begin</Text>
                </VStack>
            </Card>
        )
    }

    return (
        <Card
            variant="default"
            borderRadius={0}
            bg={SEMANTIC_COLORS.bgSecondary}
            border="1px solid"
            borderColor={level.color}
            p={SPACING.xl}
            flex={1}
            display="flex"
            flexDirection="column"
        >
            <VStack align="stretch" spacing={6} flex={1}>
                {/* Title Section */}
                <VStack align="start" spacing={2}>
                    <Text
                        fontSize="4xl"
                        letterSpacing="wider"
                        color={level.color}
                        fontWeight="bold"
                    >
                        {level.name}
                    </Text>
                    {level.subtitle && (
                        <Text
                            fontSize="sm"
                            color={SEMANTIC_COLORS.textSecondary}
                            letterSpacing="wide"
                        >
                            {level.subtitle}
                        </Text>
                    )}
                </VStack>

                {/* Description */}
                <Box
                    borderLeft="3px solid"
                    borderColor={level.color}
                    pl={4}
                    py={2}
                >
                    <Text color={SEMANTIC_COLORS.textPrimary} fontSize="md" lineHeight="1.6">
                        {level.description}
                    </Text>
                </Box>

                {/* Basic Metrics */}
                <Box
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    borderRadius={0}
                    p={4}
                    bg={SEMANTIC_COLORS.bgTertiary}
                >
                    <VStack align="stretch" spacing={3}>
                        <HStack justify="space-between">
                            <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Status</Text>
                            <HStack spacing={2}>
                                <Box
                                    w="8px"
                                    h="8px"
                                    bg={level.status === 'unlocked' ? SEMANTIC_COLORS.info : SEMANTIC_COLORS.textSecondary}
                                    borderRadius="full"
                                    animation={level.status === 'unlocked' ? 'pulse 2s infinite' : 'none'}
                                />
                                <Text color={SEMANTIC_COLORS.textPrimary} fontSize="sm" textTransform="uppercase">
                                    {level.status}
                                </Text>
                            </HStack>
                        </HStack>
                        <HStack justify="space-between">
                            <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Access Level</Text>
                            <Text color={SEMANTIC_COLORS.textPrimary} fontSize="sm">Level {level.id}</Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">Protocol</Text>
                            <Text color={SEMANTIC_COLORS.textPrimary} fontSize="sm">Active</Text>
                        </HStack>
                    </VStack>
                </Box>

                {/* Enter Button */}
                <Button
                    onClick={() => onEnter(level)}
                    bg={level.color}
                    color={SEMANTIC_COLORS.bgPrimary}
                    size="lg"
                    fontSize="lg"
                    letterSpacing="wider"
                    fontWeight="bold"
                    borderRadius={0}
                    border="1px solid"
                    borderColor={level.color}
                    transition={TRANSITIONS.colors}
                    _hover={HOVER_EFFECTS.borderHighlight}
                    _focus={FOCUS_STYLES.ring}
                    mt="auto"
                >
                    ENTER
                </Button>
            </VStack>
        </Card>
    )
}
