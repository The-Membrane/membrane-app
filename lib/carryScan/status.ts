/**
 * S7 STATUS — by dedupe key, against the last 8 weekly files on the `data` branch.
 *
 *   NEW         passes this week, passed in none of the previous 8 weeks, not on the app.
 *               The 8-week window stops a flickering row from showing as NEW again.
 *   STILL       passed last week too; `weeksInRow` counts the run.
 *   RETURNING   passed within the last 8 weeks, but not last week.
 *   DROPPED     passed last week and fails now, listed with the gate it failed.
 *   NOW ON APP  the key has entered the on-app set: removed, with a success note.
 *
 * "Passes" = listed as ranked (main list or LP tab). "Last week" is the most recent weekly
 * file, so a missed scan does not turn every row RETURNING.
 * PERSISTENT: once 4 weekly files exist (this one included), (a) at the default size was
 * positive in at least 3 of the last 4.
 */

import {
  THRESHOLDS,
  type DroppedRow,
  type NowOnAppRow,
  type PastWeek,
  type ScoutList,
  type ScoutStatus,
} from './types'

const PASSING: ScoutList[] = ['ranked', 'lp']

export interface CurrentRow {
  key: string | null
  aliases: string[]
  list: ScoutList
  carryA100k: number | null
  label: string
  protocol: string
  stable: string
  unrankedReason?: string
}

export interface StatusResult {
  byKey: Map<string, { status: ScoutStatus; weeksInRow: number; persistent: boolean | null }>
  dropped: DroppedRow[]
  nowOnApp: NowOnAppRow[]
  newCount: number
}

const passKeys = (w: PastWeek): Set<string> =>
  new Set(w.rows.filter((r) => r.key && PASSING.includes(r.list)).map((r) => r.key as string))

export function computeStatuses(
  current: readonly CurrentRow[],
  pastWeeks: readonly PastWeek[],
  onAppKeys: ReadonlySet<string>,
  gateByAlias: ReadonlyMap<string, string>,
): StatusResult {
  const past = [...pastWeeks]
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-THRESHOLDS.statusWindowWeeks)
  const pastPass = past.map(passKeys)
  const last = past.length ? past[past.length - 1] : null
  const lastPass = last ? pastPass[pastPass.length - 1] : new Set<string>()
  const anyPast = new Set(pastPass.flatMap((s) => [...s]))

  const byKey: StatusResult['byKey'] = new Map()
  const nowPass = new Set<string>()
  let newCount = 0
  for (const r of current) {
    if (!r.key || !PASSING.includes(r.list)) continue
    nowPass.add(r.key)
    let status: ScoutStatus
    let weeksInRow = 1
    if (lastPass.has(r.key)) {
      status = 'STILL'
      for (let i = pastPass.length - 1; i >= 0 && pastPass[i].has(r.key); i--) weeksInRow++
    } else if (anyPast.has(r.key)) {
      status = 'RETURNING'
    } else {
      status = 'NEW'
      newCount++
    }
    byKey.set(r.key, { status, weeksInRow, persistent: persistentOf(r.key, r.carryA100k, past) })
  }

  const dropped: DroppedRow[] = []
  const nowOnApp: NowOnAppRow[] = []
  if (last) {
    for (const pr of last.rows) {
      if (!pr.key || !PASSING.includes(pr.list) || nowPass.has(pr.key)) continue
      const label = pr.label ?? pr.key
      if (onAppKeys.has(pr.key)) {
        nowOnApp.push({
          key: pr.key,
          label,
          protocol: pr.protocol ?? '',
          stable: pr.stable ?? '',
          note: 'now on the app — it left the scout list because the app covers it',
        })
        continue
      }
      // An unverified row has no key this week; match it by its DeFiLlama alias.
      const cur = current.find(
        (c) =>
          (c.key !== null && c.key === pr.key) ||
          c.aliases.some((a) => (pr.aliases ?? []).includes(a)),
      )
      const fromTrace = (pr.aliases ?? []).map((a) => gateByAlias.get(a)).find(Boolean)
      const failedGate = cur
        ? (cur.unrankedReason ?? `listed as ${cur.list}`)
        : (fromTrace ?? 'not in this week’s DeFiLlama universe')
      dropped.push({
        key: pr.key,
        aliases: pr.aliases ?? [],
        label,
        protocol: pr.protocol ?? '',
        stable: pr.stable ?? '',
        failedGate,
        lastPassedWeek: last.week,
      })
    }
  }
  return { byKey, dropped, nowOnApp, newCount }
}

/** What S7 needs to know about one finalist to list it, or drop it. */
export interface FinalistFacts {
  /** The resolved deposit contract; null when no resolver found one. */
  address: string | null
  /** The resolver's reason when `address` is null. */
  unresolvedReason?: string
  verification?: { ok: boolean; failed?: string } | null
  stability?: { ok: boolean; reason?: string } | null
  exposure: 'single' | 'multi'
  /** A same-stable borrow benchmark exists at the default size. */
  hasBenchmark: boolean
  /** (a) is positive at the default size and on the 30-day mean, after S6 pricing. */
  positive: boolean
}

export type FinalistPlacement = { list: ScoutList; reason?: string } | { drop: string }

/**
 * S7: list or drop each finalist. Stability is checked FIRST, for every finalist: a real
 * stability failure drops the row whether or not it resolved or verified (2026-W41 listed 9
 * unresolved, unstable rows as Unverified). A chart that could not be read is not a failure:
 * the row stays listed as Unverified, with that reason. Then, in order: address, on-chain
 * verification, LP, benchmark, carry.
 * `stable` counts the finalists whose stability passed (an unavailable chart is not a pass).
 */
export function placeFinalists(finalists: readonly FinalistFacts[]): {
  placements: FinalistPlacement[]
  stable: number
} {
  const placements = finalists.map((f): FinalistPlacement => {
    if (!f.stability?.ok) {
      if (f.stability?.reason?.startsWith('chart unavailable'))
        return { list: 'unverified', reason: f.stability.reason }
      return { drop: `stability: ${f.stability?.reason ?? 'unknown'}` }
    }
    if (!f.address)
      return { list: 'unverified', reason: f.unresolvedReason ?? 'address not resolved' }
    if (!f.verification?.ok)
      return { list: 'unverified', reason: f.verification?.failed ?? 'not verified' }
    if (f.exposure === 'multi')
      return f.positive ? { list: 'lp' } : { drop: 'LP: (a) not positive after pricing' }
    if (!f.hasBenchmark) return { list: 'no-benchmark', reason: 'no same-stable borrow market' }
    return f.positive
      ? { list: 'ranked' }
      : { drop: 'carry: (a) not positive after on-chain pricing or averaging' }
  })
  return { placements, stable: finalists.filter((f) => f.stability?.ok).length }
}

function persistentOf(
  key: string,
  carryNow: number | null,
  past: readonly PastWeek[],
): boolean | null {
  const window = THRESHOLDS.persistentWindow
  if (past.length + 1 < window) return null
  const prev = past.slice(-(window - 1))
  let positive = carryNow !== null && carryNow > 0 ? 1 : 0
  for (const w of prev) {
    const r = w.rows.find((x) => x.key === key)
    const a = r?.carryA?.['100k']?.apy
    if (typeof a === 'number' && a > 0) positive++
  }
  return positive >= THRESHOLDS.persistentMin
}
