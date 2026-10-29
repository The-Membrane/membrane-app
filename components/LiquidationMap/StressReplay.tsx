import React from 'react'
import { Box, HStack, Text, VStack } from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Card } from '@/components/ui/Card'
import { Eyebrow } from '@/components/Evidence/atoms'

import { usd2 } from './liqmapLogic'

// Curator stress replay: past crash paths on today's Aave Ethereum price book,
// liquidated debt under Aave's rules vs Membrane's (board Q26-TERMINAL-APP).
// A measured snapshot; the bars compare the two rule sets on one scale.

export type StressDoc = {
  source: string
  rules: string
  notes: string[]
  crashes: {
    name: string
    ethDrop: number
    btcDrop: number
    aaveUsd: number
    membraneUsd: number
  }[]
}

export const StressReplay: React.FC<{ doc: StressDoc | null }> = ({ doc }) => {
  if (!doc) return null
  const max = Math.max(...doc.crashes.map((c) => c.aaveUsd), 1)
  return (
    <Card variant="default" p={SPACING_PATTERNS.cardPadding}>
      <VStack align="stretch" spacing={SPACING.base}>
        <Eyebrow>07 / Past crashes on today&apos;s book · Aave vs Membrane rules</Eyebrow>
        {doc.crashes.map((c) => (
          <VStack key={c.name} align="stretch" spacing={SPACING.xs}>
            <HStack justify="space-between">
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                {c.name} · ETH −{Math.round(c.ethDrop * 100)}% · BTC −{Math.round(c.btcDrop * 100)}%
                in 72 h
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.success}
              >
                {Math.round((1 - c.membraneUsd / c.aaveUsd) * 100)}% less liquidated
              </Text>
            </HStack>
            {(
              [
                ['Aave', c.aaveUsd, SEMANTIC_COLORS.danger],
                ['Membrane', c.membraneUsd, SEMANTIC_COLORS.success],
              ] as const
            ).map(([label, v, color]) => (
              <HStack key={label} spacing={SPACING.sm}>
                <Text
                  w="80px"
                  flexShrink={0}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                >
                  {label}
                </Text>
                <Box flex="1" h="8px" bg={SEMANTIC_COLORS.bgTertiary}>
                  <Box h="100%" w={`${(v / max) * 100}%`} bg={color} />
                </Box>
                <Text
                  w="64px"
                  flexShrink={0}
                  textAlign="right"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  {usd2(v)}
                </Text>
              </HStack>
            ))}
          </VStack>
        ))}
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {doc.rules}. {doc.notes.join(' ')} · {doc.source}
        </Text>
      </VStack>
    </Card>
  )
}

export default StressReplay
