// PetDashboard — a pet's PetLens stats, BYTES balance, and a (burner-signed) feed action.
// Numbers are always mono. Feed is promptless when a play session is live.

import React from 'react'
import { Box, Button, SimpleGrid, Text, VStack } from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { useQGameBytes, useFeed, type PetWithId } from '@/hooks/useQGame'

const label = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}
const MOODS = ['—', 'grumpy', 'peckish', 'happy', 'pumped']

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <Box>
      <Text {...label} fontSize="10px">{k}</Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.body} color={tone ?? SEMANTIC_COLORS.textPrimary}>
        {v}
      </Text>
    </Box>
  )
}

const PetDashboard: React.FC<{ pet: PetWithId; sessionLive: boolean }> = ({ pet, sessionLive }) => {
  const { data: bytes } = useQGameBytes()
  const feed = useFeed()
  const c = pet.card
  const winRate = c.races > 0 ? `${((c.wins / c.races) * 100).toFixed(0)}%` : '—'
  const fed = c.satiation > 0n

  return (
    <Card variant="default">
      <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
        <Box>
          <Text {...label}>Pet #{pet.id.toString()}</Text>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h3}
            color={SEMANTIC_COLORS.textPrimary}
          >
            {c.name || 'Unnamed runner'}
          </Text>
        </Box>

        <SimpleGrid columns={{ base: 2, sm: 3 }} spacing={SPACING.md}>
          <Stat k="Races" v={String(c.races)} />
          <Stat k="Wins" v={String(c.wins)} tone={c.wins > 0 ? SEMANTIC_COLORS.success : undefined} />
          <Stat k="Win rate" v={winRate} />
          <Stat k="Train races" v={String(c.trainRaces)} />
          <Stat k="Streak" v={String(c.streak)} />
          <Stat k="Mood" v={MOODS[c.moodLvl] ?? '—'} />
          <Stat k="Race eps" v={`${c.raceEpsPct}%`} />
          <Stat k="Train eps" v={`${c.trainEpsPct}%`} />
          <Stat
            k="BYTES"
            v={bytes != null ? bytes.toString() : '…'}
            tone={SEMANTIC_COLORS.primary}
          />
        </SimpleGrid>

        <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
          <Text {...label} mb={SPACING.xs}>Satiation</Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={fed ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}>
            {fed ? `fed · ${c.satiation.toString()}s of nerve left` : 'hungry — shakier paws (higher race epsilon)'}
          </Text>
          <Button
            mt={SPACING.sm}
            size="sm"
            variant="ghost"
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            isDisabled={!sessionLive || feed.isPending}
            isLoading={feed.isPending}
            loadingText="Feeding…"
            transition={TRANSITIONS.colors}
            _hover={HOVER_EFFECTS.borderHighlight}
            _active={ACTIVE_EFFECTS.dim}
            _focus={FOCUS_STYLES.ring}
            onClick={() => feed.mutate({ id: pet.id })}
          >
            Feed (burns BYTES)
          </Button>
          {!sessionLive && (
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.xs}>
              Start a play session to feed, train, and race without wallet prompts.
            </Text>
          )}
          {feed.isError && (
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.danger} mt={SPACING.xs}>
              {(feed.error as Error)?.message ?? 'Feed failed'}
            </Text>
          )}
        </Box>
      </VStack>
    </Card>
  )
}

export default PetDashboard
