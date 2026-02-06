import React from 'react'
import { Box, Image } from '@chakra-ui/react'

export const DiscoBallMeteor = React.memo(() => {
    return (
        <Box
            position="absolute"
            top="-14px"
            left="20px"
            w="200px"
            h="200px"
            zIndex={1}
            display="flex"
            alignItems="center"
            justifyContent="center"
        >
            {/* Sparkle overlay - subtle twinkling effect */}
            <Box
                position="absolute"
                w="100%"
                h="100%"
                borderRadius="50%"
                pointerEvents="none"
                zIndex={2}
                sx={{
                    background: `
                        radial-gradient(circle at 25% 35%, rgba(255, 255, 255, 0.4) 0%, transparent 4%),
                        radial-gradient(circle at 65% 70%, rgba(166, 146, 255, 0.3) 0%, transparent 5%),
                        radial-gradient(circle at 85% 25%, rgba(59, 229, 229, 0.4) 0%, transparent 4%)
                    `,
                    animation: 'discoSparkle 2.5s ease-in-out infinite',
                    mixBlendMode: 'screen',
                    opacity: 0.5,
                }}
            />

            {/* Main disco ball image */}
            <Image
                src="/images/spinning-disco.webp"
                alt="Disco Ball"
                w="150%"
                h="150%"
                objectFit="cover"
                position="relative"
                zIndex={1}
                sx={{
                    animation: 'discoSparkle 3s ease-in-out infinite',
                    willChange: 'filter',
                }}
            />
        </Box>
    )
})

DiscoBallMeteor.displayName = 'DiscoBallMeteor'
