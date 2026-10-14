// Pure logic for the TELEGRAM ADDRESS-ALERT BOT (MOAT step 7). JSX-free and
// I/O-free: parse a chat command, word a reply, and plan which alarm moments go
// to which chat. All I/O (Telegram HTTP, Postgres) lives in
// scripts/lib/telegramBot.mjs, which receives this module injected — the Next
// webhook imports it directly, the node scripts load it through tsx.
//
// A message is an existing venue alarm (alertLogic's routing) delivered to a chat
// that subscribed to a watched address. Nothing here computes a new signal.

import { getAddress } from 'viem'

import { alarmConsequence } from '@/components/Carry/venueLogLogic'
import { heldVenues, isUnreadDepthAlarm, matchAlerts, type AlarmLike, type WatchLike } from '@/components/Radar/alertLogic'
import { eventHeadline, provenanceLine } from '@/lib/userAlerts/feed'
import { base64urlToHex, FEED_TOKEN_RE, TELEGRAM_LINK_PREFIX, type Direction, type Metric } from '@/lib/userAlerts/metrics'

/** Re-exported so the injected-logic callers (scripts/lib/telegramBot.mjs) reach it. */
export { heldVenues }

export const SITE = 'https://membrane.money'
export const MAX_PER_CHAT_PER_RUN = 20

export type Command =
  | { kind: 'subscribe'; address: string }
  | { kind: 'link_thresholds'; token: string }
  | { kind: 'stop' }
  | { kind: 'list' }
  | { kind: 'help' }

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
/** `th_` + the feed token's 32 bytes as base64url (43 chars): 46 ≤ Telegram's 64. */
const THRESHOLD_LINK_RE = new RegExp(`^${TELEGRAM_LINK_PREFIX}([A-Za-z0-9_-]{43})$`)

/** The feed token a `/start th_…` payload carries, or null. */
export const thresholdTokenFromPayload = (arg: string): string | null => {
  const m = THRESHOLD_LINK_RE.exec(arg)
  const hex = m ? base64urlToHex(m[1]) : null
  return hex && FEED_TOKEN_RE.test(hex) ? hex : null
}

/**
 * One chat message → one command. Accepts the group form `/start@bot_name`.
 * '/start <0xaddress>' (the deep-link payload) subscribes; a bare or invalid
 * '/start' and anything unrecognised get help.
 */
export const parseCommand = (text: unknown): Command => {
  if (typeof text !== 'string') return { kind: 'help' }
  const [head = '', arg = ''] = text.trim().split(/\s+/)
  const cmd = head.toLowerCase().replace(/@[a-z0-9_]+$/, '')
  if (cmd === '/start') {
    if (ADDRESS_RE.test(arg)) return { kind: 'subscribe', address: getAddress(arg) }
    const token = thresholdTokenFromPayload(arg)
    return token ? { kind: 'link_thresholds', token } : { kind: 'help' }
  }
  if (cmd === '/stop') return { kind: 'stop' }
  if (cmd === '/list') return { kind: 'list' }
  return { kind: 'help' }
}

/** t.me deep link that opens the bot with `/start <address>`. */
export const deepLink = (username: string, address: string): string =>
  `https://t.me/${username.replace(/^@/, '')}?start=${getAddress(address)}`

export const radarLink = (address: string): string => `${SITE}/ethereum/radar?address=${address}`

export const shortAddr = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`

export type Reply =
  | { kind: 'subscribed'; address: string; held: string[]; openTexts: string[]; footer: string }
  | { kind: 'not_watched'; address: string }
  | { kind: 'stopped'; count: number; feeds?: number }
  | { kind: 'list'; addresses: string[]; feeds?: number }
  | { kind: 'full'; max: number }
  | { kind: 'th_linked'; active: number }
  | { kind: 'th_unknown' }
  | { kind: 'th_full'; max: number }
  | { kind: 'help' }

/** Plain text, no markdown. "Data compiled by Membrane." appears once, in the welcome. */
/**
 * What a subscriber is alerted on, in plain words, one line per alarm genre
 * (scripts/lib/alarmRules.mjs). No thresholds here: the numbers live in the
 * glossary, which is built from the rule constants.
 */
export const WATCHED_RISKS = [
  'its exit gate changes (cooldown length, terms page, instant-exit liquidity)',
  'its exit capacity falls fast',
  'withdrawals outrun deposits day after day',
  'instant exit could not cover its worst recent day of withdrawals',
  'its swap-out pool drains or goes one-sided',
] as const

/** Only a lending venue (Aave) has a utilization alarm; the line shows only for its holders. */
const LENDING_RISK = 'its lending market is almost fully lent out'
const isLendingVenue = (v: string) => v.startsWith('aave')


export const replyText = (r: Reply): string => {
  switch (r.kind) {
    case 'subscribed': {
      const venues = r.held.length ? r.held.join(', ') : null
      const lines = [
        venues
          ? `Watching ${shortAddr(r.address)}. It holds ${venues}.`
          : `Watching ${shortAddr(r.address)}. It holds none of the venues Membrane watches right now.`,
        r.openTexts.length
          ? `Right now:\n${r.openTexts.map((t) => `- ${t}`).join('\n')}`
          : venues
            ? `Right now: no alarm on ${venues}.`
            : null,
        `This chat gets a message when an alarm starts or ends on ${venues ?? 'a venue this address holds'}:\n${[...WATCHED_RISKS, ...(r.held.some(isLendingVenue) ? [LENDING_RISK] : [])].map((w) => `- ${w}`).join('\n')}`,
        `Radar profile: ${radarLink(r.address)}`,
        'Data compiled by Membrane · /stop to unsubscribe · /list to see what this chat watches',
      ].filter(Boolean)
      return lines.join('\n\n')
    }
    case 'not_watched':
      return `Track this address on Radar first: ${radarLink(r.address)}`
    case 'stopped': {
      const feeds = r.feeds ?? 0
      if (r.count === 0 && feeds === 0) return 'This chat was not watching any address.'
      const parts = [
        r.count > 0 ? `${r.count} address${r.count === 1 ? '' : 'es'}` : null,
        feeds > 0 ? `${feeds} alert feed${feeds === 1 ? '' : 's'}` : null,
      ].filter(Boolean)
      return `Stopped. This chat no longer gets alerts for ${parts.join(' and ')}.`
    }
    case 'full':
      return `This chat already watches ${r.max} addresses. /stop to reset.`
    case 'list': {
      const feedLine = r.feeds ? `Your alert feeds linked here: ${r.feeds}.` : null
      const body = r.addresses.length
        ? `This chat watches:\n${r.addresses.map((a) => `- ${shortAddr(a)} ${radarLink(a)}`).join('\n')}`
        : 'This chat watches no address. Open Radar, track an address, then tap "telegram".'
      return feedLine ? `${body}\n\n${feedLine}` : body
    }
    case 'th_linked':
      return [
        `Linked. This chat gets a message when one of your ${r.active} alert${r.active === 1 ? '' : 's'} is reached or clears.`,
        'Values are checked about hourly. Your RSS feed keeps working.',
        'Data compiled by Membrane · /stop to unlink',
      ].join('\n\n')
    case 'th_unknown':
      return 'That alert link is not valid. Set an alert on Membrane, then tap its telegram link.'
    case 'th_full':
      return `This chat already has ${r.max} alert feeds. /stop to reset.`
    case 'help':
    default:
      return [
        'Membrane venue alerts.',
        'Subscribe from Radar: track an address, then tap "telegram" in its alerts block.',
        `${SITE}/ethereum/radar`,
        '/list shows what this chat watches. /stop unsubscribes.',
      ].join('\n')
  }
}

/** Texts of the alarms open now on the venues a watch holds (for the welcome). */
export const openAlertTexts = (watch: WatchLike, alarms: AlarmLike[]): { held: string[]; openTexts: string[] } => {
  const held = heldVenues(watch)
  const { open } = matchAlerts(held, alarms, watch.createdAt)
  return { held, openTexts: open.map((a) => `${a.venue}: ${a.text}`) }
}

// --- delivery planning -------------------------------------------------------

export type Moment = 'fired' | 'cleared'

export type SubscriptionLike = {
  id: string
  chatId: string
  address: string
  createdAt: string
  stoppedAt: string | null
}

export type AlarmRow = AlarmLike & { id: string }

export type DeliveredKey = { subscriptionId: string; alarmId: string; moment: Moment }

export type Delivery = { subscriptionId: string; chatId: string; alarmId: string; moment: Moment; text: string; at: string }

const keyOf = (k: DeliveredKey) => `${k.subscriptionId}|${k.alarmId}|${k.moment}`

export const alertMessage = (args: { address: string; alarm: AlarmLike; moment: Moment; footer?: string }): string => {
  const { alarm, moment } = args
  const consequence = alarmConsequence({
    venue: alarm.venue,
    kind: alarm.kind,
    at: moment === 'fired' ? alarm.firedAt : (alarm.clearedAt as string),
    prev: null,
    next: null,
    provenance: 'alarm',
    severity: alarm.severity,
    evidence: alarm.evidence,
    cleared: moment === 'cleared',
  }).text
  return [
    `${shortAddr(args.address)} holds ${alarm.venue}`,
    consequence,
    `Radar profile: ${radarLink(args.address)}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Which (subscription, alarm, moment) messages to send this run.
 *  - ACTIVE subscriptions only (stoppedAt null) whose address is still watched.
 *  - Alarms on venues the watch holds now (heldVenues), minus unread-depth artefacts.
 *  - 'fired' only for alarms that opened AFTER the subscription began — no
 *    backfill; the /start reply lists what was already open.
 *  - 'cleared' for alarms whose clear lands after the subscription began.
 *  - Never a key already in `delivered` (the idempotency ledger).
 *  - Oldest first; at most MAX_PER_CHAT_PER_RUN per chat. The overflow stays
 *    unsent (no ledger row), so it goes out on the next run.
 */
export const planDeliveries = (args: {
  subscriptions: SubscriptionLike[]
  watchesByAddress: Record<string, WatchLike | undefined>
  alarms: AlarmRow[]
  delivered: DeliveredKey[]
  footerByAddress?: Record<string, string | undefined>
  onOverflow?: (chatId: string, dropped: number) => void
  cap?: number
}): Delivery[] => {
  const cap = args.cap ?? MAX_PER_CHAT_PER_RUN
  const done = new Set(args.delivered.map(keyOf))
  const candidates: Delivery[] = []
  for (const s of args.subscriptions) {
    if (s.stoppedAt) continue
    const watch = args.watchesByAddress[s.address]
    if (!watch) continue
    const since = Date.parse(s.createdAt)
    const holds = new Set(heldVenues(watch))
    for (const a of args.alarms) {
      if (!holds.has(a.venue) || isUnreadDepthAlarm(a)) continue
      const moments: Array<[Moment, string]> = []
      if (Date.parse(a.firedAt) > since) moments.push(['fired', a.firedAt])
      if (a.clearedAt && Date.parse(a.clearedAt) > since) moments.push(['cleared', a.clearedAt])
      for (const [moment, at] of moments) {
        if (done.has(keyOf({ subscriptionId: s.id, alarmId: a.id, moment }))) continue
        candidates.push({
          subscriptionId: s.id,
          chatId: s.chatId,
          alarmId: a.id,
          moment,
          at,
          text: alertMessage({ address: s.address, alarm: a, moment, footer: args.footerByAddress?.[s.address] }),
        })
      }
    }
  }
  candidates.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || (x.moment === y.moment ? 0 : x.moment === 'fired' ? -1 : 1))
  const perChat = new Map<string, number>()
  const out: Delivery[] = []
  const dropped = new Map<string, number>()
  for (const d of candidates) {
    const n = perChat.get(d.chatId) ?? 0
    if (n >= cap) {
      dropped.set(d.chatId, (dropped.get(d.chatId) ?? 0) + 1)
      continue
    }
    perChat.set(d.chatId, n + 1)
    out.push(d)
  }
  for (const [chatId, n] of dropped) args.onOverflow?.(chatId, n)
  return out
}

// --- user threshold alerts ("Alert me at X") ---------------------------------
// A chat linked to an owner's feed (/start th_<token>) gets one message per
// crossed/cleared event recorded after it linked. Sent by
// scripts/lib/telegramBot.mjs sendThresholdAlerts, which ships DARK until
// TELEGRAM_ALERTS_WEBHOOK_SECRET is set.

export type ChatLink = { ownerId: string; chatId: string; createdAt: string }

export type ThresholdEventRow = {
  id: string
  ownerId: string
  thresholdId: string
  kind: 'crossed' | 'cleared'
  value: number
  at: string
  asOf: string
  source: string
  metric: Metric
  subject: string
  direction: Direction
  threshold: number
}

export type ThresholdDelivery = { eventId: string; chatId: string; text: string; at: string }

/** Plain text, no markdown: the event, its source and as-of, how to stop. */
export const thresholdMessage = (e: ThresholdEventRow): string =>
  [eventHeadline(e), provenanceLine(e.source, e.asOf), '/stop to unlink this chat'].join('\n')

/**
 * Which (event, chat) messages to send this run.
 *  - Active links only; an event goes to every chat linked to its owner.
 *  - No backfill: only events recorded AFTER the chat linked.
 *  - Never a pair already in `delivered` (the user_alert_deliveries ledger).
 *  - Oldest first; at most MAX_PER_CHAT_PER_RUN per chat, the rest wait for the next run.
 */
export const planThresholdDeliveries = (args: {
  links: ChatLink[]
  events: ThresholdEventRow[]
  delivered: Array<{ eventId: string; chatId: string }>
  onOverflow?: (chatId: string, dropped: number) => void
  cap?: number
}): ThresholdDelivery[] => {
  const cap = args.cap ?? MAX_PER_CHAT_PER_RUN
  const done = new Set(args.delivered.map((d) => `${d.eventId}|${d.chatId}`))
  const chatsByOwner = new Map<string, ChatLink[]>()
  for (const l of args.links) chatsByOwner.set(l.ownerId, [...(chatsByOwner.get(l.ownerId) ?? []), l])
  const candidates: ThresholdDelivery[] = []
  for (const e of args.events) {
    for (const l of chatsByOwner.get(e.ownerId) ?? []) {
      if (Date.parse(e.at) <= Date.parse(l.createdAt)) continue
      if (done.has(`${e.id}|${l.chatId}`)) continue
      candidates.push({ eventId: e.id, chatId: l.chatId, text: thresholdMessage(e), at: e.at })
    }
  }
  candidates.sort((x, y) => Date.parse(x.at) - Date.parse(y.at))
  const perChat = new Map<string, number>()
  const dropped = new Map<string, number>()
  const out: ThresholdDelivery[] = []
  for (const d of candidates) {
    const n = perChat.get(d.chatId) ?? 0
    if (n >= cap) {
      dropped.set(d.chatId, (dropped.get(d.chatId) ?? 0) + 1)
      continue
    }
    perChat.set(d.chatId, n + 1)
    out.push(d)
  }
  for (const [chatId, n] of dropped) args.onOverflow?.(chatId, n)
  return out
}
