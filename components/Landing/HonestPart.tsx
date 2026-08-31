import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, Lede, Num } from './atoms'
import { LandingCalc, LandingState } from './types'
import { coverMultiple, recallLive, recallRows, usd } from './utils'

interface Props {
  st: LandingState
  c: LandingCalc
}

const RiskCard: React.FC<{ k: string; value: React.ReactNode; note: string }> = ({ k, value, note }) => (
  <Box bg={SEMANTIC_COLORS.bgSecondary} p={SPACING.base} display="grid" gap={SPACING.xs}>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.22em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
      {k}
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="19px" sx={{ fontVariantNumeric: 'tabular-nums' }} color={SEMANTIC_COLORS.textPrimary}>
      {value}
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} lineHeight="1.5">
      {note}
    </Text>
  </Box>
)

export const HonestPart: React.FC<Props> = ({ st, c }) => {
  const cover = coverMultiple(c)
  const rows = recallRows(c)
  const live = recallLive(c)

  return (
    <Box as="section" display="grid" gap={SPACING.lg}>
      <Box display="grid" gap={SPACING.md}>
        <Eyebrow>What would actually break it</Eyebrow>
        <Text as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontWeight={TYPOGRAPHY.normal} fontSize={{ base: '21px', md: '30px' }} lineHeight="1.15" color={SEMANTIC_COLORS.textPrimary}>
          The honest part
        </Text>
        <Lede>Bitcoin falls, your loan does not. These are the numbers that decide whether that matters.</Lede>
      </Box>

      {/* risk grid */}
      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="1px" bg={SEMANTIC_COLORS.borderSubtle} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
        <RiskCard k="Survives a drop of" value={`−${c.dropPct.toFixed(0)}%`} note="before the clock starts" />
        <RiskCard k="Then you get" value="8 hours" note="to add collateral or repay — not an instant close" />
        <RiskCard k="Bitcoin would need to reach" value={usd(c.trigger)} note="for that clock to start at all" />
        <RiskCard
          k="Yield covers interest"
          value={<Text as="span" color={cover >= 1 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}>{`${cover.toFixed(1)}×`}</Text>}
          note="while the venue holds its rate"
        />
      </Box>

      {/* auto-repayment / venue recall */}
      <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderStrong} bg={SEMANTIC_COLORS.bgSecondary} p={SPACING.base} display="grid" gap={SPACING.md}>
        <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={SPACING.md} flexWrap="wrap">
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="17px" color={SEMANTIC_COLORS.textPrimary}>
            Your bitcoin is not the first thing sold
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.success} border="1px solid" borderColor="rgba(155,220,79,0.45)" py={SPACING.xs} px={SPACING.sm}>
            Venue recall
          </Text>
        </Box>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} maxW="80ch" lineHeight="1.6">
          If you are liquidated, the engine walks the venues you deployed into and drags back whatever is liquid, straight against the debt. Only
          what it cannot cover comes out of your collateral. It measures what actually arrived rather than what the venue claims it sent.
        </Text>

        {/* trajectory cells */}
        <Box display="grid" gridTemplateColumns={{ base: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' }} gap="1px" bg={SEMANTIC_COLORS.borderSubtle} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
          {rows.map((r) => (
            <Box key={r.w} bg={SEMANTIC_COLORS.bgSecondary} px={SPACING.md} py={SPACING.md} display="grid" gap={SPACING.xs}>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.2em" textTransform="uppercase" color={r.now ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textTertiary}>
                {r.w}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="15px" sx={{ fontVariantNumeric: 'tabular-nums' }} color={SEMANTIC_COLORS.textPrimary}>
                {usd(r.d)}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" sx={{ fontVariantNumeric: 'tabular-nums' }} color={r.now ? SEMANTIC_COLORS.textSecondary : r.warn ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.success}>
                {r.n}
              </Text>
            </Box>
          ))}
        </Box>

        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary} lineHeight="1.6">
          On the {c.v.mix} mix, <Num>{usd(live)}</Num> of a <Num>{usd(c.debt)}</Num> loan repays itself before a single satoshi is sold. Even if a
          venue returns <Num>nothing</Num> the balance is still yours, it just cannot arrive in time. Which venues you picked is what sets that
          number, and it is the same choice that set your yield.
        </Text>
      </Box>
    </Box>
  )
}

export default HonestPart
