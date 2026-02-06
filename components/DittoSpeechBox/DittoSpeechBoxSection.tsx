import React from 'react'
import { VStack, Box, Text, HStack, IconButton, Button, Icon } from '@chakra-ui/react'
import { ChevronLeftIcon, CloseIcon, QuestionIcon } from '@chakra-ui/icons'
import { BookOpen, HelpCircle } from 'lucide-react'
import { useDittoSpeechBox } from './hooks/useDittoSpeechBox'

interface DittoSpeechBoxSectionProps {
    title: string
    onBack: () => void
    onClose?: () => void
    children: React.ReactNode
    titleColor?: string
    showTutorialButton?: boolean
    onTutorialClick?: () => void
    onFAQClick?: () => void
}

export const DittoSpeechBoxSection: React.FC<DittoSpeechBoxSectionProps> = ({
    title,
    onBack,
    onClose,
    children,
    titleColor = "#F5F5F5",
    showTutorialButton = false,
    onTutorialClick,
    onFAQClick,
}) => {
    // const { currentView } = useDittoSpeechBox()

    return (
        <Box position="relative" w="100%" flex={1} overflow="hidden" display="flex" flexDirection="column">
            <VStack spacing={3} align="stretch" w="100%" position="relative" zIndex={5} bg="transparent" flex={1} overflow="hidden" minH={0}>
                {/* Header with Back, Title, and Close - always visible */}
                <Box w="100%" flexShrink={0} position="relative" zIndex={5}>
                    <HStack justify="space-between" align="center" mb={2} w="100%" minH="40px" spacing={2}>
                        <Button
                            size="xs"
                            variant="ghost"
                            leftIcon={<ChevronLeftIcon />}
                            onClick={onBack}
                            color="#F5F5F5"
                            _hover={{ bg: '#6943FF20' }}
                            flexShrink={0}
                            minW="60px"
                            width="20%"
                        >
                            {/* Back */}
                        </Button>
                        {/* Full title with border */}
                        {title === "Boost Breakdown" ? (
                            <Box
                                flex={1}
                                display="flex"
                                justifyContent="center"
                                alignItems="center"
                                transform="translate(-3%, 0%)"
                                position="relative"
                                zIndex={1}
                            >
                                <Box
                                    bgGradient="linear(to-r, purple.400, cyan.400)"
                                    p="2px"
                                    borderRadius="md"
                                    display="inline-block"
                                >
                                    <VStack
                                        spacing={0}
                                        align="center"
                                        justify="center"
                                        bg="#23252B"
                                        borderRadius="md"
                                        px={3}
                                        py={1}
                                    >
                                        <Text
                                            fontSize="xl"
                                            fontWeight="bold"
                                            color="#F5F5F5"
                                            lineHeight="1.2"
                                        >
                                            Boost
                                        </Text>
                                        <Text
                                            fontSize="xl"
                                            fontWeight="bold"
                                            color="#F5F5F5"
                                            lineHeight="1.2"
                                        >
                                            Breakdown
                                        </Text>
                                    </VStack>
                                </Box>
                            </Box>
                        ) : (
                            <Box
                                flex={1}
                                display="flex"
                                justifyContent="center"
                                alignItems="center"
                                transform={title === "Transmuter Lockdrop" ? "translate(0, 0%)" : "translate(-3%, 0%)"}
                                position="relative"
                                zIndex={1}
                            >
                                <Box
                                    bgGradient="linear(to-r, purple.400, cyan.400)"
                                    p="2px"
                                    borderRadius="md"
                                    display="inline-block"
                                >
                                    <Text
                                        fontSize="xl"
                                        fontWeight="bold"
                                        color="#F5F5F5"
                                        textAlign="center"
                                        px={3}
                                        py={1}
                                        bg="#23252B"
                                        borderRadius="md"
                                        noOfLines={title === "Transmuter Lockdrop" ? undefined : 1}
                                    >
                                        {title}
                                    </Text>
                                </Box>
                            </Box>
                        )}
                        <HStack spacing={2} flexShrink={0} minW="auto" justify="flex-end">
                            {showTutorialButton && onTutorialClick && (
                                <IconButton
                                    aria-label="Tutorial"
                                    icon={<Icon as={BookOpen} w={4} h={4} />}
                                    size="sm"
                                    variant="ghost"
                                    color="#F5F5F5"
                                    onClick={onTutorialClick}
                                    _hover={{ bg: '#6943FF20', color: '#6943FF', transform: 'scale(1.1)' }}
                                    _active={{ transform: 'scale(0.95)' }}
                                    title="Tutorial"
                                    transition="all 0.2s ease"
                                    borderRadius="md"
                                />
                            )}
                            {onFAQClick && (
                                <IconButton
                                    aria-label="FAQ"
                                    icon={<Icon as={HelpCircle} w={4} h={4} />}
                                    size="sm"
                                    variant="ghost"
                                    color="#F5F5F5"
                                    onClick={onFAQClick}
                                    _hover={{ bg: '#6943FF20', color: '#6943FF', transform: 'scale(1.1)' }}
                                    _active={{ transform: 'scale(0.95)' }}
                                    title="FAQ"
                                    transition="all 0.2s ease"
                                    borderRadius="md"
                                />
                            )}
                            <IconButton
                                aria-label="Close"
                                icon={<CloseIcon />}
                                size="sm"
                                variant="ghost"
                                color="#F5F5F5"
                                onClick={onClose || (() => { })}
                                _hover={{ bg: '#6943FF20', color: '#F5F5F5', transform: 'scale(1.1)' }}
                                _active={{ transform: 'scale(0.95)' }}
                                transition="all 0.2s ease"
                                borderRadius="md"
                            />
                        </HStack>
                    </HStack>
                </Box>
                {/* Content - scrollable when over max height */}
                <Box
                    w="100%"
                    flex={1}
                    minH={0}
                    overflowY="auto"
                    overflowX="hidden"
                    position="relative"
                    zIndex={5}
                    sx={{
                        '&::-webkit-scrollbar': {
                            width: '6px',
                        },
                        '&::-webkit-scrollbar-track': {
                            background: '#1a1a1a',
                            borderRadius: '3px',
                        },
                        '&::-webkit-scrollbar-thumb': {
                            background: '#6943FF60',
                            borderRadius: '3px',
                        },
                        '&::-webkit-scrollbar-thumb:hover': {
                            background: '#6943FF',
                        },
                    }}
                >
                    {children}
                </Box>
            </VStack>
        </Box>
    )
}

