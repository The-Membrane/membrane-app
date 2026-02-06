import React, { useState } from 'react'
import { Box, Text, VStack, HStack, Icon } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import ChainLayout from '@/components/ChainLayout'
import { Wifi } from 'lucide-react'
import { levels, Level } from '@/components/Home/CyberpunkHome'
import { ControlPanel } from '@/components/Elevator/ControlPanel'
import { LevelSelectionCard } from '@/components/Elevator/LevelSelectionCard'

export default function LevelsPage() {
    const router = useRouter()
    const { chainName } = useChainRoute()
    const [selectedLevel, setSelectedLevel] = useState<number | null>(null)

    const handleLevelClick = (level: Level) => {
        if (level.status === 'unlocked') {
            setSelectedLevel(level.id)
        }
    }

    const handleEnter = (level: Level) => {
        if (level.route) {
            router.push(`/${chainName}/${level.route}`)
        }
    }

    return (
        <ChainLayout>
            <Box
                position="relative"
                minH="100vh"
                bg="#0A0A0A"
                overflow="hidden"
                display="flex"
                justifyContent="center"
                py={8}
            >
                {/* Hexagonal Background Grid - full background */}
                <Box
                    position="fixed"
                    inset={0}
                    opacity={0.5}
                    zIndex={0}
                >
                    <Box
                        as="svg"
                        w="100%"
                        h="100%"
                    >
                        <defs>
                            <pattern id="hexagonPatternLevels" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
                                {/* Left hexagon */}
                                <polygon
                                    points="34.64,10 51.96,20 51.96,40 34.64,50 17.32,40 17.32,20"
                                    fill="none"
                                    stroke="#6943FF"
                                    strokeWidth="1"
                                />
                                {/* Right hexagon (offset down) */}
                                <polygon
                                    points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                    fill="none"
                                    stroke="#6943FF"
                                    strokeWidth="1"
                                />
                                {/* Top-right continuation for seamless tiling */}
                                <polygon
                                    points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                    fill="none"
                                    stroke="#6943FF"
                                    strokeWidth="1"
                                />
                            </pattern>
                        </defs>
                        <rect width="100%" height="100%" fill="url(#hexagonPatternLevels)" />
                    </Box>
                </Box>

                {/* Content - 90% width container with black background */}
                <Box
                    position="relative"
                    zIndex={2}
                    minH="100vh"
                    w="90vw"
                    bg="#000000"
                    display="flex"
                    flexDirection="column"
                    px={4}
                    py={8}
                >
                    {/* Header */}
                    <VStack mb={8} spacing={4}>
                        <Text
                            fontSize={{ base: '2xl', md: '4xl', lg: '6xl' }}
                            fontFamily="mono"
                            color="#3BE5E5"
                            textShadow="0 0 20px #3BE5E5, 0 0 40px #3BE5E5"
                            letterSpacing="wider"
                            textAlign="center"
                        >
                            ELEVATOR ACCESS
                        </Text>
                        <HStack spacing={2} color="#8A8A8A">
                            <Icon as={Wifi} w={4} h={4} animation="pulse 2s infinite" />
                            <Text letterSpacing="widest" fontSize="sm">NEURAL LINK STABLE</Text>
                        </HStack>
                    </VStack>

                    <HStack
                        spacing={8}
                        w="100%"
                        flexDirection={{ base: 'column', md: 'row' }}
                        flex={1}
                        align="stretch"
                    >
                        {/* Elevator Control Panel - 50% width */}
                        <Box flex={1} w={{ base: '100%', md: '50%' }} display="flex" flexDirection="column">
                            <ControlPanel
                                selectedLevel={selectedLevel}
                                onLevelClick={handleLevelClick}
                            />
                        </Box>

                        {/* Level Display - 50% width */}
                        <Box flex={1} w={{ base: '100%', md: '50%' }} display="flex" flexDirection="column">
                            <LevelSelectionCard
                                level={selectedLevel ? levels.find(l => l.id === selectedLevel) || null : null}
                                onEnter={handleEnter}
                            />
                        </Box>
                    </HStack>
                </Box>
            </Box>
        </ChainLayout>
    )
}

