import React from 'react'
import { IconButton, Tooltip, useDisclosure } from '@chakra-ui/react'
import { FaShare } from 'react-icons/fa'
import { ShareModal } from './ShareModal'
import type { CardType } from '@/services/shareableCard'

interface ShareButtonProps {
    cardType: CardType
    size?: 'xs' | 'sm' | 'md'
    variant?: 'ghost' | 'outline' | 'solid'
    colorScheme?: string
}

/**
 * Share button that opens the share modal with card components
 */
export const ShareButton: React.FC<ShareButtonProps> = ({
    cardType,
    size = 'sm',
    variant = 'ghost',
    colorScheme = 'purple',
}) => {
    const { isOpen, onOpen, onClose } = useDisclosure()

    return (
        <>
            <Tooltip
                label="Share achievement"
                fontSize="xs"
                bg="gray.800"
                color="white"
                borderRadius="md"
                hasArrow
            >
                <IconButton
                    aria-label="Share"
                    icon={<FaShare />}
                    size={size}
                    variant={variant}
                    colorScheme={colorScheme}
                    onClick={onOpen}
                    _hover={{ color: 'cyan.400' }}
                />
            </Tooltip>

            <ShareModal
                isOpen={isOpen}
                onClose={onClose}
                initialCardType={cardType}
            />
        </>
    )
}

export default ShareButton


