// Pure view-model for EDITING an alert on the alerts page (/alerts/<token>,
// ManageAlerts.tsx). JSX-free and I/O-free so tests/unit exercises what the edit form
// shows and how each PATCH answer maps to a state. Parsing and bounds are the same
// as setting an alert (alertMeAtLogic thresholdError → lib/userAlerts/metrics.ts).
//
// The edit SEMANTICS live in lib/userAlerts/store.ts editThreshold (docs/USER_ALERTS.md):
// a changed line is a new alert that starts fresh; the old one stops and keeps its
// history; an unchanged Save writes nothing.

import type { Direction, Metric } from '@/lib/userAlerts/metrics'

import { parseInput, thresholdError, type FieldError } from './alertMeAtLogic'

export const EDIT_CTA = 'Edit'
export const SAVE_CTA = 'Save'
export const CANCEL_CTA = 'Cancel'
export const STOP_CTA = 'Stop'
/** Beside "Save": what a changed number does (it can fire again; past alerts stay). */
export const EDIT_NOTE = 'Saving starts this alert fresh. Its past alerts stay under Recent.'
export const GONE_TEXT = 'This alert is no longer active. The list is up to date.'

/**
 * The edit input starts at the STORED number, exactly (up to the six decimals the API
 * keeps) — never rounded to display precision, which would silently change the line
 * when only the direction is edited.
 */
export const editPrefill = (threshold: number): string => (Number.isFinite(threshold) ? String(threshold) : '')

/** The PATCH body: the parsed number (decimal comma already read) and the direction. */
export const editBody = (direction: Direction, input: string) => ({ direction, threshold: parseInput(input) })

/** The typed value's problem, if any — the same rule as "Set alert". */
export const editError = (metric: Metric, input: string): FieldError | null => thresholdError(metric, input)

export type EditResult = { id?: string; changed?: boolean; error?: string; field?: string; message?: string }

export type EditOutcome =
  | { phase: 'saved'; id: string; changed: boolean }
  | { phase: 'invalid'; message: string }
  /** 404: not an active alert of this link any more (stopped, or already replaced). */
  | { phase: 'gone' }
  | { phase: 'error'; message: string }

/** One PATCH answer → the edit form's next state. */
export const editOutcome = (status: number, body: EditResult | null): EditOutcome => {
  if (status === 200 && typeof body?.id === 'string') return { phase: 'saved', id: body.id, changed: body.changed === true }
  if (status === 400) return { phase: 'invalid', message: body?.message ?? 'Check the number and try again.' }
  if (status === 404) return { phase: 'gone' }
  if (status === 429) return { phase: 'error', message: 'Too many tries. Wait a minute.' }
  return { phase: 'error', message: 'Could not save it. Try again.' }
}
