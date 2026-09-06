import React from 'react'
import { Box, Grid, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'

import { fmtUsd } from '@/components/Radar/radarLogic'
import { Stamp } from '@/components/Carry/atoms'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

/**
 * DesireRouter — the three-door strip under the ForecastGate (owner-approved
 * landing change). Evidence stays the trust story; this stops it being a dead end
 * by routing the three carry desires to their flow: check a venue's exit → radar,
 * find the spread → carry, watch the big books → strats. Mounted AFTER the gate so
 * the commit-before-reveal forecast flow is never disturbed.
 *
 * The strats door shows LIVE numbers from /api/strats when the fetch lands; until
 * then it uses static copy with NO numbers — a stale count must never render as
 * live (docs V20 / provenance discipline).
 */

type StratsSummary = { count: number; total_usd: number }

const Door: React.FC<{ href: string; eyebrow: string; body: React.ReactNode; cta: string }> = ({
  href,
  eyebrow,
  body,
  cta,
}) => (
  <NextLink href={href} style={{ textDecoration: 'none' }}>
    <Box
      as="span"
      display="flex"
      flexDirection="column"
      h="100%"
      p={SPACING.base}
      bg={SEMANTIC_COLORS.bgPrimary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      borderRadius={0}
      cursor="pointer"
      transition={TRANSITIONS.colors}
      _hover={{ borderColor: SEMANTIC_COLORS.success }}
      _focusVisible={FOCUS_STYLES.ring}
    >
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.28em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
        {eyebrow}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textPrimary} mt={SPACING.sm} lineHeight={1.6} flex="1">
        {body}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.success} mt={SPACING.md} letterSpacing="0.06em">
        {cta}
      </Text>
    </Box>
  </NextLink>
)

export const DesireRouter: React.FC = () => {
  const { chainName } = useChainRoute()

  const { data } = useQuery<StratsSummary>({
    queryKey: ['strats_summary'],
    queryFn: async () => {
      const r = await fetch('/api/strats')
      if (!r.ok) throw new Error(`strats ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    // App default is refetchOnMount:false; override so an empty first fetch
    // cannot stick for the session.
    refetchOnMount: true,
  })

  const booksBody =
    data && data.count > 0
      ? `${data.count} tracked strats, ${fmtUsd(data.total_usd)} — auto-discovered on mainnet, stressed against recorded capacity`
      : 'tracked carry strats, auto-discovered on mainnet and stressed against recorded capacity'

  return (
    <Box mt={SPACING.lg} mb={SPACING.lg}>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.28em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary} mb={SPACING.md}>
        Pick your read
      </Text>
      <Grid templateColumns={{ base: '1fr', md: 'repeat(3, 1fr)' }} gap={SPACING.base}>
        <Door
          href={`/${chainName}/radar`}
          eyebrow="Check a venue's exit"
          body="Paste any address — its positions, stressed against recorded capacity and realized flow."
          cta="→ /radar"
        />
        <Door
          href={`/${chainName}/carry`}
          eyebrow="Find the spread"
          body="The measured board, exit costs priced in — the yield-hunter's whole picture on one page."
          cta="→ /carry"
        />
        <Door href={`/${chainName}/strats`} eyebrow="Watch the big books" body={booksBody} cta="→ /strats" />
      </Grid>
      <Stamp>carry radar · recorded corpus · {new Date().toISOString().slice(0, 10)}</Stamp>
    </Box>
  )
}

export default DesireRouter
