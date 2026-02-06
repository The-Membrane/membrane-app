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

        setOpenFaqItems((prev) => {
            const newSet = new Set<string>()

            // If clicking on the same item that's open, close it
            if (prev.has(id)) {
                return newSet
            }

            // If there's an item currently open, close it first
            if (prev.size > 0) {
                // Start closing animation immediately
                setOpenFaqItems(new Set<string>())

                // After closing animation completes, open the new item
                timeoutRef.current = setTimeout(() => {
                    setOpenFaqItems(new Set([id]))
                }, 200) // Match the Collapse transition duration

                return prev // Return current state for immediate close
            } else {
                // No item is open, open the clicked item immediately
                newSet.add(id)
                return newSet
            }
        })
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
                <Text fontSize="sm" fontWeight="bold" color="#F5F5F5">
                    FAQ
                </Text>
                <Text fontSize="sm" color="#F5F5F580">
                    No FAQ items available.
                </Text>
            </VStack>
        )
    }

    return (
        <VStack spacing={4} align="stretch" w="100%" h="100%" p={3} overflowY="auto">
            <Text fontSize="md" fontWeight="bold" color="#F5F5F5" letterSpacing="0.5px" pb={2} borderBottom="1px solid" borderColor="#6943FF20">
                Frequently Asked Questions
            </Text>

            {faqItems.map((item) => (
                <Box
                    key={item.id}
                    w="100%"
                    bg="#1A1D26"
                    borderRadius="md"
                    border="1px solid"
                    borderColor="#6943FF20"
                    overflow="hidden"
                >
                    <Box
                        p={4}
                        cursor="pointer"
                        _hover={{ bg: '#6943FF20', transform: 'translateX(2px)' }}
                        _active={{ transform: 'translateX(0px)' }}
                        onClick={() => toggleFaqItem(item.id)}
                        transition="all 0.2s ease"
                        borderRadius="md"
                    >
                        <HStack justify="space-between" align="center" spacing={3}>
                            <Text fontSize="sm" fontWeight="semibold" color="#F5F5F5" flex={1} lineHeight="1.5">
                                {item.question}
                            </Text>
                            <Icon
                                as={ChevronDownIcon}
                                color="#6943FF"
                                boxSize={5}
                                transform={openFaqItems.has(item.id) ? 'rotate(180deg)' : 'rotate(0deg)'}
                                transition="transform 0.3s ease"
                            />
                        </HStack>
                    </Box>
                    <Collapse in={openFaqItems.has(item.id)}>
                        <Box p={4} pt={0} pl={4}>
                            <Text fontSize="sm" color="#F5F5F580" lineHeight="1.7" letterSpacing="0.2px">
                                {item.answer}
                            </Text>
                        </Box>
                    </Collapse>
                </Box>
            ))}
        </VStack>
    )
}


