/**
 * RETURN-VISIT STATES (framework "Return loop"). The page leads differently by visitor.
 *
 *   first          default story.
 *   returning      a remembered wallet, re-read today and replayed again; the delta since
 *                  the last visit is printed.
 *   changed        the same wallet, bigger or at a higher LTV than last time: the size
 *                  lines lead.
 *   after-event    PENDING. Needs a real-event feed (a cascade detector and that night's
 *                  replay). No source in the repo; the switch exists, the state is a note.
 *   deployed       PENDING. Needs a live Membrane position read. Membrane is pre-launch
 *                  (only anvil 31337 in config/evm/addresses.json); the state is a note.
 *
 * Memory is browser localStorage, one key, every access in try/catch: a private window,
 * blocked storage or a thumbnail capture gets the first-visit page and nothing breaks.
 * It is a per-viewer convenience only: nothing here is shared, sent or relied on.
 */

export const RETURN_KEY = 'membrane.landing.v1'

export interface VisitRecord {
  address: string
  /** Epoch ms of the visit that wrote this record. */
  at: number
  debtUsd: number
  collateralUsd: number
  ltv: number
  /** The verdict figure (venue closed − Membrane closed) on that visit. */
  lessUsd: number
  scenarioId: string
  /** Which position on the wallet (protocol:market). A delta is only taken on the same one. */
  positionKey?: string
}

export type VisitState = 'first' | 'returning' | 'changed' | 'after-event' | 'deployed'

/** The two states with no data source yet. Rendered as a note, never as numbers. */
export const PENDING_STATES: Record<'after-event' | 'deployed', string> = {
  'after-event':
    'After a market event: pending. It needs a cascade feed that replays the night on your position; none exists yet.',
  deployed:
    'Already on Membrane: pending. It needs a live Membrane position read; Membrane is pre-launch.',
}

export interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

function store(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

export function isVisitRecord(v: unknown): v is VisitRecord {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.address === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(r.address) &&
    ['at', 'debtUsd', 'collateralUsd', 'ltv', 'lessUsd'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k] as number)) &&
    typeof r.scenarioId === 'string' &&
    (r.positionKey === undefined || typeof r.positionKey === 'string')
  )
}

export function readVisit(s: StorageLike | null = store()): VisitRecord | null {
  if (!s) return null
  try {
    const raw = s.getItem(RETURN_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isVisitRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeVisit(r: VisitRecord, s: StorageLike | null = store()): void {
  if (!s) return
  try {
    s.setItem(RETURN_KEY, JSON.stringify(r))
  } catch {
    /* storage full or blocked: the page works without it */
  }
}

/** A position counts as changed when debt grew ≥ 10% or LTV rose ≥ 1 point. */
export const CHANGE_DEBT_GROWTH = 0.1
export const CHANGE_LTV_POINTS = 0.01

export interface CurrentRead {
  address: string
  positionKey?: string
  debtUsd: number
  collateralUsd: number
  ltv: number
  lessUsd: number
}

/**
 * Classify this visit. `previous` is the record from the last visit (null on a first
 * visit), `current` today's read of the same wallet (null until it lands).
 * `after-event` and `deployed` are never returned here: their sources do not exist, so
 * the switch can name them (PENDING_STATES) but nothing can route a visitor into them.
 */
export function classifyVisit(previous: VisitRecord | null, current: CurrentRead | null): VisitState {
  if (!previous) return 'first'
  if (!current) return 'returning'
  // A different wallet than the one remembered is that wallet's first visit.
  if (current.address.toLowerCase() !== previous.address.toLowerCase()) return 'first'
  // Another position on the same wallet: nothing to compare against.
  if (!sameKey(previous, current)) return 'returning'
  const grew = previous.debtUsd > 0 ? current.debtUsd / previous.debtUsd - 1 >= CHANGE_DEBT_GROWTH : current.debtUsd > 0
  const higher = current.ltv - previous.ltv >= CHANGE_LTV_POINTS
  return grew || higher ? 'changed' : 'returning'
}

/** Same position? Records written before keys existed never match. */
export function sameKey(previous: VisitRecord, current: CurrentRead): boolean {
  return !!previous.positionKey && previous.positionKey === current.positionKey
}

export interface VisitDelta {
  sinceMs: number
  debtUsd: number
  collateralUsd: number
  ltvPoints: number
  lessUsd: number
}

export function visitDelta(previous: VisitRecord, current: CurrentRead, now: number): VisitDelta {
  return {
    sinceMs: Math.max(0, now - previous.at),
    debtUsd: current.debtUsd - previous.debtUsd,
    collateralUsd: current.collateralUsd - previous.collateralUsd,
    ltvPoints: current.ltv - previous.ltv,
    lessUsd: current.lessUsd - previous.lessUsd,
  }
}
