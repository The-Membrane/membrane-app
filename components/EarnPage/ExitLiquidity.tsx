import React from 'react'
import { Box, Flex, Grid, HStack, Text, VStack, Wrap } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { MockStamp } from '@/components/demo'

import { CapacityBandKey, VenueLiquidity } from './types'
import { CAPACITY_BANDS, CAPACITY_READS_STAMP, VENUE_LIQUIDITY } from './fixtures'
import { bandSharePercent, buildCapacitySummary, venueSharePercent, venueTotalUsd, usd } from './utils'

/** Band → semantic token, ported from the proto's BANDS rgba palette (script :425-427). Order is load-bearing. */
const BAND_COLOR: Record<CapacityBandKey, string> = {
  instant: SEMANTIC_COLORS.success,
  cooling: SEMANTIC_COLORS.warning,
  stranded: SEMANTIC_COLORS.danger,
}

const NoteRun: React.FC<{ note: VenueLiquidity['note'] }> = ({ note }) => (
  <>
    {note.map((seg, i) => {
      const color = seg.tone
        ? seg.tone === 'success'
          ? SEMANTIC_COLORS.success
          : seg.tone === 'warning'
            ? SEMANTIC_COLORS.warning
            : SEMANTIC_COLORS.danger
        : undefined
      return (
        <Text as="span" key={i} color={color} fontWeight={seg.bold ? TYPOGRAPHY.semibold : undefined}>
          {seg.text}
        </Text>
      )
    })}
  </>
)

/** Sect 02 "Can you leave right now" — the three-band withdrawal capacity surface (proto :199-209, 424-464). */
export const ExitLiquidity: React.FC = () => {
  const bands = CAPACITY_BANDS.filter((b) => b.amountUsd > 0)

  return (
    <Card variant="default">
      <Flex h="22px" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} overflow="hidden">
        {bands.map((band) => (
          <Box key={band.key} title={band.key} h="100%" w={`${bandSharePercent(band).toFixed(1)}%`} bg={BAND_COLOR[band.key]} opacity={0.75} />
        ))}
      </Flex>

      <Wrap spacing={SPACING.base} mt={SPACING.md}>
        {bands.map((band) => (
          <HStack key={band.key} spacing={SPACING.sm}>
            <Box w="9px" h="9px" bg={BAND_COLOR[band.key]} opacity={0.75} />
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
              {band.label} · {usd(band.amountUsd)}
            </Text>
          </HStack>
        ))}
      </Wrap>

      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textPrimary} letterSpacing="0.03em" mt={SPACING.md}>
        {buildCapacitySummary()}
      </Text>

      <VStack align="stretch" spacing={0} mt={SPACING.lg}>
        {VENUE_LIQUIDITY.map((venue, i) => {
          const total = venueTotalUsd(venue)
          return (
            <Grid
              key={venue.venue}
              templateColumns={{ base: '1fr', md: '120px 1fr 240px' }}
              gap={SPACING.md}
              alignItems="center"
              py={SPACING.md}
              borderBottom={i < VENUE_LIQUIDITY.length - 1 ? '1px solid' : undefined}
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Box>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
                  {venue.venue}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="9px"
                  color={SEMANTIC_COLORS.textTertiary}
                  letterSpacing="0.14em"
                  textTransform="uppercase"
                >
                  {venue.sub}
                </Text>
              </Box>

              <Flex h="13px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} overflow="hidden">
                {venue.instantUsd > 0 && <Box h="100%" w={`${venueSharePercent(venue, 'instant')}%`} bg={BAND_COLOR.instant} opacity={0.75} />}
                {venue.coolingUsd > 0 && <Box h="100%" w={`${venueSharePercent(venue, 'cooling')}%`} bg={BAND_COLOR.cooling} opacity={0.7} />}
                {venue.strandedUsd > 0 && <Box h="100%" w={`${venueSharePercent(venue, 'stranded')}%`} bg={BAND_COLOR.stranded} opacity={0.7} />}
              </Flex>

              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="9.5px"
                color={SEMANTIC_COLORS.textSecondary}
                lineHeight={1.55}
                textAlign={{ base: 'left', md: 'right' }}
              >
                {usd(total)} deployed · <NoteRun note={venue.note} />
              </Text>
            </Grid>
          )
        })}
      </VStack>

      <HStack spacing={SPACING.sm} mt={SPACING.md} align="baseline">
        <MockStamp label="mock" />
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.03em">
          {CAPACITY_READS_STAMP}
        </Text>
      </HStack>
    </Card>
  )
}

export default ExitLiquidity
