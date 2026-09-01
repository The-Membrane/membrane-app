import React, { useState, useRef, useEffect } from 'react'
import { VStack, Text, HStack, Box, Collapse, Icon } from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import { SectionComponentProps } from '../types'
import { FAQItem } from '../hooks/usePageTutorial'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

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
                <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary}>
                    FAQ
                </Text>
                <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary}>
                    No FAQ items available.
                </Text>
            </VStack>
        )
    }

    return (
        <VStack spacing={4} align="stretch" w="100%" h="100%" p={3} overflowY="auto">
            <Text fontSize="md" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary} letterSpacing="0.5px" pb={2} borderBottom="1px solid" borderColor="#9bdc4f20">
                Frequently Asked Questions
            </Text>

            {faqItems.map((item) => (
                <Box
                    key={item.id}
                    w="100%"
                    bg={SEMANTIC_COLORS.bgSecondary}
                    borderRadius={0}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    overflow="hidden"
                >
                    <Box
                        p={SPACING.base}
                        cursor="pointer"
                        role="button"
                        tabIndex={0}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.brighten}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        onClick={() => toggleFaqItem(item.id)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                toggleFaqItem(item.id)
                            }
                        }}
                        borderRadius={0}
                    >
                        <HStack justify="space-between" align="center" spacing={3}>
                            <Text fontSize="sm" fontWeight="semibold" color={SEMANTIC_COLORS.textPrimary} flex={1} lineHeight="1.5">
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
                            <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} lineHeight="1.7" letterSpacing="0.2px">
                                {item.answer}
                            </Text>
                        </Box>
                    </Collapse>
                </Box>
            ))}
        </VStack>
    )
}


