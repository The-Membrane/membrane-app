import React from 'react'
import { Box, HStack, Text, Switch } from '@chakra-ui/react'

const PRIMARY_PURPLE = 'rgb(166, 146, 255)'

interface AdvancedModeToggleProps {
    isAdvancedMode: boolean
    onToggle: (isEnabled: boolean) => void
    position?: {
        top?: string | number
        right?: string | number
    }
}

export const AdvancedModeToggle: React.FC<AdvancedModeToggleProps> = ({
    isAdvancedMode,
    onToggle,
    position = { top: '10px', right: 5 },
}) => {
    return (
        <Box
            position="absolute"
            top={position.top}
            right={position.right}
            zIndex={1000}
            bg="transparent"
            borderRadius="md"
            p={3}
        >
            <HStack spacing={3} align="center">
                <Text
                    fontSize="sm"
                    color="white"
                    fontFamily="mono"
                    fontWeight="700"
                >
                    Advanced mode
                </Text>
                <Switch
                    isChecked={isAdvancedMode}
                    onChange={(e) => onToggle(e.target.checked)}
                    colorScheme="gray"
                    size="md"
                    sx={{
                        '& .chakra-switch__track': {
                            bg: 'rgba(20, 20, 30, 0.8)',
                            border: '1px solid white',
                            borderColor: 'white',
                            _checked: {
                                bg: PRIMARY_PURPLE,
                                borderColor: PRIMARY_PURPLE,
                            },
                        },
                        '& .chakra-switch__thumb': {
                            bg: 'white',
                            _checked: {
                                bg: 'white',
                            },
                        },
                    }}
                />
            </HStack>
        </Box>
    )
}



















