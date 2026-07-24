import React from 'react'
import { Box, VStack, Button, HStack, IconButton } from '@chakra-ui/react'
import { m, AnimatePresence } from 'framer-motion'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import { ChevronLeftIcon } from '@chakra-ui/icons'

interface EditPanelProps {
    isOpen: boolean
    onClose: () => void
    currentView: string
}

export const EditPanel: React.FC<EditPanelProps> = ({ isOpen, onClose, currentView }) => {
    const router = useRouter()
    const { chainName } = useChainRoute()

    const handleDeposit = () => {
        router.push(`/${chainName}/${currentView}`)
        onClose()
    }

    const handleWithdraw = () => {
        router.push(`/${chainName}/${currentView}`)
        onClose()
    }

    const handleLoop = () => {
        router.push(`/${chainName}/${currentView}`)
        onClose()
    }

    return (
        <AnimatePresence>
            {isOpen && (
                <m.div
                    initial={{ x: 0, scaleX: 0 }}
                    animate={{ x: 0, scaleX: 1 }}
                    exit={{ x: 0, scaleX: 0 }}
                    transition={{ duration: 0.3, ease: 'easeInOut' }}
                    style={{
                        position: 'absolute',
                        right: '-341px',
                        top: "33px",
                        // height: '200px',
                        zIndex: -1,
                        transformOrigin: 'left center',
                    }}
                >
                    <Box
                        position="relative"
                        zIndex={-1}
                        w="fit-content"
                        h="100%"
                        bg="#23252B"
                        border="1px solid"
                        borderColor="#9bdc4f40"
                        borderLeft="none"
                        borderRadius="0 md md 0"
                        boxShadow="0 4px 12px rgba(0,0,0,0.5), 0 0 20px rgba(155, 220, 79, 0.3)"
                        // boxShadowLeft="none"
                        p={4}
                        pl={0}
                    // justifyContent={"center"}
                    >
                        <HStack gap={1} h={"100%"}>
                            <IconButton
                                // position="absolute"
                                w={"5%"}
                                h={"100%"}
                                // right={"50%"}

                                // transform="translateX(-50%)"
                                // top={"50%"}
                                aria-label="Back"
                                icon={<ChevronLeftIcon />}
                                size="sm"
                                variant="ghost"
                                color="#ece6d8"
                                onClick={onClose}
                                _hover={{ bg: undefined, color: undefined }}
                                _active={{ bg: undefined, color: undefined }}
                                display="flex"
                            />
                            <HStack spacing={3} align="stretch" mt={4} w={"fit-content"}>
                                <Button
                                    size="sm"
                                    colorScheme="secondary"
                                    bg="secondary.500"
                                    color="white"
                                    onClick={handleDeposit}
                                    _hover={{
                                        bg: 'secondary.400',
                                    }}
                                >
                                    Deposit
                                </Button>
                                <Button
                                    size="sm"
                                    colorScheme="secondary"
                                    bg="secondary.500"
                                    color="white"
                                    onClick={handleWithdraw}
                                    _hover={{
                                        bg: 'secondary.400',
                                    }}
                                >
                                    Withdraw
                                </Button>
                                <Button
                                    size="sm"
                                    colorScheme="secondary"
                                    bg="secondary.500"
                                    color="white"
                                    onClick={handleLoop}
                                    _hover={{
                                        bg: 'secondary.400',
                                    }}
                                >
                                    Loop
                                </Button>
                            </HStack>
                        </HStack>
                    </Box>
                </m.div>
            )}
        </AnimatePresence>
    )
}

