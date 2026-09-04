import { Box, Text, VStack, HStack } from '@chakra-ui/react'
import { levels } from './CyberpunkLevelsData'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

interface LevelsDisplayProps {
    selectedLevel: number | null
}

// The right-hand "level display" panel: shows the selected level's details and
// a stacked visualization, or an empty-state prompt when nothing is selected.
export const LevelsDisplay = ({ selectedLevel }: LevelsDisplayProps) => {
    return (
        <Box flex={1} display="flex" flexDirection="column">
            {selectedLevel ? (
                <Box
                    bgGradient={`linear(to-br, color-mix(in srgb, var(--m-secondary) 6%, transparent), ${SEMANTIC_COLORS.bgPrimary})`}
                    border="2px solid"
                    borderColor={SEMANTIC_COLORS.secondary}
                    borderRadius="md"
                    p={8}
                    flex={1}
                    display="flex"
                    flexDirection="column"
                    boxShadow="0 0 30px color-mix(in srgb, var(--m-secondary) 19%, transparent)"
                >
                    <VStack
                        align="center"
                        justify="center"
                        flex={1}
                        spacing={6}
                        textAlign="center"
                    >
                        {/* <Text
                                        fontSize="8xl"
                                        fontFamily="mono"
                                        color={levels[selectedLevel - 1].color}
                                        textShadow={`0 0 30px ${levels[selectedLevel - 1].color}`}
                                    >
                                        {selectedLevel}
                                    </Text> */}
                        <Text
                            fontSize="3xl"
                            letterSpacing="wider"
                            color={levels[selectedLevel - 1].color}
                        >
                            {levels[selectedLevel - 1].name}
                        </Text>
                        <Text color={SEMANTIC_COLORS.textPrimary} maxW="md">
                            {levels[selectedLevel - 1].description}
                        </Text>

                        {/* Level Visualization */}
                        <VStack spacing={2} w="100%" maxW="xs">
                            {[...Array(levels.length)].reverse().map((_, i) => {
                                const levelIndex = levels.length - 1 - i
                                const level = levels[levelIndex]
                                return (
                                    <Box
                                        key={level.id}
                                        h="48px"
                                        mb={2}
                                        border="2px solid"
                                        borderRadius="md"
                                        transition="all 0.3s"
                                        bg={
                                            level.id === selectedLevel
                                                ? `linear-gradient(to right, ${SEMANTIC_COLORS.primary}, ${SEMANTIC_COLORS.primary})`
                                                : SEMANTIC_COLORS.bgPrimary
                                        }
                                        borderColor={
                                            level.id === selectedLevel
                                                ? SEMANTIC_COLORS.secondary
                                                : 'color-mix(in srgb, var(--m-primary) 19%, transparent)'
                                        }
                                        boxShadow={
                                            level.id === selectedLevel
                                                ? `0 0 20px ${SEMANTIC_COLORS.primary}`
                                                : 'none'
                                        }
                                    >
                                        <HStack justify="space-between" h="100%" px={4}>
                                            <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">
                                                {level.name}
                                            </Text>
                                            {level.id === selectedLevel && (
                                                <Box
                                                    w="8px"
                                                    h="8px"
                                                    bg={SEMANTIC_COLORS.secondary}
                                                    borderRadius="full"
                                                    animation="pulse 2s infinite"
                                                />
                                            )}
                                        </HStack>
                                    </Box>
                                )
                            })}
                        </VStack>
                    </VStack>
                </Box>
            ) : (
                <Box
                    border="2px solid"
                    borderColor="color-mix(in srgb, var(--m-primary) 19%, transparent)"
                    borderStyle="dashed"
                    borderRadius="md"
                    p={8}
                    flex={1}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                >
                    <VStack spacing={4}>
                        <Text fontSize="6xl" opacity={0.2}>⟐</Text>
                        <Text color={SEMANTIC_COLORS.textSecondary}>Select a level to begin</Text>
                    </VStack>
                </Box>
            )}
        </Box>
    )
}
