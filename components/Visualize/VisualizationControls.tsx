import React from 'react'
import { HStack, Button, Select, Text } from '@chakra-ui/react'

interface VisualizationControlsProps {
    timeRange: '1h' | '24h' | '7d' | '30d'
    onTimeRangeChange: (range: '1h' | '24h' | '7d' | '30d') => void
    viewMode: 'galaxy' | 'markets' | 'timeline'
    onViewModeChange: (mode: 'galaxy' | 'markets' | 'timeline') => void
}

export const VisualizationControls: React.FC<VisualizationControlsProps> = ({
    timeRange,
    onTimeRangeChange,
    viewMode,
    onViewModeChange,
}) => {
    return (
        <HStack spacing={4}>
            <HStack spacing={2}>
                <Text fontSize="xs" color="purple.400" fontFamily="mono">
                    VIEW:
                </Text>
                <Button
                    size="sm"
                    variant={viewMode === 'galaxy' ? 'solid' : 'outline'}
                    colorScheme="purple"
                    onClick={() => onViewModeChange('galaxy')}
                    fontFamily="mono"
                    fontSize="xs"
                >
                    Galaxy
                </Button>
                <Button
                    size="sm"
                    variant={viewMode === 'markets' ? 'solid' : 'outline'}
                    colorScheme="purple"
                    onClick={() => onViewModeChange('markets')}
                    fontFamily="mono"
                    fontSize="xs"
                >
                    Markets
                </Button>
                <Button
                    size="sm"
                    variant={viewMode === 'timeline' ? 'solid' : 'outline'}
                    colorScheme="purple"
                    onClick={() => onViewModeChange('timeline')}
                    fontFamily="mono"
                    fontSize="xs"
                >
                    Timeline
                </Button>
            </HStack>

            <HStack spacing={2}>
                <Text fontSize="xs" color="purple.400" fontFamily="mono">
                    RANGE:
                </Text>
                <Select
                    size="sm"
                    value={timeRange}
                    onChange={(e) => onTimeRangeChange(e.target.value as '1h' | '24h' | '7d' | '30d')}
                    bg="rgba(10, 10, 15, 0.8)"
                    borderColor="rgba(138, 43, 226, 0.5)"
                    color="purple.200"
                    fontFamily="mono"
                    fontSize="xs"
                    w="120px"
                    _hover={{ borderColor: 'purple.400' }}
                    _focus={{ borderColor: 'purple.400', boxShadow: '0 0 0 1px rgba(138, 43, 226, 0.5)' }}
                >
                    <option value="1h" style={{ background: '#0a0a0f', color: '#8a2be2' }}>
                        1 Hour
                    </option>
                    <option value="24h" style={{ background: '#0a0a0f', color: '#8a2be2' }}>
                        24 Hours
                    </option>
                    <option value="7d" style={{ background: '#0a0a0f', color: '#8a2be2' }}>
                        7 Days
                    </option>
                    <option value="30d" style={{ background: '#0a0a0f', color: '#8a2be2' }}>
                        30 Days
                    </option>
                </Select>
            </HStack>
        </HStack>
    )
}

