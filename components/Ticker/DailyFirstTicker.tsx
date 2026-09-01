// App-wide daily ticker — mounted directly under the top nav in components/Layout.tsx.
// GET /api/game/ticker (public, s-maxage=60). Two honors per UTC day, both from the
// daily race: 'first' (first wallet through the finish line) and 'fastest' (current
// fastest run of the day — can change intraday as faster runs land). Both kinds serve
// clean_name only (see lib/game/cleanName.ts) — the raw on-chain display name never
// reaches the client. Living Typeface: bgRaise strip, hairline top+bottom, mono
// uppercase, phosphor ★ separators, bone text. Continuous CSS marquee via duplicated
// content; respects prefers-reduced-motion (static row, no animation).

import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { useQuery } from '@tanstack/react-query'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'

type TickerItemKind = 'first' | 'fastest'

type TickerItem = {
  kind: TickerItemKind
  day: string // YYYY-MM-DD, UTC
  cleanName: string
  occurredAt: string
  /** ticks — present only for kind: 'fastest'. */
  value?: string
}

type TickerResponse = { items: TickerItem[] }

const POLL_INTERVAL_MS = 5 * 60 * 1000

async function fetchTicker(): Promise<TickerResponse> {
  const res = await fetch('/api/game/ticker')
  if (!res.ok) throw new Error(`ticker_fetch_failed_${res.status}`)
  return res.json()
}

// Parsed as UTC midnight so the day label never shifts a day off in a non-UTC
// browser timezone.
function formatDailyLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function tickerCopy(item: TickerItem): string {
  const label = formatDailyLabel(item.day)
  if (item.kind === 'fastest') {
    const ticks = Number(item.value)
    const ticksLabel = Number.isFinite(ticks)
      ? `${ticks.toLocaleString()} ticks`
      : `${item.value} ticks`
    return `${item.cleanName} — fastest ${label} daily · ${ticksLabel}`
  }
  return `${item.cleanName} — first through the ${label} daily`
}

const marquee = keyframes`
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
`

function TickerContent({ items }: { items: TickerItem[] }) {
  return (
    <HStack spacing={SPACING.xl} pr={SPACING.xl} as="span" display="inline-flex" flexShrink={0}>
      {items.map((item, i) => (
        <Text
          key={`${item.kind}-${item.day}-${i}`}
          as="span"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          textTransform="uppercase"
          letterSpacing="0.28em"
          color={SEMANTIC_COLORS.textPrimary}
          whiteSpace="nowrap"
        >
          <Text as="span" color={SEMANTIC_COLORS.primary} mr={SPACING.xs}>
            ★
          </Text>
          {tickerCopy(item)}
        </Text>
      ))}
    </HStack>
  )
}

export const DailyFirstTicker: React.FC = () => {
  const { data, isLoading } = useQuery<TickerResponse>({
    queryKey: ['game', 'ticker'],
    queryFn: fetchTicker,
    staleTime: POLL_INTERVAL_MS,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: false,
  })

  const items = data?.items ?? []
  if (isLoading || items.length === 0) return null

  return (
    <Box
      as="section"
      aria-label="Daily first-through ticker"
      overflow="hidden"
      bg={SEMANTIC_COLORS.bgTertiary}
      borderTop="1px solid"
      borderBottom="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      py={SPACING.sm}
    >
      <Box
        display="inline-flex"
        sx={{
          animation: `${marquee} 60s linear infinite`,
          '@media (prefers-reduced-motion: reduce)': {
            animation: 'none',
          },
        }}
      >
        <TickerContent items={items} />
        {/* Duplicate copy makes the -50% translate loop seamless. Hidden from
            assistive tech so the ticker isn't announced twice. */}
        <Box aria-hidden="true" display="inline-flex">
          <TickerContent items={items} />
        </Box>
      </Box>
    </Box>
  )
}

export default DailyFirstTicker
