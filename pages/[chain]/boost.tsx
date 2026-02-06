import React from 'react'
import { Box, VStack, Text } from '@chakra-ui/react'
import ChainLayout from '@/components/ChainLayout'
import { BoostSection } from '@/components/DittoSpeechBox/sections/BoostSection'

export default function BoostPage() {
    return (
        <ChainLayout>
            <Box
                w="100%"
                minH="100vh"
                bg="gray.900"
                py={8}
                px={4}
            >
                <VStack spacing={8} maxW="1400px" mx="auto">
                    <Box w="100%">
                        <Text
                            fontSize="3xl"
                            fontWeight="bold"
                            color="white"
                            fontFamily="mono"
                            textTransform="uppercase"
                            letterSpacing="wide"
                            mb={2}
                        >
                            BOOSTS
                        </Text>
                        <Text
                            fontSize="sm"
                            color="gray.400"
                            fontFamily="mono"
                        >
                            Detailed view of your boost sources and deposit management
                        </Text>
                    </Box>
                    <Box
                        w="100%"
                        bg="gray.800"
                        border="2px solid"
                        borderColor="purple.400"
                        borderRadius="md"
                        p={6}
                    >
                        <BoostSection onBack={() => {}} />
                    </Box>
                </VStack>
            </Box>
        </ChainLayout>
    )
}

