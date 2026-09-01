import React from 'react'
import { Text } from '@chakra-ui/react'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

/* ── Stat card ── */
export const StatCard: React.FC<{
  label: string
  value: string
  valueColor?: string
  glow?: boolean
}> = ({ label, value, valueColor = SEMANTIC_COLORS.info, glow = false }) => (
  <Card variant="subtle" p={4} borderRadius={0}>
    <Text
      fontSize="xs"
      color={SEMANTIC_COLORS.textSecondary}
      fontFamily="mono"
      letterSpacing="0.5px"
      mb={2}
    >
      {label}
    </Text>
    <Text
      fontSize="2xl"
      fontWeight="bold"
      color={valueColor}
      fontFamily="mono"
    >
      {value}
    </Text>
  </Card>
)
