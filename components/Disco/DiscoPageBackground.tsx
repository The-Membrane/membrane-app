import React from 'react'
import { Box } from '@chakra-ui/react'
import { PRIMARY_PURPLE } from './DiscoPageConstants'

/** Fixed hexagonal background grid behind the Disco page content. */
export const DiscoPageBackground: React.FC = () => {
    return (
        <Box
            position="fixed"
            inset={0}
            opacity={0.4}
            zIndex={0}
            pointerEvents="none"
        >
            <Box as="svg" w="100%" h="100%">
                <defs>
                    <pattern id="hexagonPatternDisco" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
                        <polygon
                            points="34.64,10 51.96,20 51.96,40 34.64,50 17.32,40 17.32,20"
                            fill="none"
                            stroke={PRIMARY_PURPLE}
                            strokeWidth="1"
                        />
                        <polygon
                            points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                            fill="none"
                            stroke={PRIMARY_PURPLE}
                            strokeWidth="1"
                        />
                        <polygon
                            points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                            fill="none"
                            stroke={PRIMARY_PURPLE}
                            strokeWidth="1"
                        />
                    </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#hexagonPatternDisco)" />
            </Box>
        </Box>
    )
}
