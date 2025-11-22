import React from 'react'
import { Box } from '@chakra-ui/react'

export const DiscoBallMeteor = React.memo(() => {
    return (
        <Box
            position="absolute"
            top="20px"
            left="20px"
            w="80px"
            h="80px"
            borderRadius="50%"
            bg="silver"
            border="2px solid"
            borderColor="whiteAlpha.300"
            zIndex={10}
        />
    )
})

DiscoBallMeteor.displayName = 'DiscoBallMeteor'
