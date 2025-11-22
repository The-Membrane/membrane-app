import React, { useState } from 'react'
import { Box, Button, Text, VStack, HStack, Image, Icon } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import ChainLayout from '@/components/ChainLayout'
import { ArrowLeft, Lock, Unlock, Wifi } from 'lucide-react'

interface Level {
    id: number
    name: string
    description: string
    status: 'unlocked' | 'locked'
    color: string
}

const levels: Level[] = [
    {
        id: 1,
        name: 'GROUND FLOOR',
        description: 'Main dance floor with holographic DJs',
        status: 'unlocked',
        color: '#3BE5E5'
    },
    {
        id: 2,
        name: 'LEVEL AZURE',
        description: 'Ambient lounge with neural relaxation pods',
        status: 'unlocked',
        color: '#6943FF'
    },
    {
        id: 3,
        name: 'LEVEL VIOLET',
        description: 'VIP section with exclusive experiences',
        status: 'unlocked',
        color: '#A692FF'
    },
    {
        id: 4,
        name: 'THE NEXUS',
        description: 'Direct neural interface experimental zone',
        status: 'locked',
        color: '#8A8A8A'
    },
    {
        id: 5,
        name: 'LEVEL OMEGA',
        description: 'Top secret - Requires special clearance',
        status: 'locked',
        color: '#8A8A8A'
    }
]

const ImageWithFallback = ({ src, alt, ...props }: any) => {
    const [hasError, setHasError] = useState(false)

    if (hasError) {
        return (
            <Box
                bg="gray.800"
                display="flex"
                alignItems="center"
                justifyContent="center"
                {...props}
            >
                <Text color="gray.500" fontSize="sm">Image failed to load</Text>
            </Box>
        )
    }

    return (
        <Image
            src={src}
            alt={alt}
            onError={() => setHasError(true)}
            {...props}
        />
    )
}

export default function LevelsPage() {
    const router = useRouter()
    const { chainName } = useChainRoute()
    const [selectedLevel, setSelectedLevel] = useState<number | null>(null)
    const [currentFloor, setCurrentFloor] = useState(0)

    const handleLevelClick = (level: Level) => {
        if (level.status === 'unlocked') {
            setSelectedLevel(level.id)
            setCurrentFloor(level.id)
        }
    }

    return (
        <ChainLayout>
            <Box
                position="relative"
                minH="100vh"
                bg="#0A0A0A"
                overflow="hidden"
                px={4}
                py={8}
            >
                {/* Background */}
                <Box position="absolute" inset={0}>
                    <ImageWithFallback
                        src="https://images.unsplash.com/photo-1694951558444-03b27ca33665?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxmdXR1cmlzdGljJTIwZWxldmF0b3J8ZW58MXx8fHwxNzYyODk2NjA1fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral"
                        alt="Elevator"
                        w="100%"
                        h="100%"
                        objectFit="cover"
                        opacity={0.2}
                    />
                    <Box
                        position="absolute"
                        inset={0}
                        bgGradient="linear(to-b, #0A0A0A80, transparent, #0A0A0A)"
                    />
                </Box>

                {/* Content */}
                <Box position="relative" zIndex={10} minH="100vh" display="flex" flexDirection="column" px={4} py={8}>
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
                        maxW="6xl"
                        mx="auto"
                        w="100%"
                        flexDirection={{ base: 'column', md: 'row' }}
                        flex={1}
                        align="stretch"
                    >
                        {/* Elevator Control Panel */}
                        <Box flex={1} display="flex" flexDirection="column">
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
                                <HStack justify="space-between" mb={6}>
                                    <Text color="#F5F5F5" fontSize="xl" letterSpacing="wider">
                                        CONTROL PANEL
                                    </Text>
                                    <Text color="#3BE5E5" fontSize="2xl" fontFamily="mono">
                                        {currentFloor}
                                    </Text>
                                </HStack>

                                {/* Level Buttons */}
                                <VStack spacing={3}>
                                    {levels.map((level) => (
                                        <Button
                                            key={level.id}
                                            onClick={() => handleLevelClick(level)}
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
                                            <HStack justify="space-between" w="100%">
                                                <VStack align="start" spacing={1}>
                                                    <HStack spacing={2}>
                                                        <Icon
                                                            as={level.status === 'unlocked' ? Unlock : Lock}
                                                            w={4}
                                                            h={4}
                                                            color={level.status === 'unlocked' ? level.color : '#8A8A8A'}
                                                        />
                                                        <Text
                                                            letterSpacing="wider"
                                                            color={level.status === 'unlocked' ? level.color : '#8A8A8A'}
                                                        >
                                                            {level.name}
                                                        </Text>
                                                    </HStack>
                                                    <Text color="#8A8A8A" fontSize="sm">
                                                        {level.description}
                                                    </Text>
                                                </VStack>
                                                <Text
                                                    fontSize="3xl"
                                                    fontFamily="mono"
                                                    color={level.status === 'unlocked' ? level.color : '#8A8A8A'}
                                                >
                                                    {level.id}
                                                </Text>
                                            </HStack>
                                        </Button>
                                    ))}
                                </VStack>
                            </Box>
                        </Box>

                        {/* Level Display */}
                        <Box flex={1} display="flex" flexDirection="column">
                            {selectedLevel ? (
                                <Box
                                    bgGradient="linear(to-br, #3BE5E510, #0A0A0A)"
                                    border="2px solid"
                                    borderColor="#3BE5E5"
                                    borderRadius="md"
                                    p={8}
                                    flex={1}
                                    display="flex"
                                    flexDirection="column"
                                    boxShadow="0 0 30px #3BE5E530"
                                >
                                    <VStack
                                        align="center"
                                        justify="center"
                                        flex={1}
                                        spacing={6}
                                        textAlign="center"
                                    >
                                        <Text
                                            fontSize="8xl"
                                            fontFamily="mono"
                                            color={levels[selectedLevel - 1].color}
                                            textShadow={`0 0 30px ${levels[selectedLevel - 1].color}`}
                                        >
                                            {selectedLevel}
                                        </Text>
                                        <Text
                                            fontSize="3xl"
                                            letterSpacing="wider"
                                            color={levels[selectedLevel - 1].color}
                                        >
                                            {levels[selectedLevel - 1].name}
                                        </Text>
                                        <Text color="#F5F5F5" maxW="md">
                                            {levels[selectedLevel - 1].description}
                                        </Text>

                                        {/* Level Visualization */}
                                        <VStack spacing={2} w="100%" maxW="xs">
                                            {[...Array(5)].reverse().map((_, i) => (
                                                <Box
                                                    key={i}
                                                    h="48px"
                                                    mb={2}
                                                    border="2px solid"
                                                    borderRadius="md"
                                                    transition="all 0.3s"
                                                    bg={
                                                        5 - i === selectedLevel
                                                            ? 'linear-gradient(to right, #6943FF, #A692FF)'
                                                            : '#0A0A0A'
                                                    }
                                                    borderColor={
                                                        5 - i === selectedLevel
                                                            ? '#3BE5E5'
                                                            : '#6943FF30'
                                                    }
                                                    boxShadow={
                                                        5 - i === selectedLevel
                                                            ? '0 0 20px #6943FF'
                                                            : 'none'
                                                    }
                                                >
                                                    <HStack justify="space-between" h="100%" px={4}>
                                                        <Text color="#8A8A8A" fontSize="sm">
                                                            {levels[4 - i].name}
                                                        </Text>
                                                        {5 - i === selectedLevel && (
                                                            <Box
                                                                w="8px"
                                                                h="8px"
                                                                bg="#3BE5E5"
                                                                borderRadius="full"
                                                                animation="pulse 2s infinite"
                                                            />
                                                        )}
                                                    </HStack>
                                                </Box>
                                            ))}
                                        </VStack>
                                    </VStack>
                                </Box>
                            ) : (
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
                            )}
                        </Box>
                    </HStack>

                    {/* Navigation */}
                    <HStack spacing={4} justify="center" mt={8}>
                        <Button
                            onClick={() => router.push(`/${chainName}?view=lobby`)}
                            px={8}
                            py={3}
                            border="2px solid"
                            borderColor="#8A8A8A"
                            color="#8A8A8A"
                            bg="transparent"
                            _hover={{
                                borderColor: '#F5F5F5',
                                color: '#F5F5F5',
                            }}
                            transition="all 0.3s"
                            letterSpacing="wider"
                            leftIcon={<Icon as={ArrowLeft} w={5} h={5} />}
                        >
                            LOBBY
                        </Button>
                        <Button
                            onClick={() => router.push(`/${chainName}?view=about`)}
                            px={8}
                            py={3}
                            border="2px solid"
                            borderColor="#6943FF"
                            color="#F5F5F5"
                            bg="transparent"
                            _hover={{
                                bg: '#6943FF20',
                                boxShadow: '0 0 20px #6943FF',
                            }}
                            transition="all 0.3s"
                            letterSpacing="wider"
                        >
                            ABOUT
                        </Button>
                    </HStack>
                </Box>
            </Box>
        </ChainLayout>
    )
}

