import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as logic from '@/components/Radar/telegramLogic'
import {
  deepLink,
  parseCommand,
  planDeliveries,
  replyText,
  type AlarmRow,
  type SubscriptionLike,
} from '@/components/Radar/telegramLogic'
import type { WatchLike } from '@/components/Radar/alertLogic'
import { botConfig, footerFrom, handleUpdate, pollOnce, sendAddressAlerts } from '@/scripts/lib/telegramBot.mjs'
import { createWebhookHandler } from '@/pages/api/telegram/webhook'

const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7' // EIP-55 test vector
const ADDR2 = '0x8617E340B3D01FA5F11F306F4090FD50E238070D' // not watched

// No test may reach the network: any un-stubbed fetch throws.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network call in a unit test')
  })
})
afterEach(() => vi.unstubAllGlobals())

const watch = (venues: string[], createdAt = '2026-09-01T00:00:00Z'): WatchLike => ({
  createdAt,
  entryPositions: null,
  lastScanned: { usdByVenue: Object.fromEntries(venues.map((v) => [v, 5000])) },
})

const alarm = (o: Partial<AlarmRow>): AlarmRow => ({
  id: 'a1',
  venue: 'sUSDe',
  kind: 'headroom_thin',
  severity: 'alarm',
  evidence: { instantUsd: 1_000_000, worstDayOutflowUsd: 900_000, ratio: 1.1 },
  firedAt: '2026-09-20T00:00:00Z',
  clearedAt: null,
  ...o,
})

const sub = (o: Partial<SubscriptionLike> = {}): SubscriptionLike => ({
  id: 's1',
  chatId: '100',
  address: ADDR,
  createdAt: '2026-09-10T00:00:00Z',
  stoppedAt: null,
  ...o,
})

describe('parseCommand', () => {
  it('subscribes on /start <address> and checksums it', () => {
    expect(parseCommand(`/start ${ADDR.toLowerCase()}`)).toEqual({ kind: 'subscribe', address: ADDR })
    expect(parseCommand(`/start@membrane_alerts_bot ${ADDR}`)).toEqual({ kind: 'subscribe', address: ADDR })
  })
  it('bare or invalid /start is help', () => {
    expect(parseCommand('/start')).toEqual({ kind: 'help' })
    expect(parseCommand('/start 0x1234')).toEqual({ kind: 'help' })
    expect(parseCommand('/start hello')).toEqual({ kind: 'help' })
  })
  it('stop, list, anything else', () => {
    expect(parseCommand('/stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('/LIST')).toEqual({ kind: 'list' })
    expect(parseCommand('hi')).toEqual({ kind: 'help' })
    expect(parseCommand(undefined)).toEqual({ kind: 'help' })
  })
  it('the deep-link payload fits Telegram start-param limits', () => {
    const link = deepLink('@membrane_alerts_bot', ADDR.toLowerCase())
    expect(link).toBe(`https://t.me/membrane_alerts_bot?start=${ADDR}`)
    expect(ADDR).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })
})

describe('replyText', () => {
  it('welcome says "Data compiled by Membrane." once, links Radar, carries the footer', () => {
    const t = replyText({ kind: 'subscribed', address: ADDR, held: ['sUSDe'], openTexts: [], footer: 'this alarm cannot yet see: X' })
    expect(t.match(/Data compiled by Membrane/g)).toHaveLength(1)
    expect(t).toContain(`https://membrane.money/ethereum/radar?address=${ADDR}`)
    expect(t).toContain('Radar profile: https://membrane.money/ethereum/radar?address=')
    expect(t).toContain('Right now: no alarm on sUSDe.')
    expect(t).toContain('This chat gets a message when an alarm starts or ends on sUSDe:')
    expect(t).not.toMatch(/Silence|cannot yet see|Open now|Venues:/)
    expect(t).not.toMatch(/[*_`[]/) // plain text, no markdown
  })
  it('not-watched points to Radar', () => {
    expect(replyText({ kind: 'not_watched', address: ADDR })).toBe(
      `Track this address on Radar first: https://membrane.money/ethereum/radar?address=${ADDR}`,
    )
  })
})

describe('planDeliveries', () => {
  const base = { watchesByAddress: { [ADDR]: watch(['sUSDe']) }, delivered: [] }

  it('does not backfill an alarm that opened before subscribing', () => {
    const out = planDeliveries({ ...base, subscriptions: [sub()], alarms: [alarm({ firedAt: '2026-09-05T00:00:00Z' })] })
    expect(out).toEqual([])
  })

  it('sends fired for a new alarm, and only cleared for a pre-existing one that clears later', () => {
    const out = planDeliveries({
      ...base,
      subscriptions: [sub()],
      alarms: [
        alarm({ id: 'new', firedAt: '2026-09-20T00:00:00Z' }),
        alarm({ id: 'old', kind: 'gate_change', evidence: { count: 1 }, firedAt: '2026-09-05T00:00:00Z', clearedAt: '2026-09-21T00:00:00Z' }),
      ],
    })
    expect(out.map((d) => [d.alarmId, d.moment])).toEqual([
      ['new', 'fired'],
      ['old', 'cleared'],
    ])
    expect(out[0].chatId).toBe('100')
    expect(out[0].text).toContain('sUSDe')
    expect(out[1].text).toMatch(/^.*holds sUSDe\nCLEARED/)
  })

  it('is idempotent against the ledger', () => {
    const alarms = [alarm({ id: 'x', clearedAt: '2026-09-21T00:00:00Z' })]
    const first = planDeliveries({ ...base, subscriptions: [sub()], alarms })
    expect(first.map((d) => d.moment)).toEqual(['fired', 'cleared'])
    const again = planDeliveries({
      ...base,
      subscriptions: [sub()],
      alarms,
      delivered: first.map((d) => ({ subscriptionId: d.subscriptionId, alarmId: d.alarmId, moment: d.moment })),
    })
    expect(again).toEqual([])
  })

  it('skips stopped subscriptions, unwatched addresses and venues not held', () => {
    const alarms = [alarm({}), alarm({ id: 'b', venue: 'sUSDS' })]
    expect(planDeliveries({ ...base, subscriptions: [sub({ stoppedAt: '2026-09-15T00:00:00Z' })], alarms })).toEqual([])
    expect(planDeliveries({ ...base, subscriptions: [sub({ address: ADDR2 })], alarms })).toEqual([])
    expect(planDeliveries({ ...base, subscriptions: [sub()], alarms }).map((d) => d.alarmId)).toEqual(['a1'])
  })

  it('excludes unread-depth alarms', () => {
    const unread = alarm({
      id: 'u',
      kind: 'depth_collapse',
      evidence: { toValue: 0, toDate: '2026-09-24T00:00:00Z', dropPct: 100 },
      firedAt: '2026-09-24T01:00:00Z',
    })
    expect(planDeliveries({ ...base, subscriptions: [sub()], alarms: [unread] })).toEqual([])
  })

  it('caps 20 per chat per run, oldest first, and reports the overflow', () => {
    const alarms = Array.from({ length: 25 }, (_, i) =>
      alarm({ id: `a${i}`, firedAt: new Date(Date.parse('2026-09-11T00:00:00Z') + i * 3600_000).toISOString() }),
    )
    const overflow: Array<[string, number]> = []
    const out = planDeliveries({
      ...base,
      subscriptions: [sub()],
      alarms,
      onOverflow: (c, n) => overflow.push([c, n]),
    })
    expect(out).toHaveLength(20)
    expect(out[0].alarmId).toBe('a0')
    expect(out[19].alarmId).toBe('a19')
    expect(overflow).toEqual([['100', 5]])
  })
})

// --- I/O half, with an injected fake sql and a stubbed Telegram API ----------

type Call = { q: string; values: unknown[] }
const fakeSql = (route: (q: string, values: unknown[]) => any[]) => {
  const calls: Call[] = []
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    return Promise.resolve(route(q, values))
  }
  return { sql, calls }
}

const tgStub = (answer: (method: string, body: any) => any) => {
  const sent: Array<{ method: string; body: any; url: string }> = []
  const fetchImpl = (async (url: string, init: any) => {
    const method = url.split('/').pop() as string
    const body = JSON.parse(init.body)
    sent.push({ method, body, url })
    return { status: 200, json: async () => answer(method, body) }
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

const config = botConfig((k: string) =>
  ({ TELEGRAM_ALERTS_BOT_TOKEN: 'test-token', TELEGRAM_ALERTS_BOT_USERNAME: 'membrane_alerts_bot' })[k],
)
const footerFor = async () => 'this alarm cannot yet see: X'
const silent = () => {}

describe('handleUpdate', () => {
  it('asks to track on Radar first when the address is not watched', async () => {
    const { sql, calls } = fakeSql(() => [])
    const out = await handleUpdate({ message: { chat: { id: 7 }, text: `/start ${ADDR}` } }, { sql, logic, footerFor })
    expect(out?.text).toContain('Track this address on Radar first')
    expect(calls.some((c) => c.q.startsWith('INSERT'))).toBe(false)
  })

  it('subscribes a watched address and lists what is open now', async () => {
    const { sql, calls } = fakeSql((q) => {
      if (q.includes('count(*)')) return [{ n: 24 }]
      if (q.includes('FROM strat_watches')) return [{ createdAt: '2026-09-01T00:00:00Z', entryPositions: null, lastScanned: { usdByVenue: { sUSDe: 5000 } } }]
      if (q.includes('FROM venue_alarms')) return [{ id: 'a1', venue: 'sUSDe', kind: 'headroom_thin', severity: 'alarm', evidence: { ratio: 1.1 }, firedAt: '2026-08-01T00:00:00Z', clearedAt: null }]
      return []
    })
    const out = await handleUpdate({ message: { chat: { id: 7 }, text: `/start ${ADDR}` } }, { sql, logic, footerFor })
    expect(out?.chatId).toBe('7')
    expect(out?.text).toContain('Right now:\n- sUSDe:')
    const ins = calls.find((c) => c.q.startsWith('INSERT INTO alert_subscriptions'))
    expect(ins?.values).toEqual(['7', ADDR])
    expect(ins?.q).toContain('stopped_at = NULL')
  })

  it('/stop stops every subscription of the chat', async () => {
    const { sql } = fakeSql((q) => (q.startsWith('UPDATE alert_subscriptions') ? [{ id: 1 }, { id: 2 }] : []))
    const out = await handleUpdate({ message: { chat: { id: 7 }, text: '/stop' } }, { sql, logic, footerFor })
    expect(out?.text).toContain('2 addresses')
  })

  it('M1: refuses a 26th active address for one chat', async () => {
    const { sql, calls } = fakeSql((q) => {
      if (q.includes('count(*)')) return [{ n: 25 }]
      if (q.includes('FROM strat_watches')) return [{ createdAt: '2026-09-01T00:00:00Z', entryPositions: null, lastScanned: null }]
      return []
    })
    const out = await handleUpdate({ message: { chat: { id: 7 }, text: `/start ${ADDR}` } }, { sql, logic, footerFor })
    expect(out?.text).toBe('This chat already watches 25 addresses. /stop to reset.')
    expect(calls.some((c) => c.q.startsWith('INSERT'))).toBe(false)
    // the cap counts OTHER addresses, so re-/start of a watched one is never blocked
    expect(calls.find((c) => c.q.includes('count(*)'))?.q).toContain('address <>')
  })

  it('L5: ignores edited_message entirely', async () => {
    const { sql, calls } = fakeSql(() => [])
    expect(await handleUpdate({ update_id: 2, edited_message: { chat: { id: 7 }, text: '/stop' } }, { sql, logic, footerFor })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('ignores updates without a text message', async () => {
    const { sql } = fakeSql(() => [])
    expect(await handleUpdate({ update_id: 1, callback_query: {} }, { sql, logic, footerFor })).toBeNull()
  })
})

describe('sendAddressAlerts', () => {
  type Row = { id: string; chatId: string; address: string; createdAt: string; stoppedAt: string | null }
  // A stateful fake: subscriptions + ledger live here so claim/release is real.
  const world = (opts: { subs?: Row[]; alarms?: any[]; delivered?: any[]; staleLedgerRead?: boolean; insertThrows?: boolean } = {}) => {
    const subs: Row[] = opts.subs ?? [{ id: 's1', chatId: '100', address: ADDR, createdAt: '2026-09-10T00:00:00Z', stoppedAt: null }]
    const ledger = new Set<string>((opts.delivered ?? []).map((d: any) => `${d.subscriptionId}|${d.alarmId}|${d.moment}`))
    const alarms = opts.alarms ?? [{ id: 'a1', venue: 'sUSDe', kind: 'headroom_thin', severity: 'alarm', evidence: { ratio: 1.1 }, firedAt: '2026-09-20T00:00:00Z', clearedAt: null }]
    const f = fakeSql((q, v) => {
      if (q.startsWith('SELECT id, chat_id')) return subs.filter((r) => !r.stoppedAt)
      if (q.includes('FROM strat_watches')) return [{ address: ADDR, createdAt: '2026-09-01T00:00:00Z', entryPositions: null, lastScanned: { usdByVenue: { sUSDe: 5000 } } }]
      if (q.includes('FROM venue_alarms')) return alarms
      if (q.startsWith('SELECT subscription_id')) {
        if (opts.staleLedgerRead) return [] // both runs planned before either claimed
        return [...ledger].map((k) => { const [subscriptionId, alarmId, moment] = k.split('|'); return { subscriptionId, alarmId, moment } })
      }
      if (q.startsWith('INSERT INTO alert_deliveries')) {
        if (opts.insertThrows) throw new Error('db hiccup')
        const k = v.join('|')
        if (ledger.has(k)) return []
        ledger.add(k)
        return [{ subscription_id: v[0] }]
      }
      if (q.startsWith('DELETE FROM alert_deliveries')) { ledger.delete(v.join('|')); return [] }
      if (q.startsWith('UPDATE alert_subscriptions s SET chat_id')) {
        const [to, from] = v as string[]
        for (const r of subs) if (r.chatId === from && !subs.some((t) => t.chatId === to && t.address === r.address)) r.chatId = to
        return []
      }
      if (q.startsWith('UPDATE alert_subscriptions SET stopped_at')) {
        const out = subs.filter((r) => r.chatId === v[0] && !r.stoppedAt)
        out.forEach((r) => (r.stoppedAt = 'now'))
        return out.map((r) => ({ id: r.id }))
      }
      return []
    })
    return { ...f, subs, ledger }
  }
  const coverage = async () => ({ sUSDe: [{ id: 'x', label: 'X', memo: 'm' }] })

  it('claims, sends, and keeps the ledger row on ok', async () => {
    const w = world()
    const { fetchImpl, sent } = tgStub(() => ({ ok: true, result: {} }))
    const r = await sendAddressAlerts(w.sql, { logic, coverage, config, fetchImpl, log: silent })
    expect(r).toEqual({ sent: 1, failed: 0 })
    expect(sent[0].body.chat_id).toBe('100')
    expect(sent[0].body.text).toContain('Radar profile: https://membrane.money/ethereum/radar?address=')
    expect(sent[0].body.text).not.toMatch(/Silence|cannot yet see/)
    expect([...w.ledger]).toEqual(['s1|a1|fired'])
  })

  it('M2: a failed send releases its claim so the next run retries', async () => {
    const w = world()
    const { fetchImpl } = tgStub(() => ({ ok: false, error_code: 429, description: 'Too Many Requests' }))
    const r = await sendAddressAlerts(w.sql, { logic, coverage, config, fetchImpl, log: silent })
    expect(r).toEqual({ sent: 0, failed: 1 })
    expect(w.ledger.size).toBe(0)
    expect(w.subs[0].stoppedAt).toBeNull()
  })

  it('M2: two overlapping runs with the same stale plan send once', async () => {
    const w = world({ staleLedgerRead: true })
    const { fetchImpl, sent } = tgStub(() => ({ ok: true }))
    const deps = { logic, coverage, config, fetchImpl, log: silent }
    const [a, b] = await Promise.all([sendAddressAlerts(w.sql, deps), sendAddressAlerts(w.sql, deps)])
    expect(a.sent + b.sent).toBe(1)
    expect(sent).toHaveLength(1)
  })

  it('M2: a throwing claim INSERT skips that delivery without aborting', async () => {
    const w = world({ insertThrows: true })
    const { fetchImpl, sent } = tgStub(() => ({ ok: true }))
    const r = await sendAddressAlerts(w.sql, { logic, coverage, config, fetchImpl, log: silent })
    expect(r).toEqual({ sent: 0, failed: 0 })
    expect(sent).toHaveLength(0)
  })

  it('sends nothing already in the ledger', async () => {
    const w = world({ delivered: [{ subscriptionId: 's1', alarmId: 'a1', moment: 'fired' }] })
    const { fetchImpl, sent } = tgStub(() => ({ ok: true }))
    await sendAddressAlerts(w.sql, { logic, coverage, config, fetchImpl, log: silent })
    expect(sent).toHaveLength(0)
  })

  it('M1: reads coverage once per run, however many addresses', async () => {
    const w = world({
      subs: [
        { id: 's1', chatId: '100', address: ADDR, createdAt: '2026-09-10T00:00:00Z', stoppedAt: null },
        { id: 's2', chatId: '200', address: ADDR, createdAt: '2026-09-10T00:00:00Z', stoppedAt: null },
      ],
    })
    const cov = vi.fn(coverage)
    const { fetchImpl } = tgStub(() => ({ ok: true }))
    await sendAddressAlerts(w.sql, { logic, coverage: cov, config, fetchImpl, log: silent })
    expect(cov).toHaveBeenCalledTimes(1)
    expect(footerFrom({ sUSDe: [{ label: 'X' }], sUSDS: [{ label: 'Y' }] }, ['sUSDe'])).toBe('this alarm cannot yet see: X')
  })

  it('L1: a non-ok send skips that chat for the rest of the run, other chats still get theirs', async () => {
    const alarms = ['a1', 'a2', 'a3'].map((id, i) => ({ id, venue: 'sUSDe', kind: 'headroom_thin', severity: 'alarm', evidence: { ratio: 1.1 }, firedAt: `2026-09-2${i}T00:00:00Z`, clearedAt: null }))
    const w = world({
      alarms,
      subs: [
        { id: 's1', chatId: '100', address: ADDR, createdAt: '2026-09-10T00:00:00Z', stoppedAt: null },
        { id: 's2', chatId: '200', address: ADDR, createdAt: '2026-09-10T00:00:00Z', stoppedAt: null },
      ],
    })
    const { fetchImpl, sent } = tgStub((_m, body) => (body.chat_id === '100' ? { ok: false, error_code: 429 } : { ok: true }))
    const r = await sendAddressAlerts(w.sql, { logic, coverage, config, fetchImpl, log: silent })
    expect(sent.filter((s) => s.body.chat_id === '100')).toHaveLength(1)
    expect(sent.filter((s) => s.body.chat_id === '200')).toHaveLength(3)
    expect(r).toEqual({ sent: 3, failed: 1 })
    expect(w.subs.every((s) => s.stoppedAt === null)).toBe(true) // 429 never stops a subscription
  })

  it('L4: a migrated group moves its subscriptions and the send is retried once on the new id', async () => {
    const w = world()
    const { fetchImpl, sent } = tgStub((_m, body) =>
      body.chat_id === '100'
        ? { ok: false, error_code: 400, description: 'group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100999 } }
        : { ok: true },
    )
    const r = await sendAddressAlerts(w.sql, { logic, coverage, config, fetchImpl, log: silent })
    expect(sent.map((s) => s.body.chat_id)).toEqual(['100', '-100999'])
    expect(r).toEqual({ sent: 1, failed: 0 })
    expect(w.subs[0]).toMatchObject({ chatId: '-100999', stoppedAt: null })
    expect([...w.ledger]).toEqual(['s1|a1|fired'])
  })

  it('L4: when the new chat already watches the address, the old row is stopped, not moved', async () => {
    const w = world({
      subs: [
        { id: 's1', chatId: '100', address: ADDR, createdAt: '2026-09-10T00:00:00Z', stoppedAt: null },
        { id: 's9', chatId: '-100999', address: ADDR, createdAt: '2026-09-10T00:00:00Z', stoppedAt: null },
      ],
    })
    const { fetchImpl, sent } = tgStub((_m, body) =>
      body.chat_id === '100' ? { ok: false, error_code: 400, parameters: { migrate_to_chat_id: -100999 } } : { ok: true },
    )
    await sendAddressAlerts(w.sql, { logic, coverage, config, fetchImpl, log: silent })
    expect(w.subs.find((s) => s.id === 's1')?.stoppedAt).toBe('now')
    expect(sent.filter((s) => s.body.chat_id === '-100999')).toHaveLength(1) // via its own s9, once
    expect(w.ledger.has('s1|a1|fired')).toBe(false)
  })

  it('ships dark when the bot env is unset: one log line, no queries, no calls', async () => {
    const { sql, calls } = fakeSql(() => [])
    const lines: string[] = []
    await sendAddressAlerts(sql, { logic, coverage, config: botConfig(() => undefined), log: (l: string) => lines.push(l) })
    expect(lines).toHaveLength(1)
    expect(calls).toHaveLength(0)
  })
})

describe('pollOnce', () => {
  it('answers each update and persists the next offset', async () => {
    const { sql, calls } = fakeSql((q) => (q.includes('FROM alert_bot_state') ? [{ value: '41' }] : []))
    const { fetchImpl, sent } = tgStub((method) =>
      method === 'getUpdates'
        ? { ok: true, result: [{ update_id: 41, message: { chat: { id: 9 }, text: '/list' } }] }
        : { ok: true },
    )
    const r = await pollOnce({ sql, logic, footerFor, config, fetchImpl, log: silent })
    expect(r).toEqual({ handled: 1, ok: true })
    expect(sent[0].body.offset).toBe(41)
    expect(sent[1].method).toBe('sendMessage')
    expect(sent[1].body.text).toContain('watches no address')
    expect(calls.find((c) => c.q.startsWith('INSERT INTO alert_bot_state'))?.values).toEqual(['42'])
  })

  it('L2: offset write is GREATEST(existing, new) and a failed write never throws', async () => {
    const { sql, calls } = fakeSql((q) => {
      if (q.includes('FROM alert_bot_state')) return [{ value: '41' }]
      if (q.startsWith('INSERT INTO alert_bot_state')) throw new Error('db down')
      return []
    })
    const { fetchImpl, sent } = tgStub((method) =>
      method === 'getUpdates'
        ? { ok: true, result: [41, 42].map((id) => ({ update_id: id, message: { chat: { id: 9 }, text: '/list' } })) }
        : { ok: true },
    )
    const r = await pollOnce({ sql, logic, footerFor, config, fetchImpl, log: silent })
    expect(r).toEqual({ handled: 2, ok: true })
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(2)
    const w = calls.find((c) => c.q.startsWith('INSERT INTO alert_bot_state'))
    expect(w?.q).toContain('GREATEST(alert_bot_state.value::bigint, EXCLUDED.value::bigint)')
  })
})

describe('webhook', () => {
  const mockRes = () => {
    const res: any = { statusCode: 0, body: undefined }
    res.status = (c: number) => ((res.statusCode = c), res)
    res.json = (b: unknown) => ((res.body = b), res)
    return res
  }
  const env = (secret?: string) => (k: string) =>
    ({
      TELEGRAM_ALERTS_BOT_TOKEN: 'test-token',
      TELEGRAM_ALERTS_BOT_USERNAME: 'membrane_alerts_bot',
      TELEGRAM_ALERTS_WEBHOOK_SECRET: secret,
    })[k]
  const update = { update_id: 1, message: { chat: { id: 5 }, text: '/list' } }

  it('503 when the webhook secret is unset', async () => {
    const { sql } = fakeSql(() => [])
    const h = createWebhookHandler({ env: env(undefined), sql: () => sql, footerFor })
    const res = mockRes()
    await h({ method: 'POST', headers: {}, body: update } as any, res)
    expect(res.statusCode).toBe(503)
  })

  it('401 on a missing or wrong secret header, and touches nothing', async () => {
    const { sql, calls } = fakeSql(() => [])
    const h = createWebhookHandler({ env: env('s3cret'), sql: () => sql, footerFor })
    for (const headers of [{}, { 'x-telegram-bot-api-secret-token': 'nope' }]) {
      const res = mockRes()
      await h({ method: 'POST', headers, body: update } as any, res)
      expect(res.statusCode).toBe(401)
    }
    expect(calls).toHaveLength(0)
  })

  it('200 and one reply with the right secret', async () => {
    const { sql } = fakeSql(() => [])
    const { fetchImpl, sent } = tgStub(() => ({ ok: true }))
    const h = createWebhookHandler({ env: env('s3cret'), sql: () => sql, footerFor, fetchImpl })
    const res = mockRes()
    await h({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's3cret' }, body: update } as any, res)
    expect(res.statusCode).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].body.chat_id).toBe('5')
  })

  it('still 200 when the handler throws (no Telegram redelivery loop)', async () => {
    const sql = () => Promise.reject(new Error('db down'))
    const h = createWebhookHandler({ env: env('s3cret'), sql: () => sql as any, footerFor })
    const res = mockRes()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await h({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's3cret' }, body: update } as any, res)
    warn.mockRestore()
    expect(res.statusCode).toBe(200)
  })
})
