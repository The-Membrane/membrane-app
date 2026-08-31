import React from 'react'
import { Box, Grid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { OracleChip, SectionHeading } from './atoms'
import { COLL } from './fixtures'

export interface CollateralProps {
  selected: number
  onSelect: (i: number) => void
  onOpenOracle: (sym: string) => void
}

export const Collateral: React.FC<CollateralProps> = ({ selected, onSelect, onOpenOracle }) => (
  <Box>
    <SectionHeading index="01 /" title="Collateral" />
    <Grid templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }} gap={SPACING.md} mt={SPACING.md}>
      {COLL.map((c, i) => (
        <Box
          key={c.sym}
          as="button"
          type="button"
          textAlign="left"
          display="grid"
          gap={SPACING.xs}
          bg={i === selected ? SEMANTIC_COLORS.bgTertiary : SEMANTIC_COLORS.bgSecondary}
          border="1px solid"
          borderColor={i === selected ? SEMANTIC_COLORS.borderStrong : SEMANTIC_COLORS.borderSubtle}
          borderRadius={0}
          color={SEMANTIC_COLORS.textPrimary}
          p={SPACING.md}
          cursor="pointer"
          transition={TRANSITIONS.colors}
          _hover={{ borderColor: SEMANTIC_COLORS.success }}
          _focus={FOCUS_STYLES.ring}
          onClick={() => onSelect(i)}
        >
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
            {c.sym}
            <OracleChip sym={c.sym} onOpen={onOpenOracle} />
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textSecondary}>
            earns {c.yld.toFixed(1)}% while posted · max draw {(c.maxLtv * 100).toFixed(0)}%
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
            1-in-1000 8h move: −{c.p999.toFixed(2)}% · worst ever: −{c.worst.toFixed(2)}% · n={c.n.toLocaleString()}
          </Text>
        </Box>
      ))}
    </Grid>
  </Box>
)

export default Collateral
