import React from 'react'
import { Box } from '@chakra-ui/react'
import { SpeechBubble } from '@/components/SpeechBubble'
import { useChainRoute } from '@/hooks/useChainRoute'

export default function Headquarters() {
    const { chainName } = useChainRoute()
    const showSpeechBubble = chainName === 'neutron'

    return (
        <Box
            position="relative"
            minH="100vh"
            bg="#0A0A0A"
            overflow="hidden"
        >
            {/* Speech Bubble - only show on neutron, positioned relative to global DittoHologram */}
            {showSpeechBubble && (
                <Box
                    position="fixed"
                    bottom={0}
                    left={0}
                    zIndex={1}
                    p={4}
                    pointerEvents="none"
                >
                    <Box position="relative" w="128px" h="128px">
                        <SpeechBubble
                            message="Welcome back, Brainiac"
                            isVisible={true}
                            position={{
                                bottom: 'calc(35% + 96px + 16px)',
                                left: '69%',
                            }}
                        />
                    </Box>
                </Box>
            )}
        </Box>
    )
}

