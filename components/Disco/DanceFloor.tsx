import React from 'react'
import { Box } from '@chakra-ui/react'

interface DanceFloorProps {
    ltvQueues?: any[]
    userDeposits?: any[]
}

export const DanceFloor = React.memo(({ ltvQueues, userDeposits }: DanceFloorProps) => {
    return (
        <Box
            w="300px"
            h="300px"
            mx="auto"
            position="relative"
            mb={8}
            display="flex"
            alignItems="center"
            justifyContent="center"
        >
            {/* Diamond shape - floor facing upwards (point at top, base at bottom) */}
            <Box
                w="200px"
                h="200px"
                bg="whiteAlpha.100"
                border="2px solid"
                borderColor="whiteAlpha.300"
                position="relative"
                clipPath="polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)"
                _before={{
                    content: '""',
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    w: '80%',
                    h: '80%',
                    bg: 'whiteAlpha.50',
                    border: '1px solid',
                    borderColor: 'whiteAlpha.200',
                    clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
                }}
            />
        </Box>
    )
})

DanceFloor.displayName = 'DanceFloor'
