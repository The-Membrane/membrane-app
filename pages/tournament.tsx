import React from 'react'
import { Box, VStack, Text } from '@chakra-ui/react'
import TournamentBracket from '@/components/Racing/TournamentBracket'

const TournamentPage: React.FC = () => {
    return (
        <Box minH="100vh" bg="#0a0f1e" p={4}>
            <VStack spacing={6} align="stretch" maxW="1200px" mx="auto">
                <Box textAlign="center" mb={4}>
                    <Text
                        fontFamily='"Press Start 2P", monospace'
                        fontSize="24px"
                        color="#7cffa0"
                        mb={2}
                    >
                        Tournament Bracket
                    </Text>
                    <Text
                        fontFamily='"Press Start 2P", monospace'
                        fontSize="12px"
                        color="#b8c1ff"
                    >
                        Watch the AI cars compete in elimination rounds
                    </Text>
                </Box>

                <TournamentBracket />
            </VStack>
        </Box>
    )
}

export default TournamentPage
