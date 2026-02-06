import React from 'react'
import { Box, Button, Text, VStack, HStack } from '@chakra-ui/react'
import { Level } from '@/components/Home/CyberpunkHome'

interface LevelSelectionCardProps {
    level: Level | null
    onEnter: (level: Level) => void
}

export const LevelSelectionCard: React.FC<LevelSelectionCardProps> = ({ level, onEnter }) => {
    if (!level) {
        return (
            <Box
                border="2px solid"
                borderColor="#6943FF30"
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
                    <Text color="#8A8A8A">Select a level to begin</Text>
                </VStack>
            </Box>
        )
    }

    return (
        <Box
            bgGradient="linear(to-br, #3BE5E510, #0A0A0A)"
            border="2px solid"
            borderColor={level.color}
            borderRadius="md"
            p={8}
            flex={1}
            display="flex"
            flexDirection="column"
            boxShadow={`0 0 30px ${level.color}30`}
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
                            color="#8A8A8A"
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
                    <Text color="#F5F5F5" fontSize="md" lineHeight="1.6">
                        {level.description}
                    </Text>
                </Box>

                {/* Basic Metrics */}
                <Box
                    border="1px solid"
                    borderColor="#6943FF30"
                    borderRadius="md"
                    p={4}
                    bg="#0A0A0A80"
                >
                    <VStack align="stretch" spacing={3}>
                        <HStack justify="space-between">
                            <Text color="#8A8A8A" fontSize="sm">Status</Text>
                            <HStack spacing={2}>
                                <Box
                                    w="8px"
                                    h="8px"
                                    bg={level.status === 'unlocked' ? '#3BE5E5' : '#8A8A8A'}
                                    borderRadius="full"
                                    animation={level.status === 'unlocked' ? 'pulse 2s infinite' : 'none'}
                                />
                                <Text color="#F5F5F5" fontSize="sm" textTransform="uppercase">
                                    {level.status}
                                </Text>
                            </HStack>
                        </HStack>
                        <HStack justify="space-between">
                            <Text color="#8A8A8A" fontSize="sm">Access Level</Text>
                            <Text color="#F5F5F5" fontSize="sm">Level {level.id}</Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text color="#8A8A8A" fontSize="sm">Protocol</Text>
                            <Text color="#F5F5F5" fontSize="sm">Active</Text>
                        </HStack>
                    </VStack>
                </Box>

                {/* Enter Button */}
                <Button
                    onClick={() => onEnter(level)}
                    bgGradient={`linear(to-r, ${level.color}, ${level.color}80)`}
                    color="#F5F5F5"
                    size="lg"
                    fontSize="lg"
                    letterSpacing="wider"
                    fontWeight="bold"
                    _hover={{
                        boxShadow: `0 0 30px ${level.color}`,
                        transform: 'scale(1.02)',
                    }}
                    transition="all 0.3s"
                    mt="auto"
                >
                    ENTER
                </Button>
            </VStack>
        </Box>
    )
}

