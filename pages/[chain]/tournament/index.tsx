import React from 'react'
import { Box, VStack, Text } from '@chakra-ui/react'
import TournamentBracket from '@/components/Racing/TournamentBracket'
import PageSeo from '@/components/PageSeo'

const TournamentPage: React.FC = () => {
    return (
        <Box minH="100vh" bg="#0a0f1e" p={4}>
            {/* Rule 0 (docs/SEO_RULESET.md): internal — Q-Racing tournament sim page */}
            <PageSeo
                seoClass="internal"
                title="Membrane — Tournament Bracket"
                description="View the Q-Racing tournament bracket, where AI-controlled cars compete against one another through a series of elimination rounds until one remains."
            />
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
