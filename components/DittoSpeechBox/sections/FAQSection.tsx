import React, { useState, useRef, useEffect } from 'react'
import { VStack, Text, HStack, Box, Collapse, Icon } from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import { SectionComponentProps } from '../types'
import { FAQItem } from '../hooks/usePageTutorial'

interface FAQSectionProps extends SectionComponentProps {
    faqItems: FAQItem[]
}

export const FAQSection: React.FC<FAQSectionProps> = ({ faqItems, onBack }) => {
    const [openFaqItems, setOpenFaqItems] = useState<Set<string>>(new Set())
    const timeoutRef = useRef<NodeJS.Timeout | null>(null)

    const toggleFaqItem = (id: string) => {
        // Clear any existing timeout
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current)
        }

        // If clicking on the same item that's open, close it
        if (openFaqItems.has(id)) {
            setOpenFaqItems(new Set<string>())
            return
        }

        // If there's an item currently open, close it first
        if (openFaqItems.size > 0) {
            // Start closing animation immediately
            setOpenFaqItems(new Set<string>())

            // After closing animation completes, open the new item
            timeoutRef.current = setTimeout(() => {
                setOpenFaqItems(new Set([id]))
            }, 200) // Match the Collapse transition duration
        } else {
            // No item is open, open the clicked item immediately
            setOpenFaqItems(new Set([id]))
        }
    }

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current)
            }
        }
    }, [])

    if (faqItems.length === 0) {
        return (
            <VStack spacing={4} align="stretch" w="100%" p={2}>
                <Text fontSize="sm" fontWeight="bold" color="#ece6d8">
                    FAQ
                </Text>
                <Text fontSize="sm" color="#ece6d880">
                    No FAQ items available.
                </Text>
            </VStack>
        )
    }

    return (
        <VStack spacing={4} align="stretch" w="100%" h="100%" p={3} overflowY="auto">
            <Text fontSize="md" fontWeight="bold" color="#ece6d8" letterSpacing="0.5px" pb={2} borderBottom="1px solid" borderColor="#9bdc4f20">
                Frequently Asked Questions
            </Text>

            {faqItems.map((item) => (
                <Box
                    key={item.id}
                    w="100%"
                    bg="#1A1D26"
                    borderRadius="md"
                    border="1px solid"
                    borderColor="#9bdc4f20"
                    overflow="hidden"
                >
                    <Box
                        p={4}
                        cursor="pointer"
                        _hover={{ bg: '#9bdc4f20', transform: 'translateX(2px)' }}
                        _active={{ transform: 'translateX(0px)' }}
                        onClick={() => toggleFaqItem(item.id)}
                        transition="all 0.2s ease"
                        borderRadius="md"
                    >
                        <HStack justify="space-between" align="center" spacing={3}>
                            <Text fontSize="sm" fontWeight="semibold" color="#ece6d8" flex={1} lineHeight="1.5">
                                {item.question}
                            </Text>
                            <Icon
                                as={ChevronDownIcon}
                                color="#9bdc4f"
                                boxSize={5}
                                transform={openFaqItems.has(item.id) ? 'rotate(180deg)' : 'rotate(0deg)'}
                                transition="transform 0.3s ease"
                            />
                        </HStack>
                    </Box>
                    <Collapse in={openFaqItems.has(item.id)}>
                        <Box p={4} pt={0} pl={4}>
                            <Text fontSize="sm" color="#ece6d880" lineHeight="1.7" letterSpacing="0.2px">
                                {item.answer}
                            </Text>
                        </Box>
                    </Collapse>
                </Box>
            ))}
        </VStack>
    )
}


