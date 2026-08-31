import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { MAXV, REG } from './fixtures'
import { SectionHeading, Stamp } from './Primitives'
import { RegimeBleedRow } from './types'

const Row: React.FC<{ r: RegimeBleedRow }> = ({ r }) => {
  const w = (Math.abs(r.v) / MAXV) * 100
  const positive = r.v >= 0
  return (
    <Box
      display="grid"
      gridTemplateColumns="1.2fr 1fr auto"
      gap={SPACING.md}
      alignItems="center"
      py={SPACING.sm}
      borderBottom="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      fontSize="11.5px"
      _last={{ borderBottom: 0 }}
    >
      <Box fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>
        <Text as="span">{r.nm}</Text>
        <Text fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
          {r.why}
        </Text>
      </Box>
      <Box
        position="relative"
        h="7px"
        bg={SEMANTIC_COLORS.bgPrimary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
      >
        <Box
          position="absolute"
          top={0}
          bottom={0}
          left={positive ? 0 : undefined}
          right={positive ? undefined : 0}
          w={`${w}%`}
          bg={positive ? SEMANTIC_COLORS.info : SEMANTIC_COLORS.danger}
        />
      </Box>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        textAlign="right"
        color={positive ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.danger}
      >
        {positive ? '+' : ''}
        {r.v.toFixed(1)}
      </Text>
    </Box>
  )
}

export const RegimeBleed: React.FC = () => (
  <>
    <SectionHeading
      index="03"
      title="Where your last submission bled"
      note="per-regime breakdown — this is the practice loop, not a verdict"
    />
    <Card p={SPACING.base}>
      <Box display="grid">
        {REG.map((r) => (
          <Row key={r.nm} r={r} />
        ))}
      </Box>
      <Stamp>submission #3 · scored 2026-08-15 over 1,000 draws · seed set rotates per scoring epoch</Stamp>
    </Card>
  </>
)

export default RegimeBleed
