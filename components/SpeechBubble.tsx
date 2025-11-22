import React from 'react'
import { Box, Text } from '@chakra-ui/react'

interface SpeechBubbleProps {
    message: string
    isVisible?: boolean
    position?: {
        bottom?: string
        left?: string
        right?: string
        top?: string
    }
    maxW?: string
    minW?: string
}

export const SpeechBubble: React.FC<SpeechBubbleProps> = ({
    message,
    isVisible = true,
    position = { bottom: 'calc(35% + 96px + 16px)', left: '69%' },
    maxW = '300px',
    minW = '200px',
}) => {
    if (!isVisible) return null

    return (
        <Box
            position="absolute"
            bottom={position.bottom}
            left={position.left}
            right={position.right}
            top={position.top}
            transform={position.left === '69%' ? 'translateX(-50%)' : undefined}
            bg="#23252B"
            color="#F5F5F5"
            px={4}
            py={3}
            borderRadius="md"
            maxW={maxW}
            minW={minW}
            boxShadow="0 4px 12px rgba(0,0,0,0.5), 0 0 20px rgba(105, 67, 255, 0.3)"
            border="1px solid"
            borderColor="#6943FF40"
            zIndex={1}
            opacity={isVisible ? 1 : 0}
            transition="opacity 0.3s ease-in-out"
            _after={{
                content: '""',
                position: 'absolute',
                bottom: '-8px',
                left: '38%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: '8px solid transparent',
                borderRight: '8px solid transparent',
                borderTop: '8px solid #23252B',
            }}
            _before={{
                content: '""',
                position: 'absolute',
                bottom: '-9px',
                left: '38%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: '9px solid transparent',
                borderRight: '9px solid transparent',
                borderTop: '9px solid #6943FF40',
            }}
        >
            <Text fontSize="sm" lineHeight="1.4" color="#F5F5F5">
                {message}
            </Text>
        </Box>
    )
}

