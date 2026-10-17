/**
 * Short headlines for the curator feed's compact surfaces: the CuratorFeedCard (venue
 * page, Today's Safety body) and the §07 oracle-gap cards. Pure.
 *
 * Owner, 2026-10-16: "summarized titles … right now it's too wordy and takes too much
 * effort to parse what the information is and if I need to care." So each item leads with
 * a 2–5 word headline in plain words ("2 curators left LBTC", "Cap cut to 0: PT-sUSDD",
 * "Oracle gap: none for 24h"); the full sentence stays one tap away; one top line says
 * whether anything fired.
 *
 * Rules (membrane-board design/DESIGN_RULES.md): calm is ink; ✖ and red only for a real
 * alarm (an exit cluster, a fired oracle gap); ░ for stale or missing inputs, with the
 * finding withheld; no verdict words; every number from the data.
 */

import { compact, durationText, short, utc } from './format'
import { gapText, STALE_HOURS, thresholdText } from './oracleGap'
import type { ClusterView, FeedRow, OracleGapMarketView, OracleGapResponse } from './service'

export type Mark = '✖' | '▲' | '░'

export interface Line {
  /** The glyph before the headline; ✖ only with `alarm`. */
  mark?: Mark
  alarm: boolean
  headline: string
  /** Small print under the headline. */
  detail: string
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

// ── feed rows ─────────────────────────────────────────────────────────────────

/** What a row is about: its collateral ("PT-sUSDD", "LBTC +2"), else its target. */
export function rowSubject(
  r: Pick<FeedRow, 'collateralSymbols' | 'targetName' | 'vaultName'>,
): string {
  const syms = r.collateralSymbols.filter((s) => s !== 'idle')
  if (syms.length) return syms.length > 1 ? `${syms[0]} +${syms.length - 1}` : syms[0]
  return r.targetName || r.vaultName
}

/** "Cap cut to 0: PT-sUSDD". Two to five words, then the subject. */
export function rowHeadline(
  r: Pick<FeedRow, 'kind' | 'collateralSymbols' | 'targetName' | 'vaultName' | 'to'>,
): string {
  const s = rowSubject(r)
  const on = r.to === 'true'
  switch (r.kind) {
    case 'cap_zero':
      return `Cap cut to 0: ${s}`
    case 'cap_cut':
      return `Cap cut: ${s}`
    case 'cap_raise':
      return `Cap raised: ${s}`
    case 'cap_submit':
      return `Cap raise queued: ${s}`
    case 'cap_revoke':
      return `Cap change revoked: ${s}`
    case 'removal_submit':
      return `Removal queued: ${s}`
    case 'removal_revoke':
      return `Removal revoked: ${s}`
    case 'market_removed':
      return `Market removed: ${s}`
    case 'market_added':
      return `Market added: ${s}`
    case 'supply_queue_remove':
      return `No new deposits: ${s}`
    case 'supply_queue_add':
      return `Takes deposits: ${s}`
    case 'writeoff_submit':
      return `Write-off queued: ${s}`
    case 'writeoff':
      return `Written off: ${s}`
    case 'timelock_submit':
      return 'Timelock change queued'
    case 'timelock_set':
      return 'Timelock changed'
    case 'timelock_revoke':
      return 'Timelock change revoked'
    case 'curator_set':
      return 'Curator changed'
    case 'allocator_set':
      return on ? 'Allocator added' : 'Allocator removed'
    case 'guardian_submit':
      return 'Guardian change queued'
    case 'guardian_set':
      return 'Guardian changed'
    case 'guardian_revoke':
      return 'Guardian change revoked'
    case 'owner_set':
      return 'Owner changed'
    case 'sentinel_set':
      return on ? 'Sentinel added' : 'Sentinel removed'
    case 'adapter_add':
      return 'Adapter added'
    case 'adapter_remove':
      return 'Adapter removed'
    case 'v2_submit':
      return 'Change queued'
    case 'v2_revoke':
      return 'Queued change revoked'
    case 'freeze':
      return `Aave froze ${s}`
    case 'unfreeze':
      return `Aave unfroze ${s}`
    case 'pause':
      return `Aave paused ${s}`
    case 'unpause':
      return `Aave unpaused ${s}`
    case 'borrow_off':
      return `Aave borrowing off: ${s}`
    case 'borrow_on':
      return `Aave borrowing on: ${s}`
    case 'ltv_zero':
      return `Aave LTV to 0: ${s}`
    case 'collateral_params':
      return `Aave params changed: ${s}`
  }
}

/** "pending · 2d 3h left" / "window elapsed, not executed" / "" (history). */
export function rowWhen(r: Pick<FeedRow, 'status' | 'secondsLeft'>): string {
  if (r.status === 'pending') return `pending · ${durationText(r.secondsLeft)} left`
  if (r.status === 'executable') return 'window elapsed, not executed'
  if (r.status === 'cleared') return 'no longer pending'
  if (r.status === 'revoked') return 'revoked'
  return ''
}

const curator = (name: string) => (/^0x[0-9a-fA-F]{40}$/.test(name) ? short(name) : name)

/**
 * A row as a card line: the headline, then vault · curator · date · status. `current`: the
 * row belongs to a cluster that is an alarm now (currentClusters); only then ✖ and red.
 */
export function rowLine(r: FeedRow, current = false): Line {
  const when = rowWhen(r)
  return {
    ...(current ? { mark: '✖' as const } : {}),
    alarm: current,
    headline: rowHeadline(r),
    detail: [
      r.vaultName,
      curator(r.curatorName),
      utc(r.ts).slice(0, 10),
      r.inCluster ? 'part of an exit cluster' : '',
      when,
    ]
      .filter(Boolean)
      .join(' · '),
  }
}

// ── clusters ──────────────────────────────────────────────────────────────────

/**
 * The feed's clusters span its whole collected range. A cluster is an alarm NOW while its
 * last exit is inside the cluster window (`windowHours`, the same 24–72 h the clusters are
 * built with) before `nowS`; an older one is history. Newest first.
 */
export function currentClusters<T extends Pick<ClusterView, 'end'>>(
  clusters: readonly T[],
  nowS: number,
  windowHours: number,
): { current: T[]; past: T[] } {
  const sorted = [...clusters].sort((a, b) => b.end - a.end)
  const W = windowHours * 3600
  return {
    current: sorted.filter((c) => nowS - c.end <= W),
    past: sorted.filter((c) => nowS - c.end > W),
  }
}

/** "2 curators left LBTC"; the window and date in the small print. ✖ only when current. */
export function clusterLine(c: ClusterView, current: boolean): Line {
  const h = c.tightestHours < 1 ? '<1h' : `${Math.round(c.tightestHours)}h`
  const unread = c.text.includes('remaining caps not read') ? ' · caps partly unread' : ''
  return {
    ...(current ? { mark: '✖' as const } : {}),
    alarm: current,
    headline: `${c.curators.length} curators left ${c.symbol}`,
    detail: `within ${h} · ${utc(c.end).slice(0, 10)} · ${c.curatorNames.map(curator).join(', ')}${unread}`,
  }
}

// ── oracle gap ────────────────────────────────────────────────────────────────

/** "$787M (book value)" / "$5M (incl. $1M book value)" / "$5M" */
export function usdWithBook(total: number, book: number): string {
  if (book > 0 && book >= total * 0.999) return `$${compact(total)} (book value)`
  if (book > 0) return `$${compact(total)} (incl. $${compact(book)} book value)`
  return `$${compact(total)}`
}

/**
 * The oracle-gap state as one card line. `error`: the query failed (a 503: no dataset).
 * Stale or unmeasured inputs withhold the finding (░). "none for 24h" only once 24 hourly
 * points exist; before that "none yet", with the count of points.
 */
export function gapLine(r: OracleGapResponse | undefined, error: boolean): Line | undefined {
  if (!r)
    return error
      ? { mark: '░', alarm: false, headline: 'Oracle gap: unavailable', detail: '' }
      : undefined
  const { meta, counts, constants } = r
  const line = thresholdText(constants)
  const h = constants.persistenceHours
  if (!meta.measured)
    return {
      alarm: false,
      headline: 'Oracle gap: not measured yet',
      detail: 'the hourly collector adds a point each run',
    }
  if (meta.stale)
    return {
      mark: '░',
      alarm: false,
      headline: 'Oracle gap: stale',
      detail: `last point ${durationText(meta.now - (meta.lastRunTs ?? 0))} ago`,
    }
  const rule = `oracle ≥ ${line} above market for ${h} h`
  if (counts.fired > 0)
    return {
      mark: '✖',
      alarm: true,
      headline: `Oracle gap: ${plural(counts.fired, 'market')} fired`,
      detail: [
        rule,
        r.exposed.fired
          ? `${usdWithBook(r.curatedUsd.fired, r.bookUsd.fired)} curated supply`
          : 'no curated supply',
      ].join(' · '),
    }
  const building = counts.building
    ? `${plural(counts.building, 'market')} above ${line} for under ${h} h`
    : ''
  return {
    alarm: false,
    headline: meta.runs >= h ? `Oracle gap: none for ${h}h` : 'Oracle gap: none yet',
    detail: [meta.runs >= h ? `no ${rule}` : `${meta.runs} of ${h} hourly points so far`, building]
      .filter(Boolean)
      .join(' · '),
  }
}

/** One §07 card's status mark: ✖ fired (alarm), ▲ building, below, ░ not measured / stale. */
export function gapMark(
  m: OracleGapMarketView,
  r: Pick<OracleGapResponse, 'constants' | 'meta'>,
): Line {
  const { i3 } = m
  const line = thresholdText(r.constants)
  const delta = i3.currentGap !== undefined ? gapText(i3.currentGap) : '░'
  switch (i3.state) {
    case 'fired':
      return {
        mark: '✖',
        alarm: true,
        headline: delta,
        detail: `fired · ${i3.hoursAboveConsecutive} h ≥ ${line}`,
      }
    case 'building':
      return {
        mark: '▲',
        alarm: false,
        headline: delta,
        detail: `${i3.hoursAboveConsecutive} of ${i3.persistence} h ≥ ${line}`,
      }
    case 'stale':
      // Stale: the figure is withheld. The small print keeps the last value, said as the
      // last point and its age, never as a current reading.
      return {
        mark: '░',
        alarm: false,
        headline: '░',
        detail: `stale · last point ${i3.currentGap !== undefined ? `${gapText(i3.currentGap)} · ` : ''}${durationText(r.meta.now - (i3.lastTs ?? 0))} old`,
      }
    case 'unobserved':
      return {
        mark: '░',
        alarm: false,
        headline: '░',
        detail: m.lastRaw ? 'not measured · low price confidence' : 'not measured',
      }
    default:
      return { alarm: false, headline: delta, detail: `below ${line}` }
  }
}

/** The $ exposed in small print: "$12.3M exposed", "$787M book value", "no curated supply". */
export function gapExposed(
  m: Pick<OracleGapMarketView, 'curatedUsd' | 'locked'>,
  minUsd: number,
): string {
  if (m.curatedUsd === undefined) return 'no curated supply'
  if (m.curatedUsd < minUsd) return `under $${minUsd} curated supply`
  return m.locked
    ? `$${compact(m.curatedUsd)} exposed · book value`
    : `$${compact(m.curatedUsd)} exposed`
}

/**
 * The exits feed's head time when it is stale, else undefined. Stale on the oracle gap's
 * own rule (STALE_HOURS: the hourly collector's cadence with slack). Past it, exits since
 * the head block are not collected yet, so nothing is said about exits "now".
 */
export function exitsAsOf(meta: { now: number; toTs: number }): number | undefined {
  return meta.now - meta.toTs > STALE_HOURS * 3600 ? meta.toTs : undefined
}

// ── the card's top line ──────────────────────────────────────────────────────

/**
 * One line that says whether anything fired: "✖ 2 alarms now", "No alarm now · 2 changes
 * queued", or, while an input is missing or stale, which one ("No exit alarm · oracle gap
 * stale", "Exits as of 2026-10-11 18:05 UTC · no oracle alarm"). "No alarm now" only when
 * both inputs are fresh.
 * Undefined while both inputs are loading.
 */
export function cardSummary(input: {
  /** Exit clusters that are an alarm now (currentClusters), open submits still inside
   *  their timelock, and `asOf`: the feed's head time, set only when the feed is stale
   *  (older than STALE_HOURS), so no "now" can be said about exits. */
  feed?: { currentClusters: number; pending: number; asOf?: number }
  feedError: boolean
  gap?: OracleGapResponse
  gapError: boolean
}): Line | undefined {
  const { feed, feedError, gap, gapError } = input
  if (!feed && !feedError && !gap && !gapError) return undefined
  const gapFresh = !!gap && gap.meta.measured && !gap.meta.stale
  const gapFired = gapFresh ? gap!.counts.fired : 0
  const alarms = (feed?.currentClusters ?? 0) + gapFired
  if (alarms > 0)
    return { mark: '✖', alarm: true, headline: `${plural(alarms, 'alarm')} now`, detail: '' }
  if (feedError && gapError)
    return { mark: '░', alarm: false, headline: 'Feed unavailable', detail: '' }
  const queued = feed?.pending ? ` · ${plural(feed.pending, 'change')} queued` : ''
  const feedFresh = !!feed && feed.asOf === undefined
  if (feedFresh && gapFresh) return { alarm: false, headline: `No alarm now${queued}`, detail: '' }
  const exits = feed
    ? feed.asOf !== undefined
      ? `Exits as of ${utc(feed.asOf)}`
      : 'No exit alarm'
    : feedError
      ? 'Exits unavailable'
      : 'Exits loading'
  const oracle = gapFresh
    ? 'no oracle alarm'
    : gapError
      ? 'oracle gap unavailable'
      : !gap
        ? 'oracle gap loading'
        : !gap.meta.measured
          ? 'oracle gap not measured'
          : 'oracle gap stale'
  const missing = (!feed && feedError) || (!!feed && !feedFresh) || gapError || (!!gap && !gapFresh)
  return {
    ...(missing ? { mark: '░' as const } : {}),
    alarm: false,
    headline: `${exits} · ${oracle}${queued}`,
    detail: '',
  }
}
