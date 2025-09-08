import React from 'react'
import { Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Text } from '@chakra-ui/react'

export type CampaignModalProps = {
    isOpen: boolean
    title: string
    body: string
    onClose: () => void
    onContinue?: () => void
    continueLabel?: string
}

const CampaignModal: React.FC<CampaignModalProps> = ({ isOpen, title, body, onClose, onContinue, continueLabel = 'Continue' }) => {
    return (
        <Modal isOpen={isOpen} onClose={onClose} isCentered>
            <ModalOverlay />
            <ModalContent bg="#0a0f1e" border="1px solid #2a3550">
                <ModalHeader color="#00ffea" fontFamily='"Press Start 2P", monospace' fontSize="14px">{title}</ModalHeader>
                <ModalBody>
                    <Text color="#e6e6e6" fontFamily='"Press Start 2P", monospace' fontSize="10px">{body}</Text>
                </ModalBody>
                <ModalFooter>
                    {onContinue && (
                        <Button mr={3} onClick={onContinue} bg="#274bff" color="#fff" _hover={{ bg: '#1f3bd9' }} fontFamily='"Press Start 2P", monospace' fontSize="10px">
                            {continueLabel}
                        </Button>
                    )}
                    <Button onClick={onClose} variant="ghost" fontFamily='"Press Start 2P", monospace' fontSize="10px">Close</Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    )
}

export default CampaignModal

