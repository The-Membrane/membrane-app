import React, { useState } from 'react'
import { Box, Button, Flex, Grid, GridItem, HStack, Text, VStack, Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalCloseButton, useDisclosure } from '@chakra-ui/react'
import { layoutPatterns } from '../utils/layoutPatterns'
import { LayoutPattern } from '../types/trackTemplates'

interface LayoutPatternSelectorProps {
    onPatternApply: (pattern: LayoutPattern) => void
}

const LayoutPatternSelector: React.FC<LayoutPatternSelectorProps> = ({ onPatternApply }) => {
    const { isOpen, onOpen, onClose } = useDisclosure()
    const [selectedPattern, setSelectedPattern] = useState<LayoutPattern | null>(null)

    const patternTypes = [
        { key: 'all', label: 'All Patterns' },
        { key: 'border', label: 'Border Patterns' },
        { key: 'center', label: 'Center Patterns' },
        { key: 'grid', label: 'Grid Patterns' },
        { key: 'spiral', label: 'Spiral Patterns' },
        { key: 'labyrinth', label: 'Labyrinth Patterns' },
        { key: 'symmetrical', label: 'Symmetrical Patterns' }
    ]

    const filteredPatterns = selectedPattern ? [selectedPattern] : layoutPatterns

    const renderPatternPreview = (pattern: LayoutPattern) => {
        // Create a sample 10x10 layout to demonstrate the pattern
        const sampleLayout = Array.from({ length: 10 }, () =>
            Array.from({ length: 10 }, () => ({
                speed_modifier: 1,
                blocks_movement: false,
                skip_next_turn: false,
                damage: 0,
                is_finish: false,
                is_start: false,
            }))
        )

        const previewLayout = pattern.apply(sampleLayout)
        const cellSize = 4
        const maxSize = 60

        return (
            <Box
                w={`${maxSize}px`}
                h={`${maxSize}px`}
                border="1px solid #2a3550"
                bg="#0b0e17"
                display="inline-block"
            >
                <Grid
                    templateColumns={`repeat(10, ${cellSize}px)`}
                    gap="1px"
                    bg="#1d2333"
                >
                    {previewLayout.map((row, y) =>
                        row.map((tile, x) => {
                            const color = tile.blocks_movement ? '#0033ff'
                                : tile.is_finish ? '#00ff00'
                                    : tile.is_start ? 'red'
                                        : tile.skip_next_turn ? '#555555'
                                            : tile.speed_modifier > 1 ? '#ffdd00'
                                                : '#111111'
                            return (
                                <GridItem
                                    key={`${x}-${y}`}
                                    w={`${cellSize}px`}
                                    h={`${cellSize}px`}
                                    bg={color}
                                />
                            )
                        })
                    )}
                </Grid>
            </Box>
        )
    }

    const handlePatternApply = () => {
        if (selectedPattern) {
            onPatternApply(selectedPattern)
            onClose()
        }
    }

    return (
        <>
            <Button
                size="sm"
                onClick={onOpen}
                variant="outline"
                borderColor="#2a3550"
                _hover={{ bg: '#131a2b' }}
            >
                Patterns
            </Button>

            <Modal isOpen={isOpen} onClose={onClose} size="xl">
                <ModalOverlay />
                <ModalContent bg="#0f1422" color="#e6e6e6" border="1px solid #1d2333">
                    <ModalHeader borderBottom="1px solid #1d2333">Layout Patterns</ModalHeader>
                    <ModalCloseButton />
                    <ModalBody p={4}>
                        <VStack spacing={4} align="stretch">
                            {/* Pattern Type Filter */}
                            <HStack spacing={2} overflowX="auto" pb={2}>
                                {patternTypes.map(type => (
                                    <Button
                                        key={type.key}
                                        size="sm"
                                        variant="outline"
                                        colorScheme="blue"
                                        onClick={() => setSelectedPattern(null)}
                                        bg="transparent"
                                        borderColor="#2a3550"
                                        _hover={{ bg: '#131a2b' }}
                                    >
                                        {type.label}
                                    </Button>
                                ))}
                            </HStack>

                            {/* Selected Pattern Controls */}
                            {selectedPattern && (
                                <Box p={3} border="1px solid #1d2333" borderRadius={6} bg="#0b0e17">
                                    <VStack spacing={3}>
                                        <Text fontSize="sm" fontWeight="bold">
                                            Selected: {selectedPattern.name}
                                        </Text>
                                        <Text fontSize="xs" opacity={0.7}>
                                            {selectedPattern.description}
                                        </Text>

                                        <Box>
                                            {renderPatternPreview(selectedPattern)}
                                        </Box>

                                        <Button
                                            size="sm"
                                            colorScheme="green"
                                            onClick={handlePatternApply}
                                            bg="#00aa00"
                                            _hover={{ bg: "#008800" }}
                                        >
                                            Apply Pattern
                                        </Button>
                                    </VStack>
                                </Box>
                            )}

                            {/* Patterns Grid */}
                            <Grid templateColumns="repeat(auto-fill, minmax(200px, 1fr))" gap={4}>
                                {filteredPatterns.map(pattern => (
                                    <GridItem key={pattern.name}>
                                        <Box
                                            p={3}
                                            border="1px solid #1d2333"
                                            borderRadius={6}
                                            bg="#0b0e17"
                                            cursor="pointer"
                                            _hover={{ bg: '#131a2b', borderColor: '#2a3550' }}
                                            onClick={() => setSelectedPattern(pattern)}
                                        >
                                            <VStack spacing={2} align="center">
                                                <Text fontSize="sm" fontWeight="bold" textAlign="center">
                                                    {pattern.name}
                                                </Text>
                                                <Text fontSize="xs" opacity={0.7} textAlign="center">
                                                    {pattern.description}
                                                </Text>
                                                <Box>
                                                    {renderPatternPreview(pattern)}
                                                </Box>
                                                <Text fontSize="xs" opacity={0.6} textTransform="capitalize">
                                                    {pattern.type} Pattern
                                                </Text>
                                            </VStack>
                                        </Box>
                                    </GridItem>
                                ))}
                            </Grid>

                            {filteredPatterns.length === 0 && (
                                <Text textAlign="center" opacity={0.6}>
                                    No patterns found for this category.
                                </Text>
                            )}
                        </VStack>
                    </ModalBody>
                </ModalContent>
            </Modal>
        </>
    )
}

export default LayoutPatternSelector
