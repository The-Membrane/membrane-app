import React from 'react'
import { Box, Button, Text, VStack, HStack, Icon } from '@chakra-ui/react'
import { Lock, Unlock } from 'lucide-react'
import { levels, Level } from '@/components/Home/CyberpunkHome'

interface ControlPanelProps {
    selectedLevel: number | null
    onLevelClick: (level: Level) => void
}

export const ControlPanel: React.FC<ControlPanelProps> = ({ selectedLevel, onLevelClick }) => {
    return (
        <Box
            bgGradient="linear(to-br, #6943FF10, #0A0A0A)"
            border="2px solid"
            borderColor="#6943FF"
            borderRadius="md"
            p={6}
            boxShadow="0 0 30px #6943FF30"
            flex={1}
            display="flex"
            flexDirection="column"
        >
            <Text color="#F5F5F5" fontSize="xl" letterSpacing="wider" mb={6}>
                CONTROL PANEL
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
                                ? '#3BE5E5'
                                : level.status === 'locked'
                                    ? '#8A8A8A30'
                                    : '#6943FF50'
                        }
                        opacity={level.status === 'locked' ? 0.5 : 1}
                        cursor={level.status === 'locked' ? 'not-allowed' : 'pointer'}
                        _hover={
                            level.status === 'unlocked'
                                ? {
                                      borderColor: '#A692FF',
                                      bg: '#6943FF10',
                                  }
                                : {}
                        }
                        boxShadow={
                            selectedLevel === level.id && level.status === 'unlocked'
                                ? `0 0 20px ${level.color}`
                                : 'none'
                        }
                    >
                        <HStack spacing={2} w="100%">
                            <Icon
                                as={level.status === 'unlocked' ? Unlock : Lock}
                                w={4}
                                h={4}
                                color={level.status === 'unlocked' ? level.color : '#8A8A8A'}
                            />
                            <VStack align="start" spacing={0}>
                                <Text
                                    letterSpacing="wider"
                                    color={level.status === 'unlocked' ? level.color : '#8A8A8A'}
                                >
                                    {level.name}
                                </Text>
                                {level.subtitle && (
                                    <Text
                                        fontSize="xs"
                                        color="#8A8A8A"
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

