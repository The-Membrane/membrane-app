import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Reading } from '@/lib/userAlerts/evaluate'
import { base64urlToHex } from '@/lib/userAlerts/metrics'
import { createRateLimiter } from '@/lib/userAlerts/rateLimit'
import { liveAllowList } from '@/lib/userAlerts/subjects'
import { createAlertsHandler } from '@/pages/api/alerts/index'
import { createFeedHandler } from '@/pages/api/alerts/feed/[token]'
import { createStatusHandler } from '@/pages/api/alerts/status'

// The /api/alerts/* handlers against a STATEFUL fake of the five statements the
// store issues (lib/userAlerts/store.ts) — owners, thresholds, events with the same
// compare-and-set + unique-transition semantics the SQL has. No DB, no chain, no
// network: values come from an injected reader.

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network call in a unit test')
  })
})
afterEach(() => vi.unstubAllGlobals())

const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7'
const ADDR2 = '0x8617E340B3D01FA5F11F306F4090FD50E238070D'
const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)
const T0 = Date.parse('2026-10-14T12:00:00Z')

type Owner = { id: string; kind: string; key: string; token: string }
type Th = {
  id: string
  ownerId: string
  metric: string
  subject: string
  direction: string
  threshold: string
  optedInAt: string
  createdAt: string
  stoppedAt: string | null
  crossedAt: string | null
  lastValue: string | null
  lastEvaluatedAt: string | null
  lastAsOf: string | null
}
type Ev = { id: string; thresholdId: string; kind: string; value: string; at: string; asOf: string; source: string; crossingAt: string }

// The out-of-order guard every transition/reading write carries (store.ts).
const notOlder = (t: { lastAsOf: string | null }, asOf: string) => t.lastAsOf === null || Date.parse(t.lastAsOf) <= Date.parse(asOf)

const world = (opts: { tablesMissing?: boolean; throws?: boolean } = {}) => {
  const owners: Owner[] = []
  const ths: Th[] = []
  const evs: Ev[] = []
  const queries: string[] = []
  let n = 0
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const sql = (strings: TemplateStringsArray, ...v: any[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    queries.push(q)
    if (opts.throws) return Promise.reject(new Error(`db down; row ${JSON.stringify(v)}`))
    const out = ((): any[] => {
      if (q.startsWith('SELECT 1 FROM user_alert_owners')) {
        if (opts.tablesMissing) throw new Error('relation "user_alert_owners" does not exist')
        return []
      }
      if (q.startsWith('SELECT id, owner_kind AS kind')) {
        const o = owners.find((x) => x.token === v[0])
        return o ? [{ id: o.id, kind: o.kind, key: o.key }] : []
      }
      if (q.startsWith('WITH o AS ( INSERT INTO user_alert_owners')) {
        const [kind, key, token, createdAt, metric, subject, direction, threshold, optedInAt] = v
        if (owners.some((x) => x.token === token)) throw new Error('duplicate feed_token')
        const o = { id: uuid(), kind, key, token }
        owners.push(o)
        const t = th({ ownerId: o.id, metric, subject, direction, threshold, optedInAt, createdAt })
        return [{ id: t.id }]
      }
      if (q.startsWith('INSERT INTO user_alert_thresholds')) {
        const [ownerId, metric, subject, direction, threshold, optedInAt, , cap] = v
        const active = ths.filter((x) => x.ownerId === ownerId && !x.stoppedAt).length
        if (active >= cap) return []
        return [{ id: th({ ownerId, metric, subject, direction, threshold, optedInAt, createdAt: optedInAt }).id }]
      }
      if (q.startsWith('SELECT id, metric, subject, direction, threshold')) {
        return ths.filter((x) => x.ownerId === v[0] && !x.stoppedAt)
      }
      if (q.startsWith('WITH upd AS ( UPDATE user_alert_thresholds SET crossed_at')) {
        expect(q).toContain('AND (last_as_of IS NULL OR last_as_of <= ?::timestamptz)')
        const [at, value, , , id, guardAsOf, , , asOf, source] = v
        const t = ths.find((x) => x.id === id && x.crossedAt === null && !x.stoppedAt && notOlder(x, guardAsOf))
        if (!t) return []
        Object.assign(t, { crossedAt: at, lastValue: value, lastEvaluatedAt: at, lastAsOf: asOf })
        return insertEvent({ thresholdId: id, kind: 'crossed', value, at, asOf, source, crossingAt: at })
      }
      if (q.startsWith('WITH prev AS')) {
        expect(q).toContain('AND (last_as_of IS NULL OR last_as_of <= ?::timestamptz)')
        const [id, guardAsOf, value, at, , , , asOf, source] = v
        const t = ths.find((x) => x.id === id && x.crossedAt !== null && !x.stoppedAt && notOlder(x, guardAsOf))
        if (!t) return []
        const crossingAt = t.crossedAt as string
        Object.assign(t, { crossedAt: null, lastValue: value, lastEvaluatedAt: at, lastAsOf: asOf })
        return insertEvent({ thresholdId: id, kind: 'cleared', value, at, asOf, source, crossingAt })
      }
      if (q.startsWith('UPDATE user_alert_thresholds SET last_value')) {
        const [value, at, asOf, id, , , , minS] = v
        const t = ths.find((x) => x.id === id && !x.stoppedAt)
        const changed = t && (t.lastValue === null || Number(t.lastValue) !== Number(value))
        const due = t && (t.lastEvaluatedAt === null || Date.parse(at) - Date.parse(t.lastEvaluatedAt) >= minS * 1000)
        if (t && changed && due && notOlder(t, asOf)) Object.assign(t, { lastValue: value, lastEvaluatedAt: at, lastAsOf: asOf })
        return []
      }
      if (q.startsWith('SELECT e.id, e.threshold_id')) {
        const mine = new Set(ths.filter((x) => x.ownerId === v[0]).map((x) => x.id))
        return evs
          .filter((e) => mine.has(e.thresholdId))
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
          .slice(0, v[1])
          .map((e) => {
            const t = ths.find((x) => x.id === e.thresholdId) as Th
            return { ...e, metric: t.metric, subject: t.subject, direction: t.direction, threshold: t.threshold }
          })
      }
      if (q.startsWith('UPDATE user_alert_thresholds SET stopped_at')) {
        const [id, ownerId] = v
        const t = ths.find((x) => x.id === id && x.ownerId === ownerId && !x.stoppedAt)
        if (!t) return []
        t.stoppedAt = 'now'
        return [{ id }]
      }
      throw new Error(`unrouted query: ${q}`)
    })()
    return Promise.resolve(out)
  }
  const th = (o: Pick<Th, 'ownerId' | 'metric' | 'subject' | 'direction' | 'threshold' | 'optedInAt' | 'createdAt'>): Th => {
    const t: Th = { id: uuid(), stoppedAt: null, crossedAt: null, lastValue: null, lastEvaluatedAt: null, lastAsOf: null, ...o }
    ths.push(t)
    return t
  }
  const insertEvent = (e: Omit<Ev, 'id'>): any[] => {
    // UNIQUE (threshold_id, kind, crossing_at) ON CONFLICT DO NOTHING
    if (evs.some((x) => x.thresholdId === e.thresholdId && x.kind === e.kind && x.crossingAt === e.crossingAt)) return []
    const id = uuid()
    evs.push({ id, ...e })
    return [{ id }]
  }
  return { sql, owners, ths, evs, queries }
}

const mockRes = () => {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> }
  res.setHeader = (k: string, v: string) => ((res.headers[k.toLowerCase()] = v), res)
  res.status = (c: number) => ((res.statusCode = c), res)
  res.json = (b: unknown) => ((res.body = b), res)
  res.send = (b: unknown) => ((res.body = b), res)
  return res
}

const DB_ENV = { DATABASE_URL: 'postgres://test' }
const TG_ENV = {
  ...DB_ENV,
  TELEGRAM_ALERTS_BOT_TOKEN: 'bot-token-SECRET',
  TELEGRAM_ALERTS_BOT_USERNAME: 'membrane_alerts_bot',
  TELEGRAM_ALERTS_WEBHOOK_SECRET: 'hook-SECRET',
}
const envOf = (o: Record<string, string | undefined>) => (k: string) => o[k]

const tokens = (...list: string[]) => {
  let i = 0
  return () => list[i++] ?? `${i}`.padStart(64, 'c')
}

const alertsHandler = (w: ReturnType<typeof world>, o: { env?: Record<string, string>; limit?: number; newToken?: () => string } = {}) =>
  createAlertsHandler({
    env: envOf(o.env ?? DB_ENV),
    sql: () => w.sql,
    allowList: liveAllowList,
    limiter: createRateLimiter({ limit: o.limit ?? 1000, windowMs: 60_000 }),
    newToken: o.newToken ?? tokens(TOKEN_A, TOKEN_B),
    nowMs: () => T0,
  })

const good = {
  ownerKind: 'address',
  ownerKey: ADDR,
  metric: 'utilization',
  subject: 'venue:aave-v3-usde',
  direction: 'above',
  threshold: 50,
  optIn: true,
}

const postWith = async (h: ReturnType<typeof alertsHandler>, body: unknown, ip = '1.2.3.4') => {
  const res = mockRes()
  await h({ method: 'POST', headers: { 'x-forwarded-for': ip }, body } as any, res)
  return res
}

describe('GET /api/alerts/status', () => {
  it('storage false without DATABASE_URL — and no query is made', async () => {
    const w = world()
    const res = mockRes()
    await createStatusHandler({ env: envOf({}), sql: () => w.sql })({ method: 'GET', headers: {} } as any, res)
    expect(res.body).toEqual({ storage: false, telegram: false, rss: false })
    expect(w.queries).toHaveLength(0)
  })
  it('storage true only when the tables answer; booleans only, no env echo', async () => {
    const res = mockRes()
    await createStatusHandler({ env: envOf(TG_ENV), sql: () => world().sql })({ method: 'GET', headers: {} } as any, res)
    expect(res.body).toEqual({ storage: true, telegram: true, rss: true })
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|postgres|membrane_alerts_bot/)
    expect(res.headers['cache-control']).toContain('s-maxage=30')

    const missing = mockRes()
    await createStatusHandler({ env: envOf(TG_ENV), sql: () => world({ tablesMissing: true }).sql })({ method: 'GET', headers: {} } as any, missing)
    expect(missing.body).toEqual({ storage: false, telegram: false, rss: false })
  })
  it('telegram needs the bot token, its username AND the webhook secret', async () => {
    for (const drop of ['TELEGRAM_ALERTS_BOT_TOKEN', 'TELEGRAM_ALERTS_BOT_USERNAME', 'TELEGRAM_ALERTS_WEBHOOK_SECRET']) {
      const res = mockRes()
      await createStatusHandler({ env: envOf({ ...TG_ENV, [drop]: undefined } as any), sql: () => world().sql })({ method: 'GET', headers: {} } as any, res)
      expect(res.body.telegram).toBe(false)
      expect(res.body.storage).toBe(true)
    }
  })
  it('memoises the probe briefly', async () => {
    const w = world()
    const h = createStatusHandler({ env: envOf(DB_ENV), sql: () => w.sql, nowMs: () => T0 })
    await h({ method: 'GET', headers: {} } as any, mockRes())
    await h({ method: 'GET', headers: {} } as any, mockRes())
    expect(w.queries).toHaveLength(1)
  })
})

describe('POST /api/alerts', () => {
  it('stores one opt-in threshold on a NEW feed and returns only its id and feed', async () => {
    const w = world()
    const res = await postWith(alertsHandler(w), good)
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['feedUrl', 'id'])
    expect(res.body.feedUrl).toBe(`https://membrane.money/api/alerts/feed/${TOKEN_A}?format=rss`)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(w.owners).toEqual([{ id: expect.any(String), kind: 'address', key: ADDR.toLowerCase(), token: TOKEN_A }])
    expect(w.ths[0]).toMatchObject({ metric: 'utilization', subject: 'venue:aave-v3-usde', direction: 'above', threshold: '50', optedInAt: new Date(T0).toISOString() })
  })

  it('a telegram link only when the bot is fully configured; it carries this feed token', async () => {
    const res = await postWith(alertsHandler(world(), { env: TG_ENV }), good)
    const link: string = res.body.telegramLink
    expect(link).toMatch(/^https:\/\/t\.me\/membrane_alerts_bot\?start=th_[A-Za-z0-9_-]{43}$/)
    expect(base64urlToHex(link.split('th_')[1])).toBe(TOKEN_A)
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET/)
    const dark = await postWith(alertsHandler(world(), { env: { ...TG_ENV, TELEGRAM_ALERTS_WEBHOOK_SECRET: '' } }), good)
    expect(dark.body.telegramLink).toBeUndefined()
  })

  it('nothing is stored without an explicit optIn:true', async () => {
    for (const optIn of [undefined, false, 'true', 1]) {
      const w = world()
      const res = await postWith(alertsHandler(w), { ...good, optIn })
      expect(res.statusCode).toBe(400)
      expect(res.body.field).toBe('optIn')
      expect(w.queries).toHaveLength(0)
    }
  })

  it('validates owner, metric, subject (live allow-list), direction and bounds before any write', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ownerKind: 'telegram' }, 'ownerKind'],
      [{ ownerKey: '0x1234' }, 'ownerKey'],
      [{ metric: 'tvl' }, 'metric'],
      [{ subject: 'venue:sUSDe' }, 'subject'], // no utilization recorded there
      [{ metric: 'apr', subject: 'venue:scrvUSD' }, 'subject'], // no APR source
      [{ metric: 'price', subject: 'asset:DOGE', threshold: 1 }, 'subject'],
      [{ direction: 'sideways' }, 'direction'],
      [{ threshold: 101 }, 'threshold'],
      [{ threshold: -1 }, 'threshold'],
      [{ threshold: 'abc' }, 'threshold'],
      [{ metric: 'price', subject: 'asset:ETH', threshold: 0 }, 'threshold'],
    ]
    for (const [patch, field] of cases) {
      const w = world()
      const res = await postWith(alertsHandler(w), { ...good, ...patch })
      expect([res.statusCode, res.body.field]).toEqual([400, field])
      expect(w.queries).toHaveLength(0)
    }
    const price = await postWith(alertsHandler(world()), { ...good, metric: 'price', subject: 'asset:ETH', direction: 'below', threshold: '2500.5' })
    expect(price.statusCode).toBe(200)
  })

  it('a string threshold must be a plain decimal ("" is not 0, "0x10" is not 16)', async () => {
    for (const threshold of ['', ' ', '0x10', '1e2', '5,5', '50%', 'Infinity']) {
      const w = world()
      const res = await postWith(alertsHandler(w), { ...good, threshold })
      expect([res.statusCode, res.body.field]).toEqual([400, 'threshold'])
      expect(w.queries).toHaveLength(0)
    }
    expect((await postWith(alertsHandler(world()), { ...good, threshold: ' 50 ' })).statusCode).toBe(200)
  })

  it('adds to an existing feed only with that feed token AND the same address', async () => {
    const w = world()
    const h = alertsHandler(w)
    await postWith(h, good)
    const again = await postWith(h, { ...good, threshold: 60, feedToken: TOKEN_A })
    expect(again.statusCode).toBe(200)
    expect(again.body.feedUrl).toContain(TOKEN_A)
    expect(w.owners).toHaveLength(1)
    expect(w.ths).toHaveLength(2)
    // Same 404 for "no such feed" and "someone else's feed" — no oracle, no write.
    const other = await postWith(h, { ...good, ownerKey: ADDR2, feedToken: TOKEN_A })
    const unknown = await postWith(h, { ...good, feedToken: 'f'.repeat(64) })
    const junk = await postWith(h, { ...good, feedToken: 'nope' })
    for (const r of [other, unknown, junk]) expect([r.statusCode, r.body]).toEqual([404, { error: 'unknown feed' }])
    expect(w.ths).toHaveLength(2)
  })

  it('POSTing an address without its token mints a separate feed — it never reveals the first', async () => {
    const w = world()
    const h = alertsHandler(w)
    const a = await postWith(h, good)
    const b = await postWith(h, good)
    expect(a.body.feedUrl).toContain(TOKEN_A)
    expect(b.body.feedUrl).toContain(TOKEN_B)
    expect(b.body.feedUrl).not.toContain(TOKEN_A)
  })

  it('caps a feed at 25 active thresholds', async () => {
    const w = world()
    const h = alertsHandler(w)
    await postWith(h, good)
    for (let i = 0; i < 24; i++) expect((await postWith(h, { ...good, feedToken: TOKEN_A })).statusCode).toBe(200)
    const full = await postWith(h, { ...good, feedToken: TOKEN_A })
    expect([full.statusCode, full.body]).toEqual([409, { error: 'cap', max: 25 }])
    expect(w.ths).toHaveLength(25)
  })

  it('rate-limits per IP, 503 without storage, 405 for other methods', async () => {
    const h = alertsHandler(world(), { limit: 2 })
    expect((await postWith(h, good)).statusCode).toBe(200)
    expect((await postWith(h, good)).statusCode).toBe(200)
    expect((await postWith(h, good)).statusCode).toBe(429)
    expect((await postWith(h, good, '5.6.7.8')).statusCode).toBe(200)
    expect((await postWith(alertsHandler(world(), { env: {} }), good)).statusCode).toBe(503)
    const res = mockRes()
    await alertsHandler(world())({ method: 'GET', headers: {} } as any, res)
    expect(res.statusCode).toBe(405)
  })

  it('a store failure is 503 and logs no threshold or owner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await postWith(alertsHandler(world({ throws: true })), good)
    expect(res.statusCode).toBe(503)
    const logged = warn.mock.calls.flat().join(' ')
    warn.mockRestore()
    expect(logged).not.toMatch(new RegExp(`${ADDR.slice(2, 10)}|aave|50`, 'i'))
  })
})

describe('GET/DELETE /api/alerts/feed/[token]', () => {
  const reader = (r: Reading | (() => Reading)) => () => async (needs: Array<{ metric: string; subject: string }>) =>
    new Map(needs.map((n) => [`${n.metric}|${n.subject}`, typeof r === 'function' ? r() : r] as [string, Reading]))
  const okAt = (value: number, asOf = '2026-10-14T11:00:00.000Z'): Reading => ({ status: 'ok', value, asOf, source: 'Membrane recorder · debt / (debt + available)' })

  const feedHandler = (w: ReturnType<typeof world>, read: ReturnType<typeof reader>, nowMs = () => T0, feedLimit = 1000) =>
    createFeedHandler({
      env: envOf(DB_ENV),
      sql: () => w.sql,
      readValues: read,
      limits: { ip: createRateLimiter({ limit: 1000, windowMs: 60_000 }), feed: createRateLimiter({ limit: feedLimit, windowMs: 60_000 }) },
      nowMs,
    })

  const get = async (h: ReturnType<typeof feedHandler>, token: string, query: Record<string, string> = {}, ip = '9.9.9.9') => {
    const res = mockRes()
    await h({ method: 'GET', headers: { 'x-forwarded-for': ip }, query: { token, ...query } } as any, res)
    return res
  }

  const seeded = async () => {
    const w = world()
    const h = alertsHandler(w)
    await postWith(h, good) // owner A: utilization above 50
    await postWith(h, { ...good, ownerKey: ADDR2, threshold: 10 }) // owner B
    return w
  }

  it('404 for an unknown or malformed token; never cached', async () => {
    const w = await seeded()
    for (const tok of ['f'.repeat(64), 'short', '../etc']) {
      const res = await get(feedHandler(w, reader(okAt(1))), tok)
      expect(res.statusCode).toBe(404)
      expect(res.headers['cache-control']).toBe('private, no-store')
    }
  })

  it("returns this owner's thresholds only — no owner key, nothing of another owner", async () => {
    const w = await seeded()
    const res = await get(feedHandler(w, reader(okAt(40))), TOKEN_A)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.body.thresholds).toHaveLength(1)
    expect(res.body.thresholds[0]).toMatchObject({ threshold: 50, direction: 'above', crossed: false, text: 'Aave v3 USDe utilization above 50.0%' })
    const s = JSON.stringify(res.body).toLowerCase()
    expect(s).not.toContain(ADDR.toLowerCase())
    expect(s).not.toContain(ADDR2.toLowerCase())
    expect(s).not.toMatch(/"threshold":10\b/)
  })

  it('evaluates on read: one crossed event however many reads, a clear only beyond the band', async () => {
    const w = await seeded()
    let value = 51
    let clock = T0
    const h = feedHandler(w, reader(() => okAt(value)), () => (clock += 60_000))
    await get(h, TOKEN_A)
    await get(h, TOKEN_A)
    await get(h, TOKEN_A)
    expect(w.evs.map((e) => e.kind)).toEqual(['crossed'])
    value = 49.6 // inside the 0.5 pp band
    await get(h, TOKEN_A)
    expect(w.evs.map((e) => e.kind)).toEqual(['crossed'])
    value = 49.4
    const res = await get(h, TOKEN_A)
    expect(w.evs.map((e) => e.kind)).toEqual(['crossed', 'cleared'])
    // the clear closes the crossing it belongs to
    expect(w.evs[1].crossingAt).toBe(w.evs[0].crossingAt)
    expect(res.body.events.map((e: any) => e.text)).toEqual([
      'Aave v3 USDe utilization back to 49.4% (alert: above 50.0%)',
      'Aave v3 USDe utilization reached 51.0% (alert: above 50.0%)',
    ])
    expect(res.body.events[0]).toMatchObject({ source: 'Membrane recorder · debt / (debt + available)', asOf: '2026-10-14T11:00:00.000Z' })
  })

  it('a stale or unavailable value is not evaluated, and the feed says so', async () => {
    const w = await seeded()
    const stale: Reading = { status: 'stale', value: 99, asOf: '2026-10-14T01:00:00.000Z', source: 'Membrane recorder · debt / (debt + available)', maxAgeS: 7200 }
    const res = await get(feedHandler(w, reader(stale)), TOKEN_A)
    expect(w.evs).toHaveLength(0)
    expect(w.ths[0].lastEvaluatedAt).toBeNull()
    expect(res.body.thresholds[0].note).toBe('not checked: Membrane recorder · debt / (debt + available) is stale (as of 2026-10-14 01:00 UTC)')
    const rss = await get(feedHandler(w, reader({ status: 'unavailable', source: 'Chainlink ETH / USD', reason: 'rpc' })), TOKEN_A, { format: 'rss' })
    expect(rss.body).toContain('not checked: Chainlink ETH / USD unavailable.')
    expect(w.evs).toHaveLength(0)
  })

  it('RSS: one item per transition, stable guid, source and as-of stated', async () => {
    const w = await seeded()
    const h = feedHandler(w, reader(okAt(55)))
    await get(h, TOKEN_A)
    const a = await get(h, TOKEN_A, { format: 'rss' })
    const b = await get(h, TOKEN_A, { format: 'rss' })
    expect(a.headers['content-type']).toBe('application/rss+xml; charset=utf-8')
    expect(a.headers['cache-control']).toBe('private, no-store')
    const items = (a.body as string).match(/<item>/g) ?? []
    expect(items).toHaveLength(1)
    const guid = (s: string) => /<guid isPermaLink="false">([^<]+)<\/guid>/.exec(s)?.[1]
    expect(guid(a.body)).toBe(guid(b.body))
    expect(a.body).toContain('Aave v3 USDe utilization reached 55.0% (alert: above 50.0%)')
    expect(a.body).toContain('as of 2026-10-14 11:00 UTC')
    expect(a.body).toContain(`<atom:link href="https://membrane.money/api/alerts/feed/${TOKEN_A}?format=rss"`)
    expect(a.body).toContain('<link>https://membrane.money/ethereum/venue/aave-v3-usde</link>')
    expect(a.body.toLowerCase()).not.toContain(ADDR.toLowerCase())
  })

  it("DELETE stops one of this owner's thresholds — and only theirs", async () => {
    const w = await seeded()
    const h = feedHandler(w, reader(okAt(40)))
    const mine = w.ths[0].id
    const theirs = w.ths[1].id
    const del = async (token: string, id: string) => {
      const res = mockRes()
      await h({ method: 'DELETE', headers: {}, query: { token, id } } as any, res)
      return res
    }
    expect((await del(TOKEN_A, theirs)).statusCode).toBe(404)
    expect((await del(TOKEN_A, 'not-a-uuid')).statusCode).toBe(400)
    expect((await del(TOKEN_A, mine)).body).toEqual({ stopped: true })
    expect((await del(TOKEN_A, mine)).statusCode).toBe(404)
    expect((await get(h, TOKEN_A)).body.thresholds).toEqual([])
    expect(w.ths[1].stoppedAt).toBeNull()
  })

  it('an OLDER cached reading after a newer crossing records nothing (out-of-order instances)', async () => {
    const w = await seeded()
    // Instance 1 holds the newer reading: crosses (as of 11:30).
    await get(feedHandler(w, reader(okAt(51, '2026-10-14T11:30:00.000Z'))), TOKEN_A)
    expect(w.evs.map((e) => e.kind)).toEqual(['crossed'])
    expect(w.ths[0].lastAsOf).toBe('2026-10-14T11:30:00.000Z')
    // Instance 2 still has an older cache (as of 11:00) that is back below the band.
    const older = await get(feedHandler(w, reader(okAt(40, '2026-10-14T11:00:00.000Z'))), TOKEN_A)
    expect(w.evs.map((e) => e.kind)).toEqual(['crossed'])
    expect(w.ths[0].crossedAt).not.toBeNull()
    expect(older.body.thresholds[0]).toMatchObject({ crossed: true, note: null })
    // A newer reading still clears normally.
    await get(feedHandler(w, reader(okAt(40, '2026-10-14T11:45:00.000Z')), () => T0 + 120_000), TOKEN_A)
    expect(w.evs.map((e) => e.kind)).toEqual(['crossed', 'cleared'])
  })

  it('the SQL guard alone also refuses an older reading (if two reads race past the JS check)', async () => {
    const { recordClearing, recordCrossing } = await import('@/lib/userAlerts/store')
    const w = await seeded()
    const id = w.ths[0].id
    expect(await recordCrossing(w.sql, id, { value: 51, at: '2026-10-14T12:00:00.000Z', asOf: '2026-10-14T11:30:00.000Z', source: 's' })).toBe(true)
    expect(await recordClearing(w.sql, id, { value: 40, at: '2026-10-14T12:01:00.000Z', asOf: '2026-10-14T11:00:00.000Z', source: 's' })).toBe(false)
    expect(w.evs).toHaveLength(1)
  })

  it('a no-transition reading writes only when the value moved, at most once a minute', async () => {
    const w = await seeded()
    let clock = T0
    let value = 40
    const h = feedHandler(w, reader(() => okAt(value)), () => clock)
    const writes = () => w.queries.filter((q) => q.startsWith('UPDATE user_alert_thresholds SET last_value')).length
    await get(h, TOKEN_A) // first reading: written
    expect(writes()).toBe(1)
    for (let i = 0; i < 5; i++) await get(h, TOKEN_A) // same value: never written
    expect(writes()).toBe(1)
    clock += 30_000
    value = 41
    await get(h, TOKEN_A) // moved, but within the minute: not written
    expect(writes()).toBe(1)
    clock += 30_000
    await get(h, TOKEN_A) // moved and a minute on: written
    expect(writes()).toBe(2)
    expect(w.ths[0].lastValue).toBe('41')
  })

  it('a malformed token is rejected before any DB call or limiter; GET is rate-limited per IP + token', async () => {
    const w = await seeded()
    const before = w.queries.length
    const h = feedHandler(w, reader(okAt(40)), () => T0, 2)
    for (const tok of ['zz', 'A'.repeat(65), '']) expect((await get(h, tok)).statusCode).toBe(404)
    expect(w.queries.length).toBe(before)
    expect((await get(h, TOKEN_A)).statusCode).toBe(200)
    expect((await get(h, TOKEN_A)).statusCode).toBe(200)
    const third = await get(h, TOKEN_A)
    expect(third.statusCode).toBe(429)
    expect(third.headers['retry-after']).toBe('60')
    // another reader of the same feed, or the same reader of another feed, is unaffected
    expect((await get(h, TOKEN_A, {}, '8.8.8.8')).statusCode).toBe(200)
    expect((await get(h, TOKEN_B)).statusCode).toBe(200)
  })

  it('RSS carries the token-gated manage link on the channel and on every item', async () => {
    const w = await seeded()
    const h = feedHandler(w, reader(okAt(55)))
    await get(h, TOKEN_A)
    const rss = (await get(h, TOKEN_A, { format: 'rss' })).body as string
    const manage = `https://membrane.money/alerts/${TOKEN_A}`
    expect(rss).toContain(`<link>${manage}</link>`)
    expect(rss).toContain(`Stop or change them: ${manage}`)
    expect(rss).toContain(`Stop this alert: ${manage}#t-${w.ths[0].id}`)
  })
})
