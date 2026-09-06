import React from 'react'
import { Box, Grid, Text } from '@chakra-ui/react'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

import { OracleChip, SectionHeading, Stamp } from './atoms'
import { venueSlug } from './venueSlug'
import { RH } from './fixtures'

const usd = (n: number) => '$' + Math.round(n / 1000) + 'k'

/** Prong confidence renders as three SEPARATE levels, never blended (§4.3). */
const CONF_COLOR: Record<'high' | 'med' | 'low', string> = {
  high: SEMANTIC_COLORS.textPrimary,
  med: SEMANTIC_COLORS.textSecondary,
  low: SEMANTIC_COLORS.warning,
}

export interface RedemptionHistoryProps {
  onOpenOracle: (sym: string) => void
  /** The user's dialled size — renders their footprint against each venue's 90d served volume. */
  amountUsd?: number
}

export const RedemptionHistory: React.FC<RedemptionHistoryProps> = ({ onOpenOracle, amountUsd = 0 }) => {
  const { chainName } = useChainRoute()
  return (
  <Box>
    <SectionHeading
      index="03 /"
      title="Will the venue give it back?"
      note="recall behavior when it mattered — evidence for liquidation-time liquidity, not a lender-flight signal"
    />
    <Card p={SPACING.base}>
      <Box>
        {RH.map((x, i) => {
          const fill = (x.srv / x.req) * 100
          const recBad = x.recOk < x.rec
          const slashBad = x.slash > 0
          // The user's contemplated size against everything this venue served in 90d.
          const footprint = x.srv > 0 ? (amountUsd / x.srv) * 100 : 0
          const footprintColor =
            footprint > 100 ? SEMANTIC_COLORS.danger : footprint > 25 ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textSecondary
          return (
            <Grid
              key={x.v}
              templateColumns={{ base: '1fr', lg: '150px 1fr 300px' }}
              gap={SPACING.base}
              alignItems="center"
              py="11px"
              borderBottom={i === RH.length - 1 ? 'none' : '1px solid'}
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textPrimary}>
                {venueSlug(x.v) ? (
                  <NextLink href={`/${chainName}/venue/${venueSlug(x.v)}`} style={{ textDecoration: 'underline' }}>
                    <Text as="span" _hover={{ color: SEMANTIC_COLORS.success }}>
                      {x.v}
                    </Text>
                  </NextLink>
                ) : (
                  x.v
                )}
                {x.oracle && <OracleChip sym={x.oracle} onOpen={onOpenOracle} />}
                <Text as="span" display="block" fontSize="9px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
                  {x.sub}
                </Text>
              </Text>

              {/* Fill bar: served (green) then unfilled (blood) */}
              <Box position="relative" h="13px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
                <Box position="absolute" top={0} bottom={0} left={0} bg={SEMANTIC_COLORS.success} opacity={0.75} w={`${fill.toFixed(1)}%`} />
                {fill < 100 && <Box position="absolute" top={0} bottom={0} right={0} bg={SEMANTIC_COLORS.danger} opacity={0.7} w={`${(100 - fill).toFixed(1)}%`} />}
              </Box>

              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="9.5px"
                color={SEMANTIC_COLORS.textSecondary}
                lineHeight={1.55}
                textAlign={{ base: 'left', lg: 'right' }}
              >
                fill{' '}
                <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                  {fill.toFixed(1)}%
                </Text>{' '}
                ({usd(x.srv)} of {usd(x.req)}, 90d) · slashed{' '}
                <Text as="span" color={slashBad ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}>
                  {x.slash}
                  {slashBad ? ' · ' + usd(x.slashAmt) : ''}
                </Text>{' '}
                · liq recalls{' '}
                <Text as="span" color={recBad ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary}>
                  {x.recOk}/{x.rec}
                </Text>{' '}
                ·{' '}
                {x.ban ? (
                  <Text as="span" color={SEMANTIC_COLORS.danger}>
                    BANNED
                  </Text>
                ) : (
                  'no ban'
                )}
                <br />
                {x.noteSegments.map((s, si) => (
                  <Text as="span" key={si} color={s.tone === 'gold' ? SEMANTIC_COLORS.warning : 'inherit'}>
                    {s.t}
                  </Text>
                ))}
                {amountUsd > 0 && (
                  <>
                    <br />
                    <Text as="span" color={footprintColor}>
                      your {usd(amountUsd)} = {footprint < 1 ? footprint.toFixed(1) : Math.round(footprint)}% of
                      everything this venue served in 90d
                    </Text>
                  </>
                )}
                {x.prongs && (
                  <>
                    <br />
                    {x.prongs.map((p, pi) => (
                      <Text as="span" key={p.label}>
                        {pi > 0 && ' · '}
                        <Text as="span" color={SEMANTIC_COLORS.textTertiary} textTransform="uppercase" letterSpacing="0.1em">
                          {p.label}
                        </Text>{' '}
                        <Text as="span" color={CONF_COLOR[p.conf]}>
                          {p.fact}
                        </Text>{' '}
                        <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                          [{p.conf}]
                        </Text>
                      </Text>
                    ))}
                  </>
                )}
              </Text>
            </Grid>
          )
        })}
      </Box>
      <Stamp>
        mock — in production this is reconstructed by an indexer from VaultServed / VaultSlashed / VenueRecalled
        events and globalVenueBannedUntil; no on-chain aggregates exist · redemptions are 1:1 at peg, so there is
        no premium to show
      </Stamp>
    </Card>
  </Box>
  )
}

export default RedemptionHistory
