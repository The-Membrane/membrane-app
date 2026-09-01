// Public race leaderboard — GET /api/game/leaderboard (Phase 5,
// docs/OFFCHAIN_QRACING_PLAN.md). Living Typeface: mono numbers, sharp corners,
// hairline borders, SEMANTIC_COLORS/TYPOGRAPHY/SPACING — do NOT copy the legacy
// Press-Start-2P/cyberpunk styling elsewhere in components/Racing/.

import React, { useState } from 'react'
import { Box, HStack, VStack, Text, Table, Thead, Tbody, Tr, Th, Td, Skeleton } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import useOffchainRacing from '@/hooks/useOffchainRacing'

type BoardKey = 'top_times' | 'byte_earned'

type LeaderboardEntry = {
  rank: number
  playerId: string
  username: string | null
  value: string
}

type LeaderboardResponse = { board: BoardKey; entries: LeaderboardEntry[] }

async function fetchLeaderboard(board: BoardKey): Promise<LeaderboardResponse> {
  const res = await fetch(`/api/game/leaderboard?board=${board}&limit=20`)
  if (!res.ok) throw new Error(`leaderboard_fetch_failed_${res.status}`)
  return res.json()
}

function formatTicks(ticks: string): string {
  const n = Number(ticks)
  return Number.isFinite(n) ? `${n.toLocaleString()} ticks` : ticks
}

// byte_ledger deltas are 6-decimal base units (GAME.BYTE_DECIMALS in lib/game/config.ts).
function formatByte(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  return `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} BYTE`
}

function displayName(username: string | null, playerId: string): string {
  return username || `player-${playerId.slice(0, 6)}`
}

const TABS: { key: BoardKey; label: string }[] = [
  { key: 'top_times', label: 'Top Times' },
  { key: 'byte_earned', label: 'Byte Earned' },
]

export const Leaderboard: React.FC = () => {
  const [board, setBoard] = useState<BoardKey>('top_times')
  const { state } = useOffchainRacing()
  const currentPlayerId = state.data?.player.id

  const { data, isLoading, isError } = useQuery<LeaderboardResponse>({
    queryKey: ['offchain-game', 'leaderboard', board],
    queryFn: () => fetchLeaderboard(board),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })

  return (
    <Card variant="default" p={SPACING_PATTERNS.cardPadding}>
      <VStack align="stretch" spacing={SPACING.md}>
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h4}
          fontWeight={TYPOGRAPHY.medium}
          color={SEMANTIC_COLORS.textPrimary}
        >
          Leaderboard
        </Text>

        <HStack spacing={SPACING.sm} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
          {TABS.map((tab) => {
            const active = tab.key === board
            return (
              <Box
                as="button"
                key={tab.key}
                onClick={() => setBoard(tab.key)}
                px={SPACING.md}
                py={SPACING.sm}
                borderBottom="2px solid"
                borderColor={active ? SEMANTIC_COLORS.primary : 'transparent'}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _focus={FOCUS_STYLES.ring}
                _focusVisible={FOCUS_STYLES.ring}
              >
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  textTransform="uppercase"
                  letterSpacing="0.28em"
                  color={active ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
                >
                  {tab.label}
                </Text>
              </Box>
            )
          })}
        </HStack>

        {isLoading && (
          <VStack align="stretch" spacing={SPACING.xs}>
            {[0, 1, 2].map((i) => (
              <Skeleton
                key={i}
                height="28px"
                startColor={SEMANTIC_COLORS.bgTertiary}
                endColor={SEMANTIC_COLORS.bgSecondary}
              />
            ))}
          </VStack>
        )}

        {isError && (
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
            Leaderboard unavailable.
          </Text>
        )}

        {!isLoading && !isError && data && (
          <Table size="sm" variant="unstyled">
            <Thead>
              <Tr>
                <Th
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  textTransform="uppercase"
                  letterSpacing="0.28em"
                  color={SEMANTIC_COLORS.textTertiary}
                  borderBottom="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  px={SPACING.sm}
                >
                  Rank
                </Th>
                <Th
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  textTransform="uppercase"
                  letterSpacing="0.28em"
                  color={SEMANTIC_COLORS.textTertiary}
                  borderBottom="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  px={SPACING.sm}
                >
                  Racer
                </Th>
                <Th
                  isNumeric
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.label}
                  textTransform="uppercase"
                  letterSpacing="0.28em"
                  color={SEMANTIC_COLORS.textTertiary}
                  borderBottom="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  px={SPACING.sm}
                >
                  {board === 'top_times' ? 'Best Time' : 'Earned'}
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {data.entries.length === 0 && (
                <Tr>
                  <Td colSpan={3} border="none" px={SPACING.sm}>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={SEMANTIC_COLORS.textSecondary}
                    >
                      No races verified yet.
                    </Text>
                  </Td>
                </Tr>
              )}
              {data.entries.map((entry) => {
                const isMe = entry.playerId === currentPlayerId
                return (
                  <Tr key={entry.playerId} bg={isMe ? 'rgba(155, 220, 79, 0.08)' : 'transparent'}>
                    <Td
                      border="none"
                      px={SPACING.sm}
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={isMe ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
                    >
                      #{entry.rank}
                    </Td>
                    <Td
                      border="none"
                      px={SPACING.sm}
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={isMe ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textPrimary}
                    >
                      {displayName(entry.username, entry.playerId)}
                      {isMe && (
                        <Text as="span" ml={SPACING.xs} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.primary}>
                          (you)
                        </Text>
                      )}
                    </Td>
                    <Td
                      isNumeric
                      border="none"
                      px={SPACING.sm}
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      fontWeight={TYPOGRAPHY.medium}
                      color={isMe ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textPrimary}
                    >
                      {board === 'top_times' ? formatTicks(entry.value) : formatByte(entry.value)}
                    </Td>
                  </Tr>
                )
              })}
            </Tbody>
          </Table>
        )}
      </VStack>
    </Card>
  )
}

export default Leaderboard
