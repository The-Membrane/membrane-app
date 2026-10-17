// /alerts/<feed token> — YOUR ALERTS PAGE. The opt-out and the editor that never
// depend on the panel an alert was set in: every RSS item links here. It lists this
// one link's alerts (the same data GET /api/alerts/feed/<token> returns — the token
// is the only key), each with Edit and Stop, and its recent events. RSS sits in the
// second layer ("More ways to get alerts"). Ink only; an error is red + ✖.
//
// EDIT (PATCH /api/alerts/feed/<token>?id=…): the same parsing and bounds as "Set
// alert". A changed number or direction replaces the alert with a fresh one (new id,
// not reached yet, the old one's events kept); an unchanged Save writes nothing. See
// lib/userAlerts/store.ts editThreshold and docs/USER_ALERTS.md.

import React, { useId, useState } from 'react'
import { Box, Button, Flex, Text, VStack } from '@chakra-ui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import NextLink from 'next/link'

import { SEMANTIC_COLORS, SHADOWS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { Card } from '@/components/ui/Card'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { FeedJson } from '@/lib/userAlerts/feed'
import { describeThreshold, MAX_ACTIVE_PER_OWNER, type Direction } from '@/lib/userAlerts/metrics'

import { ErrorLine, LABEL, LineControls, NOTE, PRIMARY, QUIET, RssDisclosure, SECONDARY } from './AlertFields'
import { controlTitle, LINK_WARNING, parseInput, relationLine } from './alertMeAtLogic'
import {
  CANCEL_CTA,
  cardState,
  type CardState,
  EDIT_CTA,
  EDIT_NOTE,
  editBody,
  editError,
  editOutcome,
  editPrefill,
  GONE_TEXT,
  SAVE_CTA,
  STOP_CTA,
  type EditOutcome,
  type EditResult,
} from './manageLogic'

const MONO = { fontFamily: TYPOGRAPHY.fontMono, fontSize: TYPOGRAPHY.xs, color: SEMANTIC_COLORS.textSecondary } as const

const RULE = { borderTop: '1px solid', borderColor: SEMANTIC_COLORS.borderSubtle } as const

/**
 * ALERT CARDS (owner 2026-10-17: "the borders blend into the page"): raised card stock
 * apart from the page, a strong hairline, the hard print shadow. The state is the
 * card's EDGE, read before the text: reached = a heavy ink top edge, unchecked = a
 * dashed hairline, watching = the plain card. Ink only (calm is ink; no green, which
 * means money; red stays for errors). Never a left-border card.
 */
const ALERT_CARD = {
  bg: SEMANTIC_COLORS.bgCardRaised,
  borderColor: SEMANTIC_COLORS.borderStrong,
  boxShadow: SHADOWS.raised,
  p: SPACING.base,
  w: '100%',
} as const

const CARD_EDGE: Record<CardState, Record<string, string>> = {
  reached: { borderTop: `4px solid ${SEMANTIC_COLORS.textPrimary}` },
  unchecked: { borderStyle: 'dashed' },
  watching: {},
}

const STATE_MARK: Record<CardState, string> = { reached: '●', unchecked: '◌', watching: '○' }

const utc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`

class FeedError extends Error {
  constructor(readonly status: number) {
    super(`feed ${status}`)
  }
}

const ERROR_TEXT = (status: number): string =>
  status === 404 ? 'This alert link is not valid.' : status === 429 ? 'Too many reads. Wait a minute.' : 'Alerts are down right now. Try later.'

type Threshold = FeedJson['thresholds'][number]
type Edit = (id: string, direction: Direction, input: string) => Promise<EditOutcome>

/** Edit in place: direction + number, one filled Save, a quiet Cancel. */
const EditForm: React.FC<{ t: Threshold; onEdit: Edit; onDone: (message: string | null) => void }> = ({ t, onEdit, onDone }) => {
  const uid = useId()
  const [direction, setDirection] = useState<Direction>(t.direction)
  const [input, setInput] = useState(() => editPrefill(t.threshold))
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [server, setServer] = useState<string | null>(null)

  const local = tried ? editError(t.metric, input) : null
  const error = local ?? (server ? { field: 'threshold' as const, message: server } : null)
  // The distance line reads the value this page just checked, only when it is fresh.
  const now = t.reading.status === 'ok' ? t.reading.value : null
  const relation = error ? null : relationLine(t.metric, direction, parseInput(input), now, t.reading.status === 'stale')
  const title = controlTitle(t.metric, t.subject)

  const save = async () => {
    setTried(true)
    setMessage(null)
    setServer(null)
    if (editError(t.metric, input)) return
    setBusy(true)
    let out: EditOutcome
    try {
      out = await onEdit(t.id, direction, input)
    } finally {
      setBusy(false)
    }
    if (out.phase === 'saved') onDone(null)
    else if (out.phase === 'gone') onDone(GONE_TEXT)
    else if (out.phase === 'invalid') setServer(out.message)
    else setMessage(out.message)
  }

  return (
    <Box mt={SPACING.sm}>
      <LineControls
        id={`${uid}-th`}
        metric={t.metric}
        label={title}
        direction={direction}
        onDirection={setDirection}
        value={input}
        onValue={(v) => {
          setInput(v)
          setServer(null)
        }}
        error={error}
      />
      {relation && (
        <Text {...NOTE} mt={SPACING.xs} sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {relation}
        </Text>
      )}
      <Flex mt={SPACING.base} direction={{ base: 'column', md: 'row' }} align={{ base: 'stretch', md: 'center' }} gap={SPACING.sm}>
        <Button {...PRIMARY} onClick={save} isLoading={busy} loadingText="Saving">
          {SAVE_CTA}
        </Button>
        <Button {...QUIET} alignSelf={{ base: 'flex-start', md: 'center' }} onClick={() => onDone(null)} isDisabled={busy}>
          {CANCEL_CTA}
        </Button>
      </Flex>
      <Text {...NOTE} mt={SPACING.xs}>
        {EDIT_NOTE}
      </Text>
      {message && <ErrorLine id={`${uid}-msg`}>{message}</ErrorLine>}
    </Box>
  )
}

const ThresholdRow: React.FC<{ t: Threshold; onStop: (id: string) => Promise<boolean>; onEdit: Edit }> = ({ t, onStop, onEdit }) => {
  const uid = useId()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const state = cardState(t)
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
    <Card
      id={`t-${t.id}`}
      variant="elevated"
      {...ALERT_CARD}
      {...CARD_EDGE[state]}
      data-state={state}
      sx={{ '&:target': { outline: `1px solid ${SEMANTIC_COLORS.textPrimary}`, outlineOffset: '2px' } }}
    >
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary} sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {editing ? controlTitle(t.metric, t.subject) : t.text}
      </Text>
      {!editing && (
        <>
          <Text {...MONO} mt={SPACING.xs} color={t.crossed ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}>
            <Text as="span" aria-hidden mr={SPACING.xs}>
              {STATE_MARK[state]}
            </Text>
            {t.crossed && t.crossedAt ? `reached · since ${utc(t.crossedAt)}` : state === 'unchecked' ? 'not checked this read' : 'not reached'}
            {t.reading.status !== 'unavailable' && t.reading.status !== 'stale' && t.reading.asOf ? ` · as of ${utc(t.reading.asOf)}` : ''}
          </Text>
          {t.note && (
            <Text {...MONO} mt={SPACING.xs}>
              {t.note}
            </Text>
          )}
          <Flex gap={SPACING.lg} mt={SPACING.xs} flexWrap="wrap">
            <Button
              {...QUIET}
              onClick={() => {
                setNote(null)
                setEditing(true)
              }}
            >
              {EDIT_CTA}
            </Button>
            <Button {...QUIET} onClick={stop} isLoading={busy} loadingText="Stopping">
              {STOP_CTA}
            </Button>
          </Flex>
        </>
      )}
      {editing && (
        <EditForm
          t={t}
          onEdit={onEdit}
          onDone={(m) => {
            setEditing(false)
            setNote(m)
          }}
        />
      )}
      {note && <ErrorLine id={`${uid}-note`}>{note}</ErrorLine>}
      {failed && <ErrorLine id={`${uid}-stop`}>Could not stop it. Try again.</ErrorLine>}
    </Card>
  )
}

/** The way on from an empty or invalid page: a 44px target, not a small text link. */
const RadarLink: React.FC = () => (
  <Button {...SECONDARY} as={NextLink} href="/ethereum/radar" mt={SPACING.sm}>
    Set an alert on Radar →
  </Button>
)

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <Card variant="subtle" {...ALERT_CARD} borderStyle="dashed" boxShadow="none">
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
      {text}
    </Text>
    <RadarLink />
  </Card>
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
      <Button {...SECONDARY} mt={SPACING.sm} onClick={onRetry}>
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

  const editOne: Edit = async (id, direction, input) => {
    let out: EditOutcome
    try {
      const r = await fetch(`/api/alerts/feed/${token}?id=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(editBody(direction, input)),
      })
      const body: EditResult | null = r.status >= 500 ? null : await r.json().catch(() => null)
      out = editOutcome(r.status, body)
    } catch {
      out = editOutcome(0, null)
    }
    if (out.phase === 'saved' && out.changed) {
      // The change is a NEW alert (new id, not reached yet): show it in the old one's place.
      const saved = out
      const threshold = parseInput(input)
      queryClient.setQueryData<FeedJson>(key, (d) =>
        d
          ? {
              ...d,
              thresholds: d.thresholds.map((t) =>
                t.id === id ? { ...t, id: saved.id, direction, threshold, text: describeThreshold({ ...t, direction, threshold }), crossed: false, crossedAt: null } : t,
              ),
            }
          : d,
      )
    }
    // Re-read after a change (the read checks the new number against now) or a 404
    // (this list was out of date).
    if ((out.phase === 'saved' && out.changed) || out.phase === 'gone') void q.refetch()
    return out
  }

  const rssUrl = `${siteUrl}/api/alerts/feed/${token}?format=rss`

  return (
    <Box maxW="820px" mx="auto" px={SPACING.base} py={SPACING.xl} color={SEMANTIC_COLORS.textPrimary} data-testid="manage-alerts">
      <Text {...LABEL}>your alerts · private link</Text>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} fontWeight={TYPOGRAPHY.bold} mt={SPACING.xs}>
        Your alerts
      </Text>
      <Text {...NOTE} mt={SPACING.xs}>
        Bookmark this page. {LINK_WARNING}
      </Text>

      {q.isLoading && (
        <Text {...MONO} mt={SPACING.lg}>
          Reading your alerts…
        </Text>
      )}
      {q.isError && <ErrorState status={q.error.status} onRetry={() => void q.refetch()} />}

      {q.data && (
        <>
          <Text {...LABEL} mt={SPACING.lg} mb={SPACING.sm} sx={{ fontVariantNumeric: 'tabular-nums' }}>
            active · {q.data.thresholds.length} of {MAX_ACTIVE_PER_OWNER}
          </Text>
          {q.data.thresholds.length === 0 ? (
            <Empty text="No active alerts on this page." />
          ) : (
            // The gap clears the 3px shadow and keeps each card its own object.
            <VStack spacing={SPACING.base} align="stretch" pr={SPACING.xs} pb={SPACING.xs}>
              {q.data.thresholds.map((t) => (
                <ThresholdRow key={t.id} t={t} onStop={stopOne} onEdit={editOne} />
              ))}
            </VStack>
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

          <Box mt={SPACING.lg} {...RULE} pt={SPACING.sm}>
            <RssDisclosure url={rssUrl} />
          </Box>

          {/* Only when the page was read: on an error nothing was checked. */}
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary} mt={SPACING.lg}>
            Data compiled by Membrane · checked each time you open this page
          </Text>
        </>
      )}
    </Box>
  )
}

export default ManageAlerts
