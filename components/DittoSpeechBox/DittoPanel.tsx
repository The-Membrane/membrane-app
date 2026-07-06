import React, { useState } from 'react'
import { Box, HStack, Text, IconButton, Icon, Tabs, TabList, Tab, TabPanels, TabPanel } from '@chakra-ui/react'
import { CloseIcon } from '@chakra-ui/icons'
import { AlertCircle, MessageSquare } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { StatusTab } from './tabs/StatusTab'
import { LearnTab } from './tabs/LearnTab'
import { FeedbackTab } from './tabs/FeedbackTab'

const MotionBox = motion(Box)

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
                bg="#15171E"
                border="1px solid"
                borderColor="#6943FF40"
                borderRadius="xl"
                overflow="hidden"
                boxShadow="0 8px 32px rgba(105, 67, 255, 0.15), 0 0 0 1px rgba(105, 67, 255, 0.1)"
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
                        color="#F5F5F580"
                        position="absolute"
                        top={1}
                        right={1}
                        w="15%"
                        minW="unset"
                        h="24px"
                        zIndex={1}
                        _hover={{ bg: '#6943FF20', color: '#F5F5F5' }}
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
                        px={4}
                        pt={3}
                        pb={2}
                        gap={2}
                        borderBottom="1px solid"
                        borderColor="#6943FF10"
                        overflowX="auto"
                        overflowY="hidden"
                        flexShrink={0}
                        css={{
                            scrollbarWidth: 'none',
                            '&::-webkit-scrollbar': { display: 'none' },
                        }}
                    >
                        <Tab
                            px={4}
                            py={1.5}
                            borderRadius="md"
                            fontSize="sm"
                            fontWeight="medium"
                            flexShrink={0}
                            color={activeTab === 0 ? '#F5F5F5' : '#F5F5F580'}
                            bg={activeTab === 0 ? '#6943FF30' : 'transparent'}
                            borderBottom={activeTab === 0 ? '2px solid' : '2px solid transparent'}
                            borderColor={activeTab === 0 ? 'cyan.400' : 'transparent'}
                            _hover={{ bg: activeTab === 0 ? undefined : '#6943FF10' }}
                            transition="all 0.2s"
                        >
                            <HStack spacing={2}>
                                <Icon as={AlertCircle} w={4} h={4} color={activeTab === 0 ? 'cyan.400' : '#F5F5F580'} />
                                <Text>Status</Text>
                            </HStack>
                        </Tab>
                        <Tab
                            px={4}
                            py={1.5}
                            borderRadius="md"
                            fontSize="sm"
                            fontWeight="medium"
                            flexShrink={0}
                            color={activeTab === 1 ? '#F5F5F5' : '#F5F5F580'}
                            bg={activeTab === 1 ? '#6943FF30' : 'transparent'}
                            borderBottom={activeTab === 1 ? '2px solid' : '2px solid transparent'}
                            borderColor={activeTab === 1 ? 'purple.400' : 'transparent'}
                            _hover={{ bg: activeTab === 1 ? undefined : '#6943FF10' }}
                            transition="all 0.2s"
                        >
                            Learn
                        </Tab>
                        <Tab
                            px={4}
                            py={1.5}
                            borderRadius="md"
                            fontSize="sm"
                            fontWeight="medium"
                            flexShrink={0}
                            color={activeTab === 2 ? '#F5F5F5' : '#F5F5F580'}
                            bg={activeTab === 2 ? '#6943FF30' : 'transparent'}
                            borderBottom={activeTab === 2 ? '2px solid' : '2px solid transparent'}
                            borderColor={activeTab === 2 ? 'cyan.400' : 'transparent'}
                            _hover={{ bg: activeTab === 2 ? undefined : '#6943FF10' }}
                            transition="all 0.2s"
                        >
                            <HStack spacing={2}>
                                <Icon as={MessageSquare} w={4} h={4} color={activeTab === 2 ? 'cyan.400' : '#F5F5F580'} />
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
