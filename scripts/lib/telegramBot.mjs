// telegramBot.mjs — I/O half of the TELEGRAM ADDRESS-ALERT BOT (MOAT step 7).
//
// Shared by three callers, one handler:
//   pages/api/telegram/webhook.ts   — production inbound (Telegram POSTs updates)
//   scripts/telegram-poll.mjs       — local/dev inbound (getUpdates long-poll)
//   scripts/check-venue-alarms.mjs  — drains /start commands (poll mode only) and
//                                     sends alarm messages at the end of each tick
//
// The pure logic (parse, wording, delivery plan) lives in
// components/Radar/telegramLogic.ts and is INJECTED as `logic`: Next imports it
// directly, the node scripts load it through tsx's CJS require (see
// scripts/telegram-poll.mjs). This
// file has no top-level I/O and imports nothing TypeScript, so both runtimes can
// load it. `sql` is a neon tagged-template function (rows array back).
//
// SEPARATE BOT from the operator's TELEGRAM_BOT_TOKEN (scripts/lib/notify.mjs).
// Env: TELEGRAM_ALERTS_BOT_TOKEN, TELEGRAM_ALERTS_BOT_USERNAME, and in webhook
// mode TELEGRAM_ALERTS_WEBHOOK_SECRET. Either of the first two unset ⇒ dark.
// The token is only ever placed in the request URL; it is never logged.

import { coverageFor, uncoveredFooter } from './alarmRules.mjs'
import { createHash } from 'node:crypto'

const API = 'https://api.telegram.org'
export const MAX_SUBSCRIPTIONS_PER_CHAT = 25

/** Bot config from an env getter (`get(key)`); `enabled` false ⇒ ship dark. */
export function botConfig(get) {
  const token = get('TELEGRAM_ALERTS_BOT_TOKEN') || ''
  const username = (get('TELEGRAM_ALERTS_BOT_USERNAME') || '').replace(/^@/, '')
  const webhookSecret = get('TELEGRAM_ALERTS_WEBHOOK_SECRET') || ''
  return { token, username, webhookSecret, enabled: !!token && !!username }
}

/**
 * Call one Bot API method. Returns the parsed body ({ ok, result } | { ok:false,
 * error_code, description }); network failures come back as ok:false. Errors
 * name the method only — never the URL, which carries the token.
 */
export async function tg(token, method, body, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))
    return json && typeof json === 'object' ? json : { ok: false, description: 'bad response' }
  } catch (e) {
    return { ok: false, description: `network: ${e?.name ?? 'error'}` }
  }
}

export const sendMessage = (token, chatId, text, fetchImpl) =>
  tg(
    token,
    'sendMessage',
    { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
    fetchImpl,
  )

const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString())

const toWatch = (r) => ({
  createdAt: iso(r.createdAt),
  entryPositions: Array.isArray(r.entryPositions) ? r.entryPositions : null,
  lastScanned: r.lastScanned ?? null,
})

const toAlarm = (r) => ({
  id: String(r.id),
  venue: r.venue,
  kind: r.kind,
  severity: r.severity,
  evidence: r.evidence ?? null,
  firedAt: iso(r.firedAt),
  clearedAt: iso(r.clearedAt),
})

/**
 * Blind-spot data for node scripts, from the ONE coverage source
 * (alarmRules coverageFor) — same inputs as pages/api/_lib/uncovered.ts.
 * Returns a loader that does ONE venue_snapshots read and yields
 * { venue: uncovered[] } for every enabled venue; derive per-address footers from
 * it with footerFrom(). `venues` = recorder config entries.
 */
export function scriptCoverage(sql, venues) {
  return async () => {
    const rows = await sql`
      SELECT DISTINCT ON (venue) venue, instant_usd FROM venue_snapshots
      WHERE source = 'observed' ORDER BY venue, observed_at DESC`
    const hasInstant = new Map(
      rows.map((r) => [r.venue, r.instant_usd !== null && r.instant_usd !== undefined]),
    )
    const byVenue = {}
    for (const v of venues.filter((c) => c.enabled)) {
      byVenue[v.name] = coverageFor(v, { hasInstant: hasInstant.get(v.name) ?? false })
    }
    return byVenue
  }
}

/** One address's footer from a run-wide coverage map (no I/O). */
export function footerFrom(byVenue, held) {
  if (!held.length) return 'no held venues: nothing to watch'
  const pick = {}
  for (const v of held) if (byVenue[v]) pick[v] = byVenue[v]
  return uncoveredFooter(pick)
}

/** Single-shot footer (one read) — for the /start reply. */
export function scriptFooterFor(sql, venues) {
  const load = scriptCoverage(sql, venues)
  return async (held) => (held.length ? footerFrom(await load(), held) : footerFrom({}, held))
}

/**
 * Apply one chat command. Returns { chatId, text } to send, or null when the
 * update carries no new text message (edited_message is ignored). DB writes
 * happen here; sending is the caller's.
 * deps: { sql, logic, footerFor(held) => Promise<string> }
 */
export async function handleUpdate(update, { sql, logic, footerFor }) {
  // Only new messages: an edited '/start' or '/stop' is never re-applied.
  const msg = update?.message
  const chatId = msg?.chat?.id
  if (chatId === undefined || chatId === null || typeof msg?.text !== 'string') return null
  const chat = String(chatId)
  // A signed wallet preference issues this short-lived opaque link token. It
  // is separate from `/start <address>`, which is only a public Radar watch.
  const alertLink = /^\/start(?:@[a-z0-9_]+)?\s+(a_[A-Za-z0-9_-]{43})$/i.exec(msg.text.trim())
  if (alertLink) {
    if (msg.chat.type !== 'private') {
      return { chatId: chat, text: 'Personal alert links can only be confirmed in a private chat.' }
    }
    const hash = createHash('sha256').update(alertLink[1]).digest('hex')
    // The DB function serializes confirmation and /stop on this chat before
    // taking fresh row snapshots; two separate HTTP SQL statements cannot.
    const bound = await sql`
      SELECT address FROM confirm_user_alert_telegram_link(${hash}, ${chat})`
    if (bound.length !== 1) {
      return {
        chatId: chat,
        text: 'This alert link expired, was used, or its preference changed. Request a fresh link in Membrane.',
      }
    }
    return {
      chatId: chat,
      text: 'Telegram chat confirmed for your signed Membrane alert preference. Personal event alerts are not active until verified onchain sources and delivery are available. /stop disconnects this chat.',
    }
  }
  const cmd = logic.parseCommand(msg.text)

  if (cmd.kind === 'subscribe') {
    const [w] = await sql`
      SELECT created_at AS "createdAt", entry_positions AS "entryPositions", last_scanned AS "lastScanned"
      FROM strat_watches WHERE address = ${cmd.address} LIMIT 1`
    if (!w)
      return { chatId: chat, text: logic.replyText({ kind: 'not_watched', address: cmd.address }) }
    // Cap ACTIVE subscriptions per chat (a re-/start of an address already
    // watched does not count against it).
    const [cnt] = await sql`
      SELECT count(*)::int AS n FROM alert_subscriptions
      WHERE chat_id = ${chat} AND stopped_at IS NULL AND address <> ${cmd.address}`
    if (Number(cnt?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_CHAT) {
      return {
        chatId: chat,
        text: logic.replyText({ kind: 'full', max: MAX_SUBSCRIPTIONS_PER_CHAT }),
      }
    }
    // Re-subscribing after /stop restarts the clock: no backfill of the stopped gap.
    await sql`
      INSERT INTO alert_subscriptions (chat_id, address) VALUES (${chat}, ${cmd.address})
      ON CONFLICT (chat_id, address) DO UPDATE SET
        created_at = CASE WHEN alert_subscriptions.stopped_at IS NULL THEN alert_subscriptions.created_at ELSE now() END,
        stopped_at = NULL`
    const watch = toWatch(w)
    const alarmRows = await sql`
      SELECT id, venue, kind, severity, evidence, fired_at AS "firedAt", cleared_at AS "clearedAt"
      FROM venue_alarms WHERE cleared_at IS NULL`
    const { held, openTexts } = logic.openAlertTexts(watch, alarmRows.map(toAlarm))
    const footer = await footerFor(held)
    return {
      chatId: chat,
      text: logic.replyText({ kind: 'subscribed', address: cmd.address, held, openTexts, footer }),
    }
  }

  if (cmd.kind === 'stop') {
    // The new personal-intent tables may not have been migrated yet. A missing
    // function must never prevent /stop from revoking the existing venue watch.
    let personalCount = 0
    let personalDisconnectUnconfirmed = false
    let personalDisconnectFailed = false
    try {
      const [personal] = await sql`
        SELECT disconnect_user_alert_telegram_chat(${chat}) AS count`
      personalCount = Number(personal?.count ?? 0)
    } catch (error) {
      personalDisconnectUnconfirmed = true
      // 42883 means this optional migration has not installed the function.
      // Any other failure might leave a live personal binding: retry /stop.
      personalDisconnectFailed = error?.code !== '42883'
    }
    const rows = await sql`
      UPDATE alert_subscriptions SET stopped_at = now()
      WHERE chat_id = ${chat} AND stopped_at IS NULL RETURNING id`
    // The legacy stop has now been attempted even when personal storage failed.
    // A retry is safe: both disconnect operations are idempotent.
    if (personalDisconnectFailed) throw new Error('personal alert disconnect unconfirmed')
    return {
      chatId: chat,
      text: `${logic.replyText({ kind: 'stopped', count: rows.length })}${personalCount > 0 ? ' Personal alert chat disconnected.' : ''}${personalDisconnectUnconfirmed ? ' Personal alert disconnect could not be confirmed; retry /stop.' : ''}`,
    }
  }

  if (cmd.kind === 'list') {
    const rows = await sql`
      SELECT address FROM alert_subscriptions
      WHERE chat_id = ${chat} AND stopped_at IS NULL ORDER BY created_at ASC`
    return {
      chatId: chat,
      text: logic.replyText({ kind: 'list', addresses: rows.map((r) => r.address) }),
    }
  }

  return { chatId: chat, text: logic.replyText({ kind: 'help' }) }
}

/**
 * Local/dev inbound: drain pending updates with getUpdates, handle each, reply,
 * and persist the offset in alert_bot_state before each reply. A failed handler
 * or offset write stops the batch without advancing past that update. Telegram
 * refuses getUpdates while a webhook is
 * set, so callers skip this when TELEGRAM_ALERTS_WEBHOOK_SECRET is configured.
 * deps: { sql, logic, footerFor, config, fetchImpl?, timeoutSec?, log? }
 */
export async function pollOnce({
  sql,
  logic,
  footerFor,
  config,
  fetchImpl = fetch,
  timeoutSec = 0,
  log = console.log,
}) {
  if (!config.enabled) {
    log(
      'telegram alerts: bot not configured (TELEGRAM_ALERTS_BOT_TOKEN/USERNAME unset) — poll skipped',
    )
    return { handled: 0, ok: false }
  }
  const [state] = await sql`SELECT value FROM alert_bot_state WHERE key = 'poll_offset'`
  const offset = state ? Number(state.value) : 0
  const res = await tg(
    config.token,
    'getUpdates',
    { offset, timeout: timeoutSec, allowed_updates: ['message'] },
    fetchImpl,
  )
  if (!res.ok) {
    log(`telegram alerts: getUpdates failed — ${res.description ?? res.error_code ?? 'unknown'}`)
    return { handled: 0, ok: false }
  }
  let handled = 0
  for (const update of res.result ?? []) {
    let out
    try {
      out = await handleUpdate(update, { sql, logic, footerFor })
    } catch {
      log('telegram alerts: update handling failed; offset unchanged')
      return { handled, ok: false }
    }
    const nextOffset = Number(update.update_id) + 1
    // GREATEST prevents an overlapping poller from moving the offset backwards.
    // Do not reply until this is durable, or an offset failure could duplicate
    // the reply on the next poll.
    try {
      await sql`
        INSERT INTO alert_bot_state (key, value) VALUES ('poll_offset', ${String(nextOffset)})
        ON CONFLICT (key) DO UPDATE SET
          value = GREATEST(alert_bot_state.value::bigint, EXCLUDED.value::bigint)::text`
    } catch {
      log('telegram alerts: offset write failed; later updates deferred')
      return { handled, ok: false }
    }
    if (out) {
      const sent = await sendMessage(config.token, out.chatId, out.text, fetchImpl)
      if (!sent.ok) log(`telegram alerts: reply failed — ${sent.description ?? sent.error_code}`)
      handled++
    }
  }
  return { handled, ok: true }
}

// Telegram answers these when a chat can never receive again (user blocked the
// bot, chat deleted): stop that chat's subscriptions rather than retry forever.
const isGone = (r) =>
  r.error_code === 403 || (r.error_code === 400 && /chat not found/i.test(r.description ?? ''))

// A group upgraded to a supergroup answers 400 with parameters.migrate_to_chat_id.
const migratedTo = (r) =>
  r.error_code === 400 &&
  r.parameters?.migrate_to_chat_id !== undefined &&
  r.parameters?.migrate_to_chat_id !== null
    ? String(r.parameters.migrate_to_chat_id)
    : null

/**
 * Move a chat's subscriptions to its new (supergroup) id. A row whose address the
 * new chat already watches cannot move (unique (chat_id, address)); it is stopped.
 * Returns the ids of the stopped rows.
 */
async function migrateChat(sql, oldId, newId) {
  await sql`
    UPDATE alert_subscriptions s SET chat_id = ${newId}
    WHERE s.chat_id = ${oldId}
      AND NOT EXISTS (SELECT 1 FROM alert_subscriptions t WHERE t.chat_id = ${newId} AND t.address = s.address)`
  const stopped = await sql`
    UPDATE alert_subscriptions SET stopped_at = now()
    WHERE chat_id = ${oldId} AND stopped_at IS NULL RETURNING id`
  return new Set(stopped.map((r) => String(r.id)))
}

/**
 * Outbound: plan and send one message per new (subscription, alarm, moment).
 * CLAIM BEFORE SEND: each delivery first inserts its ledger row (ON CONFLICT DO
 * NOTHING RETURNING); only the run that gets the row back sends, so two
 * overlapping runs send at most once. A failed send DELETEs the claim so the next
 * run retries it, and skips that chat for the rest of this run.
 * deps: { logic, coverage: () => Promise<byVenue>, config, fetchImpl?, log? }
 */
export async function sendAddressAlerts(
  sql,
  { logic, coverage, config, fetchImpl = fetch, log = console.log },
) {
  if (!config.enabled) {
    log(
      'telegram alerts: bot not configured (TELEGRAM_ALERTS_BOT_TOKEN/USERNAME unset) — nothing sent',
    )
    return { sent: 0, failed: 0 }
  }
  const subRows = await sql`
    SELECT id, chat_id AS "chatId", address, created_at AS "createdAt", stopped_at AS "stoppedAt"
    FROM alert_subscriptions WHERE stopped_at IS NULL`
  if (subRows.length === 0) {
    log('telegram alerts: no active subscriptions')
    return { sent: 0, failed: 0 }
  }
  const subscriptions = subRows.map((r) => ({
    id: String(r.id),
    chatId: String(r.chatId),
    address: r.address,
    createdAt: iso(r.createdAt),
    stoppedAt: iso(r.stoppedAt),
  }))
  const addresses = [...new Set(subscriptions.map((s) => s.address))]
  const watchRows = await sql`
    SELECT address, created_at AS "createdAt", entry_positions AS "entryPositions", last_scanned AS "lastScanned"
    FROM strat_watches WHERE address = ANY(${addresses})`
  const watchesByAddress = Object.fromEntries(watchRows.map((r) => [r.address, toWatch(r)]))
  const alarmRows = await sql`
    SELECT id, venue, kind, severity, evidence, fired_at AS "firedAt", cleared_at AS "clearedAt"
    FROM venue_alarms
    WHERE fired_at > now() - interval '7 days' OR cleared_at > now() - interval '7 days'`
  const alarms = alarmRows.map(toAlarm)
  if (alarms.length === 0) {
    log('telegram alerts: no alarm opened or cleared in 7 days')
    return { sent: 0, failed: 0 }
  }
  // Ledger keyed by the alarms in play (not by time): an old fired row still
  // blocks a re-send when that alarm's clear lands inside the window.
  const deliveredRows = await sql`
    SELECT subscription_id AS "subscriptionId", alarm_id AS "alarmId", moment FROM alert_deliveries
    WHERE subscription_id = ANY(${subscriptions.map((s) => s.id)}) AND alarm_id = ANY(${alarms.map((a) => a.id)})`
  const delivered = deliveredRows.map((r) => ({
    subscriptionId: String(r.subscriptionId),
    alarmId: String(r.alarmId),
    moment: r.moment,
  }))
  // ONE coverage read per run; every address's footer derives from it.
  const byVenue = await coverage()
  const footerByAddress = {}
  for (const a of addresses) {
    const w = watchesByAddress[a]
    if (w) footerByAddress[a] = footerFrom(byVenue, logic.heldVenues(w))
  }
  const plan = logic.planDeliveries({
    subscriptions,
    watchesByAddress,
    alarms,
    delivered,
    footerByAddress,
    onOverflow: (chatId, n) =>
      log(`telegram alerts: chat cap reached — ${n} message(s) deferred to next run`),
  })

  let sent = 0
  let failed = 0
  const skip = new Set() // chats skipped for the rest of this run
  const migrated = new Map() // old chat id -> new chat id
  const stoppedSubs = new Set()
  const release = async (d) => {
    try {
      await sql`
        DELETE FROM alert_deliveries
        WHERE subscription_id = ${d.subscriptionId} AND alarm_id = ${d.alarmId} AND moment = ${d.moment}`
    } catch (e) {
      log(`telegram alerts: claim release failed — ${e?.message ?? e}`)
    }
  }
  for (const d of plan) {
    const chatId = migrated.get(d.chatId) ?? d.chatId
    if (skip.has(chatId) || stoppedSubs.has(d.subscriptionId)) continue
    let claimed
    try {
      claimed = await sql`
        INSERT INTO alert_deliveries (subscription_id, alarm_id, moment)
        VALUES (${d.subscriptionId}, ${d.alarmId}, ${d.moment})
        ON CONFLICT DO NOTHING RETURNING subscription_id`
    } catch (e) {
      log(`telegram alerts: claim failed (${d.moment}) — ${e?.message ?? e}`)
      continue
    }
    if (!claimed || claimed.length === 0) continue // another run owns it
    let r = await sendMessage(config.token, chatId, d.text, fetchImpl)
    const to = r.ok ? null : migratedTo(r)
    if (to) {
      try {
        const stopped = await migrateChat(sql, chatId, to)
        for (const id of stopped) stoppedSubs.add(id)
        migrated.set(d.chatId, to)
        log('telegram alerts: chat migrated to a supergroup — subscriptions moved')
        if (!stoppedSubs.has(d.subscriptionId))
          r = await sendMessage(config.token, to, d.text, fetchImpl)
      } catch (e) {
        log(`telegram alerts: chat migration failed — ${e?.message ?? e}`)
      }
      if (stoppedSubs.has(d.subscriptionId)) {
        // Its row could not move (the new chat already watches that address); the
        // new chat's own subscription carries the alert. Not a chat failure.
        await release(d)
        continue
      }
    }
    if (r.ok) {
      sent++
      continue
    }
    failed++
    await release(d)
    const failedChat = migrated.get(d.chatId) ?? chatId
    skip.add(failedChat)
    log(
      `telegram alerts: send failed (${d.moment}) — ${r.description ?? r.error_code ?? 'unknown'}; chat skipped this run`,
    )
    if (isGone(r)) {
      try {
        await sql`UPDATE alert_subscriptions SET stopped_at = now() WHERE chat_id = ${failedChat} AND stopped_at IS NULL`
        log('telegram alerts: chat unreachable — its subscriptions stopped')
      } catch (e) {
        log(`telegram alerts: stop failed — ${e?.message ?? e}`)
      }
    }
  }
  log(`telegram alerts: planned ${plan.length}, sent ${sent}, failed ${failed}`)
  return { sent, failed }
}
