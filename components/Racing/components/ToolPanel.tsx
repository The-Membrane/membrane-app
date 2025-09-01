import React, { useState } from 'react'
import { Box, Button, Flex, HStack, Text, VStack } from '@chakra-ui/react'
import { ChevronLeftIcon } from '@chakra-ui/icons'
import TemplateSelector from './TemplateSelector'
import TrackUtilities from './TrackUtilities'

type ToolView = 'main' | 'templates' | 'utilities'

interface ToolPanelProps {
    onTemplateSelect: (template: any) => void
    onLayoutChange: (newLayout: any[][]) => void
    layout: any[][]
}

const ToolPanel: React.FC<ToolPanelProps> = ({
    onTemplateSelect,
    onLayoutChange,
    layout
}) => {
    const [currentView, setCurrentView] = useState<ToolView>('main')

    const renderMainView = () => (
        <VStack align="stretch" spacing={4}>
            <Text fontSize="lg" fontWeight="bold">Helpers</Text>

            <VStack align="stretch" spacing={2}>
                <Button
                    size="sm"
                    onClick={() => setCurrentView('templates')}
                    variant="outline"
                    borderColor="#2a3550"
                    _hover={{ bg: '#131a2b' }}
                >
                    Templates
                </Button>
                <Button
                    size="sm"
                    onClick={() => setCurrentView('utilities')}
                    variant="outline"
                    borderColor="#2a3550"
                    _hover={{ bg: '#131a2b' }}
                >
                    Utilities
                </Button>
            </VStack>
        </VStack>
    )

    const renderTemplatesView = () => (
        <VStack align="stretch" spacing={4}>
            <Flex align="center" justify="space-between">
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCurrentView('main')}
                    leftIcon={<ChevronLeftIcon />}
                    color="#e6e6e6"
                    _hover={{ bg: '#131a2b' }}
                >
                    Back
                </Button>
                <Text fontSize="lg" fontWeight="bold">Templates</Text>
                <Box w="40px" /> {/* Spacer for centering */}
            </Flex>

            <TemplateSelector onTemplateSelect={onTemplateSelect} />
        </VStack>
    )



    const renderUtilitiesView = () => (
        <VStack align="stretch" spacing={4}>
            <Flex align="center" justify="space-between">
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCurrentView('main')}
                    leftIcon={<ChevronLeftIcon />}
                    color="#e6e6e6"
                    _hover={{ bg: '#131a2b' }}
                >
                    Back
                </Button>
                <Text fontSize="lg" fontWeight="bold">Utilities</Text>
                <Box w="40px" /> {/* Spacer for centering */}
            </Flex>

            <TrackUtilities layout={layout} onLayoutChange={onLayoutChange} />
        </VStack>
    )

    const renderCurrentView = () => {
        switch (currentView) {
            case 'templates':
                return renderTemplatesView()
            case 'utilities':
                return renderUtilitiesView()
            default:
                return renderMainView()
        }
    }

    return (
        <Box overflow="hidden">
            {renderCurrentView()}
        </Box>
    )
}

export default ToolPanel
