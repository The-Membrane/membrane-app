import { Box, Text, VStack, HStack } from '@chakra-ui/react'
import { levels } from './CyberpunkLevelsData'

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
                    bgGradient="linear(to-br, #46d39a10, #09090a)"
                    border="2px solid"
                    borderColor="#46d39a"
                    borderRadius="md"
                    p={8}
                    flex={1}
                    display="flex"
                    flexDirection="column"
                    boxShadow="0 0 30px #46d39a30"
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
                        <Text color="#ece6d8" maxW="md">
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
                                                ? 'linear-gradient(to right, #9bdc4f, #9bdc4f)'
                                                : '#09090a'
                                        }
                                        borderColor={
                                            level.id === selectedLevel
                                                ? '#46d39a'
                                                : '#9bdc4f30'
                                        }
                                        boxShadow={
                                            level.id === selectedLevel
                                                ? '0 0 20px #9bdc4f'
                                                : 'none'
                                        }
                                    >
                                        <HStack justify="space-between" h="100%" px={4}>
                                            <Text color="#8d877b" fontSize="sm">
                                                {level.name}
                                            </Text>
                                            {level.id === selectedLevel && (
                                                <Box
                                                    w="8px"
                                                    h="8px"
                                                    bg="#46d39a"
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
                    borderColor="#9bdc4f30"
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
                        <Text color="#8d877b">Select a level to begin</Text>
                    </VStack>
                </Box>
            )}
        </Box>
    )
}
