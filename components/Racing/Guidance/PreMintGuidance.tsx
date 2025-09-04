import React, { useState } from 'react'
import {
    Modal,
    ModalOverlay,
    ModalContent,
    ModalBody,
    ModalCloseButton,
    Text,
    VStack,
    Button,
    UnorderedList,
    ListItem,
    Box,
    useBreakpointValue,
    Checkbox,
    HStack,
} from '@chakra-ui/react'
import useAppState from '@/persisted-state/useAppState'

interface PreMintGuidanceProps {
    isOpen: boolean
    onClose: () => void
}

const PreMintGuidance: React.FC<PreMintGuidanceProps> = ({ isOpen, onClose }) => {
    const { setAppState } = useAppState()
    const isMobile = useBreakpointValue({ base: true, md: false })
    const [allowCookies, setAllowCookies] = useState(true)

    const handleContinue = () => {
        setAppState({
            hasSeenPreMintGuidance: true,
            setCookie: allowCookies
        })
        onClose()
    }

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="xl" isCentered closeOnOverlayClick={false}>
            <ModalOverlay />
            <ModalContent
                maxW="600px"
                borderWidth="2px"
                borderColor="#0033ff"
                bg="#0a0f1e"
                color="#e6e6e6"
            >
                <ModalCloseButton color="#b8c1ff" />
                <ModalBody p={6}>
                    <VStack spacing={6} align="stretch">
                        <Text
                            fontFamily='"Press Start 2P", monospace'
                            fontSize={isMobile ? '16px' : '20px'}
                            color="#00ffea"
                            textAlign="center"
                            mb={4}
                        >
                            WELCOME TO MAZE RUNNERS
                        </Text>

                        <Text fontSize="md" color="#b8c1ff" textAlign="center">
                            Before you mint your first Runner, here's what you need to know:
                        </Text>

                        <Box border="1px solid #0033ff" p={4} bg="#070b15">
                            <UnorderedList spacing={3} color="#e6e6e6">

                                <ListItem fontSize="sm">
                                    <Text as="span" color="#00ffea" fontWeight="bold">Maze Runner:</Text> Your Runner is an NFT with an onchain brain that controls its actions.
                                </ListItem>
                                <ListItem fontSize="sm">
                                    <Text as="span" color="#00ffea" fontWeight="bold">Energy System:</Text> Your Runner uses energy to train.
                                </ListItem>
                                <ListItem fontSize="sm">
                                    <Text as="span" color="#00ffea" fontWeight="bold">Racing:</Text> Train your Runner to top the leaderboards and complete the reoccuring maze to earn $BYTE.
                                </ListItem>
                                <ListItem fontSize="sm">
                                    <Text as="span" color="#00ffea" fontWeight="bold">Track Creation:</Text> Design and share your own racing tracks with the community.
                                </ListItem>
                                <ListItem fontSize="sm">
                                    <Text as="span" color="#00ffea" fontWeight="bold">Training:</Text> Your Runner gets faster the more efficiently you train.
                                </ListItem>
                            </UnorderedList>
                        </Box>

                        <Text fontSize="sm" color="#b8c1ff" textAlign="center" fontStyle="italic">
                            Ready to join the race?
                        </Text>

                        <HStack justify="center" spacing={2} mb={4}>
                            <Checkbox
                                isChecked={allowCookies}
                                onChange={(e) => setAllowCookies(e.target.checked)}
                                colorScheme="blue"
                                size="sm"
                            >
                                <Text fontSize="xs" color="#b8c1ff">
                                    Allow cookies for a personalized experience
                                </Text>
                            </Checkbox>
                        </HStack>

                        <Button
                            onClick={handleContinue}
                            bg="#0033ff"
                            color="white"
                            _hover={{ bg: '#0044ff' }}
                            fontFamily='"Press Start 2P", monospace'
                            fontSize="12px"
                            size="lg"
                        >
                            I'M READY
                        </Button>
                    </VStack>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}

export default PreMintGuidance
