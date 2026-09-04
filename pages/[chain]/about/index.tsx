import React from 'react'
import { Box, Text, VStack, HStack, Button } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import ChainLayout from '@/components/ChainLayout'
import { ArrowLeft } from 'lucide-react'
import { Icon } from '@chakra-ui/react'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'

const features = [
    {
        icon: '⚡',
        accent: SEMANTIC_COLORS.info,
        title: 'Immersive experience',
        body: 'Cutting-edge neural technology creates unparalleled sensory journeys.',
    },
    {
        icon: '🛡️',
        accent: SEMANTIC_COLORS.success,
        title: 'Secure protocol',
        body: 'Military-grade encryption protects your neural signature.',
    },
    {
        icon: '🧠',
        accent: SEMANTIC_COLORS.info,
        title: 'Multi-level access',
        body: 'Explore different dimensions of consciousness across our levels.',
    },
]

export default function AboutPage() {
    const router = useRouter()
    const { chainName } = useChainRoute()

    return (
        <ChainLayout>
            <Box
                position="relative"
                minH="100vh"
                bg={SEMANTIC_COLORS.bgPrimary}
                overflow="hidden"
                display="flex"
                flexDirection="column"
                alignItems="center"
                px={4}
                py={12}
            >
                {/* Hexagonal Background Grid — very-low-alpha bone hairline atmosphere */}
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
                                    stroke="color-mix(in srgb, var(--m-text-primary) 5%, transparent)"
                                    strokeWidth="1"
                                />
                                {/* Right hexagon (offset down) */}
                                <polygon
                                    points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                                    fill="none"
                                    stroke="color-mix(in srgb, var(--m-text-primary) 5%, transparent)"
                                    strokeWidth="1"
                                />
                                {/* Top-right continuation for seamless tiling */}
                                <polygon
                                    points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                                    fill="none"
                                    stroke="color-mix(in srgb, var(--m-text-primary) 5%, transparent)"
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
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.borderStrong}
                            borderRadius="full"
                        >
                            <Box
                                w="96px"
                                h="96px"
                                bg={SEMANTIC_COLORS.bgTertiary}
                                border="1px solid"
                                borderColor={SEMANTIC_COLORS.success}
                                borderRadius="full"
                                display="flex"
                                alignItems="center"
                                justifyContent="center"
                            >
                                <Text
                                    fontFamily="heading"
                                    color={SEMANTIC_COLORS.success}
                                    fontSize="4xl"
                                >
                                    R
                                </Text>
                            </Box>
                        </Box>
                        <Text
                            as="h1"
                            fontFamily={TYPOGRAPHY.fontDisplay}
                            fontSize={TYPOGRAPHY.h1}
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.textPrimary}
                            textAlign="center"
                        >
                            Receptionist
                        </Text>
                        <Text
                            fontFamily="mono"
                            fontSize={TYPOGRAPHY.label}
                            textTransform="uppercase"
                            letterSpacing="0.28em"
                            color={SEMANTIC_COLORS.textSecondary}
                        >
                            Neural interface active
                        </Text>
                    </VStack>

                    {/* Dialogue Box */}
                    <Card
                        variant="default"
                        borderRadius={0}
                        bg={SEMANTIC_COLORS.bgSecondary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        p={SPACING.xl}
                        mb={8}
                    >
                        <VStack spacing={6} align="stretch">
                            <HStack align="start" spacing={4}>
                                <Box
                                    w="8px"
                                    h="8px"
                                    bg={SEMANTIC_COLORS.info}
                                    borderRadius="full"
                                    mt={2}
                                    animation="pulse 2s infinite"
                                />
                                <Text fontFamily="heading" color={SEMANTIC_COLORS.textPrimary} flex={1}>
                                    Welcome to <Text as="span" color={SEMANTIC_COLORS.success}>The Membrane</Text>, where the boundaries between reality and the digital realm blur into something extraordinary.
                                </Text>
                            </HStack>

                            <HStack align="start" spacing={4}>
                                <Box
                                    w="8px"
                                    h="8px"
                                    bg={SEMANTIC_COLORS.info}
                                    borderRadius="full"
                                    mt={2}
                                    animation="pulse 2s infinite"
                                    style={{ animationDelay: '0.5s' }}
                                />
                                <Text fontFamily="heading" color={SEMANTIC_COLORS.textPrimary} flex={1}>
                                    We are more than just a club. We are a neural nexus, a convergence point for digital consciousness and human experience.
                                </Text>
                            </HStack>
                        </VStack>
                    </Card>

                    {/* Features Grid */}
                    <HStack
                        spacing={6}
                        mb={8}
                        flexDirection={{ base: 'column', md: 'row' }}
                        align="stretch"
                    >
                        {features.map((feature) => (
                            <Card
                                key={feature.title}
                                variant="default"
                                borderRadius={0}
                                bg={SEMANTIC_COLORS.bgSecondary}
                                border="1px solid"
                                borderColor={SEMANTIC_COLORS.borderSubtle}
                                p={SPACING.lg}
                                flex={1}
                                transition={TRANSITIONS.colors}
                                _hover={HOVER_EFFECTS.borderHighlight}
                            >
                                <Text color={feature.accent} mb={4} fontSize="2xl">{feature.icon}</Text>
                                <Text
                                    fontFamily="heading"
                                    color={SEMANTIC_COLORS.textPrimary}
                                    fontSize={TYPOGRAPHY.h4}
                                    mb={2}
                                >
                                    {feature.title}
                                </Text>
                                <Text fontFamily="mono" color={SEMANTIC_COLORS.textSecondary} fontSize="sm">
                                    {feature.body}
                                </Text>
                            </Card>
                        ))}
                    </HStack>

                    {/* Info Box */}
                    <Box
                        borderLeft="3px solid"
                        borderColor={SEMANTIC_COLORS.info}
                        bg={SEMANTIC_COLORS.bgTertiary}
                        pl={4}
                        py={4}
                        pr={4}
                        mb={8}
                    >
                        <Text fontFamily="mono" color={SEMANTIC_COLORS.textPrimary} mb={2}>
                            <Text
                                as="span"
                                textTransform="uppercase"
                                letterSpacing="0.28em"
                                fontSize={TYPOGRAPHY.label}
                                color={SEMANTIC_COLORS.info}
                            >
                                Status
                            </Text>{' '}
                            Neural sync nominal
                        </Text>
                        <Text fontFamily="mono" color={SEMANTIC_COLORS.textPrimary}>
                            <Text
                                as="span"
                                textTransform="uppercase"
                                letterSpacing="0.28em"
                                fontSize={TYPOGRAPHY.label}
                                color={SEMANTIC_COLORS.info}
                            >
                                Location
                            </Text>{' '}
                            Neural District 07, Sector Grid 42-A
                        </Text>
                    </Box>

                    {/* Divider */}
                    <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mb={8} />

                    {/* Navigation Buttons */}
                    <HStack spacing={4} justify="center">
                        <Button
                            onClick={() => router.push(`/${chainName}/levels`)}
                            variant="outline"
                            px={8}
                            py={3}
                            borderRadius={0}
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.borderStrong}
                            color={SEMANTIC_COLORS.textPrimary}
                            bg="transparent"
                            fontFamily="mono"
                            letterSpacing="wider"
                            transition={TRANSITIONS.colors}
                            _hover={HOVER_EFFECTS.borderHighlight}
                            _focus={FOCUS_STYLES.ring}
                            leftIcon={<Icon as={ArrowLeft} w={5} h={5} />}
                        >
                            BACK
                        </Button>
                        <Button
                            onClick={() => router.push(`/${chainName}/levels`)}
                            px={8}
                            py={3}
                            borderRadius={0}
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.success}
                            bg={SEMANTIC_COLORS.success}
                            color={SEMANTIC_COLORS.bgPrimary}
                            fontFamily="mono"
                            letterSpacing="wider"
                            transition={TRANSITIONS.colors}
                            _hover={HOVER_EFFECTS.borderHighlight}
                            _focus={FOCUS_STYLES.ring}
                        >
                            EXPLORE LEVELS
                        </Button>
                    </HStack>
                </Box>
            </Box>
        </ChainLayout>
    )
}
