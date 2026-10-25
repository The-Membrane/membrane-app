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
  tg(token, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }, fetchImpl)

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
    const hasInstant = new Map(rows.map((r) => [r.venue, r.instant_usd !== null && r.instant_usd !== undefined]))
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

// Threshold-link reads on /stop and /list must never break the address replies
// (e.g. before scripts/apply-alert-thresholds-ddl.mjs has run): failures count 0.
async function stopChatLinks(sql, chat) {
  try {
    const rows = await sql`
      UPDATE user_alert_chat_links SET stopped_at = now()
      WHERE chat_id = ${chat} AND stopped_at IS NULL RETURNING owner_id`
    return rows.length
  } catch {
    return 0
  }
}

async function countChatLinks(sql, chat) {
  try {
    const [r] = await sql`
      SELECT count(*)::int AS n FROM user_alert_chat_links WHERE chat_id = ${chat} AND stopped_at IS NULL`
    return Number(r?.n ?? 0)
  } catch {
    return 0
  }
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
 * deps: { sql, logic, footerFor(held) => Promise<string>, thresholds? }
 *
 * `thresholds.enabled` turns on the USER THRESHOLD ALERT commands (/start th_<token>
 * links this chat to that alert feed; /stop and /list include those links). Only
 * the webhook passes it — the webhook runs only once TELEGRAM_ALERTS_WEBHOOK_SECRET
 * is set, which is the owner's switch. Poll mode (secret unset) leaves it off, so
 * a th_ link there gets the plain help reply.
 */
export async function handleUpdate(update, { sql, logic, footerFor, thresholds = { enabled: false } }) {
  const thresholdsOn = thresholds.enabled === true
  // Only new messages: an edited '/start' or '/stop' is never re-applied.
  const msg = update?.message
  const chatId = msg?.chat?.id
  if (chatId === undefined || chatId === null || typeof msg?.text !== 'string') return null
  const chat = String(chatId)
  const cmd = logic.parseCommand(msg.text)

  if (cmd.kind === 'subscribe') {
    const [w] = await sql`
      SELECT created_at AS "createdAt", entry_positions AS "entryPositions", last_scanned AS "lastScanned"
      FROM strat_watches WHERE address = ${cmd.address} LIMIT 1`
    if (!w) return { chatId: chat, text: logic.replyText({ kind: 'not_watched', address: cmd.address }) }
    // Cap ACTIVE subscriptions per chat (a re-/start of an address already
    // watched does not count against it).
    const [cnt] = await sql`
      SELECT count(*)::int AS n FROM alert_subscriptions
      WHERE chat_id = ${chat} AND stopped_at IS NULL AND address <> ${cmd.address}`
    if (Number(cnt?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_CHAT) {
      return { chatId: chat, text: logic.replyText({ kind: 'full', max: MAX_SUBSCRIPTIONS_PER_CHAT }) }
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
    return { chatId: chat, text: logic.replyText({ kind: 'subscribed', address: cmd.address, held, openTexts, footer }) }
  }

  if (cmd.kind === 'link_thresholds') {
    if (!thresholdsOn) return { chatId: chat, text: logic.replyText({ kind: 'help' }) }
    const [owner] = await sql`SELECT id FROM user_alert_owners WHERE feed_token = ${cmd.token} LIMIT 1`
    if (!owner) return { chatId: chat, text: logic.replyText({ kind: 'th_unknown' }) }
    const ownerId = String(owner.id)
    // Same cap as address subscriptions; re-linking a feed already linked is never blocked.
    const [cnt] = await sql`
      SELECT count(*)::int AS n FROM user_alert_chat_links
      WHERE chat_id = ${chat} AND stopped_at IS NULL AND owner_id <> ${ownerId}::uuid`
    if (Number(cnt?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_CHAT) {
      return { chatId: chat, text: logic.replyText({ kind: 'th_full', max: MAX_SUBSCRIPTIONS_PER_CHAT }) }
    }
    // Re-linking after /stop restarts the clock: no backfill of the stopped gap.
    await sql`
      INSERT INTO user_alert_chat_links (owner_id, chat_id) VALUES (${ownerId}::uuid, ${chat})
      ON CONFLICT (owner_id, chat_id) DO UPDATE SET
        created_at = CASE WHEN user_alert_chat_links.stopped_at IS NULL THEN user_alert_chat_links.created_at ELSE now() END,
        stopped_at = NULL`
    const [act] = await sql`
      SELECT count(*)::int AS n FROM user_alert_thresholds
      WHERE owner_id = ${ownerId}::uuid AND stopped_at IS NULL`
    return { chatId: chat, text: logic.replyText({ kind: 'th_linked', active: Number(act?.n ?? 0) }) }
  }

  if (cmd.kind === 'stop') {
    const rows = await sql`
      UPDATE alert_subscriptions SET stopped_at = now()
      WHERE chat_id = ${chat} AND stopped_at IS NULL RETURNING id`
    const feeds = thresholdsOn ? await stopChatLinks(sql, chat) : 0
    return { chatId: chat, text: logic.replyText({ kind: 'stopped', count: rows.length, feeds }) }
  }

  if (cmd.kind === 'list') {
    const rows = await sql`
      SELECT address FROM alert_subscriptions
      WHERE chat_id = ${chat} AND stopped_at IS NULL ORDER BY created_at ASC`
    const feeds = thresholdsOn ? await countChatLinks(sql, chat) : 0
    return { chatId: chat, text: logic.replyText({ kind: 'list', addresses: rows.map((r) => r.address), feeds }) }
  }

  return { chatId: chat, text: logic.replyText({ kind: 'help' }) }
}

/**
 * Local/dev inbound: drain pending updates with getUpdates, handle each, reply,
 * and persist the offset in alert_bot_state after every update (a crash never
 * re-answers a handled command). Telegram refuses getUpdates while a webhook is
 * set, so callers skip this when TELEGRAM_ALERTS_WEBHOOK_SECRET is configured.
 * deps: { sql, logic, footerFor, config, fetchImpl?, timeoutSec?, log? }
 */
export async function pollOnce({ sql, logic, footerFor, config, fetchImpl = fetch, timeoutSec = 0, log = console.log }) {
  if (!config.enabled) {
    log('telegram alerts: bot not configured (TELEGRAM_ALERTS_BOT_TOKEN/USERNAME unset) — poll skipped')
    return { handled: 0, ok: false }
  }
  const [state] = await sql`SELECT value FROM alert_bot_state WHERE key = 'poll_offset'`
  let offset = state ? Number(state.value) : 0
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
    try {
      const out = await handleUpdate(update, { sql, logic, footerFor })
      if (out) {
        const sent = await sendMessage(config.token, out.chatId, out.text, fetchImpl)
        if (!sent.ok) log(`telegram alerts: reply failed — ${sent.description ?? sent.error_code}`)
        handled++
      }
    } catch (e) {
      log(`telegram alerts: update ${update?.update_id} failed — ${e?.message ?? e}`)
    }
    offset = Number(update.update_id) + 1
    // Own try: a failed offset write never throws out of pollOnce. GREATEST so an
    // overlapping poller can never move the offset backwards.
    try {
      await sql`
        INSERT INTO alert_bot_state (key, value) VALUES ('poll_offset', ${String(offset)})
        ON CONFLICT (key) DO UPDATE SET
          value = GREATEST(alert_bot_state.value::bigint, EXCLUDED.value::bigint)::text`
    } catch (e) {
      log(`telegram alerts: offset write failed — ${e?.message ?? e}`)
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
  r.error_code === 400 && r.parameters?.migrate_to_chat_id !== undefined && r.parameters?.migrate_to_chat_id !== null
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
export async function sendAddressAlerts(sql, { logic, coverage, config, fetchImpl = fetch, log = console.log }) {
  if (!config.enabled) {
    log('telegram alerts: bot not configured (TELEGRAM_ALERTS_BOT_TOKEN/USERNAME unset) — nothing sent')
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
    onOverflow: (chatId, n) => log(`telegram alerts: chat cap reached — ${n} message(s) deferred to next run`),
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
        if (!stoppedSubs.has(d.subscriptionId)) r = await sendMessage(config.token, to, d.text, fetchImpl)
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
    log(`telegram alerts: send failed (${d.moment}) — ${r.description ?? r.error_code ?? 'unknown'}; chat skipped this run`)
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

/**
 * Outbound for USER THRESHOLD ALERTS ("Alert me at X"). SHIPS DARK: unless the bot
 * env AND TELEGRAM_ALERTS_WEBHOOK_SECRET are set (the owner's switch), it logs one
 * line and returns before any query or fetch.
 *
 * Otherwise, for chats linked to an alert feed (/start th_<token>):
 *  1. `evaluate(ownerIds)` (injected; lib/userAlerts/service.ts evaluateOwners) checks
 *     those owners' thresholds against current values and records crossed/cleared
 *     events — the same evaluate-on-read the RSS feed runs, so a Telegram-only owner
 *     is not waiting on a feed reader.
 *  2. Each new event goes to each chat linked to its owner: CLAIM BEFORE SEND on
 *     user_alert_deliveries (ON CONFLICT DO NOTHING RETURNING), release on a failed
 *     send, skip that chat for the rest of the run — exactly as sendAddressAlerts.
 * Log lines carry counts only: never a threshold, a value or an owner.
 * @param {any} sql
 * @param {{ logic: any, config: any, evaluate?: ((ownerIds: string[]) => Promise<{ ok: number, failed: number }>) | null, fetchImpl?: typeof fetch, log?: (line: string) => void }} deps
 */
export async function sendThresholdAlerts(sql, { logic, config, evaluate = null, fetchImpl = fetch, log = console.log }) {
  if (!config.enabled || !config.webhookSecret) {
    log('telegram threshold alerts: dark (bot env or TELEGRAM_ALERTS_WEBHOOK_SECRET unset) — nothing sent')
    return { sent: 0, failed: 0 }
  }
  const linkRows = await sql`
    SELECT owner_id AS "ownerId", chat_id AS "chatId", created_at AS "createdAt"
    FROM user_alert_chat_links WHERE stopped_at IS NULL`
  if (linkRows.length === 0) {
    log('telegram threshold alerts: no linked chats')
    return { sent: 0, failed: 0 }
  }
  const links = linkRows.map((r) => ({ ownerId: String(r.ownerId), chatId: String(r.chatId), createdAt: iso(r.createdAt) }))
  const ownerIds = [...new Set(links.map((l) => l.ownerId))]
  if (evaluate) {
    try {
      const r = await evaluate(ownerIds)
      log(`telegram threshold alerts: checked ${r?.ok ?? 0} feed(s)${r?.failed ? `, ${r.failed} failed` : ''}`)
    } catch (e) {
      log(`telegram threshold alerts: check failed (non-fatal) — ${e?.name ?? 'error'}`)
    }
  }
  const eventRows = await sql`
    SELECT e.id, e.threshold_id AS "thresholdId", e.kind, e.value, e.at, e.as_of AS "asOf", e.source,
           t.owner_id AS "ownerId", t.metric, t.subject, t.direction, t.threshold
    FROM user_alert_events e
    JOIN user_alert_thresholds t ON t.id = e.threshold_id
    WHERE t.owner_id = ANY(${ownerIds}) AND t.stopped_at IS NULL AND e.at > now() - interval '7 days'`
  if (eventRows.length === 0) {
    log('telegram threshold alerts: no new events')
    return { sent: 0, failed: 0 }
  }
  const events = eventRows.map((r) => ({
    id: String(r.id),
    ownerId: String(r.ownerId),
    thresholdId: String(r.thresholdId),
    kind: r.kind === 'cleared' ? 'cleared' : 'crossed',
    value: Number(r.value),
    at: iso(r.at),
    asOf: iso(r.asOf),
    source: String(r.source),
    metric: r.metric,
    subject: String(r.subject),
    direction: r.direction,
    threshold: Number(r.threshold),
  }))
  const deliveredRows = await sql`
    SELECT event_id AS "eventId", chat_id AS "chatId" FROM user_alert_deliveries
    WHERE event_id = ANY(${events.map((e) => e.id)})`
  const delivered = deliveredRows.map((r) => ({ eventId: String(r.eventId), chatId: String(r.chatId) }))
  const plan = logic.planThresholdDeliveries({
    links,
    events,
    delivered,
    onOverflow: (_chatId, n) => log(`telegram threshold alerts: chat cap reached — ${n} message(s) deferred to next run`),
  })

  let sent = 0
  let failed = 0
  const skip = new Set()
  const release = async (d) => {
    try {
      await sql`DELETE FROM user_alert_deliveries WHERE event_id = ${d.eventId}::uuid AND chat_id = ${d.chatId}`
    } catch (e) {
      log(`telegram threshold alerts: claim release failed — ${e?.name ?? 'error'}`)
    }
  }
  for (const d of plan) {
    if (skip.has(d.chatId)) continue
    let claimed
    try {
      claimed = await sql`
        INSERT INTO user_alert_deliveries (event_id, chat_id) VALUES (${d.eventId}::uuid, ${d.chatId})
        ON CONFLICT DO NOTHING RETURNING event_id`
    } catch (e) {
      log(`telegram threshold alerts: claim failed — ${e?.name ?? 'error'}`)
      continue
    }
    if (!claimed || claimed.length === 0) continue // another run owns it
    const r = await sendMessage(config.token, d.chatId, d.text, fetchImpl)
    if (r.ok) {
      sent++
      continue
    }
    const to = migratedTo(r)
    if (to) {
      // A group became a supergroup: move its links (a feed the new chat already
      // links is stopped on the old id) AND its delivery ledger — otherwise every
      // event already sent to the old id would be re-sent to the new one — and let
      // the next run deliver this event to the new id.
      await release(d)
      skip.add(d.chatId)
      try {
        await sql`
          UPDATE user_alert_chat_links l SET chat_id = ${to}
          WHERE l.chat_id = ${d.chatId}
            AND NOT EXISTS (SELECT 1 FROM user_alert_chat_links t WHERE t.chat_id = ${to} AND t.owner_id = l.owner_id)`
        await sql`UPDATE user_alert_chat_links SET stopped_at = now() WHERE chat_id = ${d.chatId} AND stopped_at IS NULL`
        await sql`
          UPDATE user_alert_deliveries x SET chat_id = ${to}
          WHERE x.chat_id = ${d.chatId}
            AND NOT EXISTS (SELECT 1 FROM user_alert_deliveries y WHERE y.chat_id = ${to} AND y.event_id = x.event_id)`
        log('telegram threshold alerts: chat migrated to a supergroup — links moved, sends next run')
      } catch (e) {
        log(`telegram threshold alerts: chat migration failed — ${e?.name ?? 'error'}`)
      }
      continue
    }
    failed++
    await release(d)
    skip.add(d.chatId)
    log(`telegram threshold alerts: send failed — ${r.description ?? r.error_code ?? 'unknown'}; chat skipped this run`)
    if (isGone(r)) {
      try {
        await sql`UPDATE user_alert_chat_links SET stopped_at = now() WHERE chat_id = ${d.chatId} AND stopped_at IS NULL`
        log('telegram threshold alerts: chat unreachable — its links stopped')
      } catch (e) {
        log(`telegram threshold alerts: stop failed — ${e?.name ?? 'error'}`)
      }
    }
  }
  log(`telegram threshold alerts: planned ${plan.length}, sent ${sent}, failed ${failed}`)
  return { sent, failed }
}
