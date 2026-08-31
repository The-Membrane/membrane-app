import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { MockStamp } from '@/components/demo'

import { Eyebrow, Lede } from './atoms'
import { ROUTES, ROUTE_STATS } from './fixtures'
import { Route } from './types'
import { routeBar } from './utils'

const RouteRow: React.FC<{ r: Route }> = ({ r }) => {
  const bar = routeBar(r)
  const col = bar.positive ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger
  return (
    <Box
      display="grid"
      gridTemplateColumns={{ base: '1fr auto', md: '1.7fr 62px 1fr 74px' }}
      gridTemplateAreas={{ base: `"nm net" "bar bar"`, md: `"nm pos bar net"` }}
      gap={{ base: '7px 10px', md: SPACING.md }}
      alignItems="center"
      bg={r.big ? SEMANTIC_COLORS.bgTertiary : SEMANTIC_COLORS.bgSecondary}
      px={SPACING.md}
      py={SPACING.sm}
      fontSize="11.5px"
    >
      <Text gridArea="nm" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
        {r.nm}
      </Text>
      <Text gridArea="pos" display={{ base: 'none', md: 'block' }} fontFamily={TYPOGRAPHY.fontMono} textAlign="right" color={SEMANTIC_COLORS.textTertiary} sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {r.pos}
      </Text>
      <Box gridArea="bar" position="relative" h="8px" bg="rgba(236,230,216,0.05)">
        <Box position="absolute" top="-2px" bottom="-2px" left={`${bar.zero}%`} w="1px" bg={SEMANTIC_COLORS.borderStrong} />
        <Box position="absolute" top={0} bottom={0} left={`${bar.left}%`} w={`${bar.fillPct}%`} bg={col} />
      </Box>
      <Text gridArea="net" fontFamily={TYPOGRAPHY.fontMono} textAlign="right" color={col} sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {r.net >= 0 ? '+' : ''}
        {r.net.toFixed(2)}
      </Text>
    </Box>
  )
}

export const Routes: React.FC = () => (
  <Box as="section" display="grid" gap={SPACING.lg}>
    <Box display="grid" gap={SPACING.md}>
      <HStack spacing={SPACING.md} align="baseline">
        <Eyebrow>1,245 real positions, measured on-chain</Eyebrow>
        <MockStamp label="measured" />
      </HStack>
      <Text as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontWeight={TYPOGRAPHY.normal} fontSize={{ base: '21px', md: '30px' }} lineHeight="1.15" color={SEMANTIC_COLORS.textPrimary}>
        The route is the trade
      </Text>
      <Lede maxW="80ch">
        Every one of these is someone borrowing on Aave, Spark, Morpho or Compound and putting it somewhere. Borrow rate and venue yield both read
        from chain. The spread between two rows is far larger than the spread between two protocols — which is why the route, not the venue you
        borrowed from, is the decision. These routes are the root system: every inefficiency closed here feeds the core the rest of the network
        grows from.
      </Lede>
    </Box>

    {/* routes table */}
    <Box display="grid" gap="1px" bg={SEMANTIC_COLORS.borderSubtle} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      {/* header */}
      <Box
        display="grid"
        gridTemplateColumns={{ base: '1fr auto', md: '1.7fr 62px 1fr 74px' }}
        gridTemplateAreas={{ base: `"nm net"`, md: `"nm pos bar net"` }}
        gap={SPACING.md}
        alignItems="center"
        bg={SEMANTIC_COLORS.bgTertiary}
        px={SPACING.md}
        py={SPACING.sm}
      >
        {(['Route', 'Pos', 'Net carry', '%'] as const).map((h, i) => (
          <Text
            key={h}
            gridArea={['nm', 'pos', 'bar', 'net'][i]}
            display={i === 1 || i === 2 ? { base: 'none', md: 'block' } : 'block'}
            textAlign={i >= 1 ? 'right' : 'left'}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="9px"
            letterSpacing="0.2em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textSecondary}
          >
            {h}
          </Text>
        ))}
      </Box>
      {ROUTES.map((r) => (
        <RouteRow key={r.nm} r={r} />
      ))}
    </Box>

    {/* summary stats */}
    <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="1px" bg={SEMANTIC_COLORS.borderSubtle} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      {ROUTE_STATS.map((s) => (
        <Box key={s.k} bg={SEMANTIC_COLORS.bgSecondary} p={SPACING.md} display="grid" gap={SPACING.xs}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
            {s.k}
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="19px" sx={{ fontVariantNumeric: 'tabular-nums' }} color={s.tone ? SEMANTIC_COLORS[s.tone] : SEMANTIC_COLORS.textPrimary}>
            {s.v}
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
            {s.n}
          </Text>
        </Box>
      ))}
    </Box>

    <Lede maxW="80ch">
      Nearly a third of these positions are underwater as measured. The worst is 21 borrowers paying 3.75% to stake into a module returning zero —
      that is not a modelling artifact, it is what they are doing. Picking the row is the whole skill, and it is a skill because the rows are this
      far apart.
    </Lede>
  </Box>
)

export default Routes
