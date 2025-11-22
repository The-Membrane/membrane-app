import { Stack, Text } from '@chakra-ui/react'
import React from 'react'

export const FlywheelPurpose = React.memo(() => {
    return (
        <Stack
            direction="column"
            gap="1rem"
            justifyContent="center"
            alignItems="center"
            mb="2rem"
            textAlign="center"
            maxW="800px"
            mx="auto"
            px={4}
        >
            <Text
                variant="title"
                letterSpacing="unset"
                fontSize={{ base: 'xl', md: '2xl' }}
                textTransform="none"
                fontWeight="600"
            >
                The Membrane Flywheel
            </Text>
            <Text
                fontSize={{ base: 'md', md: 'lg' }}
                color="whiteAlpha.700"
                lineHeight="1.6"
            >
                The Membrane Flywheel creates sustainable value through interconnected products that reinforce each other.
                Disco provides risk capital, Transmuter enables liquidity, and Manic generates revenue—each component
                strengthens the others in a continuous cycle of growth.
            </Text>
        </Stack>
    )
})

FlywheelPurpose.displayName = 'FlywheelPurpose'

