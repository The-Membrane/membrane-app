import React from 'react'
import { Box, VStack } from '@chakra-ui/react'
import ChainLayout from '@/components/ChainLayout'
import { BoostSection } from '@/components/DittoSpeechBox/sections/BoostSection'
import { PageTitle } from '@/components/ui/PageTitle'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import PageSeo from '@/components/PageSeo'

export default function BoostPage() {
    return (
        <ChainLayout>
            {/* Rule 0 (docs/SEO_RULESET.md): app — wallet-gated boost management tool */}
            <PageSeo
                seoClass="app"
                title="Membrane — Boosts"
                description="View your boost sources and manage the deposits behind them, with a detailed breakdown of how each source contributes to your total boost multiplier."
            />
            <Box
                w="100%"
                minH="100vh"
                bg={SEMANTIC_COLORS.bgPrimary}
                py={SPACING.xl}
                px={SPACING.base}
            >
                <VStack spacing={SPACING.xl} maxW="1400px" mx="auto">
                    <Box w="100%">
                        <PageTitle
                            title="Boosts"
                            subtitle="Detailed view of your boost sources and deposit management"
                        />
                    </Box>
                    <Box
                        w="100%"
                        bg={SEMANTIC_COLORS.bgSecondary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        borderRadius={0}
                        p={SPACING.lg}
                    >
                        {/* onBack is intentionally a no-op here: BoostSection renders as a standalone page,
                            not inside the DittoSpeechBox drawer, so there is no parent view to return to. */}
                        <BoostSection onBack={() => {}} />
                    </Box>
                </VStack>
            </Box>
        </ChainLayout>
    )
}

