// Public race leaderboard — GET /api/game/leaderboard (Phase 5,
// docs/OFFCHAIN_QRACING_PLAN.md; extended for the on-chain game — see
// pages/api/game/leaderboard.ts for the board/source shape). Living Typeface: mono
// numbers, sharp corners, hairline borders, SEMANTIC_COLORS/TYPOGRAPHY/SPACING — do NOT
// copy the legacy Press-Start-2P/cyberpunk styling elsewhere in components/Racing/.

import React, { useState } from 'react'
import {
  Box,
  HStack,
  VStack,
  Text,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Skeleton,
} from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import useOffchainRacing from '@/hooks/useOffchainRacing'

type BoardKey = 'top_times' | 'byte_earned' | 'daily' | 'ghost'
type SourceFilter = 'all' | 'onchain' | 'practice'

type LeaderboardEntry = {
  source: 'onchain' | 'practice'
  rank: number | null
  id: string
  displayName: string | null
  value: string
}

type DailyBoardDay = {
  day: string
  first: {
    wallet: string | null
    displayName: string
    occurredAt: string
    txHash: string | null
  } | null
  entries: LeaderboardEntry[]
}

type LeaderboardResponse =
  | { board: 'top_times' | 'ghost'; source: SourceFilter; entries: LeaderboardEntry[] }
  | {
      board: 'byte_earned'
      source: SourceFilter
      onchain: LeaderboardEntry[]
      practice: LeaderboardEntry[]
    }
  | { board: 'daily'; source: SourceFilter; days: DailyBoardDay[] }

async function fetchLeaderboard(
  board: BoardKey,
  source: SourceFilter,
): Promise<LeaderboardResponse> {
  const res = await fetch(`/api/game/leaderboard?board=${board}&source=${source}&limit=20`)
  if (!res.ok) throw new Error(`leaderboard_fetch_failed_${res.status}`)
  return res.json()
}

function formatTicks(ticks: string): string {
  const n = Number(ticks)
  return Number.isFinite(n) ? `${n.toLocaleString()} ticks` : ticks
}

// byte_ledger deltas (practice) and onchain_results 'byte_earned' rows are both
// 6-decimal base units (GAME.BYTE_DECIMALS in lib/game/config.ts).
function formatByte(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  return `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} BYTE`
}

function formatWins(raw: string): string {
  const n = Number(raw)
  return Number.isFinite(n) ? `${n.toLocaleString()} win${n === 1 ? '' : 's'}` : raw
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function shortWallet(wallet: string): string {
  return wallet.length > 10 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet
}

function displayName(entry: LeaderboardEntry): string {
  if (entry.displayName) return entry.displayName
  return entry.source === 'onchain' ? shortWallet(entry.id) : `player-${entry.id.slice(0, 6)}`
}

const BOARD_TABS: { key: BoardKey; label: string }[] = [
  { key: 'top_times', label: 'Top Times' },
  { key: 'byte_earned', label: 'Byte Earned' },
  { key: 'daily', label: 'Dailies' },
  { key: 'ghost', label: 'Ghost' },
]

const SOURCE_TABS: { key: SourceFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'onchain', label: 'On-chain' },
  { key: 'practice', label: 'Practice' },
]

// Every table on this page reads this way: on-chain rows show a real rank, practice
// rows always show `*` — never a number, even where the API self-ranks a practice-only
// list (byte_earned's practice column). See the legend line rendered under EntryTable.
function RankCell({ entry }: { entry: LeaderboardEntry }) {
  const isPractice = entry.source === 'practice'
  return (
    <Td
      border="none"
      px={SPACING.sm}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.small}
      color={isPractice ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textSecondary}
    >
      {isPractice ? '*' : `#${entry.rank}`}
    </Td>
  )
}

function NameCell({ entry, isMe }: { entry: LeaderboardEntry; isMe: boolean }) {
  return (
    <Td
      border="none"
      px={SPACING.sm}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.small}
      color={isMe ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textPrimary}
    >
      {displayName(entry)}
      {entry.source === 'practice' && (
        <Text
          as="span"
          ml={SPACING.xs}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="10px"
          textTransform="uppercase"
          letterSpacing="0.2em"
          color={SEMANTIC_COLORS.textTertiary}
        >
          practice
        </Text>
      )}
      {isMe && (
        <Text as="span" ml={SPACING.xs} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.primary}>
          (you)
        </Text>
      )}
    </Td>
  )
}

function EntryTable({
  entries,
  valueLabel,
  formatValue,
  isMe,
  emptyLabel,
  showLegend,
}: {
  entries: LeaderboardEntry[]
  valueLabel: string
  formatValue: (value: string) => string
  isMe: (entry: LeaderboardEntry) => boolean
  emptyLabel: string
  showLegend: boolean
}) {
  return (
    <VStack align="stretch" spacing={SPACING.xs}>
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
              {valueLabel}
            </Th>
          </Tr>
        </Thead>
        <Tbody>
          {entries.length === 0 && (
            <Tr>
              <Td colSpan={3} border="none" px={SPACING.sm}>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {emptyLabel}
                </Text>
              </Td>
            </Tr>
          )}
          {entries.map((entry) => {
            const me = isMe(entry)
            return (
              <Tr
                key={`${entry.source}-${entry.id}`}
                bg={me ? 'rgba(155, 220, 79, 0.08)' : 'transparent'}
              >
                <RankCell entry={entry} />
                <NameCell entry={entry} isMe={me} />
                <Td
                  isNumeric
                  border="none"
                  px={SPACING.sm}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  fontWeight={TYPOGRAPHY.medium}
                  color={me ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textPrimary}
                >
                  {formatValue(entry.value)}
                </Td>
              </Tr>
            )
          })}
        </Tbody>
      </Table>
      {showLegend && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>
          * practice circuit — places by value, official ranks count on-chain runs
        </Text>
      )}
    </VStack>
  )
}

export const Leaderboard: React.FC = () => {
  const [board, setBoard] = useState<BoardKey>('top_times')
  const [source, setSource] = useState<SourceFilter>('all')
  const { state } = useOffchainRacing()
  const currentPlayerId = state.data?.player.id
  const { address: currentWallet } = useAccount()

  const isMe = (entry: LeaderboardEntry) => {
    if (entry.source === 'practice') return !!currentPlayerId && entry.id === currentPlayerId
    return !!currentWallet && entry.id.toLowerCase() === currentWallet.toLowerCase()
  }

  const { data, isLoading, isError } = useQuery<LeaderboardResponse>({
    queryKey: ['offchain-game', 'leaderboard', board, source],
    queryFn: () => fetchLeaderboard(board, source),
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

        <HStack
          spacing={SPACING.sm}
          borderBottom="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          {BOARD_TABS.map((tab) => {
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

        {/* Segmented source filter: All | On-chain | Practice */}
        <HStack
          spacing={0}
          alignSelf="flex-start"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          {SOURCE_TABS.map((tab, i) => {
            const active = tab.key === source
            return (
              <Box
                as="button"
                key={tab.key}
                onClick={() => setSource(tab.key)}
                px={SPACING.md}
                py={SPACING.xs}
                bg={active ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
                borderLeft={i > 0 ? '1px solid' : 'none'}
                borderColor={SEMANTIC_COLORS.borderSubtle}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _focus={FOCUS_STYLES.ring}
                _focusVisible={FOCUS_STYLES.ring}
              >
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11px"
                  textTransform="uppercase"
                  letterSpacing="0.2em"
                  color={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
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
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            Leaderboard unavailable.
          </Text>
        )}

        {!isLoading && !isError && data && data.board === 'top_times' && (
          <EntryTable
            entries={data.entries}
            valueLabel="Best Time"
            formatValue={formatTicks}
            isMe={isMe}
            emptyLabel="No races verified yet."
            showLegend={data.entries.some((e) => e.source === 'practice')}
          />
        )}

        {!isLoading && !isError && data && data.board === 'ghost' && (
          <EntryTable
            entries={data.entries}
            valueLabel="Wins"
            formatValue={formatWins}
            isMe={isMe}
            emptyLabel="No ghost races won yet."
            showLegend={false}
          />
        )}

        {!isLoading && !isError && data && data.board === 'byte_earned' && (
          <VStack align="stretch" spacing={SPACING.lg}>
            <VStack align="stretch" spacing={SPACING.xs}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                textTransform="uppercase"
                letterSpacing="0.28em"
                color={SEMANTIC_COLORS.textSecondary}
              >
                Real BYTES — on-chain
              </Text>
              <EntryTable
                entries={data.onchain}
                valueLabel="Earned"
                formatValue={formatByte}
                isMe={isMe}
                emptyLabel="No on-chain BYTE earned yet."
                showLegend={false}
              />
            </VStack>
            <VStack align="stretch" spacing={SPACING.xs}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                textTransform="uppercase"
                letterSpacing="0.28em"
                color={SEMANTIC_COLORS.textSecondary}
              >
                Practice BYTE — not real, does not mint
              </Text>
              <EntryTable
                entries={data.practice}
                valueLabel="Earned"
                formatValue={formatByte}
                isMe={isMe}
                emptyLabel="No practice BYTE earned yet."
                showLegend={data.practice.length > 0}
              />
            </VStack>
          </VStack>
        )}

        {!isLoading && !isError && data && data.board === 'daily' && (
          <VStack align="stretch" spacing={SPACING.lg}>
            {data.days.length === 0 && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textSecondary}
              >
                No daily runs recorded yet.
              </Text>
            )}
            {data.days.map((d) => (
              <VStack key={d.day} align="stretch" spacing={SPACING.xs}>
                <HStack justify="space-between">
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    fontWeight={TYPOGRAPHY.medium}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    {formatDay(d.day)}
                  </Text>
                  {d.first && (
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize="11px"
                      color={SEMANTIC_COLORS.textSecondary}
                    >
                      First through: {d.first.displayName}
                    </Text>
                  )}
                </HStack>
                <EntryTable
                  entries={d.entries}
                  valueLabel="Time"
                  formatValue={formatTicks}
                  isMe={isMe}
                  emptyLabel="No on-chain runs recorded for this day."
                  showLegend={false}
                />
              </VStack>
            ))}
          </VStack>
        )}
      </VStack>
    </Card>
  )
}

export default Leaderboard
