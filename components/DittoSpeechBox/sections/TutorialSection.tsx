import React from 'react'
import { VStack, HStack, Text, Button, Box } from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import { SectionComponentProps } from '../types'
import { TutorialStep } from '../hooks/usePageTutorial'

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
                <Box flex={1} h="3px" bg="#6943FF20" borderRadius="full" position="relative" overflow="hidden">
                    <Box
                        h="100%"
                        bg="linear-gradient(90deg, #6943FF, #7C5AFF)"
                        borderRadius="full"
                        transition="width 0.4s cubic-bezier(0.4, 0, 0.2, 1)"
                        width={`${((currentStep + 1) / totalSteps) * 100}%`}
                        boxShadow="0 0 8px rgba(105, 67, 255, 0.5)"
                    />
                </Box>
                <Text fontSize="xs" color="#F5F5F580" fontFamily="mono" minW="45px" textAlign="right" fontWeight="medium">
                    {currentStep + 1}/{totalSteps}
                </Text>
            </HStack>

            {/* Step content */}
            <Box flex={1} overflowY="auto" py={3} px={1}>
                <VStack spacing={4} align="stretch">
                    <Text fontSize="md" fontWeight="bold" color="#F5F5F5" lineHeight="1.4">
                        {step.title}
                    </Text>
                    <Text fontSize="sm" color="#F5F5F580" lineHeight="1.7" letterSpacing="0.2px">
                        {step.content}
                    </Text>
                </VStack>
            </Box>

            {/* Navigation */}
            <HStack spacing={3} justify="space-between" w="100%" pt={3} borderTop="1px solid" borderColor="#6943FF20">
                <Button
                    size="sm"
                    variant="ghost"
                    color="#F5F5F5"
                    _hover={{ bg: '#6943FF20', color: '#6943FF' }}
                    _active={{ transform: 'scale(0.95)' }}
                    onClick={onPrevious}
                    isDisabled={isFirstStep}
                    leftIcon={<ChevronLeftIcon />}
                    fontSize="xs"
                    minW="80px"
                    transition="all 0.2s ease"
                    opacity={isFirstStep ? 0.4 : 1}
                    cursor={isFirstStep ? 'not-allowed' : 'pointer'}
                >
                    Previous
                </Button>

                <Button
                    size="sm"
                    bg="#6943FF"
                    color="white"
                    _hover={{ bg: '#7C5AFF', transform: 'scale(1.05)', boxShadow: '0 0 15px rgba(105, 67, 255, 0.5)' }}
                    _active={{ transform: 'scale(0.95)' }}
                    onClick={isLastStep ? onFinish : onNext}
                    rightIcon={isLastStep ? undefined : <ChevronRightIcon />}
                    fontSize="xs"
                    minW="80px"
                    transition="all 0.2s ease"
                    fontWeight="semibold"
                >
                    {isLastStep ? 'Finish' : 'Next'}
                </Button>
            </HStack>
        </VStack>
    )
}


