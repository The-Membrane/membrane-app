import React from 'react'
import { Box, Text, VStack, Modal, ModalOverlay, ModalContent, ModalBody, ModalCloseButton, ModalHeader } from '@chakra-ui/react'

interface StorefrontTOSModalProps {
    isOpen: boolean
    onClose: () => void
    tosContent: string
}

// Terms of Service modal: renders the lazily-fetched TOS.md content with a
// lightweight inline markdown parser (headings, lists, rules, bold spans).
export const StorefrontTOSModal = ({ isOpen, onClose, tosContent }: StorefrontTOSModalProps) => {
    return (
        <Modal isOpen={isOpen} onClose={onClose} size="xl" isCentered>
            <ModalOverlay bg="blackAlpha.800" />
            <ModalContent
                bg="#09090a"
                border="2px solid"
                borderColor="#9bdc4f"
                borderRadius="md"
                minW={{ base: "90%", md: "600px" }}
                maxW="800px"
                maxH="70vh"
            >
                <ModalHeader
                    color="#9bdc4f"
                    fontSize={{ base: "xl", md: "2xl" }}
                    textShadow="0 0 20px #9bdc4f"
                    letterSpacing="wider"
                    borderBottom="1px solid"
                    borderColor="#9bdc4f50"
                    pb={4}
                >
                    TERMS OF SERVICE
                </ModalHeader>
                <ModalCloseButton color="#8d877b" _hover={{ color: "#46d39a" }} />
                <ModalBody
                    p={6}
                    overflowY="auto"
                    css={{
                        '&::-webkit-scrollbar': {
                            width: '8px',
                        },
                        '&::-webkit-scrollbar-track': {
                            background: '#09090a',
                        },
                        '&::-webkit-scrollbar-thumb': {
                            background: '#9bdc4f',
                            borderRadius: '4px',
                        },
                        '&::-webkit-scrollbar-thumb:hover': {
                            background: '#46d39a',
                        },
                    }}
                >
                    <VStack spacing={4} align="stretch">
                        {tosContent.split('\n').map((line, index) => {
                            const trimmed = line.trim();

                            if (trimmed.startsWith('# ')) {
                                return (
                                    <React.Fragment key={`h1-${trimmed}`}>
                                        <Text
                                            as="h1"
                                            color="#9bdc4f"
                                            fontSize="1.5em"
                                            fontWeight="bold"
                                            mt={6}
                                            mb={2}
                                            textShadow="0 0 10px #9bdc4f"
                                        >
                                            {trimmed.substring(2)}
                                        </Text>
                                        <br />
                                    </React.Fragment>
                                );
                            }

                            if (trimmed.startsWith('## ')) {
                                return (
                                    <React.Fragment key={`h2-${trimmed}`}>
                                        <Text
                                            as="h2"
                                            color="#46d39a"
                                            fontSize="1.3em"
                                            fontWeight="bold"
                                            mt={5}
                                            mb={2}
                                            textShadow="0 0 8px #46d39a"
                                        >
                                            {trimmed.substring(3)}
                                        </Text>
                                        <br />
                                    </React.Fragment>
                                );
                            }

                            if (trimmed === '---') {
                                return (
                                    // Index kept intentionally: every '---' divider renders identical,
                                    // stateless markup and this list is a full re-parse of static TOS
                                    // text that never reorders/filters, so no stable id exists or matters.
                                    <React.Fragment key={index}>
                                        <Box
                                            borderTop="1px solid"
                                            borderColor="#9bdc4f50"
                                            my={6}
                                        />
                                        <br />
                                    </React.Fragment>
                                );
                            }

                            if (trimmed.startsWith('- ') || /^\d+\. /.test(trimmed)) {
                                const listItem = trimmed.replace(/^[-•]\s*/, '').replace(/^\d+\.\s*/, '');
                                return (
                                    <React.Fragment key={`li-${trimmed}`}>
                                        <Text
                                            as="li"
                                            ml={6}
                                            color="#ece6d8"
                                        >
                                            {listItem.split(/\*\*(.+?)\*\*/g).map((part, i) =>
                                                i % 2 === 1 ? (
                                                    <Text as="span" key={part} color="#46d39a" fontWeight="bold">
                                                        {part}
                                                    </Text>
                                                ) : (
                                                    part
                                                )
                                            )}
                                        </Text>
                                        <br />
                                    </React.Fragment>
                                );
                            }

                            if (trimmed === '') {
                                return (
                                    // Index kept intentionally: every blank line renders an identical
                                    // stateless spacer and this list is a full re-parse of static TOS
                                    // text that never reorders/filters, so no stable id exists or matters.
                                    <React.Fragment key={index}>
                                        <Box h={2} />
                                        <br />
                                    </React.Fragment>
                                );
                            }

                            return (
                                <React.Fragment key={`p-${trimmed}`}>
                                    <Text
                                        color="#ece6d8"
                                        mb={2}
                                    >
                                        {trimmed.split(/\*\*(.+?)\*\*/g).map((part, i) =>
                                            i % 2 === 1 ? (
                                                <Text as="span" key={part} color="#46d39a" fontWeight="bold">
                                                    {part}
                                                </Text>
                                            ) : (
                                                part
                                            )
                                        )}
                                    </Text>
                                    <br />
                                </React.Fragment>
                            );
                        })}
                    </VStack>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}
