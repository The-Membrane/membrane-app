import React from 'react'
import { Box, Text } from '@chakra-ui/react'

/** Title and subtitle header for the Disco page. */
export const DiscoPageHeader: React.FC = () => {
    return (
        <Box
            textAlign="center"
            mb={2}
            px={4}
            w="100%"
            display="flex"
            flexDirection="column"
            alignItems="center"
        >
            <Text
                fontSize={{ base: 'lg', md: 'xl' }}
                fontWeight="bold"
                bgGradient="linear(to-r, primary.400, secondary.400)"
                bgClip="text"
                fontFamily="'Neon Tubes', mono"
                mb={2}
            >
                MBRN Insurance Discovery
            </Text>
            <Text
                fontSize="sm"
                color="whiteAlpha.600"
                fontFamily="mono"
                maxW="600px"
            >
                Get paid CDT while standing on the frontline for absorbing bad debt. Choose your risk slot and join the layered Guardians of Solvency!
            </Text>
        </Box>
    )
}
