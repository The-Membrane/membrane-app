import React from 'react'
import {
    Box,
    Button,
    Text,
    HStack,
    VStack,
    IconButton,
    useBreakpointValue,
    Portal,
} from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from '@chakra-ui/icons'
import useAppState from '@/persisted-state/useAppState'

export interface TutorialStep {
    id: string
    title: string
    content: string
    position: 'left' | 'right' | 'top' | 'bottom'
    targetSelector?: string
    targetElement?: HTMLElement
    targetTab?: 'car' | 'race' | 'create'
}

interface TutorialOverlayProps {
    isOpen: boolean
    onClose: () => void
    steps: TutorialStep[]
    currentStep: number
    onNext: () => void
    onPrevious: () => void
    onSkip: () => void
}

const TutorialOverlay: React.FC<TutorialOverlayProps> = ({
    isOpen,
    onClose,
    steps,
    currentStep,
    onNext,
    onPrevious,
    onSkip,
}) => {
    const isMobile = useBreakpointValue({ base: true, md: false })

    if (!isOpen || currentStep >= steps.length) return null

    const step = steps[currentStep]
    const isFirstStep = currentStep === 0
    const isLastStep = currentStep === steps.length - 1

    // Calculate position based on step configuration
    const getPositionStyles = () => {
        const baseStyles = {
            position: 'absolute' as const,
            zIndex: 1000,
            maxW: isMobile ? '280px' : '350px',
            bg: '#0a0f1e',
            border: '2px solid #0033ff',
            borderRadius: '8px',
            p: 4,
            boxShadow: '0 0 20px rgba(0, 51, 255, 0.3)',
        }

        // On mobile, always center the modal
        if (isMobile) {
            return {
                ...baseStyles,
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                position: 'fixed' as const,
                width: '90vw',
                maxW: '320px'
            }
        }

        // Desktop positioning
        switch (step.position) {
            case 'left':
                return { ...baseStyles, right: '2vw', top: '50%', transform: 'translateY(-50%)' }
            case 'right':
                return { ...baseStyles, left: '2vw', top: '50%', transform: 'translateY(-50%)' }
            case 'top':
                return { ...baseStyles, bottom: '60%', left: '50%', transform: 'translateX(-50%)' }
            case 'bottom':
                return { ...baseStyles, top: '2vh', left: '50%', transform: 'translateX(-50%)' }
            default:
                return { ...baseStyles, right: '2vw', top: '50%', transform: 'translateY(-50%)' }
        }
    }

    return (
        <Portal>
            {/* Backdrop */}
            <Box
                position="fixed"
                top={0}
                left={0}
                right={0}
                bottom={0}
                bg="rgba(0, 0, 0, 0.7)"
                zIndex={999}
                onClick={onClose}
            />

            {/* Tutorial Tooltip */}
            <Box {...getPositionStyles()}>
                <VStack spacing={4} align="stretch">
                    {/* Header */}
                    <HStack justify="space-between" align="center">
                        <Text
                            fontFamily='"Press Start 2P", monospace'
                            fontSize={isMobile ? '10px' : '12px'}
                            color="#00ffea"
                            fontWeight="bold"
                        >
                            {step.title}
                        </Text>
                        <IconButton
                            aria-label="Close tutorial"
                            icon={<CloseIcon />}
                            size="sm"
                            variant="ghost"
                            color="#b8c1ff"
                            _hover={{ color: '#ffffff' }}
                            onClick={onSkip}
                        />
                    </HStack>

                    {/* Content */}
                    <Text fontSize="sm" color="#e6e6e6" lineHeight="1.5">
                        {step.content}
                    </Text>

                    {/* Progress and Navigation */}
                    <VStack spacing={2}>
                        {/* Progress */}
                        <Text fontSize="xs" color="#b8c1ff" textAlign="center">
                            {currentStep + 1} / {steps.length}
                        </Text>

                        {/* Navigation */}
                        <HStack spacing={2} justify="center">
                            <Button
                                size="sm"
                                variant="outline"
                                borderColor="#0033ff"
                                color="#b8c1ff"
                                _hover={{ borderColor: '#00ffea', color: '#00ffea' }}
                                onClick={onPrevious}
                                isDisabled={isFirstStep}
                                fontFamily='"Press Start 2P", monospace'
                                fontSize="10px"
                                leftIcon={<ChevronLeftIcon />}
                            >
                                PREV
                            </Button>

                            <Button
                                size="sm"
                                bg="#0033ff"
                                color="white"
                                _hover={{ bg: '#0044ff' }}
                                onClick={isLastStep ? onClose : onNext}
                                fontFamily='"Press Start 2P", monospace'
                                fontSize="10px"
                                rightIcon={isLastStep ? undefined : <ChevronRightIcon />}
                            >
                                {isLastStep ? 'FINISH' : 'NEXT'}
                            </Button>
                        </HStack>
                    </VStack>
                </VStack>
            </Box>
        </Portal>
    )
}

export default TutorialOverlay
