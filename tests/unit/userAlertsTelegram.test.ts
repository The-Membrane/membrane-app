import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as logic from '@/components/Radar/telegramLogic'
import { parseCommand, planThresholdDeliveries, replyText, thresholdMessage, type ThresholdEventRow } from '@/components/Radar/telegramLogic'
import { hexToBase64url, thresholdDeepLink } from '@/lib/userAlerts/metrics'
import { botConfig, handleUpdate, pollOnce, sendThresholdAlerts } from '@/scripts/lib/telegramBot.mjs'
import { createWebhookHandler } from '@/pages/api/telegram/webhook'

// USER THRESHOLD ALERTS over Telegram: DARK until TELEGRAM_ALERTS_WEBHOOK_SECRET is
// set (owner rule). With it unset nothing is read, nothing is sent, no fetch is made.

let fetchCalls = 0
beforeEach(() => {
  fetchCalls = 0
  vi.stubGlobal('fetch', () => {
    fetchCalls++
    throw new Error('network call in a unit test')
  })
})
afterEach(() => vi.unstubAllGlobals())

const TOKEN = '0123456789abcdef'.repeat(4)
const startText = `/start th_${hexToBase64url(TOKEN)}`

type Call = { q: string; values: unknown[] }
const fakeSql = (route: (q: string, values: unknown[]) => any[]) => {
  const calls: Call[] = []
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    try {
      return Promise.resolve(route(q, values))
    } catch (e) {
      return Promise.reject(e)
    }
  }
  return { sql, calls }
}

const tgStub = (answer: (method: string, body: any) => any) => {
  const sent: Array<{ method: string; body: any }> = []
  const fetchImpl = (async (url: string, init: any) => {
    const method = url.split('/').pop() as string
    const body = JSON.parse(init.body)
    sent.push({ method, body })
    return { status: 200, json: async () => answer(method, body) }
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

const env = (o: Record<string, string | undefined>) => (k: string) => o[k]
const BOT = { TELEGRAM_ALERTS_BOT_TOKEN: 'test-token', TELEGRAM_ALERTS_BOT_USERNAME: 'membrane_alerts_bot' }
const lit = botConfig(env({ ...BOT, TELEGRAM_ALERTS_WEBHOOK_SECRET: 's3cret' }))
const footerFor = async () => 'x'
const silent = () => {}

const event = (o: Partial<ThresholdEventRow> = {}): ThresholdEventRow => ({
  id: 'e1',
  ownerId: 'o1',
  thresholdId: 't1',
  kind: 'crossed',
  value: 2498.1,
  at: '2026-10-14T12:00:00.000Z',
  asOf: '2026-10-14T11:58:00.000Z',
  source: 'Chainlink ETH / USD',
  metric: 'price',
  subject: 'asset:ETH',
  direction: 'below',
  threshold: 2500,
  ...o,
})

describe('the /start th_<token> payload', () => {
  it('parses to the feed token; the link fits Telegram start-param limits', () => {
    expect(parseCommand(startText)).toEqual({ kind: 'link_thresholds', token: TOKEN })
    expect(parseCommand(`/start@membrane_alerts_bot th_${hexToBase64url(TOKEN)}`)).toEqual({ kind: 'link_thresholds', token: TOKEN })
    const payload = thresholdDeepLink('membrane_alerts_bot', TOKEN).split('?start=')[1]
    expect(payload).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(`/start ${payload}`).toBe(startText)
  })
  it('a malformed th_ payload is help', () => {
    expect(parseCommand('/start th_short')).toEqual({ kind: 'help' })
    expect(parseCommand(`/start th_${hexToBase64url(TOKEN)}x`)).toEqual({ kind: 'help' })
    expect(parseCommand(`/start th_${'!'.repeat(43)}`)).toEqual({ kind: 'help' })
  })
})

describe('handleUpdate — threshold links', () => {
  const msg = (text: string) => ({ message: { chat: { id: 7 }, text } })

  it('dark by default (poll mode): a th_ link gets help and touches nothing', async () => {
    const { sql, calls } = fakeSql(() => [])
    const out = await handleUpdate(msg(startText), { sql, logic, footerFor })
    expect(out?.text).toBe(replyText({ kind: 'help' }))
    expect(calls).toHaveLength(0)
  })

  it('pollOnce never enables it', async () => {
    const { sql, calls } = fakeSql((q) => (q.includes('FROM alert_bot_state') ? [{ value: '1' }] : []))
    const { fetchImpl, sent } = tgStub((m) => (m === 'getUpdates' ? { ok: true, result: [{ update_id: 1, ...msg(startText) }] } : { ok: true }))
    await pollOnce({ sql, logic, footerFor, config: botConfig(env(BOT)), fetchImpl, log: silent })
    expect(calls.some((c) => c.q.includes('user_alert'))).toBe(false)
    expect(sent[1].body.text).toBe(replyText({ kind: 'help' }))
  })

  it('enabled: an unknown token is refused without a write', async () => {
    const { sql, calls } = fakeSql(() => [])
    const out = await handleUpdate(msg(startText), { sql, logic, footerFor, thresholds: { enabled: true } })
    expect(out?.text).toBe(replyText({ kind: 'th_unknown' }))
    expect(calls.map((c) => c.q.slice(0, 40))).toEqual(['SELECT id FROM user_alert_owners WHERE f'])
    expect(calls[0].values).toEqual([TOKEN])
  })

  it('enabled: a known token links this chat (re-link restarts the clock) and says how many alerts', async () => {
    const { sql, calls } = fakeSql((q) => {
      if (q.startsWith('SELECT id FROM user_alert_owners')) return [{ id: 'o1' }]
      if (q.includes('FROM user_alert_chat_links')) return [{ n: 3 }]
      if (q.includes('FROM user_alert_thresholds')) return [{ n: 2 }]
      return []
    })
    const out = await handleUpdate(msg(startText), { sql, logic, footerFor, thresholds: { enabled: true } })
    expect(out?.text).toContain('one of your 2 alerts is reached or clears')
    const ins = calls.find((c) => c.q.startsWith('INSERT INTO user_alert_chat_links'))
    expect(ins?.values).toEqual(['o1', '7'])
    expect(ins?.q).toContain('stopped_at = NULL')
    // the reply never lists the thresholds themselves
    expect(out?.text).not.toMatch(/\$|%|above|below/)
  })

  it('enabled: caps links per chat at 25 (other feeds only)', async () => {
    const { sql, calls } = fakeSql((q) => {
      if (q.startsWith('SELECT id FROM user_alert_owners')) return [{ id: 'o1' }]
      if (q.includes('FROM user_alert_chat_links')) return [{ n: 25 }]
      return []
    })
    const out = await handleUpdate(msg(startText), { sql, logic, footerFor, thresholds: { enabled: true } })
    expect(out?.text).toBe('This chat already has 25 alert feeds. /stop to reset.')
    expect(calls.some((c) => c.q.startsWith('INSERT'))).toBe(false)
    expect(calls.find((c) => c.q.includes('FROM user_alert_chat_links'))?.q).toContain('owner_id <>')
  })

  it('/stop also unlinks threshold feeds when enabled, and still works if their table is missing', async () => {
    const { sql } = fakeSql((q) => {
      if (q.startsWith('UPDATE alert_subscriptions')) return [{ id: 1 }]
      if (q.startsWith('UPDATE user_alert_chat_links')) return [{ owner_id: 'o1' }, { owner_id: 'o2' }]
      return []
    })
    const out = await handleUpdate(msg('/stop'), { sql, logic, footerFor, thresholds: { enabled: true } })
    expect(out?.text).toBe('Stopped. This chat no longer gets alerts for 1 address and 2 alert feeds.')
    const broken = fakeSql((q) => {
      if (q.includes('user_alert_chat_links')) throw new Error('relation does not exist')
      return []
    })
    const out2 = await handleUpdate(msg('/stop'), { sql: broken.sql, logic, footerFor, thresholds: { enabled: true } })
    expect(out2?.text).toBe('This chat was not watching any address.')
  })

  it('the webhook (secret set) links through the same handler', async () => {
    const { sql } = fakeSql((q) => {
      if (q.startsWith('SELECT id FROM user_alert_owners')) return [{ id: 'o1' }]
      if (q.includes('count(*)')) return [{ n: 1 }]
      return []
    })
    const { fetchImpl, sent } = tgStub(() => ({ ok: true }))
    const h = createWebhookHandler({ env: env({ ...BOT, TELEGRAM_ALERTS_WEBHOOK_SECRET: 's3cret' }), sql: () => sql, footerFor, fetchImpl })
    const res: any = { status: (c: number) => ((res.code = c), res), json: () => res }
    await h({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's3cret' }, body: { update_id: 1, ...msg(startText) } } as any, res)
    expect(res.code).toBe(200)
    expect(sent[0].body.text).toContain('Linked.')
  })
})

describe('planThresholdDeliveries', () => {
  const link = { ownerId: 'o1', chatId: '100', createdAt: '2026-10-14T00:00:00.000Z' }
  it('no backfill, never twice, every linked chat', () => {
    const out = planThresholdDeliveries({
      links: [link, { ...link, chatId: '200' }, { ownerId: 'o2', chatId: '300', createdAt: link.createdAt }],
      events: [event({ id: 'old', at: '2026-10-13T00:00:00.000Z' }), event({ id: 'new' })],
      delivered: [{ eventId: 'new', chatId: '200' }],
    })
    expect(out.map((d) => [d.eventId, d.chatId])).toEqual([['new', '100']])
    expect(out[0].text).toBe('ETH price reached $2,498.10 (alert: below $2,500.00)\nChainlink ETH / USD · as of 2026-10-14 11:58 UTC\n/stop ends every alert in this chat')
  })
  it('caps per chat per run, oldest first, reporting the overflow', () => {
    const overflow: Array<[string, number]> = []
    const events = Array.from({ length: 23 }, (_, i) => event({ id: `e${i}`, at: new Date(Date.parse('2026-10-14T01:00:00Z') + i * 60_000).toISOString() }))
    const out = planThresholdDeliveries({ links: [link], events: [...events].reverse(), delivered: [], onOverflow: (c, n) => overflow.push([c, n]) })
    expect(out).toHaveLength(20)
    expect(out[0].eventId).toBe('e0')
    expect(overflow).toEqual([['100', 3]])
  })
  it('message text is plain, names the source and as-of', () => {
    const t = thresholdMessage(event({ kind: 'cleared', value: 2513 }))
    expect(t).toContain('ETH price back to $2,513.00')
    expect(t).not.toMatch(/[*_`[]/)
  })
})

describe('sendThresholdAlerts', () => {
  it('ships DARK without the webhook secret: one log line, no queries, no fetch', async () => {
    for (const config of [botConfig(env(BOT)), botConfig(env({})), botConfig(env({ TELEGRAM_ALERTS_WEBHOOK_SECRET: 's3cret' }))]) {
      const { sql, calls } = fakeSql(() => [])
      const lines: string[] = []
      const evaluate = vi.fn()
      const r = await sendThresholdAlerts(sql, { logic, config, evaluate, log: (l: string) => lines.push(l) })
      expect(r).toEqual({ sent: 0, failed: 0 })
      expect(lines).toHaveLength(1)
      expect(calls).toHaveLength(0)
      expect(evaluate).not.toHaveBeenCalled()
    }
    expect(fetchCalls).toBe(0)
  })

  // Threshold rows, for the delivery query's rule: an event goes out while its row is
  // active, or while the row's EDIT CHAIN (same owner, metric, subject, created_at —
  // an edit keeps created_at) still has an active row.
  type Row = { id: string; ownerId: string; metric: string; subject: string; createdAt: string; stoppedAt: string | null }
  const world = (opts: { sendOk?: boolean; events?: ThresholdEventRow[]; rows?: Row[] } = {}) => {
    const ledger = new Set<string>()
    const stopped: string[] = []
    const f = fakeSql((q, v) => {
      if (q.startsWith('SELECT owner_id AS "ownerId", chat_id')) return [{ ownerId: 'o1', chatId: '100', createdAt: '2026-10-14T00:00:00.000Z' }]
      if (q.startsWith('SELECT e.id')) {
        const evs = opts.events ?? [event()]
        // the query's own text carries the rule this fake applies
        expect(q).toContain('AND (t.stopped_at IS NULL OR EXISTS (')
        expect(q).toContain('h.owner_id = t.owner_id AND h.metric = t.metric AND h.subject = t.subject')
        expect(q).toContain('AND h.created_at = t.created_at AND h.stopped_at IS NULL))')
        const rows = opts.rows
        if (!rows) return evs
        const chainLive = (t: Row) =>
          !t.stoppedAt || rows.some((h) => h.ownerId === t.ownerId && h.metric === t.metric && h.subject === t.subject && h.createdAt === t.createdAt && !h.stoppedAt)
        return evs.filter((e) => {
          const t = rows.find((r) => r.id === e.thresholdId)
          return !!t && chainLive(t)
        })
      }
      if (q.startsWith('SELECT event_id')) return [...ledger].map((k) => ({ eventId: k.split('|')[0], chatId: k.split('|')[1] }))
      if (q.startsWith('INSERT INTO user_alert_deliveries')) {
        const k = v.join('|')
        if (ledger.has(k)) return []
        ledger.add(k)
        return [{ event_id: v[0] }]
      }
      if (q.startsWith('DELETE FROM user_alert_deliveries')) {
        ledger.delete(v.join('|'))
        return []
      }
      if (q.startsWith('UPDATE user_alert_chat_links SET stopped_at')) {
        stopped.push(String(v[0]))
        return []
      }
      return []
    })
    return { ...f, ledger, stopped }
  }

  it('lit: checks the linked owners, then claims and sends each new event once', async () => {
    const w = world()
    const evaluate = vi.fn(async () => ({ ok: 1, failed: 0 }))
    const { fetchImpl, sent } = tgStub(() => ({ ok: true, result: {} }))
    expect(await sendThresholdAlerts(w.sql, { logic, config: lit, evaluate, fetchImpl, log: silent })).toEqual({ sent: 1, failed: 0 })
    expect(evaluate).toHaveBeenCalledWith(['o1'])
    expect(sent[0].body.chat_id).toBe('100')
    expect(sent[0].body.text).toContain('ETH price reached $2,498.10')
    expect([...w.ledger]).toEqual(['e1|100'])
    // a second run sends nothing
    expect(await sendThresholdAlerts(w.sql, { logic, config: lit, evaluate, fetchImpl, log: silent })).toEqual({ sent: 0, failed: 0 })
    expect(sent).toHaveLength(1)
  })

  it('a failed send releases its claim; an unreachable chat has its links stopped', async () => {
    const w = world()
    const { fetchImpl } = tgStub(() => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }))
    expect(await sendThresholdAlerts(w.sql, { logic, config: lit, fetchImpl, log: silent })).toEqual({ sent: 0, failed: 1 })
    expect(w.ledger.size).toBe(0)
    expect(w.stopped).toEqual(['100'])
  })

  it('a group that became a supergroup: links AND the delivery ledger move, so nothing is re-sent', async () => {
    const w = world()
    const { fetchImpl } = tgStub(() => ({ ok: false, error_code: 400, description: 'group upgraded', parameters: { migrate_to_chat_id: -100999 } }))
    await sendThresholdAlerts(w.sql, { logic, config: lit, fetchImpl, log: silent })
    const moved = w.calls.find((c) => c.q.startsWith('UPDATE user_alert_deliveries x SET chat_id'))
    expect(moved?.values.slice(0, 2)).toEqual(['-100999', '100'])
    expect(moved?.q).toContain('NOT EXISTS')
    expect(w.calls.some((c) => c.q.startsWith('UPDATE user_alert_chat_links l SET chat_id'))).toBe(true)
    expect(w.ledger.size).toBe(0) // this event's claim released: it goes to the new id next run
  })

  it('a crossing on the old line just before an EDIT is still sent; after Stop it is not', async () => {
    const created = '2026-10-14T10:00:00.000Z'
    const base = { ownerId: 'o1', metric: 'price', subject: 'asset:ETH', createdAt: created }
    const old: Row = { ...base, id: 't1', stoppedAt: '2026-10-14T12:01:00.000Z' } // replaced by the edit
    const crossedOnOld = event({ id: 'e1', thresholdId: 't1' })
    // the edit's replacement (same created_at) is active: the old line's event goes out
    const edited = world({ events: [crossedOnOld], rows: [old, { ...base, id: 't2', stoppedAt: null }] })
    const a = tgStub(() => ({ ok: true, result: {} }))
    expect(await sendThresholdAlerts(edited.sql, { logic, config: lit, fetchImpl: a.fetchImpl, log: silent })).toEqual({ sent: 1, failed: 0 })
    expect(a.sent[0].body.text).toContain('ETH price reached $2,498.10')
    // the whole chain stopped (Stop on the replacement): nothing is sent
    const stoppedChain = world({ events: [crossedOnOld], rows: [old, { ...base, id: 't2', stoppedAt: '2026-10-14T12:30:00.000Z' }] })
    const b = tgStub(() => ({ ok: true, result: {} }))
    expect(await sendThresholdAlerts(stoppedChain.sql, { logic, config: lit, fetchImpl: b.fetchImpl, log: silent })).toEqual({ sent: 0, failed: 0 })
    // a row stopped by Stop is not revived by ANOTHER alert on the same subject (a different created_at)
    const other = world({ events: [crossedOnOld], rows: [old, { ...base, id: 't3', createdAt: '2026-10-14T11:00:00.000Z', stoppedAt: null }] })
    const c = tgStub(() => ({ ok: true, result: {} }))
    expect(await sendThresholdAlerts(other.sql, { logic, config: lit, fetchImpl: c.fetchImpl, log: silent })).toEqual({ sent: 0, failed: 0 })
    expect(c.sent).toHaveLength(0)
  })

  it('/stop says exactly what it ends (addresses too)', () => {
    expect(replyText({ kind: 'th_linked', active: 1 })).toContain('/stop ends every alert in this chat (feeds and Radar addresses)')
  })

  it('log lines carry counts only — never a threshold, value or owner', async () => {
    const w = world()
    const lines: string[] = []
    const { fetchImpl } = tgStub(() => ({ ok: true }))
    await sendThresholdAlerts(w.sql, { logic, config: lit, evaluate: async () => ({ ok: 1, failed: 0 }), fetchImpl, log: (l: string) => lines.push(l) })
    expect(lines.join('\n')).not.toMatch(/2,?49|2,?500|ETH|o1|100/)
  })
})
