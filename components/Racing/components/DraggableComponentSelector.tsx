import React, { useState, useRef } from 'react'
import { Box, Button, Flex, Grid, GridItem, HStack, Text, VStack, Select } from '@chakra-ui/react'
import { trackComponents } from '../utils/trackComponents'
import { TrackComponent } from '../types/trackTemplates'

interface DraggableComponentSelectorProps {
    onComponentPlace: (component: TrackComponent, x: number, y: number, rotation: number, mirrored: boolean) => void
    trackWidth: number
    trackHeight: number
    onPlacementModeChange: (isActive: boolean) => void
}

const DraggableComponentSelector: React.FC<DraggableComponentSelectorProps> = ({
    onComponentPlace,
    trackWidth,
    trackHeight,
    onPlacementModeChange
}) => {
    const [selectedCategory, setSelectedCategory] = useState<string>('all')
    const [selectedComponent, setSelectedComponent] = useState<TrackComponent | null>(null)
    const [rotation, setRotation] = useState<number>(0)
    const [mirrored, setMirrored] = useState<boolean>(false)
    const [isDragging, setIsDragging] = useState<boolean>(false)
    const [dragPosition, setDragPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

    const categories = [
        { key: 'all', label: 'All Components' },
        { key: 'corner', label: 'Corners' },
        { key: 'straight', label: 'Straights' },
        { key: 'obstacle', label: 'Obstacles' },
        { key: 'power-up', label: 'Power-ups' },
        { key: 'hazard', label: 'Hazards' },
        { key: 'start-finish', label: 'Start/Finish' }
    ]

    const filteredComponents = selectedCategory === 'all'
        ? trackComponents
        : trackComponents.filter(c => c.category === selectedCategory)

    const renderComponentPreview = (component: TrackComponent, rot: number = 0, mirror: boolean = false) => {
        const cellSize = 4
        const maxWidth = 40
        const maxHeight = 40

        let displayLayout = component.layout

        // Apply rotation
        for (let i = 0; i < rot; i++) {
            displayLayout = rotate90(displayLayout)
        }

        // Apply mirroring
        if (mirror) {
            displayLayout = mirrorHorizontal(displayLayout)
        }

        const scaleX = Math.min(maxWidth / component.width, maxHeight / component.height)
        const scaleY = scaleX
        const displayWidth = Math.floor(component.width * scaleX)
        const displayHeight = Math.floor(component.height * scaleY)

        return (
            <Box
                w={`${displayWidth}px`}
                h={`${displayHeight}px`}
                border="1px solid #2a3550"
                bg="#0b0e17"
                display="inline-block"
                overflow="hidden"
            >
                <Grid
                    templateColumns={`repeat(${displayLayout[0]?.length || 0}, ${cellSize}px)`}
                    gap="1px"
                    bg="#1d2333"
                    transform={`scale(${scaleX}, ${scaleY})`}
                    transformOrigin="top left"
                >
                    {displayLayout.map((row, y) =>
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

    const rotate90 = (layout: any[][]): any[][] => {
        const height = layout.length
        const width = layout[0]?.length ?? 0
        const rotated: any[][] = []

        for (let x = 0; x < width; x++) {
            rotated[x] = []
            for (let y = height - 1; y >= 0; y--) {
                rotated[x][height - 1 - y] = layout[y][x]
            }
        }

        return rotated
    }

    const mirrorHorizontal = (layout: any[][]): any[][] => {
        return layout.map(row => row.slice().reverse())
    }

    const handleDragStart = (e: React.DragEvent, component: TrackComponent) => {
        setSelectedComponent(component)
        setIsDragging(true)
        e.dataTransfer.setData('text/plain', component.name)
        e.dataTransfer.effectAllowed = 'copy'
    }

    const handleDragEnd = () => {
        setIsDragging(false)
        setSelectedComponent(null)
    }

    const handlePlacementClick = () => {
        if (selectedComponent) {
            // Set the component for placement and enable placement mode
            onPlacementComponentSet(selectedComponent, rotation, mirrored)
            onPlacementModeChange(true)
        }
    }

    return (
        <VStack spacing={4} align="stretch">
            {/* Category Filter */}
            <HStack spacing={2} overflowX="auto" pb={2}>
                {categories.map(category => (
                    <Button
                        key={category.key}
                        size="sm"
                        variant={selectedCategory === category.key ? "solid" : "outline"}
                        colorScheme="blue"
                        onClick={() => setSelectedCategory(category.key)}
                        bg={selectedCategory === category.key ? "#274bff" : "transparent"}
                        borderColor="#2a3550"
                        _hover={{ bg: selectedCategory === category.key ? "#1f3bd9" : "#131a2b" }}
                    >
                        {category.label}
                    </Button>
                ))}
            </HStack>

            {/* Selected Component Controls */}
            {selectedComponent && (
                <Box p={3} border="1px solid #1d2333" borderRadius={6} bg="#0b0e17">
                    <VStack spacing={3}>
                        <Text fontSize="sm" fontWeight="bold">
                            Selected: {selectedComponent.name}
                        </Text>
                        <Text fontSize="xs" opacity={0.7}>
                            {selectedComponent.description}
                        </Text>

                        <HStack spacing={4}>
                            {selectedComponent.rotation && (
                                <VStack spacing={1}>
                                    <Text fontSize="xs">Rotation</Text>
                                    <Select
                                        size="sm"
                                        value={rotation}
                                        onChange={(e) => setRotation(Number(e.target.value))}
                                        bg="#0b0e17"
                                        borderColor="#2a3550"
                                    >
                                        <option value={0}>0°</option>
                                        <option value={1}>90°</option>
                                        <option value={2}>180°</option>
                                        <option value={3}>270°</option>
                                    </Select>
                                </VStack>
                            )}

                            {selectedComponent.mirror && (
                                <VStack spacing={1}>
                                    <Text fontSize="xs">Mirror</Text>
                                    <Button
                                        size="sm"
                                        variant={mirrored ? "solid" : "outline"}
                                        onClick={() => setMirrored(!mirrored)}
                                        bg={mirrored ? "#274bff" : "transparent"}
                                        borderColor="#2a3550"
                                        _hover={{ bg: mirrored ? "#1f3bd9" : "#131a2b" }}
                                    >
                                        {mirrored ? "On" : "Off"}
                                    </Button>
                                </VStack>
                            )}
                        </HStack>

                        <Box>
                            {renderComponentPreview(selectedComponent, rotation, mirrored)}
                        </Box>

                        <HStack spacing={2}>
                            <Button
                                size="sm"
                                colorScheme="green"
                                onClick={handlePlacementClick}
                                bg="#00aa00"
                                _hover={{ bg: "#008800" }}
                            >
                                Place at Center
                            </Button>
                            <Text fontSize="xs" opacity={0.6}>
                                Or drag component to track
                            </Text>
                        </HStack>
                    </VStack>
                </Box>
            )}

            {/* Components Grid */}
            <Grid templateColumns="repeat(auto-fill, minmax(120px, 1fr))" gap={3}>
                {filteredComponents.map(component => (
                    <GridItem key={component.name}>
                        <Box
                            p={2}
                            border="1px solid #1d2333"
                            borderRadius={6}
                            bg="#0b0e17"
                            cursor="grab"
                            _hover={{ bg: '#131a2b', borderColor: '#2a3550' }}
                            onClick={() => setSelectedComponent(component)}
                            draggable
                            onDragStart={(e) => handleDragStart(e, component)}
                            onDragEnd={handleDragEnd}
                        >
                            <VStack spacing={2} align="center">
                                <Text fontSize="xs" fontWeight="bold" textAlign="center">
                                    {component.name}
                                </Text>
                                <Box>
                                    {renderComponentPreview(component)}
                                </Box>
                                <Text fontSize="xs" opacity={0.6}>
                                    {component.width}×{component.height}
                                </Text>
                            </VStack>
                        </Box>
                    </GridItem>
                ))}
            </Grid>

            {filteredComponents.length === 0 && (
                <Text textAlign="center" opacity={0.6}>
                    No components found for this category.
                </Text>
            )}

            {/* Instructions */}
            <Box p={3} border="1px solid #1d2333" borderRadius={6} bg="#0b0e17">
                <Text fontSize="sm" fontWeight="bold" mb={2}>How to use:</Text>
                <VStack spacing={1} align="stretch">
                    <Text fontSize="xs">1. Select a component to configure rotation/mirror</Text>
                    <Text fontSize="xs">2. Drag component to track or click "Place at Center"</Text>
                    <Text fontSize="xs">3. Components will be placed at the center of the track</Text>
                </VStack>
            </Box>
        </VStack>
    )
}

export default DraggableComponentSelector
