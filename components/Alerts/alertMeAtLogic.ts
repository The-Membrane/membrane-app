// Pure view-model for the "Alert me at X" control (AlertMeAt.tsx) and the edit form
// on the alerts page (ManageAlerts.tsx). JSX-free and I/O-free so tests/unit
// exercises exactly what they render: the prefill, the validation messages, the
// distance-from-now line, the copy, and how each API answer maps to a state. Bounds
// come from lib/userAlerts/metrics.ts — the same constants the API validates with.
//
// ONE MENTAL MODEL (owner, 2026-10-16): "set an alert → where you'll get it". The
// first layer never says "feed", "store" or "threshold"; RSS is a second layer.

import { isPast } from '@/lib/userAlerts/evaluate'
import {
  ADDRESS_RE,
  checkThreshold,
  describeThreshold,
  formatValue,
  MAX_ACTIVE_PER_OWNER,
  METRIC_DP,
  METRIC_LABEL,
  subjectLabel,
  type Direction,
  type Metric,
} from '@/lib/userAlerts/metrics'

// --- copy (owner-approved shapes; tests pin every string) -------------------------

/** Beside "Set alert". Pressing it IS the opt-in: nothing is stored before the press. */
export const CONSENT_TEXT = 'We keep this number so we can alert you. Only you get the link.'
export const SET_LINE = 'Alert set.'
export const STOPPED_LINE = 'Alert stopped.'
export const WHERE_LABEL = "where you'll get it"
export const TELEGRAM_CTA = 'Get it in Telegram'
export const ALERTS_PAGE_CTA = 'Your alerts page'
export const ALERTS_PAGE_NOTE = 'Bookmark it. It shows when your number is reached.'
export const LINK_WARNING = 'Anyone with this link can read these alerts.'
/** The second layer: RSS, for people who already use a feed reader. */
export const MORE_WAYS = 'More ways to get alerts'
export const RSS_NOTE = 'For a feed reader. Keep it private, like your alerts page.'
export const NEW_PAGE_CTA = 'Start a second alerts page'

export type Draft = { input: string; direction: Direction; address: string }

export type FieldError = { field: 'threshold' | 'address'; message: string }

/** "Aave v3 USDe utilization" — the control's fixed subject, in words. */
export const controlTitle = (metric: Metric, subject: string): string => `${subjectLabel(subject)} ${METRIC_LABEL[metric]}`

/**
 * The input's prefill: the CURRENT live value at the metric's display precision, or
 * '' when there is no live value — or when it is stale (the evaluator would skip it,
 * so offering it as "now" would mislead). Never a made-up default.
 */
export const prefillText = (metric: Metric, current: number | null | undefined, stale = false): string =>
  stale || current === null || current === undefined || !Number.isFinite(current) ? '' : current.toFixed(METRIC_DP[metric])

/** A stale live value: no prefill, no distance line, and this (the evaluator skips it). */
export const STALE_LINE = 'The live number is out of date. Alerts are not checked until it updates.'
export const NO_VALUE_LINE = 'No live number right now.'

/** The small line under the number: its as-of, that it is stale, or that there is none. */
export const stampText = (asOf: string | null | undefined, hasValue: boolean, stale: boolean): string => {
  if (stale) return STALE_LINE
  if (!hasValue) return NO_VALUE_LINE
  return asOf ? `Live number as of ${asOf.slice(0, 16).replace('T', ' ')} UTC.` : ''
}

export type Parsed = { ok: true; value: number } | { ok: false; message: string }

/** Thousands separators: 1,234 · 12,345,678.9 (groups of exactly three). */
const THOUSANDS = /^\d{1,3}(,\d{3})+(\.\d+)?$/
/** One comma, no dot: the comma is the decimal mark (4,5 · 87,5). */
const DECIMAL_COMMA = /^\d+,\d+$/
const PLAIN = /^-?(\d+(\.\d*)?|\.\d+)$/

/**
 * Typed text → number, never guessing a 10× wrong value. "$", "%" and spaces are
 * dropped. A comma is read as a thousands separator ONLY in strict groups of three
 * (1,234.5); a single comma with no dot is the decimal mark (4,5 → 4.5); any other
 * comma (1,23,4 · 4,5.6) is refused with a message rather than read either way.
 */
export const parseNumber = (text: string): Parsed => {
  const s = text.replace(/[$%\s]/g, '')
  if (s === '') return { ok: false, message: 'Enter a number.' }
  let norm = s
  if (s.includes(',')) {
    if (THOUSANDS.test(s)) norm = s.replace(/,/g, '')
    else if (DECIMAL_COMMA.test(s)) norm = s.replace(',', '.')
    else return { ok: false, message: 'Use a dot for decimals, like 4.5.' }
  }
  if (!PLAIN.test(norm)) return { ok: false, message: 'Enter a plain number, like 4.5.' }
  return { ok: true, value: Number(norm) }
}

/** parseNumber, as a number (NaN when it does not parse). */
export const parseInput = (text: string): number => {
  const p = parseNumber(text)
  return p.ok ? p.value : NaN
}

/**
 * The typed number, parsed and bounded — the ONE rule for setting an alert AND for
 * editing one on the alerts page (decimal comma, bounds). Null when it is fine.
 */
export const thresholdError = (metric: Metric, input: string): FieldError | null => {
  const p = parseNumber(input)
  if (!p.ok) return { field: 'threshold', message: p.message }
  const c = checkThreshold(metric, p.value)
  return c.ok ? null : { field: 'threshold', message: c.message }
}

/** Every problem with the draft, in display order (threshold, address). */
export const draftErrors = (metric: Metric, draft: Draft, needsAddress: boolean): FieldError[] => {
  const out: FieldError[] = []
  const th = thresholdError(metric, draft.input)
  if (th) out.push(th)
  if (needsAddress && !ADDRESS_RE.test(draft.address.trim())) out.push({ field: 'address', message: 'Enter a 0x address.' })
  return out
}

/**
 * The errors to SHOW: the draft's own (only after a submit attempt) and, failing
 * that, the field the server named. One per field.
 */
export const visibleErrors = (
  metric: Metric,
  draft: Draft,
  needsAddress: boolean,
  tried: boolean,
  server: FieldError | null,
): Record<FieldError['field'], FieldError | null> => {
  const local = tried ? draftErrors(metric, draft, needsAddress) : []
  const pick = (f: FieldError['field']) => local.find((e) => e.field === f) ?? (server?.field === f ? server : null)
  return { threshold: pick('threshold'), address: pick('address') }
}

/**
 * The distance-from-now line under the input. Whole units, measured from now,
 * floored (rounded toward risk — DESIGN_RULES §4). Null when there is no live value
 * or no valid threshold yet.
 */
export const relationLine = (
  metric: Metric,
  direction: Direction,
  threshold: number,
  current: number | null | undefined,
  stale = false,
): string | null => {
  // A stale value is not "now": no distance, no "fires on the first check".
  if (stale || current === null || current === undefined || !Number.isFinite(current) || !Number.isFinite(threshold)) return null
  const now = formatValue(metric, current)
  if (isPast(direction, current, threshold)) return `Now ${now}: already at or ${direction} it. Fires on the first check.`
  const gap =
    metric === 'price'
      ? current > 0
        ? Math.floor((Math.abs(threshold - current) / current) * 100)
        : null
      : Math.floor(Math.abs(threshold - current))
  const unit = metric === 'price' ? '%' : ' pp'
  const dist = gap === null ? '' : gap >= 1 ? `${gap}${unit} ` : `under 1${unit} `
  return `Fires ${dist}${direction} now (${now}).`
}

/** A full alerts page, in plain words. `max` is the API's cap (MAX_ACTIVE_PER_OWNER). */
export const capText = (max: number): string =>
  `You have ${max} alerts, the most one link holds. Remove one on your alerts page to add another.`

export type SubmitResult = {
  id?: string
  feedUrl?: string
  telegramLink?: string
  error?: string
  message?: string
  field?: string
  max?: number
}

export type Outcome =
  | { phase: 'success'; feedUrl: string; telegramLink: string | null; id: string | null }
  | { phase: 'cap'; message: string }
  | { phase: 'invalid'; field: FieldError['field'] | null; message: string }
  | { phase: 'unknownFeed' }
  | { phase: 'error'; message: string }

/** One API answer → the control's next state. */
export const submitOutcome = (status: number, body: SubmitResult | null): Outcome => {
  if (status === 200 && body?.feedUrl) {
    return { phase: 'success', feedUrl: body.feedUrl, telegramLink: body.telegramLink ?? null, id: body.id ?? null }
  }
  if (status === 409) return { phase: 'cap', message: capText(body?.max ?? MAX_ACTIVE_PER_OWNER) }
  if (status === 400) {
    const f = body?.field
    const field = f === 'threshold' ? f : f === 'ownerKey' ? 'address' : null
    return { phase: 'invalid', field, message: body?.message ?? 'Check the alert and try again.' }
  }
  if (status === 404) return { phase: 'unknownFeed' }
  if (status === 429) return { phase: 'error', message: 'Too many tries. Wait a few minutes.' }
  return { phase: 'error', message: 'Alerts are down right now. Try later.' }
}

export type OutcomeView =
  | { kind: 'stored'; feedUrl: string; telegramLink: string | null; id: string | null }
  | { kind: 'field'; error: FieldError }
  | { kind: 'cap'; message: string }
  | { kind: 'message'; message: string }

/**
 * Where an outcome shows: the stored panel, under the field it names (only if that
 * field is on screen), or as one line under the form.
 */
export const outcomeView = (out: Outcome, addressFieldShown: boolean): OutcomeView => {
  if (out.phase === 'success') return { kind: 'stored', feedUrl: out.feedUrl, telegramLink: out.telegramLink, id: out.id }
  if (out.phase === 'invalid' && out.field && (out.field !== 'address' || addressFieldShown)) {
    return { kind: 'field', error: { field: out.field, message: out.message } }
  }
  if (out.phase === 'unknownFeed') return { kind: 'message', message: 'Alerts are down right now. Try later.' }
  // A full alerts page is not a dead end: the control links to it, and offers a second page.
  if (out.phase === 'cap') return { kind: 'cap', message: out.message }
  return { kind: 'message', message: out.message }
}

/** "ETH price below $2,500.00" — the alert just set, under "Alert set." */
export const alertLine = (metric: Metric, subject: string, direction: Direction, threshold: number): string =>
  describeThreshold({ metric, subject, direction, threshold })

/** "Your alerts page": the token-gated page that lists, edits and stops them. */
export const manageHref = (token: string): string => `/alerts/${token}`

/** The feed token inside a feed URL (to add the next alert to the same feed). */
export const tokenFromFeedUrl = (url: string): string | null => /\/api\/alerts\/feed\/([0-9a-f]{64})/.exec(url)?.[1] ?? null

/** Per-viewer convenience key: this browser's feed for this address. */
export const feedStorageKey = (address: string): string => `membrane:alerts:feed:${address.trim().toLowerCase()}`

/** The POST body. */
export const requestBody = (args: {
  metric: Metric
  subject: string
  direction: Direction
  threshold: number
  address: string
  feedToken: string | null
}) => ({
  ownerKind: 'address' as const,
  ownerKey: args.address.trim(),
  metric: args.metric,
  subject: args.subject,
  direction: args.direction,
  threshold: args.threshold,
  optIn: true as const,
  ...(args.feedToken ? { feedToken: args.feedToken } : {}),
})
