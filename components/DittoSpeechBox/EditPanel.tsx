import React from 'react'
import { Box, VStack, Button, HStack, IconButton } from '@chakra-ui/react'
import { m, AnimatePresence } from 'framer-motion'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import { ChevronLeftIcon } from '@chakra-ui/icons'

import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

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
                        bg={SEMANTIC_COLORS.bgTertiary}
                        border="1px solid"
                        borderColor="color-mix(in srgb, var(--m-primary) 25%, transparent)"
                        borderLeft="none"
                        borderRadius={0}
                        
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
                                color={SEMANTIC_COLORS.textPrimary}
                                onClick={onClose}
                                _hover={{ bg: undefined, color: undefined }}
                                _active={{ bg: undefined, color: undefined }}
                                display="flex"
                            />
                            <HStack spacing={3} align="stretch" mt={4} w={"fit-content"}>
                                <Button
                                    size="sm"
                                    colorScheme="secondary"
                                    bg={SEMANTIC_COLORS.info}
                                    color={SEMANTIC_COLORS.bgPrimary}
                                    borderRadius={0}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    onClick={handleDeposit}
                                    transition={TRANSITIONS.colors}
                                    _hover={HOVER_EFFECTS.borderHighlight}
                                    _active={ACTIVE_EFFECTS.dim}
                                    _focus={FOCUS_STYLES.ring}
                                    _focusVisible={FOCUS_STYLES.ring}
                                >
                                    Deposit
                                </Button>
                                <Button
                                    size="sm"
                                    colorScheme="secondary"
                                    bg={SEMANTIC_COLORS.info}
                                    color={SEMANTIC_COLORS.bgPrimary}
                                    borderRadius={0}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    onClick={handleWithdraw}
                                    transition={TRANSITIONS.colors}
                                    _hover={HOVER_EFFECTS.borderHighlight}
                                    _active={ACTIVE_EFFECTS.dim}
                                    _focus={FOCUS_STYLES.ring}
                                    _focusVisible={FOCUS_STYLES.ring}
                                >
                                    Withdraw
                                </Button>
                                <Button
                                    size="sm"
                                    colorScheme="secondary"
                                    bg={SEMANTIC_COLORS.info}
                                    color={SEMANTIC_COLORS.bgPrimary}
                                    borderRadius={0}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    onClick={handleLoop}
                                    transition={TRANSITIONS.colors}
                                    _hover={HOVER_EFFECTS.borderHighlight}
                                    _active={ACTIVE_EFFECTS.dim}
                                    _focus={FOCUS_STYLES.ring}
                                    _focusVisible={FOCUS_STYLES.ring}
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

