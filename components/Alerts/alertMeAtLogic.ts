// Pure view-model for the "Alert me at X" control (AlertMeAt.tsx). JSX-free and
// I/O-free so tests/unit exercises exactly what the control renders: the prefill,
// the validation messages, the distance-from-now line, and how each API answer maps
// to a state. Bounds and words come from lib/userAlerts/metrics.ts — the same
// constants the API validates with.

import { isPast } from '@/lib/userAlerts/evaluate'
import {
  ADDRESS_RE,
  checkThreshold,
  describeThreshold,
  formatValue,
  METRIC_DP,
  METRIC_LABEL,
  subjectLabel,
  type Direction,
  type Metric,
} from '@/lib/userAlerts/metrics'

export const OPT_IN_TEXT = 'Store this threshold to alert me. Only you get the feed link.'

export type Phase = 'idle' | 'submitting' | 'success' | 'error' | 'cap' | 'stopped'

export type Draft = { input: string; direction: Direction; optIn: boolean; address: string }

export type FieldError = { field: 'threshold' | 'address' | 'optIn'; message: string }

/** "Aave v3 USDe utilization" — the control's fixed subject, in words. */
export const controlTitle = (metric: Metric, subject: string): string => `${subjectLabel(subject)} ${METRIC_LABEL[metric]}`

/**
 * The input's prefill: the CURRENT live value at the metric's display precision, or
 * '' when there is no live value. Never a made-up default.
 */
export const prefillText = (metric: Metric, current: number | null | undefined): string =>
  current === null || current === undefined || !Number.isFinite(current) ? '' : current.toFixed(METRIC_DP[metric])

/** Typed text → number. Tolerates "$", "%", thousands commas and spaces; '' → NaN. */
export const parseInput = (text: string): number => {
  const s = text.replace(/[$%,\s]/g, '')
  return s === '' ? NaN : Number(s)
}

/** Every problem with the draft, in display order (threshold, address, opt-in). */
export const draftErrors = (metric: Metric, draft: Draft, needsAddress: boolean): FieldError[] => {
  const out: FieldError[] = []
  if (draft.input.trim() === '') out.push({ field: 'threshold', message: 'Enter a number.' })
  else {
    const c = checkThreshold(metric, parseInput(draft.input))
    if (!c.ok) out.push({ field: 'threshold', message: c.message })
  }
  if (needsAddress && !ADDRESS_RE.test(draft.address.trim())) out.push({ field: 'address', message: 'Enter a 0x address.' })
  if (!draft.optIn) out.push({ field: 'optIn', message: 'Tick the box to store this alert.' })
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
  return { threshold: pick('threshold'), address: pick('address'), optIn: pick('optIn') }
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
): string | null => {
  if (current === null || current === undefined || !Number.isFinite(current) || !Number.isFinite(threshold)) return null
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
  if (status === 409) return { phase: 'cap', message: `${body?.max ?? 25} alerts max per feed. Stop one first.` }
  if (status === 400) {
    const f = body?.field
    const field = f === 'threshold' || f === 'optIn' ? f : f === 'ownerKey' ? 'address' : null
    return { phase: 'invalid', field, message: body?.message ?? 'Check the alert and try again.' }
  }
  if (status === 404) return { phase: 'unknownFeed' }
  if (status === 429) return { phase: 'error', message: 'Too many tries. Wait a few minutes.' }
  return { phase: 'error', message: 'Alerts are down right now. Try later.' }
}

export type OutcomeView =
  | { kind: 'stored'; feedUrl: string; telegramLink: string | null; id: string | null }
  | { kind: 'field'; error: FieldError }
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
  return { kind: 'message', message: out.message }
}

/** "Stored: ETH price below $2,500.00" */
export const successLine = (metric: Metric, subject: string, direction: Direction, threshold: number): string =>
  `Stored: ${describeThreshold({ metric, subject, direction, threshold })}`

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
