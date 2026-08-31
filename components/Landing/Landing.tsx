import React, { useMemo, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DemoBanner } from '@/components/demo'
import { useChainRoute } from '@/hooks/useChainRoute'

import Hero from './Hero'
import Counterfactual from './Counterfactual'
import HonestPart from './HonestPart'
import Routes from './Routes'
import Scanner from './Scanner'
import { DEFAULT_STATE } from './fixtures'
import { LandingState, VenueKey } from './types'
import { calc } from './utils'

/** Hairline divider between sections. */
const Divider: React.FC = () => <Box borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} />

export const Landing: React.FC = () => {
  const { chainName } = useChainRoute()
  const [st, setSt] = useState<LandingState>(DEFAULT_STATE)
  const c = useMemo(() => calc(st), [st])

  const onBtc = (v: number) => setSt((s) => ({ ...s, btc: v }))
  const onLtv = (v: number) => setSt((s) => ({ ...s, ltv: v }))
  const onVenue = (v: VenueKey) => setSt((s) => ({ ...s, venue: v }))

  return (
    <Box bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <DemoBanner note="the instrument runs on illustrative figures — connect a wallet to price your own" />

      <Box maxW="1180px" mx="auto" px={{ base: SPACING.base, md: SPACING.lg }}>
        {/* 01 — the instrument */}
        <Box pt={SPACING.xl}>
          <Hero st={st} c={c} chainName={chainName} onBtc={onBtc} onLtv={onLtv} onVenue={onVenue} />
        </Box>

        {/* 02 — retrospective counterfactual */}
        <Box py={{ base: SPACING['2xl'], md: SPACING['3xl'] }}>
          <Counterfactual st={st} c={c} />
        </Box>
        <Divider />

        {/* 03 — risk, in hours */}
        <Box py={{ base: SPACING['2xl'], md: SPACING['3xl'] }}>
          <HonestPart st={st} c={c} />
        </Box>
        <Divider />

        {/* 03b — what the market is running */}
        <Box py={{ base: SPACING['2xl'], md: SPACING['3xl'] }}>
          <Routes />
        </Box>
        <Divider />

        {/* 04 — the scanner */}
        <Box py={{ base: SPACING['2xl'], md: SPACING['3xl'] }}>
          <Scanner chainName={chainName} />
        </Box>

        {/* footer */}
        <Box pt={SPACING.lg} pb={SPACING['3xl']} display="grid" gap={SPACING.xs}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>
            Figures illustrative — Bitcoin at $95,000, borrow rate 3%, venue rates 4–12%. Not live data, not advice.
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>
            Borrowing against volatile collateral can lose you the collateral. The 8-hour delay is time, not a guarantee.
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

export default Landing
