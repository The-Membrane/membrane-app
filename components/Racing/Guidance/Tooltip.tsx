import React from 'react'
import {
    Box,
    Text,
    Portal,
    useBreakpointValue,
} from '@chakra-ui/react'

interface TooltipProps {
    content: string
    isVisible: boolean
    position?: 'top' | 'bottom' | 'left' | 'right'
    children: React.ReactNode
}

const Tooltip: React.FC<TooltipProps> = ({
    content,
    isVisible,
    position = 'top',
    children,
}) => {
    const isMobile = useBreakpointValue({ base: true, md: false })

    const getPositionStyles = () => {
        const baseStyles = {
            position: 'absolute' as const,
            zIndex: 1000,
            maxW: isMobile ? '200px' : '250px',
            bg: '#0a0f1e',
            border: '1px solid #0033ff',
            borderRadius: '4px',
            p: 2,
            boxShadow: '0 0 10px rgba(0, 51, 255, 0.2)',
            fontSize: 'xs',
            color: '#e6e6e6',
            fontFamily: 'Inter, sans-serif',
        }

        switch (position) {
            case 'top':
                return { ...baseStyles, bottom: '100%', left: '50%', transform: 'translateX(-50%)', mb: 2 }
            case 'bottom':
                return { ...baseStyles, top: '100%', left: '50%', transform: 'translateX(-50%)', mt: 2 }
            case 'left':
                return { ...baseStyles, right: '100%', top: '50%', transform: 'translateY(-50%)', mr: 2 }
            case 'right':
                return { ...baseStyles, left: '100%', top: '50%', transform: 'translateY(-50%)', ml: 2 }
            default:
                return { ...baseStyles, bottom: '100%', left: '50%', transform: 'translateX(-50%)', mb: 2 }
        }
    }

    return (
        <Box position="relative" display="inline-block">
            {children}
            {isVisible && (
                <Portal>
                    <Box {...getPositionStyles()}>
                        <Text>{content}</Text>
                    </Box>
                </Portal>
            )}
        </Box>
    )
}

export default Tooltip
