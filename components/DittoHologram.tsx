import React from 'react'
import { Box, Image } from '@chakra-ui/react'
import { useChainRoute } from '@/hooks/useChainRoute'

interface DittoHologramProps {
    stayShown?: boolean
}

export const DittoHologram: React.FC<DittoHologramProps> = ({ stayShown = false }) => {
    const { chainName } = useChainRoute()

    // Only show on neutron chain
    if (chainName !== 'neutron') {
        return null
    }

    return (
        <Box
            position="fixed"
            bottom={0}
            left={0}
            zIndex={0}
            p={4}
            pointerEvents="none"
        >
            {/* Container for both images */}
            <Box position="relative" w="128px" h="128px">
                {/* Base image - holo-no-ditto (always visible) */}
                <Image
                    src="/images/holo-no-ditto.svg"
                    alt="Holo no ditto"
                    w="128px"
                    h="128px"
                    objectFit="contain"
                />
                {/* Ditto overlay - fades in gradually, positioned 20% above holo */}
                <Image
                    src="/images/ditto.svg"
                    alt="Ditto"
                    position="absolute"
                    bottom="50%"
                    left="50%"
                    transform="translateX(-50%)"
                    w="96px"
                    h="96px"
                    objectFit="contain"
                    opacity={stayShown ? 1 : 0}
                    transition="opacity 1s ease-in"
                />
            </Box>
        </Box>
    )
}

