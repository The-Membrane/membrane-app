import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { BasisInfo, Colour } from '@/lib/oracleRegistry/types'

import { basisBar, COLOUR_META, fmtBps } from './viewModel'

// The structural gap between a basis feed (exchange rate, CAPO cap, fixed schedule, peg
// assumption) and the market consensus. Centre tick = market; shaded = the asset's band;
// marker = this feed. The scale always holds the marker, so a large basis reads as large.

export const BasisBar: React.FC<{ basis: BasisInfo; bandBps: number; colour: Colour }> = ({
  basis,
  bandBps,
  colour,
}) => {
  const g = basisBar(basis.bps, bandBps)
  return (
    <Box>
      <HStack justify="space-between" fontFamily={TYPOGRAPHY.fontMono} fontSize="10px">
        <Text
          as="span"
          letterSpacing="0.14em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textTertiary}
        >
          Basis vs market
        </Text>
        <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
          {fmtBps(basis.bps)}
        </Text>
      </HStack>
      <Box
        position="relative"
        h="10px"
        mt="3px"
        role="img"
        aria-label={`Basis ${fmtBps(basis.bps)} versus market; band plus or minus ${bandBps} bps; scale plus or minus ${Math.round(g.scale)} bps`}
      >
        <Box
          position="absolute"
          left={0}
          right={0}
          top="4px"
          h="2px"
          bg={SEMANTIC_COLORS.borderSubtle}
        />
        <Box
          position="absolute"
          top="2px"
          h="6px"
          left={`${g.bandLeftPct}%`}
          w={`${g.bandWidthPct}%`}
          bg={SEMANTIC_COLORS.borderStrong}
        />
        <Box
          position="absolute"
          top={0}
          h="10px"
          left="50%"
          w="1px"
          bg={SEMANTIC_COLORS.textSecondary}
        />
        <Box
          position="absolute"
          top={0}
          h="10px"
          w="3px"
          ml="-1px"
          left={`${g.markerPct}%`}
          bg={COLOUR_META[colour].token}
        />
      </Box>
      <HStack
        justify="space-between"
        mt="2px"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="9px"
        color={SEMANTIC_COLORS.textTertiary}
        aria-hidden="true"
      >
        <Text as="span">{fmtBps(-g.scale)}</Text>
        <Text as="span">market</Text>
        <Text as="span">{fmtBps(g.scale)}</Text>
      </HStack>
    </Box>
  )
}

export default BasisBar
