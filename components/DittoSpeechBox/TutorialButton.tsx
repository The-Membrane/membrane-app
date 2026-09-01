import React from 'react'
import { Button, Icon } from '@chakra-ui/react'
import { QuestionIcon } from '@chakra-ui/icons'

import { TRANSITIONS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

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
            color={SEMANTIC_COLORS.textPrimary}
            _hover={{ bg: 'transparent', color: SEMANTIC_COLORS.primary }}
            _active={ACTIVE_EFFECTS.dim}
            fontSize="xs"
            leftIcon={<QuestionIcon />}
            px={3}
            py={2}
            borderRadius={0}
            transition={TRANSITIONS.colors}
            fontWeight="medium"
            _focus={FOCUS_STYLES.ring}
            _focusVisible={FOCUS_STYLES.ring}
        >
            {label}
        </Button>
    )
}


