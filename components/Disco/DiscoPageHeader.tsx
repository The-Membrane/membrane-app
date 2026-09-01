import React from 'react'
import { Box, Text } from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

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
                as="h1"
                fontSize={TYPOGRAPHY.h1}
                fontWeight={TYPOGRAPHY.bold}
                color={SEMANTIC_COLORS.textPrimary}
                fontFamily={TYPOGRAPHY.fontDisplay}
                mb={2}
            >
                MBRN Insurance Discovery
            </Text>
            <Text
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textSecondary}
                fontFamily={TYPOGRAPHY.fontMono}
                maxW="600px"
            >
                Get paid CDT while standing on the frontline for absorbing bad debt. Choose your risk slot and join the layered Guardians of Solvency!
            </Text>
        </Box>
    )
}
