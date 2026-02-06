import React from 'react'
import { Box, Text, VStack, HStack, Button } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import ChainLayout from '@/components/ChainLayout'
import { ArrowLeft } from 'lucide-react'
import { Icon } from '@chakra-ui/react'

export default function AboutPage() {
    const router = useRouter()
    const { chainName } = useChainRoute()

    return (
        <ChainLayout>
            <Box
                position="relative"
                minH="100vh"
                bg="#0A0A0A"
                overflow="hidden"
                display="flex"
                flexDirection="column"
                alignItems="center"
                px={4}
                py={12}
            >
                {/* Hexagonal Background Grid */}
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
                            <pattern id="hexagonPatternAbout" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
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
                        <rect width="100%" height="100%" fill="url(#hexagonPatternAbout)" />
                    </Box>
                </Box>

                {/* Content */}
                <Box position="relative" zIndex={2} maxW="3xl" mx="auto" w="100%">
                    {/* Header */}
                    <VStack mb={12} spacing={6}>
                        <Box
                            display="inline-block"
                            p={6}
                            border="2px solid"
                            borderColor="#6943FF"
                            borderRadius="full"
                            boxShadow="0 0 30px #6943FF"
                        >
                            <Box
                                w="96px"
                                h="96px"
                                bgGradient="linear(to-br, #6943FF, #A692FF)"
                                borderRadius="full"
                                display="flex"
                                alignItems="center"
                                justifyContent="center"
                            >
                                <Text color="#F5F5F5" fontSize="4xl">R</Text>
                            </Box>
                        </Box>
                        <Text
                            fontSize={{ base: '2xl', md: '4xl', lg: '6xl' }}
                            fontFamily="mono"
                            color="#A692FF"
                            textShadow="0 0 20px #6943FF"
                            letterSpacing="wider"
                            textAlign="center"
                        >
                            RECEPTIONIST
                        </Text>
                        <Text color="#8A8A8A" letterSpacing="widest">
                            NEURAL INTERFACE ACTIVE
                        </Text>
                    </VStack>

                    {/* Dialogue Box */}
                    <Box
                        bgGradient="linear(to-br, #6943FF10, #0A0A0A)"
                        border="2px solid"
                        borderColor="#6943FF"
                        borderRadius="md"
                        p={8}
                        mb={8}
                        boxShadow="0 0 20px #6943FF20"
                    >
                        <VStack spacing={6} align="stretch">
                            <HStack align="start" spacing={4}>
                                <Box
                                    w="8px"
                                    h="8px"
                                    bg="#3BE5E5"
                                    borderRadius="full"
                                    mt={2}
                                    animation="pulse 2s infinite"
                                />
                                <Text color="#F5F5F5" flex={1}>
                                    Welcome to <Text as="span" color="#A692FF">The Membrane</Text>, where the boundaries between reality and the digital realm blur into something extraordinary.
                                </Text>
                            </HStack>

                            <HStack align="start" spacing={4}>
                                <Box
                                    w="8px"
                                    h="8px"
                                    bg="#3BE5E5"
                                    borderRadius="full"
                                    mt={2}
                                    animation="pulse 2s infinite"
                                    style={{ animationDelay: '0.5s' }}
                                />
                                <Text color="#F5F5F5" flex={1}>
                                    We are more than just a club. We are a neural nexus, a convergence point for digital consciousness and human experience.
                                </Text>
                            </HStack>
                        </VStack>
                    </Box>

                    {/* Features Grid */}
                    <HStack
                        spacing={6}
                        mb={8}
                        flexDirection={{ base: 'column', md: 'row' }}
                    >
                        <Box
                            border="1px solid"
                            borderColor="#6943FF50"
                            borderRadius="md"
                            p={6}
                            bg="#0A0A0A80"
                            _hover={{ borderColor: '#3BE5E5' }}
                            transition="colors 0.3s"
                            flex={1}
                        >
                            <Text color="#3BE5E5" mb={4} fontSize="2xl">⚡</Text>
                            <Text color="#F5F5F5" mb={2} fontWeight="bold">
                                IMMERSIVE EXPERIENCE
                            </Text>
                            <Text color="#8A8A8A" fontSize="sm">
                                Cutting-edge neural technology creates unparalleled sensory journeys
                            </Text>
                        </Box>

                        <Box
                            border="1px solid"
                            borderColor="#6943FF50"
                            borderRadius="md"
                            p={6}
                            bg="#0A0A0A80"
                            _hover={{ borderColor: '#3BE5E5' }}
                            transition="colors 0.3s"
                            flex={1}
                        >
                            <Text color="#A692FF" mb={4} fontSize="2xl">🛡️</Text>
                            <Text color="#F5F5F5" mb={2} fontWeight="bold">
                                SECURE PROTOCOL
                            </Text>
                            <Text color="#8A8A8A" fontSize="sm">
                                Military-grade encryption protects your neural signature
                            </Text>
                        </Box>

                        <Box
                            border="1px solid"
                            borderColor="#6943FF50"
                            borderRadius="md"
                            p={6}
                            bg="#0A0A0A80"
                            _hover={{ borderColor: '#3BE5E5' }}
                            transition="colors 0.3s"
                            flex={1}
                        >
                            <Text color="#6943FF" mb={4} fontSize="2xl">🧠</Text>
                            <Text color="#F5F5F5" mb={2} fontWeight="bold">
                                MULTI-LEVEL ACCESS
                            </Text>
                            <Text color="#8A8A8A" fontSize="sm">
                                Explore different dimensions of consciousness across our levels
                            </Text>
                        </Box>
                    </HStack>

                    {/* Info Box */}
                    <Box
                        borderLeft="4px solid"
                        borderColor="#3BE5E5"
                        bg="#3BE5E505"
                        borderRadius="md"
                        p={6}
                        mb={8}
                    >
                        <Text color="#F5F5F5" mb={2}>
                            <Text as="span" color="#3BE5E5">STATUS:</Text> Currently operating at 99.7% neural sync capacity
                        </Text>
                        <Text color="#F5F5F5">
                            <Text as="span" color="#3BE5E5">LOCATION:</Text> Neural District 07, Sector Grid 42-A
                        </Text>
                    </Box>

                    {/* Navigation Buttons */}
                    <HStack spacing={4} justify="center">
                        <Button
                            onClick={() => router.push(`/${chainName}/levels`)}
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
                            leftIcon={<Icon as={ArrowLeft} w={5} h={5} />}
                        >
                            BACK
                        </Button>
                        <Button
                            onClick={() => router.push(`/${chainName}/levels`)}
                            px={8}
                            py={3}
                            bgGradient="linear(to-r, #6943FF, #A692FF)"
                            color="#F5F5F5"
                            _hover={{
                                boxShadow: '0 0 30px #6943FF',
                            }}
                            transition="all 0.3s"
                            letterSpacing="wider"
                        >
                            EXPLORE LEVELS
                        </Button>
                    </HStack>
                </Box>
            </Box>
        </ChainLayout>
    )
}

