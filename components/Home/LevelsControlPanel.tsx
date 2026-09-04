import { Box, Button, Text, VStack, HStack, Icon } from '@chakra-ui/react'
import { Lock, Unlock } from 'lucide-react'
import { levels } from './CyberpunkLevelsData'
import type { Level } from './CyberpunkLevelsData'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

interface LevelsControlPanelProps {
    selectedLevel: number | null
    onLevelClick: (level: Level) => void
}

// The elevator "control panel": the list of level buttons.
export const LevelsControlPanel = ({ selectedLevel, onLevelClick }: LevelsControlPanelProps) => {
    return (
        <Box flex={1} display="flex" flexDirection="column">
            <Box
                bgGradient={`linear(to-br, color-mix(in srgb, var(--m-primary) 6%, transparent), ${SEMANTIC_COLORS.bgPrimary})`}
                border="2px solid"
                borderColor={SEMANTIC_COLORS.primary}
                borderRadius="md"
                p={6}
                boxShadow="0 0 30px color-mix(in srgb, var(--m-primary) 19%, transparent)"
                flex={1}
                display="flex"
                flexDirection="column"
            >
                <HStack justify="space-between" mb={6}>
                    <Text color={SEMANTIC_COLORS.textPrimary} fontSize="xl" letterSpacing="wider">
                        CONTROL PANEL
                    </Text>
                    {/* <Text color={SEMANTIC_COLORS.secondary} fontSize="2xl" fontFamily="mono">
                                    {currentFloor}
                                </Text> */}
                </HStack>

                {/* Level Buttons */}
                <VStack spacing={3}>
                    {levels.map((level) => (
                        <Button
                            key={level.id}
                            onClick={() => onLevelClick(level)}
                            isDisabled={level.status === 'locked'}
                            w="100%"
                            p={4}
                            border="2px solid"
                            borderRadius="md"
                            transition="all 0.3s"
                            bg={
                                selectedLevel === level.id
                                    ? `linear-gradient(to right, ${level.color}30, ${level.color}20)`
                                    : 'transparent'
                            }
                            borderColor={
                                selectedLevel === level.id
                                    ? SEMANTIC_COLORS.secondary
                                    : level.status === 'locked'
                                        ? 'color-mix(in srgb, var(--m-text-secondary) 19%, transparent)'
                                        : 'color-mix(in srgb, var(--m-primary) 31%, transparent)'
                            }
                            opacity={level.status === 'locked' ? 0.5 : 1}
                            cursor={level.status === 'locked' ? 'not-allowed' : 'pointer'}
                            _hover={
                                level.status === 'unlocked'
                                    ? {
                                        borderColor: SEMANTIC_COLORS.primary,
                                        bg: 'color-mix(in srgb, var(--m-primary) 6%, transparent)',
                                    }
                                    : {}
                            }
                            boxShadow={
                                selectedLevel === level.id && level.status === 'unlocked'
                                    ? `0 0 20px ${level.color}`
                                    : 'none'
                            }
                        >
                            <HStack justify="space-between" w="100%">
                                <VStack align="start" spacing={1}>
                                    <HStack spacing={2}>
                                        <Icon
                                            as={level.status === 'unlocked' ? Unlock : Lock}
                                            w={4}
                                            h={4}
                                            color={level.status === 'unlocked' ? level.color : SEMANTIC_COLORS.textSecondary}
                                        />
                                        <Text
                                            letterSpacing="wider"
                                            color={level.status === 'unlocked' ? level.color : SEMANTIC_COLORS.textSecondary}
                                        >
                                            {level.name}
                                        </Text>
                                    </HStack>
                                    <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">
                                        {level.description}
                                    </Text>
                                </VStack>
                                <Text
                                    fontSize="3xl"
                                    fontFamily="mono"
                                    color={level.status === 'unlocked' ? level.color : SEMANTIC_COLORS.textSecondary}
                                >
                                    {level.id}
                                </Text>
                            </HStack>
                        </Button>
                    ))}
                </VStack>
            </Box>
        </Box>
    )
}
