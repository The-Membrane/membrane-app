import React from 'react'
import { Box, Text, Flex } from '@chakra-ui/react'

export type DialogueBoxProps = {
    isVisible: boolean
    message: string
    targetRef?: React.RefObject<HTMLElement>
    position?: 'top' | 'bottom' | 'left' | 'right'
    offset?: { x: number; y: number }
    onClose?: () => void
    autoCloseDelay?: number
}

const DialogueBox: React.FC<DialogueBoxProps> = ({
    isVisible,
    message,
    targetRef,
    position = 'top',
    offset = { x: 0, y: 0 },
    onClose,
    autoCloseDelay
}) => {
    const [positionStyle, setPositionStyle] = React.useState<React.CSSProperties>({})

    React.useEffect(() => {
        if (!isVisible || !targetRef?.current) return

        const target = targetRef.current
        const rect = target.getBoundingClientRect()
        const dialogueWidth = 200
        const dialogueHeight = 80
        const pointerSize = 10

        let x = 0
        let y = 0

        switch (position) {
            case 'top':
                x = rect.left + rect.width / 2 - dialogueWidth / 2 + offset.x
                y = rect.top - dialogueHeight - pointerSize + offset.y
                break
            case 'bottom':
                x = rect.left + rect.width / 2 - dialogueWidth / 2 + offset.x
                y = rect.bottom + pointerSize + offset.y
                break
            case 'left':
                x = rect.left - dialogueWidth - pointerSize + offset.x
                y = rect.top + rect.height / 2 - dialogueHeight / 2 + offset.y
                break
            case 'right':
                x = rect.right + pointerSize + offset.x
                y = rect.top + rect.height / 2 - dialogueHeight / 2 + offset.y
                break
        }

        setPositionStyle({
            position: 'fixed',
            left: Math.max(10, Math.min(x, window.innerWidth - dialogueWidth - 10)),
            top: Math.max(10, Math.min(y, window.innerHeight - dialogueHeight - 10)),
            zIndex: 1000,
            pointerEvents: 'none'
        })
    }, [isVisible, targetRef, position, offset])

    React.useEffect(() => {
        if (!isVisible || !autoCloseDelay || !onClose) return

        const timer = setTimeout(() => {
            onClose()
        }, autoCloseDelay)

        return () => clearTimeout(timer)
    }, [isVisible, autoCloseDelay, onClose])

    if (!isVisible) return null

    return (
        <Box
            style={positionStyle}
            bg="#0a0f1e"
            border="2px solid #00ffea"
            borderRadius="8px"
            p={3}
            minW="200px"
            maxW="300px"
            boxShadow="0 4px 20px rgba(0, 255, 234, 0.3)"
        >
            {/* Speech bubble pointer */}
            <Box
                position="absolute"
                width="0"
                height="0"
                style={{
                    [position === 'top' ? 'bottom' : position === 'bottom' ? 'top' : position === 'left' ? 'right' : 'left']: '-10px',
                    [position === 'top' || position === 'bottom' ? 'left' : 'top']: '50%',
                    transform: position === 'top' || position === 'bottom' ? 'translateX(-50%)' : 'translateY(-50%)',
                    borderLeft: position === 'left' ? 'none' : '10px solid transparent',
                    borderRight: position === 'right' ? 'none' : '10px solid transparent',
                    borderTop: position === 'top' ? 'none' : '10px solid transparent',
                    borderBottom: position === 'bottom' ? 'none' : '10px solid transparent',
                    [position === 'left' ? 'borderRight' : position === 'right' ? 'borderLeft' : position === 'top' ? 'borderBottom' : 'borderTop']: '10px solid #00ffea'
                }}
            />

            <Text
                color="#e6e6e6"
                fontFamily='"Press Start 2P", monospace'
                fontSize="10px"
                lineHeight="1.4"
                textAlign="center"
            >
                {message}
            </Text>
        </Box>
    )
}

export default DialogueBox
