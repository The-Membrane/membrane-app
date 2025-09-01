import React, { useState } from 'react'
import { Box, Button, Flex, HStack, Text, VStack, Alert, AlertIcon, AlertTitle, AlertDescription } from '@chakra-ui/react'
import { validateTrack, autoFixTrack, mirrorHorizontal, mirrorVertical, rotate90, rotate180, rotate270 } from '../utils/trackUtilities'
import { TrackValidation } from '../types/trackTemplates'

interface TrackUtilitiesProps {
    layout: any[][]
    onLayoutChange: (newLayout: any[][]) => void
}

const TrackUtilities: React.FC<TrackUtilitiesProps> = ({ layout, onLayoutChange }) => {
    const [validation, setValidation] = useState<TrackValidation | null>(null)

    const handleValidation = () => {
        const result = validateTrack(layout)
        setValidation(result)
    }

    const handleAutoFix = () => {
        const fixedLayout = autoFixTrack(layout)
        onLayoutChange(fixedLayout)
        const result = validateTrack(fixedLayout)
        setValidation(result)
    }



    const handleMirrorHorizontal = () => {
        const mirroredLayout = mirrorHorizontal(layout)
        onLayoutChange(mirroredLayout)
    }

    const handleMirrorVertical = () => {
        const mirroredLayout = mirrorVertical(layout)
        onLayoutChange(mirroredLayout)
    }

    const handleRotate90 = () => {
        const rotatedLayout = rotate90(layout)
        onLayoutChange(rotatedLayout)
    }

    const handleRotate180 = () => {
        const rotatedLayout = rotate180(layout)
        onLayoutChange(rotatedLayout)
    }

    const handleRotate270 = () => {
        const rotatedLayout = rotate270(layout)
        onLayoutChange(rotatedLayout)
    }

    return (
        <VStack spacing={4} align="stretch">
            {/* Validation Section */}
            <Box>
                <Text fontSize="sm" fontWeight="bold" mb={2}>Track Validation</Text>
                <HStack spacing={2}>
                    <Button
                        size="xs"
                        onClick={handleValidation}
                        colorScheme="blue"
                        bg="#274bff"
                        _hover={{ bg: "#1f3bd9" }}
                    >
                        Validate
                    </Button>
                    <Button
                        size="xs"
                        onClick={handleAutoFix}
                        colorScheme="green"
                        bg="#00aa00"
                        _hover={{ bg: "#008800" }}
                    >
                        Auto Fix
                    </Button>
                </HStack>

                {validation && (
                    <Box mt={3}>
                        {validation.errors.length > 0 && (
                            <Alert status="error" mb={2}>
                                <AlertIcon />
                                <Box>
                                    <AlertTitle>Errors</AlertTitle>
                                    {validation.errors.map((error, index) => (
                                        <AlertDescription key={index}>{error}</AlertDescription>
                                    ))}
                                </Box>
                            </Alert>
                        )}

                        {validation.warnings.length > 0 && (
                            <Alert status="warning" mb={2}>
                                <AlertIcon />
                                <Box>
                                    <AlertTitle>Warnings</AlertTitle>
                                    {validation.warnings.map((warning, index) => (
                                        <AlertDescription key={index}>{warning}</AlertDescription>
                                    ))}
                                </Box>
                            </Alert>
                        )}

                        {validation.suggestions.length > 0 && (
                            <Alert status="info" mb={2}>
                                <AlertIcon />
                                <Box>
                                    <AlertTitle>Suggestions</AlertTitle>
                                    {validation.suggestions.map((suggestion, index) => (
                                        <AlertDescription key={index}>{suggestion}</AlertDescription>
                                    ))}
                                </Box>
                            </Alert>
                        )}

                        {validation.isValid && validation.errors.length === 0 && (
                            <Alert status="success">
                                <AlertIcon />
                                <AlertTitle>Track is valid!</AlertTitle>
                            </Alert>
                        )}
                    </Box>
                )}
            </Box>

            {/* Transform Section */}
            <Box>
                <Text fontSize="sm" fontWeight="bold" mb={2}>Transform Track</Text>
                <VStack spacing={2} align="stretch">
                    <HStack spacing={2}>
                        <Button
                            size="sm"
                            onClick={handleMirrorHorizontal}
                            variant="outline"
                            borderColor="#2a3550"
                            _hover={{ bg: '#131a2b' }}
                            flex={1}
                        >
                            ↔
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleMirrorVertical}
                            variant="outline"
                            borderColor="#2a3550"
                            _hover={{ bg: '#131a2b' }}
                            flex={1}
                        >
                            ↕
                        </Button>
                    </HStack>

                    <HStack spacing={2}>
                        <Button
                            size="sm"
                            onClick={handleRotate90}
                            variant="outline"
                            borderColor="#2a3550"
                            _hover={{ bg: '#131a2b' }}
                            flex={1}
                        >
                            ↻
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleRotate180}
                            variant="outline"
                            borderColor="#2a3550"
                            _hover={{ bg: '#131a2b' }}
                            flex={1}
                        >
                            ↻↻
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleRotate270}
                            variant="outline"
                            borderColor="#2a3550"
                            _hover={{ bg: '#131a2b' }}
                            flex={1}
                        >
                            ↺
                        </Button>
                    </HStack>
                </VStack>
            </Box>

            {/* Track Info */}
            <Box p={3} border="1px solid #1d2333" borderRadius={6} bg="#0b0e17">
                <Text fontSize="sm" fontWeight="bold" mb={2}>Track Information</Text>
                <VStack spacing={1} align="stretch">
                    <Text fontSize="xs">Size: {layout[0]?.length || 0} × {layout.length}</Text>
                    <Text fontSize="xs">Start Tiles: {layout.reduce((sum, row) => sum + row.filter(t => t.is_start).length, 0)}</Text>
                    <Text fontSize="xs">Finish Tiles: {layout.reduce((sum, row) => sum + row.filter(t => t.is_finish).length, 0)}</Text>
                    <Text fontSize="xs">Wall Tiles: {layout.reduce((sum, row) => sum + row.filter(t => t.blocks_movement).length, 0)}</Text>
                    <Text fontSize="xs">Boost Tiles: {layout.reduce((sum, row) => sum + row.filter(t => t.speed_modifier > 1).length, 0)}</Text>
                    <Text fontSize="xs">Sticky Tiles: {layout.reduce((sum, row) => sum + row.filter(t => t.skip_next_turn).length, 0)}</Text>
                </VStack>
            </Box>
        </VStack>
    )
}

export default TrackUtilities
