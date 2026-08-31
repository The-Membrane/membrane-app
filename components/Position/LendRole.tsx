import React from 'react'
import { Box, Grid, HStack, Text, VStack } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { SectionHead } from './primitives'
import { FeedList } from './FeedList'
import { LEND_FEED, SEATS } from './fixtures'
import { withAlpha } from './utils'
import { LossSegment, Seat } from './types'

const SEG_ALPHA: Record<LossSegment['tone'], number> = { teal: 0.35, gold: 0.4, phos: 0.28, blood: 0.25 }
const SEG_BASE: Record<LossSegment['tone'], string> = {
  teal: SEMANTIC_COLORS.info,
  gold: SEMANTIC_COLORS.warning,
  phos: SEMANTIC_COLORS.success,
  blood: SEMANTIC_COLORS.danger,
}

const HeadCell: React.FC<{ k: string; v: string; note: string }> = ({ k, v, note }) => (
  <Box display="grid" gap="5px" alignContent="start" minW={0}>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.24em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
      {k}
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="24px" lineHeight="1.05" color={SEMANTIC_COLORS.textPrimary}>
      {v}
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary} lineHeight={1.5}>
      {note}
    </Text>
  </Box>
)

const SeatCard: React.FC<{ seat: Seat }> = ({ seat }) => (
  <Card>
    <HStack justify="space-between" align="baseline" spacing="10px">
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="15px" color={SEMANTIC_COLORS.textPrimary}>
        {seat.name}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
        {seat.staked}
      </Text>
    </HStack>
    <HStack h="9px" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt={SPACING.md} spacing={0}>
      {seat.lossOrder.map((seg, i) => (
        <Box
          key={i}
          h="100%"
          w={`${seg.width}%`}
          bg={withAlpha(SEG_BASE[seg.tone], SEG_ALPHA[seg.tone])}
          outline={seg.me ? `1px solid ${SEMANTIC_COLORS.success}` : undefined}
          outlineOffset={seg.me ? '-1px' : undefined}
        />
      ))}
    </HStack>
    <VStack align="stretch" spacing="5px" mt={SPACING.md} pt="11px" borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      {seat.mini.map((row, i) => (
        <HStack key={i} justify="space-between" fontSize="10.5px" color={SEMANTIC_COLORS.textSecondary}>
          <Text as="span">{row.label}</Text>
          <Box as="span" fontWeight={400} color={row.color === 'gold' ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary}>
            {row.value}
          </Box>
        </HStack>
      ))}
    </VStack>
  </Card>
)

/** The Lend role: staked tranches, their loss order, and realized fees. */
export const LendRole: React.FC = () => (
  <Box>
    <Card as={Grid} gridTemplateColumns={{ base: '1fr', md: '1fr 1fr 1fr' }} gap={{ base: SPACING.lg, md: '22px' }}>
      <HeadCell k="Staked" v="$14,300" note="across 2 tranches" />
      <HeadCell k="Fees paid to you" v="$412.85" note="realized, lifetime" />
      <HeadCell k="Losses taken" v="$0" note="no haircut has ever reached a tranche" />
    </Card>

    <SectionHead index="01 /" title="Your seats" note="each collateral has its own loss order — full detail on the Earn page" />
    <Grid gridTemplateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={SPACING.base}>
      {SEATS.map((seat) => (
        <SeatCard key={seat.name} seat={seat} />
      ))}
    </Grid>

    <SectionHead index="02 /" title="Fees paid to you" note="realized only, by collateral" />
    <Card>
      <FeedList rows={LEND_FEED} />
    </Card>
  </Box>
)
