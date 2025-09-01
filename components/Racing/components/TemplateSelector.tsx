import React from 'react'
import { Box, Grid, GridItem, Text, VStack } from '@chakra-ui/react'
import { trackTemplates } from '../utils/trackTemplates'
import { TrackTemplate } from '../types/trackTemplates'

interface TemplateSelectorProps {
    onTemplateSelect: (template: TrackTemplate) => void
}

const TemplateSelector: React.FC<TemplateSelectorProps> = ({ onTemplateSelect }) => {
    const filteredTemplates = trackTemplates

    const renderTemplatePreview = (template: TrackTemplate) => {
        const cellSize = 3
        const maxWidth = 60
        const maxHeight = 45

        const scaleX = Math.min(maxWidth / template.width, maxHeight / template.height)
        const scaleY = scaleX
        const displayWidth = Math.floor(template.width * scaleX)
        const displayHeight = Math.floor(template.height * scaleY)

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
                    templateColumns={`repeat(${template.width}, ${cellSize}px)`}
                    gap="1px"
                    bg="#1d2333"
                    transform={`scale(${scaleX}, ${scaleY})`}
                    transformOrigin="top left"
                >
                    {template.layout.map((row, y) =>
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

    return (
        <VStack spacing={4} align="stretch">
            {/* Templates Grid */}
            <Grid templateColumns="repeat(auto-fill, minmax(200px, 1fr))" gap={4}>
                {filteredTemplates.map(template => (
                    <GridItem key={template.name}>
                        <Box
                            p={3}
                            border="1px solid #1d2333"
                            borderRadius={6}
                            bg="#0b0e17"
                            cursor="pointer"
                            _hover={{ bg: '#131a2b', borderColor: '#2a3550' }}
                            onClick={() => onTemplateSelect(template)}
                        >
                            <VStack spacing={2} align="center">
                                <Text fontSize="sm" fontWeight="bold" textAlign="center">
                                    {template.name}
                                </Text>
                                <Text fontSize="xs" opacity={0.7} textAlign="center">
                                    {template.description}
                                </Text>
                                <Box>
                                    {renderTemplatePreview(template)}
                                </Box>
                                <Text fontSize="xs" opacity={0.6}>
                                    {template.width}×{template.height}
                                </Text>
                            </VStack>
                        </Box>
                    </GridItem>
                ))}
            </Grid>

            {filteredTemplates.length === 0 && (
                <Text textAlign="center" opacity={0.6}>
                    No templates found for this category.
                </Text>
            )}
        </VStack>
    )
}

export default TemplateSelector
