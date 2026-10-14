// /alerts/<feed token> — YOUR ALERTS. The opt-out that never depends on the panel an
// alert was set in: every RSS item links here. It lists this one feed's thresholds
// (the same data GET /api/alerts/feed/<token> returns — the token is the only key)
// with a Stop button each, and its recent events. Ink only; an error is red + ✖.

import React, { useState } from 'react'
import { Box, Button, Flex, Text } from '@chakra-ui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NextLink from 'next/link'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { FeedJson } from '@/lib/userAlerts/feed'

import { LINK_WARNING } from './alertMeAtLogic'

const LABEL = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: SEMANTIC_COLORS.textSecondary,
} as const

const MONO = { fontFamily: TYPOGRAPHY.fontMono, fontSize: TYPOGRAPHY.xs, color: SEMANTIC_COLORS.textSecondary } as const

const ACTION = { variant: 'outline', w: 'auto', h: 'auto', minH: '44px', px: SPACING.base, whiteSpace: 'normal', flexShrink: 0 } as const

const RULE = { borderTop: '1px solid', borderColor: SEMANTIC_COLORS.borderSubtle } as const

const utc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`

class FeedError extends Error {
  constructor(readonly status: number) {
    super(`feed ${status}`)
  }
}

const ERROR_TEXT = (status: number): string =>
  status === 404 ? 'This alert link is not valid.' : status === 429 ? 'Too many reads. Wait a minute.' : 'Alerts are down right now. Try later.'

type Threshold = FeedJson['thresholds'][number]

const ThresholdRow: React.FC<{ t: Threshold; onStop: (id: string) => Promise<boolean> }> = ({ t, onStop }) => {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const stop = async () => {
    setBusy(true)
    setFailed(false)
    try {
      if (!(await onStop(t.id))) setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Box id={`t-${t.id}`} {...RULE} py={SPACING.md} sx={{ '&:target': { bg: SEMANTIC_COLORS.bgTertiary } }}>
      <Flex gap={SPACING.md} justify="space-between" align="center" flexWrap="wrap">
        <Box minW={0} flex="1 1 220px">
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
            {t.text}
          </Text>
          <Text {...MONO} mt={SPACING.xs} color={t.crossed ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}>
            {t.crossed && t.crossedAt ? `● reached · since ${utc(t.crossedAt)}` : 'not reached'}
            {t.reading.status !== 'unavailable' && t.reading.status !== 'stale' && t.reading.asOf ? ` · as of ${utc(t.reading.asOf)}` : ''}
          </Text>
          {t.note && (
            <Text {...MONO} mt={SPACING.xs}>
              {t.note}
            </Text>
          )}
        </Box>
        <Button {...ACTION} variant="ghost" onClick={stop} isLoading={busy} loadingText="Stopping">
          Stop
        </Button>
      </Flex>
      {failed && (
        <Text {...MONO} color={SEMANTIC_COLORS.danger} role="alert" mt={SPACING.xs}>
          ✖ Could not stop it. Try again.
        </Text>
      )}
    </Box>
  )
}

const FeedLink: React.FC<{ token: string; siteUrl: string }> = ({ token, siteUrl }) => {
  const [copied, setCopied] = useState(false)
  const url = `${siteUrl}/api/alerts/feed/${token}?format=rss`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked: the link stays on screen */
    }
  }
  return (
    <Box mt={SPACING.lg} {...RULE} pt={SPACING.md}>
      <Text {...LABEL}>your rss feed</Text>
      <Text {...MONO} color={SEMANTIC_COLORS.textPrimary} wordBreak="break-all" mt={SPACING.xs}>
        {url}
      </Text>
      <Text {...MONO} mt={SPACING.xs}>
        {LINK_WARNING}
      </Text>
      <Button {...ACTION} mt={SPACING.sm} onClick={copy}>
        {copied ? 'Copied' : 'Copy feed link'}
      </Button>
    </Box>
  )
}

/** The way on from an empty or invalid feed: a 44px target, not a small text link. */
const RadarLink: React.FC = () => (
  <Button {...ACTION} as={NextLink} href="/ethereum/radar" variant="ghost" mt={SPACING.sm} _focus={FOCUS_STYLES.ring}>
    Set an alert on Radar →
  </Button>
)

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <Box {...RULE} py={SPACING.md}>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
      {text}
    </Text>
    <RadarLink />
  </Box>
)

/** An error is never a dead end: an unknown link leads to Radar; anything else can retry. */
const ErrorState: React.FC<{ status: number; onRetry: () => void }> = ({ status, onRetry }) => (
  <Box mt={SPACING.lg}>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.danger} role="alert">
      ✖ {ERROR_TEXT(status)}
    </Text>
    {status === 404 ? (
      <RadarLink />
    ) : (
      <Button {...ACTION} variant="ghost" mt={SPACING.sm} onClick={onRetry}>
        Try again
      </Button>
    )}
  </Box>
)

export const ManageAlerts: React.FC<{ token: string; siteUrl: string }> = ({ token, siteUrl }) => {
  const queryClient = useQueryClient()
  const key = ['alerts_feed', token]
  const q = useQuery<FeedJson, FeedError>({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/alerts/feed/${token}`, { cache: 'no-store' })
      if (!r.ok) throw new FeedError(r.status)
      return r.json()
    },
    staleTime: 0,
    refetchOnMount: true,
    retry: false,
  })

  const stopOne = async (id: string): Promise<boolean> => {
    try {
      const r = await fetch(`/api/alerts/feed/${token}?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!r.ok) return false
      queryClient.setQueryData<FeedJson>(key, (d) => (d ? { ...d, thresholds: d.thresholds.filter((t) => t.id !== id) } : d))
      return true
    } catch {
      return false
    }
  }

  return (
    <Box maxW="820px" mx="auto" px={SPACING.base} py={SPACING.xl} color={SEMANTIC_COLORS.textPrimary} data-testid="manage-alerts">
      <Text {...LABEL}>your alerts · private link</Text>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} fontWeight={TYPOGRAPHY.bold} mt={SPACING.xs}>
        Your alerts
      </Text>

      {q.isLoading && (
        <Text {...MONO} mt={SPACING.lg}>
          Reading your alerts…
        </Text>
      )}
      {q.isError && <ErrorState status={q.error.status} onRetry={() => void q.refetch()} />}

      {q.data && (
        <>
          <Text {...LABEL} mt={SPACING.lg} mb={SPACING.xs}>
            active · {q.data.thresholds.length}
          </Text>
          {q.data.thresholds.length === 0 ? (
            <Empty text="No active alerts on this feed." />
          ) : (
            q.data.thresholds.map((t) => <ThresholdRow key={t.id} t={t} onStop={stopOne} />)
          )}

          {q.data.events.length > 0 && (
            <>
              <Text {...LABEL} mt={SPACING.lg} mb={SPACING.xs}>
                recent
              </Text>
              {q.data.events.map((e) => (
                <Box key={e.id} {...RULE} py={SPACING.sm}>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textPrimary}>
                    {utc(e.at)} · {e.text}
                  </Text>
                  <Text {...MONO}>
                    {e.source} · as of {utc(e.asOf)}
                  </Text>
                </Box>
              ))}
            </>
          )}

          <FeedLink token={token} siteUrl={siteUrl} />

          {/* Only when a feed was read: on an error nothing was checked. */}
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary} mt={SPACING.lg}>
            Data compiled by Membrane · checked each time this page or your feed is read
          </Text>
        </>
      )}
    </Box>
  )
}

export default ManageAlerts
