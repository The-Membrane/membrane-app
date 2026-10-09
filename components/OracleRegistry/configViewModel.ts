// View-model for the CONFIG CARDS view of /[chain]/oracles (?view=config): state colours, the
// red overlay, chips, headline, ETA wording and timeline filters. No React here, so every
// rule is unit-tested in tests/unit/oracleRegistryConfigViewModel.test.ts.
//
// Colour rules (owner ruling 2026-10-05, design §6):
//   pending  ◐ amber  — a timelock op queued or armed, not yet live (border, never a fill)
//   proposed ○ blue   — a Safe transaction / governance proposal not yet on-chain
//   historical ● grey — executed
//   stale    ◌ grey   — past its ETA but not executable now (not counted as pending)
//   RED ■    — any downgrade or floor breach, in ANY state. The red border wins over the state
//              colour, but the state is still written out, so nothing depends on colour alone.

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import type { AssetSummary } from '@/lib/oracleRegistry/apiTypes'
import type {
  BreachView,
  ConfigCardView,
  ConfigChangeView,
  ConfigCounts,
  ConfigTabSummary,
  DelayChip,
  OAppView,
  ProposedSourceView,
  RouteRowView,
  RouteSideView,
} from '@/lib/oracleRegistry/config/apiTypes'
import type { ChangeTag, Dimension, ValueAtRisk } from '@/lib/oracleRegistry/config/types'
import { valueAtRiskLabel } from '@/lib/oracleRegistry/config/value'

import { fmtDuration, fmtUtc } from './viewModel'

// ---- vocabulary ---------------------------------------------------------------------------

export type RowState = 'pending' | 'proposed' | 'historical' | 'stale'

/** `token` colours borders and glyphs; `text` (when set) the small state word (AA contrast). */
export type StateMeta = { glyph: string; label: string; token: string; text?: string }

export const STATE_META: Record<RowState, StateMeta> = {
  pending: { glyph: '◐', label: 'PENDING', token: SEMANTIC_COLORS.warning },
  proposed: { glyph: '○', label: 'PROPOSED', token: SEMANTIC_COLORS.proposed },
  historical: {
    glyph: '●',
    label: 'HISTORICAL',
    token: SEMANTIC_COLORS.textTertiary,
    text: SEMANTIC_COLORS.textSecondary,
  },
  stale: {
    glyph: '◌',
    label: 'STALE',
    token: SEMANTIC_COLORS.textTertiary,
    text: SEMANTIC_COLORS.textSecondary,
  },
}

export const RED_META: StateMeta = {
  glyph: '■',
  label: 'RED',
  token: SEMANTIC_COLORS.danger,
  text: SEMANTIC_COLORS.dangerText,
}

/** The colour for SMALL text in `token`'s role: AA contrast for the danger / tertiary greys. */
export const smallText = (token: string): string =>
  token === SEMANTIC_COLORS.danger
    ? SEMANTIC_COLORS.dangerText
    : token === SEMANTIC_COLORS.textTertiary
      ? SEMANTIC_COLORS.textSecondary
      : token

export const DIMENSION_LABEL: Record<Dimension, string> = {
  bridge: 'Bridge',
  oracle: 'Oracles',
  admin: 'Admin',
  mint_redeem: 'Mint / redeem',
}

export const DIMENSION_ORDER: readonly Dimension[] = ['bridge', 'oracle', 'admin', 'mint_redeem']

/**
 * Tags worth shouting (upper-case chips); the rest render as quiet lower-case words. `tone`
 * 'danger' marks a chip that only ever explains a RED row (review round 5: ANOMALY and the
 * verification chips used the amber of OPERATIONAL).
 */
export const TAG_LABEL: Partial<
  Record<ChangeTag, { label: string; loud: boolean; tone?: 'danger' | 'warning' }>
> = {
  logic_change: { label: 'LOGIC CHANGE', loud: true },
  stale_rollback: { label: 'STALE ROLLBACK', loud: true },
  flash: { label: 'FLASH', loud: true },
  large_raise: { label: 'LARGE RAISE', loud: true },
  run_risk: { label: 'RUN RISK', loud: true },
  not_executable: { label: 'NOT EXECUTABLE', loud: false },
  rotation: { label: 'rotation', loud: false },
  deprecated_dvn: { label: 'deprecated DVN', loud: false },
  default_change: { label: 'LZ default changed', loud: false },
  route_created: { label: 'route created', loud: false },
  route_removed: { label: 'route removed', loud: false },
  send_side: { label: 'send side', loud: false },
  grace_period: { label: 'grace period', loud: false },
  blocked: { label: 'blocked', loud: false },
  unblocked: { label: 'unblocked', loud: false },
  inactive_route: { label: 'inactive route', loud: false },
  initialization: { label: 'initial setup', loud: false },
  // a queued call the judge could not decode is unknown, not calm (review round 5)
  undecoded: { label: 'CALL NOT DECODED', loud: true, tone: 'warning' },
  bracketed: { label: 'bracketed', loud: false },
  // owner ruling #4: a grant that follows the protocol's established bot pattern (amber)
  operational: { label: 'OPERATIONAL', loud: true, tone: 'warning' },
  anomaly: { label: 'ANOMALY', loud: true, tone: 'danger' },
  // round 2 #6: more DVNs to pick from at the same threshold (amber, not red)
  wider_dvn_set: { label: 'WIDER DVN SET', loud: true },
  // source verification: checked and NOT verified, vs the lookup FAILED (both fail closed)
  unverified: { label: 'NOT VERIFIED', loud: true, tone: 'danger' },
  verification_unread: { label: 'VERIFICATION LOOKUP FAILED', loud: true, tone: 'danger' },
  // review round 6: a call that executes through a timelock's no-delay bypass, and a Safe
  // DELEGATECALL to foreign code (only ever on a red row)
  timelock_bypass: { label: 'TIMELOCK BYPASS', loud: true, tone: 'warning' },
  delegatecall: { label: 'DELEGATECALL', loud: true, tone: 'danger' },
}

/**
 * A floor-breach route's severity: "$300M at risk (locked on Ethereum)", or "value unread" and
 * why (owner ruling 2026-10-08 #14: such a route sorts first).
 */
export const routeValueText = (v: ValueAtRisk | null | undefined): string => valueAtRiskLabel(v)

/**
 * The red banner's title (KG-2, closed 2026-10-08): floor breaches counted in ROUTES, like the
 * headline (`floorBreachRoutes`), with the breaching sides in brackets when they differ —
 * "1 FLOOR BREACH (2 sides) · 3 RULE BREACHES IN FORCE NOW". `routes` = the counted routes;
 * `sides` = the BR-2 lines listed under the banner.
 */
export function breachBannerTitle(routes: number, sides: number, rules: number): string {
  const r = Math.max(routes, sides > 0 ? 1 : 0)
  const floor = r
    ? `${r} FLOOR ${r === 1 ? 'BREACH' : 'BREACHES'}${sides !== r ? ` (${sides} ${sides === 1 ? 'side' : 'sides'})` : ''}`
    : ''
  const rule = rules ? `${rules} RULE ${rules === 1 ? 'BREACH' : 'BREACHES'}` : ''
  return `${[floor, rule].filter(Boolean).join(' · ')} IN FORCE NOW`
}

/** DVN operators for display: an issuer-run one says so ("usdt0 (issuer-run)"). */
export function operatorLabels(
  side: Pick<RouteSideView, 'operators'> & Partial<Pick<RouteSideView, 'issuerRun'>>,
): string[] {
  const issuer = side.issuerRun ?? []
  return side.operators.map((o) => (issuer.includes(o) ? `${o} (issuer-run)` : o))
}

/**
 * Long ROUND integers (16+ digits, at most 4 significant) read as exact powers of ten:
 * "100000000000000000000000000" → "1e26", "15000000000000000000" → "1.5e19". Never rounded:
 * any other digit run, and digits inside hex or decimals, are left as they are.
 */
export function compactDigits(s: string): string {
  return s.replace(/(?<![\w.])\d{16,}(?![\w.])/g, (m) => {
    if (m.startsWith('0')) return m
    const sig = m.replace(/0+$/, '')
    if (sig.length > 4) return m
    return `${sig.length === 1 ? sig : `${sig[0]}.${sig.slice(1)}`}e${m.length - 1}`
  })
}

export type TagChip = { label: string; loud: boolean; tone?: 'danger' | 'warning' }

export function tagChips(tags: readonly ChangeTag[]): TagChip[] {
  return tags.map((t) => TAG_LABEL[t] ?? { label: t.replace(/_/g, ' '), loud: false })
}

/** Border / glyph colour of a loud tag chip: red for a chip that explains a red row, else amber. */
export const tagToken = (c: Pick<TagChip, 'tone'>): string =>
  c.tone === 'danger' ? RED_META.token : SEMANTIC_COLORS.warning

/**
 * The quiet line under a timeline row: the quiet tags, then EVERY note (review round 5: only the
 * first two notes were shown, so an ANOMALY / OPERATIONAL row lost its reason).
 */
export function rowNoteLine(tags: readonly ChangeTag[], notes: readonly string[]): string {
  return [
    ...tagChips(tags)
      .filter((t) => !t.loud)
      .map((t) => t.label),
    ...notes,
  ].join(' · ')
}

// ---- rows ---------------------------------------------------------------------------------

export function rowState(r: Pick<ConfigChangeView, 'state' | 'stage'>): RowState {
  if (r.state === 'pending' && r.stage === 'stale') return 'stale'
  return r.state
}

export type RowFrame = {
  /** Left accent bar: colour and width. */
  accent: string
  accentWidth: string
  /** 1px outline, or null for quiet rows. */
  outline: string | null
  /** The state chip (always shown, in the STATE colour even when red wins the border). */
  state: StateMeta
}

/** Border colours for a timeline row: red wins over amber / blue / grey, in any state. */
export function rowFrame(r: Pick<ConfigChangeView, 'state' | 'stage' | 'red'>): RowFrame {
  const st = rowState(r)
  const state = STATE_META[st]
  if (r.red) return { accent: RED_META.token, accentWidth: '3px', outline: RED_META.token, state }
  if (st === 'pending' || st === 'proposed')
    return { accent: state.token, accentWidth: '3px', outline: state.token, state }
  return { accent: SEMANTIC_COLORS.borderStrong, accentWidth: '1px', outline: null, state }
}

/**
 * A pending op whose ETA passed AFTER the collector's last read: the card cannot know whether
 * it executed since, so the row says so instead of looking still-pending. Needs the clock.
 */
export function readBeforeEta(eta: number | null, asOfTs: number, now: number | null): boolean {
  return eta != null && eta > 1 && now != null && eta <= now && asOfTs > 0 && asOfTs < eta
}

/** "ETA in 3h 12m" · "ETA passed 2d ago" · "ETA 2026-10-06 08:36 UTC" before the clock runs. */
export function etaText(eta: number | null, now: number | null): string | null {
  if (eta == null || eta <= 1) return null
  if (now == null) return `ETA ${fmtUtc(eta)}`
  const d = eta - now
  return d > 0 ? `ETA in ${fmtDuration(d)}` : `ETA passed ${fmtDuration(-d)} ago`
}

/**
 * The state written out (≤ 3 words + a number), next to its glyph:
 *   PENDING · ARMED · PENDING · ETA in 3h · PENDING · 2/6 CONFIRMED (multisig) · STALE · PAST ETA
 *   · PROPOSED · 2/5 SIGNED · HISTORICAL
 */
export function stateText(
  r: Pick<ConfigChangeView, 'state' | 'stage' | 'eta' | 'signatures'>,
  now: number | null,
): string {
  const st = rowState(r)
  if (st === 'stale') return 'STALE · PAST ETA'
  if (st === 'pending') {
    if (r.stage === 'armed') return 'PENDING · ARMED'
    // a legacy MultiSigWallet submission: confirmations so far, no ETA (no minimum delay)
    if (r.stage === 'submitted')
      return r.signatures ? `PENDING · ${r.signatures} CONFIRMED` : 'PENDING · SUBMITTED'
    const eta = etaText(r.eta, now)
    return eta ? `PENDING · ${eta}` : 'PENDING'
  }
  // a fully signed Safe transaction (review round 6): anyone can execute it now — ARMED
  if (st === 'proposed' && r.stage === 'armed')
    return r.signatures ? `PROPOSED · ARMED · ${r.signatures} SIGNED` : 'PROPOSED · ARMED'
  if (st === 'proposed') return r.signatures ? `PROPOSED · ${r.signatures} SIGNED` : 'PROPOSED'
  return 'HISTORICAL'
}

/** The red chips of one change: DOWNGRADE, FLOOR BREACH, STILL IN EFFECT. */
export function redChips(
  r: Pick<ConfigChangeView, 'severity' | 'floorBreach' | 'red' | 'stillInEffect' | 'state'>,
): string[] {
  const out: string[] = []
  if (r.severity === 'downgrade') out.push('DOWNGRADE')
  if (r.floorBreach) out.push('FLOOR BREACH')
  if (r.red && r.stillInEffect && r.state === 'historical') out.push('STILL IN EFFECT')
  return out
}

export type AnnouncementChip = { label: string; title: string; tone: 'danger' | 'neutral' }

/**
 * The announcement chip. v1 ingests no governance source, so it never says "announced":
 * NO GOV CHANNEL (the issuer has no forum / Snapshot) carries the same weight as
 * ANNOUNCEMENT NOT CHECKED (a channel exists but is not read yet). UNANNOUNCED appears only
 * when a matcher has run and found nothing.
 */
export function announcementChip(
  r: Pick<ConfigChangeView, 'announcement' | 'unannounced'>,
): AnnouncementChip | null {
  if (r.unannounced === true)
    return {
      label: 'UNANNOUNCED',
      title: 'No governance post matched this change before it was queued',
      tone: 'danger',
    }
  if (r.unannounced === false) return null
  return r.announcement === 'no_gov_channel'
    ? {
        label: 'NO GOV CHANNEL',
        title: 'The issuer has no governance forum or Snapshot space to announce changes in',
        tone: 'neutral',
      }
    : {
        label: 'ANNOUNCEMENT NOT CHECKED',
        title:
          'A governance channel exists but is not ingested in v1, so this change was not matched to a post',
        tone: 'neutral',
      }
}

/** "Linea receive" · "Linea send + receive (peer)" — a peer serves both directions. */
export function routeLabel(r: NonNullable<ConfigChangeView['route']>): string {
  return `${r.chain} ${r.direction === 'both' ? 'send + receive (peer)' : r.direction}`
}

/** Where the change is: "block 24,784,877" · "blocks 26,085,463–26,085,464" · "queued". */
export function blockText(
  r: Pick<ConfigChangeView, 'block' | 'blockFrom' | 'state'> &
    Partial<Pick<ConfigChangeView, 'queue'>>,
): string {
  const n = (b: number) => b.toLocaleString('en-US')
  // a legacy MultiSigWallet transaction is SUBMITTED on-chain, not queued in a timelock (review
  // round 7: WBTC's pending rows read "—", their age invisible)
  const multisig = r.state === 'pending' && r.queue?.kind === 'legacy_multisig'
  if (r.block == null)
    return r.state === 'proposed'
      ? 'off-chain'
      : multisig
        ? `submitted · tx ${r.queue!.opId} · block not read`
        : '—'
  if (r.blockFrom != null && r.blockFrom < r.block - 1)
    return `blocks ${n(r.blockFrom)}–${n(r.block)}`
  if (multisig) return `submitted at block ${n(r.block)}`
  return r.state === 'pending' ? `queued at block ${n(r.block)}` : `block ${n(r.block)}`
}

// ---- grouping and filters -------------------------------------------------------------------

export type TimelineFilter = { dimension: Dimension | null; redOnly: boolean }

/**
 * The timeline filter after a button press (review round 6): "All" clears BOTH the dimension and
 * "Red only" (before, it only cleared the dimension, so a Red only left on could hide every row
 * with no visible way back); a dimension toggles; Red only toggles.
 */
export function nextFilter(
  f: TimelineFilter,
  a: { kind: 'all' } | { kind: 'dimension'; dimension: Dimension } | { kind: 'red' },
): TimelineFilter {
  if (a.kind === 'all') return { dimension: null, redOnly: false }
  if (a.kind === 'red') return { ...f, redOnly: !f.redOnly }
  return { ...f, dimension: f.dimension === a.dimension ? null : a.dimension }
}

/** Red rows in the Stale group: the group opens by default and its summary says so. */
export function staleRedCount(
  rows: readonly Pick<ConfigChangeView, 'state' | 'stage' | 'red'>[],
): number {
  return rows.filter((r) => rowState(r) === 'stale' && r.red).length
}

/** Accessible name of a change's "#" permalink. */
export const permalinkLabel = (title: string): string => `Permalink to this change: ${title}`

/** Why each side of a route row was not read — visible text, not only a tooltip. */
export function unreadLines(r: Pick<RouteRowView, 'local' | 'remote'>): string[] {
  const out = r.remote?.unread ? [`remote side not read: ${r.remote.unread}`] : []
  for (const d of ['receive', 'send'] as const)
    for (const [s, where] of [
      [r.local[d], 'Ethereum'],
      [r.remote?.[d], 'remote'],
    ] as const)
      if (s?.unread) out.push(`${where} ${d} side not read: ${s.unread}`)
  return out
}

/** The queued op a row belongs to (a batch key); null for executed rows. */
const opKey = (r: Pick<ConfigChangeView, 'state' | 'queue'>): string | null =>
  r.queue && r.state !== 'historical'
    ? `${r.state}|${r.queue.kind}|${r.queue.address}|${r.queue.opId}`
    : null

/**
 * Rows matching a filter. A queued op is atomic (review round 7): when any of its calls
 * matches, ALL its calls are kept, so its batch never reads "0 red" or a reduced call count
 * because the red call was in another dimension.
 */
export function filterRows(
  rows: readonly ConfigChangeView[],
  f: TimelineFilter,
): ConfigChangeView[] {
  const match = (r: ConfigChangeView) =>
    (!f.dimension || r.dimension === f.dimension) && (!f.redOnly || r.red)
  const ops = new Set(
    rows
      .filter(match)
      .map(opKey)
      .filter((k): k is string => k !== null),
  )
  return rows.filter((r) => match(r) || ops.has(opKey(r) ?? ''))
}

export type RowGroups = Record<RowState, ConfigChangeView[]>

/** Pending first, then proposed, then historical; stale ops sit apart (not amber). */
export function groupRows(rows: readonly ConfigChangeView[]): RowGroups {
  const g: RowGroups = { pending: [], stale: [], proposed: [], historical: [] }
  for (const r of rows) g[rowState(r)].push(r)
  return g
}

export type TimelineItem =
  | { kind: 'row'; row: ConfigChangeView }
  | {
      kind: 'batch'
      key: string
      /** First call: carries the op's shared state, stage, ETA, queue, executor, tx. */
      head: ConfigChangeView
      rows: ConfigChangeView[]
      redCount: number
      /** "Send config ×12 · Receive config ×12". */
      summary: string
    }

/**
 * The loud chips of a batch's calls, once each (review round 6: a batch with no red call showed
 * only "0 red", hiding WIDER DVN SET, CALL NOT DECODED and a timelock BYPASS behind a closed
 * disclosure). Danger-toned chips first.
 */
export function batchLoudChips(rows: readonly Pick<ConfigChangeView, 'tags'>[]): TagChip[] {
  const seen = new Map<string, TagChip>()
  for (const r of rows) for (const c of tagChips(r.tags)) if (c.loud) seen.set(c.label, c)
  return [...seen.values()].sort(
    (a, b) => Number(b.tone === 'danger') - Number(a.tone === 'danger'),
  )
}

/** A batch opens by default when a call is red or carries a loud chip. */
export function batchOpensByDefault(b: {
  redCount: number
  rows: readonly Pick<ConfigChangeView, 'tags'>[]
}): boolean {
  return b.redCount > 0 || batchLoudChips(b.rows).length > 0
}

/** "Send config eid 30110: E=4 → E=4" → "Send config"; "upgrade 0x30…" → "upgrade". */
export function callKind(title: string): string {
  const head = title
    .split(/ eid | 0x|:| for | → /)[0]
    .replace(/[\s,]+$/, '')
    .replace(/\s+(of|on|to)$/, '')
    .trim()
  return head || title
}

export function batchSummary(rows: readonly Pick<ConfigChangeView, 'title'>[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(callKind(r.title), (counts.get(callKind(r.title)) ?? 0) + 1)
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(' · ')
}

/**
 * Folds the calls of ONE queued op (a timelock scheduleBatch, a Safe multiSend) into a single
 * batch item at the position of its first call. Executed (historical) changes are never
 * folded. A lone call stays a plain row. Input order is kept.
 */
export function batchRows(rows: readonly ConfigChangeView[]): TimelineItem[] {
  const out: TimelineItem[] = []
  const at = new Map<string, number>()
  for (const r of rows) {
    const key = opKey(r)
    const i = key == null ? undefined : at.get(key)
    if (key == null || i == null) {
      if (key != null) at.set(key, out.length)
      out.push({ kind: 'row', row: r })
      continue
    }
    const cur = out[i]
    if (cur.kind === 'row')
      out[i] = { kind: 'batch', key, head: cur.row, rows: [cur.row, r], redCount: 0, summary: '' }
    else cur.rows.push(r)
  }
  for (const it of out)
    if (it.kind === 'batch') {
      it.redCount = it.rows.filter((r) => r.red).length
      it.summary = batchSummary(it.rows)
    }
  return out
}

/**
 * The historical group's count line. Unfiltered: "319 executed" or "56 of 319 shown · every
 * red row kept" when quiet rows were trimmed. Filtered: how many rows match, out of how many
 * are loaded, so a trimmed count never reads as the filter's result.
 */
export function historicalAside(a: {
  matching: number
  filtered: boolean
  timeline: Pick<ConfigCardView['timeline'], 'historicalShown' | 'historicalTotal' | 'complete'>
}): string {
  const { matching, filtered, timeline: t } = a
  if (!filtered)
    return t.complete
      ? `${matching} executed`
      : `${t.historicalShown} of ${t.historicalTotal} shown · every red row kept`
  return t.complete
    ? `${matching} of ${t.historicalTotal} match`
    : `${matching} match · ${t.historicalShown} of ${t.historicalTotal} loaded`
}

export function dimensionCounts(rows: readonly ConfigChangeView[]): Record<Dimension, number> {
  const out: Record<Dimension, number> = { bridge: 0, oracle: 0, admin: 0, mint_redeem: 0 }
  for (const r of rows) out[r.dimension]++
  return out
}

// ---- header ----------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Does the card hold a route the verifier floor (BR-2) applies to? A LayerZero route, or a
 * Wormhole NTT manager line (the floor binds its threshold — wstETH's BNB Chain route). CCIP
 * pools and canonical rollup bridges have no verifier floor.
 */
export function hasFloorRoutes(bridge: {
  oapps: readonly { routes: readonly unknown[] }[]
  ccip: readonly { key: string }[]
}): boolean {
  return (
    bridge.oapps.some((o) => o.routes.length > 0) ||
    bridge.ccip.some((c) => c.key.startsWith('bridge/ntt/'))
  )
}

/**
 * "rsETH: 0 floor breaches · 1 red in effect · 0 pending · 0 proposed". Without collector
 * output there are no counts to state: zeros would read as "nothing found". With the change
 * files but no head-state file, the queue counts are known and the breaches are not.
 */
export function headline(
  symbol: string,
  c: ConfigCounts,
  available = true,
  changesAvailable = false,
  /**
   * false: no route the floor applies to (no LayerZero route, no Wormhole NTT route) — the
   * floor count is not applicable, never "0". See `hasFloorRoutes`.
   */
  hasLzRoutes = true,
): string {
  if (!available && changesAvailable) {
    // review round 8: the change files carry the red queued / red in effect counts — the
    // headline names them (it dropped them, and the tab and the headline disagreed)
    const reds = [
      c.redInEffect ? `${c.redInEffect} red in effect` : '',
      c.redOpen ? `${c.redOpen} red queued` : '',
    ].filter(Boolean)
    return `${symbol}: head state not collected — floor and rule breaches unknown · ${reds.length ? `${reds.join(' · ')} · ` : ''}${c.pending} pending · ${c.proposed} proposed (from the change files)`
  }
  if (!available)
    return `${symbol}: not collected — floor breaches, red flags, pending and proposed changes are unknown`
  const parts = [
    hasLzRoutes || c.floorBreaches
      ? plural(c.floorBreaches, 'floor breach', 'floor breaches')
      : 'no LayerZero or NTT route (floor n/a)',
  ]
  if (c.ruleBreaches) parts.push(plural(c.ruleBreaches, 'rule breach', 'rule breaches'))
  if (c.redInEffect) parts.push(`${c.redInEffect} red in effect`)
  if (c.redOpen) parts.push(`${c.redOpen} red queued`)
  parts.push(c.armed ? `${c.pending} pending (${c.armed} armed)` : `${c.pending} pending`)
  parts.push(
    c.armedProposed
      ? `${c.proposed} proposed (${c.armedProposed} armed)`
      : `${c.proposed} proposed`,
  )
  // Partial data (review round 5): the counts above are only what was read.
  const gaps = [
    c.unread ? plural(c.unread, 'route side unread', 'route sides unread') : '',
    c.readGaps ? `${plural(c.readGaps, 'read', 'reads')} failed` : '',
  ].filter(Boolean)
  const hedge = gaps.length ? ` — ${gaps.join(' and ')}: red flags may be missing` : ''
  return `${symbol}: ${parts.join(' · ')}${hedge}`
}

/**
 * The headline's tone (review round 8): red whenever a red is known — also when the head state
 * is missing but the change files hold a red (it was amber there); amber (warning) when nothing
 * red is known and the head state is missing; normal otherwise.
 */
export function headlineTone(
  available: boolean,
  changesAvailable: boolean,
  openRed: number,
): 'red' | 'warning' | 'normal' {
  if (openRed > 0 && (available || changesAvailable)) return 'red'
  return available ? 'normal' : 'warning'
}

/** Collector output older than this is marked STALE (the timeline may be missing changes). */
export const CONFIG_STALE_AFTER_SEC = 48 * 3600

/** A block's count aside ("4 powers"), or "not collected" — never a zero nobody read. */
export function blockAside(available: boolean, n: number, one: string, many = `${one}s`): string {
  return available ? plural(n, one, many) : 'not collected'
}

/**
 * The Oracles block's aside (review round 5): "not collected" when the subject's oracle
 * governance events are not collected (no oracle asset, or no collector output) — never
 * "0 config changes" — else the count over the window the collector covers.
 */
export function oracleAside(o: ConfigCardView['oracle']): string {
  if (!o.collected) return 'not collected'
  const n = plural(o.changes, 'config change')
  return o.windowDays ? `${n} · last ${o.windowDays} d` : n
}

/** A timeline filter button: "Admin 4", or "Oracles: not collected" (never a zero nobody read). */
export function dimensionFilterLabel(d: Dimension, n: number, collected = true): string {
  return collected ? `${DIMENSION_LABEL[d]} ${n}` : `${DIMENSION_LABEL[d]}: not collected`
}

export type FilterButton = {
  key: 'all' | 'red' | Dimension
  label: string
  active: boolean
  disabled: boolean
}

/**
 * The timeline's filter buttons (review round 7): with no collector output at all every button
 * says "not collected" and is disabled — never "All 0 · Bridge 0 · Red only 0" — and a
 * dimension that was not collected (Oracles for a subject outside the catalog) is disabled
 * unless it is the active filter (so it can always be turned off).
 */
export function timelineFilterButtons(
  v: Pick<ConfigCardView, 'available' | 'changesAvailable'> & {
    oracle: Pick<ConfigCardView['oracle'], 'collected'>
    timeline: { totals: Pick<ConfigCardView['timeline']['totals'], 'all' | 'red' | 'byDimension'> }
  },
  filter: TimelineFilter,
): FilterButton[] {
  const any = v.available || v.changesAvailable
  const t = v.timeline.totals
  const out: FilterButton[] = [
    {
      key: 'all',
      label: any ? `All ${t.all}` : 'All: not collected',
      active: !filter.dimension && !filter.redOnly,
      // "All" clears the filters: enabled whenever one is on
      disabled: !any && !filter.dimension && !filter.redOnly,
    },
  ]
  for (const d of DIMENSION_ORDER) {
    const collected = any && (d !== 'oracle' || v.oracle.collected)
    const active = filter.dimension === d
    out.push({
      key: d,
      label: dimensionFilterLabel(d, t.byDimension[d] ?? 0, collected),
      active,
      disabled: (!collected || !t.byDimension[d]) && !active,
    })
  }
  out.push({
    key: 'red',
    label: any ? `Red only ${t.red}` : 'Red only: not collected',
    active: filter.redOnly,
    disabled: (!any || !t.red) && !filter.redOnly,
  })
  return out
}

/** The timeline's count line; "not collected" when neither state nor change files exist. */
export function timelineCountsLine(
  v: Pick<ConfigCardView, 'available' | 'changesAvailable' | 'counts'> & {
    timeline: Pick<ConfigCardView['timeline'], 'historicalTotal'>
  },
): string {
  if (!v.available && !v.changesAvailable) return 'not collected'
  return `${v.counts.pending} pending · ${v.counts.proposed} proposed · ${v.timeline.historicalTotal} historical · ${v.counts.redTotal} red`
}

/** Tooltip of the "no pending window" chip: who can act with no delay (bypass included). */
export const NO_WINDOW_TITLE =
  'A holder with no delay (a Safe, an EOA, a timelock bypass, a contract with no delay, or a multisig whose submissions were not read) can change this: a change can land with no pending window to observe'

export function asOfLine(
  asOf: ConfigCardView['asOf'],
  now: number | null,
): { text: string; stale: boolean } {
  if (!asOf.block) return { text: 'not collected yet', stale: true }
  const base = `as of block ${asOf.block.toLocaleString('en-US')} · ${fmtUtc(asOf.ts)}`
  if (now == null) return { text: base, stale: false }
  const age = Math.max(0, now - asOf.ts)
  return { text: `${base} · ${fmtDuration(age)} ago`, stale: age > CONFIG_STALE_AFTER_SEC }
}

/** "Upgrade 10d" · "Mint INSTANT" — and whether a change could land with no pending window. */
export function delayText(d: Pick<DelayChip, 'label' | 'delayLabel' | 'pendingObservable'>): {
  key: string
  value: string
  noWindow: boolean
} {
  return { key: d.label, value: d.delayLabel, noWindow: !d.pendingObservable }
}

const SOURCE_LABEL: Record<ProposedSourceView['kind'], string> = {
  safe_tx_service: 'Safe queue',
  snapshot: 'Snapshot',
  discourse: 'Forum',
}

/**
 * "Safe queue: 2 read · Snapshot: not ingested · Forum: not ingested". A subject with NO
 * governance channel has no Snapshot space or forum to ingest: say that, not "not ingested".
 */
export function sourcesLine(
  sources: readonly ProposedSourceView[],
  announcement: ConfigCardView['announcement'] = 'not_checked',
): string {
  const byKind = new Map<ProposedSourceView['kind'], ProposedSourceView[]>()
  for (const s of sources) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s])
  const parts: string[] = []
  const kinds =
    announcement === 'no_gov_channel'
      ? (['safe_tx_service'] as const)
      : (['safe_tx_service', 'snapshot', 'discourse'] as const)
  for (const kind of kinds) {
    const xs = byKind.get(kind)
    if (!xs?.length) continue
    const ok = xs.filter((x) => x.status === 'ok').length
    const down = xs.filter((x) => x.status === 'unavailable').length
    const word =
      ok === xs.length
        ? kind === 'safe_tx_service'
          ? `${ok} read`
          : 'read'
        : down
          ? `${down} unavailable`
          : 'not ingested'
    parts.push(`${SOURCE_LABEL[kind]}: ${word}`)
  }
  if (announcement === 'no_gov_channel')
    parts.push('no governance channel (no Snapshot space or forum)')
  return parts.join(' · ')
}

// ---- bridge ----------------------------------------------------------------------------------

export type ECell = { text: string; token: string; glyph: string; label: string }

/** One route side's E: ■ red under the floor, — when closed, ? when unread. */
export function eCell(side: RouteSideView | null | undefined, unread?: string | null): ECell {
  if (unread)
    return {
      text: 'UNREAD',
      token: SEMANTIC_COLORS.warning,
      glyph: '?',
      label: `remote unread: ${unread}`,
    }
  if (side?.unread)
    return {
      text: 'UNREAD',
      token: SEMANTIC_COLORS.warning,
      glyph: '?',
      label: `${side.direction} side unread: ${side.unread}`,
    }
  if (!side) return { text: '—', token: SEMANTIC_COLORS.textTertiary, glyph: '', label: 'not read' }
  if (!side.live)
    return {
      text: side.shape === 'closed' ? 'closed' : 'off',
      token: SEMANTIC_COLORS.textTertiary,
      glyph: '',
      label: side.display,
    }
  if (side.E == null)
    return { text: '?', token: SEMANTIC_COLORS.textTertiary, glyph: '', label: side.display }
  if (side.floorBreach || side.E < 2)
    return {
      text: String(side.E),
      token: RED_META.token,
      glyph: RED_META.glyph,
      label: `under the floor: ${side.display}`,
    }
  return {
    text: String(side.E),
    token: SEMANTIC_COLORS.textPrimary,
    glyph: '',
    label: side.display,
  }
}

/** "20 live · min E 3 · 0 under floor · remote 19 read / 1 unread". */
export function oappSummary(
  o: Pick<OAppView, 'routes' | 'liveRoutes' | 'closedRoutes' | 'remoteRead' | 'remoteUnread'>,
): string {
  const live = o.routes.filter((r) => r.live)
  const es = live.map((r) => r.minE).filter((e): e is number => e != null)
  const under = o.routes.filter((r) => r.floorBreach).length
  const parts = [
    `${o.liveRoutes} live`,
    es.length ? `min E ${Math.min(...es)}` : 'min E —',
    `${under} under floor`,
    `remote ${o.remoteRead} read / ${o.remoteUnread} unread`,
  ]
  if (o.closedRoutes) parts.push(`${o.closedRoutes} closed`)
  return parts.join(' · ')
}

export type RouteFlags = { breaches: BreachView[]; tags: string[]; warnings: string[] }

/**
 * What a route row must say beyond its E cells: failing state rules other than the floor
 * (the floor already reads as ■ in the cell), tags and warnings from every side, deduped.
 * Plumbing the columns already show is dropped: the send_side tag, "REMOTE UNREAD" and
 * "route closed" warnings.
 */
export function routeFlags(r: Pick<RouteRowView, 'local' | 'remote'>): RouteFlags {
  const sides = [r.local.receive, r.local.send, r.remote?.receive, r.remote?.send].filter(
    (s): s is RouteSideView => !!s,
  )
  const seen = new Set<string>()
  const breaches: BreachView[] = []
  const tags: string[] = []
  const warnings: string[] = []
  for (const s of sides) {
    for (const b of s.breaches) {
      const k = `b|${b.ruleId}|${b.message}`
      if (b.ruleId === 'BR-2' || seen.has(k)) continue
      seen.add(k)
      breaches.push(b)
    }
    for (const t of tagChips(s.tags.filter((x) => x !== 'send_side'))) {
      if (seen.has(`t|${t.label}`)) continue
      seen.add(`t|${t.label}`)
      tags.push(t.label)
    }
    for (const w of s.warnings) {
      if (/^(REMOTE )?UNREAD$|^route closed$/.test(w) || seen.has(`w|${w}`)) continue
      seen.add(`w|${w}`)
      warnings.push(w)
    }
  }
  return { breaches, tags, warnings }
}

/**
 * The closed-routes disclosure (review round 7): BR-4 / BR-5 / BR-7 can fire on a route that is
 * not live, and a red row must never sit collapsed under a calm summary — the disclosure opens
 * and its summary counts the red routes (like the stale group).
 */
export function closedRoutesDisclosure(
  closed: readonly Pick<RouteRowView, 'local' | 'remote' | 'floorBreach'>[],
): { summary: string; open: boolean; red: number } {
  const red = closed.filter((r) => r.floorBreach || routeFlags(r).breaches.length > 0).length
  const n = closed.length
  return {
    summary: `${n} closed ${n === 1 ? 'route' : 'routes'} (peer zeroed or blocked)${red ? ` · ${RED_META.glyph} ${red} with red flags` : ''}`,
    open: red > 0,
    red,
  }
}

/** Operators that differ between the Ethereum receive side and the remote receive side. */
export function remoteOperatorsDiffer(
  local: RouteSideView | null | undefined,
  remote: RouteSideView | null | undefined,
): boolean {
  if (!local || !remote) return false
  const a = [...local.operators].sort().join()
  const b = [...remote.operators].sort().join()
  return a !== b
}

// ---- tabs ----------------------------------------------------------------------------------

export type ConfigMark = { glyph: string; count?: number; token: string; label: string }

/** Collected output older than CONFIG_STALE_AFTER_SEC at `now` (never during SSR: no clock). */
export function summaryStale(
  s: Partial<Pick<ConfigTabSummary, 'asOf'>> | null | undefined,
  now: number | null,
): boolean {
  return !!s?.asOf && now != null && now - s.asOf.ts > CONFIG_STALE_AFTER_SEC
}

/**
 * Config marks on an asset tab: ■n open red flags, ◐n pending, ?n route sides that could not
 * be read, !n other failed reads, ░ stale output, ∅ not collected. Empty only when the last
 * read is fresh, complete and quiet. Labels are unique (React keys).
 */
export function configTabMarks(
  s:
    | (Pick<ConfigTabSummary, 'counts'> & Partial<Pick<ConfigTabSummary, 'asOf'>>)
    | null
    | undefined,
  now: number | null = null,
): ConfigMark[] {
  if (!s) return []
  const out: ConfigMark[] = []
  if (s.counts.openRed)
    out.push({
      glyph: RED_META.glyph,
      count: s.counts.openRed,
      token: RED_META.token,
      label: `${s.counts.openRed} config red ${s.counts.openRed === 1 ? 'flag' : 'flags'}`,
    })
  if (s.counts.pending)
    out.push({
      glyph: STATE_META.pending.glyph,
      count: s.counts.pending,
      token: STATE_META.pending.token,
      label: `${s.counts.pending} pending`,
    })
  if (s.counts.unread)
    out.push({
      glyph: '?',
      count: s.counts.unread,
      token: SEMANTIC_COLORS.warning,
      label: `${s.counts.unread} route ${s.counts.unread === 1 ? 'side' : 'sides'} unread`,
    })
  // other failed reads that can hide a red flag (power holders, Safe / multisig queues) — a
  // glyph of their own, so "?5 ?2" never shows two different gaps as one
  if (s.counts.readGaps)
    out.push({
      glyph: '!',
      count: s.counts.readGaps,
      token: SEMANTIC_COLORS.warning,
      label: `${s.counts.readGaps} ${s.counts.readGaps === 1 ? 'read' : 'reads'} failed`,
    })
  if (summaryStale(s, now))
    out.push({
      glyph: '░',
      token: SEMANTIC_COLORS.warning,
      label: `config STALE (older than ${CONFIG_STALE_AFTER_SEC / 3600} hours)`,
    })
  // No head-state output for this subject (review round 5): a visible mark of its own — the
  // empty marks of a clean read must never stand for "nothing was read".
  if (s.asOf === null)
    out.push({ glyph: '∅', token: SEMANTIC_COLORS.warning, label: 'config not collected' })
  return out
}

export type ConfigView = 'oracles' | 'config'

export const parseView = (v: unknown): ConfigView => (v === 'config' ? 'config' : 'oracles')

/** Element id ↔ URL hash for a change (`#<changeId>`); tolerant of percent-encoding. */
export function hashToChangeId(hash: string): string | null {
  const h = hash.replace(/^#/, '')
  if (!h) return null
  try {
    return decodeURIComponent(h)
  } catch {
    return h
  }
}

export function changeHref(slug: string, id: string): string {
  return `?asset=${encodeURIComponent(slug)}&view=config#${encodeURIComponent(id)}`
}

/**
 * In-page anchor of a change. The page keeps ?asset=…&view=config in the URL, so the resolved
 * link IS the permalink, and following it scrolls without a reload.
 */
export const changeAnchor = (id: string): string => `#${encodeURIComponent(id)}`

/**
 * Spoken config part of a tab label: "1 config red flag, 30 pending" · "config: no red flags".
 * "no red flags" is said only of a fresh, complete read: stale output or unread route sides
 * mean red flags may be missing, and the label says so.
 */
export function configTabLabel(
  s:
    | (Pick<ConfigTabSummary, 'counts'> & Partial<Pick<ConfigTabSummary, 'asOf'>>)
    | null
    | undefined,
  now: number | null = null,
): string {
  if (!s) return ''
  const marks = configTabMarks(s, now)
  const flags = marks.filter(
    (m) => m.glyph === RED_META.glyph || m.glyph === STATE_META.pending.glyph,
  )
  const gaps = marks.filter((m) => !flags.includes(m))
  if (flags.length) return marks.map((m) => m.label).join(', ')
  // no collector output: say so — "no red flags" would be a claim nobody checked
  if (s.asOf === null) return 'config: not collected'
  if (gaps.length)
    return `config: no red flags found, but ${gaps.map((m) => m.label).join(' and ')} — red flags may be missing`
  return 'config: no red flags'
}

export type TabEntry = {
  slug: string
  symbol: string
  /** The oracle summary; null ⇒ config-only tab. */
  oracle: AssetSummary | null
  config: ConfigTabSummary | null
}

/** Oracle asset tabs (catalog order) with their config summary, then config-only subjects. */
export function mergeTabs(
  assets: readonly AssetSummary[],
  configs: readonly ConfigTabSummary[],
): TabEntry[] {
  const bySlug = new Map(configs.map((c) => [c.slug, c]))
  const out: TabEntry[] = assets.map((a) => ({
    slug: a.slug,
    symbol: a.symbol,
    oracle: a,
    config: bySlug.get(a.slug) ?? null,
  }))
  const seen = new Set(out.map((t) => t.slug))
  for (const c of configs)
    if (!seen.has(c.slug)) out.push({ slug: c.slug, symbol: c.symbol, oracle: null, config: c })
  return out
}
