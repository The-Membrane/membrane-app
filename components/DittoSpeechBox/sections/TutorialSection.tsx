import React from 'react'
import { VStack, HStack, Text, Button, Box } from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import { SectionComponentProps } from '../types'
import { TutorialStep } from '../hooks/usePageTutorial'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

interface TutorialSectionProps extends SectionComponentProps {
    steps: TutorialStep[]
    currentStep: number
    isFirstStep: boolean
    isLastStep: boolean
    totalSteps: number
    onNext: () => void
    onPrevious: () => void
    onFinish: () => void
    onSkip: () => void
    onOpenFAQ?: () => void
}

export const TutorialSection: React.FC<TutorialSectionProps> = ({
    steps,
    currentStep,
    isFirstStep,
    isLastStep,
    totalSteps,
    onNext,
    onPrevious,
    onFinish,
    onSkip,
    onBack,
    onOpenFAQ,
}) => {
    const step = steps[currentStep]

    if (!step) return null

    return (
        <VStack spacing={4} align="stretch" w="100%" h="100%" p={3}>
            {/* Progress indicator */}
            <HStack spacing={3} w="100%" align="center">
                <Box flex={1} h="3px" bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} position="relative" overflow="hidden">
                    <Box
                        h="100%"
                        bg={SEMANTIC_COLORS.primary}
                        borderRadius={0}
                        transition="width 0.4s cubic-bezier(0.4, 0, 0.2, 1)"
                        width={`${((currentStep + 1) / totalSteps) * 100}%`}
                    />
                </Box>
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily={TYPOGRAPHY.fontMono} minW="45px" textAlign="right" fontWeight="medium">
                    {currentStep + 1}/{totalSteps}
                </Text>
            </HStack>

            {/* Step content */}
            <Box flex={1} overflowY="auto" py={3} px={1}>
                <VStack spacing={4} align="stretch">
                    <Text fontSize="md" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary} lineHeight="1.4">
                        {step.title}
                    </Text>
                    <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} lineHeight="1.7" letterSpacing="0.2px">
                        {step.content}
                    </Text>
                </VStack>
            </Box>

            {/* Navigation */}
            <HStack spacing={3} justify="space-between" w="100%" pt={3} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
                <Button
                    size="sm"
                    variant="ghost"
                    color={SEMANTIC_COLORS.textPrimary}
                    borderRadius={0}
                    fontFamily={TYPOGRAPHY.fontMono}
                    _hover={{ bg: 'transparent', color: SEMANTIC_COLORS.primary }}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                    _focusVisible={FOCUS_STYLES.ring}
                    onClick={onPrevious}
                    isDisabled={isFirstStep}
                    leftIcon={<ChevronLeftIcon />}
                    fontSize={TYPOGRAPHY.xs}
                    minW="80px"
                    transition={TRANSITIONS.colors}
                    opacity={isFirstStep ? 0.4 : 1}
                    cursor={isFirstStep ? 'not-allowed' : 'pointer'}
                >
                    Previous
                </Button>

                <Button
                    size="sm"
                    bg={SEMANTIC_COLORS.primary}
                    color={SEMANTIC_COLORS.bgPrimary}
                    borderRadius={0}
                    fontFamily={TYPOGRAPHY.fontMono}
                    _hover={HOVER_EFFECTS.borderHighlight}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                    _focusVisible={FOCUS_STYLES.ring}
                    onClick={isLastStep ? onFinish : onNext}
                    rightIcon={isLastStep ? undefined : <ChevronRightIcon />}
                    fontSize={TYPOGRAPHY.xs}
                    minW="80px"
                    transition={TRANSITIONS.colors}
                    fontWeight="semibold"
                >
                    {isLastStep ? 'Finish' : 'Next'}
                </Button>
            </HStack>
        </VStack>
    )
}


