import React from 'react'
import { Button, Icon } from '@chakra-ui/react'
import { QuestionIcon } from '@chakra-ui/icons'

interface TutorialButtonProps {
    onClick: () => void
    isVisible?: boolean
    label?: string
}

export const TutorialButton: React.FC<TutorialButtonProps> = ({
    onClick,
    isVisible = true,
    label = 'Tutorial',
}) => {
    if (!isVisible) return null

    return (
        <Button
            onClick={onClick}
            variant="ghost"
            size="sm"
            color="#ece6d8"
            _hover={{ bg: '#9bdc4f20', color: '#9bdc4f', transform: 'scale(1.05)' }}
            _active={{ transform: 'scale(0.95)' }}
            fontSize="xs"
            leftIcon={<QuestionIcon />}
            px={3}
            py={2}
            borderRadius="md"
            transition="all 0.2s ease"
            fontWeight="medium"
            boxShadow="0 2px 8px rgba(0, 0, 0, 0.2)"
        >
            {label}
        </Button>
    )
}


