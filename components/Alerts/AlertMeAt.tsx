// "ALERT ME AT X" — the compact inline control that stores ONE opt-in threshold
// (price, utilization or APR) and hands back the owner's private RSS feed link.
//
//  - The metric and subject are fixed by where it is mounted; the threshold input is
//    prefilled from the CURRENT live value passed in (no value → no prefill).
//  - Nothing is stored without the explicit opt-in tick.
//  - Hidden entirely while the alert store is unavailable (/api/alerts/status
//    storage:false) — never a disabled gate (DESIGN_RULES §7).
//  - Telegram shows only when the status says the owner has switched it on.
//  - Calm ink only: no green (money only), red + ✖ only for an error.
//
// Exported for the position page: <AlertMeAt metric subject currentValue ownerAddress />, plus
// optional prefillValue (a threshold other than the live value, e.g. halfway to a line) and
// defaultDirection (a rising-price risk alerts 'above').

import React, { useId, useState } from 'react'
import { Box, Button, Checkbox, Flex, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DEFAULT_DIRECTION, DIRECTIONS, type Direction, type Metric } from '@/lib/userAlerts/metrics'

import {
  controlTitle,
  feedStorageKey,
  LINK_WARNING,
  manageHref,
  OPT_IN_TEXT,
  outcomeView,
  parseInput,
  prefillText,
  relationLine,
  requestBody,
  stampText,
  submitOutcome,
  successLine,
  tokenFromFeedUrl,
  visibleErrors,
  type FieldError,
  type Outcome,
  type SubmitResult,
} from './alertMeAtLogic'
import { useAlertsStatus } from './useAlertsStatus'

export interface AlertMeAtProps {
  metric: Metric
  /** 'asset:ETH' | 'venue:<recorder venue key>' */
  subject: string
  /** The live value in the metric's unit (USD, or percent). Null → no prefill. */
  currentValue: number | null
  /** Prefill the threshold with this instead of the live value. Absent → the live value. */
  prefillValue?: number | null
  /** The direction the toggle starts on. Absent → DEFAULT_DIRECTION[metric]. */
  defaultDirection?: Direction
  /** When currentValue was measured (ISO), for the stamp. */
  asOf?: string | null
  /**
   * The live value is older than its source's max age (lib/userAlerts/freshness.ts).
   * Then: no prefill, no distance-from-now line, and "Not checked until the value is
   * fresh." — the evaluator skips a stale value, so the UI must not promise a check.
   */
  stale?: boolean
  /** The address on the page (pasted or connected). Absent → the control asks for one. */
  ownerAddress?: string | null
  /** False when the parent renders one shared address input for several controls. */
  askAddress?: boolean
  /** Start folded to one "Alert me at" button (for dense cards). */
  collapsible?: boolean
}

const LABEL = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: SEMANTIC_COLORS.textSecondary,
} as const

const NOTE = { fontFamily: TYPOGRAPHY.fontMono, fontSize: TYPOGRAPHY.label, color: SEMANTIC_COLORS.textSecondary } as const

const FIELD = {
  h: '44px',
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.small,
  color: SEMANTIC_COLORS.textPrimary,
  bg: SEMANTIC_COLORS.bgSecondary,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderMedium,
  borderRadius: 0,
  px: SPACING.md,
  _focus: FOCUS_STYLES.ring,
  _focusVisible: FOCUS_STYLES.ring,
  _invalid: { borderColor: SEMANTIC_COLORS.danger },
  spellCheck: false,
  autoComplete: 'off',
} as const

// 44px touch target; labels wrap instead of overflowing a 390px card.
const ACTION = {
  variant: 'outline',
  w: 'auto',
  h: 'auto',
  minH: '44px',
  maxW: '100%',
  px: SPACING.base,
  whiteSpace: 'normal',
  flexShrink: 0,
} as const

const SECTION = { mt: SPACING.md, pt: SPACING.md, borderTop: '1px solid', borderColor: SEMANTIC_COLORS.borderSubtle } as const

// --- I/O (no React) ---------------------------------------------------------

const readToken = (address: string): string | null => {
  try {
    return window.localStorage.getItem(feedStorageKey(address))
  } catch {
    return null
  }
}
const writeToken = (address: string, token: string | null) => {
  try {
    if (token) window.localStorage.setItem(feedStorageKey(address), token)
    else window.localStorage.removeItem(feedStorageKey(address))
  } catch {
    /* storage blocked: the next alert just starts a new feed */
  }
}

const post = async (body: unknown): Promise<{ status: number; json: SubmitResult | null }> => {
  try {
    const r = await fetch('/api/alerts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    // A 5xx body is not ours to read; 2xx/4xx carry the answer submitOutcome maps.
    if (r.status >= 500) return { status: r.status, json: null }
    return { status: r.status, json: await r.json().catch(() => null) }
  } catch {
    return { status: 0, json: null }
  }
}

type Store = { metric: Metric; subject: string; direction: Direction; threshold: number; address: string }

/** Store one threshold on this browser's feed for the address, or on a new feed. */
async function storeAlert(a: Store): Promise<Outcome> {
  const token = readToken(a.address)
  let r = await post(requestBody({ ...a, feedToken: token }))
  if (r.status === 404 && token) {
    // This browser's feed is gone (or is not this address's): start a fresh one.
    writeToken(a.address, null)
    r = await post(requestBody({ ...a, feedToken: null }))
  }
  const out = submitOutcome(r.status, r.json)
  if (out.phase === 'success') writeToken(a.address, tokenFromFeedUrl(out.feedUrl))
  return out
}

type Stored = { feedUrl: string; telegramLink: string | null; id: string | null; text: string }

async function stopAlert(s: Stored): Promise<boolean> {
  const token = tokenFromFeedUrl(s.feedUrl)
  if (!s.id || !token) return false
  try {
    const r = await fetch(`/api/alerts/feed/${token}?id=${encodeURIComponent(s.id)}`, { method: 'DELETE' })
    return r.ok
  } catch {
    return false
  }
}

// --- pieces -----------------------------------------------------------------

const ErrorLine: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => (
  <Text id={id} {...NOTE} color={SEMANTIC_COLORS.danger} role="alert">
    ✖ {children}
  </Text>
)

const DirectionToggle: React.FC<{ value: Direction; onChange: (d: Direction) => void }> = ({ value, onChange }) => (
  <Flex role="group" aria-label="Direction" flexShrink={0}>
    {DIRECTIONS.map((d) => {
      const on = value === d
      return (
        <Button
          key={d}
          {...ACTION}
          variant="ghost"
          px={SPACING.md}
          onClick={() => onChange(d)}
          aria-pressed={on}
          color={on ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textTertiary}
          borderColor={on ? SEMANTIC_COLORS.borderStrong : SEMANTIC_COLORS.borderSubtle}
          bg={on ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
          ml={d === 'below' ? '-1px' : 0}
        >
          {d}
        </Button>
      )
    })}
  </Flex>
)

const OptInBox: React.FC<{ checked: boolean; onChange: (v: boolean) => void; error: FieldError | null; errorId: string }> = ({
  checked,
  onChange,
  error,
  errorId,
}) => (
  <>
    <Checkbox
      mt={SPACING.sm}
      minH="44px"
      isChecked={checked}
      onChange={(e) => onChange(e.target.checked)}
      isInvalid={!!error}
      aria-describedby={error ? errorId : undefined}
      sx={{
        '.chakra-checkbox__control': { borderRadius: 0, borderColor: SEMANTIC_COLORS.borderStrong, transition: TRANSITIONS.colors },
        '.chakra-checkbox__control[data-checked]': {
          bg: SEMANTIC_COLORS.textPrimary,
          borderColor: SEMANTIC_COLORS.textPrimary,
          color: SEMANTIC_COLORS.bgPrimary,
        },
        '.chakra-checkbox__control[data-invalid]': { borderColor: SEMANTIC_COLORS.danger },
        '.chakra-checkbox__control[data-focus-visible]': FOCUS_STYLES.ring,
      }}
    >
      <Text as="span" {...NOTE} color={SEMANTIC_COLORS.textPrimary}>
        {OPT_IN_TEXT}
      </Text>
    </Checkbox>
    {error && <ErrorLine id={errorId}>{error.message}</ErrorLine>}
  </>
)

const AddressField: React.FC<{ id: string; value: string; onChange: (v: string) => void; error: FieldError | null }> = ({
  id,
  value,
  onChange,
  error,
}) => (
  <Box mt={SPACING.sm}>
    <Text as="label" htmlFor={id} {...LABEL} display="block" mb={SPACING.xs}>
      your address
    </Text>
    <Input
      id={id}
      {...FIELD}
      textAlign="left"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="0x…"
      isInvalid={!!error}
      aria-invalid={!!error}
      aria-describedby={error ? `${id}-e` : undefined}
    />
    {error && <ErrorLine id={`${id}-e`}>{error.message}</ErrorLine>}
  </Box>
)

/** The threshold input with its unit; mono, tabular, right-aligned. */
const ThresholdField: React.FC<{
  id: string
  metric: Metric
  label: string
  value: string
  onChange: (v: string) => void
  error: FieldError | null
}> = ({ id, metric, label, value, onChange, error }) => (
  <Flex flex="1 1 140px" minW={0} align="center" gap={SPACING.xs}>
    {metric === 'price' && (
      <Text {...NOTE} aria-hidden>
        $
      </Text>
    )}
    <Input
      id={id}
      {...FIELD}
      textAlign="right"
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={metric === 'price' ? 'price' : '%'}
      aria-label={`${label} threshold`}
      isInvalid={!!error}
      aria-invalid={!!error}
      aria-describedby={error ? `${id}-e` : undefined}
      sx={{ fontVariantNumeric: 'tabular-nums' }}
    />
    {metric !== 'price' && (
      <Text {...NOTE} aria-hidden>
        %
      </Text>
    )}
  </Flex>
)

const ValueStamp: React.FC<{ text: string }> = ({ text }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary} mt={SPACING.xs}>
    {text}
  </Text>
)

/** A full feed: manage it (stop some) or start a new feed for this address. */
const CapActions: React.FC<{ manage: string | null; onNewFeed: () => void }> = ({ manage, onNewFeed }) => (
  <Flex gap={SPACING.sm} flexWrap="wrap" mt={SPACING.xs}>
    {manage && (
      <Button {...ACTION} variant="ghost" as="a" href={manage}>
        Manage alerts
      </Button>
    )}
    <Button {...ACTION} variant="ghost" onClick={onNewFeed}>
      Start a new feed
    </Button>
  </Flex>
)

/** After a store: the feed link, copy, Telegram (only when on), stop, set another. */
const StoredPanel: React.FC<{ stored: Stored; telegramOn: boolean; onReset: () => void }> = ({ stored, telegramOn, onReset }) => {
  const [stopped, setStopped] = useState(false)
  const [copied, setCopied] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const uid = useId()
  const token = tokenFromFeedUrl(stored.feedUrl)
  const manage = token ? manageHref(token) : null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stored.feedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked: the link stays on screen */
    }
  }
  const stop = async () => {
    setMessage(null)
    if (await stopAlert(stored)) setStopped(true)
    else setMessage('Could not stop it. Try again.')
  }

  return (
    <Box {...SECTION} data-testid="alert-me-at">
      <Text {...NOTE} color={SEMANTIC_COLORS.textPrimary} role="status">
        ● {stopped ? stored.text.replace(/^Stored:/, 'Stopped:') : stored.text}
      </Text>
      {!stopped && (
        <>
          <Text {...LABEL} mt={SPACING.sm}>
            your rss feed
          </Text>
          <Text
            as="a"
            href={stored.feedUrl}
            target="_blank"
            rel="noopener noreferrer"
            display="block"
            {...NOTE}
            color={SEMANTIC_COLORS.textPrimary}
            textDecoration="underline"
            wordBreak="break-all"
            mt={SPACING.xs}
            _focus={FOCUS_STYLES.ring}
          >
            {stored.feedUrl}
          </Text>
          <Text {...NOTE} mt={SPACING.xs}>
            {LINK_WARNING}
          </Text>
        </>
      )}
      <Flex gap={SPACING.sm} flexWrap="wrap" mt={SPACING.sm}>
        {!stopped && (
          <Button {...ACTION} onClick={copy}>
            {copied ? 'Copied' : 'Copy feed link'}
          </Button>
        )}
        {!stopped && telegramOn && stored.telegramLink && (
          <Button {...ACTION} as="a" href={stored.telegramLink} target="_blank" rel="noopener noreferrer">
            Telegram
          </Button>
        )}
        {!stopped && stored.id && (
          <Button {...ACTION} variant="ghost" onClick={stop}>
            Stop this alert
          </Button>
        )}
        {manage && (
          <Button {...ACTION} variant="ghost" as="a" href={manage}>
            Manage alerts
          </Button>
        )}
        <Button {...ACTION} variant="ghost" onClick={onReset}>
          Set another
        </Button>
      </Flex>
      {message && <ErrorLine id={`${uid}-msg`}>{message}</ErrorLine>}
    </Box>
  )
}

// --- the control --------------------------------------------------------------

type FormProps = Omit<AlertMeAtProps, 'collapsible'> & { telegramOn: boolean }

const AlertForm: React.FC<FormProps> = ({
  metric,
  subject,
  currentValue,
  prefillValue,
  defaultDirection,
  asOf,
  stale = false,
  ownerAddress,
  askAddress = true,
  telegramOn,
}) => {
  const uid = useId()
  // null = untouched: the input shows the live prefill, and follows it if it arrives late.
  const [typed, setTyped] = useState<string | null>(null)
  const [direction, setDirection] = useState<Direction>(defaultDirection ?? DEFAULT_DIRECTION[metric])
  const [optIn, setOptIn] = useState(false)
  const [addressInput, setAddressInput] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [serverError, setServerError] = useState<FieldError | null>(null)
  const [stored, setStored] = useState<Stored | null>(null)
  const [capped, setCapped] = useState(false)

  const title = controlTitle(metric, subject)
  const needsAddress = !ownerAddress
  const ownAddressInput = needsAddress && askAddress
  const address = ownerAddress ?? addressInput
  // A stale live value still blocks the prefill, whichever value would fill it.
  const input = typed ?? prefillText(metric, prefillValue !== undefined ? prefillValue : currentValue, stale)
  const draft = { input, direction, optIn, address }
  const errors = visibleErrors(metric, draft, needsAddress, tried, serverError)
  const relation = errors.threshold ? null : relationLine(metric, direction, parseInput(input), currentValue, stale)
  const ids = { threshold: `${uid}-th`, address: `${uid}-addr`, optIn: `${uid}-opt`, msg: `${uid}-msg` }

  const reset = () => {
    setStored(null)
    setTried(false)
    setOptIn(false)
    setTyped(null)
    setMessage(null)
    setServerError(null)
    setCapped(false)
  }

  const submit = async () => {
    setTried(true)
    setServerError(null)
    setMessage(null)
    setCapped(false)
    const shown = visibleErrors(metric, draft, needsAddress, true, null)
    if (shown.threshold || shown.address || shown.optIn) return
    const threshold = parseInput(input)
    setBusy(true)
    let out: Outcome
    try {
      out = await storeAlert({ metric, subject, direction, threshold, address })
    } finally {
      setBusy(false)
    }
    const view = outcomeView(out, ownAddressInput)
    if (view.kind === 'stored') setStored({ ...view, text: successLine(metric, subject, direction, threshold) })
    else if (view.kind === 'field') setServerError(view.error)
    else {
      setMessage(view.message)
      setCapped(view.kind === 'cap')
    }
  }

  // The full feed is this browser's stored one: forget it, and the retry mints a new feed.
  const startNewFeed = () => {
    writeToken(address, null)
    void submit()
  }
  const fullToken = capped ? readToken(address) : null

  if (stored) return <StoredPanel stored={stored} telegramOn={telegramOn} onReset={reset} />

  return (
    <Box {...SECTION} data-testid="alert-me-at">
      <Text {...LABEL}>Alert me at · {title}</Text>

      {ownAddressInput && <AddressField id={ids.address} value={addressInput} onChange={setAddressInput} error={errors.address} />}

      <Flex gap={SPACING.sm} flexWrap="wrap" mt={SPACING.sm} align="stretch">
        <DirectionToggle value={direction} onChange={setDirection} />
        <ThresholdField
          id={ids.threshold}
          metric={metric}
          label={title}
          value={input}
          onChange={(v) => {
            setTyped(v)
            setServerError(null)
          }}
          error={errors.threshold}
        />
        <Button {...ACTION} onClick={submit} isLoading={busy} loadingText="Storing">
          Set alert
        </Button>
      </Flex>
      {errors.threshold && <ErrorLine id={`${ids.threshold}-e`}>{errors.threshold.message}</ErrorLine>}
      {errors.address && !ownAddressInput && <ErrorLine id={`${ids.address}-e`}>Enter your 0x address above.</ErrorLine>}
      {relation && (
        <Text {...NOTE} mt={SPACING.xs} sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {relation}
        </Text>
      )}

      <OptInBox checked={optIn} onChange={setOptIn} error={errors.optIn} errorId={ids.optIn} />
      {message && <ErrorLine id={ids.msg}>{message}</ErrorLine>}
      {capped && <CapActions manage={fullToken ? manageHref(fullToken) : null} onNewFeed={startNewFeed} />}

      <ValueStamp text={stampText(asOf, currentValue !== null, stale)} />
    </Box>
  )
}

export const AlertMeAt: React.FC<AlertMeAtProps> = ({ collapsible = false, ...props }) => {
  const status = useAlertsStatus()
  const [open, setOpen] = useState(!collapsible)
  if (!status.data?.storage) return null
  if (!open) {
    return (
      <Button {...ACTION} variant="ghost" mt={SPACING.md} onClick={() => setOpen(true)} aria-expanded={false}>
        Alert me at · {controlTitle(props.metric, props.subject)}
      </Button>
    )
  }
  return <AlertForm {...props} telegramOn={status.data.telegram} />
}

export default AlertMeAt
