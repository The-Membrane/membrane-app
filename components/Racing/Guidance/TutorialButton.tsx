import React from 'react'
import { Button, Text } from '@chakra-ui/react'
import { QuestionIcon } from '@chakra-ui/icons'

interface TutorialButtonProps {
    onClick: () => void
    isVisible?: boolean
}

const TutorialButton: React.FC<TutorialButtonProps> = ({ onClick, isVisible = true }) => {
    if (!isVisible) return null

    return (
        <Button
            onClick={onClick}
            variant="ghost"
            size="sm"
            color="#b8c1ff"
            _hover={{ color: '#00ffea' }}
            fontFamily='"Press Start 2P", monospace'
            fontSize="10px"
            leftIcon={<QuestionIcon />}
            px={2}
        >
            TUTORIAL
        </Button>
    )
}

export default TutorialButton
