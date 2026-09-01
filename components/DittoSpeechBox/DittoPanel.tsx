import React, { useState } from 'react'
import { Box, HStack, Text, IconButton, Icon, Tabs, TabList, Tab, TabPanels, TabPanel } from '@chakra-ui/react'
import { CloseIcon } from '@chakra-ui/icons'
import { AlertCircle, MessageSquare } from 'lucide-react'
import { m, AnimatePresence } from 'framer-motion'
import { StatusTab } from './tabs/StatusTab'
import { LearnTab } from './tabs/LearnTab'
import { FeedbackTab } from './tabs/FeedbackTab'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

const MotionBox = m(Box)

interface DittoPanelProps {
    isVisible: boolean
    onClose: () => void
}

/**
 * DittoPanel - The main refactored Ditto UI
 *
 * Tabs: Status | Learn | Feedback
 */
export const DittoPanel: React.FC<DittoPanelProps> = ({ isVisible, onClose }) => {
    const [activeTab, setActiveTab] = useState(0)

    if (!isVisible) return null

    return (
        <AnimatePresence>
            <MotionBox
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 20, scale: 0.95 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                w="450px"
                h="500px"
                maxH="700px"
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                overflow="hidden"
                display="flex"
                flexDirection="column"
            >
                {/* Close button */}
                <Box position="relative">
                    <IconButton
                        aria-label="Close"
                        icon={<CloseIcon w={2} h={2} />}
                        size="xs"
                        variant="ghost"
                        color={SEMANTIC_COLORS.textSecondary}
                        borderRadius={0}
                        position="absolute"
                        top={SPACING.xs}
                        right={SPACING.xs}
                        w="15%"
                        minW="unset"
                        h="24px"
                        zIndex={1}
                        transition={TRANSITIONS.colors}
                        _hover={{ ...HOVER_EFFECTS.brighten, bg: 'transparent' }}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        onClick={onClose}
                    />
                </Box>

                {/* Tabs */}
                <Tabs
                    variant="unstyled"
                    index={activeTab}
                    onChange={setActiveTab}
                    flex={1}
                    display="flex"
                    flexDirection="column"
                    overflow="hidden"
                >
                    <TabList
                        px={SPACING.base}
                        pt={SPACING.md}
                        pb={SPACING.sm}
                        gap={SPACING.sm}
                        borderBottom="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        overflowX="auto"
                        overflowY="hidden"
                        flexShrink={0}
                        css={{
                            scrollbarWidth: 'none',
                            '&::-webkit-scrollbar': { display: 'none' },
                        }}
                    >
                        <Tab
                            px={SPACING.base}
                            py={SPACING.xs}
                            borderRadius={0}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            fontWeight={TYPOGRAPHY.medium}
                            flexShrink={0}
                            color={activeTab === 0 ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
                            bg="transparent"
                            borderBottom="2px solid"
                            borderColor={activeTab === 0 ? SEMANTIC_COLORS.primary : 'transparent'}
                            transition={TRANSITIONS.colors}
                            _hover={HOVER_EFFECTS.brighten}
                            _focus={FOCUS_STYLES.ring}
                            _focusVisible={FOCUS_STYLES.ring}
                        >
                            <HStack spacing={SPACING.sm}>
                                <Icon as={AlertCircle} w={4} h={4} color={activeTab === 0 ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary} />
                                <Text>Status</Text>
                            </HStack>
                        </Tab>
                        <Tab
                            px={SPACING.base}
                            py={SPACING.xs}
                            borderRadius={0}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            fontWeight={TYPOGRAPHY.medium}
                            flexShrink={0}
                            color={activeTab === 1 ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
                            bg="transparent"
                            borderBottom="2px solid"
                            borderColor={activeTab === 1 ? SEMANTIC_COLORS.primary : 'transparent'}
                            transition={TRANSITIONS.colors}
                            _hover={HOVER_EFFECTS.brighten}
                            _focus={FOCUS_STYLES.ring}
                            _focusVisible={FOCUS_STYLES.ring}
                        >
                            Learn
                        </Tab>
                        <Tab
                            px={SPACING.base}
                            py={SPACING.xs}
                            borderRadius={0}
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            fontWeight={TYPOGRAPHY.medium}
                            flexShrink={0}
                            color={activeTab === 2 ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
                            bg="transparent"
                            borderBottom="2px solid"
                            borderColor={activeTab === 2 ? SEMANTIC_COLORS.primary : 'transparent'}
                            transition={TRANSITIONS.colors}
                            _hover={HOVER_EFFECTS.brighten}
                            _focus={FOCUS_STYLES.ring}
                            _focusVisible={FOCUS_STYLES.ring}
                        >
                            <HStack spacing={SPACING.sm}>
                                <Icon as={MessageSquare} w={4} h={4} color={activeTab === 2 ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary} />
                                <Text>Feedback</Text>
                            </HStack>
                        </Tab>
                    </TabList>

                    <TabPanels flex={1} overflow="hidden">
                        <TabPanel p={0} h="100%">
                            <StatusTab />
                        </TabPanel>
                        <TabPanel p={0} h="100%">
                            <LearnTab />
                        </TabPanel>
                        <TabPanel p={0} h="100%">
                            <FeedbackTab />
                        </TabPanel>
                    </TabPanels>
                </Tabs>
            </MotionBox>
        </AnimatePresence>
    )
}

export default DittoPanel
