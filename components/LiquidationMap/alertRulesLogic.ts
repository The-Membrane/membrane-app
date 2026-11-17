// User-set alert rules for the X-ray. Pure: evaluate rules on one live read, fire
// only on a new crossing, and (de)serialize for browser storage. In-app only:
// checked while the page is open. Off-site delivery stays off until the PERSONAL
// ALERT OUTBOX gates pass (board, 2026-09-27).

export type AlertKind = 'distance' | 'hf' | 'daysToHf1'

export type AlertRule = { id: string; kind: AlertKind; threshold: number }

export type AlertInput = {
  distance: number | null
  healthFactor: number | null
  daysToHf1: number | null
}

export type Fired = { id: string; text: string }

export const RULE_LIMITS: Record<AlertKind, { min: number; max: number; label: string }> = {
  distance: { min: 0.001, max: 0.5, label: 'Distance to liquidation below' },
  hf: { min: 1, max: 5, label: 'Health factor below' },
  daysToHf1: { min: 1, max: 3650, label: 'Days to HF 1 at today’s rates below' },
}

export const MAX_RULES = 6
export const STORAGE_KEY = 'membrane.liqmap.alerts.v1'
export const RECHECK_MS = 5 * 60 * 1000

const fmt = (kind: AlertKind, v: number) =>
  kind === 'distance'
    ? `${(v * 100).toFixed(1)}%`
    : kind === 'hf'
      ? v.toFixed(3)
      : `${Math.round(v)}`

const valueOf = (kind: AlertKind, x: AlertInput) =>
  kind === 'distance' ? x.distance : kind === 'hf' ? x.healthFactor : x.daysToHf1

export function validRule(r: unknown): r is AlertRule {
  if (!r || typeof r !== 'object') return false
  const { id, kind, threshold } = r as AlertRule
  if (typeof id !== 'string' || !(kind in RULE_LIMITS) || typeof threshold !== 'number')
    return false
  const L = RULE_LIMITS[kind]
  return Number.isFinite(threshold) && threshold >= L.min && threshold <= L.max
}

/** Rules whose live value is below the threshold. No value = no data = not fired. */
export function evaluateRules(rules: AlertRule[], x: AlertInput): Fired[] {
  const out: Fired[] = []
  for (const r of rules) {
    const v = valueOf(r.kind, x)
    if (v === null || !Number.isFinite(v) || v >= r.threshold) continue
    out.push({
      id: r.id,
      text: `${RULE_LIMITS[r.kind].label} ${fmt(r.kind, r.threshold)}: now ${fmt(r.kind, v)}`,
    })
  }
  return out
}

/** Edge-triggered: only rules that were not already firing on the previous read. */
export function newlyFired(prev: ReadonlySet<string>, now: Fired[]): Fired[] {
  return now.filter((f) => !prev.has(f.id))
}

export type Stored = { address: string; rules: AlertRule[] }

export function parseStored(raw: string | null): Stored | null {
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as Stored
    if (!d || typeof d.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(d.address)) return null
    const rules = Array.isArray(d.rules) ? d.rules.filter(validRule).slice(0, MAX_RULES) : []
    return { address: d.address, rules }
  } catch {
    return null
  }
}

export const makeRule = (kind: AlertKind, threshold: number, now = Date.now()): AlertRule => ({
  id: `${kind}-${now.toString(36)}`,
  kind,
  threshold,
})
