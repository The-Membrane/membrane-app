import React from 'react'
import { Box, Button, Text, VStack, HStack, Icon } from '@chakra-ui/react'
import { Lock, Unlock } from 'lucide-react'
import { levels, Level } from '@/components/Home/CyberpunkLevelsData'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'

interface ControlPanelProps {
    selectedLevel: number | null
    onLevelClick: (level: Level) => void
}

export const ControlPanel: React.FC<ControlPanelProps> = ({ selectedLevel, onLevelClick }) => {
    return (
        <Box
            bg={SEMANTIC_COLORS.bgSecondary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            borderRadius={0}
            p={SPACING.lg}
            flex={1}
            display="flex"
            flexDirection="column"
        >
            <Text
                fontFamily="mono"
                fontSize={TYPOGRAPHY.label}
                textTransform="uppercase"
                letterSpacing="0.28em"
                color={SEMANTIC_COLORS.textSecondary}
                mb={6}
            >
                Control Panel
            </Text>

            {/* Level Buttons */}
            <VStack spacing={3}>
                {levels.map((level) => (
                    <Button
                        key={level.id}
                        onClick={() => onLevelClick(level)}
                        isDisabled={level.status === 'locked'}
                        w="100%"
                        p={4}
                        border="1px solid"
                        borderRadius={0}
                        transition={TRANSITIONS.colors}
                        bg={
                            selectedLevel === level.id
                                ? SEMANTIC_COLORS.bgTertiary
                                : 'transparent'
                        }
                        borderColor={
                            selectedLevel === level.id
                                ? SEMANTIC_COLORS.info
                                : level.status === 'locked'
                                    ? SEMANTIC_COLORS.borderSubtle
                                    : SEMANTIC_COLORS.borderStrong
                        }
                        opacity={level.status === 'locked' ? 0.5 : 1}
                        cursor={level.status === 'locked' ? 'not-allowed' : 'pointer'}
                        _hover={
                            level.status === 'unlocked'
                                ? {
                                      borderColor: SEMANTIC_COLORS.borderStrong,
                                      bg: SEMANTIC_COLORS.bgTertiary,
                                  }
                                : {}
                        }
                        _focus={FOCUS_STYLES.ring}
                    >
                        <HStack spacing={2} w="100%">
                            <Icon
                                as={level.status === 'unlocked' ? Unlock : Lock}
                                w={4}
                                h={4}
                                color={level.status === 'unlocked' ? level.color : SEMANTIC_COLORS.textSecondary}
                            />
                            <VStack align="start" spacing={0}>
                                <Text
                                    letterSpacing="wider"
                                    color={level.status === 'unlocked' ? level.color : SEMANTIC_COLORS.textSecondary}
                                >
                                    {level.name}
                                </Text>
                                {level.subtitle && (
                                    <Text
                                        fontSize="xs"
                                        color={SEMANTIC_COLORS.textSecondary}
                                        letterSpacing="wide"
                                    >
                                        {level.subtitle}
                                    </Text>
                                )}
                            </VStack>
                        </HStack>
                    </Button>
                ))}
            </VStack>
        </Box>
    )
}
