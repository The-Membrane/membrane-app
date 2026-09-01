// OnchainStandings — the per-tier leaderboards from the Standings contract. Protocol-scoped
// and live regardless of wallet connection (demo-first). Numbers mono; lower steps = better.

import React, { useState } from 'react'
import { Box, Button, HStack, Text, VStack } from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { TIER_NAMES } from '@/lib/qgame/abi'
import { useQGameStandings } from '@/hooks/useQGame'

const label = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}
const trunc = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const OnchainStandings: React.FC<{ highlight?: string | null }> = ({ highlight }) => {
  const { data, isLoading } = useQGameStandings()
  const [tier, setTier] = useState(0)
  const board = data?.find((t) => t.tier === tier)

  return (
    <Card variant="default">
      <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
        <Text {...label}>On-chain standings</Text>

        <HStack spacing={SPACING.xs} flexWrap="wrap">
          {TIER_NAMES.map((name, i) => {
            const active = tier === i
            return (
              <Button
                key={name}
                onClick={() => setTier(i)}
                size="xs"
                variant="ghost"
                borderRadius={0}
                border="1px solid"
                borderColor={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
                color={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
                fontFamily={TYPOGRAPHY.fontMono}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _active={ACTIVE_EFFECTS.dim}
                _focus={FOCUS_STYLES.ring}
              >
                {name}
              </Button>
            )
          })}
        </HStack>

        <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
          {isLoading ? (
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
              loading standings…
            </Text>
          ) : !board || board.entries.length === 0 ? (
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
              No records yet on {TIER_NAMES[tier]}. Finish a race to claim the top slot.
            </Text>
          ) : (
            <VStack align="stretch" spacing={SPACING.xs}>
              {board.entries.map((e, i) => {
                const me = highlight && e.who.toLowerCase() === highlight.toLowerCase()
                return (
                  <HStack key={`${e.who}-${i}`} justify="space-between">
                    <HStack spacing={SPACING.sm}>
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={i === 0 ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textTertiary}
                        w="24px"
                      >
                        {i + 1}
                      </Text>
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={me ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textPrimary}
                      >
                        {trunc(e.who)}{me ? ' · you' : ''}
                      </Text>
                    </HStack>
                    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
                      {e.steps} steps
                    </Text>
                  </HStack>
                )
              })}
            </VStack>
          )}
        </Box>
      </VStack>
    </Card>
  )
}

export default OnchainStandings
