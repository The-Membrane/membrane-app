// "ALERT ME AT X" — the compact inline control that sets ONE alert on a live number
// (price, utilization or APR) and then says where the reader will get it.
//
// ONE MENTAL MODEL (owner, 2026-10-16): "set an alert → where you'll get it".
//  - The number is prefilled from the CURRENT live value passed in (no value, or a
//    stale one → no prefill).
//  - "Set alert" is the block's one filled action, full width on phones. Pressing it
//    IS the opt-in (the consent line sits beside it); nothing is stored before.
//  - After it: "Alert set.", then where it arrives — Telegram (only once the owner has
//    switched it on) and "Your alerts page" (/alerts/<token>, to bookmark). RSS is a
//    second layer, behind "More ways to get alerts". The first layer never says
//    "feed", "store" or "threshold".
//  - Hidden entirely while the alert store is unavailable (/api/alerts/status
//    storage:false) — never a disabled gate (DESIGN_RULES §7).
//  - Calm ink only: no green (money only), red + ✖ only for an error.
//
// Exported for the position page: <AlertMeAt metric subject currentValue ownerAddress />, plus
// optional prefillValue (a threshold other than the live value, e.g. halfway to a line) and
// defaultDirection (a rising-price risk alerts 'above'). The venue page passes `choices`
// to offer one control over several numbers of the same subject.

import React, { useId, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DEFAULT_DIRECTION, METRIC_LABEL, type Direction, type Metric } from '@/lib/userAlerts/metrics'

import { ErrorLine, FIELD, LABEL, LineControls, NOTE, PRIMARY, QUIET, RssDisclosure, SECONDARY, Segmented } from './AlertFields'
import {
  ALERTS_PAGE_CTA,
  ALERTS_PAGE_NOTE,
  alertLine,
  CHANGED_ELSEWHERE,
  CONSENT_TEXT,
  controlTitle,
  feedStorageKey,
  LINK_WARNING,
  manageHref,
  NEW_PAGE_CTA,
  outcomeView,
  parseInput,
  prefillText,
  relationLine,
  requestBody,
  SET_LINE,
  stampText,
  STOPPED_LINE,
  stopOutcome,
  submitOutcome,
  TELEGRAM_CTA,
  tokenFromFeedUrl,
  visibleErrors,
  WHERE_LABEL,
  type FieldError,
  type Outcome,
  type SubmitResult,
} from './alertMeAtLogic'
import { useAlertsStatus } from './useAlertsStatus'

/** One live number the control can alert on. */
export type AlertChoice = {
  metric: Metric
  /** The live value in the metric's unit (USD, or percent). Null → no prefill. */
  currentValue: number | null
  /** When currentValue was measured (ISO), for the stamp. */
  asOf?: string | null
  /** Older than its source's max age (lib/userAlerts/freshness.ts): no prefill, no distance line. */
  stale?: boolean
}

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
   * Then: no prefill, no distance-from-now line, and the stamp says alerts are not
   * checked until it updates — the evaluator skips a stale value, so the UI must not
   * promise a check.
   */
  stale?: boolean
  /**
   * Several numbers on the same subject (the venue page: utilization and supply APR).
   * With two or more, the control shows a switch between them and ONE "Set alert";
   * the entry for `metric` starts selected.
   */
  choices?: readonly AlertChoice[]
  /** The address on the page (pasted or connected). Absent → the control asks for one. */
  ownerAddress?: string | null
  /** False when the parent renders one shared address input for several controls. */
  askAddress?: boolean
  /** Start folded to one "Alert me at" button (for dense cards). */
  collapsible?: boolean
}

// A hairline rule and real air above the block; each group below is SPACING.base apart.
const SECTION = { mt: SPACING.md, pt: SPACING.base, borderTop: '1px solid', borderColor: SEMANTIC_COLORS.borderSubtle } as const
const GROUP = SPACING.base

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
    /* storage blocked: the next alert just starts a new alerts page */
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

/** Set one alert on this browser's alerts page for the address, or on a new page. */
async function storeAlert(a: Store): Promise<Outcome> {
  const token = readToken(a.address)
  let r = await post(requestBody({ ...a, feedToken: token }))
  if (r.status === 404 && token) {
    // This browser's page is gone (or is not this address's): start a fresh one.
    writeToken(a.address, null)
    r = await post(requestBody({ ...a, feedToken: null }))
  }
  const out = submitOutcome(r.status, r.json)
  if (out.phase === 'success') writeToken(a.address, tokenFromFeedUrl(out.feedUrl))
  return out
}

type Stored = { feedUrl: string; telegramLink: string | null; id: string | null; text: string }

async function stopAlert(s: Stored): Promise<ReturnType<typeof stopOutcome>> {
  const token = tokenFromFeedUrl(s.feedUrl)
  if (!s.id || !token) return 'failed'
  try {
    const r = await fetch(`/api/alerts/feed/${token}?id=${encodeURIComponent(s.id)}`, { method: 'DELETE' })
    return stopOutcome(r.status)
  } catch {
    return 'failed'
  }
}

// --- pieces -----------------------------------------------------------------

const AddressField: React.FC<{ id: string; value: string; onChange: (v: string) => void; error: FieldError | null }> = ({
  id,
  value,
  onChange,
  error,
}) => (
  <Box mt={GROUP}>
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

/** A full alerts page: go remove one there, or (rarely) start a second page. */
const CapActions: React.FC<{ manage: string | null; onNewPage: () => void }> = ({ manage, onNewPage }) => (
  <Flex direction="column" align="flex-start" gap={SPACING.xs} mt={SPACING.sm}>
    {manage && (
      <Button {...SECONDARY} as="a" href={manage}>
        {ALERTS_PAGE_CTA}
      </Button>
    )}
    <Button {...QUIET} onClick={onNewPage}>
      {NEW_PAGE_CTA}
    </Button>
  </Flex>
)

/** After "Set alert": what was set, where it arrives, and RSS behind a second layer. */
const StoredPanel: React.FC<{ stored: Stored; telegramOn: boolean; onReset: () => void }> = ({ stored, telegramOn, onReset }) => {
  const [stopped, setStopped] = useState(false)
  // The alert is no longer active under this panel's id: edited (new id) or stopped
  // on the alerts page. Never guess which alert replaced it: send the reader there.
  const [elsewhere, setElsewhere] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const uid = useId()
  const token = tokenFromFeedUrl(stored.feedUrl)
  const manage = token ? manageHref(token) : null

  const stop = async () => {
    setMessage(null)
    const out = await stopAlert(stored)
    if (out === 'stopped') setStopped(true)
    else if (out === 'elsewhere') setElsewhere(true)
    else setMessage('Could not stop it. Try again.')
  }

  return (
    <Box {...SECTION} data-testid="alert-me-at">
      <Box role="status">
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
          ● {stopped ? STOPPED_LINE : SET_LINE}
        </Text>
        <Text {...NOTE} mt={SPACING.xs} sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {stored.text}
        </Text>
      </Box>

      {!stopped && (
        <Box mt={GROUP}>
          <Text {...LABEL}>{WHERE_LABEL}</Text>
          <Flex direction="column" align={{ base: 'stretch', md: 'flex-start' }} gap={SPACING.sm} mt={SPACING.sm}>
            {telegramOn && stored.telegramLink && (
              <Button {...SECONDARY} as="a" href={stored.telegramLink} target="_blank" rel="noopener noreferrer">
                {TELEGRAM_CTA}
              </Button>
            )}
            {manage && (
              <Button {...SECONDARY} as="a" href={manage} target="_blank" rel="noopener noreferrer">
                {ALERTS_PAGE_CTA}
              </Button>
            )}
          </Flex>
          <Text {...NOTE} mt={SPACING.xs}>
            {ALERTS_PAGE_NOTE} {LINK_WARNING}
          </Text>
          <RssDisclosure url={stored.feedUrl} />
        </Box>
      )}

      <Flex gap={SPACING.lg} flexWrap="wrap" mt={SPACING.sm}>
        <Button {...QUIET} onClick={onReset}>
          Set another
        </Button>
        {!stopped && !elsewhere && stored.id && (
          <Button {...QUIET} onClick={stop}>
            Stop this alert
          </Button>
        )}
      </Flex>
      {elsewhere && (
        <Box role="status" mt={SPACING.xs}>
          <Text {...NOTE}>{CHANGED_ELSEWHERE}</Text>
          {manage && (
            <Button {...SECONDARY} as="a" href={manage} mt={SPACING.sm}>
              {ALERTS_PAGE_CTA}
            </Button>
          )}
        </Box>
      )}
      {message && <ErrorLine id={`${uid}-msg`}>{message}</ErrorLine>}
    </Box>
  )
}

// --- the control --------------------------------------------------------------

type FormProps = Omit<AlertMeAtProps, 'collapsible'> & { telegramOn: boolean }

const AlertForm: React.FC<FormProps> = ({
  metric: initialMetric,
  subject,
  currentValue,
  prefillValue,
  defaultDirection,
  asOf,
  stale = false,
  choices,
  ownerAddress,
  askAddress = true,
  telegramOn,
}) => {
  const uid = useId()
  const options = choices && choices.length > 1 ? choices : null
  const [picked, setPicked] = useState<Metric>(initialMetric)
  // The props' own number unless the reader switched to another choice.
  const own = picked === initialMetric
  const active: AlertChoice = (!own && options?.find((c) => c.metric === picked)) || { metric: initialMetric, currentValue, asOf, stale }
  const metric = active.metric
  const isStale = active.stale ?? false

  // null = untouched: the input shows the live prefill, and follows it if it arrives late.
  const [typed, setTyped] = useState<string | null>(null)
  const [direction, setDirection] = useState<Direction>(defaultDirection ?? DEFAULT_DIRECTION[initialMetric])
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
  const prefillFrom = own && prefillValue !== undefined ? prefillValue : active.currentValue
  const input = typed ?? prefillText(metric, prefillFrom, isStale)
  const draft = { input, direction, address }
  const errors = visibleErrors(metric, draft, needsAddress, tried, serverError)
  const relation = errors.threshold ? null : relationLine(metric, direction, parseInput(input), active.currentValue, isStale)
  const stamp = stampText(active.asOf, active.currentValue !== null, isStale)
  const ids = { threshold: `${uid}-th`, address: `${uid}-addr`, msg: `${uid}-msg` }

  const clearOutcome = () => {
    setTried(false)
    setMessage(null)
    setServerError(null)
    setCapped(false)
  }
  const reset = () => {
    setStored(null)
    setTyped(null)
    clearOutcome()
  }
  const pick = (m: Metric) => {
    if (m === picked) return
    setPicked(m)
    setTyped(null)
    setDirection(m === initialMetric && defaultDirection ? defaultDirection : DEFAULT_DIRECTION[m])
    clearOutcome()
  }

  const submit = async () => {
    setTried(true)
    setServerError(null)
    setMessage(null)
    setCapped(false)
    const shown = visibleErrors(metric, draft, needsAddress, true, null)
    if (shown.threshold || shown.address) return
    const threshold = parseInput(input)
    setBusy(true)
    let out: Outcome
    try {
      out = await storeAlert({ metric, subject, direction, threshold, address })
    } finally {
      setBusy(false)
    }
    const view = outcomeView(out, ownAddressInput)
    if (view.kind === 'stored') setStored({ ...view, text: alertLine(metric, subject, direction, threshold) })
    else if (view.kind === 'field') setServerError(view.error)
    else {
      setMessage(view.message)
      setCapped(view.kind === 'cap')
    }
  }

  // The full page is this browser's stored one: forget it, and the retry mints a new page.
  const startNewPage = () => {
    writeToken(address, null)
    void submit()
  }
  const fullToken = capped ? readToken(address) : null

  if (stored) return <StoredPanel stored={stored} telegramOn={telegramOn} onReset={reset} />

  return (
    <Box {...SECTION} data-testid="alert-me-at">
      <Text {...LABEL}>Alert me at · {title}</Text>

      {ownAddressInput && <AddressField id={ids.address} value={addressInput} onChange={setAddressInput} error={errors.address} />}

      {/* the number: which one (venue page), direction, value, distance, as-of */}
      <Box mt={GROUP}>
        {options && (
          <Box mb={SPACING.sm}>
            <Segmented
              label="Which number"
              options={options.map((c) => c.metric)}
              value={metric}
              onChange={pick}
              text={(m) => METRIC_LABEL[m]}
            />
          </Box>
        )}
        <LineControls
          id={ids.threshold}
          metric={metric}
          label={title}
          direction={direction}
          onDirection={setDirection}
          value={input}
          onValue={(v) => {
            setTyped(v)
            setServerError(null)
          }}
          error={errors.threshold}
        />
        {errors.address && !ownAddressInput && <ErrorLine id={`${ids.address}-e`}>Enter your 0x address above.</ErrorLine>}
        {relation && (
          <Text {...NOTE} mt={SPACING.xs} sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {relation}
          </Text>
        )}
        {stamp && (
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary} mt={SPACING.xs}>
            {stamp}
          </Text>
        )}
      </Box>

      {/* the one action, and what pressing it means */}
      <Flex mt={GROUP} direction={{ base: 'column', md: 'row' }} align={{ base: 'stretch', md: 'center' }} gap={SPACING.sm}>
        <Button {...PRIMARY} onClick={submit} isLoading={busy} loadingText="Setting">
          Set alert
        </Button>
        <Text {...NOTE}>{CONSENT_TEXT}</Text>
      </Flex>
      {message && <ErrorLine id={ids.msg}>{message}</ErrorLine>}
      {capped && <CapActions manage={fullToken ? manageHref(fullToken) : null} onNewPage={startNewPage} />}
    </Box>
  )
}

export const AlertMeAt: React.FC<AlertMeAtProps> = ({ collapsible = false, ...props }) => {
  const status = useAlertsStatus()
  const [open, setOpen] = useState(!collapsible)
  if (!status.data?.storage) return null
  if (!open) {
    return (
      <Button {...SECONDARY} mt={SPACING.md} onClick={() => setOpen(true)} aria-expanded={false}>
        Alert me at · {controlTitle(props.metric, props.subject)}
      </Button>
    )
  }
  return <AlertForm {...props} telegramOn={status.data.telegram} />
}

export default AlertMeAt
